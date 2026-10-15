//! Auxiliary device-local writing snapshots. Callers serialize whole transactions.
//! A corrupt or unsupported source is renamed aside, never deleted, and the
//! healthy slot keeps working. Oversized snapshots keep unsaved writing first.
use crate::{
    safe_io::{self, Intent, IoFailure, Revision},
    text_format::TextFormat,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

const MAX_BYTES: u64 = 32 * 1024 * 1024;
const MAX_DOCUMENTS: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDoc {
    pub id: String,
    pub name: String,
    pub current_path: Option<String>,
    pub original_path: Option<String>,
    pub content: String,
    pub saved_content: Option<String>,
    pub saved_revision: Option<Revision>,
    pub format: Option<TextFormat>,
    pub original_text: Option<String>,
    pub updated_at: u64,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub updated_at: u64,
    pub docs: Vec<RecoveryDoc>,
    pub active_id: Option<String>,
    pub root: Option<String>,
    pub legacy_source_hash: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Envelope {
    version: u32,
    sequence: u64,
    sha256: String,
    snapshot: Snapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub snapshot: Option<Snapshot>,
    pub sequence: u64,
    pub warnings: Vec<String>,
    pub writable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub sequence: u64,
    /// Documents left out to stay within the limits; unsaved writing goes first.
    pub omitted: usize,
}

fn validate(snapshot: &Snapshot) -> Result<(), IoFailure> {
    if snapshot.version != 1 {
        return Err(IoFailure::new(
            "unsupported",
            "Unsupported recovery format. Its source has been retained.",
        ));
    }
    if snapshot.docs.len() > MAX_DOCUMENTS {
        return Err(IoFailure::new(
            "invalid",
            "Recovery has reached its document limit. Save copies before closing.",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    if snapshot
        .docs
        .iter()
        .any(|doc| doc.id.is_empty() || !ids.insert(&doc.id))
    {
        return Err(IoFailure::new(
            "invalid",
            "Some crash recovery data couldn’t be read.",
        ));
    }
    Ok(())
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_slot(path: &Path) -> Result<Option<(Envelope, safe_io::Snapshot)>, IoFailure> {
    match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(meta) if meta.len() > MAX_BYTES => {
            return Err(IoFailure::new(
                "invalid",
                "Crash recovery data is too large to read.",
            ))
        }
        _ => {}
    }
    let disk = safe_io::read(path)?;
    let envelope: Envelope = serde_json::from_slice(&disk.bytes).map_err(|_| {
        IoFailure::new(
            "invalid",
            "Some crash recovery data couldn’t be read. It has been kept, not deleted.",
        )
    })?;
    validate(&envelope.snapshot)?;
    if envelope.version != 1
        || envelope.sha256
            != hash(
                &serde_json::to_vec(&envelope.snapshot)
                    .map_err(|e| IoFailure::new("invalid", e.to_string()))?,
            )
    {
        return Err(IoFailure::new(
            "invalid",
            "Recovery integrity check failed; its source has been retained.",
        ));
    }
    Ok(Some((envelope, disk)))
}

/// Unreadable, unsupported or failed-integrity content, as opposed to a storage error.
fn damaged(error: &IoFailure) -> bool {
    matches!(error.kind, "invalid" | "unsupported")
}

/// Rename a damaged slot aside (`current.json.corrupt-<ms>`); its bytes are kept.
fn quarantine(path: &Path) -> Result<(), IoFailure> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    for n in 0..100 {
        let suffix = if n == 0 { String::new() } else { format!("-{n}") };
        let aside = path.with_file_name(format!("{name}.corrupt-{stamp}{suffix}"));
        match fs::symlink_metadata(&aside) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::rename(path, aside)?;
                return Ok(());
            }
            _ => {}
        }
    }
    Err(IoFailure::new("io", "Could not set aside damaged recovery"))
}

fn healthy_slot(path: &Path) -> Result<Option<(Envelope, safe_io::Snapshot)>, IoFailure> {
    match read_slot(path) {
        Err(error) if damaged(&error) => quarantine(path).map(|_| None),
        other => other,
    }
}

fn unsaved(doc: &RecoveryDoc) -> bool {
    doc.saved_content.as_deref() != Some(doc.content.as_str())
}

/// Keep what fits the document and byte limits, unsaved writing and the active
/// document first, in their original order. Returns how many were left out.
fn fit(snapshot: &mut Snapshot) -> Result<usize, IoFailure> {
    let invalid = |e: serde_json::Error| IoFailure::new("invalid", e.to_string());
    let sizes = snapshot
        .docs
        .iter()
        .map(|doc| serde_json::to_vec(doc).map(|v| v.len() as u64 + 1))
        .collect::<Result<Vec<_>, _>>()
        .map_err(invalid)?;
    let base = serde_json::to_vec(&Snapshot {
        version: snapshot.version,
        updated_at: snapshot.updated_at,
        docs: Vec::new(),
        active_id: snapshot.active_id.clone(),
        root: snapshot.root.clone(),
        legacy_source_hash: snapshot.legacy_source_hash.clone(),
    })
    .map_err(invalid)?
    .len() as u64;
    // Envelope fields around the snapshot: version, sequence and checksum.
    let budget = MAX_BYTES.saturating_sub(base + 256);
    if snapshot.docs.len() <= MAX_DOCUMENTS && sizes.iter().sum::<u64>() <= budget {
        return Ok(0);
    }
    let mut order: Vec<usize> = (0..snapshot.docs.len()).collect();
    order.sort_by_key(|&i| {
        let doc = &snapshot.docs[i];
        (!unsaved(doc), snapshot.active_id.as_ref() != Some(&doc.id), i)
    });
    let (mut keep, mut used, mut count) = (vec![false; sizes.len()], 0, 0);
    for i in order {
        if count < MAX_DOCUMENTS && used + sizes[i] <= budget {
            keep[i] = true;
            used += sizes[i];
            count += 1;
        }
    }
    let before = snapshot.docs.len();
    let mut flags = keep.into_iter();
    snapshot.docs.retain(|_| flags.next().unwrap_or(false));
    Ok(before - snapshot.docs.len())
}

pub fn load(root: &Path) -> Loaded {
    let mut warnings = Vec::new();
    let mut writable = true;
    let mut newest: Option<Envelope> = None;
    for name in ["current.json", "previous.json"] {
        match read_slot(&root.join(name)) {
            Ok(Some((record, _))) => {
                if newest
                    .as_ref()
                    .map_or(true, |old| record.sequence > old.sequence)
                {
                    newest = Some(record);
                }
            }
            Ok(None) => {}
            Err(error) => {
                // A damaged slot is set aside by the next write; storage errors persist.
                writable &= damaged(&error);
                warnings.push(format!("{name}: {}", error.message));
            }
        }
    }
    Loaded {
        sequence: newest.as_ref().map_or(0, |record| record.sequence),
        snapshot: newest.map(|record| record.snapshot),
        writable,
        warnings,
    }
}

fn create_root(root: &Path) -> Result<(), IoFailure> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root)?;
    Ok(())
}

