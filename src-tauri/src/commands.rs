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
pub async fn ssh_connect(app: AppHandle, mut config: SessionConfig) -> Result<(), String> {
    let sink = Arc::new(TauriSink(app));
    let session_id = config.id.clone();

    // 密码只在这里从 DPAPI 凭据库取出，解密结果留在 Rust 进程内，绝不回传 WebView。
    // secret_id 是保存连接时的原始 id；多标签会话的 runtimeId 只是会话实例标识。
    let password_missing = config
        .password
        .as_ref()
        .map(|p| p.is_empty())
        .unwrap_or(true);
    if config.auth_method == "password" && password_missing {
        let credential_id = config.secret_id.as_deref().unwrap_or(&config.id);
        match crate::secrets::get(credential_id) {
            Ok(Some(cred)) => {
                // 安全要点：凭据与保存时的 host/port/username 绑定。渲染层若被注入，
                // 可以把 secret_id 换成任意连接、把 host 换成攻击者服务器来骗取密码；
                // 这里用后端自己保存的绑定做校验，不一致立刻拒绝，明文绝不出进程。
                let binding = cred.binding;
                if !binding.is_bound() {
                    sink.status(
                        &session_id,
                        "error",
                        Some(format!(
                            "连接「{}」的密码由旧版本保存，缺少主机绑定保护。请编辑该连接重新输入密码后保存。",
                            config.name
                        )),
                    );
                    return Ok(());
                }
                if !config.host.eq_ignore_ascii_case(&binding.host)
                    || config.port != binding.port
                    || config.username != binding.username
                {
                    sink.status(
                        &session_id,
                        "error",
                        Some(format!(
                            "拒绝连接：已保存密码仅可用于 {}@{}:{}，本次请求却是 {}@{}:{}。\
                             若确实要改目标地址，请编辑连接重新输入密码。",
                            binding.username, binding.host, binding.port,
                            config.username, config.host, config.port
                        )),
                    );
                    return Ok(());
                }
                config.password = Some(cred.password);
            }
            Ok(None) => {
                // 没有已保存密码：交给 ssh::connect 统一报「没有可用密码」，
                // 与手动输入密码为空时的表现一致。
            }
            Err(e) => {
                // 与 ssh::connect 的约定一致：失败只经 status(error) 告知前端，
                // command 恒返回 Ok，避免前端 void driver.connect() 产生未处理 rejection，
                // 也让 UI 能显示错误而不是永远停在 "connecting"。
                sink.status(
                    &session_id,
                    "error",
                    Some(format!("读取已保存密码失败: {e:#}")),
                );
                return Ok(());
            }
        }
    }
    ssh::connect(sink, config).await.map_err(|e| format!("{e:#}"))
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
pub fn secret_set(
    id: String,
    password: String,
    host: String,
    port: u16,
    username: String,
) -> Result<(), String> {
    let binding = crate::secrets::SecretBinding { host, port, username };
    crate::secrets::set(&id, &password, binding).map_err(|e| format!("{e:#}"))
}

// 故意不提供 secret_get：密码只在 ssh_connect 内部由后端取用，
// 前端拿不到明文，即使渲染层被注入脚本也无法批量导出已保存密码。

#[tauri::command]
pub fn secret_remove(id: String) -> Result<(), String> {
    crate::secrets::remove(&id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn secret_has(id: String) -> bool {
    crate::secrets::has(&id)
}
