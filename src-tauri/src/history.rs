//! Device-local auxiliary version history. Markdown remains the canonical document.
//! Commands serialize transactions; blobs precede conditional manifest commits.
//! Corrupt records are retained: maintenance moves them to `damaged/` and keeps
//! the content they name. An interrupted commit can leave an unreferenced
//! blob, but cannot publish a manifest that references unwritten contents.
use crate::{
    safe_io::{self, Intent, IoFailure, Revision},
    text_format::{self, TextFormat},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Reverse,
    collections::{BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_CONTENT: u64 = 32 * 1024 * 1024;
const MAX_MANIFEST: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_DOCUMENTS: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub sequence: u64,
    pub captured_at: u64,
    pub reason: String,
    pub representation: String,
    pub sha256: String,
    pub byte_length: u64,
    pub format: TextFormat,
    pub disk_revision: Option<Revision>,
    pub operation: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub document_id: String,
    pub name: String,
    pub current_path: Option<String>,
    pub canonical_path: Option<String>,
    pub previous_paths: Vec<String>,
    pub entries: Vec<Entry>,
}
#[derive(Deserialize, Serialize)]
struct Envelope {
    version: u32,
    sha256: String,
    manifest: Manifest,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub document_id: String,
    pub name: String,
    pub current_path: Option<String>,
    pub content: Option<String>,
    pub disk_revision: Option<Revision>,
    pub format: TextFormat,
    pub reason: String,
    pub operation: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub entry: Entry,
    pub content: String,
}
#[derive(Serialize)]
pub struct Catalogue {
    pub documents: Vec<Manifest>,
    pub warnings: Vec<String>,
    pub truncated: bool,
}

fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn validate_id(id: &str) -> Result<(), IoFailure> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(IoFailure::new("invalid", "Invalid history identity"))
    }
}
fn digest_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn record_path(root: &Path, id: &str) -> Result<PathBuf, IoFailure> {
    validate_id(id)?;
    Ok(root.join("documents").join(format!("{id}.json")))
}
fn regular_path(path: &Path) -> Result<(), IoFailure> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(IoFailure::new(
            "invalid",
            "History contains a symbolic link; its source has been retained",
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn prepare(root: &Path) -> Result<(), IoFailure> {
    for path in [root.to_owned(), root.join("documents"), root.join("blobs")] {
        regular_path(&path)?;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
    }
    Ok(())
}
fn read_limited(path: &Path, limit: u64) -> Result<safe_io::Snapshot, IoFailure> {
    regular_path(path)?;
    if fs::metadata(path)?.len() > limit {
        return Err(IoFailure::new(
            "invalid",
            "A saved version is too large to read",
        ));
    }
    let disk = safe_io::read(path)?;
    if disk.bytes.len() as u64 > limit {
        return Err(IoFailure::new(
            "invalid",
            "A saved version is too large to read",
        ));
    }
    Ok(disk)
}
fn validate(manifest: &Manifest) -> Result<(), IoFailure> {
    validate_id(&manifest.document_id)?;
    let mut sequences = HashSet::new();
    if manifest.version != 1
        || manifest.entries.len() > MAX_ENTRIES
        || manifest.previous_paths.len() > MAX_ENTRIES
        || manifest.entries.iter().any(|entry| {
            !digest_id(&entry.sha256)
                || entry.byte_length > MAX_CONTENT
                || entry.sequence == 0
                || !sequences.insert(entry.sequence)
                || !["buffer-utf8", "raw-disk"].contains(&entry.representation.as_str())
                || !["utf8", "windows1252"].contains(&entry.format.encoding.as_str())
                || !["\n", "\r\n", "\r", "mixed"].contains(&entry.format.eol.as_str())
                || entry.operation.as_ref().is_some_and(|id| !valid_id(id))
        })
        || manifest
            .entries
            .windows(2)
            .any(|pair| pair[0].sequence >= pair[1].sequence)
    {
        return Err(IoFailure::new(
            "invalid",
            "Some version history couldn’t be read. It has been kept, not deleted",
        ));
    }
    Ok(())
}
fn read_record(root: &Path, id: &str) -> Result<Option<(Manifest, Revision)>, IoFailure> {
    let path = record_path(root, id)?;
    let disk = match read_limited(&path, MAX_MANIFEST) {
        Ok(disk) => disk,
        Err(e) if e.kind == "missing" => return Ok(None),
        Err(e) => return Err(e),
    };
    let envelope: Envelope = serde_json::from_slice(&disk.bytes).map_err(|_| {
        IoFailure::new(
            "invalid",
            "Some version history couldn’t be read. It has been kept, not deleted",
        )
    })?;
    validate(&envelope.manifest)?;
    let bytes = serde_json::to_vec(&envelope.manifest)
        .map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    if envelope.version != 1
        || envelope.manifest.document_id != id
        || envelope.sha256 != fingerprint(&bytes)
    {
        return Err(IoFailure::new(
            "invalid",
            "History integrity check failed; its source has been retained",
        ));
    }
    Ok(Some((envelope.manifest, disk.revision)))
}
fn commit(root: &Path, manifest: &Manifest, previous: Option<Revision>) -> Result<(), IoFailure> {
    validate(manifest)?;
    let payload =
        serde_json::to_vec(manifest).map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    let bytes = serde_json::to_vec(&Envelope {
        version: 1,
        sha256: fingerprint(&payload),
        manifest: manifest.clone(),
    })
    .map_err(|e| IoFailure::new("invalid", e.to_string()))?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err(IoFailure::new(
            "io",
            "This document has too many saved versions to add another. Its older versions are kept",
        ));
    }
    let path = record_path(root, &manifest.document_id)?;
    safe_io::write(
        &path,
        &bytes,
        previous.map_or(Intent::Create, Intent::Replace),
    )?;
    if read_limited(&path, MAX_MANIFEST)?.bytes != bytes {
        return Err(IoFailure::new(
            "conflict",
            "History changed during verification",
        ));
    }
    Ok(())
}
pub fn capture(root: &Path, request: Capture) -> Result<Manifest, IoFailure> {
    capture_with(root, request, now_ms(), || Ok(()))
}
fn capture_with(
    root: &Path,
    request: Capture,
    now: u64,
    before_commit: impl FnOnce() -> Result<(), IoFailure>,
) -> Result<Manifest, IoFailure> {
    validate_id(&request.document_id)?;
    if ![
        "opening",
        "interval",
        "manual-save",
        "close",
        "before-reload",
        "before-overwrite",
        "before-restore",
        "before-bulk",
        "rename",
        "copy",
        "relink",
    ]
    .contains(&request.reason.as_str())
        || request.operation.as_ref().is_some_and(|id| !valid_id(id))
        || request.name.len() > 4096
    {
        return Err(IoFailure::new(
            "invalid",
            "Invalid history capture metadata",
        ));
    }
    let (bytes, representation, format, revision) = match (request.content, request.disk_revision) {
        (Some(text), None) => {
            let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
            (normalized.into_bytes(), "buffer-utf8", request.format, None)
        }
        (None, Some(expected)) => {
            let path = request
                .current_path
                .as_ref()
                .ok_or_else(|| IoFailure::new("invalid", "Raw history needs a path"))?;
            let disk = read_limited(&fs::canonicalize(Path::new(path))?, MAX_CONTENT)?;
            if disk.revision != expected {
                return Err(IoFailure::new(
                    "conflict",
                    "The file changed on disk before AmberText could keep a copy of it",
                ));
            }
            let (_, format) = text_format::decode(&disk.bytes)?;
            (disk.bytes, "raw-disk", format, Some(disk.revision))
        }
        _ => {
            return Err(IoFailure::new(
                "invalid",
                "History needs exactly one disk revision or editor buffer",
            ))
        }
    };
    if bytes.len() as u64 > MAX_CONTENT {
        return Err(IoFailure::new(
            "io",
            "This version exceeds the history content limit; writing remains open",
        ));
    }
    prepare(root)?;
    let sha256 = fingerprint(&bytes);
    let blob_path = root.join("blobs").join(format!("{sha256}.bin"));
    let incoming = (bytes.len() as u64).saturating_add(4096);
    // Trim only well past the target, so captures near it don't each run a
    // full pass. A failed trim never blocks the capture; the periodic pass
    // reports problems instead.
    if !blob_path.exists()
        && usage(root)?.saturating_add(incoming) > STORAGE_TARGET + STORAGE_TARGET / 10
    {
        let _ = run_maintenance(root, now, STORAGE_TARGET.saturating_sub(incoming), false);
    }
    let previous = read_record(root, &request.document_id)?;
    let previous_revision = previous.as_ref().map(|x| x.1.clone());
    let mut manifest = previous.map(|x| x.0).unwrap_or_else(|| Manifest {
        version: 1,
        document_id: request.document_id,
        name: request.name.clone(),
        current_path: None,
        canonical_path: None,
        previous_paths: Vec::new(),
        entries: Vec::new(),
    });
    match read_limited(&blob_path, MAX_CONTENT) {
        Ok(existing) if existing.bytes == bytes => {}
        Ok(_) => {
            return Err(IoFailure::new(
                "invalid",
                "A history content file failed its integrity check; its source has been retained",
            ))
        }
        Err(error) if error.kind == "missing" => {
            safe_io::write(&blob_path, &bytes, Intent::Create)?;
        }
        Err(error) => return Err(error),
    }
    if read_limited(&blob_path, MAX_CONTENT)?.bytes != bytes {
        return Err(IoFailure::new(
            "conflict",
            "History content changed during verification",
        ));
    }
    if manifest.current_path != request.current_path {
        if let Some(old) = manifest.current_path.take() {
            remember(&mut manifest.previous_paths, old);
        }
        manifest.current_path = request.current_path;
        // Never preserve a previous file's canonical association after a rename/copy.
        manifest.canonical_path = None;
    }
    if let Some(disk) = &revision {
        manifest.canonical_path = Some(disk.canonical_path.clone());
    }
    manifest.name = request.name;
    let duplicate = manifest.entries.last().is_some_and(|entry| {
        entry.sha256 == sha256
            && entry.representation == representation
            && entry.format == format
            && entry.operation == request.operation
    });
    if !duplicate {
        thin(&mut manifest, now);
        if manifest.entries.len() >= MAX_ENTRIES {
            return Err(IoFailure::new(
                "io",
                "History reached its version limit; earlier versions have been retained",
            ));
        }
        let sequence = manifest.entries.last().map_or(Ok(1), |entry| {
            entry
                .sequence
                .checked_add(1)
                .ok_or_else(|| IoFailure::new("invalid", "History sequence exhausted"))
        })?;
        manifest.entries.push(Entry {
            sequence,
            captured_at: now,
            reason: request.reason,
            representation: representation.into(),
            sha256,
            byte_length: bytes.len() as u64,
            format,
            disk_revision: revision,
            operation: request.operation,
        });
    }
    before_commit()?;
    commit(root, &manifest, previous_revision)?;
    Ok(manifest)
}
pub fn versions(root: &Path, id: &str) -> Result<Manifest, IoFailure> {
    read_record(root, id)?
        .map(|x| x.0)
        .ok_or_else(|| IoFailure::new("missing", "No local history exists for this document"))
}
pub fn read_version(root: &Path, id: &str, sequence: u64) -> Result<Version, IoFailure> {
    let manifest = versions(root, id)?;
    let entry = manifest
        .entries
        .into_iter()
        .find(|entry| entry.sequence == sequence)
        .ok_or_else(|| IoFailure::new("missing", "This history version is unavailable"))?;
    let disk = read_limited(
        &root.join("blobs").join(format!("{}.bin", entry.sha256)),
        MAX_CONTENT,
    )?;
    if disk.bytes.len() as u64 != entry.byte_length || fingerprint(&disk.bytes) != entry.sha256 {
        return Err(IoFailure::new(
            "invalid",
            "History content integrity check failed; its source has been retained",
        ));
    }
    let content = if entry.representation == "raw-disk" {
        text_format::decode(&disk.bytes)?.0
    } else {
        String::from_utf8(disk.bytes)
            .map_err(|_| IoFailure::new("invalid", "History buffer is not valid UTF-8"))?
    };
    Ok(Version { entry, content })
}
pub fn catalogue(root: &Path) -> Result<Catalogue, IoFailure> {
    let directory = root.join("documents");
    regular_path(&directory)?;
    let items = match fs::read_dir(&directory) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Catalogue {
                documents: Vec::new(),
                warnings: Vec::new(),
                truncated: false,
            })
        }
        Err(e) => return Err(e.into()),
    };
    let mut result = Catalogue {
        documents: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };
    let mut inspected = 0;
    let mut inspected_bytes = 0u64;
    for item in items {
        if inspected >= MAX_DOCUMENTS {
            result.truncated = true;
            break;
        }
        inspected += 1;
        let item = match item {
            Ok(item) => item,
            Err(e) => {
                result.warnings.push(e.to_string());
                continue;
            }
        };
        let path = item.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        inspected_bytes = inspected_bytes
            .saturating_add(fs::metadata(&path).map(|m| m.len()).unwrap_or(MAX_MANIFEST));
        if inspected_bytes > MAX_CONTENT {
            result.truncated = true;
            break;
        }
        let Some(id) = path.file_stem().and_then(|x| x.to_str()) else {
            result.warnings.push("Some version history couldn’t be read".into());
            continue;
        };
        match read_record(root, id) {
            Ok(Some((manifest, _))) => result.documents.push(manifest),
            Ok(None) => {}
            Err(e) => result.warnings.push(format!("{id}: {}", e.message)),
        }
    }
    result.documents.sort_by(|a, b| {
        b.entries
            .last()
            .map(|x| x.captured_at)
            .cmp(&a.entries.last().map(|x| x.captured_at))
    });
    Ok(result)
}

