import { create } from "zustand";
import { driver } from "./drivers";
import { appendSessionLog, monitorRegistry, sessionLog, terminalRegistry } from "./runtime";
import { Monitor } from "./monitor";
import type {
  ConnectionStatus,
  EditorFile,
  LayoutState,
  RemoteFileEntry,
  SavedCommand,
  SessionConfig,
  TabPane,
  Toast,
  Workspace,
  Preferences,
} from "./types";
import { DEFAULT_PREFERENCES } from "./types";
import { DEFAULT_COMMANDS } from "./constants";

const SESSIONS_KEY = "mssh.v2.sessions";
const FOLDERS_KEY = "mssh.v2.folders";
const COMMANDS_KEY = "mssh.v2.commands";
const FILES_KEY = "mssh.v2.editorFiles";
const REMOTE_KEY = "mssh.v2.remote";
const HISTORY_KEY = "mssh.v2.history";
// 布局开关沿用 v3 key 以保留用户已有的右侧面板状态；
// 左侧宽度现在可拖拽调宽但不可折叠，实际尺寸由 PanelGroup 的 mssh.layout.v4 自动保存
const LAYOUT_KEY = "mssh.v3.layout";
const PREFS_KEY = "mssh.v2.preferences";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

/**
 * 保存连接列表。
 *
 * 密码绝不写进 localStorage（那会以明文落在 WebView2 的 leveldb 里）：
 * 带密码的条目先交给系统加密存储（Windows DPAPI），再从落盘副本里剥掉。
 * 连接时由 Rust 后端自行从凭据库取回，明文不再经过前端。
 */
function persistSessions(
  sessions: SessionConfig[],
  onSecretError?: (message: string, name?: string) => void,
) {
  const stripped = sessions.map((s) => {
    if (s.password) {
      void driver.secretSet(s.id, s.password, s.host, s.port, s.username).catch((e) => {
        // 加密失败 = 密码没有落到凭据库：本次连接不受影响，但下次取不到密码。
        // 必须明确告知用户，否则"以为记住了、下次却要重输"会像随机故障。
        onSecretError?.(
          `连接「${s.name}」的密码未能加密保存：${String(e)}。本次可用，下次需重新输入。`,
          s.name,
        );
      });
    }
    const { password: _plaintext, secretId: _secretId, ...rest } = s;
    return rest;
  });
  save(SESSIONS_KEY, stripped);
}

/**
 * 升级迁移期的加密失败暂存。
 * initialSessions() 在 store 创建前运行，拿不到 showToast；而 secretSet 是异步的，
 * 失败回调往往在 store 建好之后才触发，所以先入队，再由 store 注册 flush 钩子统一提示。
 */
const pendingMigrationNames: string[] = [];
let flushMigrationErrors: (() => void) | null = null;

function queueMigrationError(_message: string, name?: string) {
  pendingMigrationNames.push(name ?? "未知连接");
  // 全量重发：Toast 是单条覆盖式，后一次提示始终包含所有失败连接。
  flushMigrationErrors?.();
}

interface AppState {
  sessions: SessionConfig[];
  workspaces: Workspace[];
  activeId: string | null;
  /** 视图窗格（1 或 2 个），每个窗格持有标签页 */
  panes: TabPane[];
  focusedPane: number;
  layout: LayoutState;
  preferences: Preferences;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
  folders: string[];
  commands: SavedCommand[];
  editorFiles: EditorFile[];
  remoteFiles: Record<string, RemoteFileEntry[]>;
  commandHistory: string[];
  globalDraft: string;
  toast: Toast | null;
  seq: number;

