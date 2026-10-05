//! Local writing intelligence: downloads a pinned llama.cpp server build plus a
//! GGUF model on demand, runs it as a sidecar bound to 127.0.0.1, and proxies
//! streaming chat completions to the webview. Document text never leaves the
//! machine unless the user points AmberText at a remote endpoint themselves.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

/// llama.cpp release the app is tested against. Bump deliberately.
const RUNTIME_TAG: &str = "b11382";

/// Unload the model after this long without a request, to give memory back.
const IDLE_STOP: Duration = Duration::from_secs(12 * 60);

pub struct AiState {
    server: Mutex<Option<Server>>,
    install_cancel: Mutex<Option<Arc<AtomicBool>>>,
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
    last_used: Mutex<Instant>,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            server: Mutex::default(),
            install_cancel: Mutex::default(),
            requests: Mutex::default(),
            last_used: Mutex::new(Instant::now()),
        }
    }
}

/// Background loop that stops an idle sidecar. Runs for the app's lifetime.
pub fn watch_idle(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(30));
        let state = app.state::<AiState>();
        let busy = !state.requests.lock().unwrap().is_empty();
        let idle = state.last_used.lock().unwrap().elapsed() > IDLE_STOP;
        if idle && !busy && state.server.lock().unwrap().is_some() {
            state.shutdown();
        }
    });
}

fn touch(app: &AppHandle) {
    *app.state::<AiState>().last_used.lock().unwrap() = Instant::now();
}

struct Server {
    child: Child,
    port: u16,
    key: String,
    model: String,
}

impl AiState {
    pub fn shutdown(&self) {
        if let Some(mut s) = self.server.lock().unwrap().take() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    url: String,
    key: String,
    model: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    runtime_installed: bool,
    runtime_supported: bool,
    installed: Vec<String>,
    server: Option<ServerInfo>,
    installing: bool,
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    file: String,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    stage: &'a str,
    file: &'a str,
    received: u64,
    total: u64,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn ai_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("ai");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = ai_dir(app)?.join("models");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("runtime").join(RUNTIME_TAG))
}

/// Release asset for this platform: (name, sha256, size). Pinned with RUNTIME_TAG.
fn runtime_spec() -> Option<(&'static str, &'static str, u64)> {
    Some(if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        ("macos-arm64.tar.gz", "c2540b6515cf508c270815b494ff3f228818165fe7dcdac73f643e4f10bde2e6", 11925743)
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        ("macos-x64.tar.gz", "37355fefe4fd208172746872e173f10e19d945ac35da01a209d9518e6ba39c13", 11477182)
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        ("win-vulkan-x64.zip", "5fb6aadc98f85599ff060decd8867e8c1732dd552797913ae6c0295dd4b47482", 33287292)
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        ("win-cpu-arm64.zip", "d599c476541d9ac4c929483e6150b6a906d0c6bd21ac739eb30d6cb6d4faaded", 12219255)
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        ("ubuntu-x64.tar.gz", "34407d59947ed4ab35fe4ab2db5f61bb4d5aedfe25e6a72f702f3ae9758a396d", 17669957)
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        ("ubuntu-arm64.tar.gz", "f4ac1827e58e3df1c7f4657acc03352be4f8ad85b8abddc23741cd7bb3730cee", 13703641)
    } else {
        return None;
    })
}

fn runtime_asset() -> Option<String> {
    let (name, _, _) = runtime_spec()?;
    Some(format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{RUNTIME_TAG}/llama-{RUNTIME_TAG}-bin-{name}"
    ))
}

const SERVER_BIN: &str = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if e.file_name() == name {
            return Some(p);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs.into_iter().find_map(|d| find_file(&d, name, depth - 1))
}

fn server_binary(app: &AppHandle) -> Option<PathBuf> {
    find_file(&runtime_dir(app).ok()?, SERVER_BIN, 2)
}

