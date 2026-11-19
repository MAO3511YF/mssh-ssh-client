import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Copy, Minus, Settings2, Square, X } from "lucide-react";
import { useAppStore } from "./store";
import { loadTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceView } from "./components/WorkspaceView";
import { MonitorPanel } from "./components/MonitorPanel";
import { GlobalCommandBar } from "./components/GlobalCommandBar";
import { SessionDialog } from "./components/SessionDialog";
import { FolderDialog } from "./components/FolderDialog";
import { WorkspaceToolsDialog, type ToolsTab } from "./components/WorkspaceToolsDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toast } from "./components/Toast";
import { EmptyState } from "./components/EmptyState";
import { CloseDialog } from "./components/CloseDialog";
import { WindowOverlay } from "./components/WindowOverlay";
import { DeleteFolderDialog, DeleteSessionDialog, RenameDialog } from "./components/LibraryDialogs";
import {
  hideWindow, isTauri, minimizeWindow, quitWindow, toggleMaximize,
  type WindowState,
} from "./windowControl";

type DialogState =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; id: string }
  | { kind: "renameSession"; id: string }
  | { kind: "deleteSession"; id: string }
  | { kind: "folder" }
  | { kind: "renameFolder"; name: string }
  | { kind: "deleteFolder"; name: string }
  | { kind: "tools"; tab: ToolsTab }
  | { kind: "settings" }
  | { kind: "close" };

/**
 * 整条分隔条都是折叠开关：按下后位移不超过 3px 视为点击（折叠/展开），超过则交给拖拽调整宽度。
 * 不用 DOM click —— 分隔条内部会在 pointerup 时 preventDefault，click 事件会被吞掉。
 */
function useRailToggle(side: "left" | "right", toggle: () => void) {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    const el = document.querySelector<HTMLElement>(`.side-rail.${side}`);
    if (!el) return;
    let start: { x: number; y: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => { start = { x: e.clientX, y: e.clientY, moved: false }; };
    const onMove = (e: PointerEvent) => {
      if (start && !start.moved && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3) start.moved = true;
    };
    const onUp = () => {
      const wasClick = start !== null && !start.moved;
      start = null;
      if (wasClick) toggleRef.current();
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
  }, [side]);
}

/**
 * 6px 分隔条里的折叠箭头。lucide 的 9~10px 图标塞不进 6px，会两侧溢出盖到终端上，
 * 所以用自绘的 4×8 实心三角（像素对齐，1x 下也不糊），颜色取主题品红。
 */
function RailChevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg className="rail-chev" width="4" height="8" viewBox="0 0 4 8" aria-hidden="true">
      <path d={dir === "left" ? "M4 0 0 4 4 8Z" : "M0 0 4 4 0 8Z"} fill="currentColor" />
    </svg>
  );
}

