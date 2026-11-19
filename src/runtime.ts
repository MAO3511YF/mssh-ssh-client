import type { Terminal } from "@xterm/xterm";
import type { Monitor } from "./monitor";

/** 非序列化的运行时实例registry，与 zustand store 分离。 */
export const terminalRegistry = new Map<string, Terminal>();
export const monitorRegistry = new Map<string, Monitor>();

/**
 * 会话输出流水：标签在窗格间移动、分屏复制都会重建 xterm 实例，
 * 挂载时回放这里的内容，避免切一次窗格终端就变空白。
 */
export const sessionLog = new Map<string, string>();
const LOG_LIMIT = 60000;

export function appendSessionLog(id: string, data: string) {
  const next = (sessionLog.get(id) ?? "") + data;
  sessionLog.set(id, next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next);
}
