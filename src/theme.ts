export interface ThemePreset {
  id: string;
  name: string;
  vars: Record<string, string>;
}

/** 可编辑的颜色项定义（供主题设置页渲染） */
export interface ColorToken {
  key: string;
  label: string;
  group: "surface" | "text" | "accent" | "status" | "terminal";
}

export const COLOR_GROUPS: { id: ColorToken["group"]; name: string; desc: string }[] = [
  { id: "surface", name: "界面", desc: "背景、面板、侧栏、卡片与边框" },
  { id: "text", name: "文字", desc: "各级文本颜色" },
  { id: "accent", name: "强调", desc: "主色与交互高亮" },
  { id: "status", name: "状态", desc: "成功、危险、警告" },
  { id: "terminal", name: "终端", desc: "终端背景、文本与 ANSI 配色" },
];

export const COLOR_TOKENS: ColorToken[] = [
  { key: "--bg", label: "页面背景", group: "surface" },
  { key: "--panel", label: "面板", group: "surface" },
  { key: "--sidebar", label: "侧栏", group: "surface" },
  { key: "--card", label: "卡片", group: "surface" },
  { key: "--popover", label: "浮层", group: "surface" },
  { key: "--line", label: "边框", group: "surface" },
  { key: "--line-soft", label: "浅边框", group: "surface" },
  { key: "--text", label: "主文本", group: "text" },
  { key: "--text-2", label: "次文本", group: "text" },
  { key: "--muted", label: "弱化文本", group: "text" },
  { key: "--accent", label: "强调色", group: "accent" },
  { key: "--accent-soft", label: "强调浅色", group: "accent" },
  { key: "--accent-contrast", label: "强调文字", group: "accent" },
  { key: "--success", label: "成功", group: "status" },
  { key: "--danger", label: "危险", group: "status" },
  { key: "--warn", label: "警告", group: "status" },
  { key: "--term-bg", label: "终端背景", group: "terminal" },
  { key: "--term-fg", label: "终端文本", group: "terminal" },
  { key: "--term-cursor", label: "光标", group: "terminal" },
  { key: "--term-selection", label: "选中", group: "terminal" },
  { key: "--term-black", label: "黑", group: "terminal" },
  { key: "--term-red", label: "红", group: "terminal" },
  { key: "--term-green", label: "绿", group: "terminal" },
  { key: "--term-yellow", label: "黄", group: "terminal" },
  { key: "--term-blue", label: "蓝", group: "terminal" },
  { key: "--term-magenta", label: "紫", group: "terminal" },
  { key: "--term-cyan", label: "青", group: "terminal" },
  { key: "--term-white", label: "白", group: "terminal" },
];

const TERM_LIGHT = {
  "--term-bg": "#1b1f27",
  "--term-fg": "#d5dae3",
  "--term-cursor": "#7aa2ff",
  "--term-selection": "#3b6ef5",
  "--term-black": "#2a2f3a",
  "--term-red": "#e06c75",
  "--term-green": "#4ec9a0",
  "--term-yellow": "#e5c07b",
  "--term-blue": "#61afef",
  "--term-magenta": "#c678dd",
  "--term-cyan": "#56b6c2",
  "--term-white": "#d5dae3",
};
const TERM_DARK = {
  ...TERM_LIGHT,
  "--term-bg": "#12151b",
  "--term-selection": "#5b8cff",
};
const TERM_MINT = {
  ...TERM_LIGHT,
  "--term-bg": "#17231e",
  "--term-fg": "#d7e6dd",
  "--term-green": "#5fd0a0",
  "--term-selection": "#2f9e74",
};
const TERM_MAGENTA = {
  ...TERM_LIGHT,
  "--term-bg": "#1e151a",
  "--term-fg": "#e6d9df",
  "--term-cursor": "#ff6fae",
  "--term-selection": "#b81a55",
  "--term-magenta": "#f06ab0",
};

