// 在 Windows 上隐藏附带的控制台窗口（debug 与 release 都隐藏），DO NOT REMOVE!!
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
  mssh_lib::run();
}
