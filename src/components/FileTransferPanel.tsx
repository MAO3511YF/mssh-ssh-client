import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  ArrowLeft, ArrowRight, ArrowUpFromLine, ArrowDownToLine, Copy, Crosshair, File as FileIcon,
  FilePlus2, Folder, FolderOpen, Pencil, RefreshCw, Trash2, X,
} from "lucide-react";
import { driver } from "../drivers";
import { useAppStore } from "../store";
import { clipboardWriteText } from "../clipboard";
import { onRemoteCd, requestEditorOpen, sessionCwd } from "../runtime";
import type { RemoteFileEntry } from "../types";

const LOCAL_CWD_KEY = "mssh.localCwd";

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

function joinPath(base: string, name: string): string {
  if (base.endsWith("/") || base.endsWith("\\")) return base + name;
  return base + "/" + name;
}

/**
 * 只取最后一段文件名。
 *
 * 远端目录列表里的名字完全由服务器决定：恶意或被入侵的服务器可以返回
 * `..\..\Users\me\AppData\Roaming\...\startup\x.bat` 这类名字，直接拼进本地
 * 路径就会写到任意位置。落盘/上传前一律先过这一层，取不到合法名字就拒绝。
 *
 * 两个细节：
 * - 远端是 Unix，只按 `/` 分段，所以 `a\b.txt` 不会被切成 `b.txt`（静默改名同样是坑）；
 * - 但 `\` 在 Windows 本地是路径分隔符，含它的名字会写进子目录 —— 这种直接拒绝，
 *   由调用方提示"文件名不合法，已跳过"，而不是替用户猜一个名字。
 */
function childName(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1).trim();
  if (!base || base === "." || base === "..") return "";
  if (base.includes("\\") || /[\x00-\x1f]/.test(base)) return "";
  return base;
}

/**
 * 把路径安全地放进远端 shell 命令里。
 *
 * 目录名可能含空格、引号、`;`、`$()` 等元字符，裸拼进 `cd xxx` 就等于让服务器
 * 上的文件名决定执行什么命令。这里用单引号包裹（内部单引号转义成 '\''），
 * 开头的 ~ 保留在引号外以便 shell 展开。
 */