/** 中性、克制、operational 的浅色主题（默认） */
export const themes: ThemePreset[] = [
  {
    id: "zcode-light",
    name: "浅色 · Neutral",
    vars: {
      "--bg": "#f7f8fa", "--panel": "#ffffff", "--sidebar": "#f3f5f8",
      "--card": "#ffffff", "--popover": "#ffffff",
      "--text": "#1f2329", "--text-2": "#51565f", "--muted": "#8b909a",
      "--line": "#e5e8ed", "--line-soft": "#f0f2f5",
      "--accent": "#3b6ef5", "--accent-soft": "#eaf0ff", "--accent-contrast": "#ffffff",
      "--success": "#1f9d55", "--danger": "#d64550", "--warn": "#d98324",
      "--ui-font-size": "13px", ...TERM_LIGHT,
    },
  },
  {
    id: "zcode-dark",
    name: "深色 · Graphite",
    vars: {
      "--bg": "#16191f", "--panel": "#1e222a", "--sidebar": "#191d24",
      "--card": "#232831", "--popover": "#262b34",
      "--text": "#e6e8ec", "--text-2": "#a8aeb9", "--muted": "#6f7783",
      "--line": "#2e343e", "--line-soft": "#272c35",
      "--accent": "#5b8cff", "--accent-soft": "#1e2b45", "--accent-contrast": "#ffffff",
      "--success": "#3fbf7f", "--danger": "#f0646f", "--warn": "#e0993f",
      "--ui-font-size": "13px", ...TERM_DARK,
    },
  },
  {
    id: "mint",
    name: "薄荷 · Mint",
    vars: {
      "--bg": "#f4f7f5", "--panel": "#ffffff", "--sidebar": "#eaf2ed",
      "--card": "#ffffff", "--popover": "#ffffff",
      "--text": "#1c2b24", "--text-2": "#4a5c53", "--muted": "#83958c",
      "--line": "#dce8e1", "--line-soft": "#eef3f0",
      "--accent": "#2f9e74", "--accent-soft": "#dff0e8", "--accent-contrast": "#ffffff",
      "--success": "#2f9e74", "--danger": "#cf5560", "--warn": "#c98a2e",
      "--ui-font-size": "13px", ...TERM_MINT,
    },
  },
  {
    id: "magenta",
    name: "品红 · Magenta",
    vars: {
      "--bg": "#fcf6f9", "--panel": "#ffffff", "--sidebar": "#fbf2f7",
      "--card": "#ffffff", "--popover": "#ffffff",
      "--text": "#2b1a22", "--text-2": "#5b4750", "--muted": "#95808a",
      "--line": "#efdbe4", "--line-soft": "#f7ecf2",
      "--accent": "#c2185b", "--accent-soft": "#fbe0ec", "--accent-contrast": "#ffffff",
      "--success": "#1f9d55", "--danger": "#c62828", "--warn": "#d98324",
      "--ui-font-size": "13px", ...TERM_MAGENTA,
    },
  },
];

const THEME_KEY = "mssh.v2.theme";
const CUSTOM_KEY = "mssh.v2.theme.custom";
const SAVED_KEY = "mssh.v2.theme.saved";

/** 读取自定义 vars（若存在） */
function loadCustomVars(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** 用户保存的自定义主题 */
export function loadSavedThemes(): ThemePreset[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const list = raw ? JSON.parse(raw) as ThemePreset[] : [];
    return Array.isArray(list) ? list.filter((t) => t && typeof t.id === "string" && typeof t.name === "string" && t.vars) : [];
  } catch {
    return [];
  }
}

/** 内置 + 用户保存的全部主题 */
export function allThemes(): ThemePreset[] {
  return [...themes, ...loadSavedThemes()];
}

/** 默认主题（首次启动、无记录时使用）：品红 / 粉 */
export const DEFAULT_THEME_ID = "magenta";

