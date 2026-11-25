import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Copy, Minus, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Settings2, Square, X } from "lucide-react";
import { useAppStore, shutdownAllSessions } from "./store";
import { matchShortcut } from "./shortcuts";
import { OPEN_EDITOR_EVENT } from "./runtime";
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
import { HostKeyDialog } from "./components/HostKeyDialog";
import {
  hideWindow, isTauri, minimizeWindow, onNativeCloseRequested, quitWindow, toggleMaximize,
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
  const setLeftCollapsed = useAppStore((s) => s.setLeftCollapsed);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeId = useAppStore((s) => s.activeId);
  const sessions = useAppStore((s) => s.sessions);
  // 有未确认的主机指纹时才挂载弹窗：弹窗用 useModal 管理聚焦/ESC，必须在挂载时就有内容
  const hostKeyPrompt = useAppStore((s) => s.hostKeyPrompt);

  const rightRef = useRef<import("react-resizable-panels").ImperativePanelHandle>(null);
  const leftRef = useRef<import("react-resizable-panels").ImperativePanelHandle>(null);

  // 右侧监控面板由顶栏按钮控制：折叠状态由面板实例驱动，尺寸变化再回写 store（见 onResize）
  const lastRightSize = useRef(22);
  const flipRight = () => {
    const p = rightRef.current;
    if (p?.isCollapsed()) p.resize(lastRightSize.current);
    else p?.collapse();
  };

  // 左侧栏同监控面板：顶栏按钮控制折叠，尺寸变化回写 store
  const lastLeftSize = useRef(20);
  const flipLeft = () => {
    const p = leftRef.current;
    if (p?.isCollapsed()) p.resize(lastLeftSize.current);
    else p?.collapse();
  };

  const closeDialog = () => setDialog({ kind: "none" });
  const activeWs = workspaces.find((w) => w.runtimeId === activeId) ?? null;

  // 文件面板发起「在编辑器打开」：切到工作台的编辑器页。
  // 要打开的文件本身由运行时里的待办请求带过去（编辑器挂载后才取得到）。
  useEffect(() => {
    const onOpen = () => setDialog({ kind: "tools", tab: "editor" });
    window.addEventListener(OPEN_EDITOR_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EDITOR_EVENT, onOpen);
  }, []);

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
  // 退出前先优雅断开所有会话：置 "正在退出" 标记（屏蔽重连提示），再逐个走 SSH 断开，
  // 避免服务器侧留下半开连接、也避免退出瞬间闪一条"正在重新连接"。
  const doQuit = () => {
    setDialog({ kind: "none" });
    void shutdownAllSessions()
      .then(() => quitWindow())
      .then((ok) => { if (!ok) setWindowState("quit"); });
  };
  const doHide = () => { setDialog({ kind: "none" }); void hideWindow().then((ok) => { if (!ok) setWindowState("hidden"); }); };
  const onWindowClose = () => {
    if (preferences.closeAction === "quit") doQuit();
    else if (preferences.closeAction === "tray") doHide();
    else setDialog({ kind: "close" });
  };
  // 系统级关闭（Alt+F4 / 任务栏关闭）也走同一套流程，避免直接销毁窗口导致会话被硬掐
  const windowCloseRef = useRef(onWindowClose);
  windowCloseRef.current = onWindowClose;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onNativeCloseRequested(() => windowCloseRef.current()).then((fn) => {
      if (disposed) fn(); else unlisten = fn;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const restoreWindow = () => setWindowState("normal");

  // 启动时恢复左右面板状态（面板实例有时要等一帧才就绪）
  useEffect(() => {
    const restore = () => {
      if (useAppStore.getState().layout.rightCollapsed) rightRef.current?.collapse();
      else rightRef.current?.resize(lastRightSize.current);
      if (useAppStore.getState().layout.leftCollapsed) leftRef.current?.collapse();
      else leftRef.current?.resize(lastLeftSize.current);
    };
    restore();
    const t = window.setTimeout(restore, 60);
    return () => window.clearTimeout(t);
  }, []);

  // 全局快捷键（可在「设置 → 鼠标与快捷键」里改）：新建连接 / 搜索命令 / 关闭标签。
  // 关闭标签刻意排除终端内的按键——Ctrl+W 在 shell 里是删一个词，抢过来会打断输入。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const prefs = useAppStore.getState().preferences;
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, select, .xterm");
      const modalOpen = !!document.querySelector(".modal-overlay");
      if (matchShortcut(e, prefs.newConnection)) {
        if (modalOpen) return;
        e.preventDefault();
        setDialog({ kind: "new" });
        return;
      }
      if (matchShortcut(e, prefs.search)) {
        if (modalOpen) return;
        e.preventDefault();
        setDialog({ kind: "tools", tab: "commands" });
        // 面板挂载后把焦点放到搜索框，敲键即可筛选
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".repo-toolbar input")?.focus();
        });
        return;
      }
      if (!typing && matchShortcut(e, prefs.closeTab)) {
        const state = useAppStore.getState();
        if (modalOpen || !state.activeId) return;
        e.preventDefault();
        void state.closeWorkspace(state.activeId);
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
      <div className="app-body">
        {/* v5：左侧栏占满整个高度（顶栏已移入主区），宽度可拖拽、也可由顶栏按钮折叠 */}
        <PanelGroup direction="horizontal" autoSaveId="mssh.layout.v5">
          <Panel
            ref={leftRef}
            order={1}
            defaultSize={layout.leftCollapsed ? 0 : lastLeftSize.current}
            minSize={14}
            maxSize={38}
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              if (size >= 1) lastLeftSize.current = size;
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

          {/* 左侧分隔条：侧栏折叠时整条隐藏，避免窗口边缘留下一条突兀的缝；展开时线条保持低调 */}
          <PanelResizeHandle className={`resize-handle vertical side-handle ${layout.leftCollapsed ? "is-hidden" : ""}`}>
            <div className="resize-line" />
          </PanelResizeHandle>

          <Panel order={2} defaultSize={80} minSize={30} className="pg-main">
            {/* 顶栏只覆盖主区与监控区，从侧栏右边缘开始；侧栏自己占满整个左侧高度 */}
            <header className="topbar">
              <button
                className={`icon-btn panel-toggle ${layout.leftCollapsed ? "" : "on"}`}
                onClick={flipLeft}
                title={layout.leftCollapsed ? "显示侧栏" : "隐藏侧栏"}
                aria-label={layout.leftCollapsed ? "显示侧栏" : "隐藏侧栏"}
                aria-pressed={!layout.leftCollapsed}
              >
                {layout.leftCollapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
              </button>
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
      {dialog.kind === "tools" && (
        <WorkspaceToolsDialog
          tab={dialog.tab}
          onTab={(tab) => setDialog({ kind: "tools", tab })}
          onClose={closeDialog}
        />
      )}
      {dialog.kind === "settings" && <SettingsDialog currentId={themeId} onApply={setThemeId} onClose={closeDialog} />}
      {dialog.kind === "close" && <CloseDialog onClose={closeDialog} onQuit={doQuit} onHide={doHide} />}
      {/* 首次连接的主机指纹确认：不确认就不写 known_hosts */}
      {hostKeyPrompt && <HostKeyDialog />}
      {windowState !== "normal" && <WindowOverlay state={windowState} onRestore={restoreWindow} />}
      <Toast />
    </div>
  );
}