  // 会话
  upsertSession: (config: SessionConfig) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, name: string) => void;

  // 工作区
  openWorkspace: (config: SessionConfig) => void;
  closeWorkspace: (runtimeId: string) => Promise<void>;
  focusWorkspace: (runtimeId: string) => void;
  setStatus: (runtimeId: string, status: ConnectionStatus, message?: string) => void;
  toggleFiles: (runtimeId: string) => void;

  // 标签页 / 分屏
  setFocusedPane: (index: number) => void;
  splitWorkspace: (runtimeId: string) => void;
  /** 收起某个分屏：把该窗格里的标签并回相邻窗格（连接保持不断开） */
  unsplitPane: (paneIndex: number) => void;
  /** 按当前「最大分屏数量」把多余窗格并回，保持布局合法 */
  clampPanes: () => void;
  mergePanes: () => void;
  moveTabToPane: (runtimeId: string, paneIndex: number) => void;
  reorderTab: (runtimeId: string, paneIndex: number, toIndex: number) => void;

  // 布局
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftCollapsed: (v: boolean) => void;
  setRightCollapsed: (v: boolean) => void;

  // 文件夹
  addFolder: (name: string) => void;
  renameFolder: (oldName: string, newName: string) => void;
  /** 删除工作区目录；若该目录含连接，把连接迁移到 mergeTo（空则迁移到默认工作区） */
  deleteFolder: (name: string, mergeTo?: string) => void;
  // 命令仓库
  upsertCommand: (cmd: SavedCommand) => void;
  deleteCommand: (id: string) => void;
  // 编辑器
  upsertEditorFile: (file: EditorFile) => void;
  deleteEditorFile: (id: string) => void;
  /** 清空编辑器草稿与远程文件缓存（两者都以明文落在 localStorage） */
  clearEditorCache: () => void;
  importFileToHost: (host: string, file: EditorFile, remotePath: string) => void;
  // 远端文件操作（文件面板右键/拖拽）
  addRemoteFile: (host: string, file: RemoteFileEntry) => void;
  renameRemoteFile: (host: string, oldName: string, newName: string) => void;
  deleteRemoteFile: (host: string, name: string) => void;

  // 命令 / 提示
  pushHistory: (command: string) => void;
  /** 清空本机命令历史（可能含敏感参数，以明文存在 localStorage） */
  clearHistory: () => void;
  setGlobalDraft: (command: string) => void;
  writeToWorkspace: (runtimeId: string, command: string, options?: { recordHistory?: boolean }) => void;
  showToast: (message: string, kind?: Toast["kind"]) => void;
  clearToast: () => void;
}

