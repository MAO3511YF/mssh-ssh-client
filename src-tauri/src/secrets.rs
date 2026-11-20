//! 连接密码的加密存储。
//!
//! 背景：前端原先把整份 SessionConfig（含明文 password）写进 WebView2 的
//! localStorage，落到 `%LOCALAPPDATA%\<identifier>\EBWebView\...\leveldb`，
//! 任何本机进程都能直接读到明文。
//!
//! 现在密码不再进入前端持久化：前端保存连接时调用 secret_set，把密码交给这里；
//! 连接时若 config.password 为空，commands.rs 再从本模块取回并解密。
//!
//! Windows 上用 DPAPI（CryptProtectData）加密，密文与当前用户账户绑定，
//! 拷到别的机器或别的用户下都无法解密。非 Windows 平台（仅开发用）没有
//! 加密后端，secret_set 直接报错，不会静默退化成明文/base64 落盘。
//!
//! ## 凭据与连接绑定（安全要点）
//!
//! 每条凭据同时保存保存时的 host / port / username。`ssh_connect` 取回密码时
//! 会用这份绑定校验前端传入的连接参数，不一致就拒绝连接。这样即便渲染层
//! 被注入脚本，也无法把「某连接的已保存密码」送到攻击者指定的主机：要改
//! 绑定必须重新调用 secret_set 并提供明文密码。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::Mutex;

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// 凭据库文件：%APPDATA%\com.mssh.desktop\secrets.dat（非 Windows 为 ~/.config/...）
fn store_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.mssh.desktop").join("secrets.dat")
}

/// 保存密码时一并记录的连接绑定。host 为空表示旧格式（无法校验，需重新输入密码）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBinding {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
}

impl SecretBinding {
    fn unbound() -> Self {
        Self { host: String::new(), port: 0, username: String::new() }
    }
    /// 旧格式（只有密文、没有绑定）返回 false。
    pub fn is_bound(&self) -> bool {
        !self.host.trim().is_empty()
    }
}

/// 落盘的一条记录：密文 + 绑定。
#[derive(Clone, Serialize, Deserialize)]
struct StoredSecret {
    #[serde(default)]
    cipher: String,
    #[serde(flatten)]
    binding: SecretBinding,
}

/// 兼容旧版本 secrets.dat：值只是 base64 密文字符串，没有绑定信息。
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum DiskEntry {
    Bound(StoredSecret),
    Legacy(String),
}

/// 解密后的凭据。密码用 Zeroizing 承载，离开作用域时自动清零堆内存。
pub struct Credential {
    pub password: Zeroizing<String>,
    pub binding: SecretBinding,
}

/// 内存缓存：id -> 记录。启动时懒加载，写入后立即落盘。
static STORE: LazyLock<Mutex<HashMap<String, StoredSecret>>> =
    LazyLock::new(|| Mutex::new(load_from_disk()));

fn load_from_disk() -> HashMap<String, StoredSecret> {
    let path = store_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let disk: HashMap<String, DiskEntry> = serde_json::from_str(&raw).unwrap_or_default();
    disk.into_iter()
        .map(|(id, entry)| {
            let stored = match entry {
                DiskEntry::Bound(s) => s,
                // 旧格式无主机绑定：读出来但标记为未绑定，连接时要求重新输入密码。
                DiskEntry::Legacy(cipher) => StoredSecret { cipher, binding: SecretBinding::unbound() },
            };
            (id, stored)
        })
        .collect()
}

fn flush(map: &HashMap<String, StoredSecret>) -> Result<()> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(map)?;
    // 先写临时文件再原子替换，避免写一半断电把凭据库写坏
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body.as_bytes())?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn lock_store() -> Result<std::sync::MutexGuard<'static, HashMap<String, StoredSecret>>> {
    STORE.lock().map_err(|_| anyhow!("凭据库已损坏，请删除 secrets.dat 后重试"))
}

#[cfg(windows)]
fn ensure_encryption_available() -> Result<()> { Ok(()) }

#[cfg(not(windows))]
fn ensure_encryption_available() -> Result<()> {
    bail!("当前平台未实现加密凭据存储，未保存密码（请改用密钥认证或 Windows 版本）")
}

