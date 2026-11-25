import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { ChevronDown, ChevronUp } from "lucide-react";
import { terminalRegistry } from "../runtime";
import { useAppStore } from "../store";
import type { Workspace } from "../types";
import { TerminalView } from "./TerminalView";
import { FileTransferPanel } from "./FileTransferPanel";

interface Props {
  workspace: Workspace;
  active: boolean;
}

export function WorkspacePanel({ workspace, active }: Props) {
  const { runtimeId, session, filesOpen } = workspace;
  const toggleFiles = useAppStore((s) => s.toggleFiles);

  useEffect(() => {
    if (active) terminalRegistry.get(runtimeId)?.focus();
  }, [active, runtimeId]);

  return (
    <PanelGroup direction="vertical" className="wpanel-group">
      <Panel defaultSize={filesOpen ? 62 : 100} minSize={20} className="wpanel-stage">
        <div className="wpanel-term">
          <TerminalView sessionId={runtimeId} />
        </div>
        {/* 收起态：终端底部一条与终端同色的切换条，常亮按钮占布局高度，不覆盖终端文字 */}
        {!filesOpen && (
          <div className="files-toggle-bar">
            <button className="files-grip" onClick={() => toggleFiles(runtimeId)} title="展开文件面板">
              <ChevronUp size={14} />
            </button>
          </div>
        )}
      </Panel>

      {filesOpen && (
        <>
          {/* 展开态：这条切换条同时是可拖拽的分隔条，文件面板紧贴其下，中间无空白。
              不画贯穿整宽的强调线——那会像一道横贯终端的彩色裂缝，只在按钮上给反馈。
              hitArea 不做外扩：这一条本身有 26px 高，够抓了，再外扩会让终端的最后一行也变成
              上下调高度的光标。 */}
          <PanelResizeHandle className="resize-handle horizontal files-handle files-toggle-bar" hitAreaMargins={{ fine: 0, coarse: 8 }}>
            <button
              className="files-grip"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => toggleFiles(runtimeId)}
              title="收起文件面板"
            >
              <ChevronDown size={14} />
            </button>
          </PanelResizeHandle>
          <Panel defaultSize={38} minSize={15} className="wpanel-files-panel">
            <FileTransferPanel host={session.host} protocol={session.protocol ?? "sftp"} runtimeId={runtimeId} />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
