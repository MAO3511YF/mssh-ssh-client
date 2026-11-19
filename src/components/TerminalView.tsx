import { useEffect, useRef } from "react";
import { createTerminal } from "../terminal";
import { sessionLog, terminalRegistry } from "../runtime";

interface Props {
  sessionId: string;
}

export function TerminalView({ sessionId }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = createTerminal(host, sessionId);
    terminalRegistry.set(sessionId, handle.terminal);
    // 窗格重建（拖动标签、分屏）后回放之前的输出
    const history = sessionLog.get(sessionId);
    if (history) handle.terminal.write(history);
    return () => {
      terminalRegistry.delete(sessionId);
      handle.dispose();
    };
  }, [sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}