pub fn write(root: &Path, snapshot: Snapshot) -> Result<Written, IoFailure> {
    write_with(root, snapshot, || Ok(()))
}

fn write_with(
    root: &Path,
    mut snapshot: Snapshot,
    before_current: impl FnOnce() -> Result<(), IoFailure>,
) -> Result<Written, IoFailure> {
    let omitted = fit(&mut snapshot)?;
    validate(&snapshot)?;
    create_root(root)?;
    // Never overwrite a corrupt/unsupported source: it is renamed aside instead.
    let current = healthy_slot(&root.join("current.json"))?;
    let previous = healthy_slot(&root.join("previous.json"))?;
    let sequence = current
        .as_ref()
        .map_or(0, |x| x.0.sequence)
        .max(previous.as_ref().map_or(0, |x| x.0.sequence))
        .checked_add(1)
        .ok_or_else(|| IoFailure::new("invalid", "Recovery sequence exhausted"))?;
    let envelope = Envelope {
        version: 1,
        sequence,
        sha256: hash(
            &serde_json::to_vec(&snapshot).map_err(|e| IoFailure::new("invalid", e.to_string()))?,
        ),
        snapshot,
    };
    let bytes =
        serde_json::to_vec(&envelope).map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(IoFailure::new("io", "Recovery has reached its storage limit. Your writing remains open; save copies before closing."));
    }
    if let Some((_, old)) = &current {
        let intent = previous
            .as_ref()
            .map_or(Intent::Create, |x| Intent::Replace(x.1.revision.clone()));
        safe_io::write(&root.join("previous.json"), &old.bytes, intent)?;
    }
    before_current()?;
    let intent = current
        .as_ref()
        .map_or(Intent::Create, |x| Intent::Replace(x.1.revision.clone()));
    safe_io::write(&root.join("current.json"), &bytes, intent)?;
    let verified = safe_io::read(&root.join("current.json"))?;
    if verified.bytes != bytes {
        return Err(IoFailure::new(
            "conflict",
            "Recovery changed during verification. Keep the writing open.",
        ));
    }
    Ok(Written { sequence, omitted })
}

