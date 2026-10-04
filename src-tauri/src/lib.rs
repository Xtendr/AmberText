mod ai;

use base64::Engine;
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State, WebviewWindow};

/// Files handed to the app before the frontend was ready to receive them
/// (command-line arguments, Finder "Open With", second instances).
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

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
fn read_text(path: String) -> Result<TextFile, String> {
    let bytes = fs::read(&path).map_err(err)?;
    // Legacy files are almost always Windows-1252; decoding them as such keeps
    // characters like æ ø é intact instead of turning them into U+FFFD on save.
    let mut content = String::from_utf8(bytes).unwrap_or_else(|e| e.into_bytes().iter().map(|&b| cp1252(b)).collect());
    if content.starts_with('\u{feff}') {
        content.remove(0);
    }
    Ok(TextFile {
        content,
        mtime: mtime_of(Path::new(&path)),
    })
}

fn cp1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xa0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char }
}

/// Writes through a sibling temp file and renames it into place so a crash
/// mid-write never leaves a truncated document behind.
#[tauri::command]
fn write_text(path: String, content: String) -> Result<u64, String> {
    // Write through symlinks to the real file rather than replacing the link.
    let target = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let dir = target.parent().ok_or("Invalid path")?;
    fs::create_dir_all(dir).map_err(err)?;
    let file_name = target
        .file_name()
        .ok_or("Invalid path")?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!(".{file_name}.margin-tmp"));
    let perms = fs::metadata(&target).ok().map(|m| m.permissions());
    let atomic = fs::write(&tmp, content.as_bytes())
        .and_then(|_| perms.map_or(Ok(()), |p| fs::set_permissions(&tmp, p)))
        .and_then(|_| fs::rename(&tmp, &target));
    if atomic.is_err() {
        let _ = fs::remove_file(&tmp);
        fs::write(&target, content.as_bytes()).map_err(err)?;
    }
    Ok(mtime_of(&target))
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
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err("A file with that name already exists".into());
    }
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(&p, content.as_bytes()).map_err(err)?;
    Ok(mtime_of(&p))
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
    let same_ignoring_case = from.to_lowercase() == to.to_lowercase();
    if Path::new(&to).exists() && !same_ignoring_case {
        return Err("Something with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(err)
}

#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(err)
}

#[tauri::command]
fn write_base64(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(err)?;
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(p, bytes).map_err(err)
}

#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    let p = PathBuf::from(&to);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::copy(&from, &p).map(|_| ()).map_err(err)
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
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
    let app_menu = SubmenuBuilder::new(app, "Margin")
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
        .item(&item("quick-open", "Quick Open…", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save-as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
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
        .manage(ai::AiState::default())
        .setup(|app| {
            let files = collect_files(std::env::args().skip(1), None);
            app.state::<PendingFiles>().0.lock().unwrap().extend(files);
            ai::kill_stale(app.handle());
            ai::watch_idle(app.handle().clone());

            // The frontend reveals the window once it has painted; never leave it hidden if that fails.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(3));
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
            list_tree,
            read_text,
            write_text,
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
        .expect("error while building Margin")
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
