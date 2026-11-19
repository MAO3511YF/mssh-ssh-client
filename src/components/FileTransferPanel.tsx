import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowLeft, ArrowUpFromLine, ArrowDownToLine, Copy, Crosshair, File as FileIcon,
  FilePlus2, Folder, FolderOpen, Pencil, RefreshCw, Trash2,
} from "lucide-react";
import { driver } from "../drivers";
import { useAppStore } from "../store";
import type { RemoteFileEntry } from "../types";

interface Props {
  host: string;
  protocol: string;
  runtimeId: string;
}

interface Item {
  name: string;
  type: "dir" | "file";
  path: string;
  size?: string;
  modified?: string;
}

interface ContextMenu {
  x: number;
  y: number;
  side: "local" | "remote";
  item: Item | null;
}

/** ArrayBuffer -> base64 */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** base64 -> UTF-8 文本（用于编辑器打开文本文件） */
function base64ToText(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function joinPath(base: string, name: string): string {
  if (base.endsWith("/") || base.endsWith("\\")) return base + name;
  return base + "/" + name;
}
function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx <= 0) return trimmed.startsWith("/") ? "/" : "~";
  return trimmed.slice(0, idx);
}
export function FileTransferPanel({ host, protocol, runtimeId }: Props) {
  const writeToWorkspace = useAppStore((s) => s.writeToWorkspace);
  const showToast = useAppStore((s) => s.showToast);
  const preferences = useAppStore((s) => s.preferences);

  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ side: "local" | "remote"; item: Item } | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  const [renaming, setRenaming] = useState<{ side: "local" | "remote"; item: Item } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [creating, setCreating] = useState<"local" | "remote" | null>(null);
  const [createValue, setCreateValue] = useState("");
  const [createDir, setCreateDir] = useState(false);
  const [dragOver, setDragOver] = useState<"local" | "remote" | null>(null);
  const [busy, setBusy] = useState(false);

  // 两侧的当前目录与历史栈
  const [localCwd, setLocalCwd] = useState<string>("~");
  const [remoteCwd, setRemoteCwd] = useState<string>(".");
  const [localItems, setLocalItems] = useState<Item[]>([]);
  const [remoteItems, setRemoteItems] = useState<Item[]>([]);

  const menuRef = useRef<HTMLDivElement>(null);
  const push = useCallback((msg: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${msg}`, ...l].slice(0, 30));
  }, []);

  const toItem = (e: RemoteFileEntry): Item => ({
    name: e.name,
    type: e.type,
    path: e.path ?? e.name,
    size: e.size,
    modified: e.modified,
  });

  const loadLocal = useCallback(async (path: string) => {
    try {
      const list = await driver.fsList(path);
      setLocalItems(list.map(toItem));
    } catch (e) {
      showToast(`读取本地目录失败: ${String(e)}`, "error");
    }
  }, [showToast]);

  const loadRemote = useCallback(async (path: string) => {
    try {
      const list = await driver.sftpList(runtimeId, path);
      setRemoteItems(list.map(toItem));
    } catch (e) {
      showToast(`读取远程目录失败: ${String(e)}`, "error");
    }
  }, [runtimeId, showToast]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const home = await driver.fsHome();
        if (alive) setLocalCwd(home);
      } catch { /* 保持默认 ~ */ }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { void loadLocal(localCwd); }, [localCwd, loadLocal]);
  useEffect(() => { void loadRemote(remoteCwd); }, [remoteCwd, loadRemote]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  const itemsOf = (side: "local" | "remote") => (side === "local" ? localItems : remoteItems);
  const cwdOf = (side: "local" | "remote") => (side === "local" ? localCwd : remoteCwd);
  const refresh = (side: "local" | "remote") => {
    if (side === "local") void loadLocal(localCwd);
    else void loadRemote(remoteCwd);
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`已复制${label}: ${text}`, "success");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); showToast(`已复制${label}: ${text}`, "success"); }
      catch { showToast("复制失败", "error"); }
      document.body.removeChild(ta);
    }
  };

  const openItem = (side: "local" | "remote", item: Item) => {
    if (item.type !== "dir") return;
    if (side === "local") setLocalCwd(item.path);
    else setRemoteCwd(item.path);
    setSelected(null);
  };
  const goUp = (side: "local" | "remote") => {
    const p = parentPath(cwdOf(side));
    if (side === "local") setLocalCwd(p);
    else setRemoteCwd(p);
  };

  const onContextMenu = (e: MouseEvent, side: "local" | "remote", item: Item | null) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(item ? { side, item } : null);
    if (item && preferences.rightClick === "copyPath") {
      void copyText(item.path, "绝对路径");
      return;
    }
    setMenu({ x: Math.min(e.clientX, window.innerWidth - 210), y: Math.min(e.clientY, window.innerHeight - 280), side, item });
  };

  const startRename = () => {
    if (!menu?.item) return;
    setRenaming({ side: menu.side, item: menu.item });
    setRenameValue(menu.item.name);
    setMenu(null);
  };
  const commitRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    const old = renaming.item;
    if (!name || name === old.name) { setRenaming(null); return; }
    const to = joinPath(parentPath(old.path), name);
    try {
      if (renaming.side === "remote") await driver.sftpRename(runtimeId, old.path, to);
      else await driver.fsRename(old.path, to);
      push(`重命名 ${old.name} → ${name}`);
      refresh(renaming.side);
    } catch (e) { showToast(`重命名失败: ${String(e)}`, "error"); }
    setSelected(null);
    setRenaming(null);
  };

  const confirmCreate = async () => {
    if (!creating) return;
    const name = createValue.trim();
    if (!name) { setCreating(null); return; }
    const full = joinPath(cwdOf(creating), name);
    try {
      if (creating === "remote") await driver.sftpCreate(runtimeId, full, createDir);
      else await driver.fsCreate(full, createDir);
      push(`新建${createDir ? "目录" : "文件"} ${full}`);
      refresh(creating);
    } catch (e) { showToast(`新建失败: ${String(e)}`, "error"); }
    setCreateValue(""); setCreating(null); setMenu(null); setCreateDir(false);
  };

  const doDelete = async () => {
    if (!menu?.item) return;
    const { side, item } = menu;
    try {
      if (side === "remote") await driver.sftpRemove(runtimeId, item.path, item.type === "dir");
      else await driver.fsRemove(item.path, item.type === "dir");
      push(`删除 ${item.name}`);
      refresh(side);
    } catch (e) { showToast(`删除失败: ${String(e)}`, "error"); }
    setSelected(null);
    setMenu(null);
  };

  const locateDir = () => {
    if (!menu?.item || menu.side !== "remote") return;
    const dir = menu.item.type === "dir" ? menu.item.path : parentPath(menu.item.path);
    const cmd = `cd ${dir}`;
    writeToWorkspace(runtimeId, cmd);
    push(`终端定位到 ${cmd}`);
    showToast(`已在终端执行 ${cmd}`, "success");
    setMenu(null);
  };

  /** 上传：本地文件 -> 远端当前目录 */
  const uploadFile = async (srcPath: string, name: string) => {
    setBusy(true);
    try {
      const content = await driver.fsRead(srcPath);
      const dest = joinPath(remoteCwd, name);
      await driver.sftpWrite(runtimeId, dest, content.contentBase64);
      push(`↑ 上传 ${name} → ${host}:${remoteCwd}`);
      showToast(`已上传 ${name}`, "success");
      refresh("remote");
    } catch (e) { showToast(`上传失败: ${String(e)}`, "error"); }
    finally { setBusy(false); }
  };

  /** 下载：远端文件 -> 本地当前目录 */
  const downloadFile = async (srcPath: string, name: string) => {
    setBusy(true);
    try {
      const content = await driver.sftpRead(runtimeId, srcPath);
      const dest = joinPath(localCwd, name);
      await driver.fsWrite(dest, content.contentBase64);
      push(`↓ 下载 ${name} ← ${host}:${parentPath(srcPath)}`);
      showToast(`已下载 ${name}`, "success");
      refresh("local");
    } catch (e) { showToast(`下载失败: ${String(e)}`, "error"); }
    finally { setBusy(false); }
  };

  /** 编辑器打开远端文本文件 */
  const openInEditor = async (item: Item) => {
    setBusy(true);
    try {
      const content = await driver.sftpRead(runtimeId, item.path);
      const text = content.isText ? base64ToText(content.contentBase64) : "";
      useAppStore.getState().upsertEditorFile({
        id: `remote-${Date.now()}`,
        name: item.name,
        language: item.name.split(".").pop() ?? "纯文本",
        content: text,
      });
      showToast(`已在编辑器打开 ${item.name}`, "success");
    } catch (e) { showToast(`打开失败: ${String(e)}`, "error"); }
    finally { setBusy(false); }
    setMenu(null);
  };

  // 拖拽：本地文件行 -> 远端列 = 上传；远端文件行 -> 本地列 = 下载；OS 文件 -> 远端 = 上传
  const onDrop = (e: DragEvent, target: "local" | "remote") => {
    e.preventDefault(); setDragOver(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length && target === "remote") {
      files.forEach((f) => {
        f.arrayBuffer().then((buf) => {
          const dest = joinPath(remoteCwd, f.name);
          driver.sftpWrite(runtimeId, dest, bytesToBase64(buf))
            .then(() => { push(`↑ 上传 ${f.name}`); refresh("remote"); })
            .catch((err) => showToast(`上传失败: ${String(err)}`, "error"));
        });
      });
      return;
    }
    const raw = e.dataTransfer.getData("text/x-mssh-file");
    if (!raw) return;
    try {
      const { side, item } = JSON.parse(raw) as { side: "local" | "remote"; item: Item };
      if (side === target || item.type === "dir") return;
      if (target === "remote") void uploadFile(item.path, item.name);
      else void downloadFile(item.path, item.name);
    } catch { /* ignore */ }
  };
  const onDragStart = (e: DragEvent, side: "local" | "remote", item: Item) => {
    e.dataTransfer.setData("text/x-mssh-file", JSON.stringify({ side, item }));
    e.dataTransfer.effectAllowed = "copy";
  };

  const renderRows = (side: "local" | "remote") =>
    itemsOf(side).map((f) => (
      <div key={`${side}-${f.path}`}>
        {renaming?.side === side && renaming.item.path === f.path ? (
          <div className="tf-rename">
            <input
              value={renameValue} autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") setRenaming(null); }}
              onBlur={() => void commitRename()}
            />
          </div>
        ) : (
          <button
            className={`tf-row ${selected?.side === side && selected.item.path === f.path ? "selected" : ""}`}
            draggable={f.type === "file"}
            onDragStart={(e) => onDragStart(e, side, f)}
            onClick={() => setSelected({ side, item: f })}
            onDoubleClick={() => openItem(side, f)}
            onContextMenu={(e) => onContextMenu(e, side, f)}
            title={f.path}
          >
            {f.type === "dir" ? <Folder size={15} className="tf-ico dir" /> : <FileIcon size={15} className="tf-ico file" />}
            <span className="tf-name">{f.name}</span>
            {f.size && <span className="tf-size">{f.size}</span>}
          </button>
        )}
      </div>
    ));

  const renderColumn = (side: "local" | "remote") => {
    const cwd = cwdOf(side);
    const label = side === "local" ? "本地" : protocol.toUpperCase();
    const display = side === "local" ? cwd : `${host}:${cwd}`;
    return (
      <div
        className={`tf-col ${dragOver === side ? "drop-active" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(side); }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => onDrop(e, side)}
        onContextMenu={(e) => onContextMenu(e, side, null)}
      >
        <div className="tf-col-head">
          <button className="tf-nav-up" title="返回上级" onClick={() => goUp(side)}><ArrowLeft size={14} /></button>
          <button className="tf-path-copy" onClick={() => void copyText(cwd, side === "local" ? "本地路径" : "远程路径")} title="复制路径">
            <span className={`tf-path-tag ${side}`}>{label}</span>
            <span className="tf-path-text">{display}</span>
            <Copy size={12} />
          </button>
          <button className="icon-btn tiny tf-refresh" title="刷新" onClick={() => refresh(side)}><RefreshCw size={14} /></button>
        </div>
        <div className="tf-list">
          {creating === side && (
            <div className="tf-create">
              <input value={createValue} autoFocus placeholder={createDir ? "目录名" : "文件名"}
                onChange={(e) => setCreateValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void confirmCreate(); if (e.key === "Escape") setCreating(null); }}
                onBlur={() => void confirmCreate()}
              />
            </div>
          )}
          {renderRows(side)}
        </div>
      </div>
    );
  };

  return (
    <div className="tf-root">
      {busy && <div className="tf-busy" title="传输中" />}
      <PanelGroup direction="horizontal" className="tf-split">
        <Panel defaultSize={50} minSize={22} className="tf-col-panel">
          {renderColumn("local")}
        </Panel>
        <PanelResizeHandle className="resize-handle vertical tf-col-resize"><div className="resize-line" /></PanelResizeHandle>
        <Panel defaultSize={50} minSize={22} className="tf-col-panel">
          {renderColumn("remote")}
        </Panel>
      </PanelGroup>

      <div className="tf-actions">
        <button className="btn tiny" disabled={selected?.side !== "local" || busy} onClick={() => selected && void uploadFile(selected.item.path, selected.item.name)}>
          <ArrowUpFromLine size={14} /> 上传
        </button>
        <button className="btn tiny" disabled={selected?.side !== "remote" || busy} onClick={() => selected && void downloadFile(selected.item.path, selected.item.name)}>
          <ArrowDownToLine size={14} /> 下载
        </button>
        <span className="tf-hint">双击目录进入 · 拖拽文件跨栏传输</span>
      </div>
      {log.length > 0 && (
        <div className="tf-log">{log.slice(0, 3).map((line, i) => <div key={i}>{line}</div>)}</div>
      )}

      {menu && (
        <div className="tf-context" ref={menuRef} style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.item ? (
            <>
              <div className="tf-context-title">{menu.item.name}</div>
              <button className="tf-context-item" onClick={() => { void copyText(menu.item!.path, "绝对路径"); setMenu(null); }}>
                <Copy size={14} /> 复制绝对路径
              </button>
              <button className="tf-context-item" onClick={() => { void copyText(menu.item!.name, "相对路径"); setMenu(null); }}>
                <Copy size={14} /> 复制相对路径
              </button>
              <div className="tf-context-sep" />
              {menu.side === "remote" && menu.item.type === "file" && (
                <button className="tf-context-item" onClick={() => void openInEditor(menu.item!)}>
                  <FileIcon size={14} /> 在编辑器打开
                </button>
              )}
              {menu.side === "remote" && (
                <button className="tf-context-item" onClick={locateDir}><Crosshair size={14} /> 定位到所在目录</button>
              )}
              <button className="tf-context-item" onClick={startRename}><Pencil size={14} /> 重命名</button>
              <button className="tf-context-item danger" onClick={() => void doDelete()}><Trash2 size={14} /> 删除</button>
            </>
          ) : (
            <>
              <div className="tf-context-title">{menu.side === "local" ? "本地目录" : "远程目录"}</div>
              <button className="tf-context-item" onClick={() => { setCreating(menu.side); setCreateDir(false); setCreateValue(""); setMenu(null); }}>
                <FilePlus2 size={14} /> 新建文件
              </button>
              <button className="tf-context-item" onClick={() => { setCreating(menu.side); setCreateDir(true); setCreateValue(""); setMenu(null); }}>
                <FolderOpen size={14} /> 新建目录
              </button>
              <button className="tf-context-item" onClick={() => { void copyText(cwdOf(menu.side), "路径"); setMenu(null); }}>
                <FolderOpen size={14} /> 复制当前路径
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
