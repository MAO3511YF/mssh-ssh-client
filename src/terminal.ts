import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { driver } from "./drivers";
import { useAppStore } from "./store";
import { TERMINAL_FONT_STACK } from "./constants";
import { buildTerminalTheme } from "./theme";
import { clipboardReadText, clipboardWriteText } from "./clipboard";
import { emitRemoteCd } from "./runtime";

export interface TerminalHandle {
  terminal: Terminal;
  dispose: () => void;
}

/**
 * 从一行已敲完的命令里提取 cd 的参数原文（交给文件面板用 SFTP 向服务器求证真实路径）。
 * 支持：cd /abs、cd rel、cd ..、cd ~、cd（回家）、引号包裹、行尾注释。
 * 注意：这里刻意不做任何路径拼接/规范化——相对路径的基准是服务器上的真实 cwd，
 * 前端无法可靠得知，必须交给 SFTP canonicalize，否则会算出 ../../../../ 这种假路径。
 */
function parseCdArg(line: string): string | null {
  const cmd = line.trim();
  // 只认行首的 cd（含 cd 后跟空白），避免把 `echo cd xxx` 之类误判
  const match = cmd.match(/^cd(?:\s+(.*))?$/);
  if (!match) return null;
  let arg = (match[1] ?? "").trim();
  // 行尾注释：# 前是空白
  arg = arg.replace(/\s+#.*$/, "").trim();
  // 去掉成对引号
  if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
    arg = arg.slice(1, -1);
  }
  // cd 无参数 = 回家；cd - 前端无法解析（依赖 shell 的 OLDPWD），跳过
  if (arg === "-") return null;
  return arg || "~";
}

export function createTerminal(container: HTMLElement, sessionId: string): TerminalHandle {
  const prefs = useAppStore.getState().preferences;
  const terminal = new Terminal({
    fontFamily: prefs.terminalFont || TERMINAL_FONT_STACK,
    fontSize: prefs.terminalFontSize || 12.5,
    lineHeight: 1.45,
    letterSpacing: 0.3,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: prefs.terminalScrollback,
    theme: buildTerminalTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(container);
  requestAnimationFrame(() => {
    try { fit.fit(); } catch { /* not laid out yet */ }
  });

  const pasteClipboard = () => {
    void clipboardReadText().then((text) => {
      if (text) driver.write(sessionId, text);
    }).catch(() => { /* clipboard unavailable */ });
  };

  // cd 跟随跳转：缓存当前输入行，回车时只把 cd 的参数原文广播给文件面板，
  // 由文件面板用 SFTP canonicalize 向服务器求证真实路径（目录不存在则不跳）。
  //
  // xterm 的 onData 是逐字符的原始按键流，得自己维护行缓冲。关键点是「拿不准就放弃」：
  // 一旦出现方向键/Home/End/Tab/Ctrl+W 等会移动光标或改写整行的按键，本行就不再解析——
  // 否则缓冲与屏幕上的真实命令行不一致，可能把 cd 到一个错误但存在的目录。
  let lineBuf: string[] = [];
  let lineCursor = 0;
  let lineUnknown = false;
  const resetLine = () => { lineBuf = []; lineCursor = 0; lineUnknown = false; };

  const dataSub = terminal.onData((data) => {
    driver.write(sessionId, data);
    if (!useAppStore.getState().preferences.terminalFollowCd) return;
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const text = lineBuf.join("");
        const usable = !lineUnknown;
        resetLine();
        if (!usable) continue;
        const arg = parseCdArg(text);
        if (arg) emitRemoteCd(sessionId, arg);
        continue;
      }
      if (ch === "\x1b") { lineUnknown = true; continue; }        // 方向键/功能键等转义序列
      if (ch === "\x7f" || ch === "\b") {
        if (lineCursor > 0) { lineBuf.splice(lineCursor - 1, 1); lineCursor -= 1; }
        continue;
      }
      if (ch === "\x03" || ch === "\x15") { resetLine(); continue; } // Ctrl+C / Ctrl+U 放弃当前行
      if (ch < " ") { lineUnknown = true; continue; }               // Tab 补全等其余控制字符：不再可信
      lineBuf.splice(lineCursor, 0, ch);
      lineCursor += 1;
    }
  });

  const selectionSub = prefs.terminalCopyOnSelect
    ? terminal.onSelectionChange(() => {
      const text = terminal.getSelection();
      if (text) void clipboardWriteText(text).catch(() => { /* ignore */ });
    })
    : null;

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    const p = useAppStore.getState().preferences;
    if (p.terminalCtrlVPaste && event.type === "keydown" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
      return false;
    }
    return true;
  });

  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 1 && useAppStore.getState().preferences.terminalMiddleClick === "paste") {
      event.preventDefault();
      pasteClipboard();
    }
  };
  const onContextMenu = (event: MouseEvent) => {
    if (!useAppStore.getState().preferences.terminalRightPaste) return;
    event.preventDefault();
    pasteClipboard();
  };
  container.addEventListener("mousedown", onMouseDown);
  container.addEventListener("contextmenu", onContextMenu);

  // 点终端以外的地方（侧栏、分隔条、文件面板…）就清掉残留的选中：选中底色是半透明品红，
  // 拖拽后残留的一条横带很容易被误认为“多出来的分割色块”
  const onDocPointerDown = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (target && container.contains(target)) return;
    if (terminal.hasSelection()) terminal.clearSelection();
  };
  document.addEventListener("pointerdown", onDocPointerDown, true);

  const resizeObserver = new ResizeObserver(() => {
    try { fit.fit(); } catch { /* ignore */ }
    const dims = fit.proposeDimensions();
    if (dims) driver.resize(sessionId, dims.cols, dims.rows);
  });
  resizeObserver.observe(container);

  const onTheme = () => { terminal.options.theme = buildTerminalTheme(); };
  const bellSub = terminal.onBell(() => {
    if (!useAppStore.getState().preferences.terminalBell) return;
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.03, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch { /* audio unavailable */ }
  });
  const onPrefs = () => {
    const p = useAppStore.getState().preferences;
    terminal.options.scrollback = p.terminalScrollback;
    terminal.options.fontFamily = p.terminalFont || TERMINAL_FONT_STACK;
    terminal.options.fontSize = p.terminalFontSize || 12.5;
    // 字号/字体变了，行列数跟着变：必须重新 fit 并把这个尺寸告诉服务器，
    // 否则远端仍按旧列宽排版，长命令会错行（或右侧被裁掉）。
    try {
      fit.fit();
      driver.resize(sessionId, terminal.cols, terminal.rows);
    } catch { /* 未布局完成时忽略 */ }
  };
  window.addEventListener("mssh:themechange", onTheme);
  window.addEventListener("mssh:prefs-changed", onPrefs);

  return {
    terminal,
    dispose: () => {
      dataSub.dispose();
      selectionSub?.dispose();
      bellSub.dispose();
      container.removeEventListener("mousedown", onMouseDown);
      container.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      resizeObserver.disconnect();
      window.removeEventListener("mssh:themechange", onTheme);
      window.removeEventListener("mssh:prefs-changed", onPrefs);
      terminal.dispose();
    },
  };
}
