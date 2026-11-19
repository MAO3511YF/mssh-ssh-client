pub mod commands;
pub mod fs_local;
pub mod model;
pub mod monitor;
pub mod sftp;
pub mod ssh;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 前端标题栏没有 data-tauri-drag-region（前端代码保持不变）。
/// 由后端注入脚本给 .topbar 打上拖拽标记，这样无边框窗口仍可拖动，
/// 而按钮、输入框等子元素保持可交互。
const DRAG_REGION_SCRIPT: &str = r#"
(function () {
  function mark() {
    var bar = document.querySelector('.topbar');
    if (!bar) return false;
    bar.setAttribute('data-tauri-drag-region', '');
    var brand = bar.querySelector('.brand');
    if (brand) brand.setAttribute('data-tauri-drag-region', '');
    return true;
  }
  function observe() {
    if (mark()) return;
    var obs = new MutationObserver(function () { if (mark()) obs.disconnect(); });
    obs.observe(document.documentElement || document, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::sftp_list,
            commands::sftp_read,
            commands::sftp_write,
            commands::sftp_rename,
            commands::sftp_remove,
            commands::sftp_create,
            commands::monitor_collect,
            commands::fs_home,
            commands::fs_list,
            commands::fs_read,
            commands::fs_write,
            commands::fs_rename,
            commands::fs_remove,
            commands::fs_create,
        ])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("MSSH")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .decorations(false)
                .initialization_script(DRAG_REGION_SCRIPT)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
