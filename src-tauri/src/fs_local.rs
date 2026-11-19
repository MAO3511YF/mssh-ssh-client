//! 本地文件系统访问：供文件传输面板的"本地"侧列目录、读写、重命名、删除。
//! Rust 侧直接用 std::fs，不需要 @tauri-apps/plugin-fs 的前端权限。
//! 路径支持 "~" 展开为本机用户目录（Windows/Linux/macOS 通用）。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use chrono::DateTime;

use crate::model::{FileContent, RemoteFileEntry};

/// 展开 ~ 与 ~\ 前缀
pub fn expand(path: &str) -> PathBuf {
    let expanded = if let Some(rest) = path.strip_prefix("~/").or_else(|| strip_prefix_win(path)) {
        if let Some(home) = dirs::home_dir() {
            home.join(rest)
        } else {
            PathBuf::from(path)
        }
    } else if path == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(path))
    } else {
        PathBuf::from(path)
    };
    expanded
}

fn strip_prefix_win(p: &str) -> Option<&str> {
    p.strip_prefix("~\\")
}

/// 归一化显示路径：本机主目录显示成 ~
fn display_path(p: &Path) -> String {
    let raw = p.to_string_lossy().to_string();
    if let Some(home) = dirs::home_dir() {
        let home_s = home.to_string_lossy().to_string();
        if let Some(rest) = raw.strip_prefix(&home_s) {
            let rest = rest.trim_start_matches(['/', '\\']);
            return if rest.is_empty() { "~".into() } else { format!("~/{}", rest.replace('\\', "/")) };
        }
    }
    raw.replace('\\', "/")
}

fn human_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "K", "M", "G", "T"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{}B", bytes) } else if v >= 100.0 { format!("{:.0}{}", v, UNITS[i]) } else { format!("{:.1}{}", v, UNITS[i]) }
}

fn format_modified(secs: u64) -> String {
    DateTime::from_timestamp(secs as i64, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "—".into())
}

/// 返回主目录显示路径
pub fn home() -> String {
    display_path(&dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")))
}

/// 列出本地目录
pub fn list(path: &str) -> Result<Vec<RemoteFileEntry>> {
    let p = expand(path);
    let rd = fs::read_dir(&p).with_context(|| format!("读取本地目录失败: {}", p.display()))?;
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        let is_dir = meta.is_dir();
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(RemoteFileEntry {
            modified: format_modified(modified),
            name,
            size: if is_dir { "—".into() } else { human_size(meta.len()) },
            kind: if is_dir { "dir".into() } else { "file".into() },
            path: entry.path().to_string_lossy().to_string(),
            content: None,
        });
    }
    out.sort_by(|a, b| {
        let ak = if a.kind == "dir" { 0 } else { 1 };
        let bk = if b.kind == "dir" { 0 } else { 1 };
        ak.cmp(&bk).then_with(|| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()))
    });
    Ok(out)
}

fn looks_like_text(path: &Path, data: &[u8]) -> bool {
    let text_ext = [
        "txt", "md", "rs", "js", "ts", "tsx", "jsx", "json", "yaml", "yml", "toml", "ini",
        "conf", "cfg", "sh", "bash", "py", "go", "java", "c", "h", "cpp", "hpp", "css",
        "html", "xml", "sql", "log", "csv", "env", "gitignore", "properties", "lock",
    ];
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if text_ext.contains(&ext.as_str()) { return true; }
    !data[..data.len().min(8192)].contains(&0u8)
}

/// 读本地文件（base64）
pub fn read(path: &str) -> Result<FileContent> {
    let p = expand(path);
    let data = fs::read(&p).with_context(|| format!("读取本地文件失败: {}", p.display()))?;
    Ok(FileContent {
        path: p.to_string_lossy().to_string(),
        content_base64: B64.encode(&data),
        is_text: looks_like_text(&p, &data),
        size: data.len() as u64,
    })
}

/// 写本地文件（base64）
pub fn write(path: &str, data_b64: &str) -> Result<u64> {
    let p = expand(path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).with_context(|| format!("创建目录失败: {}", parent.display()))?;
    }
    let bytes = B64.decode(data_b64).map_err(|e| anyhow::anyhow!("base64 解码失败: {}", e))?;
    let len = bytes.len() as u64;
    let mut f = fs::File::create(&p).with_context(|| format!("创建本地文件失败: {}", p.display()))?;
    f.write_all(&bytes).with_context(|| format!("写入本地文件失败: {}", p.display()))?;
    Ok(len)
}

pub fn rename(from: &str, to: &str) -> Result<()> {
    let (a, b) = (expand(from), expand(to));
    fs::rename(&a, &b).with_context(|| format!("重命名失败: {} → {}", a.display(), b.display()))
}

pub fn remove(path: &str, is_dir: bool) -> Result<()> {
    let p = expand(path);
    if is_dir {
        fs::remove_dir_all(&p)
    } else {
        fs::remove_file(&p)
    }
    .with_context(|| format!("删除失败: {}", p.display()))
}

pub fn create(path: &str, is_dir: bool) -> Result<()> {
    let p = expand(path);
    if is_dir {
        fs::create_dir_all(&p).with_context(|| format!("新建目录失败: {}", p.display()))
    } else {
        if let Some(parent) = p.parent() { fs::create_dir_all(parent)?; }
        match fs::File::create(&p) {
            Ok(_) => Ok(()),
            Err(e) => bail!("新建文件失败: {}: {}", p.display(), e),
        }
    }
}