/// Kills a sidecar left behind by a previous run that didn't exit cleanly
/// (crash, force quit). Only touches processes running our own runtime binary.
pub fn kill_stale(app: &AppHandle) {
    let Ok(dir) = ai_dir(app) else { return };
    let pid_file = dir.join("server.pid");
    let Some(pid) = fs::read_to_string(&pid_file).ok().and_then(|s| s.trim().parse::<u32>().ok()) else { return };
    let _ = fs::remove_file(&pid_file);
    let runtime = dir.join("runtime").to_string_lossy().into_owned();
    #[cfg(unix)]
    {
        let out = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output();
        if out.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&runtime)) {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
    #[cfg(windows)]
    {
        let script = format!("(Get-Process -Id {pid} -ErrorAction SilentlyContinue).Path");
        let mut ps = Command::new("powershell");
        ps.args(["-NoProfile", "-Command", &script]);
        hide_window(&mut ps);
        if ps.output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&runtime)) {
            let mut kill = Command::new("taskkill");
            kill.args(["/PID", &pid.to_string(), "/F"]);
            hide_window(&mut kill);
            let _ = kill.status();
        }
    }
}

fn valid_file_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\']) && !name.starts_with('.') && name.ends_with(".gguf")
}

fn installed_models(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = models_dir(app) else { return vec![] };
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".gguf"))
        .collect()
}

fn server_info(s: &Server) -> ServerInfo {
    ServerInfo {
        url: format!("http://127.0.0.1:{}", s.port),
        key: s.key.clone(),
        model: s.model.clone(),
    }
}

/// Drops the server handle if the process has died behind our back.
fn reap(state: &AiState) {
    let mut guard = state.server.lock().unwrap();
    if let Some(s) = guard.as_mut() {
        if !matches!(s.child.try_wait(), Ok(None)) {
            *guard = None;
        }
    }
}

#[tauri::command]
pub fn ai_status(app: AppHandle, state: State<AiState>) -> Result<AiStatus, String> {
    reap(&state);
    Ok(AiStatus {
        runtime_installed: server_binary(&app).is_some(),
        runtime_supported: runtime_asset().is_some(),
        installed: installed_models(&app),
        server: state.server.lock().unwrap().as_ref().map(server_info),
        installing: state.install_cancel.lock().unwrap().is_some(),
        dir: ai_dir(&app)?.to_string_lossy().into_owned(),
    })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("AmberText/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// Streams `url` into `dest`, resuming a previous partial download when possible.
fn download(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    stage: &str,
    expected: Option<(&str, u64)>,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let part = dest.with_extension(format!(
        "{}.part",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    let file_name = dest.file_name().unwrap().to_string_lossy().into_owned();
    let mut hasher = Sha256::new();
    let mut have = 0u64;
    if part.exists() && expected.is_some() {
        let mut f = fs::File::open(&part).map_err(err)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf).map_err(err)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            have += n as u64;
        }
        if let Some((sha, size)) = expected {
            // A crash between the last write and the rename leaves a complete .part behind;
            // asking the server for bytes past the end would fail forever.
            if have >= size {
                let ok = have == size && format!("{:x}", hasher.clone().finalize()).eq_ignore_ascii_case(sha);
                if ok {
                    return fs::rename(&part, dest).map_err(err);
                }
                let _ = fs::remove_file(&part);
                hasher = Sha256::new();
                have = 0;
            }
        }
    } else {
        let _ = fs::remove_file(&part);
    }

    let mut req = agent().get(url);
    if have > 0 {
        req = req.set("Range", &format!("bytes={have}-"));
    }
    let resp = req.call().map_err(|e| format!("Download failed — {e}"))?;
    if have > 0 && resp.status() != 206 {
        have = 0;
        hasher = Sha256::new();
    }
    let total = expected.map(|(_, s)| s).unwrap_or_else(|| {
        resp.header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| n + have)
            .unwrap_or(0)
    });

    let mut out = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(have > 0)
        .truncate(have == 0)
        .open(&part)
        .map_err(err)?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 256 * 1024];
    let mut received = have;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("Download interrupted — {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(err)?;
        hasher.update(&buf[..n]);
        received += n as u64;
        if last_emit.elapsed() > Duration::from_millis(120) {
            last_emit = Instant::now();
            let _ = app.emit("ai-progress", Progress { stage, file: &file_name, received, total });
        }
    }
    out.flush().map_err(err)?;
    drop(out);
    let _ = app.emit("ai-progress", Progress { stage, file: &file_name, received, total });

    if let Some((sha, size)) = expected {
        let digest = format!("{:x}", hasher.finalize());
        if received != size || !digest.eq_ignore_ascii_case(sha) {
            let _ = fs::remove_file(&part);
            return Err("The download didn't match its checksum. Please try again.".into());
        }
    }
    fs::rename(&part, dest).map_err(err)
}

