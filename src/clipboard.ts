/**
 * 剪贴板统一封装。
 *
 * Tauri 环境走官方 clipboard-manager 插件（Rust 层直接读写系统剪贴板），
 * 不会触发 WebView2 的「tauri.localhost 想要查看剪贴板」权限弹窗；
 * 浏览器预览（mock 模式）回退到 navigator.clipboard。
 */
import { isTauri } from "./windowControl";

async function nativeClipboard() {
  const { readText, writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  return { readText, writeText };
}

export async function clipboardReadText(): Promise<string> {
  if (isTauri()) {
    const { readText } = await nativeClipboard();
    return readText();
  }
  return navigator.clipboard.readText();
}

export async function clipboardWriteText(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await nativeClipboard();
    return writeText(text);
  }
  return navigator.clipboard.writeText(text);
}
