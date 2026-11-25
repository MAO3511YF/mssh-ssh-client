/**
 * 系统字体检测。
 *
 * 浏览器没有「列出已安装字体」的 API：`document.fonts.check()` 对不存在的字体
 * 也会返回 true（它只看兜底字体能不能画出来），`queryLocalFonts()` 需要权限且
 * WebView2 不保证支持。唯一可靠的办法是量字宽——用候选字体和三种兜底字体
 * 画同一串字符，宽度一致就说明系统里没装它（浏览器已经悄悄换成兜底字体了）。
 *
 * 之前终端字体下拉里的 JetBrains Mono / Fira Code 之类就是这么「看起来能选、
 * 选了没反应」的：现在只列真正装了的字体，选谁就是谁。
 */

/** 检测用样本：拉丁 + 数字 + 符号 + 中文，尽量让不同字体画出不同的宽度 */
const PROBE = "mmmmmmmmlliWWW00OQ@#%&中文字体测试";
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;

let sharedCtx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (sharedCtx === undefined) {
    const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
    sharedCtx = canvas?.getContext("2d") ?? null;
  }
  return sharedCtx;
}

function widthOf(font: string): number | null {
  const ctx = context();
  if (!ctx) return null;
  ctx.font = `72px ${font}`;
  const w = ctx.measureText(PROBE).width;
  return Number.isFinite(w) && w > 0 ? w : null;
}

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

const availability = new Map<string, boolean>();

/** 字体族是否真的装在这台机器上（与三种兜底字体逐一比对宽度） */
export function isFontInstalled(family: string): boolean {
  const cached = availability.get(family);
  if (cached !== undefined) return cached;
  const quoted = quote(family);
  let differs = 0;
  let measurable = 0;
  for (const fallback of FALLBACKS) {
    const base = widthOf(fallback);
    const probed = widthOf(`${quoted}, ${fallback}`);
    if (base === null || probed === null) continue;
    measurable += 1;
    // 宽度和兜底一致 = 浏览器把候选字体换掉了，说明系统里没有它
    if (Math.abs(probed - base) > 0.01) differs += 1;
  }
  // 三种兜底里至少两种宽度不同才认定装了：等宽字体可能和默认 monospace 同宽，
  // 只比对一种会把它误判成"没装"。缺字体时三种都会和兜底一致，不会误判成有。
  const installed = measurable >= 2 && differs >= 2;
  availability.set(family, installed);
  return installed;
}

const monoCache = new Map<string, boolean>();

/** 该字体是否为等宽字体：i / M / W 三个字符宽度相同即为等宽 */
export function isMonospace(family: string): boolean {
  const cached = monoCache.get(family);
  if (cached !== undefined) return cached;
  const ctx = context();
  let mono = false;
  if (ctx) {
    ctx.font = `72px ${quote(family)}`;
    const i = ctx.measureText("i").width;
    const m = ctx.measureText("M").width;
    const w = ctx.measureText("W").width;
    mono = i > 0 && Math.abs(i - m) < 0.01 && Math.abs(m - w) < 0.01;
  }
  monoCache.set(family, mono);
  return mono;
}

export type TerminalFontOption = { value: string; label: string; family: string };

/**
 * 候选字体目录：只用来「发现」系统里装了哪些等宽字体。
 * 没装的一律不进下拉（否则选了也只是回退到 Consolas，等于骗人）；
 * 目录里没有的字体，用户可以自己填 font-family。
 */
const MONO_CANDIDATES: { family: string; label?: string }[] = [
  { family: "JetBrains Mono" },
  { family: "Cascadia Code" },
  { family: "Cascadia Mono" },
  { family: "Fira Code" },
  { family: "Source Code Pro" },
  { family: "IBM Plex Mono" },
  { family: "Hack" },
  { family: "Inconsolata" },
  { family: "Victor Mono" },
  { family: "Iosevka" },
  { family: "Roboto Mono" },
  { family: "Ubuntu Mono" },
  { family: "DejaVu Sans Mono" },
  { family: "Noto Sans Mono" },
  { family: "Space Mono" },
  { family: "Anonymous Pro" },
  { family: "PT Mono" },
  { family: "Sarasa Mono SC", label: "更纱等宽 SC（中日文等宽）" },
  { family: "Sarasa Term SC", label: "更纱终端 SC" },
  { family: "Noto Sans Mono CJK SC", label: "Noto Sans Mono CJK SC" },
  { family: "Consolas" },
  { family: "Lucida Console" },
  { family: "Courier New" },
  { family: "Menlo" },
  { family: "Monaco" },
  { family: "SF Mono" },
];

/** 内置默认字体栈会真正落到哪一款（用于「等宽默认（Cascadia Code）」这种诚实标注） */
export function resolveDefaultFamily(): string | null {
  for (const family of ["SF Mono", "Cascadia Code", "JetBrains Mono", "Consolas", "Courier New"]) {
    if (isFontInstalled(family)) return family;
  }
  return null;
}

/** 真正可用的终端字体（已安装且为等宽），值直接就是可用的 font-family 栈 */
export function installedTerminalFonts(): TerminalFontOption[] {
  const out: TerminalFontOption[] = [];
  for (const item of MONO_CANDIDATES) {
    if (!isFontInstalled(item.family)) continue;
    // 候选目录里的字体大多是等宽；个别（如 Iosevka 变体）不是等宽就不提供
    if (!isMonospace(item.family)) continue;
    out.push({
      value: `'${item.family}', monospace`,
      label: item.label ?? item.family,
      family: item.family,
    });
  }
  return out;
}

/** 从 font-family 栈里取出首个字体族名，用于「未安装」提示 */
export function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || stack;
}
