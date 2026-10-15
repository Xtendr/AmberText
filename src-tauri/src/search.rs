//! Rebuildable workspace search: no persistent index and no dependency on the UI tree.
use crate::{
    safe_io::{IoFailure, Revision},
    text_format,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};
use unicode_segmentation::{GraphemeCursor, UnicodeSegmentation};
pub const MAX_FILES: usize = 20_000;
pub const MAX_ENTRIES: usize = 50_000;
pub const MAX_DEPTH: usize = 64;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_SCAN_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_RESULTS: usize = 2_000;
pub const MAX_PATH_BYTES: usize = 16 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt"];
const GENERATED: &[&str] = &["node_modules", "target", "__pycache__", "$RECYCLE.BIN"];
#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub visited: usize,
    pub eligible: usize,
    pub scanned: usize,
    pub bytes_read: u64,
    pub excluded: usize,
    pub skipped: usize,
    pub partial: bool,
    pub cancelled: bool,
    pub warnings: Vec<String>,
}
impl Coverage {
    fn issue(&mut self, path: &Path, message: &str) {
        self.skipped += 1;
        self.partial = true;
        if self.warnings.len() < 50 {
            self.warnings
                .push(format!("{}: {message}", dunce::simplified(path).display()));
        }
    }
}
#[derive(Debug)]
pub struct Catalogue {
    pub files: Vec<PathBuf>,
    pub coverage: Coverage,
}
/// True for links that point elsewhere: symbolic links and, on Windows, junctions and
/// mount points (name-surrogate reparse tags). Cloud placeholders such as OneDrive
/// Files On-Demand carry other reparse tags and are ordinary files or folders here.
pub(crate) fn link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}
pub fn catalogue(root: &Path, cancelled: &impl Fn() -> bool) -> Result<Catalogue, IoFailure> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(IoFailure::new("invalid", "Search needs a folder"));
    }
    let mut out = Catalogue {
        files: Vec::new(),
        coverage: Coverage::default(),
    };
    let mut queue = vec![(root.clone(), 0)];
    let mut seen = HashSet::new();
    let mut path_bytes = 0usize;
    while let Some((dir, depth)) = queue.pop() {
        if cancelled() {
            out.coverage.cancelled = true;
            out.coverage.partial = true;
            break;
        }
        match fs::symlink_metadata(&dir).and_then(|meta| {
            if link(&meta) {
                return Err(std::io::Error::other("Directory became a link"));
            }
            let current = fs::canonicalize(&dir)?;
            if !current.starts_with(&root) {
                return Err(std::io::Error::other("Directory left the selected folder"));
            }
            Ok(())
        }) {
            Ok(()) => {}
            Err(e) => {
                out.coverage.issue(&dir, &e.to_string());
                continue;
            }
        }
        if !seen.insert(dir.clone()) {
            continue;
        }
        if depth > MAX_DEPTH {
            out.coverage.issue(&dir, "Directory depth limit reached");
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(x) => x,
            Err(e) => {
                out.coverage.issue(&dir, &e.to_string());
                continue;
            }
        };
        for entry in entries {
            if cancelled() {
                out.coverage.cancelled = true;
                out.coverage.partial = true;
                return Ok(out);
            }
            if out.coverage.visited >= MAX_ENTRIES
                || out.files.len() >= MAX_FILES
                || path_bytes >= MAX_PATH_BYTES
            {
                out.coverage.issue(&dir, "Workspace listing limit reached");
                return Ok(out);
            }
            out.coverage.visited += 1;
            let entry = match entry {
                Ok(x) => x,
                Err(e) => {
                    out.coverage.issue(&dir, &e.to_string());
                    continue;
                }
            };
            let path = entry.path();
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                out.coverage
                    .issue(&path, "Non-Unicode filename is not searchable");
                continue;
            };
            if name.starts_with('.') || name.starts_with('~') {
                out.coverage.excluded += 1;
                continue;
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) => {
                    out.coverage.issue(&path, &e.to_string());
                    continue;
                }
            };
            if link(&meta) {
                out.coverage
                    .issue(&path, "Skipped: a shortcut or link to another location");
                continue;
            }
            if meta.is_dir() {
                if GENERATED.contains(&name.as_str()) {
                    out.coverage.excluded += 1;
                    continue;
                }
                path_bytes += path.as_os_str().len();
                queue.push((path, depth + 1));
            } else if meta.is_file() {
                if !path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| EXTENSIONS.contains(&s.to_ascii_lowercase().as_str()))
                {
                    out.coverage.excluded += 1;
                    continue;
                }
                out.coverage.eligible += 1;
                if meta.len() > MAX_FILE_BYTES {
                    out.coverage.issue(&path, "Skipped: larger than 2 MB");
                    continue;
                }
                path_bytes += path.as_os_str().len();
                out.files.push(path);
            } else {
                out.coverage.issue(&path, "Unsupported filesystem entry");
            }
        }
    }
    out.files.sort();
    Ok(out)
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub document_id: String,
    pub path: String,
    pub content: String,
    pub revision: Option<Revision>,
    #[serde(default)]
    pub excluded: bool,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub query_id: String,
    pub root: String,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub overlays: Vec<Overlay>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub relative_path: String,
    pub document_id: Option<String>,
    pub source: &'static str,
    pub revision: Option<Revision>,
    pub content_hash: String,
    pub from: usize,
    pub to: usize,
    pub line: usize,
    pub snippet: String,
    /// Some matches in this file were not captured; replacement must skip the file.
    pub truncated: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub query_id: String,
    pub root: String,
    pub hits: Vec<Hit>,
    pub coverage: Coverage,
    pub complete: bool,
    pub result_limited: bool,
}
pub fn content_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}
#[derive(Default, Serialize)]
struct ReadMeasurements {
    metadata_ms: f64,
    canonical_ms: f64,
    open_read_ms: f64,
    decode_ms: f64,
    revision_hash_ms: f64,
    normalize_ms: f64,
}
fn read_phase<T>(counter: Option<&mut f64>, action: impl FnOnce() -> T) -> T {
    if let Some(counter) = counter {
        let start = std::time::Instant::now();
        let result = action();
        *counter += start.elapsed().as_secs_f64() * 1000.0;
        result
    } else {
        action()
    }
}
fn read_bounded(path: &Path, root: &Path, profile: &mut Option<ReadMeasurements>) -> Result<(String, Revision, usize), IoFailure> {
    read_source_measured(path, root, profile).map(|(text, revision, bytes, _)| (text, revision, bytes))
}
/// Shared bounded read for revision-tagged Markdown diagnostics.
pub(crate) fn read_source(path: &Path, root: &Path) -> Result<(String, Revision, usize, text_format::TextFormat), IoFailure> {
    read_source_measured(path, root, &mut None)
}
fn read_source_measured(path: &Path, root: &Path, profile: &mut Option<ReadMeasurements>) -> Result<(String, Revision, usize, text_format::TextFormat), IoFailure> {
    let meta = read_phase(profile.as_mut().map(|p| &mut p.metadata_ms), ||fs::symlink_metadata(path))?;
    if link(&meta) || !meta.is_file() {
        return Err(IoFailure::new(
            "unsupported",
            "Skipped: this is now a link or not a regular file",
        ));
    }
    let canonical = read_phase(profile.as_mut().map(|p| &mut p.canonical_ms), ||fs::canonicalize(path))?;
    if !canonical.starts_with(root) {
        return Err(IoFailure::new("invalid", "Skipped: this file is now outside the folder"));
    }
    let mut bytes = Vec::new();
    read_phase(profile.as_mut().map(|p| &mut p.open_read_ms), || {
        File::open(&canonical)?.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)
    })?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(IoFailure::new(
            "invalid",
            "Skipped: larger than 2 MB",
        ));
    }
    let (text, format) = read_phase(profile.as_mut().map(|p| &mut p.decode_ms), ||text_format::decode(&bytes))?;
    let revision = Revision {
        canonical_path: canonical.to_string_lossy().into_owned(),
        sha256: read_phase(profile.as_mut().map(|p| &mut p.revision_hash_ms), ||format!("{:x}", Sha256::digest(&bytes))),
    };
    let normalized = read_phase(profile.as_mut().map(|p| &mut p.normalize_ms), ||normalize(&text));
    Ok((normalized, revision, bytes.len(), format))
}
fn word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}
/// Lowercase one character. Dotted capital I folds to plain "i" so that every
/// character folds to whole characters and "istanbul" finds "İSTANBUL".
fn fold(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
    } else if c == '\u{130}' {
        out.push('i');
    } else {
        out.extend(c.to_lowercase());
    }
}
fn grapheme_boundary(text: &str, at: usize) -> bool {
    at == 0
        || at == text.len()
        || GraphemeCursor::new(at, text.len(), true)
            .is_boundary(text, 0)
            .unwrap_or(false)
}
/// Literal Unicode lowercase matching maps folded bytes back to original character boundaries.
/// No canonical normalization is implied. A match never covers part of a case
/// expansion or part of a user-perceived character (accent, emoji modifier, joiner),
/// so replacing it can never leave a stray mark behind.
fn literal_ranges(
    text: &str,
    query: &str,
    case: bool,
    whole: bool,
    cancelled: &impl Fn() -> bool,
) -> Vec<(usize, usize)> {
    let needle = if case {
        query.to_owned()
    } else {
        let mut needle = String::new();
        query.chars().for_each(|c| fold(c, &mut needle));
        needle
    };
    if needle.is_empty() {
        return Vec::new();
    }
    let (hay, mapping) = if case {
        (std::borrow::Cow::Borrowed(text), Vec::new())
    } else {
        let mut hay = String::new();
        let mut mapping = Vec::new();
        let mut remapped = false;
        for (index, (start, c)) in text.char_indices().enumerate() {
            if index % 4096 == 0 && cancelled() {
                return Vec::new();
            }
            let end = start + c.len_utf8();
            let at = hay.len();
            fold(c, &mut hay);
            if !remapped && hay.len() - at != c.len_utf8() {
                mapping.extend((0..at).map(|n| (n, n + 1)));
                remapped = true;
            }
            if remapped {
                for _ in at..hay.len() {
                    mapping.push((start, end));
                }
            }
        }
        (std::borrow::Cow::Owned(hay), mapping)
    };
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor <= hay.len() {
        if cancelled() || out.len() > 200 {
            break;
        }
        let Some(found) = hay[cursor..].find(&needle) else {
            break;
        };
        let start = cursor + found;
        let end = start + needle.len();
        let (from, to) = if mapping.is_empty() {
            (start, end)
        } else {
            (mapping[start].0, mapping[end - 1].1)
        };
        let whole_fold = mapping.is_empty()
            || ((start == 0 || mapping[start - 1] != mapping[start])
                && (end == hay.len() || mapping[end] != mapping[end - 1]));
        let first = |g: &str| g.chars().next().is_some_and(word);
        let accepted = whole_fold
            && grapheme_boundary(text, from)
            && grapheme_boundary(text, to)
            && (!whole
                || (!text[..from].graphemes(true).next_back().is_some_and(first)
                    && !text[to..].graphemes(true).next().is_some_and(first)));
        if accepted {
            if out.last() != Some(&(from, to)) {
                out.push((from, to));
            }
            cursor = end;
        } else {
            // A rejected candidate may overlap a valid one; retry from the next character.
            cursor = start + hay[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    out
}
#[derive(Default, Serialize)]
pub struct Measurements {
    catalogue_ms: f64,
    read_ms: f64,
    matching_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_details: Option<ReadMeasurements>,
}
pub fn run(
    request: &Request,
    cancelled: &impl Fn() -> bool,
    emit: impl FnMut(Event),
) -> Result<Measurements, IoFailure> {
    run_inner(request, cancelled, emit, false)
}
pub fn run_profiled(
    request: &Request,
    cancelled: &impl Fn() -> bool,
    emit: impl FnMut(Event),
) -> Result<Measurements, IoFailure> {
    run_inner(request, cancelled, emit, true)
}
fn run_inner(
    request: &Request,
    cancelled: &impl Fn() -> bool,
    mut emit: impl FnMut(Event),
    profile_read: bool,
) -> Result<Measurements, IoFailure> {
    if request.query.is_empty()
        || request.query.len() > 1024
        || request.query_id.len() > 120
        || request.overlays.len() > 200
    {
        return Err(IoFailure::new(
            "invalid",
            "The search text or open documents are too large to search",
        ));
    }
    let catalogue_start = std::time::Instant::now();
    let root = fs::canonicalize(&request.root)?;
    let user_root = PathBuf::from(&request.root);
    let mut cat = catalogue(&root, cancelled)?;
    let mut measurements = Measurements {
        catalogue_ms: catalogue_start.elapsed().as_secs_f64() * 1000.0,
        read_details: profile_read.then(ReadMeasurements::default),
        ..Measurements::default()
    };
    emit(Event {
        query_id: request.query_id.clone(),
        root: request.root.clone(),
        hits: vec![],
        coverage: cat.coverage.clone(),
        complete: false,
        result_limited: false,
    });
    let mut overlay_bytes = 0usize;
    let mut overlays = Vec::new();
    let mut suppressed = HashSet::new();
    for overlay in &request.overlays {
        overlay_bytes = overlay_bytes.saturating_add(overlay.content.len());
        let original = PathBuf::from(&overlay.path);
        let path = match fs::canonicalize(&original).or_else(|_| {
            let parent = original
                .parent()
                .ok_or_else(|| std::io::Error::other("Invalid buffer path"))?;
            Ok::<_, std::io::Error>(
                fs::canonicalize(parent)?.join(
                    original
                        .file_name()
                        .ok_or_else(|| std::io::Error::other("Invalid buffer filename"))?,
                ),
            )
        }) {
            Ok(path) => path,
            Err(error) => {
                cat.coverage.issue(&original, &error.to_string());
                continue;
            }
        };
        if !path.is_absolute() || !path.starts_with(&root) {
            continue;
        }
        let relative = path.strip_prefix(&root).unwrap();
        if relative.components().any(|c| {
            c.as_os_str()
                .to_str()
                .is_some_and(|s| s.starts_with('.') || s.starts_with('~') || GENERATED.contains(&s))
        }) {
            continue;
        }
        if overlay.excluded
            || overlay_bytes > 32 * 1024 * 1024
            || overlay.content.len() as u64 > MAX_FILE_BYTES
        {
            cat.coverage
                .issue(&path, "Skipped: this open document is too large to search");
            suppressed.insert(path);
            continue;
        }
        // Dirty overlays are matched by canonical identity when known, never lowercase paths.
        let canonical = overlay
            .revision
            .as_ref()
            .map(|r| PathBuf::from(&r.canonical_path));
        if canonical.as_ref().is_some_and(|p| !p.starts_with(&root)) {
            cat.coverage
                .issue(&path, "Open buffer identity is outside folder");
            continue;
        }
        if !cat.files.contains(&path)
            && path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| EXTENSIONS.contains(&s.to_ascii_lowercase().as_str()))
        {
            if cat.files.len() >= MAX_FILES {
                cat.coverage
                    .issue(&path, "Workspace listing limit reached for open buffer");
                continue;
            }
            cat.files.push(path.clone());
        }
        overlays.push((path, canonical, overlay));
    }
    for (path, _, _) in &overlays {
        if overlays.iter().filter(|(p, _, _)| p == path).count() > 1 {
            if suppressed.insert(path.clone()) {
                cat.coverage.issue(
                    path,
                    "Multiple unsaved buffers have this identity; resolve them before searching",
                );
            }
        }
    }
    let mut total = 0;
    let mut limited = false;
    let mut batch = Vec::new();
    for path in &cat.files {
        if cancelled() {
            cat.coverage.cancelled = true;
            cat.coverage.partial = true;
            break;
        }
        if suppressed.contains(path) {
            continue;
        }
        let selected = overlays
            .iter()
            .find(|(p, c, _)| p == path || c.as_ref() == Some(path));
        let read_start = std::time::Instant::now();
        let (text, revision, source, document_id) = if let Some((_, _, overlay)) = selected {
            (
                normalize(&overlay.content),
                overlay.revision.clone(),
                "buffer",
                Some(overlay.document_id.clone()),
            )
        } else {
            if cat.coverage.bytes_read + MAX_FILE_BYTES > MAX_SCAN_BYTES {
                cat.coverage.issue(path, "Total search byte limit reached");
                break;
            }
            match read_bounded(path, &root, &mut measurements.read_details) {
                Ok((text, revision, bytes)) => {
                    cat.coverage.bytes_read += bytes as u64;
                    (text, Some(revision), "disk", None)
                }
                Err(e) => {
                    cat.coverage.issue(path, &e.message);
                    continue;
                }
            }
        };
        measurements.read_ms += read_start.elapsed().as_secs_f64() * 1000.0;
        cat.coverage.scanned += 1;
        let match_start = std::time::Instant::now();
        let hash = content_hash(&text);
        let ranges = literal_ranges(
            &text,
            &request.query,
            request.case_sensitive,
            request.whole_word,
            cancelled,
        );
        let file_limited = ranges.len() > 200;
        let found = ranges.len();
        measurements.matching_ms += match_start.elapsed().as_secs_f64() * 1000.0;
        // Hits carry the folder path as the user opened it, never the canonical
        // `\\?\` form, so opened tabs, recents and later searches agree on identity.
        let relative = path.strip_prefix(&root).ok();
        let user_path = relative
            .map(|r| user_root.join(r))
            .unwrap_or_else(|| dunce::simplified(path).to_path_buf())
            .to_string_lossy()
            .into_owned();
        let relative_path = relative
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| user_path.clone());
        let mut kept = 0;
        let mut prior = 0;
        let mut units = 0;
        let mut line = 1;
        for (from, to) in ranges.into_iter().take(200) {
            units += text[prior..from].encode_utf16().count();
            line += text[prior..from].bytes().filter(|b| *b == b'\n').count();
            let before = text[..from]
                .chars()
                .rev()
                .take(60)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            let matched = text[from..to].chars().take(120).collect::<String>();
            let after = text[to..].chars().take(60).collect::<String>();
            batch.push(Hit {
                path: user_path.clone(),
                relative_path: relative_path.clone(),
                document_id: document_id.clone(),
                source,
                revision: revision.clone(),
                content_hash: hash.clone(),
                from: units,
                to: units + text[from..to].encode_utf16().count(),
                line,
                snippet: format!("{before}{matched}{after}"),
                truncated: false,
            });
            prior = from;
            total += 1;
            kept += 1;
            if total >= MAX_RESULTS {
                limited = true;
                cat.coverage.partial = true;
                break;
            }
        }
        if file_limited {
            cat.coverage
                .issue(path, "Per-file result limit (200) reached");
            limited = true;
        } else if kept < found {
            cat.coverage
                .issue(path, "Not all matches in this file are listed");
        }
        if kept < found {
            // The batch holds only this file's hits: earlier batches were emitted.
            batch.iter_mut().for_each(|hit| hit.truncated = true);
        }
        if !batch.is_empty() || cat.coverage.scanned % 50 == 0 {
            emit(Event {
                query_id: request.query_id.clone(),
                root: request.root.clone(),
                hits: std::mem::take(&mut batch),
                coverage: cat.coverage.clone(),
                complete: false,
                result_limited: limited,
            });
        }
        if total >= MAX_RESULTS {
            break;
        }
    }
    if cancelled() {
        cat.coverage.cancelled = true;
        cat.coverage.partial = true;
    }
    emit(Event {
        query_id: request.query_id.clone(),
        root: request.root.clone(),
        hits: batch,
        coverage: cat.coverage,
        complete: true,
        result_limited: limited,
    });
    Ok(measurements)
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "ambertext-search-{}-{}-{}",
                std::process::id(),
                ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn write(&self, name: &str, text: &str) {
            let p = self.0.join(name);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn request(f: &Fixture, query: &str) -> Request {
        Request {
            query_id: "test".into(),
            root: fs::canonicalize(&f.0)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            query: query.into(),
            case_sensitive: true,
            whole_word: false,
            overlays: vec![],
        }
    }
    #[test]
    fn catalogue_exceeds_ui_limits_reports_exclusions_and_rebuilds() {
        let f = Fixture::new();
        for i in 0..6101 {
            f.write(&format!("file-{i}.md"), "needle");
        }
        f.write(&format!("{}deep.md", "nested/".repeat(15)), "needle");
        f.write(".private.md", "hidden");
        f.write("node_modules/ignored.md", "generated");
        f.write("image.png", "unsupported");
        f.write("large.md", &"x".repeat(MAX_FILE_BYTES as usize + 1));
        let cat = catalogue(&f.0, &|| false).unwrap();
        assert_eq!(cat.files.len(), 6102);
        assert_eq!(cat.coverage.excluded, 3);
        assert_eq!(cat.coverage.skipped, 1);
        assert!(cat.coverage.partial);
        fs::remove_file(f.0.join("file-0.md")).unwrap();
        f.write("new.md", "new");
        let next = catalogue(&f.0, &|| false).unwrap();
        assert_eq!(next.files.len(), 6102);
        assert!(next.files.iter().any(|p| p.ends_with("new.md")));
        assert!(!next.files.iter().any(|p| p.ends_with("file-0.md")));
    }
    #[test]
    fn raw_formats_unicode_offsets_dirty_overlay_and_no_mutation() {
        let f = Fixture::new();
        f.write("writing.md", "\u{feff}🙂 e\u{301} first\r\nneedle\r\n");
        let mut q = request(&f, "needle");
        let mut events = vec![];
        run(&q, &|| false, |e| events.push(e)).unwrap();
        let hits: Vec<_> = events.iter().flat_map(|e| &e.hits).collect();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].from, 12);
        assert_eq!(hits[0].to, 18);
        assert_eq!(hits[0].line, 2);
        let original = fs::read(f.0.join("writing.md")).unwrap();
        q.overlays.push(Overlay {
            document_id: "dirty".into(),
            path: fs::canonicalize(f.0.join("writing.md"))
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            content: "🙂 unsaved needle".into(),
            excluded: false,
            revision: hits[0].revision.clone(),
        });
        events.clear();
        run(&q, &|| false, |e| events.push(e)).unwrap();
        let hits: Vec<_> = events.iter().flat_map(|e| &e.hits).collect();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].from, 11);
        assert_eq!(hits[0].source, "buffer");
        assert_eq!(fs::read(f.0.join("writing.md")).unwrap(), original);
    }
    #[test]
    fn literal_case_whole_word_multiline_and_result_limit() {
        assert_eq!(
            literal_ranges("İ dotted ΑΛΦΑ café 😀", "αλφα", false, true, &|| false),
            vec![(10, 18)]
        );
        assert_eq!(
            literal_ranges("cat cats concatenate cat\nnext", "cat", true, true, &|| {
                false
            }),
            vec![(0, 3), (21, 24)]
        );
        assert_eq!(
            literal_ranges("one\ntwo", "one\ntwo", true, false, &|| false),
            vec![(0, 7)]
        );
        let f = Fixture::new();
        f.write("many.md", &"a ".repeat(1000));
        let mut final_event = None;
        run(&request(&f, "a"), &|| false, |e| {
            if e.complete {
                final_event = Some(e)
            }
        })
        .unwrap();
        let e = final_event.unwrap();
        assert!(e.result_limited && e.coverage.partial);
        assert!(e.coverage.warnings.iter().any(|w| w.contains("200")));
    }
    #[test]
    fn unicode_matches_never_split_characters() {
        let none = &|| false;
        // Dotted capital I is one whole character, never a partial expansion.
        assert_eq!(literal_ranges("İSTANBUL", "istanbul", false, false, none), vec![(0, 9)]);
        assert_eq!(literal_ranges("istanbul", "İSTANBUL", false, false, none), vec![(0, 8)]);
        assert_eq!(literal_ranges("start İ next", "i", false, false, none), vec![(6, 8)]);
        // Decomposed letters keep their accents: no match leaves a stray mark behind.
        assert_eq!(literal_ranges("I\u{307} dot", "i", false, false, none), vec![]);
        assert_eq!(literal_ranges("e\u{301} e", "e", false, true, none), vec![(4, 5)]);
        assert_eq!(literal_ranges("e\u{301} e", "e", true, false, none), vec![(4, 5)]);
        assert_eq!(literal_ranges("cafe\u{301}", "cafe\u{301}", true, true, none), vec![(0, 6)]);
        assert_eq!(literal_ranges("e\u{301}x x", "x", true, true, none), vec![(5, 6)]);
        // Emoji modifiers and joined emoji are whole characters too.
        assert_eq!(literal_ranges("👍🏽 👍", "👍", true, false, none), vec![(9, 13)]);
        assert_eq!(literal_ranges("👩\u{200d}💻", "💻", true, false, none), vec![]);
        // Kelvin sign folds to a shorter "k" without shifting later positions.
        assert_eq!(literal_ranges("\u{212a} k", "k", false, false, none), vec![(0, 3), (4, 5)]);
        // A rejected whole-word candidate must not hide an overlapping valid one.
        assert_eq!(literal_ranges("aa a a", "a a", true, true, none), vec![(3, 6)]);
    }
    #[test]
    fn hits_use_folder_path_and_mark_truncated_files() {
        let f = Fixture::new();
        f.write("A/one.md", &"a ".repeat(1500));
        f.write("B/two.md", &"a ".repeat(150));
        f.write("C/three.md", &"a ".repeat(150));
        for i in 0..12 {
            f.write(&format!("D/{i:02}.md"), &"a ".repeat(160));
        }
        let mut q = request(&f, "a");
        q.root = f.0.to_string_lossy().into_owned();
        let mut hits = vec![];
        run(&q, &|| false, |e| hits.extend(e.hits)).unwrap();
        assert!(hits
            .iter()
            .all(|h| h.path.starts_with(&q.root) && !h.path.starts_with(r"\?\")));
        assert!(hits
            .iter()
            .any(|h| h.path == f.0.join("A").join("one.md").to_string_lossy()));
        let count = |name: &str| hits.iter().filter(|h| h.relative_path == name).count();
        let truncated = |name: &str| {
            hits.iter()
                .filter(|h| h.relative_path == name)
                .all(|h| h.truncated)
        };
        assert_eq!(hits.len(), MAX_RESULTS);
        // Per-file limit and the global limit both mark the cut file, and only it.
        assert!(count("A/one.md") == 200 && truncated("A/one.md"));
        assert!(count("D/09.md") == 60 && truncated("D/09.md"));
        assert_eq!(count("D/10.md"), 0);
        assert_eq!(
            hits.iter().filter(|h| h.truncated).count(),
            count("A/one.md") + count("D/09.md")
        );
    }
    #[test]
    fn cancellation_and_invalid_query_are_explicit() {
        let f = Fixture::new();
        f.write("a.md", "needle");
        let mut events = vec![];
        run(&request(&f, "needle"), &|| true, |e| events.push(e)).unwrap();
        assert!(events.last().unwrap().coverage.cancelled);
        assert!(events.last().unwrap().complete);
        assert!(run(&request(&f, ""), &|| false, |_| {}).is_err());
    }

    #[test]
    fn directory_depth_and_large_dirty_buffer_are_explicit() {
        let f = Fixture::new();
        f.write(&format!("{}deep.md", "d/".repeat(65)), "needle");
        f.write("dirty.md", "needle");
        let mut q = request(&f, "needle");
        q.overlays.push(Overlay {
            document_id: "large".into(),
            path: f.0.join("dirty.md").to_string_lossy().into_owned(),
            content: "x".repeat(MAX_FILE_BYTES as usize + 1),
            excluded: false,
            revision: None,
        });
        let mut events = vec![];
        run(&q, &|| false, |e| events.push(e)).unwrap();
        assert_eq!(events.iter().map(|e| e.hits.len()).sum::<usize>(), 0);
        assert!(events.last().unwrap().coverage.partial);
        assert_eq!(events.last().unwrap().coverage.skipped, 2);
    }
    #[test]
    fn duplicate_dirty_identities_do_not_choose_one_silently() {
        let f = Fixture::new();
        f.write("dirty.md", "disk needle");
        let mut q = request(&f, "needle");
        for id in ["one", "two"] {
            q.overlays.push(Overlay {
                document_id: id.into(),
                path: f.0.join("dirty.md").to_string_lossy().into_owned(),
                content: format!("{id} needle"),
                excluded: false,
                revision: None,
            });
        }
        let mut events = vec![];
        run(&q, &|| false, |e| events.push(e)).unwrap();
        assert_eq!(events.iter().map(|e| e.hits.len()).sum::<usize>(), 0);
        assert!(events
            .last()
            .unwrap()
            .coverage
            .warnings
            .iter()
            .any(|w| w.contains("Multiple unsaved")));
    }
    #[cfg(windows)]
    #[test]
    fn junction_loop_is_skipped_without_traversal() {
        use std::os::windows::process::CommandExt;
        let f = Fixture::new();
        f.write("inside.md", "needle");
        let link = f.0.join("loop");
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&f.0)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Junction fixture unavailable: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cat = catalogue(&f.0, &|| false).unwrap();
        fs::remove_dir(&link).unwrap(); // unlink this owned junction before fixture cleanup
        assert_eq!(cat.files.len(), 1);
        assert_eq!(cat.coverage.skipped, 1);
        assert!(cat.coverage.warnings[0].contains("link"));
    }
    #[cfg(windows)]
    fn peak_working_set() -> Option<usize> {
        #[repr(C)]
        struct Counters {
            cb: u32,
            faults: u32,
            peak: usize,
            working: usize,
            peak_paged: usize,
            paged: usize,
            peak_nonpaged: usize,
            nonpaged: usize,
            pagefile: usize,
            peak_pagefile: usize,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> *mut std::ffi::c_void;
        }
        #[link(name = "psapi")]
        extern "system" {
            fn GetProcessMemoryInfo(
                process: *mut std::ffi::c_void,
                counters: *mut Counters,
                size: u32,
            ) -> i32;
        }
        let mut counters = Counters {
            cb: std::mem::size_of::<Counters>() as u32,
            faults: 0,
            peak: 0,
            working: 0,
            peak_paged: 0,
            paged: 0,
            peak_nonpaged: 0,
            nonpaged: 0,
            pagefile: 0,
            peak_pagefile: 0,
        };
        unsafe {
            if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0 {
                Some(counters.peak)
            } else {
                None
            }
        }
    }
    #[cfg(not(windows))]
    fn peak_working_set() -> Option<usize> {
        None
    }
    #[test]
    #[ignore = "Explicit measured corpus fixture; run alone with --ignored --nocapture"]
    fn measured_workspace_oracle() {
        for (documents, file_bytes, stride) in [(1000, 26_214, 1), (10_000, 220, 10)] {
            let f = Fixture::new();
            let mut expected = Vec::new();
            let mut corpus_bytes = 0usize;
            for i in 0..documents {
                let name = format!("group-{}/same-{}.md", i % 20, i);
                let mut text = format!("🙂 e\u{301} writing {i}\n");
                if i % stride == 0 {
                    let from = text.encode_utf16().count();
                    text.push_str("unique-needle");
                    expected.push((name.clone(), from));
                }
                while text.len() < file_bytes {
                    text.push('x');
                }
                corpus_bytes += text.len();
                f.write(&name, &text);
            }
            for pass in 0..4 {
                let fixture_root = fs::canonicalize(&f.0).unwrap();
                let mut q = request(&f, "unique-needle");
                q.case_sensitive = pass < 2;
                let start = std::time::Instant::now();
                let mut first = None;
                let mut actual = Vec::new();
                let mut coverage = None;
                let measurements = run(&q, &|| false, |e| {
                    if !e.hits.is_empty() && first.is_none() {
                        first = Some(start.elapsed().as_secs_f64() * 1000.0);
                    }
                    for h in e.hits {
                        let rel = Path::new(&h.path)
                            .strip_prefix(&fixture_root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        actual.push((rel, h.from));
                        assert_eq!(h.to - h.from, 13);
                    }
                    if e.complete {
                        coverage = Some(e.coverage);
                    }
                })
                .unwrap();
                let complete = start.elapsed().as_secs_f64() * 1000.0;
                let c = coverage.unwrap();
                actual.sort();
                let mut expected = expected.clone();
                expected.sort();
                assert_eq!(actual, expected);
                assert!(!c.partial);
                assert_eq!(c.scanned, documents);
                println!(
                    "SEARCH_MEASURE {}",
                    serde_json::json!({"documents":documents,"corpusBytes":corpus_bytes,"pass":pass,"firstMs":first,"completeMs":complete,"peakProcessWorkingSetBytes":peak_working_set(),"cache":"Freshly generated then repeated; OS cache not controlled; no app search cache","profile":if cfg!(debug_assertions) {"debug"}else{"release"},"caseSensitive":q.case_sensitive,"breakdown":measurements})
                );
            }
            let q = request(&f, "unique-needle");
            let cancelled = std::sync::atomic::AtomicBool::new(false);
            let start = std::time::Instant::now();
            let mut signalled = None;
            let mut final_cancel = false;
            run(
                &q,
                &|| cancelled.load(std::sync::atomic::Ordering::SeqCst),
                |e| {
                    if !e.hits.is_empty() && signalled.is_none() {
                        signalled = Some(std::time::Instant::now());
                        cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    if e.complete {
                        final_cancel = e.coverage.cancelled;
                    }
                },
            )
            .unwrap();
            assert!(final_cancel);
            let cancel_ms = signalled.unwrap().elapsed().as_secs_f64() * 1000.0;
            println!(
                "SEARCH_CANCEL {}",
                serde_json::json!({"documents":documents,"acknowledgedMs":cancel_ms,"totalMs":start.elapsed().as_secs_f64()*1000.0,"surface":"native worker cancellation after first result, not IPC or blocked filesystem read"})
            );
        }
    }

    #[test]
    fn binary_and_legacy_are_reported_without_writing() {
        let f = Fixture::new();
        fs::write(f.0.join("legacy.txt"), b"caf\xe9").unwrap();
        fs::write(f.0.join("binary.md"), b"\xff\xfe\0x").unwrap();
        let mut all = vec![];
        run(&request(&f, "café"), &|| false, |e| all.push(e)).unwrap();
        assert_eq!(all.iter().map(|e| e.hits.len()).sum::<usize>(), 1);
        assert_eq!(all.last().unwrap().coverage.skipped, 1);
        assert_eq!(fs::read(f.0.join("legacy.txt")).unwrap(), b"caf\xe9");
    }
}
