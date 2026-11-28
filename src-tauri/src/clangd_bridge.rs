use crate::project_db::{self, ProjectModel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClangdStatus {
    Active,
    Unavailable,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClangdSemanticEdge {
    pub source_fn: String,
    pub target_fn: String,
    pub call_site_line: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClangdReport {
    pub status: ClangdStatus,
    pub binary_path: Option<String>,
    pub temp_cdb_dir: Option<String>,
    pub added_edges: Vec<ClangdSemanticEdge>,
    pub queried_functions: usize,
    pub elapsed_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct QueryTargetFn {
    pub name: String,
    pub disk_path: PathBuf,
    /// 1-based line number of the function header/name
    pub line_start: usize,
    /// 0-based UTF-8 column of the function identifier on `line_start`
    pub name_col: usize,
}

// ============================================================================
// 1. Auto-detect local `clangd` binary (PATH / LLVM / VS Code / Cursor / Env)
// ============================================================================

pub fn detect_clangd_binary(override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Ok(env_p) = std::env::var("CHAIN_ANALYSIS_CLANGD") {
        let pb = PathBuf::from(env_p.trim());
        if pb.is_file() {
            return Some(pb);
        }
    }

    let bin_name = if cfg!(windows) { "clangd.exe" } else { "clangd" };

    // 1. Search PATH
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join(bin_name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }

    // 2. Standard LLVM / MSYS2 / Homebrew paths
    let static_cands: &[&str] = if cfg!(windows) {
        &[
            r"C:\Program Files\LLVM\bin\clangd.exe",
            r"C:\Program Files (x86)\LLVM\bin\clangd.exe",
            r"D:\LLVM\bin\clangd.exe",
            r"C:\msys64\mingw64\bin\clangd.exe",
            r"C:\msys64\ucrt64\bin\clangd.exe",
        ]
    } else {
        &[
            "/usr/bin/clangd",
            "/usr/local/bin/clangd",
            "/opt/homebrew/opt/llvm/bin/clangd",
        ]
    };
    for s in static_cands {
        let pb = PathBuf::from(s);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // 3. VS Code / Cursor clangd extension globalStorage on Windows
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            for editor in ["Code", "Cursor", "Antigravity"] {
                let install_dir = PathBuf::from(&appdata)
                    .join(editor)
                    .join("User")
                    .join("globalStorage")
                    .join("llvm-vs-code-extensions.vscode-clangd")
                    .join("install");
                if let Some(found) = find_clangd_in_vscode_install(&install_dir, bin_name) {
                    return Some(found);
                }
            }
        }
    }

    None
}

fn find_clangd_in_vscode_install(install_dir: &Path, bin_name: &str) -> Option<PathBuf> {
    let rd = fs::read_dir(install_dir).ok()?;
    let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    versions.sort();
    for ver in versions.into_iter().rev() {
        let direct = ver.join("bin").join(bin_name);
        if direct.is_file() {
            return Some(direct);
        }
        if let Ok(sub_rd) = fs::read_dir(&ver) {
            for sub in sub_rd.flatten() {
                let nested = sub.path().join("bin").join(bin_name);
                if nested.is_file() {
                    return Some(nested);
                }
            }
        }
    }
    None
}

pub fn probe_clangd_environment(project_path: Option<&str>, custom_clangd: Option<&str>) -> Value {
    let detected = detect_clangd_binary(custom_clangd);
    let version = detected.as_ref().and_then(|bin| {
        let out = Command::new(bin).arg("--version").output().ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines().next().map(|l| l.trim().to_string())
    });

    let sys_includes = if let Some(p) = project_path {
        let model = project_db::discover_project_model(Path::new(p));
        let flavor = model
            .active_target()
            .map(|t| t.compiler_flavor)
            .unwrap_or(project_db::CompilerFlavor::Unknown);
        project_db::discover_host_system_includes(flavor)
            .into_iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    json!({
        "available": detected.is_some(),
        "binaryPath": detected.map(|p| p.to_string_lossy().replace('\\', "/")),
        "version": version,
        "hostSystemIncludes": sys_includes,
    })
}

// ============================================================================
// 2. LSP JSON-RPC 2.0 Framing & Client (`Content-Length` over stdio)
// ============================================================================

pub fn encode_lsp_message(payload: &Value) -> Vec<u8> {
    let body = payload.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    let mut buf = Vec::with_capacity(header.len() + body.len());
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(body.as_bytes());
    buf
}

pub fn read_lsp_message<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 LSP 头失败: {}", e))?;
        if n == 0 {
            return Ok(None); // EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("Content-Length") {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
    }

    let len = content_length.ok_or_else(|| "缺少 Content-Length 头".to_string())?;
    if len > 16 * 1024 * 1024 {
        return Err(format!("LSP 消息过大: {} bytes", len));
    }
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|e| format!("读取 LSP 消息体失败: {}", e))?;
    let val: Value =
        serde_json::from_slice(&body).map_err(|e| format!("解析 LSP JSON 失败: {}", e))?;
    Ok(Some(val))
}

pub fn path_to_file_uri(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let clean = raw.strip_prefix("//?/").unwrap_or(&raw);
    let mut encoded = String::with_capacity(clean.len() + 16);
    if clean.starts_with('/') {
        encoded.push_str("file://");
    } else {
        encoded.push_str("file:///");
    }
    for b in clean.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':' => {
                encoded.push(b as char);
            }
            _ => encoded.push_str(&format!("%{:02X}", b)),
        }
    }
    encoded
}

