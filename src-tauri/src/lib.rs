pub mod analyzer;
pub mod c_ast;
pub mod callback_flow;
pub mod clangd_bridge;
pub mod project_db;

use analyzer::{
    analyze_local_c_project_with_progress, export_porting_bundle, ExportPortingPayload,
};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn get_engine_status() -> Value {
    json!({
        "engine": "ChainAnalysis Rust Core",
        "version": env!("CARGO_PKG_VERSION"),
        "stage": "M4_FULL_DESKTOP_APP",
        "native": true
    })
}

#[tauri::command]
async fn analyze_c_project(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        analyze_local_c_project_with_progress(&path, |percent, stage, detail| {
            let _ = app.emit(
                "analysis-progress",
                json!({
                    "percent": percent,
                    "stage": stage,
                    "detail": detail,
                }),
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_porting_package(payload: ExportPortingPayload) -> Result<Value, String> {
    export_porting_bundle(payload)
}

#[tauri::command]
fn get_project_compile_db(path: String, target_index: Option<usize>) -> Result<Value, String> {
    let model = project_db::discover_project_model(Path::new(&path));
    Ok(json!({
        "sourceKind": model.source_kind,
        "activeTargetIndex": model.active_target_index,
        "targets": model.targets.iter().map(|t| json!({
            "name": t.name,
            "compilerFlavor": t.compiler_flavor.as_str(),
            "sourcesCount": t.sources.len(),
            "includeDirsCount": t.include_dirs.len(),
            "definesCount": t.defines.len(),
            "excludedFilesCount": t.excluded_files.len(),
        })).collect::<Vec<_>>(),
        "compileCommands": model.build_compile_commands(target_index),
    }))
}

#[tauri::command]
fn get_clangd_status(
    project_path: Option<String>,
    custom_clangd_path: Option<String>,
) -> Value {
    clangd_bridge::probe_clangd_environment(project_path.as_deref(), custom_clangd_path.as_deref())
}

#[tauri::command]
async fn open_standalone_drawer(
    app: tauri::AppHandle,
    repo_path: Option<String>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("drawer_popup") {
        let _ = win.set_focus();
        return Ok(());
    }
    let url_str = match repo_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(repo) => {
            let encoded = repo
                .bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{:02X}", b),
                })
                .collect::<String>();
            format!("index.html?standalone=drawer&repo={}", encoded)
        }
        None => "index.html?standalone=drawer".to_string(),
    };
    let app_handle = app.clone();
    let win = WebviewWindowBuilder::new(&app, "drawer_popup", WebviewUrl::App(url_str.into()))
        .title("ChainAnalysis — 独立源码与移植分析副窗口")
        .inner_size(780.0, 920.0)
        .min_inner_size(420.0, 500.0)
        .build()
        .map_err(|e| e.to_string())?;
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app_handle.emit("drawer-window-closed", ());
        }
    });
    Ok(())
}

#[tauri::command]
async fn close_standalone_drawer(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("drawer_popup") {
        let _ = win.destroy();
    }
    let _ = app.emit("drawer-window-closed", ());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_engine_status,
            analyze_c_project,
            export_porting_package,
            get_project_compile_db,
            get_clangd_status,
            open_standalone_drawer,
            close_standalone_drawer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
