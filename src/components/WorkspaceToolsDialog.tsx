import { Command, SquarePen, X } from "lucide-react";
import { useModal } from "../useModal";
import { CommandRepositoryContent } from "./CommandRepository";
import { EditorDialogContent } from "./EditorDialog";

export type ToolsTab = "commands" | "editor";

interface Props {
  onClose: () => void;
  /** 受控：文件面板里点「在编辑器打开」时由 App 直接切到 editor 页 */
  tab: ToolsTab;
  onTab: (tab: ToolsTab) => void;
}

/** 命令仓库与编辑器合并为一个窗口 */
export function WorkspaceToolsDialog({ onClose, tab, onTab }: Props) {
  const dialogRef = useModal<HTMLDivElement>(onClose);

  return (
    // 点遮罩不再关闭：工作台里有正在编辑的表单/代码，误点空白处就丢失太糟，只保留右上角 X 与 Esc
    <div className="modal-overlay">
      <div className="modal tools-page" role="dialog" aria-modal="true" aria-labelledby="tools-title" ref={dialogRef}>
        <div className="modal-head tools-head">
          <div><h2 id="tools-title">工作台</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
          <div className="tools-tabs">
            <button className={`tools-tab ${tab === "commands" ? "on" : ""}`} onClick={() => onTab("commands")}>
              <Command size={15} /> 命令仓库
            </button>
            <button className={`tools-tab ${tab === "editor" ? "on" : ""}`} onClick={() => onTab("editor")}>
              <SquarePen size={15} /> 编辑器
            </button>
          </div>
        </div>
        <div className="tools-content">
          {/* 两个页面都保持挂载、只切显示：否则从编辑器切到命令仓库再切回来，
              正在编辑（可能还没保存到服务器）的内容会被直接卸载丢掉。 */}
          <div className="tools-pane" style={{ display: tab === "commands" ? "contents" : "none" }}>
            <CommandRepositoryContent onClose={onClose} />
          </div>
          <div className="tools-pane" style={{ display: tab === "editor" ? "contents" : "none" }}>
            <EditorDialogContent onClose={onClose} />
          </div>
        </div>
      </div>
    </div>
  );
}
