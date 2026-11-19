import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { useAppStore } from "../store";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
}

export function FolderDialog({ onClose }: Props) {
  const addFolder = useAppStore((s) => s.addFolder);
  const folders = useAppStore((s) => s.folders);
  const dialogRef = useModal<HTMLDivElement>(onClose);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const submit = () => {
    const v = name.trim();
    if (!v) { setError("请输入工作区名称"); return; }
    if (folders.includes(v)) { setError("该工作区已存在"); return; }
    addFolder(v);
    onClose();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="folder-title" ref={dialogRef}>
        <div className="modal-head">
          <div><h2 id="folder-title">新建工作区</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <label className="field wide">
            <span>工作区名称 <b>*</b></span>
            <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError(""); }} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder="例如：生产环境" />
            {error && <small className="err">{error}</small>}
          </label>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}><FolderPlus size={15} /> 创建</button>
        </div>
      </div>
    </div>
  );
}
