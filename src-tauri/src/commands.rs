//! 前端 drivers/tauri.ts 实际 invoke 的命令。
//! SSH 四命令参数名与前端一一对应：config / sessionId / data / cols / rows。
//! SFTP/监控命令为本次补齐的新接口。

use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::model::{
    ClosedPayload, DataPayload, FileContent, MonitorSnapshot, RemoteFileEntry, SessionConfig,
    StatusPayload,
};
use crate::{fs_local, monitor, sftp, ssh};
use crate::ssh::EventSink;

/// 把 SSH 事件转成 Tauri event 发给前端
struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn status(&self, session_id: &str, status: &str, message: Option<String>) {
        let _ = self.0.emit(
            "ssh://status",
            StatusPayload {
                session_id: session_id.to_string(),
                status: status.to_string(),
                message,
            },
        );
    }

    fn data(&self, session_id: &str, data: &str) {
        let _ = self.0.emit(
            "ssh://data",
            DataPayload {
                session_id: session_id.to_string(),
                data: data.to_string(),
            },
        );
    }

    fn closed(&self, session_id: &str) {
        let _ = self.0.emit(
            "ssh://closed",
            ClosedPayload {
                session_id: session_id.to_string(),
            },
        );
    }
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, config: SessionConfig) -> Result<(), String> {
    ssh::connect(Arc::new(TauriSink(app)), config)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn ssh_write(session_id: String, data: String) -> Result<(), String> {
    ssh::write(&session_id, data)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn ssh_resize(session_id: String, cols: u32, rows: u32) -> Result<(), String> {
    ssh::resize(&session_id, cols, rows)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn ssh_disconnect(app: AppHandle, session_id: String) -> Result<(), String> {
    let sink: Arc<dyn EventSink> = Arc::new(TauriSink(app));
    ssh::disconnect(&sink, &session_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ===== SFTP =====

#[tauri::command]
pub async fn sftp_list(session_id: String, path: String) -> Result<Vec<RemoteFileEntry>, String> {
    sftp::list(&session_id, &path).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn sftp_read(session_id: String, path: String) -> Result<FileContent, String> {
    sftp::read(&session_id, &path).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn sftp_write(session_id: String, path: String, data: String) -> Result<u64, String> {
    sftp::write(&session_id, &path, &data)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn sftp_rename(session_id: String, from: String, to: String) -> Result<(), String> {
    sftp::rename(&session_id, &from, &to)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn sftp_remove(session_id: String, path: String, is_dir: bool) -> Result<(), String> {
    sftp::remove(&session_id, &path, is_dir)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn sftp_create(session_id: String, path: String, is_dir: bool) -> Result<(), String> {
    sftp::create(&session_id, &path, is_dir)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ===== 资源监控 =====

#[tauri::command]
pub async fn monitor_collect(session_id: String) -> Result<MonitorSnapshot, String> {
    monitor::collect(&session_id)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ===== 本地文件系统 =====

#[tauri::command]
pub fn fs_home() -> String {
    fs_local::home()
}

#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<RemoteFileEntry>, String> {
    fs_local::list(&path).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn fs_read(path: String) -> Result<FileContent, String> {
    fs_local::read(&path).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn fs_write(path: String, data: String) -> Result<u64, String> {
    fs_local::write(&path, &data).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    fs_local::rename(&from, &to).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn fs_remove(path: String, is_dir: bool) -> Result<(), String> {
    fs_local::remove(&path, is_dir).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn fs_create(path: String, is_dir: bool) -> Result<(), String> {
    fs_local::create(&path, is_dir).map_err(|e| format!("{e:#}"))
}

// ===== 凭据（密码加密存储）=====
// 密码不再进入 localStorage，改由这里用 DPAPI 加密后单独落盘

#[tauri::command]
pub fn secret_set(id: String, password: String) -> Result<(), String> {
    crate::secrets::set(&id, &password).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn secret_get(id: String) -> Result<Option<String>, String> {
    crate::secrets::get(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn secret_remove(id: String) -> Result<(), String> {
    crate::secrets::remove(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn secret_has(id: String) -> bool {
    crate::secrets::has(&id)
}
