import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FilePlus2, Save, Search, Trash2, Upload, X } from "lucide-react";
import { useAppStore } from "../store";
import { DEFAULT_EDITOR_SHORTCUTS, type EditorFile, type EditorShortcutId } from "../types";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
}

const LANGS = ["纯文本", "Shell", "YAML", "JSON", "JavaScript", "Python", "Markdown", "Dockerfile"];

/** 各语言的注释前缀 */
const COMMENT: Record<string, string> = {
  Shell: "#", YAML: "#", Python: "#", Dockerfile: "#", JavaScript: "//", JSON: "//",
};

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
  const files = useAppStore((s) => s.editorFiles);
  const upsert = useAppStore((s) => s.upsertEditorFile);
  const remove = useAppStore((s) => s.deleteEditorFile);
  const importFile = useAppStore((s) => s.importFileToHost);
  const sessions = useAppStore((s) => s.sessions);
  const preferences = useAppStore((s) => s.preferences);

  const [activeId, setActiveId] = useState<string | null>(files[0]?.id ?? null);
  const [targetHost, setTargetHost] = useState(sessions[0]?.host ?? "");
  const [remotePath, setRemotePath] = useState("/home/deploy");
  const [bar, setBar] = useState<null | "find" | "goto">(null);
  const [query, setQuery] = useState("");
  const [lineInput, setLineInput] = useState("");

  const codeRef = useRef<HTMLTextAreaElement>(null);
  /** 自建撤销栈：textarea 是受控组件，编辑都走 React state，浏览器原生 undo 栈是空的 */
  const hist = useRef<{ id: string | null; stack: { text: string; sel: [number, number] }[]; index: number; at: number }>({
    id: null, stack: [], index: -1, at: 0,
  });
  const suppress = useRef(false);
  const active = files.find((f) => f.id === activeId) ?? null;
  const shortcuts = { ...DEFAULT_EDITOR_SHORTCUTS, ...(preferences.editorShortcuts ?? {}) };

  const create = () => {
    const file: EditorFile = { id: `f-${Date.now()}`, name: "untitled.txt", language: "纯文本", content: "" };
    upsert(file);
    setActiveId(file.id);
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

  const update = (patch: Partial<EditorFile>, forceHistory = false) => {
    if (!active) return;
    if (patch.content !== undefined && patch.content !== active.content) recordHistory(patch.content, forceHistory);
    upsert({ ...active, ...patch });
  };

  const alertMsg = (m: string) => useAppStore.getState().showToast(m, "error");

  const doImport = () => {
    if (!active) { alertMsg("请先新建或选择文件"); return; }
    if (!targetHost.trim()) { alertMsg("请选择目标服务器"); return; }
    importFile(targetHost, active, remotePath);
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
    if (h.index <= 0) { useAppStore.getState().showToast("没有可撤销的操作", "info"); return; }
    h.index -= 1;
    const s = h.stack[h.index];
    suppress.current = true;
    update({ content: s.text });
    suppress.current = false;
    selectRange(s.sel[0], s.sel[1]);
  };

  const redo = () => {
    const h = hist.current;
    if (h.index >= h.stack.length - 1) { useAppStore.getState().showToast("没有可重做的操作", "info"); return; }
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
    if (idx < 0) { useAppStore.getState().showToast(`未找到：${q}`, "error"); return; }
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
      if (idx < 0) { useAppStore.getState().showToast("没有更多匹配", "info"); return; }
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
      const indent = l.match(/^\s*/)?.[0] ?? "";
      const body = l.slice(indent.length);
      if (allCommented) return indent + body.slice(token.length).replace(/^ /, "");
      return `${indent}${token} ${body}`;
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

  return (
    <>
      <div className="editor-body">
        <div className="editor-files">
          <div className="editor-files-head">
            <span>文件</span>
            <button className="icon-btn tiny" title="新建文件" onClick={create}><FilePlus2 size={15} /></button>
          </div>
          <div className="editor-files-list">
            {files.length === 0 && <div className="editor-empty">暂无文件</div>}
            {files.map((f) => (
              <div key={f.id} className={`editor-file-item ${f.id === activeId ? "active" : ""}`} onClick={() => setActiveId(f.id)}>
                <span>{f.name}</span>
                <button className="icon-btn tiny" title="删除" onClick={(e) => {
                  e.stopPropagation();
                  remove(f.id);
                  if (f.id === activeId) setActiveId(files.find((x) => x.id !== f.id)?.id ?? null);
                }}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <button className="editor-new-btn" onClick={create}><FilePlus2 size={14} /> 新建文件</button>
        </div>

        <div className="editor-main">
          {!active ? (
            <div className="editor-placeholder">
              <FilePlus2 size={36} strokeWidth={1.3} />
              <p>选择或新建一个文件</p>
              <button className="btn secondary tiny" onClick={create}>新建文件</button>
            </div>
          ) : (
            <>
              <div className="editor-meta">
                <input className="editor-name" value={active.name} onChange={(e) => update({ name: e.target.value })} />
                <select value={active.language} onChange={(e) => update({ language: e.target.value })}>
                  {LANGS.map((l) => <option key={l}>{l}</option>)}
                </select>
                <button className="btn ghost tiny" onClick={() => useAppStore.getState().showToast("草稿已保存", "success")}><Save size={13} /> 保存草稿</button>
              </div>

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
              </div>
            </>
          )}
        </div>
      </div>

      <div className="editor-import">
        <span className="editor-import-label"><Upload size={15} /> 导入到服务器</span>
        <select value={targetHost} onChange={(e) => setTargetHost(e.target.value)} aria-label="目标服务器">
          <option value="">选择目标服务器…</option>
          {sessions.map((s) => <option key={s.id} value={s.host}>{s.name} · {s.host}</option>)}
        </select>
        <input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="远程路径" spellCheck={false} />
        <span className="spacer" />
        <button className="btn secondary" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={doImport}><Upload size={15} /> 导入到服务器</button>
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
