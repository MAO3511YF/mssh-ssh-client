import { useState } from "react";
import { LogOut, MinusCircle, X } from "lucide-react";
import { useModal } from "../useModal";
import { useAppStore } from "../store";
import type { Preferences } from "../types";

interface Props {
  onClose: () => void;
  onQuit: () => void;
  onHide: () => void;
}

/** 未设置默认关闭行为时，点击 X 弹出的选择提示。 */
export function CloseDialog({ onClose, onQuit, onHide }: Props) {
  const ref = useModal<HTMLDivElement>(onClose);
  const setPref = useAppStore((s) => s.setPreference);
  const [remember, setRemember] = useState(false);

  const choose = (action: Preferences["closeAction"]) => {
    if (remember) setPref("closeAction", action);
    if (action === "quit") onQuit();
    else onHide();
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal close-dialog" role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <div><h2>关闭 MSSH</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="close-choices">
          <button className="close-choice" onClick={() => choose("quit")}>
            <span className="close-choice-ico danger"><LogOut size={20} /></span>
            <span className="close-choice-text"><b>退出程序</b><small>结束所有连接并关闭 MSSH</small></span>
          </button>
          <button className="close-choice" onClick={() => choose("tray")}>
            <span className="close-choice-ico accent"><MinusCircle size={20} /></span>
            <span className="close-choice-text"><b>隐藏到后台</b><small>保持连接，从托盘继续运行</small></span>
          </button>
        </div>
        <label className="close-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>记住我的选择，以后不再询问</span>
        </label>
        <div className="modal-foot"><span className="spacer" /><button className="btn" onClick={onClose}>取消</button></div>
      </div>
    </div>
  );
}
