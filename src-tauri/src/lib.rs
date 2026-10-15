mod ai;
mod safe_io;
mod text_format;
mod recovery;
mod history;
mod search;
mod replacement_receipts;
mod references;

use base64::Engine;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State, WebviewWindow};

/// Files handed to the app before the frontend was ready to receive them
/// (command-line arguments, Finder "Open With", second instances).
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

#[derive(Default)]
struct RecoveryGate(Arc<Mutex<()>>);

#[derive(Default)]
struct HistoryGate(Arc<Mutex<()>>);

#[derive(Default)]
struct ReceiptGate(Arc<Mutex<()>>);
fn receipt_root(app: &tauri::AppHandle) -> Result<PathBuf, safe_io::IoFailure> {
    app.path().app_local_data_dir().map(|p| p.join("replacement-receipts"))
        .map_err(|e| safe_io::IoFailure::new("io", e.to_string()))
}
#[tauri::command]
async fn replacement_receipt_write(app: tauri::AppHandle, gate: State<'_, ReceiptGate>, receipt: replacement_receipts::Receipt, expected: Option<safe_io::Revision>) -> Result<replacement_receipts::Record, safe_io::IoFailure> {
    let root = receipt_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || { let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); replacement_receipts::write(&root, receipt, expected) })
        .await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}
#[tauri::command]
async fn replacement_receipt_catalogue(app: tauri::AppHandle, gate: State<'_, ReceiptGate>) -> Result<replacement_receipts::Catalogue, safe_io::IoFailure> {
    let root = receipt_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || { let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); replacement_receipts::catalogue(&root) })
        .await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[derive(Default)]
struct SearchState {
    generation: Arc<std::sync::atomic::AtomicU64>,
    worker: Arc<Mutex<()>>,
}
#[derive(Default)]
struct ReferenceState(SearchState);
#[tauri::command]
fn reference_scan_cancel(state: State<'_, ReferenceState>) {
    state.0.generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
async fn reference_catalogue(state: State<'_, ReferenceState>, root: String) -> Result<references::Catalogue, safe_io::IoFailure> {
    let generation = state.0.generation.clone(); let worker = state.0.worker.clone();
    let mine = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || generation.load(std::sync::atomic::Ordering::SeqCst) != mine;
        let _guard = worker.lock().unwrap_or_else(|p| p.into_inner());
        references::catalogue(Path::new(&root), &cancelled)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}
#[tauri::command]
async fn reference_read(state: State<'_, ReferenceState>, root: String, path: String) -> Result<references::Source, safe_io::IoFailure> {
    let worker = state.0.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = worker.lock().unwrap_or_else(|p| p.into_inner()); references::read(Path::new(&root), Path::new(&path))
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}
#[tauri::command]
async fn reference_target(state: State<'_, ReferenceState>, root: String, path: String) -> Result<references::Target, safe_io::IoFailure> {
    let worker = state.0.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = worker.lock().unwrap_or_else(|p| p.into_inner()); references::inspect(Path::new(&root), Path::new(&path))
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}
#[tauri::command]
fn workspace_search_cancel(state: State<'_, SearchState>) {
    state.generation.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
}
#[tauri::command]
async fn workspace_search(app: tauri::AppHandle, state: State<'_, SearchState>, request: search::Request) -> Result<(),safe_io::IoFailure> {
    let generation=state.generation.clone();
    let mine=generation.fetch_add(1,std::sync::atomic::Ordering::SeqCst)+1;
    let worker=state.worker.clone();
    // Phase diagnostics only in an explicitly isolated debug validation app.
    // Ordinary identifiers and release builds never emit this extra payload.
    let validation=hidden_validation(&app);
    let waiting=validation.then(std::time::Instant::now);
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled=||generation.load(std::sync::atomic::Ordering::SeqCst)!=mine;
        let _guard=loop {
            if cancelled() {return Ok(());}
            match worker.try_lock() {
                Ok(guard)=>break guard,
                Err(std::sync::TryLockError::Poisoned(p))=>break p.into_inner(),
                Err(std::sync::TryLockError::WouldBlock)=>std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        };
        let worker_wait_ms=waiting.map(|start|start.elapsed().as_secs_f64()*1000.0);
        let running=validation.then(std::time::Instant::now);
        let mut emit_ms=0.0;
        let emit=|event| {
            if !cancelled() {
                let emitting=validation.then(std::time::Instant::now);
                let _=app.emit("ambertext:workspace-search",event);
                if let Some(start)=emitting {emit_ms+=start.elapsed().as_secs_f64()*1000.0;}
            }
        };
        let measured=if validation {search::run_profiled(&request,&cancelled,emit)}
            else {search::run(&request,&cancelled,emit)};
        measured.map(|measurements| {
            if let Some(start)=running {
                let _=app.emit("ambertext:hidden-search-profile",serde_json::json!({
                    "queryId":request.query_id,"measurements":measurements,
                    "workerWaitMs":worker_wait_ms,"workerRunMs":start.elapsed().as_secs_f64()*1000.0,
                    "emitMs":emit_ms
                }));
            }
        })
    }).await.map_err(|e|safe_io::IoFailure::new("io",e.to_string()))?
}


