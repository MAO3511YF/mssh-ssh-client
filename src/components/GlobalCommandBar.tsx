import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Check, ChevronDown, History, Layers3, Minus, Send, Server, Trash2, X } from "lucide-react";
import { useAppStore } from "../store";

type TargetState = { all: boolean; ids: string[] };

/** 同一台服务器（user@host:port）上开的多个窗口合并成一行，勾选即整台服务器都收到命令 */
type ServerGroup = {
  key: string;
  name: string;
  username: string;
  host: string;
  port: number;
  color?: string;
  ids: string[];
};

export function GlobalCommandBar() {
  const draft = useAppStore((s) => s.globalDraft);
  const setDraft = useAppStore((s) => s.setGlobalDraft);
  const workspaces = useAppStore((s) => s.workspaces);
  const writeToWorkspace = useAppStore((s) => s.writeToWorkspace);
  const showToast = useAppStore((s) => s.showToast);
  const [targetState, setTargetState] = useGlobalTarget();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, bottom: 0 });
  const [historyOpen, setHistoryOpen] = useState(false);
  const commandHistory = useAppStore((s) => s.commandHistory);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const idxRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const histRef = useRef<HTMLDivElement>(null);
  const histBtnRef = useRef<HTMLButtonElement>(null);
  const histPopRef = useRef<HTMLDivElement>(null);

  const connected = workspaces.filter((w) => w.status === "connected");
  const connectedIds = connected.map((w) => w.runtimeId);
  const validIdSet = new Set(connectedIds);

  // 按服务器归并：同一台机器开三个终端只占一行，避免目标列表里三行一模一样
  const groups = useMemo<ServerGroup[]>(() => {
    const map = new Map<string, ServerGroup>();
    for (const w of connected) {
      const key = `${w.session.username}@${w.session.host}:${w.session.port}`;
      const group = map.get(key);
      if (group) group.ids.push(w.runtimeId);
      else map.set(key, {
        key,
        name: w.session.name,
        username: w.session.username,
        host: w.session.host,
        port: w.session.port,
        color: w.session.color,
        ids: [w.runtimeId],
      });
    }
    return [...map.values()];
  }, [connected]);

  // 窗口关闭后清理失效的勾选，避免残留目标
  useEffect(() => {
    if (targetState.all) return;
    const ids = targetState.ids.filter((id) => validIdSet.has(id));
    if (ids.length !== targetState.ids.length) setTargetState({ all: false, ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  // 点击面板外部关闭；窗口尺寸变化时关闭，避免定位漂移
  useEffect(() => {
    if (!menuOpen && !historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuOpen && !wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setMenuOpen(false);
      if (historyOpen && !histRef.current?.contains(t) && !histPopRef.current?.contains(t)) setHistoryOpen(false);
    };
    const onResize = () => { setMenuOpen(false); setHistoryOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen, historyOpen]);

  const toggleHistory = () => {
    if (!historyOpen && histBtnRef.current) {
      const r = histBtnRef.current.getBoundingClientRect();
      setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    }
    setHistoryOpen((v) => !v);
  };

  const pickHistory = (cmd: string) => {
    setDraft(cmd);
    idxRef.current = commandHistory.indexOf(cmd);
    setHistoryOpen(false);
  };

  const toggleMenu = () => {
    if (!menuOpen && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setMenuPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
    }
    setMenuOpen((v) => !v);
  };

  const selectedIdSet = targetState.all
    ? new Set(connectedIds)
    : new Set(targetState.ids.filter((id) => validIdSet.has(id)));
  const selectedCount = selectedIdSet.size;
  const allSelected = connected.length > 0 && selectedCount === connected.length;
  // 目标以「服务器」为单位：同一台机器的多个终端只算一台，与列表行数一致
  const selectedServers = groups.filter((g) => g.ids.some((id) => selectedIdSet.has(id))).length;

  const toggleAll = () => {
    setTargetState(targetState.all || allSelected ? { all: false, ids: [] } : { all: true, ids: [] });
  };

  /** 选中集合统一收敛：覆盖全部窗口时折叠成 all，否则记录具体 runtimeId */
  const applySelection = (next: Set<string>) => {
    if (connected.length > 0 && next.size === connected.length) setTargetState({ all: true, ids: [] });
    else setTargetState({ all: false, ids: [...next].filter((id) => validIdSet.has(id)) });
  };

  const toggleGroup = (group: ServerGroup) => {
    const next = new Set(selectedIdSet);
    const allOn = group.ids.every((id) => next.has(id));
    group.ids.forEach((id) => { if (allOn) next.delete(id); else next.add(id); });
    applySelection(next);
  };

  const broadcast = () => {
    const value = draft.trim();
    if (!value) { showToast("先输入要发送的命令", "info"); return; }
    if (connected.length === 0) { showToast("没有已连接的窗口", "error"); return; }
    if (selectedCount === 0) { showToast("请先选择发送目标", "error"); return; }
    const targets = connected.filter((w) => selectedIdSet.has(w.runtimeId));
    targets.forEach((w, i) => writeToWorkspace(w.runtimeId, value, { recordHistory: i === 0 }));
    const serverCount = new Set(targets.map((w) => `${w.session.username}@${w.session.host}:${w.session.port}`)).size;
    showToast(
      targets.length === serverCount
        ? `已发送到 ${serverCount} 台服务器`
        : `已发送到 ${serverCount} 台服务器（${targets.length} 个窗口）`,
      "success"
    );
    setDraft("");
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); broadcast(); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      const history = useAppStore.getState().commandHistory;
      if (history.length && idxRef.current > 0) setDraft(history[--idxRef.current]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const history = useAppStore.getState().commandHistory;
      if (idxRef.current < history.length - 1) setDraft(history[++idxRef.current]);
      else { idxRef.current = history.length; setDraft(""); }
    }
  };

  const targetLabel = selectedCount === 0
    ? "选择发送目标"
    : allSelected
      ? "全部服务器"
      : `已选 ${selectedServers} 台服务器`;

  return (
    <div className="global-bar">
      <div className="gb-target-wrap" ref={wrapRef}>
        <button
          ref={btnRef}
          className={`gb-target-btn${menuOpen ? " open" : ""}${selectedCount === 0 ? " empty" : ""}`}
          onClick={toggleMenu}
          title="选择发送目标窗口"
          aria-expanded={menuOpen}
        >
          <Layers3 size={14} className="gb-target-icon" />
          <span className="gb-target-label">{targetLabel}</span>
          <span className="gb-target-badge">{selectedServers}</span>
          <ChevronDown size={12} className={`gb-chev${menuOpen ? " rot" : ""}`} />
        </button>
      </div>

      {menuOpen && createPortal(
        <div
          ref={popRef}
          className="gb-popover"
          style={{ left: menuPos.left, bottom: menuPos.bottom }}
          role="dialog"
          aria-label="选择发送目标"
        >
          <div className="gb-pop-head">
            <div>
              <div className="gb-pop-title">发送目标</div>
              <div className="gb-pop-sub">同一台服务器的多个窗口合并为一台，勾选即全部接收</div>
            </div>
            <button className="gb-pop-close" onClick={() => setMenuOpen(false)} title="关闭" aria-label="关闭">
              <X size={14} />
            </button>
          </div>

          <div className="gb-pop-list">
            <button
              className={`gb-row gb-row-all${allSelected ? " checked" : ""}`}
              onClick={toggleAll}
              role="checkbox"
              aria-checked={allSelected}
            >
              <span className={`gb-check${allSelected ? " checked" : ""}`}>{allSelected && <Check size={12} strokeWidth={3} />}</span>
              <span className="gb-row-icon all"><AppWindow size={15} /></span>
              <span className="gb-row-text">
                <span className="gb-row-name">所有服务器</span>
                <span className="gb-row-meta">
                  {connected.length > groups.length
                    ? `${groups.length} 台服务器 · ${connected.length} 个终端`
                    : "广播到全部已连接终端"}
                </span>
              </span>
              <span className="gb-row-count">{groups.length}</span>
            </button>

            <div className="gb-pop-divider"><span>服务器列表</span></div>

            {groups.length > 0 ? groups.map((g) => {
              const on = g.ids.filter((id) => selectedIdSet.has(id)).length;
              const checked = on === g.ids.length;
              const partial = on > 0 && !checked;
              return (
                <button
                  key={g.key}
                  className={`gb-row${checked ? " checked" : ""}${partial ? " partial" : ""}`}
                  onClick={() => toggleGroup(g)}
                  role="checkbox"
                  aria-checked={partial ? "mixed" : checked}
                  title={g.ids.length > 1 ? `${g.name} 上打开了 ${g.ids.length} 个终端` : `${g.username}@${g.host}:${g.port}`}
                >
                  <span className={`gb-check${checked ? " checked" : ""}${partial ? " partial" : ""}`}>
                    {checked ? <Check size={12} strokeWidth={3} /> : partial ? <Minus size={12} strokeWidth={3} /> : null}
                  </span>
                  <span className="gb-row-icon" style={{ color: g.color ?? "var(--accent)" }}><Server size={15} /></span>
                  <span className="gb-row-text">
                    <span className="gb-row-name">{g.name}</span>
                    <span className="gb-row-meta">{g.username}@{g.host}:{g.port}</span>
                  </span>
                  {g.ids.length > 1
                    ? <span className="gb-row-count multi" title={`该服务器有 ${g.ids.length} 个终端`}>{g.ids.length} 个终端</span>
                    : <span className="gb-row-dot" />}
                </button>
              );
            }) : <div className="gb-pop-empty">暂无已连接服务器</div>}
          </div>

          <div className="gb-pop-foot">
            <span className="gb-pop-summary">
              已选 <b>{selectedCount}</b> / {connected.length} 个终端
            </span>
            <button className="gb-pop-done" onClick={() => setMenuOpen(false)}>完成</button>
          </div>
        </div>,
        document.body
      )}

      <div className="gb-hist-wrap" ref={histRef}>
        <button
          ref={histBtnRef}
          className={`gb-hist-btn${historyOpen ? " open" : ""}`}
          onClick={toggleHistory}
          title="命令历史（也可在输入框按 ↑ / ↓ 翻阅）"
          aria-expanded={historyOpen}
        >
          <History size={15} />
          <span>历史</span>
          {commandHistory.length > 0 && <span className="gb-hist-badge">{commandHistory.length}</span>}
        </button>
      </div>
      {historyOpen && createPortal(
        <div
          ref={histPopRef}
          className="gb-popover gb-hist-pop"
          style={{ left: menuPos.left, bottom: menuPos.bottom }}
          role="dialog"
          aria-label="命令历史"
        >
          <div className="gb-pop-head">
            <div>
              <div className="gb-pop-title">命令历史</div>
              <div className="gb-pop-sub">最近 {commandHistory.length} 条 · 点击回填，输入框 ↑/↓ 也可翻阅</div>
            </div>
            <button className="gb-pop-close" onClick={() => setHistoryOpen(false)} title="关闭" aria-label="关闭">
              <X size={14} />
            </button>
          </div>
          <div className="gb-pop-list">
            {commandHistory.length > 0 ? [...commandHistory].reverse().map((cmd, i) => (
              <button
                key={`${i}-${cmd}`}
                className="gb-hist-row"
                onClick={() => pickHistory(cmd)}
                title={cmd}
              >
                <span className="gb-hist-idx">{commandHistory.length - i}</span>
                <span className="gb-hist-cmd">{cmd}</span>
              </button>
            )) : <div className="gb-pop-empty">暂无历史命令</div>}
          </div>
          <div className="gb-pop-foot">
            <span className="gb-pop-summary">历史保存在本机</span>
            <button className="gb-pop-done danger" onClick={() => { clearHistory(); showToast("命令历史已清空", "success"); }}>
              <Trash2 size={13} /> 清空
            </button>
          </div>
        </div>,
        document.body
      )}

      <input
        className="gb-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder="输入命令，↑/↓ 翻阅历史"
        spellCheck={false}
      />
      <button className="gb-send" onClick={broadcast} title="群发命令" disabled={!draft.trim()}>
        <Send size={15} /> <span>群发</span>
      </button>
    </div>
  );
}

// 目标选择状态保存在模块级（非持久化，随界面生命周期）
let globalTarget: TargetState = { all: true, ids: [] };
const targetListeners = new Set<(v: TargetState) => void>();

function useGlobalTarget(): [TargetState, (v: TargetState) => void] {
  const [value, setValue] = useState(globalTarget);
  useEffect(() => {
    const fn = (next: TargetState) => setValue(next);
    targetListeners.add(fn);
    return () => { targetListeners.delete(fn); };
  }, []);
  const set = useCallback((next: TargetState) => {
    globalTarget = next;
    targetListeners.forEach((fn) => fn(next));
  }, []);
  return [value, set];
}