export default function App() {
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [themeId, setThemeId] = useState(() => loadTheme().id);
  const [windowState, setWindowState] = useState<WindowState>("normal");
  const [maximized, setMaximized] = useState(false);
  const preferences = useAppStore((s) => s.preferences);
  const layout = useAppStore((s) => s.layout);
  const setLeftCollapsed = useAppStore((s) => s.setLeftCollapsed);
  const setRightCollapsed = useAppStore((s) => s.setRightCollapsed);
  const toggleLeft = useAppStore((s) => s.toggleLeft);
  const toggleRight = useAppStore((s) => s.toggleRight);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);

  const leftRef = useRef<import("react-resizable-panels").ImperativePanelHandle>(null);
  const rightRef = useRef<import("react-resizable-panels").ImperativePanelHandle>(null);

  // 折叠只由一个方向驱动：点击 → 面板实例；面板尺寸变化 → 回写 store（见 onResize）
  const lastSize = useRef({ left: 20, right: 22 });
  const flipLeft = () => {
    const p = leftRef.current;
    if (!p) { toggleLeft(); return; }
    if (p.isCollapsed()) p.resize(lastSize.current.left); else p.collapse();
  };
  const flipRight = () => {
    const p = rightRef.current;
    if (!p) { toggleRight(); return; }
    if (p.isCollapsed()) p.resize(lastSize.current.right); else p.collapse();
  };
  useRailToggle("left", flipLeft);
  useRailToggle("right", flipRight);

  const closeDialog = () => setDialog({ kind: "none" });
  const activeWs = workspaces.find((w) => w.runtimeId === activeId) ?? null;

  // 窗口控制：Tauri 走原生，浏览器预览走可见模拟
  const doMinimize = () => { void minimizeWindow().then((ok) => { if (!ok) setWindowState("minimized"); }); };
  const doMaximize = () => {
    const wasMax = maximized;
    void toggleMaximize().then(() => {
      setMaximized(isTauri() ? !wasMax : Boolean(document.fullscreenElement));
    });
  };
  // 浏览器预览下全屏状态变化时同步按钮图标
  useEffect(() => {
    const onChange = () => setMaximized(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const doQuit = () => { setDialog({ kind: "none" }); void quitWindow().then((ok) => { if (!ok) setWindowState("quit"); }); };
  const doHide = () => { setDialog({ kind: "none" }); void hideWindow().then((ok) => { if (!ok) setWindowState("hidden"); }); };
  const onWindowClose = () => {
    if (preferences.closeAction === "quit") doQuit();
    else if (preferences.closeAction === "tray") doHide();
    else setDialog({ kind: "close" });
  };
  const restoreWindow = () => setWindowState("normal");

  // 启动时恢复上次的折叠状态（仅一次；面板实例有时要等一帧才就绪）
  useEffect(() => {
    const restore = () => {
      const l = useAppStore.getState().layout;
      if (l.leftCollapsed) leftRef.current?.collapse();
      if (l.rightCollapsed) rightRef.current?.collapse();
    };
    restore();
    const t = window.setTimeout(restore, 60);
    return () => window.clearTimeout(t);
  }, []);

  // 快捷键 Ctrl+N 新建连接
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        // 已有弹窗（例如工作台里正在写命令）时不再叠加「新建连接」
        if (document.querySelector(".modal-overlay")) return;
        e.preventDefault();
        setDialog({ kind: "new" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const editingSession = dialog.kind === "edit" ? sessions.find((s) => s.id === dialog.id) : undefined;
  const renameSessionTarget = dialog.kind === "renameSession" ? sessions.find((s) => s.id === dialog.id) : undefined;
  const deleteSessionTarget = dialog.kind === "deleteSession" ? sessions.find((s) => s.id === dialog.id) : undefined;

  return (
    <div
      className="app"
      // 全局禁用 webview 原生右键菜单（含"打印 / 检查"等），侧栏自定义菜单照常工作
      onContextMenu={(e) => e.preventDefault()}
      style={{
        "--rail-tint": `${Math.max(0, Math.min(100, preferences.railTint ?? 20))}%`,
        "--rail-tint-hover": `${Math.max(0, Math.min(100, (preferences.railTint ?? 20) + 12))}%`,
        "--rail-w": `${preferences.railWidth ?? 6}px`,
      } as CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          {preferences.brandVisible && (
            <span
              className="brand-name"
              style={{
                fontFamily: preferences.brandFont || undefined,
                fontSize: `${preferences.brandFontSize}px`,
                fontWeight: preferences.brandWeight,
                color: preferences.brandColor || undefined,
                letterSpacing: `${preferences.brandSpacing}px`,
              }}
            >{preferences.brandText || "MSSH"}</span>
          )}
        </div>
        <div className="topbar-right">
          <button className="icon-btn" onClick={() => setDialog({ kind: "settings" })} title="设置"><Settings2 size={16} /></button>
          <div className="window-controls">
            <button className="win-btn" onClick={doMinimize} title="最小化" aria-label="最小化"><Minus size={15} /></button>
            <button className="win-btn" onClick={doMaximize} title={maximized ? "还原窗口" : "最大化"} aria-label="最大化或还原">
              {maximized ? <Copy size={12} /> : <Square size={11} />}
            </button>
            <button className="win-btn close" onClick={onWindowClose} title="关闭" aria-label="关闭"><X size={15} /></button>
          </div>
        </div>
      </header>

      <div className="app-body">
        <PanelGroup direction="horizontal" autoSaveId="mssh.layout.v2">
          <Panel
            ref={leftRef}
            order={1}
            defaultSize={20}
            minSize={14}
            maxSize={34}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              if (size >= 1) lastSize.current.left = size;
              setLeftCollapsed(size < 1);
            }}
            className="pg-side"
          >
            <Sidebar
              onNew={() => setDialog({ kind: "new" })}
              onFolder={() => setDialog({ kind: "folder" })}
              onRepo={() => setDialog({ kind: "tools", tab: "commands" })}
              onEditor={() => setDialog({ kind: "tools", tab: "editor" })}
              onEditSession={(id) => setDialog({ kind: "edit", id })}
              onRenameSession={(id) => setDialog({ kind: "renameSession", id })}
              onDeleteSession={(id) => setDialog({ kind: "deleteSession", id })}
              onRenameFolder={(name) => setDialog({ kind: "renameFolder", name })}
              onDeleteFolder={(name) => setDialog({ kind: "deleteFolder", name })}
            />
          </Panel>
          <PanelResizeHandle className={`resize-handle vertical side-rail left ${layout.leftCollapsed ? "collapsed" : ""}`}>
            <div className="resize-line" />
            {preferences.railChevron && <RailChevron dir={layout.leftCollapsed ? "right" : "left"} />}
          </PanelResizeHandle>

          <Panel order={2} defaultSize={58} minSize={30} className="pg-main">
            <main className="main-area">
              {workspaces.length === 0 ? (
                <EmptyState onNew={() => setDialog({ kind: "new" })} />
              ) : (
                <WorkspaceView />
              )}
            </main>
            <GlobalCommandBar />
          </Panel>

          <PanelResizeHandle className={`resize-handle vertical side-rail right ${layout.rightCollapsed ? "collapsed" : ""}`}>
            <div className="resize-line" />
            {preferences.railChevron && <RailChevron dir={layout.rightCollapsed ? "left" : "right"} />}
          </PanelResizeHandle>
          <Panel
            ref={rightRef}
            order={3}
            defaultSize={22}
            minSize={16}
            maxSize={34}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              if (size >= 1) lastSize.current.right = size;
              setRightCollapsed(size < 1);
            }}
            className="pg-monitor"
          >
            <MonitorPanel
              sessionId={activeWs?.runtimeId ?? null}
              host={activeWs?.session.host}
              status={activeWs?.status}
              statusMessage={activeWs?.statusMessage}
            />
          </Panel>
        </PanelGroup>
      </div>

      {dialog.kind === "new" && <SessionDialog onClose={closeDialog} />}
      {dialog.kind === "edit" && editingSession && <SessionDialog editing={editingSession} onClose={closeDialog} />}
      {dialog.kind === "renameSession" && renameSessionTarget && (
        <RenameDialog
          title="重命名连接"
          label="连接名称"
          initial={renameSessionTarget.name}
          entityId={renameSessionTarget.id}
          target="session"
          onClose={closeDialog}
        />
      )}
      {dialog.kind === "deleteSession" && deleteSessionTarget && (
        <DeleteSessionDialog session={deleteSessionTarget} onClose={closeDialog} />
      )}
      {dialog.kind === "folder" && <FolderDialog onClose={closeDialog} />}
      {dialog.kind === "renameFolder" && (
        <RenameDialog
          title="重命名工作区"
          label="工作区名称"
          initial={dialog.name}
          target="folder"
          onClose={closeDialog}
        />
      )}
      {dialog.kind === "deleteFolder" && <DeleteFolderDialog name={dialog.name} onClose={closeDialog} />}
      {dialog.kind === "tools" && <WorkspaceToolsDialog initialTab={dialog.tab} onClose={closeDialog} />}
      {dialog.kind === "settings" && <SettingsDialog currentId={themeId} onApply={setThemeId} onClose={closeDialog} />}
      {dialog.kind === "close" && <CloseDialog onClose={closeDialog} onQuit={doQuit} onHide={doHide} />}
      {windowState !== "normal" && <WindowOverlay state={windowState} onRestore={restoreWindow} />}
      <Toast />
    </div>
  );
}