fn history_root(app: &tauri::AppHandle) -> Result<PathBuf, safe_io::IoFailure> {
    app.path().app_local_data_dir().map(|p| p.join("history"))
        .map_err(|e| safe_io::IoFailure::new("io", e.to_string()))
}

#[tauri::command]
async fn history_maintain(app: tauri::AppHandle, gate: State<'_, HistoryGate>) -> Result<history::Maintenance, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::maintain(&root)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_release(app: tauri::AppHandle, gate: State<'_, HistoryGate>, document_id: String, operation: String) -> Result<(), safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::release_operation(&root, &document_id, &operation)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_remove_all(app: tauri::AppHandle, gate: State<'_, HistoryGate>) -> Result<(), safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::remove_all(&root)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_capture(app: tauri::AppHandle, gate: State<'_, HistoryGate>, request: history::Capture) -> Result<history::Manifest, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        history::capture(&root, request)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_catalogue(app: tauri::AppHandle, gate: State<'_, HistoryGate>) -> Result<history::Catalogue, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        history::catalogue(&root)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_versions(app: tauri::AppHandle, gate: State<'_, HistoryGate>, document_id: String) -> Result<history::Manifest, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        history::versions(&root, &document_id)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_read(app: tauri::AppHandle, gate: State<'_, HistoryGate>, document_id: String, sequence: u64) -> Result<history::Version, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        history::read_version(&root, &document_id, sequence)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

fn recovery_root(app: &tauri::AppHandle) -> Result<PathBuf, safe_io::IoFailure> {
    app.path().app_local_data_dir().map(|p| p.join("recovery"))
        .map_err(|e| safe_io::IoFailure::new("io", e.to_string()))
}

/// Remove day-old staging files a crash left in the app's own data folders only.
fn sweep_app_temps(app: &tauri::AppHandle) {
    let Ok(data) = app.path().app_local_data_dir() else { return };
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for dir in ["recovery", "history", "history/documents", "history/blobs", "replacement-receipts"] {
        safe_io::sweep_stale_temps(&data.join(dir), day);
    }
}

#[tauri::command]
async fn recovery_load(app: tauri::AppHandle, gate: State<'_, RecoveryGate>) -> Result<recovery::Loaded, safe_io::IoFailure> {
    let root = recovery_root(&app)?;
    let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        recovery::load(&root)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))
}

#[tauri::command]
async fn recovery_write(app: tauri::AppHandle, gate: State<'_, RecoveryGate>, snapshot: recovery::Snapshot) -> Result<recovery::Written, safe_io::IoFailure> {
    let root = recovery_root(&app)?;
    let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        recovery::write(&root, snapshot)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn recovery_preserve_legacy(app: tauri::AppHandle, gate: State<'_, RecoveryGate>, source: String) -> Result<String, safe_io::IoFailure> {
    let root = recovery_root(&app)?;
    let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
        recovery::preserve_legacy(&root, &source)
    }).await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[tauri::command]
async fn history_usage(app: tauri::AppHandle, gate: State<'_, HistoryGate>) -> Result<u64, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::usage(&root)
    }).await.map_err(|e| safe_io::IoFailure::new("io",e.to_string()))?
}
#[tauri::command]
async fn history_rebind(app: tauri::AppHandle, gate: State<'_, HistoryGate>, from: String, to: String) -> Result<(), safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::rebind(&root,&from,&to)
    }).await.map_err(|e| safe_io::IoFailure::new("io",e.to_string()))?
}

