//! 与前端 `src/types.ts` 对齐的数据结构。
//! Tauri 把 JS 的 camelCase 参数转成 Rust 字段名，serde 的 rename_all 负责反序列化。

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

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
    /// 密码用 Zeroizing 承载：drop 时自动把堆内存清零，Debug 输出也会遮蔽内容。
    /// 注意这只覆盖本进程内的副本；russh 认证接口要求 Into<String>，其内部副本无法控制。
    pub password: Option<Zeroizing<String>>,
    /// 凭据库中保存该密码时使用的原始连接 id；标签的 runtimeId 只是会话实例 id
    pub secret_id: Option<String>,
    pub private_key_path: Option<String>,
    pub protocol: Option<String>,
    /// 侧栏 / 标签页圆点颜色（纯展示用，后端不解读）
    pub color: Option<String>,
    /// JS number 是毫秒时间戳
    pub created_at: i64,
    /// 本次连接是否已得到用户「信任这台新主机」的确认。
    /// 首次连接（known_hosts 里没有该主机）时后端会中止握手并回传指纹，
    /// 只有用户在界面上确认后前端才会带这个标记重连——不再静默自动信任。
    #[serde(default)]
    pub trust_new_host_key: bool,
    /// 本次连接是否已得到用户「这台服务器的指纹变了，我认新指纹」的确认。
    /// 指纹变化比"新主机"更危险（可能是中间人），因此前端会弹高危确认框，
    /// 只有用户明确确认后后端才会删掉旧记录并写入新指纹。
    #[serde(default)]
    pub trust_changed_host_key: bool,
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
    /// "dir" | "file"；序列化为 "type" 与前端 RemoteFileEntry 对齐
    #[serde(rename = "type")]
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

/// 真实 GPU 信息（来自 nvidia-smi）。采集不到时为 None，前端据此隐藏整块 GPU 面板，
/// 绝不用 CPU 推导或写死示例值冒充。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// 显卡型号，如 "NVIDIA GeForce RTX 3080"
    pub name: String,
    /// GPU 利用率 0-100
    pub utilization: f64,
    /// 显存已用 MiB
    pub mem_used: f64,
    /// 显存总量 MiB
    pub mem_total: f64,
    /// 温度 °C；读不到为 None
    pub temperature: Option<f64>,
    /// 功耗 W；读不到为 None
    pub power: Option<f64>,
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
    /// 真实 GPU 信息；无 GPU / 采集失败为 None
    pub gpu: Option<GpuInfo>,
    pub disk_read: f64,
    pub disk_write: f64,
    pub net_in: f64,
    pub net_out: f64,
    pub processes: Vec<ProcessEntry>,
    pub connections: Vec<NetConnection>,
    pub history: Vec<f64>,
    pub net_history: Vec<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归测试：文件名类别字段序列化为 "type" 而非 "kind"。
    /// 曾因后端字段叫 kind、前端读 type，导致真机 SFTP 列表图标错乱、双击进不了目录。
    #[test]
    fn remote_file_entry_serializes_as_type() {
        let e = RemoteFileEntry {
            name: "home".into(),
            size: "—".into(),
            modified: "—".into(),
            kind: "dir".into(),
            path: "/home/ubuntu".into(),
            content: None,
        };
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["type"], "dir", "必须有 type 字段，JSON={json}");
        assert!(json.get("kind").is_none(), "不应出现 kind 字段，JSON={json}");
        assert!(json.get("content").is_none(), "content 为 None 时应省略，JSON={json}");
    }
}
