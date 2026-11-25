import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, File as FileIcon, FilePlus2, Folder, Loader2,
  RefreshCw, Save, Search, Server, Trash2, X,
} from "lucide-react";
import { useAppStore } from "../store";
import { driver } from "../drivers";
import { sessionCwd, takeEditorOpen } from "../runtime";
import { DEFAULT_EDITOR_SHORTCUTS, type EditorFile, type EditorShortcutId, type RemoteFileEntry } from "../types";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
}

const LANGS = ["纯文本", "Shell", "YAML", "JSON", "JavaScript", "Python", "Markdown", "Dockerfile"];

/** 各语言的注释前缀 */
const COMMENT: Record<string, string> = {
  Shell: "#", YAML: "#", Python: "#", Dockerfile: "#", JavaScript: "//", JSON: "//",
};

/** 按扩展名推断语言，猜不到就当纯文本 */
const EXT_LANG: Record<string, string> = {
  sh: "Shell", bash: "Shell", zsh: "Shell", ksh: "Shell", env: "Shell",
  conf: "Shell", cfg: "Shell", ini: "Shell", service: "Shell", timer: "Shell", rule: "Shell",
  py: "Python",
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "JavaScript", jsx: "JavaScript", tsx: "JavaScript",
  json: "JSON",
  yml: "YAML", yaml: "YAML",
  md: "Markdown", markdown: "Markdown",
  txt: "纯文本", log: "纯文本", csv: "纯文本",
};

function langOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "Dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "纯文本";
  return EXT_LANG[base.slice(dot + 1).toLowerCase()] ?? "纯文本";
}

/** 各语言对应的标准扩展名（切换语言时用来改文件名，空串=没有扩展名，用固定文件名） */
const LANG_EXT: Record<string, string> = {
  Shell: "sh", Python: "py", JavaScript: "js", JSON: "json",
  YAML: "yml", Markdown: "md", Dockerfile: "", 纯文本: "txt",
};

/** 远程路径拼接 / 取上级（服务器是 Unix，只认 /） */
const rjoin = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;
const rparent = (p: string) => {
  const s = p.replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
};
const baseName = (p: string) => p.split("/").pop() || p;

/**
 * 保存到服务器用的文件名：必须是单段。
 * 名字来自用户输入，含分隔符或 .. 时一律拒绝，避免写到预期之外的路径。
 */
function safeName(name: string): string {
  const n = name.trim();
  if (!n || n === "." || n === ".." || n.includes("/") || n.includes("\\") || n.includes("\0")) return "";
  return n;
}

/** UTF-8 文本 <-> base64（分块编码，避免大文件时 fromCharCode 参数过多爆栈）。
 *  解码严格按 UTF-8：遇到 GBK 等其它编码返回 null——
 *  否则会把乱码原样写回服务器，等于损坏文件。 */