#[tauri::command]
async fn history_resolve(app: tauri::AppHandle, gate: State<'_, HistoryGate>, path: String, canonical: Option<String>, exclude: Vec<String>) -> Result<Option<String>, safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::resolve(&root,&path,canonical.as_deref(),&exclude)
    }).await.map_err(|e| safe_io::IoFailure::new("io",e.to_string()))?
}

#[tauri::command]
async fn history_detach(app: tauri::AppHandle, gate: State<'_, HistoryGate>, document_id: String) -> Result<(), safe_io::IoFailure> {
    let root = history_root(&app)?; let gate = gate.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate.lock().unwrap_or_else(|p| p.into_inner()); history::detach(&root,&document_id)
    }).await.map_err(|e| safe_io::IoFailure::new("io",e.to_string()))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileEntry>>,
}

#[derive(Serialize)]
struct TextFile {
    content: String,
    mtime: u64,
    revision: safe_io::Revision,
    format: text_format::TextFormat,
}

const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mdx", "txt"];
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "__pycache__", "$RECYCLE.BIN"];
const MAX_TREE_ENTRIES: usize = 6000;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn mtime_of(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek(), bi.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().filter(|c| c.is_ascii_digit()) {
                    na.push(*c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().filter(|c| c.is_ascii_digit()) {
                    nb.push(*c);
                    bi.next();
                }
                let ord = na.len().cmp(&nb.len()).then_with(|| na.cmp(&nb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let ord = ca.cmp(cb);
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn walk(dir: &Path, depth: usize, budget: &mut usize) -> Vec<FileEntry> {
    let mut out = Vec::new();
    if depth > 12 || *budget == 0 {
        return out;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return out;
    };
    for entry in read.flatten() {
        if *budget == 0 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('~') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            *budget -= 1;
            let children = walk(&path, depth + 1, budget);
            out.push(FileEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: true,
                children: Some(children),
            });
        } else if kind.is_file() && is_text_file(&path) {
            *budget -= 1;
            out.push(FileEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir: false,
                children: None,
            });
        }
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    out
}

#[tauri::command]
fn list_tree(root: String) -> Result<Vec<FileEntry>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("Folder not found".into());
    }
    let mut budget = MAX_TREE_ENTRIES;
    Ok(walk(&root, 0, &mut budget))
}

#[tauri::command]
fn read_text(path: String) -> Result<TextFile, safe_io::IoFailure> {
    let snapshot = safe_io::read(Path::new(&path))?;
    let (content, format) = text_format::decode(&snapshot.bytes)?;
    Ok(TextFile {
        content,
        mtime: snapshot.mtime,
        revision: snapshot.revision,
        format,
    })
}

#[derive(Serialize)]
struct SavedFile {
    mtime: u64,
    revision: safe_io::Revision,
}

/// A missing expected revision means create only, never implicit overwrite.
#[tauri::command]
fn write_text(path: String, content: String, expected: Option<safe_io::Revision>, format: Option<text_format::TextFormat>) -> Result<SavedFile, safe_io::IoFailure> {
    let intent = expected.map(safe_io::Intent::Replace).unwrap_or(safe_io::Intent::Create);
    let bytes = text_format::encode(&content, &format.unwrap_or_default())?;
    let saved = safe_io::write(Path::new(&path), &bytes, intent)?;
    Ok(SavedFile { mtime: saved.mtime, revision: saved.revision })
}

#[tauri::command]
fn file_mtime(path: String) -> Option<u64> {
    let p = Path::new(&path);
    if p.is_file() {
        Some(mtime_of(p))
    } else {
        None
    }
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn create_file(path: String, content: String) -> Result<u64, String> {
    safe_io::write(Path::new(&path), content.as_bytes(), safe_io::Intent::Create)
        .map(|saved| saved.mtime).map_err(|e| e.message)
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("A folder with that name already exists".into());
    }
    fs::create_dir_all(p).map_err(err)
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    // Case-insensitive spelling is not file identity: Windows directories and
    // macOS volumes may be case-sensitive. Permit an existing destination only
    // when both paths resolve to the same canonical entry (case-only rename).
    // A dangling symlink is still an occupied name and must not be replaced.
    match fs::symlink_metadata(&to) {
        Ok(target_entry) => {
            // Canonical equality through a symbolic link does not mean the
            // directory entries are identical. Renaming a link onto its referent
            // would replace that file with the link; refuse occupied link names.
            let source_entry = fs::symlink_metadata(&from).map_err(err)?;
            if source_entry.file_type().is_symlink() || target_entry.file_type().is_symlink() {
                return Err("Something with that name already exists".into());
            }
            let source = fs::canonicalize(&from).map_err(err)?;
            let target = fs::canonicalize(&to).map_err(err)?;
            if source != target { return Err("Something with that name already exists".into()); }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(err(e)),
    }
    install_rename(Path::new(&from), Path::new(&to)).map_err(err)
}

#[cfg(not(windows))]
fn install_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn install_rename(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let entry = |path: &Path| -> std::io::Result<Vec<u16>> {
        // Canonicalize the parent for long-path support, not the final entry:
        // renaming a symbolic link must move the link rather than its referent.
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = path.file_name().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid rename path"))?;
        let full = fs::canonicalize(parent)?.join(name);
        let mut wide: Vec<u16> = full.as_os_str().encode_wide().collect();
        if wide.contains(&0) { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid rename path")); }
        wide.push(0);
        Ok(wide)
    };
    let from = entry(from)?; let to = entry(to)?;
    // Neither REPLACE_EXISTING nor COPY_ALLOWED: a destination created after
    // the UI check is protected, and a cross-volume copy/delete is not inferred.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else { Ok(()) }
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicU64, Ordering};
    static ID: AtomicU64 = AtomicU64::new(0);

    fn fixture(root: PathBuf) -> PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = root.join(format!("ambertext-rename-{}-{nonce}-{}", std::process::id(), ID.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&dir).unwrap();
        dir // Operation-owned evidence retained; no cleanup of caller directories.
    }

    fn text(path: &Path) -> String { path.to_string_lossy().into_owned() }

    #[test]
    fn rename_rejects_an_existing_target_and_retains_both_files() {
        let dir = fixture(std::env::temp_dir());
        let from = dir.join("source.md"); let to = dir.join("destination.md");
        fs::write(&from, b"source bytes").unwrap(); fs::write(&to, b"destination bytes").unwrap();
        assert!(rename_path(text(&from), text(&to)).is_err());
        assert_eq!(fs::read(&from).unwrap(), b"source bytes");
        assert_eq!(fs::read(&to).unwrap(), b"destination bytes");
        let renamed = dir.join("renamed.md");
        rename_path(text(&from), text(&renamed)).unwrap();
        assert!(!from.exists()); assert_eq!(fs::read(renamed).unwrap(), b"source bytes");
    }

    #[test]
    fn rename_case_only_without_a_distinct_target_keeps_bytes() {
        let dir = fixture(std::env::temp_dir());
        let from = dir.join("Case.md"); let to = dir.join("case.md");
        fs::write(&from, b"case rename bytes").unwrap();
        rename_path(text(&from), text(&to)).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"case rename bytes");
        assert!(fs::read_dir(dir).unwrap().any(|e| e.unwrap().file_name() == "case.md"));
    }

    #[test]
    #[cfg(windows)]
    fn windows_rename_install_preserves_destination_created_after_check() {
        let dir = fixture(std::env::temp_dir());
        let from = dir.join("source.md"); let to = dir.join("destination.md");
        fs::write(&from, b"our writing").unwrap();
        assert!(fs::symlink_metadata(&to).is_err());
        // An external writer wins the name after the initial check but before
        // the actual filesystem rename. The install itself must refuse it.
        fs::write(&to, b"external writing").unwrap();
        assert!(install_rename(&from, &to).is_err());
        assert_eq!(fs::read(&from).unwrap(), b"our writing");
        assert_eq!(fs::read(&to).unwrap(), b"external writing");
    }

    #[test]
    fn rename_folder_keeps_child_writing_and_case_only_name() {
        let dir = fixture(std::env::temp_dir());
        let from = dir.join("Case"); let to = dir.join("case");
        fs::create_dir(&from).unwrap(); fs::write(from.join("writing.md"), b"child writing").unwrap();
        rename_path(text(&from), text(&to)).unwrap();
        assert_eq!(fs::read(to.join("writing.md")).unwrap(), b"child writing");
        assert!(fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name() == "case"));
        let renamed = dir.join("Renamed");
        rename_path(text(&to), text(&renamed)).unwrap();
        assert_eq!(fs::read(renamed.join("writing.md")).unwrap(), b"child writing");
    }

    #[test]
    #[cfg(windows)]
    fn windows_rename_keeps_long_path_support_and_rejects_embedded_nul() {
        let dir = fixture(std::env::temp_dir());
        let long_dir = (0..7).fold(dir.clone(), |p, i| p.join(format!("{i}-{}", "x".repeat(45))));
        fs::create_dir_all(&long_dir).unwrap();
        let from = long_dir.join("source.md"); let to = long_dir.join("destination.md");
        assert!(text(&from).len() > 260);
        fs::write(&from, b"long path writing").unwrap();
        rename_path(text(&from), text(&to)).unwrap();
        assert_eq!(fs::read(&to).unwrap(), b"long path writing");
        let invalid = dir.join("invalid\0name.md");
        assert!(install_rename(&to, &invalid).is_err());
        assert_eq!(fs::read(&to).unwrap(), b"long path writing");
    }

    #[test]
    #[ignore = "Requires an explicitly supplied disposable case-sensitive directory"]
    fn case_sensitive_rename_never_clobbers_case_distinct_target() {
        let root = PathBuf::from(std::env::var_os("AMBERTEXT_CASE_FIXTURE_ROOT").expect("Supply a disposable case-sensitive directory"));
        assert!(root.is_absolute() && root.is_dir());
        let dir = fixture(root);
        let upper = dir.join("Case.md"); let lower = dir.join("case.md");
        // create_new must succeed twice: this proves actual case-sensitive
        // storage before asserting the command's no-clobber behavior.
        OpenOptions::new().write(true).create_new(true).open(&upper).unwrap();
        OpenOptions::new().write(true).create_new(true).open(&lower).unwrap();
        fs::write(&upper, b"Upper bytes").unwrap(); fs::write(&lower, b"Lower bytes").unwrap();
        assert_ne!(fs::canonicalize(&upper).unwrap(), fs::canonicalize(&lower).unwrap());
        assert!(rename_path(text(&upper), text(&lower)).is_err());
        assert_eq!(fs::read(&upper).unwrap(), b"Upper bytes");
        assert_eq!(fs::read(&lower).unwrap(), b"Lower bytes");
    }

    #[test]
    #[ignore = "Requires filesystem symbolic-link creation permission"]
    fn rename_cannot_replace_a_file_with_its_symbolic_link() {
        let dir = fixture(std::env::temp_dir());
        let file = dir.join("writing.md"); let link = dir.join("alias.md");
        fs::write(&file, b"original writing").unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&file, &link).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        assert_eq!(fs::canonicalize(&file).unwrap(), fs::canonicalize(&link).unwrap());
        assert!(rename_path(text(&link), text(&file)).is_err());
        assert!(rename_path(text(&file), text(&link)).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"original writing");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
    }
}

