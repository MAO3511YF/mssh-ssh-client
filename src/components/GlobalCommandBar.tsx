import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Check, ChevronDown, Layers3, Send, Terminal, X } from "lucide-react";
import { useAppStore } from "../store";

type TargetState = { all: boolean; ids: string[] };

export function GlobalCommandBar() {
  const draft = useAppStore((s) => s.globalDraft);
  const setDraft = useAppStore((s) => s.setGlobalDraft);
  const workspaces = useAppStore((s) => s.workspaces);
  const writeToWorkspace = useAppStore((s) => s.writeToWorkspace);
  const showToast = useAppStore((s) => s.showToast);
  const [targetState, setTargetState] = useGlobalTarget();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, bottom: 0 });
  const idxRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const connected = workspaces.filter((w) => w.status === "connected");
  const connectedIds = connected.map((w) => w.runtimeId);
  const validIdSet = new Set(connectedIds);

  // 窗口关闭后清理失效的勾选，避免残留目标
  useEffect(() => {
    if (targetState.all) return;
    const ids = targetState.ids.filter((id) => validIdSet.has(id));
    if (ids.length !== targetState.ids.length) setTargetState({ all: false, ids });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  // 点击面板外部关闭；窗口尺寸变化时关闭，避免定位漂移
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !popRef.current?.contains(t)) setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen]);

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

  const toggleAll = () => {
    setTargetState(targetState.all || allSelected ? { all: false, ids: [] } : { all: true, ids: [] });
  };

  const toggleOne = (runtimeId: string) => {
    if (targetState.all) {
      // 从「全选」切换为手动：保留除当前项外的其他窗口
      setTargetState({ all: false, ids: connectedIds.filter((id) => id !== runtimeId) });
      return;
    }
    const has = targetState.ids.includes(runtimeId);
    const ids = has ? targetState.ids.filter((id) => id !== runtimeId) : [...targetState.ids, runtimeId];
    const valid = ids.filter((id) => validIdSet.has(id));
    if (connected.length > 0 && valid.length === connected.length) setTargetState({ all: true, ids: [] });
    else setTargetState({ all: false, ids: valid });
  };

  const broadcast = () => {
    const value = draft.trim();
    if (!value) return;
    if (connected.length === 0) { showToast("没有已连接的窗口", "error"); return; }
    if (selectedCount === 0) { showToast("请先选择发送目标", "error"); return; }
    const targets = connected.filter((w) => selectedIdSet.has(w.runtimeId));
    targets.forEach((w, i) => writeToWorkspace(w.runtimeId, value, { recordHistory: i === 0 }));
    showToast(`已发送到 ${targets.length} 个窗口`, "success");
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
      ? "所有窗口"
      : `已选 ${selectedCount} 个窗口`;

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
          <span className="gb-target-badge">{selectedCount}</span>
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
              <div className="gb-pop-sub">勾选要接收命令的窗口，可多选</div>
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
                <span className="gb-row-name">所有窗口</span>
                <span className="gb-row-meta">广播到全部已连接终端</span>
              </span>
              <span className="gb-row-count">{connected.length}</span>
            </button>

            <div className="gb-pop-divider"><span>窗口列表</span></div>

            {connected.length > 0 ? connected.map((w) => {
              const checked = selectedIdSet.has(w.runtimeId);
              return (
                <button
                  key={w.runtimeId}
                  className={`gb-row${checked ? " checked" : ""}`}
                  onClick={() => toggleOne(w.runtimeId)}
                  role="checkbox"
                  aria-checked={checked}
                >
                  <span className={`gb-check${checked ? " checked" : ""}`}>{checked && <Check size={12} strokeWidth={3} />}</span>
                  <span className="gb-row-icon" style={{ color: w.session.color ?? "var(--accent)" }}><Terminal size={15} /></span>
                  <span className="gb-row-text">
                    <span className="gb-row-name">{w.session.name}</span>
                    <span className="gb-row-meta">{w.session.username}@{w.session.host}:{w.session.port}</span>
                  </span>
                  <span className="gb-row-dot" />
                </button>
              );
            }) : <div className="gb-pop-empty">暂无已连接窗口</div>}
          </div>

          <div className="gb-pop-foot">
            <span className="gb-pop-summary">已选 <b>{selectedCount}</b> / {connected.length} 个窗口</span>
            <button className="gb-pop-done" onClick={() => setMenuOpen(false)}>完成</button>
          </div>
        </div>,
        document.body
      )}

      <input
        className="gb-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        spellCheck={false}
      />
      <button className="gb-send" onClick={broadcast} title="群发命令">
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
