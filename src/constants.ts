import type { AuthType, ConnectionType, SavedCommand, TransferProtocol } from "./types";

export const TYPE_META: Record<ConnectionType, { label: string; short: string }> = {
  ssh: { label: "SSH 终端", short: "SSH" },
  transfer: { label: "文件传输", short: "SFTP" },
  scp: { label: "SCP 传输", short: "SCP" },
};

export const CONNECTION_TYPES: ConnectionType[] = ["ssh", "transfer", "scp"];

export const PROTOCOLS: { value: TransferProtocol; label: string }[] = [
  { value: "sftp", label: "SFTP" },
  { value: "ftp", label: "FTP" },
];

export const AUTH_METHODS: { value: AuthType; label: string }[] = [
  { value: "password", label: "密码" },
  { value: "privateKey", label: "私钥" },
  { value: "agent", label: "SSH Agent" },
  { value: "none", label: "不验证" },
];

export const ENV_OPTIONS = ["生产环境", "测试环境", "开发环境", "本地环境"];

export const COLOR_LABELS: { value: string; label: string }[] = [
  { value: "#4f7cff", label: "蓝" },
  { value: "#22a06b", label: "绿" },
  { value: "#e8912d", label: "橙" },
  { value: "#d1495b", label: "红" },
  { value: "#8b5cf6", label: "紫" },
  { value: "#0891b2", label: "青" },
];

/**
 * 品牌文字可选字体。
 * 前 6 款为打包进应用的字体（public/fonts），无需系统预装，效果真实一致；
 * 后几款为常见风格系统字体，作为额外差异选项。每款均带中文兜底。
 */
export const BRAND_FONTS: { value: string; label: string }[] = [
  { value: "", label: "系统默认" },
  { value: "'MSSH KuaiLe', 'Microsoft YaHei', sans-serif", label: "快乐体 · 圆润手写" },
  { value: "'MSSH HuangYou', 'Microsoft YaHei', sans-serif", label: "黄油体 · 粗圆可爱" },
  { value: "'MSSH XiaoWei', 'Microsoft YaHei', serif", label: "小薇体 · 清新宋体" },
  { value: "'MSSH MaShan', 'Microsoft YaHei', cursive", label: "马善政 · 毛笔手写" },
  { value: "'MSSH Quicksand', 'Microsoft YaHei', sans-serif", label: "Quicksand · 圆润" },
  { value: "'MSSH Fredoka', 'Microsoft YaHei', sans-serif", label: "Fredoka · 活泼圆体" },
  { value: "'KaiTi', 'STKaiti', '楷体', serif", label: "楷体 · 传统书写" },
  { value: "'YouYuan', '幼圆', 'Microsoft YaHei', sans-serif", label: "幼圆 · 圆润" },
  { value: "'LiSu', '隶书', 'STLiti', serif", label: "隶书 · 古朴" },
];

export const DEFAULT_COMMANDS: SavedCommand[] = [
  { id: "c1", name: "查看磁盘占用", command: "df -h", group: "系统", description: "显示各分区磁盘使用情况" },
  { id: "c2", name: "查看内存", command: "free -h", group: "系统", description: "显示内存使用情况" },
  { id: "c3", name: "系统负载", command: "uptime", group: "系统", description: "查看运行时间与负载" },
  { id: "c4", name: "进程列表", command: "ps aux --sort=-%mem | head -20", group: "系统", description: "按内存排序的进程" },
  { id: "c5", name: "当前目录", command: "pwd", group: "文件", description: "显示当前工作目录" },
  { id: "c6", name: "列出文件", command: "ls -lah", group: "文件", description: "详细列出当前目录文件" },
  { id: "c7", name: "查找大文件", command: "find . -type f -size +100M -exec ls -lh {} \\;", group: "文件", description: "查找超过 100M 的文件" },
  { id: "c8", name: "Docker 容器", command: "docker ps -a", group: "运维", description: "列出所有容器" },
  { id: "c9", name: "Git 状态", command: "git status", group: "开发", description: "查看仓库状态" },
  { id: "c10", name: "监听端口", command: "ss -tlnp", group: "运维", description: "查看监听中的端口" },
];