#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(err)
}

fn create_binary(path: &Path, bytes: &[u8]) -> Result<safe_io::Revision, safe_io::IoFailure> {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    // Existing image files are never replacements. Stage/flush and atomically
    // install only a new destination through the same owner as safe text IO.
    Ok(safe_io::write(path, bytes, safe_io::Intent::Create)?.revision)
}
fn create_base64(path: &Path, data: &str) -> Result<safe_io::Revision, safe_io::IoFailure> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data)
        .map_err(|e| safe_io::IoFailure::new("invalid", e.to_string()))?;
    create_binary(path, &bytes)
}
const MAX_COPY_BYTES: u64 = 100 * 1024 * 1024;
fn copy_binary(from: &Path, to: &Path) -> Result<safe_io::Revision, safe_io::IoFailure> {
    copy_binary_limited(from, to, MAX_COPY_BYTES)
}
fn copy_binary_limited(from: &Path, to: &Path, max: u64) -> Result<safe_io::Revision, safe_io::IoFailure> {
    if fs::metadata(from)?.len() > max {
        return Err(safe_io::IoFailure::new("too_large", format!("This file is too large to copy (the limit is {} MB).", max / (1024 * 1024))));
    }
    let bytes = fs::read(from)?;
    create_binary(to, &bytes)
}
#[tauri::command]
async fn write_base64(path: String, data: String) -> Result<safe_io::Revision, safe_io::IoFailure> {
    tauri::async_runtime::spawn_blocking(move || create_base64(Path::new(&path), &data))
        .await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}