fn install_runtime(app: &AppHandle, cancel: &AtomicBool) -> Result<(), String> {
    if server_binary(app).is_some() {
        return Ok(());
    }
    let url = runtime_asset().ok_or("Local AI isn't available on this platform yet")?;
    let dir = runtime_dir(app)?;
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(err)?;
    let archive = dir.join(if url.ends_with(".zip") { "runtime.zip" } else { "runtime.tar.gz" });
    let (_, sha, size) = runtime_spec().ok_or("Local AI isn't available on this platform yet")?;
    download(app, &url, &archive, "runtime", Some((sha, size)), cancel)?;
    // bsdtar ships with macOS and Windows 10+, and reads both zip and tar.gz.
    // On Windows, a GNU tar from Git or MSYS earlier on PATH can't read zip files.
    #[cfg(windows)]
    let mut cmd = Command::new(
        std::env::var_os("SystemRoot").map_or_else(|| PathBuf::from("tar"), |r| PathBuf::from(r).join("System32").join("tar.exe")),
    );
    #[cfg(not(windows))]
    let mut cmd = Command::new("tar");
    cmd.arg("-xf").arg(&archive).arg("-C").arg(&dir);
    hide_window(&mut cmd);
    let status = cmd.status().map_err(|e| format!("Couldn't unpack the AI runtime — {e}"))?;
    let _ = fs::remove_file(&archive);
    if !status.success() || server_binary(app).is_none() {
        let _ = fs::remove_dir_all(&dir);
        return Err("Couldn't unpack the AI runtime".into());
    }
    #[cfg(unix)]
    if let Some(bin) = server_binary(app) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

#[tauri::command]
pub async fn ai_install(app: AppHandle, model: ModelSpec) -> Result<(), String> {
    if !valid_file_name(&model.file) {
        return Err("Invalid model file name".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<AiState>();
        let mut slot = state.install_cancel.lock().unwrap();
        if slot.is_some() {
            return Err("Another download is already in progress".into());
        }
        *slot = Some(cancel.clone());
    }
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_runtime(&app2, &cancel)?;
        let dest = models_dir(&app2)?.join(&model.file);
        if !dest.exists() {
            download(&app2, &model.url, &dest, "model", Some((&model.sha256, model.size)), &cancel)?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(err)
    .and_then(|r| r);
    *app.state::<AiState>().install_cancel.lock().unwrap() = None;
    result
}

#[tauri::command]
pub fn ai_cancel_install(state: State<AiState>) {
    if let Some(c) = state.install_cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn ai_remove(app: AppHandle, state: State<AiState>, file: String) -> Result<(), String> {
    if !valid_file_name(&file) {
        return Err("Invalid model file name".into());
    }
    let running = state.server.lock().unwrap().as_ref().map(|s| s.model == file).unwrap_or(false);
    if running {
        state.shutdown();
    }
    let p = models_dir(&app)?.join(&file);
    if p.exists() {
        fs::remove_file(p).map_err(err)?;
    }
    Ok(())
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    Ok(l.local_addr().map_err(err)?.port())
}

fn random_key() -> String {
    let mut h = Sha256::new();
    h.update(format!("{:?}{}", Instant::now(), std::process::id()).as_bytes());
    h.update(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    format!("{:x}", h.finalize())[..32].to_string()
}

fn hide_window(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _cmd.creation_flags(0x0800_0000);
    }
}

fn log_tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| {
            let l = l.to_ascii_lowercase();
            l.contains("error") || l.contains("failed") || l.contains("unknown")
        })
        .collect();
    lines.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" · ")
}

#[tauri::command]
pub async fn ai_start(app: AppHandle, file: String, ctx: Option<u32>) -> Result<ServerInfo, String> {
    if !valid_file_name(&file) {
        return Err("Invalid model file name".into());
    }
    touch(&app);
    {
        let state = app.state::<AiState>();
        reap(&state);
        let guard = state.server.lock().unwrap();
        if let Some(s) = guard.as_ref().filter(|s| s.model == file) {
            return Ok(server_info(s));
        }
    }
    app.state::<AiState>().shutdown();
    kill_stale(&app);

    let bin = server_binary(&app).ok_or("The AI runtime isn't installed")?;
    let model = models_dir(&app)?.join(&file);
    if !model.exists() {
        return Err("That model isn't downloaded yet".into());
    }
    let port = free_port()?;
    let key = random_key();
    let log_path = ai_dir(&app)?.join("server.log");
    let log = fs::File::create(&log_path).map_err(err)?;
    let mut cmd = Command::new(&bin);
    cmd.current_dir(bin.parent().unwrap())
        .arg("-m")
        .arg(&model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key])
        .args(["-c", &ctx.unwrap_or(16384).to_string(), "-np", "1", "-ngl", "999"])
        .args(["--reasoning", "off", "--no-webui", "--jinja"])
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(err)?)
        .stderr(log);
    hide_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Couldn't start the AI runtime — {e}"))?;
    let _ = fs::write(ai_dir(&app)?.join("server.pid"), child.id().to_string());
    *app.state::<AiState>().server.lock().unwrap() = Some(Server { child, port, key: key.clone(), model: file.clone() });

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let health = format!("http://127.0.0.1:{port}/health");
        let started = Instant::now();
        let client = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).build();
        loop {
            {
                let state = app2.state::<AiState>();
                let mut guard = state.server.lock().unwrap();
                match guard.as_mut() {
                    Some(s) if s.port == port => {
                        if !matches!(s.child.try_wait(), Ok(None)) {
                            *guard = None;
                            let detail = log_tail(&log_path);
                            return Err(if detail.is_empty() {
                                "The AI runtime stopped unexpectedly".to_string()
                            } else {
                                format!("The AI runtime stopped — {detail}")
                            });
                        }
                    }
                    _ => return Err("cancelled".to_string()),
                }
            }
            if let Ok(r) = client.get(&health).call() {
                if r.status() == 200 {
                    return Ok(());
                }
            }
            if started.elapsed() > Duration::from_secs(180) {
                app2.state::<AiState>().shutdown();
                return Err("The model took too long to load".to_string());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    })
    .await
    .map_err(err)??;

    Ok(ServerInfo { url: format!("http://127.0.0.1:{port}"), key, model: file })
}

