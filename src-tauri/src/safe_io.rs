//! Same-directory replacement without truncating the original on an error.
//! Checks are conditional within this process, not a filesystem-wide CAS.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub canonical_path: String,
    pub sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IoFailure {
    pub kind: &'static str,
    pub message: String,
}

impl IoFailure {
    pub(crate) fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl From<io::Error> for IoFailure {
    fn from(e: io::Error) -> Self {
        let kind = match e.kind() {
            io::ErrorKind::NotFound => "missing",
            io::ErrorKind::PermissionDenied => "permission",
            io::ErrorKind::AlreadyExists => "conflict",
            _ => "io",
        };
        Self::new(kind, e.to_string())
    }
}

#[derive(Debug)]
pub struct Snapshot {
    pub bytes: Vec<u8>,
    pub revision: Revision,
    pub mtime: u64,
}

pub enum Intent {
    Create,
    Replace(Revision),
}

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
type DestinationLocks = Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>;
static LOCKS: OnceLock<DestinationLocks> = OnceLock::new();

fn destination_lock(target: &Path) -> Arc<Mutex<()>> {
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(target).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(target.to_owned(), Arc::downgrade(&lock));
    lock
}

fn destination(path: &Path) -> Result<PathBuf, IoFailure> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(fs::canonicalize(path)?), // A dangling symlink is not a new file.
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let absolute = if path.is_absolute() {
                path.to_owned()
            } else {
                std::env::current_dir()?.join(path)
            };
            let parent = absolute
                .parent()
                .ok_or_else(|| IoFailure::new("invalid", "Invalid destination"))?;
            let name = absolute
                .file_name()
                .ok_or_else(|| IoFailure::new("invalid", "Invalid file name"))?;
            Ok(fs::canonicalize(parent)?.join(name))
        }
        Err(e) => Err(e.into()),
    }
}

fn revision(target: &Path, bytes: &[u8]) -> Revision {
    Revision {
        canonical_path: target.to_string_lossy().into_owned(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
    }
}

pub fn read(path: &Path) -> Result<Snapshot, IoFailure> {
    let target = fs::canonicalize(path)?;
    let bytes = fs::read(&target)?;
    let mtime = fs::metadata(&target)?
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Snapshot {
        revision: revision(&target, &bytes),
        bytes,
        mtime,
    })
}