/// 保存/更新某个连接的密码及其连接绑定。
///
/// 调用方必须同时提供 host/port/username：绑定随密码一起加密保存，
/// 后续取回时以这份绑定为准，前端无法单独改写。
pub fn set(id: &str, password: &str, binding: SecretBinding) -> Result<()> {
    if id.trim().is_empty() {
        bail!("连接 id 为空，无法保存密码");
    }
    if !binding.is_bound() {
        bail!("连接主机为空，无法保存带主机绑定的密码");
    }
    // 非 Windows 构建没有系统级加密后端，绝不静默退化成明文/base64 落盘
    ensure_encryption_available()?;
    let enc = protect(password.as_bytes())?;
    let mut map = lock_store()?;
    map.insert(
        id.to_string(),
        StoredSecret { cipher: B64.encode(enc), binding },
    );
    flush(&map)
}

/// 取回某个连接的密码及其绑定（不存在返回 None）。
pub fn get(id: &str) -> Result<Option<Credential>> {
    let raw = {
        let map = lock_store()?;
        map.get(id).cloned()
    };
    let Some(stored) = raw else { return Ok(None) };
    let enc = B64
        .decode(stored.cipher.as_bytes())
        .map_err(|e| anyhow!("凭据库内容损坏: {e}"))?;
    let plain = unprotect(&enc)?;
    let text = String::from_utf8(plain).map_err(|e| anyhow!("凭据解密结果不是合法文本: {e}"))?;
    Ok(Some(Credential {
        password: Zeroizing::new(text),
        binding: stored.binding,
    }))
}

/// 删除某个连接的密码（连接被删除或改用其它认证方式时调用）
pub fn remove(id: &str) -> Result<()> {
    let mut map = lock_store()?;
    if map.remove(id).is_some() {
        flush(&map)?;
    }
    Ok(())
}

/// 是否存在某个连接「可用」的密码（带主机绑定，且不触发解密）。
/// 旧格式的无绑定条目返回 false，避免 UI 提示「留空沿用」却在连接时被拒绝。
pub fn has(id: &str) -> bool {
    lock_store()
        .map(|m| m.get(id).is_some_and(|s| s.binding.is_bound()))
        .unwrap_or(false)
}

// ===== Windows：DPAPI =====

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CryptProtectData,
    };

    // CRYPTPROTECT_UI_FORBIDDEN：禁止弹任何 UI（后台线程没有窗口，弹窗会失败）
    const UI_FORBIDDEN: u32 = 0x1;

    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let ok = CryptProtectData(
            &mut input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            bail!("DPAPI 加密失败: {}", std::io::Error::last_os_error());
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Ok(out)
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CryptUnprotectData,
    };

    const UI_FORBIDDEN: u32 = 0x1;

    unsafe {
        let mut input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let mut descr: *mut u16 = std::ptr::null_mut();
        let ok = CryptUnprotectData(
            &mut input,
            &mut descr,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 {
            bail!(
                "DPAPI 解密失败（凭据可能来自其他用户或其他机器）: {}",
                std::io::Error::last_os_error()
            );
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        if !descr.is_null() {
            LocalFree(descr as *mut core::ffi::c_void);
        }
        Ok(out)
    }
}

// ===== 非 Windows：开发环境退化为不加密（set 已被 ensure_encryption_available 拦住） =====

#[cfg(not(windows))]
fn protect(data: &[u8]) -> Result<Vec<u8>> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    Ok(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_protect() {
        let plain = b"p@ssw0rd-\xe4\xb8\xad\xe6\x96\x87";
        let enc = protect(plain).unwrap();
        assert_eq!(unprotect(&enc).unwrap(), plain.to_vec());
    }

    #[test]
    fn base64_is_not_plaintext_in_store_format() {
        // 存储层只保存 base64，不应出现原文
        let enc = protect(b"secret-value").unwrap();
        let b64 = B64.encode(enc);
        assert!(!b64.contains("secret-value"));
    }

    #[test]
    fn stored_secret_roundtrips_binding() {
        let stored = StoredSecret {
            cipher: "Y2lwaGVy".into(),
            binding: SecretBinding {
                host: "10.0.0.8".into(),
                port: 2222,
                username: "deploy".into(),
            },
        };
        let json = serde_json::to_string(&stored).unwrap();
        let back: StoredSecret = serde_json::from_str(&json).unwrap();
        assert_eq!(back.binding, stored.binding);
        assert_eq!(back.cipher, stored.cipher);
    }

    #[test]
    fn legacy_string_entry_loads_as_unbound() {
        let raw = r#"{"old-connect":"YmFzZTY0"}"#;
        let disk: HashMap<String, DiskEntry> = serde_json::from_str(raw).unwrap();
        assert!(matches!(disk.get("old-connect"), Some(DiskEntry::Legacy(_))));
        let bound = SecretBinding {
            host: "h".into(),
            port: 22,
            username: "u".into(),
        };
        assert!(bound.is_bound());
        assert!(!SecretBinding::unbound().is_bound());
    }
}
