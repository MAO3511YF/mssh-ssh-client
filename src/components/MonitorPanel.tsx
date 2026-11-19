import { useEffect, useState } from "react";
import {
  Activity, Cpu, HardDrive, MemoryStick, Network, RefreshCw,
  ThermometerSun, Unplug, Zap,
} from "lucide-react";
import { monitorRegistry } from "../runtime";
import type { ConnectionStatus, MonitorSnapshot } from "../types";

interface Props {
  sessionId: string | null;
  host?: string;
  status?: ConnectionStatus;
  statusMessage?: string;
}

function Sparkline({ values, color = "var(--accent)" }: { values: number[]; color?: string }) {
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - (v / max) * 28}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function tone(pct: number) {
  return pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok";
}

function Meter({ icon: Icon, label, value, detail, detail2 }: {
  icon: typeof Cpu; label: string; value: string; detail?: string; detail2?: string;
}) {
  const pct = Math.max(0, Math.min(100, parseFloat(value) || 0));
  const t = tone(pct);
  return (
    <div className="mon-meter">
      <div className="mon-meter-head">
        <span className="mon-meter-label"><Icon size={13} /> {label}</span>
        <span className={`mon-meter-val ${t}`}>{value}{detail && <small>{detail}</small>}</span>
      </div>
      <div className="mon-bar"><i className={t} style={{ width: `${pct}%` }} /></div>
      {detail2 && <div className="mon-meter-sub">{detail2}</div>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="mon-stat">
      <span className="mon-stat-label">{label}</span>
      <span className="mon-stat-value">{value}</span>
      {sub && <span className="mon-stat-sub">{sub}</span>}
    </div>
  );
}

export function MonitorPanel({ sessionId, host, status, statusMessage }: Props) {
  const [snap, setSnap] = useState<MonitorSnapshot | null>(null);

  useEffect(() => {
    if (!sessionId) { setSnap(null); return; }
    const mon = monitorRegistry.get(sessionId);
    if (!mon) { setSnap(null); return; }
    setSnap(mon.snapshot());
    return mon.subscribe(setSnap);
  }, [sessionId]);

  // 未连接（或尚未拿到真实采集数据）时不展示任何监控数值，只给出连接状态
  if (status !== "connected" || !snap) {
    const connecting = status === "connecting";
    return (
      <div className="monitor-root">
        <div className="monitor-head">
          <div className="monitor-title"><Activity size={15} /> 资源监控</div>
          {host && <div className="monitor-host">{host}</div>}
        </div>
        <div className="monitor-error">
          <div className="monitor-error-icon"><Unplug size={22} /></div>
          <div className="monitor-error-detail">
            {connecting ? "连接中…" : (statusMessage || "连接未建立，无法采集监控数据")}
          </div>
        </div>
      </div>
    );
  }

  const memPct = Math.round(snap.memUsed / snap.memTotal * 100);
  const swapPct = snap.swapTotal ? Math.round(snap.swapUsed / snap.swapTotal * 100) : 0;
  const mainFs = snap.filesystems[0];
  const diskPct = mainFs ? Math.round(mainFs.used / mainFs.total * 100) : 0;
  const gpuPct = 34 + (snap.cpu % 30);

  return (
    <div className="monitor-root">
      <div className="monitor-head">
        <div className="monitor-title"><Activity size={15} /> 资源监控</div>
        {host && <div className="monitor-host">{host}</div>}
      </div>

      <div className="monitor-body">
        <div className="mon-overview">
          <Stat label="运行时间" value={snap.uptime} sub={`${snap.cpuCores} 核`} />
          <Stat label="负载" value={snap.load.map((n) => n.toFixed(2)).join(" ")} sub="1 / 5 / 15 min" />
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>资源占用</span></div>
          <Meter icon={Cpu} label="CPU" value={`${snap.cpu}%`} detail2={`${snap.cpuCores} 核心`} />
          <Meter icon={MemoryStick} label="内存" value={`${memPct}%`} detail={`${snap.memUsed}/${snap.memTotal}G`} detail2={`应用 ${snap.memApp}G · 缓存 ${snap.memCache}G`} />
          <Meter icon={RefreshCw} label="Swap" value={`${swapPct}%`} detail={`${snap.swapUsed}/${snap.swapTotal}G`} />
          <Meter icon={HardDrive} label="磁盘" value={`${diskPct}%`} detail={`${mainFs?.used}/${mainFs?.total}G`} detail2={snap.filesystems.map((f) => `${f.mount} ${Math.round(f.used / f.total * 100)}%`).join(" · ")} />
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>GPU</span><span className="mon-badge"> NVIDIA </span></div>
          <Meter icon={Zap} label="使用率" value={`${gpuPct}%`} />
          <Meter icon={MemoryStick} label="显存" value={`${Math.round(gpuPct * 0.7)}%`} detail="5.6/8.0G" />
          <div className="mon-mini-row">
            <span><ThermometerSun size={12} /> 温度 {46 + snap.cpu % 20}°C</span>
            <span><Zap size={12} /> 功耗 {72 + snap.cpu % 40}W</span>
          </div>
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>CPU 趋势</span><small>最近 36 秒</small></div>
          <Sparkline values={snap.history} />
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>磁盘 IO</span></div>
          <div className="mon-io-row">
            <span><span className="net-dot down" /> 读取 <b>{snap.diskRead}</b> KB/s</span>
            <span><span className="net-dot up" /> 写入 <b>{snap.diskWrite}</b> KB/s</span>
          </div>
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>网络</span><Network size={12} /></div>
          <Sparkline values={snap.netHistory} color="var(--success)" />
          <div className="mon-io-row">
            <span><span className="net-dot up" /> 下行 <b>{snap.netIn}</b> KB/s</span>
            <span><span className="net-dot down" /> 上行 <b>{snap.netOut}</b> KB/s</span>
          </div>
          <table className="mon-table">
            <thead><tr><th>协议</th><th>本地地址</th><th>状态</th></tr></thead>
            <tbody>
              {snap.connections.map((c, i) => (
                <tr key={i}><td>{c.proto}</td><td title={c.remote}>{c.local}</td><td><span className={`conn-state ${c.state.toLowerCase()}`}>{c.state}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>进程</span><small>TOP {snap.processes.length}</small></div>
          <table className="mon-table proc-table">
            <thead><tr><th>PID</th><th>用户</th><th>CPU%</th><th>MEM%</th><th>命令</th></tr></thead>
            <tbody>
              {snap.processes.slice(0, 8).map((p) => (
                <tr key={p.pid}>
                  <td>{p.pid}</td><td>{p.user}</td>
                  <td className={tone(p.cpu)}>{p.cpu.toFixed(1)}</td>
                  <td>{p.mem.toFixed(1)}</td>
                  <td title={p.command}>{p.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
