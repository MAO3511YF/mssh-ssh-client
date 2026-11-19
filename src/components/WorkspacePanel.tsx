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
        {!filesOpen && (
          <button className="files-expand" onClick={() => toggleFiles(runtimeId)} title="展开文件面板">
            <ChevronUp size={9} />
          </button>
        )}
      </Panel>

      {filesOpen && (
        <>
          <PanelResizeHandle className="resize-handle horizontal files-handle">
            <div className="resize-line" />
            <button
              className="files-collapse"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => toggleFiles(runtimeId)}
              title="收起文件面板"
            >
              <ChevronDown size={9} />
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