pub fn preserve_legacy(root: &Path, source: &str) -> Result<String, IoFailure> {
    if source.len() as u64 > MAX_BYTES {
        return Err(IoFailure::new(
            "invalid",
            "Legacy recovery exceeds its safe import limit.",
        ));
    }
    create_root(root)?;
    let fingerprint = hash(source.as_bytes());
    let path = root.join(format!("legacy-{fingerprint}.json"));
    match safe_io::read(&path) {
        Ok(existing) if existing.bytes == source.as_bytes() => return Ok(fingerprint),
        Ok(_) => {
            return Err(IoFailure::new(
                "conflict",
                "Legacy recovery copy does not match its source.",
            ))
        }
        Err(e) if e.kind == "missing" => {}
        Err(e) => return Err(e),
    }
    safe_io::write(&path, source.as_bytes(), Intent::Create)?;
    if safe_io::read(&path)?.bytes != source.as_bytes() {
        return Err(IoFailure::new(
            "conflict",
            "Legacy recovery could not be verified.",
        ));
    }
    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static ID: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "ambertext-recovery-{}-{}",
                std::process::id(),
                ID.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn snapshot(text: &str) -> Snapshot {
        Snapshot {
            version: 1,
            updated_at: 123,
            docs: vec![RecoveryDoc {
                id: "stable-draft".into(),
                name: "Draft".into(),
                current_path: None,
                original_path: Some("missing.md".into()),
                content: text.into(),
                saved_content: None,
                saved_revision: None,
                format: Some(TextFormat::default()),
                original_text: None,
                updated_at: 123,
                reason: Some("recovered".into()),
            }],
            active_id: Some("stable-draft".into()),
            root: None,
            legacy_source_hash: None,
        }
    }
    #[test]
    fn reopened_store_restores_exact_text_and_identity() {
        let fixture = Fixture::new();
        let expected = snapshot("Unsaved שלום\nمرحبا 🙂");
        let written = write(&fixture.0, expected.clone()).unwrap();
        assert_eq!((written.sequence, written.omitted), (1, 0));
        assert_eq!(load(&fixture.0).snapshot.unwrap(), expected);
    }
    // Only the explicitly spawned disposable test process enters this helper.
    #[test]
    fn child_writer() {
        let Some(root) = std::env::var_os("AMBERTEXT_RECOVERY_CHILD_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let mut next = snapshot("Unsaved שלום\nمرحبا 🙂");
        let mut backed = next.docs[0].clone();
        backed.id = "path-backed".into();
        backed.current_path = Some("copied-fixture.md".into());
        backed.saved_content = Some("saved baseline".into());
        next.docs.push(backed);
        let ready = || {
            fs::write(root.join("child-ready"), b"ready").unwrap();
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        };
        if std::env::var("AMBERTEXT_RECOVERY_CHILD_PHASE").unwrap() == "before-install" {
            let _ = write_with(&root, next, ready);
        } else {
            write(&root, next).unwrap();
            let _ = ready();
        }
    }
    #[test]
    fn killed_writer_preserves_committed_or_preceding_snapshot() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for phase in ["installed", "before-install"] {
            let fixture = Fixture::new();
            write(&fixture.0, snapshot("previous committed writing")).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                    .args(["--exact", "recovery::tests::child_writer", "--nocapture"])
                    .env("AMBERTEXT_RECOVERY_CHILD_ROOT", &fixture.0)
                    .env("AMBERTEXT_RECOVERY_CHILD_PHASE", phase)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let mut child = Child(command.spawn().unwrap());
            let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
            while !fixture.0.join("child-ready").exists() && std::time::Instant::now() < until {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "Disposable writer exited before its checkpoint"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(
                fixture.0.join("child-ready").exists(),
                "Writer did not reach its checkpoint"
            );
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            let restored = load(&fixture.0);
            assert!(restored.writable);
            let restored = restored.snapshot.unwrap();
            if phase == "installed" {
                assert_eq!(restored.docs[0].id, "stable-draft");
                assert_eq!(restored.docs[0].content, "Unsaved שלום\nمرحبا 🙂");
                assert_eq!(
                    restored.docs[1].current_path.as_deref(),
                    Some("copied-fixture.md")
                );
                assert_eq!(
                    restored.docs[1].saved_content.as_deref(),
                    Some("saved baseline")
                );
            } else {
                assert_eq!(restored.docs[0].content, "previous committed writing");
            }
        }
    }
    #[test]
    fn readonly_journal_failure_retains_readable_writing() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("original")).unwrap();
        let path = fixture.0.join("current.json");
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(write(&fixture.0, snapshot("new")).is_err());
        assert_eq!(
            load(&fixture.0).snapshot.unwrap().docs[0].content,
            "original"
        );
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
    }
    #[test]
    fn failure_between_backup_and_install_keeps_previous_readable() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("original")).unwrap();
        assert!(
            write_with(&fixture.0, snapshot("new"), || Err(IoFailure::new(
                "io",
                "Injected full storage"
            )))
            .is_err()
        );
        assert_eq!(
            load(&fixture.0).snapshot.unwrap().docs[0].content,
            "original"
        );
        assert_eq!(
            read_slot(&fixture.0.join("previous.json"))
                .unwrap()
                .unwrap()
                .0
                .snapshot
                .docs[0]
                .content,
            "original"
        );
    }
    #[test]
    fn corrupt_current_exposes_good_fallback_and_is_set_aside_not_overwritten() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("first")).unwrap();
        write(&fixture.0, snapshot("second")).unwrap();
        fs::write(fixture.0.join("current.json"), b"damaged").unwrap();
        let found = load(&fixture.0);
        assert!(found.writable && !found.warnings.is_empty());
        assert_eq!(found.snapshot.unwrap().docs[0].content, "first");
        write(&fixture.0, snapshot("third")).unwrap();
        assert_eq!(set_aside(&fixture.0, "current.json"), [b"damaged".to_vec()]);
        let found = load(&fixture.0);
        assert!(found.warnings.is_empty());
        assert_eq!(found.snapshot.unwrap().docs[0].content, "third");
        let previous = read_slot(&fixture.0.join("previous.json")).unwrap().unwrap();
        assert_eq!(previous.0.snapshot.docs[0].content, "first");
    }
    fn set_aside(root: &Path, slot: &str) -> Vec<Vec<u8>> {
        fs::read_dir(root)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{slot}.corrupt-"))
            })
            .map(|e| fs::read(e.path()).unwrap())
            .collect()
    }
    #[test]
    fn unsupported_previous_is_set_aside_and_current_keeps_working() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("first")).unwrap();
        write(&fixture.0, snapshot("second")).unwrap();
        let path = fixture.0.join("previous.json");
        let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["snapshot"]["version"] = 2.into();
        let newer = serde_json::to_vec(&value).unwrap();
        fs::write(&path, &newer).unwrap();
        assert_eq!(load(&fixture.0).snapshot.unwrap().docs[0].content, "second");
        write(&fixture.0, snapshot("third")).unwrap();
        assert_eq!(set_aside(&fixture.0, "previous.json"), [newer]);
        let found = load(&fixture.0);
        assert!(found.warnings.is_empty());
        assert_eq!(found.snapshot.unwrap().docs[0].content, "third");
        let previous = read_slot(&path).unwrap().unwrap();
        assert_eq!(previous.0.snapshot.docs[0].content, "second");
    }
    fn many(count: usize, unsaved_every: usize) -> Snapshot {
        let mut next = snapshot("");
        next.docs = (0..count)
            .map(|i| {
                let mut doc = snapshot(&format!("writing {i}")).docs.remove(0);
                doc.id = format!("doc-{i}");
                if i % unsaved_every != 0 {
                    doc.saved_content = Some(doc.content.clone());
                }
                doc
            })
            .collect();
        next.active_id = Some("doc-1".into());
        next
    }
    #[test]
    fn too_many_documents_keeps_unsaved_and_active_first() {
        let fixture = Fixture::new();
        let next = many(300, 7);
        let written = write(&fixture.0, next.clone()).unwrap();
        assert_eq!(written.omitted, 300 - MAX_DOCUMENTS);
        let kept = load(&fixture.0).snapshot.unwrap().docs;
        assert_eq!(kept.len(), MAX_DOCUMENTS);
        let ids: Vec<_> = kept.iter().map(|d| d.id.as_str()).collect();
        assert!(next.docs.iter().filter(|d| unsaved(d)).all(|d| ids.contains(&d.id.as_str())));
        assert!(ids.contains(&"doc-1"));
        let mut sorted = ids.clone();
        sorted.sort_by_key(|id| id[4..].parse::<usize>().unwrap());
        assert_eq!(ids, sorted, "Kept documents changed their order");
    }
    #[test]
    fn oversized_writing_keeps_unsaved_writing_within_the_byte_limit() {
        let fixture = Fixture::new();
        let mut next = many(3, 3);
        let mib = 1024 * 1024;
        for (i, doc) in next.docs.iter_mut().enumerate() {
            doc.content = ["a", "b", "c"][i].repeat(if i == 0 { 10 * mib } else { 6 * mib });
            if i != 0 {
                doc.saved_content = Some(doc.content.clone());
            }
        }
        next.active_id = None;
        let written = write(&fixture.0, next).unwrap();
        assert_eq!(written.omitted, 1);
        assert!(fs::metadata(fixture.0.join("current.json")).unwrap().len() <= MAX_BYTES);
        let kept = load(&fixture.0).snapshot.unwrap().docs;
        assert_eq!(kept.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["doc-0", "doc-1"]);
        assert_eq!(kept[0].content.len(), 10 * mib);
    }
    #[test]
    fn checksum_detects_valid_json_with_changed_writing() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("first")).unwrap();
        let path = fixture.0.join("current.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["snapshot"]["docs"][0]["content"] = "modified".into();
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let found = load(&fixture.0);
        assert!(found.snapshot.is_none() && !found.warnings.is_empty());
        let tampered = fs::read(&path).unwrap();
        write(&fixture.0, snapshot("second")).unwrap();
        assert_eq!(set_aside(&fixture.0, "current.json"), [tampered]);
    }
    #[test]
    fn legacy_import_is_idempotent_and_source_is_exact() {
        let fixture = Fixture::new();
        let source = "{\"docs\":[{\"content\":\"Old unsaved text\"}]}";
        let a = preserve_legacy(&fixture.0, source).unwrap();
        let b = preserve_legacy(&fixture.0, source).unwrap();
        assert_eq!(a, b);
        assert_eq!(
            fs::read(fixture.0.join(format!("legacy-{a}.json"))).unwrap(),
            source.as_bytes()
        );
    }
    #[test]
    fn invalid_identity_and_versions_do_not_replace_recovery() {
        let fixture = Fixture::new();
        write(&fixture.0, snapshot("original")).unwrap();
        let mut next = snapshot("bad");
        next.version = 2;
        assert!(write(&fixture.0, next).is_err());
        let mut next = snapshot("bad");
        next.docs.push(next.docs[0].clone());
        assert!(write(&fixture.0, next).is_err());
        assert_eq!(
            load(&fixture.0).snapshot.unwrap().docs[0].content,
            "original"
        );
    }
}
