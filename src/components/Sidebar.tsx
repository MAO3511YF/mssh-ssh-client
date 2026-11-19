import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Command, Folder, FolderPlus, Library,
  MoreHorizontal, Pencil, Plus, Search, Server, SquarePen, Terminal, Trash2,
} from "lucide-react";
import { useAppStore } from "../store";
import { TYPE_META } from "../constants";
import type { DirectoryGroup } from "../sidebarTypes";

interface Props {
  onNew: () => void;
  onFolder: () => void;
  onRepo: () => void;
  onEditor: () => void;
  onEditSession: (id: string) => void;
  onRenameSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onRenameFolder: (name: string) => void;
  onDeleteFolder: (name: string) => void;
}

type Menu =
  | { kind: "folder"; name: string; x: number; y: number }
  | { kind: "session"; id: string; x: number; y: number };

export function Sidebar({
  onNew, onFolder, onRepo, onEditor,
  onEditSession, onRenameSession, onDeleteSession, onRenameFolder, onDeleteFolder,
}: Props) {
  const sessions = useAppStore((s) => s.sessions);
  const folders = useAppStore((s) => s.folders);
  const commands = useAppStore((s) => s.commands);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const activeId = useAppStore((s) => s.activeId);
  const workspaces = useAppStore((s) => s.workspaces);
  const writeToWorkspace = useAppStore((s) => s.writeToWorkspace);
  const showToast = useAppStore((s) => s.showToast);

  const [searchOpen, setSearchOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const groups = useMemo<DirectoryGroup[]>(() => {
    const names = new Set<string>(folders);
    for (const s of sessions) names.add(s.directory?.trim() || "默认工作区");
    return Array.from(names, (name) => ({
      name,
      items: sessions.filter((s) => (s.directory?.trim() || "默认工作区") === name),
      empty: folders.includes(name) && !sessions.some((s) => (s.directory?.trim() || "默认工作区") === name),
    }));
  }, [sessions, folders]);

  const results = useMemo(() => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return commands.slice(0, 6);
    return commands.filter((c) => [c.name, c.command, c.description].some((v) => v?.toLowerCase().includes(q))).slice(0, 8);
  }, [commands, commandQuery]);

  const activeSessionId = workspaces.find((w) => w.runtimeId === activeId)?.session.id;

  // 菜单：点击空白处 / 滚动 / Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const toggleDir = (name: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  // 菜单跟随鼠标，落在点击点下方；贴近视口右/下边缘时向内翻，避免被裁切
  const placeMenu = (e: React.MouseEvent): { x: number; y: number } => {
    const mw = 168; // 与 .ctx-menu min-width 对应
    const mh = menu?.kind === "session" ? 120 : 88;
    return {
      x: Math.max(6, Math.min(e.clientX, window.innerWidth - mw - 8)),
      y: Math.max(6, Math.min(e.clientY + 6, window.innerHeight - mh - 8)),
    };
  };
  const openFolderMenu = (name: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "folder", name, ...placeMenu(e) });
  };
  const openSessionMenu = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ kind: "session", id, ...placeMenu(e) });
  };

  return (
    <div className="sidebar-root">
      <div className="side-section">
        <button className="side-new" onClick={onNew}>
          <Plus size={16} />
          <span>New Connection</span>
        </button>
      </div>

      <div className="side-nav">
        <button className={`side-nav-item ${searchOpen ? "on" : ""}`} onClick={() => setSearchOpen((v) => !v)}>
          <Search size={16} />
          <span>搜索命令</span>
        </button>
        {searchOpen && (
          <div className="cmd-search-box">
            <div className="cmd-search-input">
              <Search size={14} />
              <input autoFocus value={commandQuery} onChange={(e) => setCommandQuery(e.target.value)} placeholder="搜索命令…" />
            </div>
            <div className="cmd-search-results">
              {results.map((c) => (
                <button
                  key={c.id}
                  className="cmd-search-row"
                  title="发送到当前工作区"
                  onClick={() => {
                    if (!activeId) { showToast("请先打开一个工作区", "error"); return; }
                    writeToWorkspace(activeId, c.command);
                    showToast(`已发送：${c.command}`, "success");
                  }}
                >
                  <span className="cmd-search-name">{c.name}</span>
                  <code>{c.command}</code>
                </button>
              ))}
              {results.length === 0 && <div className="cmd-search-empty">无匹配命令</div>}
            </div>
            <button className="cmd-search-manage" onClick={onRepo}>
              <Library size={13} /> 管理命令仓库
            </button>
          </div>
        )}
        <button className="side-nav-item" onClick={onRepo}>
          <Command size={16} />
          <span>命令仓库</span>
          <span className="nav-count">{commands.length}</span>
        </button>
        <button className="side-nav-item" onClick={onEditor}>
          <SquarePen size={16} />
          <span>编辑器</span>
        </button>
      </div>

      <div className="side-divider" />

      <div className="side-tree">
        <div className="side-tree-head">
          <span>工作区</span>
          <button className="icon-btn tiny" title="新建工作区" onClick={onFolder}><FolderPlus size={15} /></button>
        </div>
        <div className="side-tree-body">
          {groups.length === 0 ? (
            <div className="empty-list">暂无连接</div>
          ) : groups.map((g) => (
            <div className="dir-group" key={g.name}>
              <div className="dir-row">
                <button className="dir-head" onClick={() => toggleDir(g.name)} onContextMenu={(e) => openFolderMenu(g.name, e)}>
                  {collapsed.has(g.name) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <Folder size={15} className="dir-ico" />
                  <span>{g.name}</span>
                  <span className="dir-count">{g.items.length}</span>
                </button>
                <button className="row-more" title="工作区操作" onClick={(e) => openFolderMenu(g.name, e)}><MoreHorizontal size={15} /></button>
              </div>
              {!collapsed.has(g.name) && (
                <div className="dir-items">
                  {g.empty && <div className="dir-empty">空工作区</div>}
                  {g.items.map((s) => (
                    <div className="dir-row" key={s.id}>
                      <button
                        className={`session-item ${activeSessionId === s.id ? "active" : ""}`}
                        onClick={() => openWorkspace(s)}
                        onContextMenu={(e) => openSessionMenu(s.id, e)}
                      >
                        <span className="session-color" style={{ background: s.color ?? "var(--accent)" }} />
                        <span className="session-name">{s.name}</span>
                        <span className="session-host">{s.host}</span>
                        <span className="session-type">{TYPE_META[s.type].short}</span>
                      </button>
                      <button className="row-more" title="连接操作" onClick={(e) => openSessionMenu(s.id, e)}><MoreHorizontal size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="side-foot">
        <div className="side-foot-item"><Server size={14} /><span>{sessions.length} 个连接</span></div>
        <div className="side-foot-item"><Terminal size={14} /><span>{workspaces.length} 个工作区</span></div>
      </div>

      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onClick={() => setMenu(null)}
        >
          {menu.kind === "folder" ? (
            <>
              <button onClick={() => onRenameFolder(menu.name)}><Pencil size={14} /> 重命名工作区</button>
              <button className="danger" onClick={() => onDeleteFolder(menu.name)}><Trash2 size={14} /> 删除工作区</button>
            </>
          ) : (
            <>
              <button onClick={() => onEditSession(menu.id)}><SquarePen size={14} /> 编辑连接</button>
              <button onClick={() => onRenameSession(menu.id)}><Pencil size={14} /> 重命名</button>
              <button className="danger" onClick={() => onDeleteSession(menu.id)}><Trash2 size={14} /> 删除连接</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
