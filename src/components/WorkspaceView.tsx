import { createContext, useContext, useState, type DragEvent, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { CircleAlert, Columns2, LoaderCircle, Minimize2, Wifi, WifiOff, X, type LucideIcon } from "lucide-react";
import { useAppStore } from "../store";
import type { ConnectionStatus, TabPane, Workspace } from "../types";
import { WorkspacePanel } from "./WorkspacePanel";

interface DragState { runtimeId: string; fromPane: number }
const STATUS_TEXT: Record<string, string> = {
  idle: "待连接", connecting: "连接中", connected: "已连接", error: "异常", closed: "已关闭",
};
/** 连接状态用图标区分（会话色点保持实心圆），避免两个圆点颜色相近时看错 */
const STATUS_ICON: Record<ConnectionStatus, LucideIcon> = {
  idle: WifiOff,
  connecting: LoaderCircle,
  connected: Wifi,
  error: CircleAlert,
  closed: WifiOff,
};

interface DndCtx {
  drag: DragState | null;
  over: string | null;
  setDrag: (d: DragState | null) => void;
  setOver: (k: string | null) => void;
  dropToPane: (i: number) => void;
  dropToTab: (i: number, to: number) => void;
  dropToSplit: () => void;
  clear: () => void;
}
const DndContext = createContext<DndCtx | null>(null);

export function WorkspaceView() {
  const panes = useAppStore((s) => s.panes);
  const workspaces = useAppStore((s) => s.workspaces);
  const focusedPane = useAppStore((s) => s.focusedPane);
  const maxPanes = useAppStore((s) => s.preferences.maxPanes ?? 4);
  const byId = new Map(workspaces.map((w) => [w.runtimeId, w]));
  const [drag, setDrag] = useState<DragState | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const clear = () => { setDrag(null); setOver(null); };
  const dropToPane = (i: number) => {
    if (!drag) return;
    if (drag.fromPane !== i) useAppStore.getState().moveTabToPane(drag.runtimeId, i);
    clear();
  };
  const dropToTab = (i: number, to: number) => {
    if (!drag) return;
    if (drag.fromPane === i) useAppStore.getState().reorderTab(drag.runtimeId, i, to);
    else {
      useAppStore.getState().moveTabToPane(drag.runtimeId, i);
      useAppStore.getState().reorderTab(drag.runtimeId, i, to);
    }
    clear();
  };
  const dropToSplit = () => {
    if (!drag) return;
    useAppStore.getState().splitWorkspace(drag.runtimeId);
    clear();
  };

  const children: ReactNode[] = [];
  panes.forEach((pane, i) => {
    if (i > 0) children.push(
      <PanelResizeHandle key={`h-${i}`} className="resize-handle vertical pane-handle"><div className="resize-line" /></PanelResizeHandle>
    );
    children.push(
      <Panel key={`p-${i}`} order={i + 1} defaultSize={100 / panes.length} minSize={12} className="view-pane">
        <DndContext.Provider value={{ drag, over, setDrag, setOver, dropToPane, dropToTab, dropToSplit, clear }}>
          <PaneView pane={pane} index={i} paneCount={panes.length} maxPanes={maxPanes} byId={byId} focused={focusedPane === i} />
        </DndContext.Provider>
      </Panel>
    );
  });

  return <div className="workspace-view"><PanelGroup direction="horizontal" className="view-group">{children}</PanelGroup></div>;
}

function PaneView({ pane, index, paneCount, maxPanes, byId, focused }: {
  pane: TabPane; index: number; paneCount: number; maxPanes: number; byId: Map<string, Workspace>; focused: boolean;
}) {
  const dnd = useContext(DndContext)!;
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const allWorkspaces = useAppStore((s) => s.workspaces);
  const activeWs = pane.activeTab ? byId.get(pane.activeTab) : undefined;
  /** 同一连接开多个终端时给标签编号（腾讯云 · 2），否则两个标签完全同名分不清 */
  const tabLabel = (rid: string) => {
    const ws = byId.get(rid)!;
    const same = allWorkspaces.filter((w) => w.session.id === ws.session.id);
    if (same.length < 2) return ws.session.name;
    return `${ws.session.name} · ${same.findIndex((w) => w.runtimeId === rid) + 1}`;
  };
  /** 窗格里只有一个终端时不允许分屏：那只会把同一个会话复制一份 */
  const canSplit = pane.tabs.length > 1;
  const atMax = paneCount >= maxPanes;
  const splitDisabled = !canSplit || atMax;

  const onTabsDragOver = (e: DragEvent) => {
    if (!dnd.drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dnd.setOver(`pane-${index}`);
  };
  const onTabsDrop = (e: DragEvent) => {
    if (!dnd.drag) return;
    e.preventDefault();
    dnd.dropToPane(index);
  };

  return (
    <div className={`pane ${focused ? "focused" : ""}`} onMouseDown={() => setFocusedPane(index)}>
      <div className="tabbar">
        <div
          className={`tabbar-tabs ${dnd.over === `pane-${index}` ? "drop-target" : ""}`}
          onDragOver={onTabsDragOver}
          onDragLeave={() => { if (dnd.over === `pane-${index}`) dnd.setOver(null); }}
          onDrop={onTabsDrop}
        >
          {pane.tabs.map((rid, ti) => {
            const ws = byId.get(rid);
            if (!ws) return null;
            const isActive = pane.activeTab === rid && focused;
            const isDragging = dnd.drag?.runtimeId === rid;
            const dropBefore = dnd.over === `tab-${index}-${ti}`;
            return (
              <div
                key={rid}
                className={`wtab ${isActive ? "active" : ""} ${isDragging ? "dragging" : ""} ${dropBefore ? "drop-before" : ""}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", rid);
                  dnd.setDrag({ runtimeId: rid, fromPane: index });
                }}
                onDragEnd={dnd.clear}
                onDragOver={(e) => {
                  if (!dnd.drag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dnd.setOver(`tab-${index}-${ti}`);
                }}
                onDrop={(e) => {
                  if (!dnd.drag) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dnd.dropToTab(index, ti);
                }}
                onClick={() => useAppStore.getState().focusWorkspace(rid)}
                title={`${ws.session.username}@${ws.session.host}`}
              >
                <span className="wtab-dot" style={{ background: ws.session.color ?? "var(--accent)" }} />
                <span className="wtab-name">{tabLabel(rid)}</span>
                {(() => {
                  const StatusIcon = STATUS_ICON[ws.status] ?? WifiOff;
                  return (
                    <span className={`status-icon ${ws.status}`} title={STATUS_TEXT[ws.status]}>
                      <StatusIcon size={13} />
                    </span>
                  );
                })()}
                <button
                  className={`wtab-split ${splitDisabled ? "disabled" : ""}`}
                  title={atMax
                    ? `已达最多 ${maxPanes} 屏`
                    : !canSplit ? "该窗格只有一个终端，无法再分屏" : `把该终端分到新的窗格（当前 ${paneCount} 屏）`}
                  aria-label="分屏"
                  aria-disabled={splitDisabled}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); useAppStore.getState().splitWorkspace(rid); }}
                ><Columns2 size={13} /></button>
                <button
                  className="wtab-close"
                  title="关闭标签"
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); void useAppStore.getState().closeWorkspace(rid); }}
                ><X size={12} /></button>
              </div>
            );
          })}
        </div>

        {paneCount > 1 && (
          <div className="tabbar-actions">
            <button
              className="pane-unsplit"
              title="收起该分屏（终端不关闭，标签并回相邻窗格）"
              aria-label="收起分屏"
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); useAppStore.getState().unsplitPane(index); }}
            ><Minimize2 size={13} /></button>
          </div>
        )}

        {paneCount === 1 && canSplit && (
          <div
            className={`split-zone ${dnd.over === "split" ? "over" : ""} ${dnd.drag && canSplit ? "armed" : ""}`}
            onDragOver={(e) => { if (!dnd.drag || !canSplit) return; e.preventDefault(); dnd.setOver("split"); }}
            onDragLeave={() => { if (dnd.over === "split") dnd.setOver(null); }}
            onDrop={(e) => { if (!dnd.drag || !canSplit) return; e.preventDefault(); dnd.dropToSplit(); }}
          />
        )}
      </div>

      <div className="pane-body">
        {activeWs ? (
          <WorkspacePanel workspace={activeWs} active={focused} />
        ) : (
          <div className="pane-empty" />
        )}
      </div>
    </div>
  );
}
