//! SFTP 子系统：在已有 SSH 会话上开子通道，完成目录/文件操作。
//!
//! 每次调用建立临时 SftpSession，操作完成后关闭并释放子通道。
//! 子通道数据经过 russh 的通道 receiver 直接交给 SftpSession，
//! 不会进入终端（ssh.rs 的 RoutingState 已按通道过滤 Handler 回调）。

use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::DateTime;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncWriteExt;

use crate::model::{FileContent, RemoteFileEntry};
use crate::ssh;

/// 人类可读文件大小
fn human_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "K", "M", "G", "T"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{}B", bytes)
    } else if v >= 100.0 {
        format!("{:.0}{}", v, UNITS[i])
    } else {
        format!("{:.1}{}", v, UNITS[i])
    }
}

fn format_modified(secs: Option<u64>) -> String {
    match secs {
        Some(s) if s > 0 => DateTime::from_timestamp(s as i64, 0)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "—".into()),
        _ => "—".into(),
    }
}

/// 判断是否为可安全当作文本打开的文件：按扩展名 + 前 8KB 是否含 NUL。
fn looks_like_text(path: &str, data: &[u8]) -> bool {
    let text_ext = [
        "txt", "md", "rs", "js", "ts", "tsx", "jsx", "json", "yaml", "yml", "toml", "ini",
        "conf", "cfg", "sh", "bash", "py", "go", "java", "c", "h", "cpp", "hpp", "css",
        "html", "xml", "sql", "log", "csv", "env", "gitignore", "properties", "lock",
    ];
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if text_ext.contains(&ext.as_str()) || path.ends_with("Makefile") || path.ends_with("Dockerfile") {
        return true;
    }
    let probe = &data[..data.len().min(8192)];
    !probe.contains(&0u8)
}

/// 打开一个临时 SFTP session，执行闭包后自动关闭子通道。
async fn with_sftp<F, T>(session_id: &str, op: F) -> Result<T>
where
    F: for<'a> FnOnce(&'a SftpSession) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T>> + Send + 'a>> + Send,
{
    let (handle, routing) = ssh::session_handle(session_id)?;
    let channel = ssh::open_subchannel(&handle, &routing).await?;
    let id = channel.id();

    // 必须显式请求 sftp 子系统，否则服务端不会启动 SFTP 协议处理
    channel.request_subsystem(true, "sftp").await?;

    // SftpSession::new 需要拥有 stream；从此处开始持有它
    let stream = channel.into_stream();
    let sftp = SftpSession::new(stream)
        .await
        .with_context(|| "启动 SFTP 子系统失败（服务端可能未启用 sftp）")?;
    sftp.set_timeout(20);

    let result = op(&sftp).await;
    let _ = sftp.close().await;
    ssh::release_subchannel(&routing, id);
    result
}

/// 列出远端目录
pub async fn list(session_id: &str, path: &str) -> Result<Vec<RemoteFileEntry>> {
    let path = if path.trim().is_empty() { ".".to_string() } else { path.to_string() };
    with_sftp(session_id, move |sftp| {
        let path = path.clone();
        Box::pin(async move {
            let mut out = Vec::new();
            let entries = sftp
                .read_dir(&path)
                .await
                .with_context(|| format!("读取目录失败: {}", path))?;
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let ft = entry.file_type();
                let kind = if ft.is_dir() {
                    "dir"
                } else if ft.is_symlink() {
                    // 符号链接按目标类型简化展示为 file
                    "file"
                } else {
                    "file"
                };
                let meta = entry.metadata();
                let full = entry.path();
                out.push(RemoteFileEntry {
                    modified: format_modified(meta.modified().ok().map(|t| {
                        t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
                    })),
                    name,
                    size: if kind == "dir" { "—".into() } else { human_size(meta.len()) },
                    kind: kind.to_string(),
                    path: full,
                    content: None,
                });
            }
            // 目录在前，文件在后，各自按名称排序
            out.sort_by(|a, b| {
                let ak = if a.kind == "dir" { 0 } else { 1 };
                let bk = if b.kind == "dir" { 0 } else { 1 };
                ak.cmp(&bk).then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
            });
            Ok(out)
        })
    })
    .await
}

/// 读取远端文件（base64 编码，避免二进制损坏）
pub async fn read(session_id: &str, path: &str) -> Result<FileContent> {
    let path = path.to_string();
    with_sftp(session_id, move |sftp| {
        let path = path.clone();
        Box::pin(async move {
            let data = sftp
                .read(&path)
                .await
                .with_context(|| format!("读取文件失败: {}", path))?;
            let is_text = looks_like_text(&path, &data);
            Ok(FileContent {
                size: data.len() as u64,
                path: path.clone(),
                content_base64: B64.encode(&data),
                is_text,
            })
        })
    })
    .await
}

/// 写入远端文件（前端上传/编辑器保存都走这里）
pub async fn write(session_id: &str, path: &str, data_b64: &str) -> Result<u64> {
    let path = path.to_string();
    let bytes = B64.decode(data_b64).map_err(|e| anyhow::anyhow!("文件内容 base64 解码失败: {}", e))?;
    let len = bytes.len() as u64;
    with_sftp(session_id, move |sftp| {
        let path = path.clone();
        let bytes = bytes.clone();
        Box::pin(async move {
            sftp.write(&path, &bytes)
                .await
                .with_context(|| format!("写入文件失败: {}", path))?;
            Ok(len)
        })
    })
    .await
}

/// 重命名 / 移动
pub async fn rename(session_id: &str, from: &str, to: &str) -> Result<()> {
    let (from, to) = (from.to_string(), to.to_string());
    with_sftp(session_id, move |sftp| {
        let (from, to) = (from.clone(), to.clone());
        Box::pin(async move {
            sftp.rename(&from, &to)
                .await
                .with_context(|| format!("重命名失败: {} → {}", from, to))?;
            Ok(())
        })
    })
    .await
}

/// 删除文件或空目录
pub async fn remove(session_id: &str, path: &str, is_dir: bool) -> Result<()> {
    let path = path.to_string();
    with_sftp(session_id, move |sftp| {
        let path = path.clone();
        Box::pin(async move {
            let result = if is_dir {
                sftp.remove_dir(&path).await
            } else {
                sftp.remove_file(&path).await
            };
            result.with_context(|| format!("删除失败: {}", path))?;
            Ok(())
        })
    })
    .await
}

/// 新建文件（空内容）或目录
pub async fn create(session_id: &str, path: &str, is_dir: bool) -> Result<()> {
    let path = path.to_string();
    with_sftp(session_id, move |sftp| {
        let path = path.clone();
        Box::pin(async move {
            if is_dir {
                sftp.create_dir(&path)
                    .await
                    .with_context(|| format!("新建目录失败: {}", path))?;
            } else {
                let mut file = sftp
                    .open_with_flags(
                        &path,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    )
                    .await
                    .with_context(|| format!("新建文件失败: {}", path))?;
                let _ = file.shutdown().await;
            }
            Ok(())
        })
    })
    .await
}

/// 创建空文件（保留给未来扩展，当前 create 已覆盖）
#[allow(dead_code)]
fn _assert_send() {
    fn assert_send<T: Send>() {}
    assert_send::<RemoteFileEntry>();
}
