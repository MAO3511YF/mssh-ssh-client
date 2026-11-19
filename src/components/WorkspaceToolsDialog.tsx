import { useState } from "react";
import { Command, SquarePen, X } from "lucide-react";
import { useModal } from "../useModal";
import { CommandRepositoryContent } from "./CommandRepository";
import { EditorDialogContent } from "./EditorDialog";

export type ToolsTab = "commands" | "editor";

interface Props {
  onClose: () => void;
  initialTab?: ToolsTab;
}

/** 命令仓库与编辑器合并为一个窗口 */
export function WorkspaceToolsDialog({ onClose, initialTab = "commands" }: Props) {
  const [tab, setTab] = useState<ToolsTab>(initialTab);
  const dialogRef = useModal<HTMLDivElement>(onClose);

  return (
    // 点遮罩不再关闭：工作台里有正在编辑的表单/代码，误点空白处就丢失太糟，只保留右上角 X 与 Esc
    <div className="modal-overlay">
      <div className="modal tools-page" role="dialog" aria-modal="true" aria-labelledby="tools-title" ref={dialogRef}>
        <div className="modal-head tools-head">
          <div><h2 id="tools-title">工作台</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
          <div className="tools-tabs">
            <button className={`tools-tab ${tab === "commands" ? "on" : ""}`} onClick={() => setTab("commands")}>
              <Command size={15} /> 命令仓库
            </button>
            <button className={`tools-tab ${tab === "editor" ? "on" : ""}`} onClick={() => setTab("editor")}>
              <SquarePen size={15} /> 编辑器
            </button>
          </div>
        </div>
        <div className="tools-content">
          {tab === "commands" ? <CommandRepositoryContent onClose={onClose} /> : <EditorDialogContent onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
