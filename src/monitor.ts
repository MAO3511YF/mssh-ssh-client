import { driver } from "./drivers";
import type { FilesystemEntry, MonitorSnapshot, NetConnection, ProcessEntry } from "./types";

const PROC_COMMANDS = [
  "nginx: worker process", "java -jar app.jar", "mysqld", "node /srv/api/index.js",
  "redis-server 6379", "dockerd", "sshd: /usr/sbin/sshd", "systemd-journald",
  "python3 /opt/agent/main.py", "kubelet", "postgres: wal writer", "prometheus",
];
const PROC_USERS = ["root", "deploy", "www-data", "mysql", "redis", "nobody"];
const NET_STATES = ["ESTABLISHED", "ESTABLISHED", "LISTEN", "TIME_WAIT", "ESTABLISHED"];

/** 浏览器演示模式：生成一份随机监控快照（无定时器，供 MockDriver 直接调用）。 */
export function mockSnapshot(sessionId: string): MonitorSnapshot {
  const seed = Array.from(sessionId).reduce((a, c) => a + c.charCodeAt(0), 0);
  const memTotal = [4, 8, 16, 32][seed % 4];
  const cpuCores = [2, 4, 8, 16][seed % 4];
  const memUsed = Math.round(memTotal * (0.3 + (seed % 4) * 0.1) * 10) / 10;
  const memApp = Math.round(memUsed * 0.62 * 10) / 10;
  const memCache = Math.round((memUsed - memApp) * 10) / 10;
  const swapTotal = Math.round(memTotal * 0.5);
  const swapUsed = Math.round(swapTotal * ((seed % 5) / 20) * 10) / 10;
  const diskTotal = [128, 256, 512, 1024][seed % 4];
  const filesystems: FilesystemEntry[] = [
    { mount: "/", used: Math.round(diskTotal * (0.25 + (seed % 3) * 0.15)), total: diskTotal },
    { mount: "/data", used: Math.round(diskTotal * 0.4), total: diskTotal * 2 },
  ];
  const cpu = 8 + Math.round(Math.random() * 18);
  const netIn = Math.round(Math.random() * 40);
  const netOut = Math.round(Math.random() * 25);
  const history = Array.from({ length: 24 }, () => 8 + Math.round(Math.random() * 18));
  const netHistory = Array.from({ length: 24 }, () => Math.round(Math.random() * 60));
  const processes: ProcessEntry[] = Array.from({ length: 8 }, (_, i) => ({
    pid: 800 + ((seed * 37 + i * 911) % 28000),
    user: PROC_USERS[(seed + i) % PROC_USERS.length],
    cpu: Math.round((18 - i * 1.8 + Math.random() * 4) * 10) / 10,
    mem: Math.round((12 - i * 1.1 + Math.random() * 3) * 10) / 10,
    command: PROC_COMMANDS[(seed + i) % PROC_COMMANDS.length],
  })).sort((a, b) => b.cpu - a.cpu);
  const randIp = (s: number, i: number) => `10.0.${(s + i) % 255}.${(s * 3 + i * 41) % 255}`;
  const connections: NetConnection[] = Array.from({ length: 5 }, (_, i) => ({
    proto: i % 2 === 0 ? "tcp" : "tcp6",
    local: `${randIp(seed, i)}:${[22, 80, 443, 8080, 5432][i]}`,
    remote: `${randIp(seed + 7, i)}:${[51023, 44312, 38091, 20154, 55001][i]}`,
    state: NET_STATES[i % NET_STATES.length],
  }));
  const loadBase = cpu / 100 * cpuCores;
  return {
    sessionId,
    uptime: `${Math.floor(seed / 6)}h ${seed % 60}m`,
    load: [loadBase, loadBase * 0.86, loadBase * 0.72].map((n) => Math.round(n * 10) / 10) as [number, number, number],
    cpu,
    cpuCores,
    memUsed, memTotal, memApp, memCache, swapUsed, swapTotal,
    filesystems,
    diskRead: Math.round(Math.random() * 60),
    diskWrite: Math.round(Math.random() * 40),
    netIn, netOut,
    processes, connections, history, netHistory,
  };
}

/**
 * 监控采集器：Tauri 环境定时调用后端真实采集；浏览器环境用本地随机数据。
 * store.ts 里连接建立时 `monitorRegistry.set(runtimeId, new Monitor(runtimeId))`。
 */
export class Monitor {
  private timer: number | null = null;
  private listeners = new Set<(s: MonitorSnapshot | null) => void>();
  private sessionId: string;
  private snapshotCache: MonitorSnapshot | null = null;
  private inFlight = false;
  private realtime: boolean;

  constructor(sessionId: string, _autoStart = true) {
    this.sessionId = sessionId;
    this.realtime = driver.kind === "tauri";
    // 立即给一份快照，避免面板首帧空白
    this.snapshotCache = this.realtime ? null : mockSnapshot(sessionId);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 1500);
  }

  private async tick() {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const snap: MonitorSnapshot | null = this.realtime
        ? await driver.collectMonitor(this.sessionId)
        : mockSnapshot(this.sessionId);
      this.snapshotCache = snap;
      this.listeners.forEach((fn) => fn(snap));
    } catch {
      // 原生驱动采集失败时绝不回退到模拟数据，立即清空快照让面板显示连接失败
      if (this.realtime && this.snapshotCache) {
        this.snapshotCache = null;
        this.listeners.forEach((fn) => fn(null));
      }
    } finally {
      this.inFlight = false;
    }
  }

  subscribe(fn: (s: MonitorSnapshot | null) => void) {
    this.listeners.add(fn);
    if (this.snapshotCache) fn(this.snapshotCache);
    return () => { this.listeners.delete(fn); };
  }

  /** 原生环境只返回真实采集到的快照；返回 null 表示监控不可用 */
  snapshot(): MonitorSnapshot | null {
    return this.snapshotCache;
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.listeners.clear();
  }
}
