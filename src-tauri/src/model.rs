//! 与前端 `src/types.ts` 对齐的数据结构。
//! Tauri 把 JS 的 camelCase 参数转成 Rust 字段名，serde 的 rename_all 负责反序列化。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 前端 SessionConfig（types.ts:8-25）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 前端只是工作区分组名，不是远程目录
    pub directory: String,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub protocol: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub note: Option<String>,
    pub color: Option<String>,
    /// JS number 是毫秒时间戳
    pub created_at: i64,
}

/// ssh://data 事件 payload
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPayload {
    pub session_id: String,
    pub data: String,
}

/// ssh://status 事件 payload
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    pub session_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// ssh://closed 事件 payload
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedPayload {
    pub session_id: String,
}

// ===== SFTP 文件传输 =====

/// 前端 RemoteFileEntry（types.ts:195-202）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    /// 人类可读大小，如 "1.2K" / "890B" / "—"
    pub size: String,
    /// 修改时间字符串
    pub modified: String,
    /// "dir" | "file"
    pub kind: String,
    /// 完整远端路径
    pub path: String,
    /// 文件内容（仅 read 时填充）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// sftp_read 的返回值：base64 编码内容，避免二进制/UTF-8 在 JSON 中损坏
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    /// base64 编码的原始字节
    pub content_base64: String,
    /// 是否为文本文件（可安全直接用文本编辑器打开）
    pub is_text: bool,
    pub size: u64,
}

// ===== 资源监控 =====

/// 前端 ProcessEntry（types.ts:206-212）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: f64,
    pub command: String,
}

/// 前端 NetConnection（types.ts:214-219）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetConnection {
    pub proto: String,
    pub local: String,
    pub remote: String,
    pub state: String,
}

/// 前端 FilesystemEntry（types.ts:221-225）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemEntry {
    pub mount: String,
    /// GB
    pub used: f64,
    /// GB
    pub total: f64,
}

/// 前端 MonitorSnapshot（types.ts:227-248）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub session_id: String,
    pub uptime: String,
    pub load: [f64; 3],
    pub cpu: f64,
    pub cpu_cores: u32,
    pub mem_used: f64,
    pub mem_total: f64,
    pub mem_app: f64,
    pub mem_cache: f64,
    pub swap_used: f64,
    pub swap_total: f64,
    pub filesystems: Vec<FilesystemEntry>,
    pub disk_read: f64,
    pub disk_write: f64,
    pub net_in: f64,
    pub net_out: f64,
    pub processes: Vec<ProcessEntry>,
    pub connections: Vec<NetConnection>,
    pub history: Vec<f64>,
    pub net_history: Vec<f64>,
}
