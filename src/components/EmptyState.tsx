import { Plus } from "lucide-react";

interface Props {
  onNew: () => void;
}

export function EmptyState({ onNew }: Props) {
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
      <h2>开始你的第一个 SSH 连接</h2>
      <p>连接到远程主机，执行命令、传输文件并实时监控系统资源。</p>
      <button className="btn primary" onClick={onNew}><Plus size={16} /> New Connection</button>
    </div>
  );
}
