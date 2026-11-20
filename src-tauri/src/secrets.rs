//! 连接密码的加密存储。
//!
//! 背景：前端原先把整份 SessionConfig（含明文 password）写进 WebView2 的
//! localStorage，落到 `%LOCALAPPDATA%\<identifier>\EBWebView\...\leveldb`，
//! 任何本机进程都能直接读到明文。
//!
//! 现在密码不再进入前端持久化：前端保存连接时调用 secret_set，把密码交给这里；
//! 连接时若 config.password 为空，ssh.rs 再从本模块取回并解密。
//!
//! Windows 上用 DPAPI（CryptProtectData）加密，密文与当前用户账户绑定，
//! 拷到别的机器或别的用户下都无法解密。非 Windows 平台（仅开发用）退化为
//! base64 存储，并在日志语义上视为不加密。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::Mutex;

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

/// 凭据库文件：%APPDATA%\com.mssh.desktop\secrets.dat（非 Windows 为 ~/.config/...）
fn store_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.mssh.desktop").join("secrets.dat")
}

/// 内存缓存：id -> base64(密文)。启动时懒加载，写入后立即落盘。
static STORE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(load_from_disk()));

fn load_from_disk() -> HashMap<String, String> {
    let path = store_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn flush(map: &HashMap<String, String>) -> Result<()> {
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

fn lock_store() -> Result<std::sync::MutexGuard<'static, HashMap<String, String>>> {
    STORE.lock().map_err(|_| anyhow!("凭据库已损坏，请删除 secrets.dat 后重试"))
}

/// 保存/更新某个连接的密码
pub fn set(id: &str, password: &str) -> Result<()> {
    if id.trim().is_empty() {
        bail!("连接 id 为空，无法保存密码");
    }
    let enc = protect(password.as_bytes())?;
    let mut map = lock_store()?;
    map.insert(id.to_string(), B64.encode(enc));
    flush(&map)
}

/// 取回某个连接的密码（不存在返回 None）
pub fn get(id: &str) -> Result<Option<String>> {
    let raw = {
        let map = lock_store()?;
        map.get(id).cloned()
    };
    let Some(b64) = raw else { return Ok(None) };
    let enc = B64
        .decode(b64.as_bytes())
        .map_err(|e| anyhow!("凭据库内容损坏: {e}"))?;
    let plain = unprotect(&enc)?;
    let text = String::from_utf8(plain).map_err(|e| anyhow!("凭据解密结果不是合法文本: {e}"))?;
    Ok(Some(text))
}

/// 删除某个连接的密码（连接被删除或改用其它认证方式时调用）
pub fn remove(id: &str) -> Result<()> {
    let mut map = lock_store()?;
    if map.remove(id).is_some() {
        flush(&map)?;
    }
    Ok(())
}

/// 是否存在某个连接的密码（不触发解密）
pub fn has(id: &str) -> bool {
    lock_store().map(|m| m.contains_key(id)).unwrap_or(false)
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

// ===== 非 Windows：开发环境退化为不加密 =====

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
}
