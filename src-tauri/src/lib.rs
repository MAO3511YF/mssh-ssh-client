pub mod commands;
pub mod fs_local;
pub mod model;
pub mod monitor;
pub mod sftp;
pub mod ssh;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

/// 托盘图标：编译期直接内嵌 PNG，不依赖 default_window_icon()
/// （本项目窗口是运行时创建的、tauri.conf 里 windows 为空，用内嵌字节最稳）。
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// 把主窗口从「隐藏到后台 / 最小化」状态拉回前台。
/// 托盘点击、托盘菜单「显示主窗口」、第二个实例启动都会走这里。
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        // 顺序不能反：隐藏的窗口要先 show 才会响应 unminimize / set_focus
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须是第一个注册的插件。
        // 第二个实例启动时只回调这里（把已有窗口唤到前台），然后自身立刻退出。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
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

            // ---- 系统托盘（右下角）----
            // 前端「隐藏到后台」只是 win.hide()，窗口会从任务栏消失，
            // 必须有托盘图标才能再把它找回来。
            let show_item = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "隐藏到后台", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出 MSSH", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &hide_item, &separator, &quit_item])?;

            let mut tray = TrayIconBuilder::with_id("mssh-tray")
                .tooltip("MSSH - SSH 客户端")
                .menu(&menu)
                // 左键单击直接显示窗口，右键才弹菜单（更符合 Windows 习惯）
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    // 左键单击 / 双击都唤起主窗口
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(tray.app_handle()),
                    _ => {}
                });

            if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_PNG) {
                tray = tray.icon(icon);
            }
            tray.build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