function b64ToText(b64: string): string | null {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 超过这个大小不打开：SFTP 会把整个文件读进内存，几十 MB 的日志会直接卡死界面 */
const MAX_OPEN_BYTES = 4 * 1024 * 1024;

interface RemoteEdit {
  runtimeId: string;
  path: string;
  text: string;
  /** 上次从服务器读到 / 写回服务器的内容，用来判断是否未保存 */
  disk: string;
  lang: string;
}

/** 关闭工作台再打开时保留未保存的内容（只在内存里，绝不写 localStorage） */
const kept: { remote: RemoteEdit | null; draftId: string | null } = { remote: null, draftId: null };

/** 把键盘事件归一成 "Ctrl+Shift+K" 这种字符串（与设置里的录制逻辑保持一致） */
function comboOf(e: React.KeyboardEvent | KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  return [...mods, key].join("+");
}

const same = (a: string | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

/** 编辑器主体，可独立弹窗，也可嵌入合并工具窗口 */
export function EditorDialogContent({ onClose }: Props) {
  const drafts = useAppStore((s) => s.editorFiles);
  const upsert = useAppStore((s) => s.upsertEditorFile);
  const remove = useAppStore((s) => s.deleteEditorFile);
  const workspaces = useAppStore((s) => s.workspaces);
  const preferences = useAppStore((s) => s.preferences);
  const showToast = useAppStore((s) => s.showToast);

  const connected = workspaces.filter((w) => w.status === "connected");
  const connectedKey = connected.map((w) => w.runtimeId).join(",");

  // 默认选当前打开的工作区；没有就连第一个已连接的
  const [runtimeId, setRuntimeId] = useState<string>(() => {
    const st = useAppStore.getState();
    const act = st.workspaces.find((w) => w.runtimeId === st.activeId);
    if (act?.status === "connected") return act.runtimeId;
    return st.workspaces.find((w) => w.status === "connected")?.runtimeId ?? "";
  });

  const [cwd, setCwd] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loadingDir, setLoadingDir] = useState(false);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  // 左栏远程目录沿用「单击选中、双击打开」的规则，和文件面板保持一致，避免误点就换文件
  const [pickedPath, setPickedPath] = useState<string | null>(null);

  const [remote, setRemote] = useState<RemoteEdit | null>(kept.remote);
  const [draftId, setDraftId] = useState<string | null>(kept.draftId);

  const [bar, setBar] = useState<null | "find" | "goto">(null);
  const [query, setQuery] = useState("");
  const [lineInput, setLineInput] = useState("");
  /** 有未保存修改时，切换文件 / 重新加载前的确认 */
  const [pending, setPending] = useState<null | { kind: "reload" } | { kind: "open"; path: string } | { kind: "new" }>(null);

  const codeRef = useRef<HTMLTextAreaElement>(null);
  /** 自建撤销栈：textarea 是受控组件，编辑都走 React state，浏览器原生 undo 栈是空的 */
  const hist = useRef<{ id: string | null; stack: { text: string; sel: [number, number] }[]; index: number; at: number }>({
    id: null, stack: [], index: -1, at: 0,
  });
  const suppress = useRef(false);

  const draft = drafts.find((d) => d.id === draftId) ?? null;
  const active = remote
    ? { id: `remote:${remote.path}`, name: baseName(remote.path), language: remote.lang, content: remote.text }
    : draft
      ? { id: draft.id, name: draft.name, language: draft.language, content: draft.content }
      : null;
  const dirty = !!remote && remote.text !== remote.disk;
  const shortcuts = { ...DEFAULT_EDITOR_SHORTCUTS, ...(preferences.editorShortcuts ?? {}) };

  // 未保存内容跨挂载保留（切到命令仓库 tab 再切回来不会丢）
  useEffect(() => { kept.remote = remote; }, [remote]);
  useEffect(() => { kept.draftId = draftId; }, [draftId]);

  // 当前服务器断开后自动切到另一个已连接的，没有就留空（此时只能写草稿）
  useEffect(() => {
    if (runtimeId && connectedKey.split(",").includes(runtimeId)) return;
    setRuntimeId(connectedKey.split(",")[0] || "");
  }, [connectedKey, runtimeId]);

  const loadDir = useCallback(async (path: string, sid = runtimeId) => {
    if (!sid) { setEntries([]); return; }
    setLoadingDir(true);
    try {
      const list = await driver.sftpList(sid, path);
      // 后端可能把 . / .. 也列出来，编辑器自己画「上级」，过滤掉避免重复
      setEntries(list.filter((e) => e.name !== "." && e.name !== ".."));
      setCwd(path);
      setPathDraft(path);
    } catch (e) {
      showToast(`读取目录失败：${String(e)}`, "error");
    } finally {
      setLoadingDir(false);
    }
  }, [runtimeId, showToast]);

  // 切服务器：落到终端当前目录（与文件面板共享 sessionCwd），否则向服务器求真实 home
  useEffect(() => {
    if (!runtimeId) { setEntries([]); setCwd(""); setPathDraft(""); return; }
    const known = sessionCwd.get(runtimeId);
    if (known) { void loadDir(known, runtimeId); return; }
    let alive = true;
    void driver.sftpCanonicalize(runtimeId, "~")
      .catch(() => driver.sftpCanonicalize(runtimeId, "."))
      .then((home) => {
        if (!alive) return;
        sessionCwd.set(runtimeId, home);
        void loadDir(home, runtimeId);
      })
      .catch(() => { if (alive) setEntries([]); });
    return () => { alive = false; };
  }, [runtimeId, connectedKey, loadDir]);

  const openRemote = useCallback(async (path: string, sid = runtimeId) => {
    if (!sid) { showToast("请先选择一个已连接的服务器", "error"); return; }
    setOpeningPath(path);
    try {
      const file = await driver.sftpRead(sid, path);
      if (!file.isText) { showToast("这是二进制文件，编辑器只能打开文本", "error"); return; }
      if (file.size > MAX_OPEN_BYTES) {
        showToast(`文件 ${(file.size / 1048576).toFixed(1)} MB，超过 4 MB 不打开`, "error");
        return;
      }
      const text = b64ToText(file.contentBase64);
      if (text === null) {
        showToast("不是 UTF-8 文本（可能是 GBK 等编码），打开后保存会破坏原文件，已取消", "error");
        return;
      }
      setDraftId(null);
      setRemote({ runtimeId: sid, path, text, disk: text, lang: langOf(path) });
      setPending(null);
      // 目录跟到文件所在位置：从文件面板跳进来时，左栏才不是停在某个无关目录
      void loadDir(rparent(path), sid);
    } catch (e) {
      showToast(`打开失败：${String(e)}`, "error");
    } finally {
      setOpeningPath(null);
    }
  }, [runtimeId, showToast, loadDir]);

  /** 有未保存修改时先问一句，避免点一下就把改动冲掉 */
  const guarded = (next: { kind: "reload" } | { kind: "open"; path: string } | { kind: "new" }, run: () => void) => {
    if (dirty) setPending(next);
    else run();
  };

  // 文件面板里点「在编辑器打开」：请求由运行时带过来，这里挂载后取一次。
  // 只取一次是有意的——它是一次性命令，不是持续订阅。
  useEffect(() => {
    const req = takeEditorOpen();
    if (!req) return;
    if (req.runtimeId !== runtimeId) setRuntimeId(req.runtimeId);
    void openRemote(req.path, req.runtimeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = async () => {
    if (!runtimeId) return;
    const raw = pathDraft.trim();
    if (!raw) return;
    const base = cwd || "/";
    const candidate = raw.startsWith("/") || raw.startsWith("~")
      ? raw
      : `${base.replace(/\/+$/, "")}/${raw}`;
    try {
      const real = await driver.sftpCanonicalize(runtimeId, candidate);
      sessionCwd.set(runtimeId, real);
      await loadDir(real);
    } catch {
      showToast(`目录不存在：${raw}`, "error");
      setPathDraft(cwd);
    }
  };

  const createDraft = () => {
    const file: EditorFile = { id: `f-${Date.now()}`, name: "script.sh", language: "Shell", content: "#!/bin/bash\n\n" };
    upsert(file);
    setRemote(null);
    setDraftId(file.id);
    setPending(null);
  };

  const newScript = () => guarded({ kind: "new" }, createDraft);

  const save = async () => {
    if (!active) return;
    if (remote) {
      const sid = remote.runtimeId;
      const ok = useAppStore.getState().workspaces.some((w) => w.runtimeId === sid && w.status === "connected");
      if (!ok) { showToast("服务器已断开，无法写回；内容仍保留在编辑器里", "error"); return; }
      try {
        await driver.sftpWrite(sid, remote.path, textToB64(remote.text));
        setRemote({ ...remote, disk: remote.text });
        showToast(`已保存 ${remote.path}`, "success");
        void loadDir(cwd, sid);
      } catch (e) {
        showToast(`保存失败：${String(e)}`, "error");
      }
      return;
    }
    // 草稿：写到当前远程目录，成功后转成远程文件，后续 Ctrl+S 直接写服务器
    if (!runtimeId || !cwd) { showToast("未连接服务器：内容已作为本地草稿保留", "info"); return; }
    const name = safeName(active.name);
    if (!name) { showToast("文件名不合法：不能含 / \\ 或为 . / ..", "error"); return; }
    const dest = rjoin(cwd, name);
    try {
      await driver.sftpWrite(runtimeId, dest, textToB64(active.content));
      setDraftId(null);
      setRemote({ runtimeId, path: dest, text: active.content, disk: active.content, lang: active.language });
      showToast(`已保存到 ${dest}`, "success");
      void loadDir(cwd);
    } catch (e) {
      showToast(`保存失败：${String(e)}`, "error");
    }
  };

  /** 记录一次内容变更；连续输入（<700ms）合并成一步，撤销时不会一个字符一步 */
  const recordHistory = (text: string, force = false) => {
    if (suppress.current || !active) return;
    const el = codeRef.current;
    const sel: [number, number] = el ? [el.selectionStart, el.selectionEnd] : [0, 0];
    const h = hist.current;
    if (h.id !== active.id) {
      h.id = active.id;
      h.stack = [{ text: active.content, sel: [0, 0] }];
      h.index = 0;
      h.at = 0;
    }
    const now = Date.now();
    const snap = { text, sel };
    if (force || now - h.at > 700) {
      h.stack = h.stack.slice(0, h.index + 1);
      h.stack.push(snap);
      h.index = h.stack.length - 1;
    } else {
      h.stack[h.index] = snap;
    }
    h.at = now;
  };

  const update = (patch: Partial<{ name: string; language: string; content: string }>, forceHistory = false) => {
    if (!active) return;
    if (patch.content !== undefined && patch.content !== active.content) recordHistory(patch.content, forceHistory);
    if (remote) {
      setRemote({
        ...remote,
        text: patch.content ?? remote.text,
        lang: patch.language ?? remote.lang,
      });
    } else if (draft) {
      upsert({ ...draft, ...patch });
    }
  };

  /**
   * 改文件名：扩展名能识别时自动跟随语言（script.sh → Shell）。
   * 识别不出（无扩展名 / 未知后缀）就保留用户已选的语言，避免把 Dockerfile 这类选择冲掉。
   */
  const changeName = (name: string) => {
    if (!draft) { update({ name }); return; }
    const detected = langOf(name);
    upsert({ ...draft, name, language: detected === "纯文本" ? draft.language : detected });
  };

  /** 改语言：把草稿的扩展名一起换成该语言的标准后缀，不再出现 script.sh + Dockerfile 这种错配 */
  const changeLang = (language: string) => {
    if (!draft) { update({ language }); return; }
    const ext = LANG_EXT[language];
    let name = draft.name;
    if (language === "Dockerfile") {
      name = "Dockerfile";
    } else if (ext) {
      // Dockerfile 这种固定文件名没有主干，切到别的语言时用 script 作默认主干，
      // 否则会出现 Dockerfile.sh 这种怪名字
      const isFixedName = name.toLowerCase() === "dockerfile";
      const dot = name.lastIndexOf(".");
      const stem = isFixedName ? "script" : dot > 0 ? name.slice(0, dot) : name;
      name = `${stem || "script"}.${ext}`;
    }
    upsert({ ...draft, language, name });
  };

  /** 写回内容并把光标放回指定位置（React 提交后再设选区，否则会被 value 覆盖） */
  const applyEdit = (next: string, start: number, end = start) => {
    update({ content: next }, true);
    requestAnimationFrame(() => {
      const el = codeRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, Math.min(end, next.length));
    });
  };

  const selectRange = (start: number, end: number) => {
    requestAnimationFrame(() => {
      const el = codeRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(Math.max(0, start), Math.max(0, end));
    });
  };

  const undo = () => {
    const h = hist.current;
    if (h.index <= 0) { showToast("没有可撤销的操作", "info"); return; }
    h.index -= 1;
    const s = h.stack[h.index];
    suppress.current = true;
    update({ content: s.text });
    suppress.current = false;
    selectRange(s.sel[0], s.sel[1]);
  };

  const redo = () => {
    const h = hist.current;
    if (h.index >= h.stack.length - 1) { showToast("没有可重做的操作", "info"); return; }
    h.index += 1;
    const s = h.stack[h.index];
    suppress.current = true;
    update({ content: s.text });
    suppress.current = false;
    selectRange(s.sel[0], s.sel[1]);
  };

  const matchCount = useMemo(() => {
    if (!active || !query) return 0;
    return active.content.toLowerCase().split(query.toLowerCase()).length - 1;
  }, [active, query]);

  /** 从当前位置向后/向前找，找不到就从头/尾绕回 */
  const findIn = (q: string, dir: 1 | -1, from?: number) => {
    const el = codeRef.current;
    if (!active || !q) return;
    const text = active.content;
    const hay = text.toLowerCase();
    const needle = q.toLowerCase();
    const pos = from ?? (dir === 1 ? el?.selectionEnd ?? 0 : el?.selectionStart ?? text.length);
    let idx = dir === 1 ? hay.indexOf(needle, pos) : hay.lastIndexOf(needle, Math.max(0, pos - 1));
    if (idx < 0) idx = dir === 1 ? hay.indexOf(needle) : hay.lastIndexOf(needle);
    if (idx < 0) { showToast(`未找到：${q}`, "error"); return; }
    selectRange(idx, idx + q.length);
  };

  const openFind = () => {
    setBar("find");
    const el = codeRef.current;
    if (el) {
      const sel = active ? active.content.slice(el.selectionStart, el.selectionEnd) : "";
      // 有选区时把选中的词带进查找框，符合直觉
      if (sel && !sel.includes("\n")) setQuery(sel);
    }
  };

  /** Ctrl+D：选中下一个相同片段 / 当前光标所在的词 */
  const selectNextMatch = () => {
    const el = codeRef.current;
    if (!active || !el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    if (s !== e) {
      const word = active.content.slice(s, e);
      const idx = active.content.indexOf(word, e);
      if (idx < 0) { showToast("没有更多匹配", "info"); return; }
      selectRange(idx, idx + word.length);
      return;
    }
    const text = active.content;
    let a = s, b = s;
    while (a > 0 && /[\w$.-]/.test(text[a - 1])) a--;
    while (b < text.length && /[\w$.-]/.test(text[b])) b++;
    if (a === b) return;
    selectRange(a, b);
  };

  const toggleComment = () => {
    const el = codeRef.current;
    if (!active || !el) return;
    const text = active.content;
    const { selectionStart: s, selectionEnd: e } = el;
    const token = COMMENT[active.language] ?? "#";
    const lines = text.split("\n");
    const startLine = text.slice(0, s).split("\n").length - 1;
    let endLine = text.slice(0, e).split("\n").length - 1;
    if (e > s && text[e - 1] === "\n") endLine -= 1;
    const block = lines.slice(startLine, endLine + 1);
    const allCommented = block.every((l) => l.trim() === "" || l.trimStart().startsWith(token));
    const next = block.map((l) => {
      if (l.trim() === "") return l;
      const ind = l.match(/^\s*/)?.[0] ?? "";
      const body = l.slice(ind.length);
      if (allCommented) return ind + body.slice(token.length).replace(/^ /, "");
      return `${ind}${token} ${body}`;
    });
    const nextLines = [...lines.slice(0, startLine), ...next, ...lines.slice(endLine + 1)];
    const nextText = nextLines.join("\n");
    const before = lines.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0);
    const selLen = next.join("\n").length;
    applyEdit(nextText, before, before + selLen);
  };

  const deleteLine = () => {
    const el = codeRef.current;
    if (!active || !el) return;
    const text = active.content;
    const { selectionStart: s, selectionEnd: e } = el;
    const lines = text.split("\n");
    const startLine = text.slice(0, s).split("\n").length - 1;
    let endLine = text.slice(0, e).split("\n").length - 1;
    if (e > s && text[e - 1] === "\n") endLine -= 1;
    const nextLines = [...lines.slice(0, startLine), ...lines.slice(endLine + 1)];
    const nextText = nextLines.join("\n");
    const at = nextLines.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0);
    applyEdit(nextText, Math.min(at, nextText.length));
  };

  const indent = (outdent = false) => {
    const el = codeRef.current;
    if (!active || !el) return;
    const text = active.content;
    const { selectionStart: s, selectionEnd: e } = el;
    const pad = " ".repeat(preferences.editorTabSize);
    // 无选区：光标处直接缩进（与普通编辑器一致）
    if (s === e && !outdent) {
      applyEdit(text.slice(0, s) + pad + text.slice(e), s + pad.length);
      return;
    }
    const lines = text.split("\n");
    const startLine = text.slice(0, s).split("\n").length - 1;
    let endLine = text.slice(0, e).split("\n").length - 1;
    if (e > s && text[e - 1] === "\n") endLine -= 1;
    const next = lines.map((l, i) => {
      if (i < startLine || i > endLine) return l;
      if (!outdent) return pad + l;
      const cut = l.match(new RegExp(`^ {0,${preferences.editorTabSize}}`))?.[0] ?? "";
      return l.slice(cut.length);
    });
    const nextText = next.join("\n");
    const before = next.slice(0, startLine).reduce((n, l) => n + l.length + 1, 0);
    const selLen = next.slice(startLine, endLine + 1).join("\n").length;
    applyEdit(nextText, before, before + selLen);
  };

  const gotoLine = (n: number) => {
    if (!active) return;
    const lines = active.content.split("\n");
    const idx = Math.max(1, Math.min(lines.length, n));
    const at = lines.slice(0, idx - 1).reduce((acc, l) => acc + l.length + 1, 0);
    selectRange(at, at + lines[idx - 1].length);
    setBar(null);
  };

  const runAction = (id: EditorShortcutId) => {
    switch (id) {
      case "find": openFind(); break;
      case "findNext": findIn(query, 1); break;
      case "findPrev": findIn(query, -1); break;
      case "gotoLine": setBar("goto"); setLineInput(String(active ? active.content.slice(0, codeRef.current?.selectionStart ?? 0).split("\n").length : 1)); break;
      case "selectNext": selectNextMatch(); break;
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "selectAll": codeRef.current?.select(); break;
      case "toggleComment": toggleComment(); break;
      case "deleteLine": deleteLine(); break;
      case "indent": indent(false); break;
      case "outdent": indent(true); break;
    }
  };

  const onCodeKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd+S 优先：写回服务器（草稿则落到当前目录）
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
      return;
    }
    // Tab 永远由编辑器接管：否则按下会把焦点移出输入框
    if (e.key === "Tab") {
      e.preventDefault();
      indent(e.shiftKey);
      return;
    }
    const combo = comboOf(e);
    const id = (Object.keys(shortcuts) as EditorShortcutId[]).find((k) => same(shortcuts[k], combo));
    if (!id) return;
    e.preventDefault();
    runAction(id);
  };

  // 快捷键里的 Ctrl+F 被拦截后，查找框要自动聚焦
  useEffect(() => {
    if (bar === "find") document.querySelector<HTMLInputElement>(".editor-find input")?.focus();
    if (bar === "goto") document.querySelector<HTMLInputElement>(".editor-goto input")?.focus();
  }, [bar]);

  // 目录列表：目录在前，同类按名称排序；过滤掉明显不是文本的常见二进制后缀
  const sorted = useMemo(() => [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  }), [entries]);

  return (
    <>
      <div className="editor-shell">
        {/* 左栏从顶部贯到底：服务器选择 + 远端目录树 + 本地草稿，
            与右侧编辑区之间的竖线因此是连续的一条，不会在半空断开。 */}
        <aside className="editor-files">
          <div className="editor-srv">
            <Server size={13} />
            <select
              value={runtimeId}
              onChange={(e) => setRuntimeId(e.target.value)}
              disabled={connected.length === 0}
              aria-label="目标服务器"
              title={connected.find((w) => w.runtimeId === runtimeId)?.session.host}
            >
              {connected.length === 0 && <option value="">未连接（只能写本地草稿）</option>}
              {connected.map((w) => (
                <option key={w.runtimeId} value={w.runtimeId}>{w.session.name}</option>
              ))}
            </select>
          </div>

          <div className="editor-files-head">
            <span>远程文件</span>
          </div>
          <div className="editor-files-list">
            {!runtimeId && <div className="editor-empty">未连接服务器<br />可在下方写本地草稿</div>}
            {runtimeId && loadingDir && entries.length === 0 && <div className="editor-empty">加载中…</div>}
            {runtimeId && !loadingDir && sorted.length === 0 && <div className="editor-empty">空目录</div>}
            {sorted.map((e) => {
              const path = e.path ?? rjoin(cwd, e.name);
              const isOpen = remote?.path === path;
              return (
                <div
                  key={`${e.type}:${path}`}
                  className={`editor-file-item ${isOpen ? "active" : ""} ${pickedPath === path ? "picked" : ""}`}
                  title={`${path}\n单击选中，双击${e.type === "dir" ? "进入目录" : "打开文件"}`}
                  onClick={() => setPickedPath(path)}
                  onDoubleClick={() => {
                    if (e.type === "dir") void loadDir(path);
                    else guarded({ kind: "open", path }, () => void openRemote(path));
                  }}
                >
                  {e.type === "dir"
                    ? <Folder size={13} className="editor-file-icon dir" />
                    : <FileIcon size={13} className="editor-file-icon" />}
                  <span>{e.name}</span>
                  {openingPath === path && <Loader2 size={12} className="spin" />}
                </div>
              );
            })}
          </div>

          <div className="editor-files-head">
            <span>本地草稿</span>
            <button className="icon-btn tiny" title="新建草稿" onClick={newScript}><FilePlus2 size={15} /></button>
          </div>
          <div className="editor-files-list editor-drafts">
            {drafts.length === 0 && <div className="editor-empty">暂无草稿</div>}
            {drafts.map((f) => (
              <div
                key={f.id}
                className={`editor-file-item ${!remote && f.id === draftId ? "active" : ""}`}
                onClick={() => guarded({ kind: "new" }, () => { setRemote(null); setDraftId(f.id); })}
              >
                <FileIcon size={13} className="editor-file-icon" />
                <span>{f.name}</span>
                <button className="icon-btn tiny" title="删除草稿" onClick={(ev) => {
                  ev.stopPropagation();
                  remove(f.id);
                  if (f.id === draftId) setDraftId(null);
                }}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        </aside>

        <div className="editor-right">
          <div className="editor-bar">
            <div className="editor-path">
              <input
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void navigate(); } }}
                placeholder="远程目录路径，回车跳转"
                spellCheck={false}
                disabled={!runtimeId}
              />
              <button className="icon-btn tiny" title="上级目录" disabled={!cwd || cwd === "/"} onClick={() => void loadDir(rparent(cwd))}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn tiny" title="刷新目录" disabled={!runtimeId} onClick={() => void loadDir(cwd)}>
                <RefreshCw size={14} className={loadingDir ? "spin" : undefined} />
              </button>
            </div>
          </div>

          <div className="editor-main">
          {!active ? (
            <div className="editor-placeholder">
              <FilePlus2 size={36} strokeWidth={1.3} />
              <p>点击左侧文件打开，或新建一个脚本</p>
              <button className="btn secondary tiny" onClick={newScript}>新建脚本</button>
            </div>
          ) : (
            <>
              <div className="editor-meta">
                {remote ? (
                  <span className="editor-name-static" title={remote.path}>{active.name}</span>
                ) : (
                  <input className="editor-name" value={active.name} onChange={(e) => changeName(e.target.value)} />
                )}
                {remote ? (
                  // 远程文件的文件名就是服务器上的路径，语言由扩展名决定，改这里没有意义
                  <span className="editor-lang-static" title="语言按文件名扩展名自动识别">{active.language}</span>
                ) : (
                  <select
                    value={active.language}
                    title="切换语言会同时把文件名后缀改成对应的标准扩展名"
                    onChange={(e) => changeLang(e.target.value)}
                  >
                    {LANGS.map((l) => <option key={l}>{l}</option>)}
                  </select>
                )}
                {dirty && <span className="editor-dirty">未保存</span>}
                <span className="spacer" />
                {remote && (
                  <button
                    className="btn ghost tiny"
                    title="丢弃未保存的修改，从服务器重新读取"
                    onClick={() => guarded({ kind: "reload" }, () => void openRemote(remote.path, remote.runtimeId))}
                  >
                    <RefreshCw size={13} /> 重新加载
                  </button>
                )}
                <button className="btn ghost tiny" onClick={() => void save()}><Save size={13} /> 保存</button>
              </div>

              {pending && (
                <div className="editor-confirm">
                  <span>当前文件有未保存的修改，继续会丢失：</span>
                  <button className="btn tiny danger" onClick={() => {
                    const p = pending;
                    setPending(null);
                    if (p.kind === "reload" && remote) void openRemote(remote.path, remote.runtimeId);
                    else if (p.kind === "open") void openRemote(p.path);
                    else if (p.kind === "new") createDraft();
                  }}>放弃修改</button>
                  <button className="btn tiny ghost" onClick={() => setPending(null)}>取消</button>
                </div>
              )}

              {bar === "find" && (
                <div className="editor-find">
                  <Search size={13} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); findIn(query, e.shiftKey ? -1 : 1); }
                      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setBar(null); codeRef.current?.focus(); }
                    }}
                    placeholder="查找…"
                    spellCheck={false}
                  />
                  <span className="editor-find-count">{query ? `${matchCount} 处` : ""}</span>
                  <button className="icon-btn tiny" title="上一个" onClick={() => findIn(query, -1)}><ArrowUp size={13} /></button>
                  <button className="icon-btn tiny" title="下一个" onClick={() => findIn(query, 1)}><ArrowDown size={13} /></button>
                  <button className="icon-btn tiny" title="关闭" onClick={() => { setBar(null); codeRef.current?.focus(); }}><X size={13} /></button>
                </div>
              )}

              {bar === "goto" && (
                <div className="editor-goto">
                  <span>跳转到行</span>
                  <input
                    value={lineInput}
                    onChange={(e) => setLineInput(e.target.value.replace(/[^\d]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); gotoLine(Number(lineInput) || 1); }
                      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setBar(null); codeRef.current?.focus(); }
                    }}
                    placeholder="行号"
                  />
                  <button className="btn tiny" onClick={() => gotoLine(Number(lineInput) || 1)}>跳转</button>
                  <button className="icon-btn tiny" title="关闭" onClick={() => { setBar(null); codeRef.current?.focus(); }}><X size={13} /></button>
                </div>
              )}

              <textarea
                ref={codeRef}
                className="editor-code"
                value={active.content}
                onChange={(e) => update({ content: e.target.value })}
                onKeyDown={onCodeKeyDown}
                style={{ fontSize: preferences.editorFontSize, tabSize: preferences.editorTabSize }}
                wrap={preferences.editorWordWrap ? "soft" : "off"}
                spellCheck={false}
                placeholder="# 在此输入文件内容…"
              />
              <div className="editor-status">
                <span>{active.language}</span>
                <span>{active.content.split("\n").length} 行</span>
                <span>{active.content.length} 字符</span>
                <span className="editor-status-path">
                  {remote ? remote.path : "未保存到服务器"}
                </span>
              </div>
            </>
          )}
        </div>
        </div>
      </div>

      <div className="editor-import">
        <span className="editor-import-label">
          {remote ? <><Server size={15} /> 远程文件</> : <><FileIcon size={15} /> 本地草稿</>}
        </span>
        <span className="editor-target">
          {remote
            ? remote.path
            : runtimeId && cwd
              ? rjoin(cwd, active ? (safeName(active.name) || active.name) : "")
              : "未连接服务器，保存内容只会留在本地草稿"}
        </span>
        <span className="spacer" />
        <button className="btn secondary" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={() => void save()} disabled={!active}><Save size={15} /> 保存</button>
      </div>
    </>
  );
}

export function EditorDialog({ onClose }: Props) {
  const dialogRef = useModal<HTMLDivElement>(onClose);
  return (
    // 与工作台一致：点遮罩不关闭，避免误触丢失正在写的内容
    <div className="modal-overlay">
      <div className="modal editor-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" ref={dialogRef}>
        <div className="modal-head">
          <div><h2 id="editor-title">编辑器</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <EditorDialogContent onClose={onClose} />
      </div>
    </div>
  );
}