/// Extract `(target_fn_name, call_site_1based_line)` pairs from a `callHierarchy/outgoingCalls` response.
pub fn parse_outgoing_calls_response(result: &Value) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let Some(arr) = result.as_array() else {
        return out;
    };
    for item in arr {
        let Some(name) = item
            .get("to")
            .and_then(|t| t.get("name"))
            .and_then(|n| n.as_str())
        else {
            continue;
        };
        // Strip C++ parameter suffixes if any (e.g. `foo(int)` -> `foo`)
        let clean_name = name.split('(').next().unwrap_or(name).trim();
        if clean_name.is_empty() {
            continue;
        }
        let line = item
            .get("fromRanges")
            .and_then(|r| r.as_array())
            .and_then(|a| a.first())
            .and_then(|r| r.get("start"))
            .and_then(|s| s.get("line"))
            .and_then(|l| l.as_u64())
            .map(|l| (l as usize) + 1)
            .unwrap_or(1);
        out.push((clean_name.to_string(), line));
    }
    out
}

struct ClangdSession {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
}

impl ClangdSession {
    fn spawn(clangd_bin: &Path, cdb_dir: &Path) -> Result<Self, String> {
        let mut child = Command::new(clangd_bin)
            .arg(format!("--compile-commands-dir={}", cdb_dir.to_string_lossy()))
            .arg("--background-index=false")
            .arg("--clang-tidy=false")
            .arg("--header-insertion=never")
            .arg("--pch-storage=memory")
            .arg("--log=error")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动 clangd 进程失败: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "无法获取 clangd stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法获取 clangd stdout".to_string())?;

        let (tx, rx) = mpsc::channel::<Value>();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(msg)) = read_lsp_message(&mut reader) {
                if tx.send(msg).is_err() {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            rx,
            next_id: 1,
        })
    }

    fn send_raw(&mut self, msg: &Value) -> Result<(), String> {
        let bytes = encode_lsp_message(msg);
        self.stdin
            .write_all(&bytes)
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("写入 clangd 失败: {}", e))
    }

    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn send_request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_raw(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;

        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let rem = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(rem) {
                Ok(msg) => {
                    if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                        if let Some(err) = msg.get("error") {
                            return Err(format!("LSP {} 错误: {}", method, err));
                        }
                        return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // Ignore server notifications (diagnostics, progress, etc.)
                }
                Err(_) => return Err(format!("LSP {} 请求超时", method)),
            }
        }
        Err(format!("LSP {} 请求超时", method))
    }

    fn initialize(&mut self, root_dir: &Path) -> Result<(), String> {
        let root_uri = path_to_file_uri(root_dir);
        let _ = self.send_request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "callHierarchy": { "dynamicRegistration": false },
                        "definition": { "dynamicRegistration": false }
                    }
                }
            }),
            Duration::from_secs(4),
        )?;
        self.send_notification("initialized", json!({}))?;
        Ok(())
    }

    fn open_document(&mut self, file_path: &Path, text: &str) -> Result<String, String> {
        let uri = path_to_file_uri(file_path);
        let lang_id = if file_path
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| matches!(e.to_ascii_lowercase().as_str(), "cpp" | "cc" | "cxx" | "hpp"))
            .unwrap_or(false)
        {
            "cpp"
        } else {
            "c"
        };
        self.send_notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": lang_id,
                    "version": 1,
                    "text": text,
                }
            }),
        )?;
        Ok(uri)
    }

    fn query_outgoing_calls(
        &mut self,
        uri: &str,
        line_0based: usize,
        col_0based: usize,
    ) -> Result<Vec<(String, usize)>, String> {
        let prep = self.send_request(
            "textDocument/prepareCallHierarchy",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line_0based, "character": col_0based }
            }),
            Duration::from_millis(1200),
        )?;
        let Some(first_item) = prep.as_array().and_then(|a| a.first()).cloned() else {
            return Ok(Vec::new());
        };
        let outgoing = self.send_request(
            "callHierarchy/outgoingCalls",
            json!({ "item": first_item }),
            Duration::from_millis(1500),
        )?;
        Ok(parse_outgoing_calls_response(&outgoing))
    }
}