#[tauri::command]
pub fn ai_stop(state: State<AiState>) {
    state.shutdown();
}

#[derive(Serialize)]
pub struct ChatResult {
    text: String,
    /// "stop", "length" (hit max_tokens) or "cancelled".
    finish: String,
}

/// Streams an OpenAI-compatible chat completion, forwarding content deltas.
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    id: String,
    url: String,
    key: Option<String>,
    body: serde_json::Value,
    on_token: Channel<String>,
) -> Result<ChatResult, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AiState>().requests.lock().unwrap().insert(id.clone(), cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(120))
            .build();
        let mut req = client.post(&url).set("Content-Type", "application/json");
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            req = req.set("Authorization", &format!("Bearer {k}"));
        }
        let resp = req.send_json(body).map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let text = r.into_string().unwrap_or_default();
                let msg = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| v["error"]["message"].as_str().map(String::from))
                    .unwrap_or(text);
                format!("The model returned an error ({code}) — {msg}")
            }
            other => format!("Couldn't reach the model — {other}"),
        })?;
        let reader = BufReader::new(resp.into_reader());
        let mut full = String::new();
        let mut finish = String::new();
        for line in reader.lines() {
            if cancel.load(Ordering::Relaxed) {
                finish = "cancelled".into();
                break;
            }
            let line = line.map_err(err)?;
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            if let Some(msg) = v["error"]["message"].as_str() {
                return Err(msg.to_string());
            }
            if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                if !delta.is_empty() {
                    full.push_str(delta);
                    let _ = on_token.send(delta.to_string());
                }
            }
            if let Some(reason) = v["choices"][0]["finish_reason"].as_str() {
                finish = reason.to_string();
            }
        }
        Ok(ChatResult { text: full, finish })
    })
    .await
    .map_err(err)
    .and_then(|r| r);
    app.state::<AiState>().requests.lock().unwrap().remove(&id);
    touch(&app);
    result
}

#[tauri::command]
pub fn ai_cancel(state: State<AiState>, id: String) {
    if let Some(c) = state.requests.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}