fn verify(target: &Path, intent: &Intent) -> Result<(), IoFailure> {
    match intent {
        Intent::Create => match fs::symlink_metadata(target) {
            Ok(_) => Err(IoFailure::new("conflict", "The destination already exists")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        },
        Intent::Replace(expected) => {
            let current = read(target)?;
            if current.revision != *expected {
                return Err(IoFailure::new(
                    "conflict",
                    "The file changed since it was read",
                ));
            }
            let meta = fs::metadata(target)?;
            if meta.permissions().readonly() {
                return Err(IoFailure::new("permission", "The file is read-only"));
            }
            reject_hard_links(target, &meta)
        }
    }
}

#[cfg(unix)]
pub(crate) fn reject_hard_links(_target: &Path, meta: &fs::Metadata) -> Result<(), IoFailure> {
    use std::os::unix::fs::MetadataExt;
    if meta.nlink() > 1 {
        return Err(IoFailure::new(
            "unsupported",
            "This file has hard links; save a separate copy",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn reject_hard_links(target: &Path, _meta: &fs::Metadata) -> Result<(), IoFailure> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct Info {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let file = File::open(target)?;
    let mut info = Info::default();
    // The handle stays alive and Info matches BY_HANDLE_FILE_INFORMATION.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if info.links > 1 {
        return Err(IoFailure::new(
            "unsupported",
            "This file has hard links; save a separate copy",
        ));
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn reject_hard_links(_target: &Path, _meta: &fs::Metadata) -> Result<(), IoFailure> {
    Ok(())
}

struct OwnedTemp(PathBuf);
impl Drop for OwnedTemp {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Copy as much of the original's security as this account may: owner, group
/// and DACL; else the DACL only; else nothing. Never fails a save.
#[cfg_attr(not(windows), allow(dead_code))]
fn copy_security(mut apply: impl FnMut(u32) -> bool) -> Option<u32> {
    [7, 4].into_iter().find(|&flags| apply(flags)) // OWNER|GROUP|DACL, then DACL
}

#[cfg(windows)]
fn preserve_security(from: &Path, to: &Path) {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "advapi32")]
    extern "system" {
        fn GetNamedSecurityInfoW(
            name: *const u16,
            object_type: u32,
            flags: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn SetNamedSecurityInfoW(
            name: *mut u16,
            object_type: u32,
            flags: u32,
            owner: *mut c_void,
            group: *mut c_void,
            dacl: *mut c_void,
            sacl: *mut c_void,
        ) -> u32;
        fn GetSecurityDescriptorControl(
            descriptor: *const c_void,
            control: *mut u16,
            revision: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    struct Descriptor(*mut c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut owner, mut group, mut dacl, mut descriptor) = (
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
    );
    // OWNER | GROUP | DACL, SE_FILE_OBJECT. Returned pointers belong to the
    // descriptor and remain valid until its LocalFree guard is dropped.
    let result = unsafe {
        GetNamedSecurityInfoW(
            from.as_ptr(),
            1,
            7,
            &mut owner,
            &mut group,
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return;
    }
    let descriptor = Descriptor(descriptor);
    let (mut control, mut revision) = (0, 0);
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
        return;
    }
    // Preserve whether inheritance is protected. Setting a foreign owner needs
    // privileges this account may lack (admin-created files, shares, other PCs),
    // so fall back to the DACL alone, then to the folder's defaults like any new
    // file. SACL audit metadata is not copied.
    let inheritance = if control & 0x1000 != 0 {
        0x8000_0000
    } else {
        0x2000_0000
    };
    copy_security(|flags| {
        let (owner, group) = if flags & 3 != 0 {
            (owner, group)
        } else {
            (std::ptr::null_mut(), std::ptr::null_mut())
        };
        unsafe {
            SetNamedSecurityInfoW(
                to.as_mut_ptr(),
                1,
                flags | inheritance,
                owner,
                group,
                dacl,
                std::ptr::null_mut(),
            ) == 0
        }
    });
}

fn temp_file(target: &Path) -> Result<(OwnedTemp, File), IoFailure> {
    let parent = target
        .parent()
        .ok_or_else(|| IoFailure::new("invalid", "Invalid destination"))?;
    for _ in 0..32 {
        let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".ambertext-{}-{id}.tmp", std::process::id()));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => return Ok((OwnedTemp(temp), file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(IoFailure::new(
        "io",
        "Could not reserve a unique temporary file",
    ))
}

#[cfg(windows)]
fn install(temp: &Path, target: &Path, create: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // No COPY_ALLOWED: staging and replacement must stay on the same volume.
    let flags = if create { 0 } else { 1 }; // MOVEFILE_REPLACE_EXISTING
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn install(temp: &Path, target: &Path, create: bool) -> io::Result<()> {
    if !create {
        return fs::rename(temp, target);
    }
    match fs::hard_link(temp, target) {
        Err(e) if e.kind() != io::ErrorKind::AlreadyExists => create_by_placeholder(temp, target),
        other => other,
    }
}

/// For volumes without hard links (exFAT, FAT, some network shares): claim the
/// name exclusively, then replace only that empty placeholder.
#[cfg_attr(windows, allow(dead_code))]
fn create_by_placeholder(temp: &Path, target: &Path) -> io::Result<()> {
    drop(OpenOptions::new().write(true).create_new(true).open(target)?);
    fs::rename(temp, target).map_err(|e| {
        if fs::metadata(target).is_ok_and(|m| m.len() == 0) {
            let _ = fs::remove_file(target);
        }
        e
    })
}

fn is_temp_name(name: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let Some(middle) = name
        .strip_prefix(".ambertext-")
        .and_then(|rest| rest.strip_suffix(".tmp"))
    else {
        return false;
    };
    matches!(middle.split_once('-'), Some((pid, id)) if digits(pid) && digits(id))
}

/// Remove staging files a crashed AmberText left in one app-owned folder: only
/// exact `.ambertext-<pid>-<n>.tmp` regular files from other processes that are
/// at least `min_age` old. Never call this on a user's folders.
pub fn sweep_stale_temps(dir: &Path, min_age: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let own = format!(".ambertext-{}-", std::process::id());
    let now = std::time::SystemTime::now();
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return false;
            };
            is_temp_name(name)
                && !name.starts_with(&own)
                && entry.metadata().is_ok_and(|m| {
                    m.file_type().is_file()
                        && m.modified()
                            .ok()
                            .and_then(|t| now.duration_since(t).ok())
                            .is_some_and(|age| age >= min_age)
                })
                && fs::remove_file(entry.path()).is_ok()
        })
        .count()
}

#[derive(Clone, Copy)]
enum Stage {
    BeforeWrite,
    BeforeFlush,
    BeforeReplace,
}

pub fn write(path: &Path, bytes: &[u8], intent: Intent) -> Result<Snapshot, IoFailure> {
    write_with(path, bytes, intent, |_| Ok(()))
}

fn write_with(
    path: &Path,
    bytes: &[u8],
    intent: Intent,
    mut hook: impl FnMut(Stage) -> io::Result<()>,
) -> Result<Snapshot, IoFailure> {
    let target = destination(path)?;
    let lock = destination_lock(&target);
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    // Re-resolve aliases under the lock; retargeting a symlink is a conflict.
    if destination(path)? != target {
        return Err(IoFailure::new(
            "conflict",
            "Destination changed during save",
        ));
    }
    verify(&target, &intent)?;
    let permissions = fs::metadata(&target).ok().map(|m| m.permissions());
    let (temp, mut file) = temp_file(&target)?;
    if let Some(permissions) = permissions {
        file.set_permissions(permissions)?;
    }
    #[cfg(windows)]
    if matches!(intent, Intent::Replace(_)) {
        preserve_security(&target, &temp.0);
    }
    hook(Stage::BeforeWrite)?;
    file.write_all(bytes)?;
    hook(Stage::BeforeFlush)?;
    file.sync_all()?;
    drop(file);
    hook(Stage::BeforeReplace)?;
    if destination(path)? != target {
        return Err(IoFailure::new(
            "conflict",
            "Destination changed during save",
        ));
    }
    verify(&target, &intent)?;
    install(&temp.0, &target, matches!(intent, Intent::Create))?;
    // Never turn a post-commit metadata/read failure into a reported failed save.
    // The committed fingerprint describes the exact bytes we staged, even if an
    // external writer subsequently changes them before the next read.
    let mtime = fs::metadata(&target)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Snapshot {
        bytes: bytes.to_vec(),
        revision: revision(&target, bytes),
        mtime,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "ambertext-safe-io-{}-{}",
                std::process::id(),
                TEMP_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn document(&self) -> PathBuf {
            let p = self.0.join("writing.md");
            fs::write(&p, b"original\r\nbytes").unwrap();
            p
        }
        fn no_temps(&self) {
            assert!(!fs::read_dir(&self.0)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(".ambertext-")));
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // The parent terminates only this directly spawned disposable writer.
    #[test]
    fn child_interrupted_writer() {
        let Some(root) = std::env::var_os("AMBERTEXT_SAVE_CHILD_ROOT") else { return };
        let root = PathBuf::from(root);
        let path = root.join("writing.md");
        let intent = if std::env::var("AMBERTEXT_SAVE_CHILD_INTENT").unwrap() == "create" {
            Intent::Create
        } else {
            Intent::Replace(read(&path).unwrap().revision)
        };
        let phase = std::env::var("AMBERTEXT_SAVE_CHILD_PHASE").unwrap();
        let ready = || {
            fs::write(root.join("child-ready"), phase.as_bytes()).unwrap();
            loop { std::thread::sleep(std::time::Duration::from_millis(50)); }
        };
        write_with(&path, "Replacement שלום 🙂\r\n".as_bytes(), intent, |stage| {
            if matches!((stage, phase.as_str()), (Stage::BeforeWrite, "before-write")
                | (Stage::BeforeFlush, "before-flush") | (Stage::BeforeReplace, "before-install")) {
                ready();
            }
            Ok(())
        }).unwrap();
        assert_eq!(phase, "installed");
        ready();
    }

    #[test]
    fn terminated_create_and_replace_keep_absent_original_or_complete_new_bytes() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        for intent in ["create", "replace"] {
            for phase in ["before-write", "before-flush", "before-install", "installed"] {
                let fixture = Fixture::new();
                let path = fixture.0.join("writing.md");
                if intent == "replace" { fixture.document(); }
                let mut command = std::process::Command::new(std::env::current_exe().unwrap());
                command.args(["--exact", "safe_io::tests::child_interrupted_writer", "--nocapture"])
                    .env("AMBERTEXT_SAVE_CHILD_ROOT", &fixture.0)
                    .env("AMBERTEXT_SAVE_CHILD_INTENT", intent)
                    .env("AMBERTEXT_SAVE_CHILD_PHASE", phase)
                    .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
                }
                let mut child = Child(command.spawn().unwrap());
                let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
                while !fixture.0.join("child-ready").exists() && std::time::Instant::now() < until {
                    assert!(child.0.try_wait().unwrap().is_none(), "Owned writer exited before {intent}/{phase}");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                assert_eq!(fs::read_to_string(fixture.0.join("child-ready")).unwrap(), phase);
                child.0.kill().unwrap(); child.0.wait().unwrap();
                if phase == "installed" {
                    assert_eq!(fs::read(&path).unwrap(), "Replacement שלום 🙂\r\n".as_bytes());
                    assert_eq!(read(&path).unwrap().revision, revision(&destination(&path).unwrap(), "Replacement שלום 🙂\r\n".as_bytes()));
                } else if intent == "replace" {
                    assert_eq!(fs::read(&path).unwrap(), b"original\r\nbytes");
                } else {
                    assert_eq!(fs::read(&path).unwrap_err().kind(), io::ErrorKind::NotFound);
                }
                // Interrupted staging may leave an auxiliary sibling temporary;
                // it must never become the canonical document before installation.
            }
        }
    }

    #[test]
    fn replacement_and_explicit_creation_commit_exact_bytes() {
        let f = Fixture::new();
        let p = f.document();
        let expected = read(&p).unwrap().revision;
        let saved = write(&p, b"new bytes", Intent::Replace(expected)).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"new bytes");
        assert_eq!(saved.revision, read(&p).unwrap().revision);
        let new = f.0.join("new.md");
        write(&new, b"created", Intent::Create).unwrap();
        assert!(write(&new, b"collision", Intent::Create).is_err());
        assert_eq!(fs::read(new).unwrap(), b"created");
        f.no_temps();
    }

    #[test]
    fn write_flush_and_replacement_failures_never_truncate_original() {
        for fail in [Stage::BeforeWrite, Stage::BeforeFlush, Stage::BeforeReplace] {
            let f = Fixture::new();
            let p = f.document();
            let before = fs::read(&p).unwrap();
            let expected = read(&p).unwrap().revision;
            let result = write_with(&p, b"replacement", Intent::Replace(expected), |stage| {
                if std::mem::discriminant(&stage) == std::mem::discriminant(&fail) {
                    Err(io::Error::other("injected storage failure"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(fs::read(p).unwrap(), before);
            f.no_temps();
        }
    }

    #[test]
    fn equal_length_intervening_edit_conflicts_even_without_mtime_comparison() {
        let f = Fixture::new();
        let p = f.document();
        let expected = read(&p).unwrap().revision;
        let result = write_with(&p, b"ours", Intent::Replace(expected), |stage| {
            if matches!(stage, Stage::BeforeReplace) {
                fs::write(&p, b"external\r\nbytes")?;
            }
            Ok(())
        });
        assert_eq!(result.unwrap_err().kind, "conflict");
        assert_eq!(fs::read(p).unwrap(), b"external\r\nbytes");
        f.no_temps();
    }

    #[test]
    fn deleted_target_is_not_recreated() {
        let f = Fixture::new();
        let p = f.document();
        let expected = read(&p).unwrap().revision;
        fs::remove_file(&p).unwrap();
        assert_eq!(
            write(&p, b"ours", Intent::Replace(expected))
                .unwrap_err()
                .kind,
            "missing"
        );
        assert!(!p.exists());
        f.no_temps();
    }

    #[test]
    fn read_only_target_is_preserved() {
        let f = Fixture::new();
        let p = f.document();
        let expected = read(&p).unwrap().revision;
        let mut permissions = fs::metadata(&p).unwrap().permissions();
        let original = permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&p, permissions).unwrap();
        assert_eq!(
            write(&p, b"ours", Intent::Replace(expected))
                .unwrap_err()
                .kind,
            "permission"
        );
        assert_eq!(fs::read(&p).unwrap(), b"original\r\nbytes");
        fs::set_permissions(p, original).unwrap();
        f.no_temps();
    }

    #[test]
    fn hard_link_writing_is_explicitly_rejected_without_splitting_aliases() {
        let f = Fixture::new();
        let p = f.document();
        let alias = f.0.join("alias.md");
        fs::hard_link(&p, &alias).unwrap();
        let expected = read(&p).unwrap().revision;
        assert_eq!(
            write(&p, b"ours", Intent::Replace(expected))
                .unwrap_err()
                .kind,
            "unsupported"
        );
        assert_eq!(fs::read(alias).unwrap(), b"original\r\nbytes");
        f.no_temps();
    }

    #[test]
    fn canonical_aliases_serialize_and_only_one_expected_revision_wins() {
        let f = Fixture::new();
        let p = f.document();
        let alias = f.0.join(".").join("writing.md");
        let revision = read(&p).unwrap().revision;
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = [p.clone(), alias]
            .into_iter()
            .enumerate()
            .map(|(i, path)| {
                let expected = revision.clone();
                let ready = barrier.clone();
                std::thread::spawn(move || {
                    ready.wait();
                    write(
                        &path,
                        format!("writer {i}").as_bytes(),
                        Intent::Replace(expected),
                    )
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, Err(e) if e.kind == "conflict"))
                .count(),
            1
        );
        f.no_temps();
    }

    #[test]
    fn security_copy_falls_back_to_dacl_then_nothing() {
        let mut tried = Vec::new();
        assert_eq!(copy_security(|flags| { tried.push(flags); true }), Some(7));
        assert_eq!(tried, [7]);
        tried.clear();
        // A file owned by another account: the owner copy is denied, the DACL is kept.
        assert_eq!(copy_security(|flags| { tried.push(flags); flags == 4 }), Some(4));
        assert_eq!(tried, [7, 4]);
        assert_eq!(copy_security(|_| false), None);
    }

    #[test]
    fn create_without_hard_links_never_replaces_existing_files() {
        let f = Fixture::new();
        let new = f.0.join("new.md");
        let (temp, mut file) = temp_file(&new).unwrap();
        file.write_all(b"created").unwrap();
        drop(file);
        create_by_placeholder(&temp.0, &new).unwrap();
        assert_eq!(fs::read(new).unwrap(), b"created");
        let p = f.document();
        let (temp, mut file) = temp_file(&p).unwrap();
        file.write_all(b"collision").unwrap();
        drop(file);
        assert_eq!(
            create_by_placeholder(&temp.0, &p).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        drop(temp);
        assert_eq!(fs::read(p).unwrap(), b"original\r\nbytes");
        f.no_temps();
    }

    #[test]
    fn stale_temp_sweep_only_removes_exact_foreign_staging_files() {
        let f = Fixture::new();
        let keep = [
            "writing.md",
            ".ambertext-12-x.tmp",
            ".ambertext-12-3.tmp.md",
            "ambertext-12-3.tmp",
            ".ambertext-12.tmp",
            ".ambertext--3.tmp",
            ".ambertext-12-3-4.tmp",
        ];
        for name in keep {
            fs::write(f.0.join(name), b"keep").unwrap();
        }
        let own = format!(".ambertext-{}-9.tmp", std::process::id());
        fs::write(f.0.join(&own), b"in use").unwrap();
        fs::create_dir(f.0.join(".ambertext-1-2.tmp")).unwrap();
        fs::write(f.0.join(".ambertext-4294967295-7.tmp"), b"orphan").unwrap();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        assert_eq!(sweep_stale_temps(&f.0, day), 0);
        assert!(f.0.join(".ambertext-4294967295-7.tmp").exists());
        assert_eq!(sweep_stale_temps(&f.0, std::time::Duration::ZERO), 1);
        assert!(!f.0.join(".ambertext-4294967295-7.tmp").exists());
        for name in keep {
            assert_eq!(fs::read(f.0.join(name)).unwrap(), b"keep");
        }
        assert!(f.0.join(own).exists() && f.0.join(".ambertext-1-2.tmp").is_dir());
        assert_eq!(sweep_stale_temps(&f.0.join("missing"), day), 0);
    }

    #[cfg(windows)]
    #[test]
    fn real_windows_sharing_lock_rejects_replacement_and_preserves_bytes() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let p = f.document();
        let expected = read(&p).unwrap().revision;
        let mut held = None;
        let result = write_with(&p, b"ours", Intent::Replace(expected), |stage| {
            if matches!(stage, Stage::BeforeReplace) {
                held = Some(OpenOptions::new().read(true).share_mode(1).open(&p)?);
                // read sharing, no delete sharing
            }
            Ok(())
        });
        assert!(result.is_err());
        drop(held);
        assert_eq!(fs::read(p).unwrap(), b"original\r\nbytes");
        f.no_temps();
    }

    #[cfg(windows)]
    #[test]
    fn windows_protected_dacl_owner_and_group_survive_replacement() {
        let f = Fixture::new();
        let p = f.document();
        let path = p.to_string_lossy().replace('\'', "''");
        let powershell = |script: String| {
            let out = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8(out.stdout).unwrap().trim().to_owned()
        };
        let before = powershell(format!("$ErrorActionPreference='Stop'; $a=[System.IO.File]::GetAccessControl('{path}'); $a.SetAccessRuleProtection($true,$true); [System.IO.File]::SetAccessControl('{path}',$a); [System.IO.File]::GetAccessControl('{path}').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)"));
        let expected = read(&p).unwrap().revision;
        write(&p, b"private writing", Intent::Replace(expected)).unwrap();
        let after = powershell(format!("$ErrorActionPreference='Stop'; [System.IO.File]::GetAccessControl('{path}').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)"));
        assert_eq!(before, after);
        assert_eq!(fs::read(p).unwrap(), b"private writing");
        f.no_temps();
    }
}