export function defaultTheme(): ThemePreset {
  return allThemes().find((t) => t.id === DEFAULT_THEME_ID) ?? themes[0];
}

/** 把当前配色保存为可复用的主题 */
export function saveTheme(name: string, vars: Record<string, string>, baseId?: string): ThemePreset {
  const base = allThemes().find((t) => t.id === baseId) ?? defaultTheme();
  const theme: ThemePreset = {
    id: `saved-${Date.now()}`,
    name: name.trim() || `自定义主题 ${loadSavedThemes().length + 1}`,
    vars: { ...base.vars, ...vars },
  };
  const list = loadSavedThemes();
  list.push(theme);
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  return theme;
}

/** 删除用户保存的主题 */
export function removeSavedTheme(id: string) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(loadSavedThemes().filter((t) => t.id !== id)));
}

export function loadTheme(): ThemePreset {
  const custom = loadCustomVars();
  if (custom) return { id: "custom", name: "自定义", vars: { ...defaultTheme().vars, ...custom } };
  const id = localStorage.getItem(THEME_KEY);
  return allThemes().find((t) => t.id === id) ?? defaultTheme();
}

/** 应用一份完整 vars 到 :root，并通知终端刷新 */
export function applyVars(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  window.dispatchEvent(new Event("mssh:themechange"));
}

export function applyTheme(theme: ThemePreset) {
  applyVars(theme.vars);
  localStorage.setItem(THEME_KEY, theme.id);
  localStorage.removeItem(CUSTOM_KEY);
}

/** 应用自定义 vars（实时预览用），并持久化 */
export function applyCustomVars(vars: Record<string, string>, baseId: string) {
  applyVars(vars);
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(vars));
  localStorage.setItem(THEME_KEY, baseId);
}

/** 读取当前 :root 上生效的全部可编辑颜色 */
export function getEffectiveVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const t of COLOR_TOKENS) {
    const v = cs.getPropertyValue(t.key).trim();
    if (v) out[t.key] = v;
  }
  return out;
}

/** 从某个预设重置为未自定义状态 */
export function resetToPreset(id: string): ThemePreset {
  const preset = allThemes().find((t) => t.id === id) ?? defaultTheme();
  applyTheme(preset);
  return preset;
}

/** 构造 xterm 配色：从 CSS 变量读取 */
export function buildTerminalTheme(vars?: Record<string, string>) {
  const v = vars ?? getEffectiveVars();
  const hex8 = (hex: string, alpha = "55") => {
    const h = hex.replace("#", "");
    return h.length === 6 ? `#${h}${alpha}` : hex;
  };
  return {
    background: v["--term-bg"] || "#1b1f27",
    foreground: v["--term-fg"] || "#d5dae3",
    cursor: v["--term-cursor"] || "#7aa2ff",
    cursorAccent: v["--term-bg"] || "#1b1f27",
    selectionBackground: hex8(v["--term-selection"] || "#3b6ef5"),
    black: v["--term-black"] || "#2a2f3a",
    red: v["--term-red"] || "#e06c75",
    green: v["--term-green"] || "#4ec9a0",
    yellow: v["--term-yellow"] || "#e5c07b",
    blue: v["--term-blue"] || "#61afef",
    magenta: v["--term-magenta"] || "#c678dd",
    cyan: v["--term-cyan"] || "#56b6c2",
    white: v["--term-white"] || "#d5dae3",
    brightBlack: v["--term-black"] || "#2a2f3a",
    brightRed: v["--term-red"] || "#e06c75",
    brightGreen: v["--term-green"] || "#4ec9a0",
    brightYellow: v["--term-yellow"] || "#e5c07b",
    brightBlue: v["--term-blue"] || "#61afef",
    brightMagenta: v["--term-magenta"] || "#c678dd",
    brightCyan: v["--term-cyan"] || "#56b6c2",
    brightWhite: v["--term-white"] || "#d5dae3",
  };
}
