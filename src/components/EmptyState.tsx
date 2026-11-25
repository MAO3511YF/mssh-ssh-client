import { Plus, Terminal as TerminalIcon } from "lucide-react";
import { useAppStore } from "../store";

interface Props {
  onNew: () => void;
}

/**
 * 工作区为空时的引导页。
 * 已经保存过连接时不再说「开始你的第一个连接」——那和左侧列表自相矛盾，
 * 直接把最近用过的几个连接摆出来，点一下就能开。
 */
export function EmptyState({ onNew }: Props) {
  const sessions = useAppStore((s) => s.sessions);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const recent = [...sessions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);

  return (
    <div className="empty-state">
      <div className="empty-illustration">
        <svg viewBox="0 0 220 150" width="220" height="150" aria-hidden="true">
          <rect x="30" y="24" width="160" height="102" rx="10" fill="var(--panel)" stroke="var(--line)" strokeWidth="1.5" />
          <rect x="30" y="24" width="160" height="26" rx="10" fill="var(--line-soft)" />
          <circle cx="44" cy="37" r="3.4" fill="var(--muted)" opacity="0.5" />
          <circle cx="56" cy="37" r="3.4" fill="var(--muted)" opacity="0.5" />
          <circle cx="68" cy="37" r="3.4" fill="var(--muted)" opacity="0.5" />
          <rect x="42" y="64" width="66" height="7" rx="3.5" fill="var(--line)" />
          <rect x="42" y="78" width="94" height="7" rx="3.5" fill="var(--line)" />
          <rect x="42" y="92" width="52" height="7" rx="3.5" fill="var(--line)" />
          <rect x="118" y="104" width="62" height="22" rx="6" fill="var(--accent)" opacity="0.12" />
          <path d="M149 110v10M144 115h10" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>

      {recent.length > 0 ? (
        <>
          <h2>还没有打开的终端</h2>
          <p>点一个已保存的连接直接打开，也可以新建一个。</p>
          <div className="empty-recent">
            {recent.map((s) => (
              <button
                key={s.id}
                className="empty-recent-row"
                onClick={() => openWorkspace(s)}
                title={`打开 ${s.username}@${s.host}:${s.port}`}
              >
                <span className="empty-recent-dot" style={{ background: s.color ?? "var(--accent)" }} />
                <span className="empty-recent-name">{s.name}</span>
                <code className="empty-recent-host">{s.username}@{s.host}</code>
                <TerminalIcon size={14} className="empty-recent-open" />
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={onNew}><Plus size={16} /> 新建连接</button>
        </>
      ) : (
        <>
          <h2>开始你的第一个 SSH 连接</h2>
          <p>连接到远程主机，执行命令、传输文件并实时监控系统资源。</p>
          <button className="btn primary" onClick={onNew}><Plus size={16} /> 新建连接</button>
        </>
      )}
    </div>
  );
}
