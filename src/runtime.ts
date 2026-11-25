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

/**
 * 终端 cd 跟随跳转的轻量事件总线。
 * 终端解析到用户敲下的 cd 后，只广播「cd 的参数原文」（如 /var、..、~/x、foo），
 * 由文件面板以服务器求证（SFTP canonicalize）解析成真实绝对路径后再跳转。
 * 这样终端端不做任何路径字符串模拟，避免出现 ../../../../ 这类累加出来的假路径，
 * 且 cd 实际失败（目录不存在）时服务器会报错，文件面板便不会误跳。
 * 用模块级 Map 而不是 zustand，是因为它属于会话运行时状态、不需要落盘或触发全局重渲染。
 */
type CdListener = (path: string) => void;
const cdListeners = new Map<string, Set<CdListener>>();

export function onRemoteCd(runtimeId: string, fn: CdListener): () => void {
  let set = cdListeners.get(runtimeId);
  if (!set) { set = new Set(); cdListeners.set(runtimeId, set); }
  set.add(fn);
  return () => { set?.delete(fn); if (set?.size === 0) cdListeners.delete(runtimeId); };
}

export function emitRemoteCd(runtimeId: string, path: string) {
  cdListeners.get(runtimeId)?.forEach((fn) => fn(path));
}

/**
 * 记录每个会话在服务器上的真实当前目录（绝对路径），由文件面板 canonicalize 成功后写入。
 * 它同时是相对 cd（如 cd foo / cd ..）的解析基准。
 */
export const sessionCwd = new Map<string, string>();

/**
 * 「在编辑器里打开这个远程文件」的一次性请求。
 *
 * 文件面板发起请求时，编辑器窗口还没挂载（要先由 App 切出工作台），
 * 所以先把请求放在这里，等编辑器挂载后再取走——用事件直接传参会丢。
 */
export interface EditorOpenRequest {
  runtimeId: string;
  path: string;
}

let pendingEditorOpen: EditorOpenRequest | null = null;

/** 通知 App 切到「工作台 → 编辑器」页 */
export const OPEN_EDITOR_EVENT = "mssh:open-editor";

export function requestEditorOpen(req: EditorOpenRequest) {
  pendingEditorOpen = req;
  window.dispatchEvent(new CustomEvent(OPEN_EDITOR_EVENT));
}

/** 取走待打开请求（只能消费一次） */
export function takeEditorOpen(): EditorOpenRequest | null {
  const req = pendingEditorOpen;
  pendingEditorOpen = null;
  return req;
}
