/**
 * 全局快捷键匹配。
 *
 * 设置里录制的组合键统一是 "Ctrl+Shift+K" 这种形式（修饰键在前，主键在最后），
 * 这里把它和真实按键事件对上：修饰键必须完全一致（多按少按都不算），
 * 主键按大小写无关比较。
 */
export function matchShortcut(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const wantCtrl = mods.some((m) => m === "ctrl" || m === "meta" || m === "cmd");
  const wantAlt = mods.includes("alt");
  const wantShift = mods.includes("shift");
  if ((e.ctrlKey || e.metaKey) !== wantCtrl) return false;
  if (e.altKey !== wantAlt) return false;
  if (e.shiftKey !== wantShift) return false;
  const pressed = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return pressed.toUpperCase() === key.toUpperCase();
}