function shellPath(p: string): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  if (p === "~") return "~";
  if (p.startsWith("~/")) return `~/${quote(p.slice(2))}`;
  // 绝对路径不会被当成选项；相对路径补 ./ 兜底，避免 -rf 这类名字变形
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return quote(p);
  return quote(`./${p.replace(/^\.\//, "")}`);
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
  // 只有会话真正 connected 时后端 SESSIONS 里才有它；未连接就请求会报「会话不存在」
  const connected = useAppStore((s) =>
    s.workspaces.find((w) => w.runtimeId === runtimeId)?.status === "connected");

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
  /** 待确认的删除项：目录会被递归删除，必须先问一次 */
  const [pendingDelete, setPendingDelete] = useState<{ side: "local" | "remote"; item: Item } | null>(null);

  // 两侧的当前目录与历史栈。本地默认落桌面，并记住上次用过的目录
  const [localCwd, setLocalCwd] = useState<string>(() => localStorage.getItem(LOCAL_CWD_KEY) || "");
  const [remoteCwd, setRemoteCwd] = useState<string>(".");
  const [localItems, setLocalItems] = useState<Item[]>([]);
  const [remoteItems, setRemoteItems] = useState<Item[]>([]);
  // 地址栏可编辑草稿：两端都显示当前路径，用户可直接输入路径回车/点箭头跳转
  const [remotePathDraft, setRemotePathDraft] = useState<string>("");
  const [localPathDraft, setLocalPathDraft] = useState<string>("");

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
    // 会话尚未建立（含断线/重连中）时不发 SFTP 请求，避免刷「会话不存在」错误
    if (!useAppStore.getState().workspaces.find((w) => w.runtimeId === runtimeId)?.status) return;
    if (useAppStore.getState().workspaces.find((w) => w.runtimeId === runtimeId)?.status !== "connected") {
      setRemoteItems([]);
      return;
    }
    try {
      const list = await driver.sftpList(runtimeId, path);
      setRemoteItems(list.map(toItem));
    } catch (e) {
      // 采集瞬间会话被断开：静默清空，等下次 connected 自动重载，不再刷错误弹窗
      setRemoteItems([]);
    }
  }, [runtimeId]);

  /**
   * 统一的远程跳转：接受绝对路径 / ~ / 相对路径（含 ..），交给服务器 canonicalize 校验。
   * - 目录存在 → 得到真实绝对路径，更新 remoteCwd 与基准并加载；
   * - 不存在 → 提示并保持原目录，这正是 cd 失败时"不该跳"的语义。
   */
  const navigateRemote = useCallback(async (input: string) => {
    const raw = input.trim();
    if (!raw) return;
    // 相对路径以当前真实目录为基准拼出完整路径；绝对/~ 路径直接交给服务器解析
    const base = sessionCwd.get(runtimeId) ?? remoteCwd;
    const candidate = raw.startsWith("/") || raw.startsWith("~")
      ? raw
      : (base === "." ? raw : `${base.replace(/\/+$/, "")}/${raw}`);
    try {
      const real = await driver.sftpCanonicalize(runtimeId, candidate);
      sessionCwd.set(runtimeId, real);
      setRemoteCwd(real);
      setRemotePathDraft(real);
    } catch (e) {
      showToast(`目录不存在或不可访问: ${raw}`, "error");
      // 输入框回填当前真实路径，避免停留在错误输入上
      setRemotePathDraft(sessionCwd.get(runtimeId) ?? remoteCwd);
    }
  }, [runtimeId, remoteCwd, showToast]);

  /** 本地跳转：输入路径（可为绝对/相对/~），用 fsList 校验是目录后才切换 */
  const navigateLocal = useCallback(async (input: string) => {
    const raw = input.trim();
    if (!raw) return;
    const candidate = raw.startsWith("~") || raw.includes(":") || raw.startsWith("/") || raw.startsWith("\\")
      ? raw
      : joinPath(localCwd, raw);
    try {
      await driver.fsList(candidate);
      setLocalCwd(candidate);
      setLocalPathDraft(candidate);
    } catch {
      showToast(`本地目录不存在或不可访问: ${raw}`, "error");
      setLocalPathDraft(localCwd);
    }
  }, [localCwd, showToast]);

  useEffect(() => {
    // 已有记忆目录就直接用；否则动态解析系统桌面（支持改盘符 / OneDrive 重定向）
    if (localStorage.getItem(LOCAL_CWD_KEY)) return;
    let alive = true;
    (async () => {
      let path = "";
      try { path = await driver.fsDesktop(); } catch { /* 回落 home */ }
      if (!path) { try { path = await driver.fsHome(); } catch { /* 保持 ~ */ } }
      if (alive && path) setLocalCwd(path);
      else if (alive) setLocalCwd("~");
    })();
    return () => { alive = false; };
  }, []);

  // 记住本地目录，下次打开直接回到这里
  useEffect(() => {
    if (localCwd && localCwd !== "~") localStorage.setItem(LOCAL_CWD_KEY, localCwd);
    if (localCwd) void loadLocal(localCwd);
  }, [localCwd, loadLocal]);
  // 连接就绪后再加载；断线期间清空，重连成功（connected 翻转）时自动重新拉取目录
  useEffect(() => { void loadRemote(remoteCwd); }, [remoteCwd, loadRemote, connected]);

  // 连接首次就绪时，向服务器求证真实 home 绝对路径，作为地址栏显示与相对跳转基准。
  // 必须用 "~" 而非 "."：SFTP 子系统的 "." 起点可能是根目录 "/"，用它当基准会让
  // cd wenku 跳到 /wenku（根下）而不是 /home/ubuntu/wenku（home 下）。
  useEffect(() => {
    if (!connected || sessionCwd.has(runtimeId)) return;
    let alive = true;
    void driver.sftpCanonicalize(runtimeId, "~").then((home) => {
      if (!alive) return;
      sessionCwd.set(runtimeId, home);
      setRemoteCwd(home);
      setRemotePathDraft(home);
    }).catch(() => {
      // 个别服务器不支持 ~ 展开，退回 "."（至少能显示一个真实绝对路径）
      if (!alive) return;
      void driver.sftpCanonicalize(runtimeId, ".").then((home) => {
        if (!alive) return;
        sessionCwd.set(runtimeId, home);
        setRemoteCwd(home);
        setRemotePathDraft(home);
      }).catch(() => { /* 稍后重连时会再试 */ });
    });
    return () => { alive = false; };
  }, [connected, runtimeId]);

  // 目录变化时同步两端地址栏草稿（双击进入、返回上级、cd 跟随都会更新）
  useEffect(() => { setRemotePathDraft(remoteCwd); }, [remoteCwd]);
  useEffect(() => { setLocalPathDraft(localCwd); }, [localCwd]);

  // 终端 cd 跟随跳转：开关开启时，远端目录随终端里的 cd 命令同步（经服务器求证真实路径）
  useEffect(() => {
    if (!preferences.terminalFollowCd) return;
    return onRemoteCd(runtimeId, (arg) => { void navigateRemote(arg); });
  }, [runtimeId, preferences.terminalFollowCd, navigateRemote]);

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
      await clipboardWriteText(text);
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
    else { setRemoteCwd(item.path); sessionCwd.set(runtimeId, item.path); }
    setSelected(null);
  };
  const goUp = (side: "local" | "remote") => {
    const p = parentPath(cwdOf(side));
    if (side === "local") setLocalCwd(p);
    else { setRemoteCwd(p); sessionCwd.set(runtimeId, p); }
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
    if (childName(name) !== name) { showToast("名称不能包含路径分隔符", "error"); return; }
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
    if (childName(name) !== name) { showToast("名称不能包含路径分隔符", "error"); return; }
    const full = joinPath(cwdOf(creating), name);
    try {
      if (creating === "remote") await driver.sftpCreate(runtimeId, full, createDir);
      else await driver.fsCreate(full, createDir);
      push(`新建${createDir ? "目录" : "文件"} ${full}`);
      refresh(creating);
    } catch (e) { showToast(`新建失败: ${String(e)}`, "error"); }
    setCreateValue(""); setCreating(null); setMenu(null); setCreateDir(false);
  };

  /** 右键删除只弹确认框：目录是递归删除，误点不可恢复 */
  const askDelete = () => {
    if (!menu?.item) return;
    setPendingDelete({ side: menu.side, item: menu.item });
    setMenu(null);
  };

  const runDelete = async () => {
    if (!pendingDelete) return;
    const { side, item } = pendingDelete;
    setPendingDelete(null);
    try {
      if (side === "remote") await driver.sftpRemove(runtimeId, item.path, item.type === "dir");
      else await driver.fsRemove(item.path, item.type === "dir");
      push(`删除 ${item.name}`);
      refresh(side);
    } catch (e) { showToast(`删除失败: ${String(e)}`, "error"); }
    setSelected(null);
  };

  const locateDir = () => {
    if (!menu?.item || menu.side !== "remote") return;
    const dir = menu.item.type === "dir" ? menu.item.path : parentPath(menu.item.path);
    // 目录名可能含空格/引号/分号，必须转义后再交给 shell
    const cmd = `cd ${shellPath(dir)}`;
    writeToWorkspace(runtimeId, cmd);
    push(`终端定位到 ${cmd}`);
    showToast(`已在终端执行 cd`, "success");
    setMenu(null);
  };

  /** 上传：本地文件 -> 远端当前目录 */
  const uploadFile = async (srcPath: string, name: string) => {
    const safe = childName(name);
    if (!safe) { showToast(`文件名不合法，已跳过：${name}`, "error"); return; }
    setBusy(true);
    try {
      const content = await driver.fsRead(srcPath);
      const dest = joinPath(remoteCwd, safe);
      await driver.sftpWrite(runtimeId, dest, content.contentBase64);
      push(`↑ 上传 ${safe} → ${host}:${remoteCwd}`);
      showToast(`已上传 ${safe}`, "success");
      refresh("remote");
    } catch (e) { showToast(`上传失败: ${String(e)}`, "error"); }
    finally { setBusy(false); }
  };

  /** 下载：远端文件 -> 本地当前目录 */
  const downloadFile = async (srcPath: string, name: string) => {
    // 名字来自远端服务器，只取最后一段，避免 ..\..\ 写到目录外
    const safe = childName(name);
    if (!safe) { showToast(`文件名不合法，已跳过：${name}`, "error"); return; }
    setBusy(true);
    try {
      const content = await driver.sftpRead(runtimeId, srcPath);
      const dest = joinPath(localCwd, safe);
      await driver.fsWrite(dest, content.contentBase64);
      push(`↓ 下载 ${safe} ← ${host}:${parentPath(srcPath)}`);
      showToast(`已下载 ${safe}`, "success");
      refresh("local");
    } catch (e) { showToast(`下载失败: ${String(e)}`, "error"); }
    finally { setBusy(false); }
  };

  /** 在编辑器打开远端文本文件：编辑器直接用 SFTP 读写这个真实文件，
   *  不再把内容复制成一份与服务器脱钩的本地草稿（那样改完根本不知道写回哪）。 */
  const openInEditor = (item: Item) => {
    requestEditorOpen({ runtimeId, path: item.path });
    setMenu(null);
  };

  // 拖拽：本地文件行 -> 远端列 = 上传；远端文件行 -> 本地列 = 下载；OS 文件 -> 远端 = 上传
  const onDrop = (e: DragEvent, target: "local" | "remote") => {
    e.preventDefault(); setDragOver(null);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length && target === "remote") {
      files.forEach((f) => {
        const safe = childName(f.name);
        if (!safe) { showToast(`文件名不合法，已跳过：${f.name}`, "error"); return; }
        f.arrayBuffer().then((buf) => {
          const dest = joinPath(remoteCwd, safe);
          driver.sftpWrite(runtimeId, dest, bytesToBase64(buf))
            .then(() => { push(`↑ 上传 ${safe}`); refresh("remote"); })
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

  const renderRows = (side: "local" | "remote") => {
    const cwd = cwdOf(side);
    // 后端 sftp/read_dir 会过滤掉 . 与 ..，这里补一行显式的上级目录入口。
    // 与普通目录行保持一致：单击只选中，双击才返回上级——避免误点时整列跳走。
    const parent = parentPath(cwd);
    const showParent = side === "local" ? cwd !== "~" : cwd !== "." && cwd !== "/" && cwd !== "~";
    const upRow = showParent ? (
      <button
        key={`${side}-up`}
        className="tf-row tf-up-row"
        onClick={() => setSelected(null)}
        onDoubleClick={() => goUp(side)}
        title={`双击返回上级目录: ${parent}`}
      >
        <Folder size={15} className="tf-ico dir" />
        <span className="tf-name">..</span>
      </button>
    ) : null;
    return (
      <>
        {upRow}
        {itemsOf(side).map((f) => (
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
        ))}
      </>
    );
  };

  const renderColumn = (side: "local" | "remote") => {
    const cwd = cwdOf(side);
    const label = side === "local" ? "本地" : protocol.toUpperCase();
    const draft = side === "local" ? localPathDraft : remotePathDraft;
    const setDraft = side === "local" ? setLocalPathDraft : setRemotePathDraft;
    const navigate = side === "local" ? navigateLocal : navigateRemote;
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
          <div className="tf-path-edit" title="输入路径后按回车或点箭头跳转到该目录">
            <span className={`tf-path-tag ${side}`}>{label}</span>
            <input
              className="tf-path-input"
              value={draft}
              spellCheck={false}
              placeholder="输入目录路径…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void navigate(draft); }
                if (e.key === "Escape") { setDraft(cwd); (e.target as HTMLInputElement).blur(); }
              }}
            />
            <button className="tf-path-go" title="跳转到该目录" onClick={() => void navigate(draft)}><ArrowRight size={13} /></button>
            <button className="tf-path-copy-btn" title="复制当前路径" onClick={() => void copyText(cwd, side === "local" ? "本地路径" : "远程路径")}><Copy size={12} /></button>
          </div>
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
        {/* 命中区不外扩：分隔槽本身 6px，光标进入槽内才变成列宽箭头，和看到的那条线对齐 */}
        <PanelResizeHandle className="resize-handle vertical tf-col-resize" hitAreaMargins={{ fine: 0, coarse: 8 }}>
          <div className="resize-line" />
        </PanelResizeHandle>
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
              <button className="tf-context-item danger" onClick={askDelete}><Trash2 size={14} /> 删除</button>
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

      {pendingDelete && (
        <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}>
          <div className="modal small" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div><h2>删除{pendingDelete.item.type === "dir" ? "目录" : "文件"}</h2></div>
              <button className="icon-btn" aria-label="关闭" onClick={() => setPendingDelete(null)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="confirm-text">
                确定删除{pendingDelete.side === "remote" ? "远端" : "本地"}的 <b>{pendingDelete.item.name}</b> 吗？
              </p>
              <p className="confirm-hint">{pendingDelete.item.path}</p>
              {pendingDelete.item.type === "dir" && (
                <p className="confirm-hint">
                  <b>
                    {pendingDelete.side === "local"
                      ? "本地目录会被递归删除，里面的所有内容无法恢复。"
                      : "远端只能删除空目录；非空目录请先在终端里处理。"}
                  </b>
                </p>
              )}
            </div>
            <div className="modal-foot">
              <span className="spacer" />
              <button className="btn secondary" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="btn danger-solid" onClick={() => void runDelete()}><Trash2 size={15} /> 删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