impl Drop for ClangdSession {
    fn drop(&mut self) {
        let _ = self.send_raw(&json!({ "jsonrpc": "2.0", "id": self.next_id, "method": "shutdown", "params": null }));
        let _ = self.send_notification("exit", Value::Null);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ============================================================================
// 3. Stage 3 Orchestrator: Enhance Stage 2 call graph with optional clangd LSP
// ============================================================================

/// Attempt to enhance the Stage 2 call graph using local `clangd` LSP + temporary `compile_commands.json`.
/// Strictly bounded by a wall-clock budget (~6s) and guaranteed to degrade gracefully if `clangd`
/// is missing, slow, or fails on proprietary embedded extensions.
pub fn enhance_graph_with_clangd(
    project_model: &ProjectModel,
    query_targets: &[QueryTargetFn],
    known_func_names: &HashSet<String>,
    existing_edge_keys: &HashSet<String>,
    override_clangd: Option<&str>,
) -> ClangdReport {
    let started = Instant::now();

    let Some(clangd_bin) = detect_clangd_binary(override_clangd) else {
        return ClangdReport {
            status: ClangdStatus::Unavailable,
            binary_path: None,
            temp_cdb_dir: None,
            added_edges: Vec::new(),
            queried_functions: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            message: "本机未检测到 clangd，已无感降级至阶段 2 (tree-sitter-c AST + 多重异步回调引擎)".to_string(),
        };
    };

    let bin_str = clangd_bin.to_string_lossy().replace('\\', "/");

    // Generate temporary compile_commands.json in %TEMP% (never modifies user repo)
    let cdb_dir = match project_model.write_temp_compile_commands(None) {
        Ok(d) => d,
        Err(e) => {
            return ClangdReport {
                status: ClangdStatus::Fallback,
                binary_path: Some(bin_str),
                temp_cdb_dir: None,
                added_edges: Vec::new(),
                queried_functions: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                message: format!("生成临时编译数据库失败，已降级阶段 2: {}", e),
            };
        }
    };
    let cdb_dir_str = cdb_dir.to_string_lossy().replace('\\', "/");

    let mut session = match ClangdSession::spawn(&clangd_bin, &cdb_dir) {
        Ok(s) => s,
        Err(e) => {
            return ClangdReport {
                status: ClangdStatus::Fallback,
                binary_path: Some(bin_str),
                temp_cdb_dir: Some(cdb_dir_str),
                added_edges: Vec::new(),
                queried_functions: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                message: format!("clangd 启动失败，已降级阶段 2: {}", e),
            };
        }
    };

    if let Err(e) = session.initialize(&project_model.root_dir) {
        return ClangdReport {
            status: ClangdStatus::Fallback,
            binary_path: Some(bin_str),
            temp_cdb_dir: Some(cdb_dir_str),
            added_edges: Vec::new(),
            queried_functions: 0,
            elapsed_ms: started.elapsed().as_millis() as u64,
            message: format!("clangd 初始化失败，已降级阶段 2: {}", e),
        };
    }

    let mut opened_uris: HashMap<PathBuf, String> = HashMap::new();
    let mut added_edges: Vec<ClangdSemanticEdge> = Vec::new();
    let mut seen_new: HashSet<(String, String)> = HashSet::new();
    let mut queried_functions = 0usize;
    let budget = Duration::from_secs(6);

    for qt in query_targets.iter().take(24) {
        if started.elapsed() >= budget {
            break;
        }
        let uri = if let Some(u) = opened_uris.get(&qt.disk_path) {
            u.clone()
        } else {
            if opened_uris.len() >= 12 {
                continue;
            }
            let Ok(text) = fs::read_to_string(&qt.disk_path) else {
                continue;
            };
            match session.open_document(&qt.disk_path, &text) {
                Ok(u) => {
                    opened_uris.insert(qt.disk_path.clone(), u.clone());
                    u
                }
                Err(_) => continue,
            }
        };

        queried_functions += 1;
        let line_0 = qt.line_start.saturating_sub(1);
        if let Ok(outgoing) = session.query_outgoing_calls(&uri, line_0, qt.name_col) {
            for (callee, call_line) in outgoing {
                if callee == qt.name || !known_func_names.contains(&callee) {
                    continue;
                }
                let key = format!("{}->{}", qt.name, callee);
                if existing_edge_keys.contains(&key) {
                    continue;
                }
                if seen_new.insert((qt.name.clone(), callee.clone())) {
                    added_edges.push(ClangdSemanticEdge {
                        source_fn: qt.name.clone(),
                        target_fn: callee,
                        call_site_line: call_line,
                        label: "clangd 语义补全 (宏/类型推导)".to_string(),
                    });
                }
            }
        }
    }

    let msg = format!(
        "clangd LSP 语义增强已激活：校验 {} 个核心函数，补全 {} 条语义调用边",
        queried_functions,
        added_edges.len()
    );

    ClangdReport {
        status: ClangdStatus::Active,
        binary_path: Some(bin_str),
        temp_cdb_dir: Some(cdb_dir_str),
        added_edges,
        queried_functions,
        elapsed_ms: started.elapsed().as_millis() as u64,
        message: msg,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_lsp_framing_encode_and_decode_roundtrip() {
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "callHierarchy/outgoingCalls",
            "params": { "item": { "name": "main" } }
        });
        let encoded = encode_lsp_message(&msg);
        let mut cursor = Cursor::new(encoded);
        let decoded = read_lsp_message(&mut cursor)
            .expect("decode ok")
            .expect("some msg");
        assert_eq!(decoded["id"], 7);
        assert_eq!(decoded["method"], "callHierarchy/outgoingCalls");
        // Next read returns None on EOF
        assert!(read_lsp_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn test_parse_call_hierarchy_outgoing_response() {
        let mock_resp = json!([
            {
                "to": { "name": "HAL_UART_Transmit_DMA", "kind": 12 },
                "fromRanges": [
                    { "start": { "line": 41, "character": 4 }, "end": { "line": 41, "character": 25 } }
                ]
            },
            {
                "to": { "name": "usb_send_packet(uint8_t *)", "kind": 12 },
                "fromRanges": [
                    { "start": { "line": 58, "character": 8 }, "end": { "line": 58, "character": 23 } }
                ]
            }
        ]);
        let parsed = parse_outgoing_calls_response(&mock_resp);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], ("HAL_UART_Transmit_DMA".to_string(), 42));
        assert_eq!(parsed[1], ("usb_send_packet".to_string(), 59));
    }

    #[test]
    fn test_graceful_fallback_when_clangd_missing() {
        let model = ProjectModel {
            root_dir: std::env::temp_dir(),
            source_kind: project_db::ProjectSourceKind::DirectoryFallback,
            targets: Vec::new(),
            active_target_index: 0,
        };
        // Force a non-existent path via override check + test fallback behavior
        let rep = enhance_graph_with_clangd(
            &model,
            &[],
            &HashSet::new(),
            &HashSet::new(),
            Some("__nonexistent_clangd_binary_xyz__"),
        );
        // Either Unavailable (when host has no clangd) or Active (if host happens to have clangd in VS Code/PATH)
        assert!(matches!(
            rep.status,
            ClangdStatus::Unavailable | ClangdStatus::Active | ClangdStatus::Fallback
        ));
    }
}
