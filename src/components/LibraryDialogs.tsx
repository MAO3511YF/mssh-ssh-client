import { useMemo, useState } from "react";
import { FolderX, Pencil, Trash2, X } from "lucide-react";
import { useAppStore } from "../store";
import { useModal } from "../useModal";
import type { SessionConfig } from "../types";

interface CloseProps { onClose: () => void; }

/** 通用重命名弹窗：工作区目录 / 连接共用。 */
export function RenameDialog({
  title, label, initial, target, entityId, onClose,
}: CloseProps & {
  title: string; label: string; initial: string;
  target: "folder" | "session";
  /** session 重命名时的会话 id；folder 重命名用 initial 作为目录名 */
  entityId?: string;
}) {
  const renameFolder = useAppStore((s) => s.renameFolder);
  const renameSession = useAppStore((s) => s.renameSession);
  const showToast = useAppStore((s) => s.showToast);
  const folders = useAppStore((s) => s.folders);
  const ref = useModal<HTMLDivElement>(onClose);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");

  const submit = () => {
    const v = value.trim();
    if (!v) { setError(`${label}不能为空`); return; }
    if (target === "folder" && v !== initial && folders.includes(v)) {
      setError("该工作区已存在"); return;
    }
    if (target === "folder") renameFolder(initial, v);
    else if (entityId) renameSession(entityId, v);
    showToast("已重命名", "success");
    onClose();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <div><h2>{title}</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <label className="field wide">
            <span>{label} <b>*</b></span>
            <input autoFocus value={value} onChange={(e) => { setValue(e.target.value); setError(""); }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
            {error && <small className="err">{error}</small>}
          </label>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}><Pencil size={15} /> 保存</button>
        </div>
      </div>
    </div>
  );
}

/** 删除连接确认弹窗。 */
export function DeleteSessionDialog({ session, onClose }: CloseProps & { session: SessionConfig }) {
  const deleteSession = useAppStore((s) => s.deleteSession);
  const showToast = useAppStore((s) => s.showToast);
  const ref = useModal<HTMLDivElement>(onClose);

  const confirm = () => {
    deleteSession(session.id);
    showToast(`已删除连接「${session.name}」`, "success");
    onClose();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <div><h2>删除连接</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="confirm-text">确定删除连接 <b>{session.name}</b> 吗？<br /><span>({session.username}@{session.host}:{session.port})</span></p>
          <p className="confirm-hint">仅删除保存的连接配置，不会影响已经打开的连接。</p>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn danger-solid" onClick={confirm}><Trash2 size={15} /> 删除</button>
        </div>
      </div>
    </div>
  );
}

/** 删除工作区弹窗：若含连接，提示是否合并并选择目标工作区。 */
export function DeleteFolderDialog({ name, onClose }: CloseProps & { name: string }) {
  const folders = useAppStore((s) => s.folders);
  const sessions = useAppStore((s) => s.sessions);
  const deleteFolder = useAppStore((s) => s.deleteFolder);
  const showToast = useAppStore((s) => s.showToast);
  const ref = useModal<HTMLDivElement>(onClose);

  const members = useMemo(
    () => sessions.filter((s) => (s.directory?.trim() || "默认工作区") === name),
    [sessions, name],
  );
  const targets = useMemo(
    () => Array.from(new Set([...folders, ...sessions.map((s) => s.directory?.trim()).filter(Boolean) as string[]]))
      .filter((f) => f !== name),
    [folders, sessions, name],
  );

  const [merge, setMerge] = useState(true);
  const [target, setTarget] = useState(targets[0] ?? "默认工作区");
  const hasMembers = members.length > 0;

  const confirm = () => {
    if (hasMembers && merge && !target.trim()) { return; }
    deleteFolder(name, hasMembers && merge ? target : undefined);
    showToast(
      hasMembers && merge
        ? `已删除工作区「${name}」，${members.length} 个连接已合并到「${target}」`
        : `已删除工作区「${name}」`,
      "success",
    );
    onClose();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <div><h2>删除工作区</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="confirm-text">确定删除工作区 <b>{name}</b> 吗？</p>
          {hasMembers ? (
            <>
              <p className="confirm-hint">该工作区下有 <b>{members.length}</b> 个连接，请选择如何处理：</p>
              <label className="radio-row">
                <input type="radio" name="folder-merge" checked={merge} onChange={() => setMerge(true)} />
                <span>合并连接到其他工作区</span>
              </label>
              {merge && (
                <label className="field wide merge-select">
                  <span>合并到</span>
                  <select value={target} onChange={(e) => setTarget(e.target.value)}>
                    {targets.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </label>
              )}
              <label className="radio-row">
                <input type="radio" name="folder-merge" checked={!merge} onChange={() => setMerge(false)} />
                <span>仅删除工作区，连接移入「默认工作区」</span>
              </label>
            </>
          ) : (
            <p className="confirm-hint">该工作区为空，删除不会影响任何连接。</p>
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn danger-solid" onClick={confirm}><FolderX size={15} /> 删除</button>
        </div>
      </div>
    </div>
  );
}