#[tauri::command]
async fn copy_file(from: String, to: String) -> Result<safe_io::Revision, safe_io::IoFailure> {
    tauri::async_runtime::spawn_blocking(move || copy_binary(Path::new(&from), Path::new(&to)))
        .await.map_err(|e| safe_io::IoFailure::new("io", e.to_string()))?
}

#[cfg(test)]
mod binary_tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ambertext-images-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn native_paste_and_copy_commit_exact_image_bytes_without_changing_sources() {
        let f = Fixture::new();
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=").unwrap();
        let document = f.0.join("æ.md"); let writing = b"Original writing\r\n![old](assets/old.png)"; fs::write(&document, writing).unwrap();
        let old = f.0.join("assets/old.png"); fs::create_dir(old.parent().unwrap()).unwrap(); fs::write(&old, [1,2,3]).unwrap();
        let pasted = f.0.join("assets/pasted æ.png");
        let result = create_base64(&pasted, &base64::engine::general_purpose::STANDARD.encode(&png)).unwrap();
        assert_eq!(fs::read(&pasted).unwrap(), png); assert_eq!(result, safe_io::read(&pasted).unwrap().revision);
        let copied = f.0.join("assets/copied (æ).png"); let receipt = copy_binary(&pasted, &copied).unwrap();
        assert_eq!(fs::read(&copied).unwrap(), png); assert_eq!(receipt, safe_io::read(&copied).unwrap().revision);
        assert_eq!(fs::read(&pasted).unwrap(), png); assert_eq!(fs::read(&old).unwrap(), [1,2,3]); assert_eq!(fs::read(&document).unwrap(), writing);
        assert!(!fs::read_dir(old.parent().unwrap()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(".ambertext-")));
    }
    #[test]
    fn native_image_collisions_never_replace_existing_files_or_aliases() {
        let f = Fixture::new(); let original = f.0.join("existing.png"); fs::write(&original, [10,20]).unwrap();
        let source = f.0.join("source.png"); fs::write(&source, [99]).unwrap();
        assert_eq!(create_binary(&original, &[99]).unwrap_err().kind, "conflict");
        assert_eq!(copy_binary(&source, &original).unwrap_err().kind, "conflict");
        assert_eq!(copy_binary(&source, &source).unwrap_err().kind, "conflict");
        let alias = f.0.join("alias.png"); fs::hard_link(&original, &alias).unwrap();
        assert_eq!(create_binary(&alias, &[99]).unwrap_err().kind, "conflict");
        #[cfg(windows)]
        assert_eq!(create_binary(&f.0.join("EXISTING.PNG"), &[99]).unwrap_err().kind, "conflict");
        assert_eq!(fs::read(&original).unwrap(), [10,20]); assert_eq!(fs::read(&alias).unwrap(), [10,20]); assert_eq!(fs::read(&source).unwrap(), [99]);
    }
    #[test]
    fn concurrent_image_creates_have_one_winner_and_invalid_inputs_leave_no_files() {
        let f = Fixture::new(); let path = f.0.join("same.png"); let gate = Arc::new(std::sync::Barrier::new(8));
        let children: Vec<_> = (0u8..8).map(|n| { let path = path.clone(); let gate = gate.clone(); std::thread::spawn(move || { gate.wait(); (n, create_binary(&path, &[n])) }) }).collect();
        let mut winner = None;
        for child in children { let (n, result) = child.join().unwrap(); match result { Ok(_) => { assert!(winner.is_none()); winner = Some(n); }, Err(error) => assert_eq!(error.kind, "conflict") } }
        assert_eq!(fs::read(&path).unwrap(), [winner.unwrap()]);
        let invalid = f.0.join("not-created/invalid.png"); assert!(create_base64(&invalid, "not base64!").is_err()); assert!(!invalid.parent().unwrap().exists());
        let big = f.0.join("big.png"); fs::write(&big, [0u8; 16]).unwrap();
        let refused = copy_binary_limited(&big, &f.0.join("assets/big-copy.png"), 8).unwrap_err(); assert_eq!(refused.kind, "too_large"); assert!(!f.0.join("assets/big-copy.png").exists());
        let absent = f.0.join("not-created/missing.png"); assert!(copy_binary(&f.0.join("missing-source.png"), &absent).is_err()); assert!(!absent.parent().unwrap().exists());
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(err)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path.clone());
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn take_launch_files(pending: State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[tauri::command]
fn print_page(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(err)
}

/// Applies the native window material (Mica on Windows 11, vibrancy on macOS).
/// Returns whether a material is actually active so the UI can fall back to
/// opaque surfaces where it isn't supported (e.g. Windows 10).
#[tauri::command]
fn set_material(window: WebviewWindow, enabled: bool, dark: bool, theme: Option<String>) -> bool {
    let native_theme = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    let _ = window.set_theme(native_theme);
    apply_material(&window, enabled, dark)
}

#[cfg(target_os = "windows")]
fn apply_material(window: &WebviewWindow, enabled: bool, dark: bool) -> bool {
    use window_vibrancy::{apply_mica, clear_mica};
    if enabled {
        apply_mica(window, Some(dark)).is_ok()
    } else {
        let _ = clear_mica(window);
        false
    }
}

#[cfg(target_os = "macos")]
fn apply_material(window: &WebviewWindow, enabled: bool, _dark: bool) -> bool {
    use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    if enabled {
        apply_vibrancy(
            window,
            NSVisualEffectMaterial::Sidebar,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
        .is_ok()
    } else {
        let _ = clear_vibrancy(window);
        false
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn apply_material(_window: &WebviewWindow, _enabled: bool, _dark: bool) -> bool {
    false
}

fn collect_files<I: IntoIterator<Item = String>>(args: I, cwd: Option<&Path>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            match (p.is_absolute(), cwd) {
                (false, Some(dir)) => dir.join(p),
                _ => p,
            }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn deliver_files(app: &tauri::AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingFiles>() {
        state.0.lock().unwrap().extend(files.iter().cloned());
    }
    let _ = app.emit("open-files", files);
}

fn focus_main(app: &tauri::AppHandle) {
    if hidden_validation(app) { return; }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hidden_validation_identity(debug: bool, identifier: &str) -> bool {
    debug && identifier.starts_with("studio.ambertext.validation.hidden.")
}
fn hidden_validation(app: &tauri::AppHandle) -> bool {
    hidden_validation_identity(cfg!(debug_assertions), &app.config().identifier)
}
#[tauri::command]
fn reveal_ready_window(window: WebviewWindow) -> Result<(), String> {
    // Validation identifiers cannot reveal a window, including the frontend's
    // ready callback. Normal/release startup retains the same show/focus calls.
    if hidden_validation(window.app_handle()) { return Ok(()); }
    window.show().map_err(err)?;
    window.set_focus().map_err(err)
}
#[tauri::command]
fn hidden_validation_state(window: WebviewWindow) -> Result<serde_json::Value, String> {
    if !cfg!(debug_assertions) || !hidden_validation(window.app_handle()) { return Err("Not an invisible validation build".into()); }
    Ok(serde_json::json!({ "guard": "AMBERTEXT_HIDDEN_VALIDATION_V1", "identifier": window.app_handle().config().identifier,
        "visible": window.is_visible().map_err(err)?, "focused": window.is_focused().map_err(err)?, "pid": std::process::id() }))
}
#[cfg(test)]
mod hidden_validation_tests {
    use super::*;
    #[test]
    fn only_debug_hidden_validation_identifiers_suppress_startup() {
        assert!(hidden_validation_identity(true, "studio.ambertext.validation.hidden.disposable"));
        assert!(!hidden_validation_identity(false, "studio.ambertext.validation.hidden.disposable"));
        assert!(!hidden_validation_identity(true, "studio.ambertext.editor"));
        assert!(!hidden_validation_identity(true, "studio.ambertext.validation.old-visible-fixture"));
    }
}

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let app_menu = SubmenuBuilder::new(app, "AmberText")
        .about(None)
        .separator()
        .item(&item("settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New Document", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&item("open-folder", "Open Folder…", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item("close-folder", "Close Folder", None)?)
        .item(&item("quick-open", "Quick Open…", Some("CmdOrCtrl+P"))?)
        .item(&item("workspace-search", "Search Folder…", None)?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("history", "Local Document History…", None)?)
        .separator()
        .item(&item("export-html", "Export as HTML…", None)?)
        .item(&item("export-pdf", "Export as PDF…", None)?)
        .separator()
        .item(&item("close-tab", "Close Tab", Some("CmdOrCtrl+W"))?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item("redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", Some("CmdOrCtrl+F"))?)
        .item(&item("replace", "Find and Replace…", Some("CmdOrCtrl+Alt+F"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("mode-write", "Write", Some("CmdOrCtrl+1"))?)
        .item(&item("mode-split", "Split", Some("CmdOrCtrl+2"))?)
        .item(&item("mode-read", "Read", Some("CmdOrCtrl+3"))?)
        .separator()
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+\\"))?)
        .item(&item("focus-mode", "Focus Mode", Some("CmdOrCtrl+Shift+F"))?)
        .item(&item("typewriter", "Typewriter Scrolling", Some("CmdOrCtrl+Shift+T"))?)
        .item(&item("zen", "Zen Mode", Some("CmdOrCtrl+Shift+Enter"))?)
        .separator()
        .item(&item("palette", "Command Palette…", Some("CmdOrCtrl+K"))?)
        .item(&item("ai", "Ask AI…", Some("CmdOrCtrl+J"))?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = collect_files(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            deliver_files(app, files);
            focus_main(app);
        }));
    }

    builder
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingFiles::default())
        .manage(RecoveryGate::default())
        .manage(HistoryGate::default())
        .manage(SearchState::default())
        .manage(ReceiptGate::default())
        .manage(ReferenceState::default())
        .manage(ai::AiState::default())
        .setup(|app| {
            if app.config().identifier.starts_with("studio.ambertext.validation.hidden.")
                && (!cfg!(debug_assertions) || app.config().app.windows.iter().any(|w| w.visible || w.focus || w.focusable)) {
                return Err("Invisible validation requires a debug build and every window hidden and non-focusable".into());
            }
            let files = collect_files(std::env::args().skip(1), None);
            app.state::<PendingFiles>().0.lock().unwrap().extend(files);
            ai::kill_stale(app.handle());
            let sweep = app.handle().clone();
            std::thread::spawn(move || sweep_app_temps(&sweep));
            ai::watch_idle(app.handle().clone());

            // The frontend reveals the window once it has painted; never leave it hidden if that fails.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
                if hidden_validation(&handle) { return; }
                if let Some(w) = handle.get_webview_window("main") {
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });

            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    let _ = app.emit("menu", event.id().as_ref().to_string());
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            replacement_receipt_write,
            replacement_receipt_catalogue,
            reveal_ready_window,
            hidden_validation_state,
            reference_catalogue,
            reference_read,
            reference_target,
            reference_scan_cancel,
            workspace_search,
            workspace_search_cancel,
            list_tree,
            read_text,
            write_text,
            recovery_load,
            recovery_write,
            recovery_preserve_legacy,
            history_capture,
            history_catalogue,
            history_versions,
            history_read,
            history_maintain,
            history_release,
            history_remove_all,
            history_usage,
            history_rebind,
            history_detach,
            history_resolve,
            file_mtime,
            path_exists,
            create_file,
            create_dir,
            rename_path,
            trash_path,
            write_base64,
            copy_file,
            reveal_path,
            take_launch_files,
            print_page,
            set_material,
            ai::ai_status,
            ai::ai_install,
            ai::ai_cancel_install,
            ai::ai_remove,
            ai::ai_start,
            ai::ai_stop,
            ai::ai_chat,
            ai::ai_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while building AmberText")
        .run(|_app, _event| {
            if let tauri::RunEvent::Exit = &_event {
                _app.state::<ai::AiState>().shutdown();
            }
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                deliver_files(_app, files);
            }
        });
}
