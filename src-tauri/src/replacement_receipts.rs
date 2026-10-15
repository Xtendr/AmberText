//! Auxiliary, checksummed batch receipts. Never stores canonical writing.
use crate::safe_io::{self, Intent, IoFailure, Revision};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::{Path, PathBuf}};
const LIMIT: u64 = 4 * 1024 * 1024;
/// Receipts kept in the folder; only older receipts whose protection was released are removed.
pub const KEEP: usize = 100;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub version: u32, pub id: String, pub root: String,
    pub created_at: u64, pub updated_at: u64, pub state: String,
    pub files: Vec<FileReceipt>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReceipt {
    pub document_id: String, pub path: String, pub relative_path: String,
    pub mode: String, pub before_hash: String, pub after_hash: String,
    pub before_revision: Revision, pub after_revision: Option<Revision>,
    pub before_sequence: Option<u64>, pub after_sequence: Option<u64>, pub disk_sequence: Option<u64>,
    pub state: String, pub message: String,
}
#[derive(Debug, Serialize)]
pub struct Record { pub receipt: Receipt, pub revision: Revision }
#[derive(Serialize)]
pub struct Catalogue { pub records: Vec<Record>, pub warnings: Vec<String>, pub truncated: bool }
#[derive(Deserialize, Serialize)]
struct Envelope { receipt: Receipt, sha256: String }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn fingerprint(id: &str) -> bool { id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
fn path(root: &Path, id: &str) -> Result<PathBuf, IoFailure> {
    if !valid_id(id) { return Err(IoFailure::new("invalid", "Invalid replacement receipt identity")); }
    Ok(root.join(format!("{id}.json")))
}
fn validate(r: &Receipt) -> Result<(), IoFailure> {
    let mut identities = std::collections::HashSet::new();
    if r.version != 1 || !valid_id(&r.id) || r.root.is_empty() || r.root.len() > 32768
        || r.files.is_empty() || r.files.len() > 2000
        || !["running", "stopped", "complete", "releasing", "released"].contains(&r.state.as_str())
        || r.files.iter().any(|f| !valid_id(&f.document_id) || !identities.insert(f.document_id.clone())
            || f.path.is_empty() || f.path.len() > 32768 || f.relative_path.len() > 32768
            || !["disk", "buffer"].contains(&f.mode.as_str())
            || !fingerprint(&f.before_hash) || !fingerprint(&f.after_hash)
            || f.message.len() > 4096 || f.before_sequence == Some(0) || f.after_sequence == Some(0) || f.disk_sequence == Some(0)
            || !["pending", "prepared", "applying", "applied", "skipped", "failed", "reverting", "reverted", "conflict"].contains(&f.state.as_str())) {
        return Err(IoFailure::new("invalid", "A past replacement couldn’t be read. It has been kept, not deleted"));
    }
    Ok(())
}
fn regular(p: &Path) -> Result<(), IoFailure> {
    match fs::symlink_metadata(p) {
        Ok(m) => {
            #[cfg(windows)]
            { use std::os::windows::fs::MetadataExt;
              if m.file_attributes() & 0x400 != 0 { return Err(IoFailure::new("invalid", "A past replacement record is a link, so it was skipped")); } }
            if m.file_type().is_symlink() { return Err(IoFailure::new("invalid", "A past replacement record is a link, so it was skipped")); }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub fn read(root: &Path, id: &str) -> Result<Record, IoFailure> {
    regular(root)?;
    let p = path(root, id)?; regular(&p)?;
    let canonical = fs::canonicalize(&p)?;
    let mut bytes = Vec::new();
    fs::File::open(&p)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT { return Err(IoFailure::new("invalid", "A past replacement record is too large to read")); }
    let env: Envelope = serde_json::from_slice(&bytes).map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    validate(&env.receipt)?;
    if env.receipt.id != id || env.sha256 != digest(&serde_json::to_vec(&env.receipt).map_err(|e| IoFailure::new("invalid", e.to_string()))?) {
        return Err(IoFailure::new("invalid", "A past replacement record is damaged. It has been kept, not deleted"));
    }
    Ok(Record { receipt: env.receipt, revision: Revision { canonical_path: canonical.to_string_lossy().into_owned(), sha256: digest(&bytes) } })
}
pub fn write(root: &Path, receipt: Receipt, expected: Option<Revision>) -> Result<Record, IoFailure> {
    validate(&receipt)?; regular(root)?;
    let mut builder = fs::DirBuilder::new(); builder.recursive(true);
    #[cfg(unix)]
    { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(root)?;
    let p = path(root, &receipt.id)?; regular(&p)?;
    let current = match read(root, &receipt.id) {
        Ok(record) => Some(record),
        Err(e) if e.kind == "missing" => None,
        Err(e) => return Err(e),
    };
    if current.as_ref().map(|r| &r.revision) != expected.as_ref() {
        return Err(IoFailure::new("conflict", "A past replacement record changed while being saved. Both copies have been kept"));
    }
    let encoded = serde_json::to_vec(&receipt).map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    let envelope = Envelope { receipt, sha256: digest(&encoded) };
    let bytes = serde_json::to_vec(&envelope).map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    if bytes.len() as u64 > LIMIT { return Err(IoFailure::new("invalid", "This replacement touches too many files to record. Try fewer files")); }
    safe_io::write(&p, &bytes, expected.map_or(Intent::Create, Intent::Replace))?;
    let result = read(root, &envelope.receipt.id)?;
    if result.revision.sha256 != digest(&bytes) { return Err(IoFailure::new("conflict", "A past replacement record changed while being checked. Try again")); }
    if result.receipt.state == "released" { prune(root, KEEP); }
    Ok(result)
}
/// Delete the oldest released receipts beyond `keep`. Receipts that can still be undone,
/// inspected or released are never removed, whatever their age.
pub fn prune(root: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let mut found: Vec<(u64, PathBuf, bool)> = entries.flatten().filter_map(|entry| {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") { return None; }
        let record = read(root, p.file_stem()?.to_str()?).ok()?;
        Some((record.receipt.created_at, p, record.receipt.state == "released"))
    }).collect();
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, p, released) in found.into_iter().skip(keep) {
        if released { let _ = fs::remove_file(p); }
    }
}
pub fn catalogue(root: &Path) -> Result<Catalogue, IoFailure> {
    regular(root)?;
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Catalogue { records: vec![], warnings: vec![], truncated: false }),
        Err(e) => return Err(e.into()),
    };
    let mut result = Catalogue { records: vec![], warnings: vec![], truncated: false };
    let mut retained = 0;
    for (i, entry) in entries.enumerate() {
        if i >= 200 { result.truncated = true; break; }
        match entry {
            Ok(entry) => {
                let p = entry.path();
                if p.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
                retained += fs::symlink_metadata(&p).map(|m| m.len().min(LIMIT)).unwrap_or(0);
                if retained > 16 * 1024 * 1024 { result.truncated = true; break; }
                match p.file_stem().and_then(|s| s.to_str()).ok_or_else(|| IoFailure::new("invalid", "Non-Unicode receipt identity"))
                    .and_then(|id| read(root, id)) {
                    Ok(record) => result.records.push(record),
                    Err(e) => result.warnings.push(e.message),
                }
            }
            Err(e) => result.warnings.push(e.to_string()),
        }
    }
    result.records.sort_by_key(|r| std::cmp::Reverse(r.receipt.created_at));
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!("ambertext-receipts-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&p).unwrap(); p
    }
    fn receipt() -> Receipt {
        Receipt { version: 1, id: "batch-one".into(), root: "fixture".into(), created_at: 1, updated_at: 1, state: "running".into(),
            files: vec![FileReceipt { document_id: "document-one".into(), path: "writing.md".into(), relative_path: "writing.md".into(), mode: "disk".into(),
                before_hash: "a".repeat(64), after_hash: "b".repeat(64), before_revision: Revision { canonical_path: "writing.md".into(), sha256: "a".repeat(64) },
                after_revision: None, before_sequence: None, after_sequence: None, disk_sequence: None, state: "pending".into(), message: "".into() }] }
    }
    #[test]
    fn restart_links_and_stale_updates_preserve_receipt() {
        let root = fixture(); let first = write(&root, receipt(), None).unwrap();
        let mut next = first.receipt.clone(); next.files[0].before_sequence = Some(7); next.files[0].disk_sequence = Some(6); next.files[0].state = "applying".into();
        let second = write(&root, next, Some(first.revision.clone())).unwrap();
        assert_eq!(read(&root, "batch-one").unwrap().receipt.files[0].before_sequence, Some(7));
        assert_eq!(catalogue(&root).unwrap().records.len(), 1);
        assert_eq!(write(&root, receipt(), Some(first.revision)).unwrap_err().kind, "conflict");
        assert_eq!(read(&root, "batch-one").unwrap().revision, second.revision);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pruning_removes_only_old_released_receipts() {
        let root = fixture();
        for n in 0..5u64 {
            let mut r = receipt(); r.id = format!("batch-{n}"); r.created_at = n; r.state = if n == 0 { "stopped" } else { "released" }.into();
            r.files[0].document_id = format!("document-{n}"); r.files[0].state = "applied".into();
            write(&root, r, None).unwrap();
        }
        prune(&root, 3);
        let mut left: Vec<String> = catalogue(&root).unwrap().records.iter().map(|r| r.receipt.id.clone()).collect(); left.sort();
        // The two oldest are beyond the bound; the oldest is still undoable and stays.
        assert_eq!(left, vec!["batch-0", "batch-2", "batch-3", "batch-4"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_and_oversized_sources_are_not_replaced() {
        let root = fixture(); write(&root, receipt(), None).unwrap();
        let p = path(&root, "batch-one").unwrap();
        fs::write(&p, b"broken receipt").unwrap();
        assert!(write(&root, receipt(), None).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"broken receipt");
        assert_eq!(catalogue(&root).unwrap().warnings.len(), 1);
        fs::write(&p, vec![b'x'; LIMIT as usize + 1]).unwrap();
        assert!(read(&root, "batch-one").is_err());
        assert!(write(&root, receipt(), None).is_err());
        assert_eq!(fs::metadata(&p).unwrap().len(), LIMIT + 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unsupported_shapes_do_not_create_files() {
        let root = fixture(); let mut r = receipt(); r.id = "../escape".into(); assert!(write(&root, r, None).is_err());
        let mut r = receipt(); r.version = 2; assert!(write(&root, r, None).is_err());
        let mut r = receipt(); r.files[0].before_sequence = Some(0); assert!(write(&root, r, None).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0); fs::remove_dir_all(root).unwrap();
    }
    // A headless child exercises existing native history, conditional writes
    // and receipt owners. It is not a native UI/IPC or installed-app fixture.
    #[test]
    fn child_batch_writer() {
        let Some(root) = std::env::var_os("AMBERTEXT_BATCH_CHILD_ROOT") else { return; };
        let root = PathBuf::from(root);
        let phase = std::env::var("AMBERTEXT_BATCH_CHILD_PHASE").unwrap();
        let writing = root.join("A.md");
        let history = root.join("history"); let journal = root.join("receipts");
        let disk = safe_io::read(&writing).unwrap();
        let (_, format) = crate::text_format::decode(&disk.bytes).unwrap();
        let before = "Original needle\nالعربية שלום 🙂";
        let after = "Original revised\nالعربية שלום 🙂";
        let mut r = receipt(); r.root = root.to_string_lossy().into_owned();
        r.files[0].path = writing.to_string_lossy().into_owned();
        r.files[0].before_revision = disk.revision.clone();
        r.files[0].before_hash = digest(before.as_bytes()); r.files[0].after_hash = digest(after.as_bytes());
        let mut second = r.files[0].clone(); second.document_id = "document-two".into(); second.path = root.join("B.md").to_string_lossy().into_owned(); second.relative_path = "B.md".into();
        r.files.push(second);
        let mut record = write(&journal, r.clone(), None).unwrap();
        for (content, raw) in [(None, true), (Some(before.to_owned()), false), (Some(after.to_owned()), false)] {
            let manifest = crate::history::capture(&history, crate::history::Capture {
                document_id: r.files[0].document_id.clone(), name: "A.md".into(), current_path: Some(r.files[0].path.clone()),
                content, disk_revision: if raw { Some(disk.revision.clone()) } else { None }, format: format.clone(), reason: "before-bulk".into(), operation: Some(r.id.clone())
            }).unwrap();
            let sequence = manifest.entries.last().unwrap().sequence;
            if raw { r.files[0].disk_sequence = Some(sequence); }
            else if r.files[0].before_sequence.is_none() { r.files[0].before_sequence = Some(sequence); }
            else { r.files[0].after_sequence = Some(sequence); }
        }
        // "checkpoints" deliberately leaves receipt links unrecorded to prove
        // that the durable operation pins can recover them after a process dies.
        if phase != "checkpoints" {
            r.files[0].state = "applying".into(); record = write(&journal, r.clone(), Some(record.revision)).unwrap();
            if phase != "before-write" {
                let bytes = crate::text_format::encode(after, &format).unwrap();
                let saved = safe_io::write(&writing, &bytes, Intent::Replace(disk.revision)).unwrap();
                if phase == "recorded" {
                    r.files[0].after_revision = Some(saved.revision); r.files[0].state = "applied".into();
                    write(&journal, r, Some(record.revision)).unwrap();
                }
            }
        }
        fs::write(root.join("child-ready"), b"ready").unwrap();
        loop { std::thread::sleep(std::time::Duration::from_millis(50)); }
    }
    #[test]
    fn killed_batch_preserves_raw_originals_result_pins_and_later_writing() {
        struct Child(std::process::Child);
        impl Drop for Child { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
        for phase in ["checkpoints", "before-write", "after-write", "recorded"] {
            let root = fixture(); let history = root.join("history"); let journal = root.join("receipts");
            let writing = root.join("A.md"); let untouched = root.join("B.md");
            let original = "\u{feff}Original needle\r\nالعربية שלום 🙂".as_bytes();
            let result = "\u{feff}Original revised\r\nالعربية שלום 🙂".as_bytes();
            fs::write(&writing, original).unwrap(); fs::write(&untouched, b"Never started needle").unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "replacement_receipts::tests::child_batch_writer", "--nocapture"])
                .env("AMBERTEXT_BATCH_CHILD_ROOT", &root).env("AMBERTEXT_BATCH_CHILD_PHASE", phase)
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
            let mut child = Child(command.spawn().unwrap());
            let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
            while !root.join("child-ready").exists() && std::time::Instant::now() < until {
                assert!(child.0.try_wait().unwrap().is_none(), "Batch child exited before checkpoint");
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(root.join("child-ready").exists(), "Batch child did not reach checkpoint");
            child.0.kill().unwrap(); child.0.wait().unwrap();
            let record = read(&journal, "batch-one").unwrap(); let file = &record.receipt.files[0];
            assert_eq!(fs::read(&writing).unwrap(), if phase == "checkpoints" || phase == "before-write" { original } else { result });
            assert_eq!(fs::read(&untouched).unwrap(), b"Never started needle");
            assert_eq!(file.state, if phase == "checkpoints" { "pending" } else if phase == "recorded" { "applied" } else { "applying" });
            let manifest = crate::history::versions(&history, "document-one").unwrap();
            assert_eq!(manifest.entries.len(), 3);
            assert!(manifest.entries.iter().all(|e| e.operation.as_deref() == Some("batch-one")));
            let raw = crate::history::read_version(&history, "document-one", 1).unwrap();
            assert!(raw.entry.format.bom); assert_eq!(raw.entry.format.eol, "\r\n");
            assert_eq!(crate::text_format::encode(&raw.content, &raw.entry.format).unwrap(), original);
            assert_eq!(crate::history::read_version(&history, "document-one", 2).unwrap().content, "Original needle\nالعربية שלום 🙂");
            assert_eq!(crate::history::read_version(&history, "document-one", 3).unwrap().content, "Original revised\nالعربية שלום 🙂");
            assert!(crate::history::remove_all(&history).is_err());
            // Conditional revert must refuse a later writer's bytes.
            let applied = safe_io::read(&writing).unwrap(); fs::write(&writing, b"Later writing retained").unwrap();
            assert_eq!(safe_io::write(&writing, original, Intent::Replace(applied.revision)).unwrap_err().kind, "conflict");
            assert_eq!(fs::read(&writing).unwrap(), b"Later writing retained");
            let mut release = record.receipt; release.state = "releasing".into();
            let pending = write(&journal, release, Some(record.revision)).unwrap();
            assert_eq!(read(&journal, "batch-one").unwrap().receipt.state, "releasing");
            crate::history::release_operation(&history, "document-one", "batch-one").unwrap();
            crate::history::release_operation(&history, "document-two", "batch-one").unwrap();
            crate::history::release_operation(&history, "document-one", "batch-one").unwrap();
            let mut released = pending.receipt; released.state = "released".into(); write(&journal, released, Some(pending.revision)).unwrap();
            crate::history::remove_all(&history).unwrap(); assert_eq!(fs::read(&writing).unwrap(), b"Later writing retained");
            fs::remove_dir_all(root).unwrap();
        }
    }
}