function formatBytes(text: string): string {
  const n = new Blob([text]).size;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function initialSessions(): SessionConfig[] {
  const sessions = load<SessionConfig[]>(SESSIONS_KEY, []);
  // 清理旧版本自动注入的演示连接；真实后端已就绪，不再预置示例数据
  const kept = sessions.filter((s) => !s.id.startsWith("demo-"));
  // 老版本把密码明文写在 localStorage 里：迁移到加密存储并重写落盘副本
  const hasPlaintextPassword = kept.some((s) => s.password);
  if (kept.length !== sessions.length || hasPlaintextPassword) {
    persistSessions(kept, queueMigrationError);
  }
  return kept;
}

/** 1.0.2 及更早版本首次运行会自动写入这六个示例工作区 */
const LEGACY_DEFAULT_FOLDERS = ["常用", "生产环境", "预发布", "开发环境", "测试环境", "监控运维"];

/**
 * 工作区列表：新装用户从零开始，由用户自己新建。
 *
 * 老版本会自动塞入六个示例工作区。若存下来的内容与默认值完全一致（顺序也一致），
 * 说明用户从未增删改过，那只是默认值而非用户自建，这里清掉；
 * 只要用户动过任意一项（改名、新增、删除），就原样保留，不会误删真实数据。
 */
function initialFolders(): string[] {
  const stored = load<string[]>(FOLDERS_KEY, []);
  const untouchedLegacy =
    stored.length === LEGACY_DEFAULT_FOLDERS.length &&
    stored.every((v, i) => v === LEGACY_DEFAULT_FOLDERS[i]);
  if (untouchedLegacy) {
    save(FOLDERS_KEY, []);
    return [];
  }
  return stored.filter((v) => typeof v === "string" && v.trim());
}

/** 供标签/分屏操作复用的不可变空值，避免 zustand selector 死循环 */
const EMPTY_PANES: TabPane[] = [{ tabs: [], activeTab: null }];
const newPane = (): TabPane => ({ tabs: [], activeTab: null });

/** 建立真实/模拟连接：驱动统一用 runtimeId 作为会话标识，与 terminal / monitor registry 对齐 */
function startSession(
  config: SessionConfig,
  runtimeId: string,
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
) {
  const handlers = {
    onData: (sid: string, data: string) => {
      appendSessionLog(sid, data);
      terminalRegistry.get(sid)?.write(data);
    },
    onStatus: (sid: string, status: ConnectionStatus, message?: string) => get().setStatus(sid, status, message),
    onClosed: () => {
      if (!get().preferences.terminalAutoReconnect) {
        set({ toast: { id: Date.now(), message: "连接已关闭", kind: "info" } });
        return;
      }
      setTimeout(() => {
        if (!get().workspaces.some((w) => w.runtimeId === runtimeId)) return;
        // secretId 指向原始连接：后端据此从 DPAPI 凭据库取密码，前端始终拿不到明文
        void driver.connect({ ...config, id: runtimeId, secretId: config.id }, handlers);
      }, 900);
    },
  };
  void driver.connect({ ...config, id: runtimeId, secretId: config.id }, handlers);
  monitorRegistry.set(runtimeId, new Monitor(runtimeId));
}


export const useAppStore = create<AppState>((set, get) => ({
  sessions: initialSessions(),
  workspaces: [],
  activeId: null,
  panes: EMPTY_PANES,
  focusedPane: 0,
  layout: load(LAYOUT_KEY, { leftCollapsed: false, rightCollapsed: true }),
  preferences: { ...DEFAULT_PREFERENCES, ...load(PREFS_KEY, {}) },
  setPreference: (key, value) => {
    set((state) => {
      const preferences = { ...state.preferences, [key]: value };
      save(PREFS_KEY, preferences);
      window.dispatchEvent(new Event("mssh:prefs-changed"));
      return { preferences };
    });
  },
  folders: initialFolders(),
  commands: load(COMMANDS_KEY, DEFAULT_COMMANDS),
  editorFiles: load(FILES_KEY, []),
  remoteFiles: load(REMOTE_KEY, {}),
  commandHistory: load(HISTORY_KEY, []),
  globalDraft: "",
  toast: null,
  seq: 0,

  upsertSession: (config) => {
    // 改成密钥/agent/免密认证后，旧的密码凭据不再有用，立刻清掉避免长期残留
    if (config.authMethod !== "password") {
      void driver.secretRemove(config.id).catch(() => {});
    }
    set((state) => {
      const idx = state.sessions.findIndex((s) => s.id === config.id);
      const sessions = idx >= 0 ? state.sessions.map((s) => (s.id === config.id ? config : s)) : [...state.sessions, config];
      persistSessions(sessions, (m) => get().showToast(m, "error"));
      return { sessions };
    });
  },

  deleteSession: (id) => {
    // 连接删除时一并清掉它的加密密码，别在凭据库里留孤儿条目
    void driver.secretRemove(id).catch(() => {});
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      persistSessions(sessions, (m) => get().showToast(m, "error"));
      return { sessions };
    });
  },

  renameSession: (id, name) => {
    const v = name.trim();
    if (!v) return;
    set((state) => {
      const sessions = state.sessions.map((s) => (s.id === id ? { ...s, name: v } : s));
      // 已打开工作区里的会话副本也同步，避免标签仍显示旧名
      const workspaces = state.workspaces.map((w) =>
        w.session.id === id ? { ...w, session: { ...w.session, name: v } } : w,
      );
      persistSessions(sessions, (m) => get().showToast(m, "error"));
      return { sessions, workspaces };
    });
  },

  openWorkspace: (config) => {
    const existing = get().workspaces.find((w) => w.session.id === config.id);
    if (existing) {
      set((state) => {
        const paneIndex = Math.max(0, state.panes.findIndex((p) => p.tabs.includes(existing.runtimeId)));
        return {
          activeId: existing.runtimeId,
          focusedPane: paneIndex,
          panes: state.panes.map((p, i) => (i === paneIndex && !p.tabs.includes(existing.runtimeId)
            ? { tabs: [...p.tabs, existing.runtimeId], activeTab: existing.runtimeId }
            : i === paneIndex ? { ...p, activeTab: existing.runtimeId } : p)),
        };
      });
      return;
    }
    const runtimeId = `${config.id}-${Date.now()}`;
    const workspace: Workspace = {
      runtimeId,
      session: config,
      status: "idle",
      filesOpen: true,
    };
    set((state) => {
      const panes = state.panes.map((p, i) => (i === state.focusedPane
        ? { tabs: [...p.tabs, runtimeId], activeTab: runtimeId }
        : p));
      return { workspaces: [...state.workspaces, workspace], activeId: runtimeId, panes };
    });
    startSession(config, runtimeId, get, set);
  },

  closeWorkspace: async (runtimeId) => {
    await driver.disconnect(runtimeId);
    terminalRegistry.get(runtimeId)?.dispose();
    terminalRegistry.delete(runtimeId);
    monitorRegistry.get(runtimeId)?.dispose();
    monitorRegistry.delete(runtimeId);
    sessionLog.delete(runtimeId);
    set((state) => {
      const workspaces = state.workspaces.filter((w) => w.runtimeId !== runtimeId);
      let panes = state.panes.map((p) => {
        if (!p.tabs.includes(runtimeId)) return p;
        const tabs = p.tabs.filter((t) => t !== runtimeId);
        let activeTab = p.activeTab;
        if (activeTab === runtimeId) {
          const removedAt = p.tabs.indexOf(runtimeId);
          activeTab = tabs[Math.min(removedAt, tabs.length - 1)] ?? null;
        }
        return { tabs, activeTab };
      });
      panes = panes.filter((p) => p.tabs.length > 0 || panes.length === 1);
      if (panes.length === 0) panes = [newPane()];
      const focusedPane = Math.min(state.focusedPane, panes.length - 1);
      const activeId = state.activeId === runtimeId
        ? (panes[focusedPane]?.activeTab ?? panes[focusedPane]?.tabs[0] ?? workspaces[workspaces.length - 1]?.runtimeId ?? null)
        : state.activeId;
      return { workspaces, activeId, focusedPane, panes };
    });
  },

  focusWorkspace: (runtimeId) => set((state) => {
    const paneIndex = state.panes.findIndex((p) => p.tabs.includes(runtimeId));
    if (paneIndex < 0) return { activeId: runtimeId };
    return {
      activeId: runtimeId,
      focusedPane: paneIndex,
      panes: state.panes.map((p, i) => (i === paneIndex ? { ...p, activeTab: runtimeId } : p)),
    };
  }),

  setFocusedPane: (index) => set((state) => {
    if (index < 0 || index >= state.panes.length) return {};
    const pane = state.panes[index];
    const activeId = pane.activeTab ?? pane.tabs[0] ?? null;
    return {
      focusedPane: index,
      activeId,
      panes: state.panes.map((p, i) => (i === index && p.activeTab !== activeId ? { ...p, activeTab: activeId } : p)),
    };
  }),

  splitWorkspace: (runtimeId) => {
    const state = get();
    const src = state.panes.findIndex((p) => p.tabs.includes(runtimeId));
    if (src < 0) return;
    const srcPane = state.panes[src];
    const maxPanes = Math.max(2, Math.min(4, state.preferences.maxPanes ?? 4));

    if (state.panes.length >= maxPanes) {
      get().showToast(`最多 ${maxPanes} 屏`, "info");
      return;
    }

    // 窗格里只剩这一个终端时，分屏只会把同一个会话复制一份 —— 不做这种分屏
    if (srcPane.tabs.length <= 1) {
      get().showToast("该窗格只有一个终端，请先打开另一个终端再分屏", "info");
      return;
    }

    const restTabs = srcPane.tabs.filter((t) => t !== runtimeId);
    const restActive = srcPane.activeTab === runtimeId ? (restTabs[0] ?? null) : srcPane.activeTab;
    const panes = [
      ...state.panes.map((p, i) => (i === src ? { tabs: restTabs, activeTab: restActive } : p)),
      { tabs: [runtimeId], activeTab: runtimeId },
    ];
    set({ panes, focusedPane: panes.length - 1, activeId: runtimeId });
  },

  unsplitPane: (paneIndex) => set((state) => {
    if (state.panes.length <= 1) return {};
    const i = Math.max(0, Math.min(paneIndex, state.panes.length - 1));
    // 优先并回左邻窗格；第一屏则并到右邻
    const targetIndex = i === 0 ? 1 : i - 1;
    const target = state.panes[targetIndex];
    const removed = state.panes[i];
    const tabs = [...target.tabs, ...removed.tabs.filter((t) => !target.tabs.includes(t))];
    if (tabs.length === 0) return {};
    const activeTab = removed.activeTab ?? target.activeTab ?? tabs[0] ?? null;
    const panes = state.panes
      .map((p, idx) => (idx === targetIndex ? { tabs, activeTab } : p))
      .filter((_, idx) => idx !== i);
    // 第一屏被收起时相邻窗格左移到 0，否则目标窗格位置不变
    return { panes, focusedPane: Math.min(i === 0 ? 0 : i - 1, panes.length - 1), activeId: activeTab };
  }),

  clampPanes: () => set((state) => {
    const max = Math.max(2, Math.min(4, state.preferences.maxPanes ?? 4));
    if (state.panes.length <= max) return {};
    const kept = state.panes.slice(0, max).map((p) => ({ ...p }));
    const extra = state.panes.slice(max).flatMap((p) => p.tabs);
    const last = kept[kept.length - 1];
    last.tabs = [...last.tabs, ...extra];
    if (!last.activeTab) last.activeTab = last.tabs[0] ?? null;
    return { panes: kept, focusedPane: Math.min(state.focusedPane, max - 1) };
  }),

  mergePanes: () => set((state) => {
    if (state.panes.length <= 1) return {};
    const tabs = state.panes.flatMap((p) => p.tabs);
    const activeTab = state.activeId && tabs.includes(state.activeId) ? state.activeId : (tabs[0] ?? null);
    return { panes: [{ tabs, activeTab }], focusedPane: 0, activeId: activeTab };
  }),

  moveTabToPane: (runtimeId, paneIndex) => set((state) => {
    if (paneIndex < 0 || paneIndex >= state.panes.length) return {};
    const src = state.panes.findIndex((p) => p.tabs.includes(runtimeId));
    if (src < 0 || src === paneIndex) return {};
    let panes = state.panes.map((p, i) => {
      if (i === src) {
        const tabs = p.tabs.filter((t) => t !== runtimeId);
        return { tabs, activeTab: p.activeTab === runtimeId ? (tabs[0] ?? null) : p.activeTab };
      }
      if (i === paneIndex) return { tabs: [...p.tabs, runtimeId], activeTab: runtimeId };
      return p;
    });
    panes = panes.filter((p) => p.tabs.length > 0 || panes.length === 1);
    if (panes.length === 0) panes = [newPane()];
    return { panes, focusedPane: Math.min(paneIndex, panes.length - 1), activeId: runtimeId };
  }),

  reorderTab: (runtimeId, paneIndex, toIndex) => set((state) => {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.tabs.includes(runtimeId)) return {};
    const tabs = pane.tabs.filter((t) => t !== runtimeId);
    const idx = Math.max(0, Math.min(toIndex, tabs.length));
    tabs.splice(idx, 0, runtimeId);
    return { panes: state.panes.map((p, i) => (i === paneIndex ? { ...p, tabs } : p)) };
  }),

  setStatus: (runtimeId, status, message) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.runtimeId === runtimeId ? { ...w, status, statusMessage: message } : w)),
    }));
  },

  toggleFiles: (runtimeId) => {
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.runtimeId === runtimeId ? { ...w, filesOpen: !w.filesOpen } : w)),
    }));
  },

  toggleLeft: () => {
    set((state) => {
      const layout = { ...state.layout, leftCollapsed: !state.layout.leftCollapsed };
      save(LAYOUT_KEY, layout);
      return { layout };
    });
  },
  toggleRight: () => {
    set((state) => {
      const layout = { ...state.layout, rightCollapsed: !state.layout.rightCollapsed };
      save(LAYOUT_KEY, layout);
      return { layout };
    });
  },
  setLeftCollapsed: (v) => {
    if (get().layout.leftCollapsed === v) return;
    set((state) => {
      const layout = { ...state.layout, leftCollapsed: v };
      save(LAYOUT_KEY, layout);
      return { layout };
    });
  },
  setRightCollapsed: (v) => {
    if (get().layout.rightCollapsed === v) return;
    set((state) => {
      const layout = { ...state.layout, rightCollapsed: v };
      save(LAYOUT_KEY, layout);
      return { layout };
    });
  },

  addFolder: (name) => {
    set((state) => {
      if (state.folders.includes(name) || !name.trim()) return state;
      const folders = [...state.folders, name.trim()];
      save(FOLDERS_KEY, folders);
      return { folders };
    });
  },

  renameFolder: (oldName, newName) => {
    const next = newName.trim();
    if (!next || next === oldName) return;
    set((state) => {
      const folders = state.folders.includes(oldName)
        ? state.folders.map((f) => (f === oldName ? next : f))
        : [...state.folders, next];
      const sessions = state.sessions.map((s) =>
        (s.directory?.trim() || "默认工作区") === oldName ? { ...s, directory: next } : s,
      );
      const workspaces = state.workspaces.map((w) =>
        (w.session.directory?.trim() || "默认工作区") === oldName
          ? { ...w, session: { ...w.session, directory: next } }
          : w,
      );
      save(FOLDERS_KEY, folders);
      persistSessions(sessions, (m) => get().showToast(m, "error"));
      return { folders, sessions, workspaces };
    });
  },

  deleteFolder: (name, mergeTo) => {
    set((state) => {
      const folders = state.folders.filter((f) => f !== name);
      // 目标工作区不存在时自动补建，避免连接落到不存在的分组
      const target = (mergeTo?.trim() || "默认工作区");
      if (!folders.includes(target)) folders.push(target);
      const sessions = state.sessions.map((s) =>
        (s.directory?.trim() || "默认工作区") === name ? { ...s, directory: target } : s,
      );
      const workspaces = state.workspaces.map((w) =>
        (w.session.directory?.trim() || "默认工作区") === name
          ? { ...w, session: { ...w.session, directory: target } }
          : w,
      );
      save(FOLDERS_KEY, folders);
      persistSessions(sessions, (m) => get().showToast(m, "error"));
      return { folders, sessions, workspaces };
    });
  },

  upsertCommand: (cmd) => {
    set((state) => {
      const idx = state.commands.findIndex((c) => c.id === cmd.id);
      const commands = idx >= 0 ? state.commands.map((c) => (c.id === cmd.id ? cmd : c)) : [...state.commands, cmd];
      save(COMMANDS_KEY, commands);
      return { commands };
    });
  },
  deleteCommand: (id) => {
    set((state) => {
      const commands = state.commands.filter((c) => c.id !== id);
      save(COMMANDS_KEY, commands);
      return { commands };
    });
  },

  upsertEditorFile: (file) => {
    set((state) => {
      const idx = state.editorFiles.findIndex((f) => f.id === file.id);
      const editorFiles = idx >= 0 ? state.editorFiles.map((f) => (f.id === file.id ? file : f)) : [...state.editorFiles, file];
      save(FILES_KEY, editorFiles);
      return { editorFiles };
    });
  },
  deleteEditorFile: (id) => {
    set((state) => {
      const editorFiles = state.editorFiles.filter((f) => f.id !== id);
      save(FILES_KEY, editorFiles);
      return { editorFiles };
    });
  },
  clearEditorCache: () => {
    save(FILES_KEY, []);
    save(REMOTE_KEY, {});
    set({ editorFiles: [], remoteFiles: {} });
  },
  importFileToHost: (host, file, remotePath) => {
    // 找到该 host 对应的活动工作区，用真实 SFTP 写入
    const ws = get().workspaces.find((w) => w.session.host === host);
    const dir = remotePath.trim() || "/";
    const full = `${dir.replace(/\/+$/, "")}/${file.name}`;
    if (ws) {
      // 文本 -> base64（UTF-8 安全）
      const bytes = new TextEncoder().encode(file.content);
      let bin = "";
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      void driver.sftpWrite(ws.runtimeId, full, btoa(bin))
        .then(() => get().showToast(`已导入 ${file.name} 到 ${host}:${full}`, "success"))
        .catch((e) => get().showToast(`导入失败: ${String(e)}`, "error"));
    } else {
      get().showToast(`主机 ${host} 未连接，无法导入`, "error");
    }
    // localStorage 记录仍保留，供编辑器侧引用
    set((state) => {
      const entry: RemoteFileEntry = {
        name: file.name,
        size: formatBytes(file.content),
        modified: new Date().toLocaleString("zh-CN", { hour12: false }),
        type: "file",
        path: full,
        content: file.content,
      };
      const hostFiles = state.remoteFiles[host] ?? [];
      const remoteFiles = { ...state.remoteFiles, [host]: [entry, ...hostFiles.filter((f) => f.name !== file.name)] };
      save(REMOTE_KEY, remoteFiles);
      return { remoteFiles };
    });
  },

  addRemoteFile: (host, file) => {
    set((state) => {
      const hostFiles = state.remoteFiles[host] ?? [];
      if (hostFiles.some((f) => f.name === file.name)) {
        return {};
      }
      const remoteFiles = { ...state.remoteFiles, [host]: [file, ...hostFiles] };
      save(REMOTE_KEY, remoteFiles);
      return { remoteFiles };
    });
  },
  renameRemoteFile: (host, oldName, newName) => {
    set((state) => {
      const hostFiles = state.remoteFiles[host] ?? [];
      const remoteFiles = {
        ...state.remoteFiles,
        [host]: hostFiles.map((f) => (f.name === oldName ? { ...f, name: newName } : f)),
      };
      save(REMOTE_KEY, remoteFiles);
      return { remoteFiles };
    });
  },
  deleteRemoteFile: (host, name) => {
    set((state) => {
      const hostFiles = state.remoteFiles[host] ?? [];
      const remoteFiles = {
        ...state.remoteFiles,
        [host]: hostFiles.filter((f) => f.name !== name),
      };
      save(REMOTE_KEY, remoteFiles);
      return { remoteFiles };
    });
  },

  pushHistory: (command) => {
    set((state) => {
      const commandHistory = [...state.commandHistory, command].slice(-100);
      save(HISTORY_KEY, commandHistory);
      return { commandHistory };
    });
  },
  clearHistory: () => {
    save(HISTORY_KEY, []);
    set({ commandHistory: [] });
  },
  setGlobalDraft: (command) => set({ globalDraft: command }),
  writeToWorkspace: (runtimeId, command, options) => {
    const ws = get().workspaces.find((w) => w.runtimeId === runtimeId);
    if (!ws) return;
    if (ws.status !== "connected") {
      get().showToast("该连接尚未就绪", "error");
      return;
    }
    driver.write(runtimeId, command + "\r");
    // 群发时由调用方决定只记录一次历史，避免同一命令重复入栈
    if (options?.recordHistory !== false) get().pushHistory(command);
  },
  showToast: (message, kind = "info") => set({ toast: { id: Date.now(), message, kind } }),
  clearToast: () => set({ toast: null }),
}));

// store 已就绪：注册迁移期的失败提示钩子。secretSet 是异步的，回调可能在此之后才触发，
// 因此保留钩子持续消费队列；每次全量重发，保证用户看到的是含所有失败连接的完整提示。
flushMigrationErrors = () => {
  if (!pendingMigrationNames.length) return;
  const names = [...new Set(pendingMigrationNames)].join("、");
  useAppStore.getState().showToast(
    `密码加密迁移失败：${names}。请编辑这些连接重新输入密码。`,
    "error",
  );
};
flushMigrationErrors();
