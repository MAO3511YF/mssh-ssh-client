import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Copy, Minus, PanelRight, PanelRightClose, Settings2, Square, X } from "lucide-react";
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

export default function App() {
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [themeId, setThemeId] = useState(() => loadTheme().id);
  const [windowState, setWindowState] = useState<WindowState>("normal");
  const [maximized, setMaximized] = useState(false);
  const preferences = useAppStore((s) => s.preferences);
  const layout = useAppStore((s) => s.layout);
  const setRightCollapsed = useAppStore((s) => s.setRightCollapsed);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);

  const rightRef = useRef<import("react-resizable-panels").ImperativePanelHandle>(null);

  // 右侧监控面板由顶栏按钮控制：折叠状态由面板实例驱动，尺寸变化再回写 store（见 onResize）
  const lastRightSize = useRef(22);
  const flipRight = () => {
    const p = rightRef.current;
    if (p?.isCollapsed()) p.resize(lastRightSize.current);
    else p?.collapse();
  };

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

  // 启动时恢复右侧面板状态（面板实例有时要等一帧才就绪）
  useEffect(() => {
    const restore = () => {
      if (useAppStore.getState().layout.rightCollapsed) rightRef.current?.collapse();
      else rightRef.current?.resize(lastRightSize.current);
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
          <button
            className={`icon-btn panel-toggle ${layout.rightCollapsed ? "" : "on"}`}
            onClick={flipRight}
            title={layout.rightCollapsed ? "显示监控面板" : "隐藏监控面板"}
            aria-label={layout.rightCollapsed ? "显示监控面板" : "隐藏监控面板"}
            aria-pressed={!layout.rightCollapsed}
          >
            {layout.rightCollapsed ? <PanelRight size={16} /> : <PanelRightClose size={16} />}
          </button>
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
        {/* v4：左侧宽度可拖拽，但保留最小宽度且不可折叠；右侧仍只由顶栏按钮控制 */}
        <PanelGroup direction="horizontal" autoSaveId="mssh.layout.v4">
          <Panel order={1} defaultSize={20} minSize={14} maxSize={38} collapsible={false} className="pg-side">
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

          {/* 左侧唯一的分隔条：拖动只改宽度，最小 14% 保证侧栏永远不会消失 */}
          <PanelResizeHandle className="resize-handle vertical side-handle">
            <div className="resize-line" />
          </PanelResizeHandle>

          <Panel order={2} defaultSize={80} minSize={30} className="pg-main">
            <main className="main-area">
              {workspaces.length === 0 ? (
                <EmptyState onNew={() => setDialog({ kind: "new" })} />
              ) : (
                <WorkspaceView />
              )}
            </main>
            <GlobalCommandBar />
          </Panel>

          {/* 右侧监控面板默认收起，只由顶栏按钮控制，没有可拖拽的收缩条 */}
          <Panel
            ref={rightRef}
            order={3}
            defaultSize={layout.rightCollapsed ? 0 : lastRightSize.current}
            minSize={16}
            maxSize={34}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              if (size >= 1) lastRightSize.current = size;
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
