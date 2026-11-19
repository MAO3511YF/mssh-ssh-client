import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { driver } from "./drivers";
import { useAppStore } from "./store";
import { buildTerminalTheme } from "./theme";

export interface TerminalHandle {
  terminal: Terminal;
  dispose: () => void;
}

export function createTerminal(container: HTMLElement, sessionId: string): TerminalHandle {
  const prefs = useAppStore.getState().preferences;
  const terminal = new Terminal({
    fontFamily: '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
    fontSize: 12.5,
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
    void navigator.clipboard?.readText().then((text) => {
      if (text) driver.write(sessionId, text);
    }).catch(() => { /* clipboard unavailable */ });
  };

  const dataSub = terminal.onData((data) => {
    driver.write(sessionId, data);
  });

  const selectionSub = prefs.terminalCopyOnSelect
    ? terminal.onSelectionChange(() => {
      const text = terminal.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
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
    terminal.options.scrollback = useAppStore.getState().preferences.terminalScrollback;
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
