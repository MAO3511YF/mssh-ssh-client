// ===== 连接与会话 =====

export type ConnectionType = "ssh" | "transfer" | "scp";
export type TransferProtocol = "sftp" | "ftp";
export type ConnectionStatus = "idle" | "connecting" | "connected" | "error" | "closed";
export type AuthType = "password" | "privateKey" | "agent" | "none";

export interface SessionConfig {
  id: string;
  type: ConnectionType;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 所属工作区（侧栏分组，必填） */
  directory: string;
  authMethod: AuthType;
  password?: string;
  privateKeyPath?: string;
  /** 仅连接时临时传给后端：凭据库中对应的原始连接 id（标签运行时 id 不带这个字段落盘） */
  secretId?: string;
  protocol?: TransferProtocol;
  env?: Record<string, string>;
  note?: string;
  color?: string;
  createdAt: number;
}

export interface Workspace {
  runtimeId: string;
  session: SessionConfig;
  status: ConnectionStatus;
  statusMessage?: string;
  filesOpen: boolean;
}

/** 一个视图窗格：持有若干标签及当前激活的标签（VS Code editor group 风格） */
export interface TabPane {
  tabs: string[];
  activeTab: string | null;
}

// ===== 布局 / 提示 =====

export interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

/** 编辑器内可自定义的快捷键动作 */
export type EditorShortcutId =
  | "find" | "gotoLine" | "findNext" | "selectNext"
  | "findPrev" | "undo" | "redo" | "selectAll"
  | "toggleComment" | "deleteLine" | "indent" | "outdent";

/** 编辑器快捷键的展示顺序与名称 */
export const EDITOR_SHORTCUTS: { id: EditorShortcutId; label: string }[] = [
  { id: "find", label: "查找" },
  { id: "gotoLine", label: "跳转到行" },
  { id: "findNext", label: "查找下一个" },
  { id: "selectNext", label: "选择下一个匹配项" },
  { id: "findPrev", label: "查找上一个" },
  { id: "undo", label: "撤销" },
  { id: "redo", label: "重做" },
  { id: "selectAll", label: "全选" },
  { id: "toggleComment", label: "切换注释" },
  { id: "deleteLine", label: "删除当前行" },
  { id: "indent", label: "缩进或插入 Tab" },
  { id: "outdent", label: "反向缩进" },
];

export const DEFAULT_EDITOR_SHORTCUTS: Record<EditorShortcutId, string> = {
  find: "Ctrl+F",
  gotoLine: "Ctrl+G",
  findNext: "F3",
  selectNext: "Ctrl+D",
  findPrev: "Shift+F3",
  undo: "Ctrl+Z",
  redo: "Ctrl+Y",
  selectAll: "Ctrl+A",
  toggleComment: "Ctrl+/",
  deleteLine: "Ctrl+Shift+K",
  indent: "Tab",
  outdent: "Shift+Tab",
};

/** 鼠标与快捷键偏好 */
export interface Preferences {
  /** 文件列表左键行为 */
  leftClick: "open" | "select";
  /** 文件列表右键行为 */
  rightClick: "menu" | "copyPath";
  /** 终端右键直接粘贴 */
  terminalRightPaste: boolean;
  /** 断线自动重连 */
  terminalAutoReconnect: boolean;
  /** 选中终端文本自动复制 */
  terminalCopyOnSelect: boolean;
  /** 终端连接提示符 */
  terminalPrompt: boolean;
  /** 终端响铃 */
  terminalBell: boolean;
  /** 鼠标中键行为 */
  terminalMiddleClick: "none" | "paste";
  /** 拦截 Ctrl+V 从剪贴板粘贴 */
  terminalCtrlVPaste: boolean;
  /** 最大缓存行数 */
  terminalScrollback: number;
  /** 清屏时保留屏幕内容 */
  terminalKeepOnClear: boolean;
  /** 编辑器字号 */
  editorFontSize: number;
  /** 编辑器 Tab 缩进空格数 */
  editorTabSize: number;
  /** 编辑器自动换行 */
  editorWordWrap: boolean;
  /** 编辑器内快捷键（可在设置里逐项修改） */
  editorShortcuts: Record<EditorShortcutId, string>;
  /** 复制 */
  copy: string;
  /** 粘贴 */
  paste: string;
  /** 复制路径 */
  copyPath: string;
  /** 搜索命令 */
  search: string;
  /** 新建连接 */
  newConnection: string;
  /** 关闭标签 */
  closeTab: string;
  /** 点击窗口关闭按钮时的行为：每次询问 / 退出程序 / 隐藏到后台 */
  closeAction: "ask" | "quit" | "tray";
  /** 最多可分屏的窗格数量 */
  maxPanes: 2 | 3 | 4;
  /** 侧栏分隔条的配色浓度：以主题强调色混入面板色的比例（0-100） */
  railTint: number;
  /** 侧栏分隔条宽度（px） */
  railWidth: 4 | 6 | 8 | 10;
  /** 分隔条上是否显示折叠箭头 */
  railChevron: boolean;
  /** 是否显示顶栏品牌文字（关闭即隐藏字样） */
  brandVisible: boolean;
  /** 品牌文字内容 */
  brandText: string;
  /** 品牌字体 font-family（空串=跟随系统 UI 字体） */
  brandFont: string;
  /** 品牌字号 px */
  brandFontSize: number;
  /** 品牌字重 */
  brandWeight: 400 | 500 | 600 | 700 | 800;
  /** 品牌文字颜色（空串=跟随主题文字色） */
  brandColor: string;
  /** 品牌字间距 px */
  brandSpacing: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  leftClick: "select",
  rightClick: "menu",
  terminalRightPaste: true,
  terminalAutoReconnect: false,
  terminalCopyOnSelect: false,
  terminalPrompt: true,
  terminalBell: false,
  terminalMiddleClick: "none",
  terminalCtrlVPaste: true,
  terminalScrollback: 3000,
  terminalKeepOnClear: true,
  editorFontSize: 12,
  editorTabSize: 2,
  editorWordWrap: true,
  editorShortcuts: { ...DEFAULT_EDITOR_SHORTCUTS },
  copy: "Ctrl+C",
  paste: "Ctrl+V",
  copyPath: "Ctrl+Shift+C",
  search: "Ctrl+K",
  newConnection: "Ctrl+N",
  closeTab: "Ctrl+W",
  closeAction: "ask",
  maxPanes: 4,
  railTint: 20,
  railWidth: 6,
  railChevron: true,
  brandVisible: true,
  brandText: "MSSH",
  brandFont: "",
  brandFontSize: 13,
  brandWeight: 700,
  brandColor: "",
  brandSpacing: 0.3,
};

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
}

