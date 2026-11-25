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

/** 自适应速率单位： KB/s → MB/s → GB/s，避免超长数字撑破卡片 */
function fmtRate(kbPerSec: number): string {
  const n = Number.isFinite(kbPerSec) ? Math.max(0, kbPerSec) : 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} GB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB/s`;
  return `${n.toFixed(n >= 100 ? 0 : 1)} KB/s`;
}

/** 折线图：固定 Y 轴上限 + 渐变填充 + 网格线；fixedMax 用于百分比场景（如 CPU 固定 0-100） */
function Sparkline({ values, color = "var(--accent)", fixedMax, unit = "" }: {
  values: number[]; color?: string; fixedMax?: number; unit?: string;
}) {
  const W = 100;
  const H = 32;
  const max = fixedMax ?? Math.max(...values, 1) * 1.15;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const y = (v: number) => H - 2 - (Math.min(v, max) / max) * (H - 5);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${x(0)},${H} ${pts} ${x(n - 1)},${H}`;
  const last = values[n - 1] ?? 0;
  const gradId = `spark-grad-${color.replace(/[^a-z0-9]/gi, "")}-${fixedMax ?? "auto"}`;
  return (
    <div className="spark-wrap">
      <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="0" y1={H / 2} x2={W} y2={H / 2} className="spark-grid" />
        <polygon points={area} fill={`url(#${gradId})`} />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {n > 0 && <circle cx={x(n - 1)} cy={y(last)} r="2.4" fill={color} vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="spark-now" style={{ color }}>{last.toFixed(1)}{unit}</span>
    </div>
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

  const memPct = snap.memTotal ? Math.round(snap.memUsed / snap.memTotal * 100) : 0;
  const swapPct = snap.swapTotal ? Math.round(snap.swapUsed / snap.swapTotal * 100) : 0;
  const mainFs = snap.filesystems[0];
  const diskPct = mainFs && mainFs.total ? Math.round(mainFs.used / mainFs.total * 100) : 0;
  // GPU 完全来自后端真实采集（nvidia-smi）；没有则整块不显示，绝不用 CPU 推导假值
  const gpu = snap.gpu;

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
          {/* 磁盘信息采集不到时整项隐藏，不再显示 "/ 0/1G" 之类的假数据 */}
          {mainFs && (
            <Meter icon={HardDrive} label="磁盘" value={`${diskPct}%`} detail={`${mainFs.used}/${mainFs.total}G`} detail2={snap.filesystems.map((f) => `${f.mount} ${f.total ? Math.round(f.used / f.total * 100) : 0}%`).join(" · ")} />
          )}
        </div>

        {/* 仅当后端真实检测到 GPU 时才显示这一整块 */}
        {gpu && (
          <div className="mon-section">
            <div className="mon-section-head"><span>GPU</span><span className="mon-badge">{gpu.name}</span></div>
            <Meter icon={Zap} label="使用率" value={`${Math.round(gpu.utilization)}%`} />
            <Meter icon={MemoryStick} label="显存" value={`${gpu.memTotal ? Math.round(gpu.memUsed / gpu.memTotal * 100) : 0}%`} detail={`${(gpu.memUsed / 1024).toFixed(1)}/${(gpu.memTotal / 1024).toFixed(1)}G`} />
            {(gpu.temperature !== null || gpu.power !== null) && (
              <div className="mon-mini-row">
                {gpu.temperature !== null && <span><ThermometerSun size={12} /> 温度 {Math.round(gpu.temperature)}°C</span>}
                {gpu.power !== null && <span><Zap size={12} /> 功耗 {Math.round(gpu.power)}W</span>}
              </div>
            )}
          </div>
        )}

        <div className="mon-section">
          <div className="mon-section-head"><span>CPU 趋势</span><small>最近 36 秒 · 峰值 {Math.round(Math.max(...snap.history, 0))}%</small></div>
          <Sparkline values={snap.history} fixedMax={100} unit="%" />
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>磁盘 IO</span><small>实时速率</small></div>
          <div className="mon-io-row">
            <span><span className="net-dot down" /> 读取 <b>{fmtRate(snap.diskRead)}</b></span>
            <span><span className="net-dot up" /> 写入 <b>{fmtRate(snap.diskWrite)}</b></span>
          </div>
        </div>

        <div className="mon-section">
          <div className="mon-section-head"><span>网络</span><Network size={12} /></div>
          <Sparkline values={snap.netHistory} color="var(--success)" unit=" KB/s" />
          <div className="mon-io-row">
            <span><span className="net-dot up" /> 下行 <b>{fmtRate(snap.netIn)}</b></span>
            <span><span className="net-dot down" /> 上行 <b>{fmtRate(snap.netOut)}</b></span>
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