pub const STORAGE_TARGET: u64 = 250 * 1024 * 1024;
const MINUTE: u64 = 60 * 1000;
const HOUR: u64 = 60 * MINUTE;
const DAY: u64 = 24 * HOUR;
// Frequent saves are thinned well before a record reaches its hard limits.
const THIN_AT_ENTRIES: usize = 4_000;
const THIN_TO_ENTRIES: usize = 3_000;
const THIN_AT_BYTES: usize = 3 * 1024 * 1024;
const THIN_TO_BYTES: usize = 2 * 1024 * 1024;
const MAX_PREVIOUS_PATHS: usize = 50;
const DAMAGED: &str = "damaged";
const CLOCK: &str = "retention-clock.json";
const NOTICE: &str = "trimmed-notice.json";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Maintenance {
    pub byte_usage: u64,
    pub removed_versions: usize,
    pub warnings: Vec<String>,
    /// Names of documents that lost older versions to the storage target.
    pub trimmed_documents: Vec<String>,
    /// Unreadable records moved to `damaged/` (kept, never deleted here).
    pub set_aside: usize,
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn listing(root: &Path, folder: &str) -> Result<Vec<(PathBuf, fs::Metadata)>, IoFailure> {
    let directory = root.join(folder);
    regular_path(&directory)?;
    let items = match fs::read_dir(directory) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut files = Vec::new();
    for item in items {
        if files.len() >= 100_000 {
            return Err(IoFailure::new(
                "io",
                "History exceeds its safe file listing limit",
            ));
        }
        let item = item?;
        let kind = item.file_type()?;
        if kind.is_symlink() {
            return Err(IoFailure::new(
                "invalid",
                "History contains a symbolic link; its source has been retained",
            ));
        }
        if !kind.is_file() {
            return Err(IoFailure::new(
                "invalid",
                "Unexpected history directory; its source has been retained",
            ));
        }
        files.push((item.path(), item.metadata()?));
    }
    Ok(files)
}
pub fn usage(root: &Path) -> Result<u64, IoFailure> {
    let mut bytes = 0u64;
    for folder in ["documents", "blobs"] {
        for (_, meta) in listing(root, folder)? {
            bytes = bytes
                .checked_add(meta.len())
                .ok_or_else(|| IoFailure::new("invalid", "History size overflow"))?;
        }
    }
    Ok(bytes)
}
fn path_key(path: &str) -> String {
    // Same rule as the UI's samePath: separator-insensitive, case-exact.
    let mut key = String::with_capacity(path.len());
    for c in path.chars() {
        let c = if c == '\\' { '/' } else { c };
        if !(c == '/' && key.ends_with('/')) {
            key.push(c);
        }
    }
    if key.ends_with('/') {
        key.pop();
    }
    key
}
fn remember(previous: &mut Vec<String>, path: String) {
    previous.retain(|p| *p != path);
    previous.push(path);
    if previous.len() > MAX_PREVIOUS_PATHS {
        previous.drain(..previous.len() - MAX_PREVIOUS_PATHS);
    }
}
fn protected(m: &Manifest) -> HashSet<u64> {
    let mut keep: HashSet<u64> = m
        .entries
        .iter()
        .filter(|e| e.operation.is_some())
        .map(|e| e.sequence)
        .collect();
    for kind in ["raw-disk", "buffer-utf8"] {
        if let Some(e) = m.entries.iter().rev().find(|e| e.representation == kind) {
            keep.insert(e.sequence);
        }
    }
    keep
}
fn entry_len(e: &Entry) -> usize {
    serde_json::to_vec(e).map_or(1024, |b| b.len() + 1)
}
/// Keeps a busy record well inside its caps: older saves are reduced to one per
/// ten minutes, then one per hour, then one per day, then the oldest go.
/// The latest copies and unfinished-action copies are always kept.
fn thin(m: &mut Manifest, now: u64) {
    let mut size = serde_json::to_vec(&*m).map_or(usize::MAX, |b| b.len());
    if m.entries.len() < THIN_AT_ENTRIES && size < THIN_AT_BYTES {
        return;
    }
    let keep_always = protected(m);
    let lengths: Vec<usize> = m.entries.iter().map(entry_len).collect();
    let mut keep = vec![true; m.entries.len()];
    let mut count = m.entries.len();
    let over = |count: usize, size: usize| count > THIN_TO_ENTRIES || size > THIN_TO_BYTES;
    for (age, bucket) in [(HOUR, 10 * MINUTE), (DAY, HOUR), (7 * DAY, DAY)] {
        let mut buckets = HashSet::new();
        for i in (0..m.entries.len()).rev() {
            let e = &m.entries[i];
            if !over(count, size) {
                break;
            }
            if keep_always.contains(&e.sequence) || now.saturating_sub(e.captured_at) <= age {
                continue;
            }
            if !buckets.insert(e.captured_at / bucket) {
                keep[i] = false;
                count -= 1;
                size = size.saturating_sub(lengths[i]);
            }
        }
    }
    for (i, e) in m.entries.iter().enumerate() {
        if !over(count, size) {
            break;
        }
        if keep[i] && !keep_always.contains(&e.sequence) {
            keep[i] = false;
            count -= 1;
            size = size.saturating_sub(lengths[i]);
        }
    }
    let mut index = 0;
    m.entries.retain(|_| {
        index += 1;
        keep[index - 1]
    });
}
#[derive(Default)]
struct Scan {
    records: Vec<(Manifest, Revision)>,
    /// Records that fail validation; these are safe to move aside.
    invalid: Vec<String>,
    /// Records that could not be read right now (locked, denied, ...).
    unreadable: Vec<String>,
}
/// Reads every record without a listing cap. Damage in one record never hides
/// the others.
fn scan(root: &Path) -> Result<Scan, IoFailure> {
    let directory = root.join("documents");
    regular_path(&directory)?;
    let items = match fs::read_dir(&directory) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Scan::default()),
        Err(e) => return Err(e.into()),
    };
    let mut result = Scan::default();
    for (n, item) in items.enumerate() {
        if n >= 100_000 {
            return Err(IoFailure::new(
                "io",
                "History exceeds its safe file listing limit",
            ));
        }
        let path = item?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|x| x.to_str())
            .filter(|id| valid_id(id))
        else {
            continue;
        };
        match read_record(root, id) {
            Ok(Some(record)) => result.records.push(record),
            Ok(None) => {}
            Err(e) if e.kind == "invalid" => result.invalid.push(id.to_owned()),
            Err(e) => result.unreadable.push(format!("{id}: {}", e.message)),
        }
    }
    result
        .records
        .sort_by(|a, b| a.0.document_id.cmp(&b.0.document_id));
    Ok(result)
}
/// Moves an unreadable record out of the index, unchanged.
fn set_aside(root: &Path, id: &str, now: u64) -> Result<(), IoFailure> {
    let folder = root.join(DAMAGED);
    regular_path(&folder)?;
    fs::create_dir_all(&folder)?;
    let source = record_path(root, id)?;
    for n in 0..1000 {
        let target = folder.join(format!("{id}-{now}-{n}.json"));
        if fs::symlink_metadata(&target).is_err() {
            fs::rename(&source, &target)?;
            return Ok(());
        }
    }
    Err(IoFailure::new(
        "io",
        "Some version history is damaged and couldn’t be set aside. It has been left as it is",
    ))
}
fn hex_runs(bytes: &[u8], found: &mut HashSet<String>) {
    let mut start = None;
    for i in 0..=bytes.len() {
        let hex = bytes
            .get(i)
            .is_some_and(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b));
        match (hex, start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                if i - s == 64 {
                    found.insert(String::from_utf8_lossy(&bytes[s..i]).into_owned());
                }
                start = None;
            }
            _ => {}
        }
    }
}
/// Content still named by set-aside records stays available for manual repair.
/// `None` means the references could not be determined, so nothing is collected.
fn damaged_references(root: &Path) -> Option<HashSet<String>> {
    let mut found = HashSet::new();
    let folder = root.join(DAMAGED);
    regular_path(&folder).ok()?;
    let items = match fs::read_dir(&folder) {
        Ok(items) => items,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(found),
        Err(_) => return None,
    };
    for item in items {
        let path = item.ok()?.path();
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if !meta.is_file() || meta.len() > 4 * MAX_CONTENT {
            return None;
        }
        hex_runs(&fs::read(&path).ok()?, &mut found);
    }
    Some(found)
}
fn is_temporary(name: &str) -> bool {
    name.starts_with(".ambertext-") && name.ends_with(".tmp")
}
/// Removes this app's own interrupted-write files once they are clearly stale.
fn collect_temporary(root: &Path, min_age: std::time::Duration) {
    let own = format!(".ambertext-{}-", std::process::id());
    for folder in ["documents", "blobs"] {
        let Ok(files) = listing(root, folder) else {
            continue;
        };
        for (path, meta) in files {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let stale = meta
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age >= min_age);
            if is_temporary(name) && !name.starts_with(&own) && stale {
                let _ = fs::remove_file(path);
            }
        }
    }
}
/// Age-based retention advances at most one day per maintenance pass, so a
/// clock set far ahead cannot expire weeks of history at once.
fn retention_reference(root: &Path, now: u64) -> u64 {
    let path = root.join(CLOCK);
    let last = regular_path(&path)
        .ok()
        .and_then(|_| fs::read_to_string(&path).ok())
        .and_then(|text| text.trim().parse::<u64>().ok());
    match last {
        Some(last) if now > last.saturating_add(DAY) => last + DAY,
        _ => now,
    }
}
fn read_notice(root: &Path) -> Vec<String> {
    let path = root.join(NOTICE);
    regular_path(&path)
        .ok()
        .and_then(|_| fs::read(&path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn write_notice(root: &Path, names: &[String]) {
    let path = root.join(NOTICE);
    if regular_path(&path).is_err() {
        return;
    }
    if names.is_empty() {
        let _ = fs::remove_file(path);
    } else if let Ok(bytes) = serde_json::to_vec(names) {
        let _ = fs::write(path, bytes);
    }
}
pub fn maintain(root: &Path) -> Result<Maintenance, IoFailure> {
    maintain_with(root, now_ms(), STORAGE_TARGET)
}
fn maintain_with(root: &Path, now: u64, budget: u64) -> Result<Maintenance, IoFailure> {
    run_maintenance(root, now, budget, true)
}
/// One pass over the records: set aside unreadable ones, apply age retention,
/// trim to the budget from the largest documents first, commit each changed
/// record once, then collect unreferenced content. Content is checked by size
/// here; full integrity checks happen whenever a version is read.
fn run_maintenance(
    root: &Path,
    now: u64,
    budget: u64,
    periodic: bool,
) -> Result<Maintenance, IoFailure> {
    collect_temporary(root, std::time::Duration::from_secs(24 * 60 * 60));
    let reference = retention_reference(root, now);
    let scan = scan(root)?;
    let mut warnings = scan.unreadable.clone();
    let mut set_aside_count = 0;
    for id in &scan.invalid {
        match set_aside(root, id, now) {
            Ok(()) => set_aside_count += 1,
            Err(e) => warnings.push(format!("{id}: {}", e.message)),
        }
    }
    let sizes: HashMap<String, u64> = listing(root, "blobs")?
        .into_iter()
        .filter_map(|(path, meta)| {
            let hash = path.file_name()?.to_str()?.strip_suffix(".bin")?;
            digest_id(hash).then(|| (hash.to_owned(), meta.len()))
        })
        .collect();
    let length = |hash: &str| sizes.get(hash).copied().unwrap_or(0);
    // A record whose content is missing or the wrong size is left untouched.
    let intact: Vec<bool> = scan
        .records
        .iter()
        .map(|(m, _)| {
            m.entries
                .iter()
                .all(|e| sizes.get(&e.sha256) == Some(&e.byte_length))
        })
        .collect();
    let mut documents: Vec<Manifest> = scan.records.iter().map(|(m, _)| m.clone()).collect();
    let original: usize = documents.iter().map(|m| m.entries.len()).sum();
    for (m, ok) in documents.iter_mut().zip(&intact) {
        if !ok {
            continue;
        }
        let keep = protected(m);
        let mut days = HashSet::new();
        let mut newer = reference;
        let mut kept: Vec<Entry> = m
            .entries
            .iter()
            .rev()
            .filter(|e| {
                // Future or out-of-order times count as no newer than what follows.
                let at = e.captured_at.min(newer);
                newer = at;
                let age = reference - at;
                keep.contains(&e.sequence)
                    || age <= 7 * DAY
                    || (age <= 90 * DAY && days.insert(at / DAY))
            })
            .cloned()
            .collect();
        kept.reverse();
        m.entries = kept;
    }
    // Budget: account incrementally instead of re-serialising per removal.
    let mut holders: HashMap<String, usize> = HashMap::new();
    let mut counts: Vec<HashMap<String, usize>> = Vec::with_capacity(documents.len());
    let mut footprint = vec![0u64; documents.len()];
    for (d, m) in documents.iter().enumerate() {
        let mut count = HashMap::new();
        for e in &m.entries {
            *count.entry(e.sha256.clone()).or_insert(0usize) += 1;
        }
        for hash in count.keys() {
            footprint[d] += length(hash);
            *holders.entry(hash.clone()).or_insert(0) += 1;
        }
        counts.push(count);
    }
    let mut content: u64 = holders.keys().map(|hash| length(hash)).sum();
    let mut overhead: u64 = documents
        .iter()
        .map(|m| serde_json::to_vec(m).map_or(MAX_MANIFEST, |b| b.len() as u64 + 150))
        .sum();
    let mut queues: Vec<VecDeque<usize>> = documents
        .iter()
        .zip(&intact)
        .map(|(m, ok)| {
            if !ok {
                return VecDeque::new();
            }
            let keep = protected(m);
            m.entries
                .iter()
                .enumerate()
                .filter(|(_, e)| !keep.contains(&e.sequence))
                .map(|(i, _)| i)
                .collect()
        })
        .collect();
    let mut removed: Vec<HashSet<u64>> = vec![HashSet::new(); documents.len()];
    let mut trimmed = BTreeSet::new();
    let mut heap: BinaryHeap<(u64, Reverse<usize>)> = (0..documents.len())
        .filter(|&d| !queues[d].is_empty())
        .map(|d| (footprint[d], Reverse(d)))
        .collect();
    // Largest document first; within it, its oldest unprotected version.
    while content + overhead > budget {
        let Some((_, Reverse(d))) = heap.pop() else {
            break;
        };
        let Some(i) = queues[d].pop_front() else {
            continue;
        };
        let e = &documents[d].entries[i];
        removed[d].insert(e.sequence);
        overhead = overhead.saturating_sub(entry_len(e) as u64);
        let count = counts[d].get_mut(&e.sha256).expect("counted entry");
        *count -= 1;
        if *count == 0 {
            counts[d].remove(&e.sha256);
            footprint[d] -= length(&e.sha256);
            let holder = holders.get_mut(&e.sha256).expect("counted holder");
            *holder -= 1;
            if *holder == 0 {
                content -= length(&e.sha256);
            }
        }
        trimmed.insert(documents[d].name.clone());
        if !queues[d].is_empty() {
            heap.push((footprint[d], Reverse(d)));
        }
    }
    let over = content + overhead > budget;
    for (m, gone) in documents.iter_mut().zip(&removed) {
        if !gone.is_empty() {
            m.entries.retain(|e| !gone.contains(&e.sequence));
        }
    }
    // Commit reference removals first. Partial failure retains extra copies.
    for ((m, (old, revision)), ok) in documents.iter().zip(&scan.records).zip(&intact) {
        if !ok {
            continue;
        }
        if m.entries.is_empty() {
            match fs::remove_file(record_path(root, &m.document_id)?) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        } else if m != old {
            commit(root, m, Some(revision.clone()))?;
        }
    }
    // Unknown references (unreadable or unmoved records) keep all content.
    if warnings.is_empty() {
        if let Some(mut references) = damaged_references(root) {
            references.extend(
                documents
                    .iter()
                    .flat_map(|m| m.entries.iter().map(|e| e.sha256.clone())),
            );
            for hash in sizes.keys().filter(|hash| !references.contains(*hash)) {
                match fs::remove_file(root.join("blobs").join(format!("{hash}.bin"))) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                    _ => {}
                }
            }
        }
    }
    let mut names = read_notice(root);
    for name in trimmed {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let failure = if intact.iter().any(|ok| !ok) {
        Some(IoFailure::new("invalid", "Some saved versions are damaged, so they were left exactly as they are; other history was tidied normally"))
    } else if over {
        Some(IoFailure::new("io", "Older versions were removed, but the most recent versions of your documents still need more than the 250 MB history limit. They are being kept, and new versions are still saved"))
    } else {
        None
    };
    // Unreported trims wait for the next periodic pass that can show them.
    if failure.is_some() || !periodic {
        write_notice(root, &names);
    } else {
        write_notice(root, &[]);
        let path = root.join(CLOCK);
        if regular_path(&path).is_ok() {
            let _ = fs::write(path, reference.to_string());
        }
    }
    if let Some(failure) = failure {
        return Err(failure);
    }
    Ok(Maintenance {
        byte_usage: usage(root)?,
        removed_versions: original - documents.iter().map(|m| m.entries.len()).sum::<usize>(),
        warnings,
        trimmed_documents: if periodic { names } else { Vec::new() },
        set_aside: set_aside_count,
    })
}
pub fn release_operation(root: &Path, id: &str, operation: &str) -> Result<(), IoFailure> {
    validate_id(operation)?;
    // A cancelled batch can include files whose checkpoint never began.
    // Releasing no existing pins is idempotent; unreadable records still fail.
    let Some((mut m, revision)) = read_record(root, id)? else { return Ok(()); };
    for e in &mut m.entries {
        if e.operation.as_deref() == Some(operation) {
            e.operation = None;
        }
    }
    commit(root, &m, Some(revision))
}
pub fn rebind(root: &Path, from: &str, to: &str) -> Result<(), IoFailure> {
    let from_key = path_key(from);
    // Keep the destination's own separator style for every moved path.
    let separator = if to.contains('\\') { "\\" } else { "/" };
    let base = to.trim_end_matches(['/', '\\']);
    for (mut m, revision) in scan(root)?.records {
        let Some(path) = m.current_path.clone() else {
            continue;
        };
        let key = path_key(&path);
        let suffix = if key == from_key {
            String::new()
        } else if let Some(rest) = key.strip_prefix(&format!("{from_key}/")) {
            format!("{separator}{}", rest.replace('/', separator))
        } else {
            continue;
        };
        remember(&mut m.previous_paths, path);
        m.current_path = Some(format!("{base}{suffix}"));
        m.canonical_path = None;
        commit(root, &m, Some(revision))?;
    }
    Ok(())
}
fn detach_manifest(m: &mut Manifest) {
    if let Some(path) = m.current_path.take() {
        remember(&mut m.previous_paths, path);
    }
    m.canonical_path = None;
}
pub fn detach(root: &Path, id: &str) -> Result<(), IoFailure> {
    let Some((mut m, revision)) = read_record(root, id)? else {
        return Ok(());
    };
    detach_manifest(&mut m);
    commit(root, &m, Some(revision))
}
/// Finds the history for a file being opened. If several records claim it
/// (older drafts used to record their source file's path), the record that
/// belongs to the file itself is chosen deterministically and the others are
/// detached from the path, keeping all of their versions.
pub fn resolve(
    root: &Path,
    path: &str,
    canonical: Option<&str>,
    exclude: &[String],
) -> Result<Option<String>, IoFailure> {
    let key = path_key(path);
    let mut matches: Vec<(Manifest, Revision)> = scan(root)?
        .records
        .into_iter()
        .filter(|(m, _)| {
            m.current_path.as_deref().is_some_and(|p| path_key(p) == key)
                || (canonical.is_some() && m.canonical_path.as_deref() == canonical)
        })
        .collect();
    let rank = |m: &Manifest| m.entries.last().map(|e| e.captured_at);
    // Best first; ties fall back to the identity for a stable choice.
    matches.sort_by(|a, b| {
        rank(&b.0)
            .cmp(&rank(&a.0))
            .then_with(|| a.0.document_id.cmp(&b.0.document_id))
    });
    let winner = matches
        .iter()
        .position(|(m, _)| !exclude.contains(&m.document_id));
    if matches.len() > 1 {
        for (i, (m, revision)) in matches.iter_mut().enumerate() {
            if Some(i) != winner && !exclude.contains(&m.document_id) {
                detach_manifest(m);
                commit(root, m, Some(revision.clone()))?;
            }
        }
    }
    Ok(winner.map(|i| matches[i].0.document_id.clone()))
}
/// Removes every history copy, including set-aside damaged records.
pub fn remove_all(root: &Path) -> Result<(), IoFailure> {
    let scan = scan(root)?;
    if !scan.unreadable.is_empty() {
        return Err(IoFailure::new(
            "io",
            "Some history copies couldn't be opened right now. Nothing was removed; try again in a moment",
        ));
    }
    if scan
        .records
        .iter()
        .any(|(m, _)| m.entries.iter().any(|e| e.operation.is_some()))
    {
        return Err(IoFailure::new("conflict", "History is protecting an unfinished action. Finish or cancel that action before removing copies"));
    }
    for id in scan
        .records
        .iter()
        .map(|(m, _)| &m.document_id)
        .chain(&scan.invalid)
    {
        match fs::remove_file(record_path(root, id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    let damaged = root.join(DAMAGED);
    regular_path(&damaged)?;
    match fs::remove_dir_all(&damaged) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    for name in [CLOCK, NOTICE] {
        let _ = fs::remove_file(root.join(name));
    }
    for folder in ["documents", "blobs"] {
        for (path, _) in listing(root, folder)? {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let blob = folder == "blobs"
                && name.strip_suffix(".bin").is_some_and(digest_id);
            if blob || is_temporary(name) {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ambertext-history-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn buffer(id: &str, content: &str) -> Capture {
        Capture {
            document_id: id.into(),
            name: "Fixture.md".into(),
            current_path: None,
            content: Some(content.into()),
            disk_revision: None,
            format: TextFormat::default(),
            reason: "interval".into(),
            operation: None,
        }
    }
    #[test]
    fn release_is_idempotent_for_absent_history_but_retains_corruption() {
        let f = Fixture::new();
        release_operation(&f.0, "never-started", "batch").unwrap();
        assert!(!f.0.join("documents").exists());
        capture(&f.0, buffer("document", "Retained writing")).unwrap();
        let path = record_path(&f.0, "document").unwrap();
        fs::write(&path, b"Corrupt retained history").unwrap();
        assert!(release_operation(&f.0, "document", "batch").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"Corrupt retained history");
        assert!(release_operation(&f.0, "../escape", "batch").is_err());
    }
    #[test]
    fn deduplicates_repeated_writes_but_retains_return_to_earlier_text() {
        let f = Fixture::new();
        capture(&f.0, buffer("document", "A")).unwrap();
        for _ in 0..12 {
            capture(&f.0, buffer("document", "A")).unwrap();
        }
        assert_eq!(versions(&f.0, "document").unwrap().entries.len(), 1);
        capture(&f.0, buffer("document", "B")).unwrap();
        capture(&f.0, buffer("document", "A")).unwrap();
        assert_eq!(versions(&f.0, "document").unwrap().entries.len(), 3);
        assert_eq!(fs::read_dir(f.0.join("blobs")).unwrap().count(), 2);
        assert_eq!(read_version(&f.0, "document", 3).unwrap().content, "A");
    }
    #[test]
    fn disk_bytes_and_normalized_buffer_remain_distinct() {
        let f = Fixture::new();
        let file = f.0.join("writing.md");
        let original = b"\xef\xbb\xbfHello\r\n";
        fs::write(&file, original).unwrap();
        let disk = safe_io::read(&file).unwrap();
        let mut request = buffer("document", "");
        request.current_path = Some(file.to_string_lossy().into());
        request.content = None;
        request.disk_revision = Some(disk.revision.clone());
        request.reason = "opening".into();
        let manifest = capture(&f.0, request).unwrap();
        assert_eq!(
            fs::read(
                f.0.join("blobs")
                    .join(format!("{}.bin", manifest.entries[0].sha256))
            )
            .unwrap(),
            original
        );
        assert_eq!(
            read_version(&f.0, "document", 1).unwrap().content,
            "Hello\r\n"
        );
        capture(&f.0, buffer("document", "Hello\r\n")).unwrap();
        let manifest = versions(&f.0, "document").unwrap();
        assert_ne!(manifest.entries[0].sha256, manifest.entries[1].sha256);
        assert_eq!(
            read_version(&f.0, "document", 2).unwrap().content,
            "Hello\n"
        );
        assert_eq!(fs::read(&file).unwrap(), original);
    }
    #[test]
    fn native_legacy_bytes_are_preserved_and_stale_baseline_is_refused() {
        let f = Fixture::new();
        let path = f.0.join("legacy.md");
        fs::write(&path, b"caf\xe9\r\n").unwrap();
        let disk = safe_io::read(&path).unwrap();
        let mut request = buffer("legacy", "");
        request.content = None;
        request.current_path = Some(path.to_string_lossy().into());
        request.disk_revision = Some(disk.revision);
        capture(&f.0, request.clone()).unwrap();
        assert_eq!(read_version(&f.0, "legacy", 1).unwrap().content, "café\r\n");
        fs::write(&path, b"External").unwrap();
        assert_eq!(capture(&f.0, request).unwrap_err().kind, "conflict");
        assert_eq!(fs::read(path).unwrap(), b"External");
    }
    #[test]
    fn failed_commit_keeps_prior_manifest_and_restart_readable() {
        let f = Fixture::new();
        capture(&f.0, buffer("document", "Original")).unwrap();
        let prior = fs::read(record_path(&f.0, "document").unwrap()).unwrap();
        let result = capture_with(&f.0, buffer("document", "Uncommitted"), 2, || {
            Err(IoFailure::new("io", "Injected storage full"))
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read(record_path(&f.0, "document").unwrap()).unwrap(),
            prior
        );
        assert_eq!(
            read_version(&f.0, "document", 1).unwrap().content,
            "Original"
        );
    }
    #[test]
    fn corruption_is_reported_and_never_repaired_by_capture() {
        let f = Fixture::new();
        let manifest = capture(&f.0, buffer("document", "Original")).unwrap();
        let path =
            f.0.join("blobs")
                .join(format!("{}.bin", manifest.entries[0].sha256));
        fs::write(&path, b"Damaged").unwrap();
        assert!(read_version(&f.0, "document", 1).is_err());
        assert!(capture(&f.0, buffer("document", "Original")).is_err());
        assert_eq!(fs::read(path).unwrap(), b"Damaged");
        let path = record_path(&f.0, "document").unwrap();
        fs::write(&path, b"{damaged").unwrap();
        assert!(capture(&f.0, buffer("document", "New writing")).is_err());
        let catalogue = catalogue(&f.0).unwrap();
        assert_eq!(catalogue.warnings.len(), 1);
        assert!(catalogue.documents.is_empty());
        assert_eq!(fs::read(path).unwrap(), b"{damaged");
    }
    #[test]
    fn rename_keeps_identity_and_copy_keeps_original_history() {
        let f = Fixture::new();
        let mut request = buffer("original", "Writing");
        request.current_path = Some("Old.md".into());
        capture(&f.0, request.clone()).unwrap();
        request.current_path = Some("New.md".into());
        request.reason = "rename".into();
        let renamed = capture(&f.0, request.clone()).unwrap();
        assert_eq!(renamed.previous_paths, ["Old.md"]);
        assert_eq!(renamed.entries.len(), 1);
        request.document_id = "copy".into();
        request.current_path = Some("Copy.md".into());
        capture(&f.0, request).unwrap();
        assert_eq!(catalogue(&f.0).unwrap().documents.len(), 2);
        assert_eq!(
            versions(&f.0, "original").unwrap().current_path.as_deref(),
            Some("New.md")
        );
    }
    #[test]
    fn unsafe_identity_and_ambiguous_capture_are_refused_before_writes() {
        let f = Fixture::new();
        assert!(capture(&f.0, buffer("../outside", "Text")).is_err());
        let mut request = buffer("valid", "Text");
        request.disk_revision = Some(Revision {
            canonical_path: "Other.md".into(),
            sha256: "a".repeat(64),
        });
        assert!(capture(&f.0, request).is_err());
        assert!(!f.0.join("documents").exists());
    }

    #[test]
    fn retention_preserves_recent_daily_latest_and_unfinished_checkpoints() {
        let f = Fixture::new();
        let now = 100 * DAY;
        let mut pinned = buffer("document", "Pinned oldest");
        pinned.operation = Some("unfinished".into());
        capture_with(&f.0, pinned, DAY, || Ok(())).unwrap();
        for (at, text) in [
            (2 * DAY, "Expired"),
            (90 * DAY, "Earlier daily"),
            (90 * DAY + 1, "Latest daily"),
            (96 * DAY, "Recent"),
            (99 * DAY, "Latest"),
        ] {
            capture_with(&f.0, buffer("document", text), at, || Ok(())).unwrap();
        }
        let result = maintain_with(&f.0, now, STORAGE_TARGET).unwrap();
        assert_eq!(result.removed_versions, 2);
        let m = versions(&f.0, "document").unwrap();
        assert_eq!(
            m.entries.iter().map(|e| e.sequence).collect::<Vec<_>>(),
            [1, 4, 5, 6]
        );
        assert_eq!(fs::read_dir(f.0.join("blobs")).unwrap().count(), 4);
        assert_eq!(
            read_version(&f.0, "document", 1).unwrap().content,
            "Pinned oldest"
        );
    }
    #[test]
    fn budget_prunes_older_versions_but_never_latest_or_shared_content() {
        let f = Fixture::new();
        capture_with(&f.0, buffer("first", &"A".repeat(2048)), 1, || Ok(())).unwrap();
        let shared = capture_with(&f.0, buffer("second", &"A".repeat(2048)), 1, || Ok(()))
            .unwrap()
            .entries[0]
            .sha256
            .clone();
        capture_with(&f.0, buffer("first", &"B".repeat(2048)), 2, || Ok(())).unwrap();
        capture_with(&f.0, buffer("first", &"C".repeat(2048)), 3, || Ok(())).unwrap();
        let result = maintain_with(&f.0, 4, 6500).unwrap();
        assert!(result.removed_versions >= 1);
        assert_eq!(
            read_version(&f.0, "first", 3).unwrap().content,
            "C".repeat(2048)
        );
        assert!(f.0.join("blobs").join(format!("{shared}.bin")).exists());
        let prior = fs::read(record_path(&f.0, "first").unwrap()).unwrap();
        assert!(maintain_with(&f.0, 4, 0).is_err());
        assert_eq!(
            fs::read(record_path(&f.0, "first").unwrap()).unwrap(),
            prior
        );
    }
    #[test]
    fn removal_refuses_unfinished_actions_and_never_touches_markdown() {
        let f = Fixture::new();
        let path = f.0.join("writing.md");
        fs::write(&path, b"Canonical writing").unwrap();
        let mut request = buffer("document", "Checkpoint");
        request.operation = Some("restore".into());
        capture(&f.0, request).unwrap();
        assert!(remove_all(&f.0).is_err());
        assert_eq!(
            read_version(&f.0, "document", 1).unwrap().content,
            "Checkpoint"
        );
        release_operation(&f.0, "document", "restore").unwrap();
        remove_all(&f.0).unwrap();
        assert!(catalogue(&f.0).unwrap().documents.is_empty());
        assert_eq!(usage(&f.0).unwrap(), 0);
        assert_eq!(fs::read(path).unwrap(), b"Canonical writing");
    }
    #[test]
    fn damaged_history_stops_cleanup_before_deleting_any_source() {
        let f = Fixture::new();
        let m = capture_with(&f.0, buffer("document", "Old"), 1, || Ok(())).unwrap();
        capture_with(&f.0, buffer("document", "New"), 2, || Ok(())).unwrap();
        let path =
            f.0.join("blobs")
                .join(format!("{}.bin", m.entries[0].sha256));
        fs::write(&path, b"Damaged").unwrap();
        let prior = fs::read(record_path(&f.0, "document").unwrap()).unwrap();
        assert!(maintain_with(&f.0, 100 * DAY, STORAGE_TARGET).is_err());
        assert_eq!(
            fs::read(record_path(&f.0, "document").unwrap()).unwrap(),
            prior
        );
        assert_eq!(fs::read(path).unwrap(), b"Damaged");
    }
    #[test]
    fn closed_folder_rebind_is_case_exact_and_detach_retains_versions() {
        let f = Fixture::new();
        let mut a = buffer("first", "One");
        a.current_path = Some("C:/Case/One.md".into());
        let mut b = buffer("second", "Two");
        b.current_path = Some("C:/case/Two.md".into());
        capture(&f.0, a).unwrap();
        capture(&f.0, b).unwrap();
        rebind(&f.0, "C:/Case", "C:/Moved").unwrap();
        assert_eq!(
            versions(&f.0, "first").unwrap().current_path.as_deref(),
            Some("C:/Moved/One.md")
        );
        assert_eq!(
            versions(&f.0, "second").unwrap().current_path.as_deref(),
            Some("C:/case/Two.md")
        );
        detach(&f.0, "first").unwrap();
        assert!(versions(&f.0, "first").unwrap().current_path.is_none());
        assert_eq!(read_version(&f.0, "first", 1).unwrap().content, "One");
    }
    #[test]
    fn readonly_manifest_keeps_existing_versions_and_canonical_file() {
        let f = Fixture::new();
        capture(&f.0, buffer("document", "Original")).unwrap();
        let writing = f.0.join("writing.md");
        fs::write(&writing, b"Canonical writing").unwrap();
        let path = record_path(&f.0, "document").unwrap();
        let prior = fs::read(&path).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        assert!(capture(&f.0, buffer("document", "New writing")).is_err());
        assert_eq!(fs::read(&path).unwrap(), prior);
        assert_eq!(
            read_version(&f.0, "document", 1).unwrap().content,
            "Original"
        );
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions).unwrap();
        assert_eq!(fs::read(writing).unwrap(), b"Canonical writing");
    }
    fn named(id: &str, name: &str, path: Option<&str>, content: &str) -> Capture {
        let mut c = buffer(id, content);
        c.name = name.into();
        c.current_path = path.map(Into::into);
        c
    }
    #[test]
    fn unreadable_record_is_moved_aside_and_healthy_history_continues() {
        let f = Fixture::new();
        capture_with(&f.0, buffer("good", "Healthy writing"), 1, || Ok(())).unwrap();
        capture_with(&f.0, buffer("bad", "Other writing"), 1, || Ok(())).unwrap();
        let bad = record_path(&f.0, "bad").unwrap();
        fs::write(&bad, b"{damaged").unwrap();
        let result = maintain_with(&f.0, 2, STORAGE_TARGET).unwrap();
        assert_eq!(result.set_aside, 1);
        assert!(result.warnings.is_empty());
        assert!(!bad.exists());
        let kept: Vec<_> = fs::read_dir(f.0.join(DAMAGED)).unwrap().collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(fs::read(kept[0].as_ref().unwrap().path()).unwrap(), b"{damaged");
        assert!(catalogue(&f.0).unwrap().warnings.is_empty());
        assert_eq!(read_version(&f.0, "good", 1).unwrap().content, "Healthy writing");
        capture_with(&f.0, buffer("good", "More writing"), 3, || Ok(())).unwrap();
        // Turning history off and removing still works, and clears set-aside records.
        remove_all(&f.0).unwrap();
        assert!(!f.0.join(DAMAGED).exists());
        assert_eq!(usage(&f.0).unwrap(), 0);
    }
    #[test]
    fn budget_trims_the_largest_document_first_and_keeps_its_latest() {
        let f = Fixture::new();
        capture_with(&f.0, named("small", "Small.md", None, &"s".repeat(1024)), 1, || Ok(())).unwrap();
        capture_with(&f.0, named("small", "Small.md", None, &"t".repeat(1024)), 2, || Ok(())).unwrap();
        for (at, c) in [(3, 'a'), (4, 'b'), (5, 'c')] {
            capture_with(&f.0, named("big", "Big.md", None, &c.to_string().repeat(4096)), at, || Ok(())).unwrap();
        }
        let budget = usage(&f.0).unwrap() - 5000;
        let result = maintain_with(&f.0, 6, budget).unwrap();
        assert_eq!(result.trimmed_documents, ["Big.md"]);
        assert_eq!(versions(&f.0, "small").unwrap().entries.len(), 2);
        let big = versions(&f.0, "big").unwrap();
        assert!(big.entries.len() < 3);
        let latest = big.entries.last().unwrap().sequence;
        assert_eq!(read_version(&f.0, "big", latest).unwrap().content, "c".repeat(4096));
    }
    #[test]
    fn duplicate_records_for_one_path_resolve_to_the_most_recent() {
        let f = Fixture::new();
        capture_with(&f.0, named("older", "One.md", Some(r"C:\Docs\One.md"), "Older"), 10, || Ok(())).unwrap();
        capture_with(&f.0, named("newer", "One.md", Some("C:/Docs/One.md"), "Newer"), 20, || Ok(())).unwrap();
        let chosen = resolve(&f.0, "C:/Docs/One.md", None, &[]).unwrap();
        assert_eq!(chosen.as_deref(), Some("newer"));
        let older = versions(&f.0, "older").unwrap();
        assert!(older.current_path.is_none());
        assert_eq!(read_version(&f.0, "older", 1).unwrap().content, "Older");
        assert_eq!(resolve(&f.0, r"C:\Docs\One.md", None, &[]).unwrap().as_deref(), Some("newer"));
        assert_eq!(resolve(&f.0, "C:/Docs/Other.md", None, &[]).unwrap(), None);
    }
    #[test]
    fn folder_rename_keeps_one_separator_style() {
        let f = Fixture::new();
        capture(&f.0, named("win", "A.md", Some(r"C:\Old\sub\A.md"), "A")).unwrap();
        capture(&f.0, named("mixed", "B.md", Some(r"C:/Old\B.md"), "B")).unwrap();
        capture(&f.0, named("unix", "C.md", Some("/old/C.md"), "C")).unwrap();
        rebind(&f.0, "C:/Old", r"D:\New").unwrap();
        assert_eq!(versions(&f.0, "win").unwrap().current_path.as_deref(), Some(r"D:\New\sub\A.md"));
        assert_eq!(versions(&f.0, "mixed").unwrap().current_path.as_deref(), Some(r"D:\New\B.md"));
        rebind(&f.0, "/old", "/new").unwrap();
        assert_eq!(versions(&f.0, "unix").unwrap().current_path.as_deref(), Some("/new/C.md"));
    }
    #[test]
    fn clock_set_far_ahead_cannot_expire_recent_history() {
        let f = Fixture::new();
        for (at, text) in [(100 * DAY, "One"), (100 * DAY + HOUR, "Two"), (101 * DAY, "Three")] {
            capture_with(&f.0, buffer("document", text), at, || Ok(())).unwrap();
        }
        maintain_with(&f.0, 101 * DAY, STORAGE_TARGET).unwrap();
        let result = maintain_with(&f.0, 10_000 * DAY, STORAGE_TARGET).unwrap();
        assert_eq!(result.removed_versions, 0);
        assert_eq!(versions(&f.0, "document").unwrap().entries.len(), 3);
    }
    #[test]
    fn stale_temporary_files_are_collected_and_fresh_ones_kept() {
        let f = Fixture::new();
        capture(&f.0, buffer("document", "Text")).unwrap();
        let stale = f.0.join("blobs").join(".ambertext-1-old.tmp");
        let fresh = f.0.join("documents").join(".ambertext-1-new.tmp");
        let other = f.0.join("blobs").join("unrelated.tmp");
        for p in [&stale, &fresh, &other] {
            fs::write(p, b"x").unwrap();
        }
        let file = fs::OpenOptions::new().write(true).open(&stale).unwrap();
        file.set_modified(SystemTime::now() - std::time::Duration::from_secs(3 * 24 * 3600)).unwrap();
        drop(file);
        maintain(&f.0).unwrap();
        assert!(!stale.exists() && fresh.exists() && other.exists());
    }
    #[test]
    fn child_history_writer() {
        let Some(root) = std::env::var_os("AMBERTEXT_HISTORY_CHILD_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let mut request = buffer("document", "Committed multilingual שלום العربية 🙂");
        request.operation = Some("unfinished-restore".into());
        let ready = || {
            fs::write(root.join("child-ready"), b"ready").unwrap();
            loop {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        if std::env::var("AMBERTEXT_HISTORY_CHILD_PHASE").unwrap() == "before-manifest" {
            let _ = capture_with(&root, request, 2, ready);
        } else {
            capture_with(&root, request, 2, || Ok(())).unwrap();
            let _ = ready();
        }
    }
    #[test]
    fn killed_history_writer_retains_previous_or_complete_new_version() {
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for phase in ["before-manifest", "committed"] {
            let f = Fixture::new();
            capture_with(&f.0, buffer("document", "Previous writing"), 1, || Ok(())).unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "history::tests::child_history_writer",
                    "--nocapture",
                ])
                .env("AMBERTEXT_HISTORY_CHILD_ROOT", &f.0)
                .env("AMBERTEXT_HISTORY_CHILD_PHASE", phase)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = Child(command.spawn().unwrap());
            let until = std::time::Instant::now() + std::time::Duration::from_secs(8);
            while !f.0.join("child-ready").exists() && std::time::Instant::now() < until {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "History fixture exited before its checkpoint"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(
                f.0.join("child-ready").exists(),
                "History fixture did not reach its checkpoint"
            );
            child.0.kill().unwrap();
            child.0.wait().unwrap();
            let m = versions(&f.0, "document").unwrap();
            let entry = m.entries.last().unwrap();
            if phase == "committed" {
                assert_eq!(
                    read_version(&f.0, "document", entry.sequence)
                        .unwrap()
                        .content,
                    "Committed multilingual שלום العربية 🙂"
                );
                assert_eq!(entry.operation.as_deref(), Some("unfinished-restore"));
                assert!(remove_all(&f.0).is_err());
            } else {
                assert_eq!(m.entries.len(), 1);
                assert_eq!(
                    read_version(&f.0, "document", entry.sequence)
                        .unwrap()
                        .content,
                    "Previous writing"
                );
            }
        }
    }
}