// ===== 命令仓库 =====

export interface SavedCommand {
  id: string;
  name: string;
  command: string;
  group: string;
  description?: string;
}

// ===== 编辑器 / 远程文件 =====

export interface EditorFile {
  id: string;
  name: string;
  language: string;
  content: string;
}

export interface RemoteFileEntry {
  name: string;
  size: string;
  modified: string;
  type: "dir" | "file";
  path?: string;
  content?: string;
}

/** sftp_read 返回：base64 字节 + 是否文本文件 */
export interface FileContent {
  path: string;
  contentBase64: string;
  isText: boolean;
  size: number;
}

// ===== 监控 =====

export interface ProcessEntry {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

export interface NetConnection {
  proto: string;
  local: string;
  remote: string;
  state: string;
}

export interface FilesystemEntry {
  mount: string;
  used: number;
  total: number;
}

export interface MonitorSnapshot {
  sessionId: string;
  uptime: string;
  load: [number, number, number];
  cpu: number;
  cpuCores: number;
  memUsed: number;
  memTotal: number;
  memApp: number;
  memCache: number;
  swapUsed: number;
  swapTotal: number;
  filesystems: FilesystemEntry[];
  diskRead: number;
  diskWrite: number;
  netIn: number;
  netOut: number;
  processes: ProcessEntry[];
  connections: NetConnection[];
  history: number[];
  netHistory: number[];
}

// ===== 驱动事件 =====

export interface SshEventHandlers {
  onData: (sessionId: string, data: string) => void;
  onStatus: (sessionId: string, status: ConnectionStatus, message?: string) => void;
  onClosed: (sessionId: string) => void;
}

/** 驱动适配层统一接口：Mock 与 Tauri 实现同一契约。 */
export interface Driver {
  readonly kind: "mock" | "tauri";
  connect(config: SessionConfig, handlers: SshEventHandlers): Promise<void>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  disconnect(sessionId: string): Promise<void>;

  // ===== SFTP 文件传输 =====
  sftpList(sessionId: string, path: string): Promise<RemoteFileEntry[]>;
  sftpRead(sessionId: string, path: string): Promise<FileContent>;
  /** data 为原始字节的 base64 编码（用 btoa/atob 处理） */
  sftpWrite(sessionId: string, path: string, dataBase64: string): Promise<number>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpRemove(sessionId: string, path: string, isDir: boolean): Promise<void>;
  sftpCreate(sessionId: string, path: string, isDir: boolean): Promise<void>;

  // ===== 本地文件系统 =====
  fsHome(): Promise<string>;
  fsList(path: string): Promise<RemoteFileEntry[]>;
  fsRead(path: string): Promise<FileContent>;
  fsWrite(path: string, data: string): Promise<number>;
  fsRename(from: string, to: string): Promise<void>;
  fsRemove(path: string, isDir: boolean): Promise<void>;
  fsCreate(path: string, isDir: boolean): Promise<void>;

  // ===== 资源监控 =====
  collectMonitor(sessionId: string): Promise<MonitorSnapshot>;

  // ===== 凭据（密码不落 localStorage）=====
  /** 把密码交给系统加密存储（Windows DPAPI），只在当前用户下可解密 */
  /** 保存密码，并把密码与该连接的 host/port/username 绑定（后端连接时会校验） */
  secretSet(id: string, password: string, host: string, port: number, username: string): Promise<void>;
  /** 是否保存过密码（只回布尔值，明文不回传前端） */
  secretHas(id: string): Promise<boolean>;
  /** 删除该连接保存的密码 */
  secretRemove(id: string): Promise<void>;
}
