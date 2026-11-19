/**
 * 窗口控制：Tauri 环境走原生 API；浏览器预览（Mock）下走可见的模拟效果，
 * 方便直接在 localhost 里看到最小化 / 最大化 / 关闭 / 隐藏后台的反馈。
 */

export type WindowState = "normal" | "minimized" | "hidden" | "quit";

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function native(): Promise<import("@tauri-apps/api/window").Window | null> {
  if (!isTauri()) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<boolean> {
  const win = await native();
  if (!win) return false;
  await win.minimize();
  return true;
}

export async function toggleMaximize(): Promise<boolean> {
  const win = await native();
  if (!win) {
    // 浏览器预览：用全屏模拟最大化
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  }
  await win.toggleMaximize();
  return true;
}

export async function hideWindow(): Promise<boolean> {
  const win = await native();
  if (!win) return false;
  await win.hide();
  return true;
}

export async function quitWindow(): Promise<boolean> {
  const win = await native();
  if (!win) return false;
  await win.destroy();
  return true;
}
