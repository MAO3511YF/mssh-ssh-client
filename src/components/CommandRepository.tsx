import { useMemo, useState } from "react";
import { Pencil, Play, Plus, Search, TextCursorInput, Trash2, X } from "lucide-react";
import { useAppStore } from "../store";
import type { SavedCommand } from "../types";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
}

const empty = (): SavedCommand => ({ id: "", name: "", command: "", group: "常用", description: "" });

/** 命令仓库主体，可独立弹窗，也可嵌入合并工具窗口 */
export function CommandRepositoryContent({ onClose }: Props) {
  const commands = useAppStore((s) => s.commands);
  const upsert = useAppStore((s) => s.upsertCommand);
  const remove = useAppStore((s) => s.deleteCommand);
  const setDraft = useAppStore((s) => s.setGlobalDraft);
  const activeId = useAppStore((s) => s.activeId);
  const writeToWorkspace = useAppStore((s) => s.writeToWorkspace);
  const showToast = useAppStore((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedCommand | null>(null);
  const [form, setForm] = useState<SavedCommand>(empty());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => [c.name, c.command, c.group, c.description].some((v) => v?.toLowerCase().includes(q))) : commands;
  }, [commands, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, SavedCommand[]>();
    for (const c of filtered) map.set(c.group, [...(map.get(c.group) ?? []), c]);
    return Array.from(map.entries());
  }, [filtered]);

  // 不传参数＝新建：必须把 editing 置成空对象，否则表单不会展开（此前点了没反应）
  const startEdit = (c?: SavedCommand) => {
    setEditing(c ? { ...c } : empty());
    setForm(c ? { ...c } : empty());
  };

  const save = () => {
    if (!form.name.trim() || !form.command.trim()) { showToast("请填写名称与命令内容", "error"); return; }
    upsert({ ...form, id: form.id || `c-${Date.now()}`, group: form.group.trim() || "常用" });
    setEditing(null);
    setForm(empty());
    showToast("已保存命令", "success");
  };

  const send = (c: SavedCommand) => {
    if (!activeId) { showToast("请先打开一个工作区", "error"); return; }
    writeToWorkspace(activeId, c.command);
    showToast(`已发送：${c.command}`, "success");
  };

  return (
    <>
      <div className="repo-toolbar">
        <div className="search-input"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索命令…" /></div>
        <button className="btn primary tiny" onClick={() => startEdit()}><Plus size={14} /> 新增命令</button>
      </div>

      {editing && (
        <div className="repo-editor">
          <div className="repo-editor-grid">
            <label className="field"><span>名称</span><input autoFocus={!form.id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：查看磁盘" /></label>
            <label className="field"><span>分组</span><input value={form.group} onChange={(e) => setForm({ ...form, group: e.target.value })} /></label>
            <label className="field wide"><span>命令内容</span><input value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="df -h" spellCheck={false} /></label>
            <label className="field wide"><span>说明</span><input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="可选" /></label>
          </div>
          <div className="repo-editor-foot">
            <button className="btn ghost tiny" onClick={() => setEditing(null)}>取消</button>
            <button className="btn primary tiny" onClick={save}>保存</button>
          </div>
        </div>
      )}

      <div className="modal-body repo-list">
        {grouped.map(([group, items]) => (
          <div className="repo-group" key={group}>
            <div className="repo-group-head">{group} <span>{items.length}</span></div>
            {items.map((c) => (
              <div className="repo-row" key={c.id}>
                <div className="repo-row-main">
                  <div className="repo-row-name">{c.name}</div>
                  <code className="repo-row-cmd">{c.command}</code>
                  {c.description && <div className="repo-row-desc">{c.description}</div>}
                </div>
                <div className="repo-row-actions">
                  <button className="icon-btn tiny" title="填入群发栏（不立即执行）" onClick={() => { setDraft(c.command); showToast("已填入群发栏", "info"); onClose(); }}><TextCursorInput size={14} /></button>
                  <button className="icon-btn tiny" title="立即发送到当前终端" onClick={() => send(c)}><Play size={14} /></button>
                  <button className="icon-btn tiny" title="编辑" onClick={() => startEdit(c)}><Pencil size={14} /></button>
                  <button className="icon-btn tiny danger" title="删除" onClick={() => remove(c.id)}><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {grouped.length === 0 && <div className="repo-empty">没有匹配的命令</div>}
      </div>
    </>
  );
}

export function CommandRepository({ onClose }: Props) {
  const dialogRef = useModal<HTMLDivElement>(onClose);
  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="repo-title" ref={dialogRef}>
        <div className="modal-head">
          <div><h2 id="repo-title">命令仓库</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <CommandRepositoryContent onClose={onClose} />
      </div>
    </div>
  );
}
