import { useEffect, useMemo, useState } from "react";
import { AppWindow, Check, Code2, LayoutGrid, MousePointer2, Palette, Plus, RotateCcw, Terminal, Trash2, X } from "lucide-react";
import {
  allThemes, applyCustomVars, COLOR_GROUPS, COLOR_TOKENS, getEffectiveVars,
  removeSavedTheme, resetToPreset, saveTheme, themes, type ThemePreset,
} from "../theme";
import { useAppStore } from "../store";
import { BRAND_FONTS, TERMINAL_FONT_STACK } from "../constants";
import { installedTerminalFonts, primaryFamily, resolveDefaultFamily } from "../fonts";
import { DEFAULT_EDITOR_SHORTCUTS, DEFAULT_PREFERENCES, EDITOR_SHORTCUTS, type Preferences } from "../types";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
  currentId: string;
  onApply: (id: string) => void;
}

type Tab = "theme" | "workspace" | "input" | "terminal" | "editor" | "window";

function KeyCap({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") { setListening(false); return; }
      // 只按修饰键时不录制，等真正的按键
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods: string[] = [];
      if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      onChange([...mods, key].join("+"));
      setListening(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, onChange]);
  return (
    <button
      className={`keycap ${listening ? "listening" : ""}`}
      onClick={() => setListening(true)}
      title="点击后按新快捷键"
    >
      {listening ? "按键…" : value}
    </button>
  );
}

function ToggleRow({ label, desc, value, onChange }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="pref-row">
      <div className="pref-info"><b>{label}</b>{desc && <span>{desc}</span>}</div>
      <button
        className={`switch ${value ? "on" : ""}`}
        role="switch"
        aria-checked={value}
        aria-label={label}
        title={`${label}：${value ? "已开启，点击关闭" : "已关闭，点击开启"}`}
        onClick={() => onChange(!value)}
      ><i /></button>
    </div>
  );
}

function NumberRow({ label, value, onChange, min, max }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number;
}) {
  return (
    <div className="pref-row">
      <div className="pref-info"><b>{label}</b></div>
      <input className="pref-number" type="number" min={min} max={max} value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
    </div>
  );
}

function Choice<T extends string>({ value, options, onChange }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="seg-choice">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

export function SettingsDialog({ onClose, currentId, onApply }: Props) {
  const dialogRef = useModal<HTMLDivElement>(onClose);
  const [tab, setTab] = useState<Tab>("theme");
  const [themeList, setThemeList] = useState<ThemePreset[]>(() => allThemes());
  const [presetId, setPresetId] = useState(() => (allThemes().some((t) => t.id === currentId) ? currentId : allThemes()[0].id));
  const [vars, setVars] = useState<Record<string, string>>(() => getEffectiveVars());
  const [savingTheme, setSavingTheme] = useState(false);
  const [themeName, setThemeName] = useState("");
  const preferences = useAppStore((s) => s.preferences);
  const setPreference = useAppStore((s) => s.setPreference);
  const clearHistory = useAppStore((s) => s.clearHistory);
  const clearEditorCache = useAppStore((s) => s.clearEditorCache);
  const showToast = useAppStore((s) => s.showToast);

  useEffect(() => { setVars(getEffectiveVars()); }, []);

  const groups = useMemo(
    () => COLOR_GROUPS.map((g) => ({ ...g, tokens: COLOR_TOKENS.filter((t) => t.group === g.id) })),
    [],
  );

  const pickPreset = (t: ThemePreset) => {
    setPresetId(t.id);
    setVars({ ...t.vars });
    resetToPreset(t.id);
    onApply(t.id);
  };
  const setColor = (key: string, value: string) => {
    const next = { ...vars, [key]: value };
    setVars(next);
    setPresetId("custom");
    applyCustomVars(next, themeList.find((t) => t.id === presetId)?.id ?? themes[0].id);
    onApply("custom");
  };
  const doReset = () => {
    const t = themeList.find((x) => x.id === presetId) ?? themes[0];
    setVars({ ...t.vars });
    resetToPreset(t.id);
    onApply(t.id);
  };
  const doSaveTheme = () => {
    const t = saveTheme(themeName, vars, themeList.find((x) => x.id === presetId)?.id);
    setThemeList(allThemes());
    setPresetId(t.id);
    setVars({ ...t.vars });
    resetToPreset(t.id);
    onApply(t.id);
    setSavingTheme(false);
    setThemeName("");
  };
  const doDeleteTheme = (id: string) => {
    removeSavedTheme(id);
    if (presetId === id) {
      setPresetId(themes[0].id);
      setVars({ ...themes[0].vars });
      resetToPreset(themes[0].id);
      onApply(themes[0].id);
    }
    setThemeList(allThemes());
  };
  const setPref = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setPreference(key, value);

  // 现场探测本机真实可用的等宽字体：没装的字体不进下拉，避免「选了没反应」的假选项
  const fontOptions = useMemo(() => installedTerminalFonts(), []);
  const defaultFamily = useMemo(() => resolveDefaultFamily(), []);
  const currentFont = preferences.terminalFont;
  const fontSelectValue = currentFont === ""
    ? ""
    : fontOptions.some((f) => f.value === currentFont)
      ? currentFont
      : "__custom";

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal settings-page" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef}>
        <div className="modal-head">
          <div><h2 id="settings-title">设置</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav">
            <button className={tab === "theme" ? "on" : ""} onClick={() => setTab("theme")}><Palette size={15} /> 外观主题</button>
            <button className={tab === "workspace" ? "on" : ""} onClick={() => setTab("workspace")}><LayoutGrid size={15} /> 工作区</button>
            <button className={tab === "input" ? "on" : ""} onClick={() => setTab("input")}><MousePointer2 size={15} /> 鼠标与快捷键</button>
            <button className={tab === "terminal" ? "on" : ""} onClick={() => setTab("terminal")}><Terminal size={15} /> 终端</button>
            <button className={tab === "editor" ? "on" : ""} onClick={() => setTab("editor")}><Code2 size={15} /> 编辑器</button>
            <button className={tab === "window" ? "on" : ""} onClick={() => setTab("window")}><AppWindow size={15} /> 窗口</button>
          </nav>

          <div className="settings-content">
            {tab === "theme" && (
              <>
                <section className="theme-section">
                  <h3 className="theme-section-title">主题</h3>
                  <div className="theme-presets">
                    {themeList.map((t) => (
                      <div
                        key={t.id}
                        className={`theme-item ${presetId === t.id ? "on" : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => pickPreset(t)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickPreset(t); } }}
                      >
                        <span className="theme-swatch" style={{ background: t.vars["--bg"], borderColor: t.vars["--line"] }}>
                          <span style={{ background: t.vars["--accent"] }} />
                          <span style={{ background: t.vars["--text"] }} />
                        </span>
                        <span className="theme-name">{t.name}</span>
                        {t.id.startsWith("saved-") && (
                          <button className="theme-remove" title="删除主题" onClick={(e) => { e.stopPropagation(); doDeleteTheme(t.id); }}>
                            <Trash2 size={13} />
                          </button>
                        )}
                        {presetId === t.id && <Check size={16} className="theme-check" />}
                      </div>
                    ))}
                  </div>
                </section>

                <section className="theme-section">
                  <div className="theme-section-head">
                    <h3 className="theme-section-title">自定义颜色</h3>
                    <div className="theme-section-actions">
                      <button className="btn tiny" onClick={() => { setSavingTheme((v) => !v); setThemeName(""); }} title="保存当前配色到主题"><Plus size={13} /> 保存到主题</button>
                      <button className="btn tiny" onClick={doReset} title="恢复当前主题配色"><RotateCcw size={13} /> 重置</button>
                    </div>
                  </div>
                  {savingTheme && (
                    <div className="theme-save-row">
                      <input autoFocus value={themeName} placeholder="主题名称"
                        onChange={(e) => setThemeName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") doSaveTheme(); if (e.key === "Escape") setSavingTheme(false); }}
                      />
                      <button className="btn primary tiny" onClick={doSaveTheme}>保存</button>
                      <button className="btn ghost tiny" onClick={() => setSavingTheme(false)}>取消</button>
                    </div>
                  )}
                  <div className="theme-groups">
                    {groups.map((g) => (
                      <div className="theme-group" key={g.id}>
                        <div className="theme-group-head">
                          <span className="theme-group-name">{g.name}</span>
                          <span className="theme-group-desc">{g.desc}</span>
                        </div>
                        <div className="color-grid">
                          {g.tokens.map((t) => {
                            const value = vars[t.key] || "#000000";
                            return (
                              <label className="color-item" key={t.key}>
                                <span className="color-swatch-wrap">
                                  <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"} onChange={(e) => setColor(t.key, e.target.value)} aria-label={t.label} />
                                </span>
                                <span className="color-meta">
                                  <span className="color-label">{t.label}</span>
                                  <span className="color-key">{t.key}</span>
                                </span>
                                <span className="color-hex">{value}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="theme-section">
                  <h3 className="theme-section-title">终端文字</h3>
                  {/* 预览用终端自己的深色底，所见即所得；改完立刻同步到所有已打开的终端 */}
                  <div className="term-preview">
                    <span
                      className="term-preview-line"
                      style={{
                        fontFamily: preferences.terminalFont || TERMINAL_FONT_STACK,
                        fontSize: `${preferences.terminalFontSize || 12.5}px`,
                      }}
                    >
                      <i>ubuntu@web-01</i>:<b>~</b>$ ls -lh /var/log
                    </span>
                  </div>
                  <div className="pref-row">
                    <div className="pref-info">
                      <b>字体</b>
                      <span>
                        {fontOptions.length > 0
                          ? `已检测到 ${fontOptions.length} 款本机可用的等宽字体，未安装的不会列出`
                          : "无法检测本机字体，请在下方手动填写 font-family"}
                      </span>
                    </div>
                    <select
                      className="pref-select"
                      value={fontSelectValue}
                      onChange={(e) => {
                        // "__custom" 只是「当前值不在列表里」的占位，选中它不改变设置
                        if (e.target.value === "__custom") return;
                        setPref("terminalFont", e.target.value);
                      }}
                    >
                      <option value="">等宽默认（{defaultFamily ?? "系统等宽"}）</option>
                      {fontOptions.map((f) => (
                        <option key={f.family} value={f.value} style={{ fontFamily: f.value }}>{f.label}</option>
                      ))}
                      {fontSelectValue === "__custom" && (
                        <option value="__custom">
                          {currentFont ? `${primaryFamily(currentFont)}（未安装，已回退）` : "自定义"}
                        </option>
                      )}
                    </select>
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>自定义字体</b><span>直接填 font-family；系统没装的字体会被浏览器的兜底字体替换</span></div>
                    <input
                      className="pref-text"
                      value={preferences.terminalFont}
                      placeholder={TERMINAL_FONT_STACK}
                      onChange={(e) => setPref("terminalFont", e.target.value)}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>字号</b><span>单位 px，改完终端会自动重排行列</span></div>
                    <input
                      className="pref-number" type="number" min={9} max={28} step={0.5}
                      value={preferences.terminalFontSize}
                      onChange={(e) => setPref("terminalFontSize", Math.max(9, Math.min(28, Number(e.target.value) || 12.5)))}
                    />
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => {
                    setPref("terminalFont", DEFAULT_PREFERENCES.terminalFont);
                    setPref("terminalFontSize", DEFAULT_PREFERENCES.terminalFontSize);
                  }}><RotateCcw size={13} /> 恢复默认</button>
                </section>

                <section className="theme-section">
                  <div className="theme-section-head">
                    <h3 className="theme-section-title">品牌文字</h3>
                    <ToggleRow
                      label="显示" desc="关闭则隐藏顶栏字样"
                      value={preferences.brandVisible}
                      onChange={(v) => setPref("brandVisible", v)}
                    />
                  </div>
                  <div className="brand-preview-box">
                    <span
                      className="brand-preview-text"
                      style={{
                        fontFamily: preferences.brandFont || undefined,
                        fontSize: `${preferences.brandFontSize}px`,
                        fontWeight: preferences.brandWeight,
                        color: preferences.brandColor || "var(--text)",
                        letterSpacing: `${preferences.brandSpacing}px`,
                      }}
                    >{preferences.brandText || "MSSH"}</span>
                    <span className="brand-preview-tip">实时预览</span>
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>文字内容</b><span>改成你喜欢的名称</span></div>
                    <input className="pref-text" value={preferences.brandText} maxLength={24}
                      onChange={(e) => setPref("brandText", e.target.value)} placeholder="MSSH" />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>字体</b><span>内置多款圆润可爱字体</span></div>
                    <select className="pref-select" value={BRAND_FONTS.some((f) => f.value === preferences.brandFont) ? preferences.brandFont : "__custom"}
                      onChange={(e) => setPref("brandFont", e.target.value === "__custom" ? preferences.brandFont : e.target.value)}>
                      {BRAND_FONTS.map((f) => (
                        <option key={f.label} value={f.value} style={{ fontFamily: f.value || undefined }}>
                          {f.label}
                        </option>
                      ))}
                      {!BRAND_FONTS.some((f) => f.value === preferences.brandFont) && <option value="__custom">自定义</option>}
                    </select>
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>自定义字体</b><span>直接填 font-family，留空则跟随上方预设</span></div>
                    <input className="pref-text" value={preferences.brandFont} placeholder="例如 'Comic Sans MS', cursive"
                      onChange={(e) => setPref("brandFont", e.target.value)} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>字号</b><span>单位 px</span></div>
                    <input className="pref-number" type="number" min={10} max={40} value={preferences.brandFontSize}
                      onChange={(e) => setPref("brandFontSize", Math.max(10, Math.min(40, Number(e.target.value) || 13)))} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>字间距</b><span>单位 px</span></div>
                    <input className="pref-number" type="number" min={-2} max={10} step={0.5} value={preferences.brandSpacing}
                      onChange={(e) => setPref("brandSpacing", Math.max(-2, Math.min(10, Number(e.target.value) || 0)))} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>字重</b><span>越粗越醒目</span></div>
                    <Choice
                      value={String(preferences.brandWeight)}
                      options={[
                        { v: "400", label: "常规" }, { v: "500", label: "中等" },
                        { v: "600", label: "半粗" }, { v: "700", label: "粗" }, { v: "800", label: "特粗" },
                      ]}
                      onChange={(v) => setPref("brandWeight", Number(v) as Preferences["brandWeight"])}
                    />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>颜色</b><span>关闭「跟随主题」可自定义</span></div>
                    <div className="pref-color-control">
                      <input className="pref-color" type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(preferences.brandColor) ? preferences.brandColor : "#c2185b"}
                        disabled={!preferences.brandColor}
                        onChange={(e) => setPref("brandColor", e.target.value)} />
                      <button
                        className={`switch ${preferences.brandColor ? "on" : ""}`}
                        role="switch"
                        aria-checked={Boolean(preferences.brandColor)}
                        title="跟随主题色"
                        onClick={() => setPref("brandColor", preferences.brandColor ? "" : "#c2185b")}
                      ><i /></button>
                    </div>
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => {
                    setPref("brandVisible", DEFAULT_PREFERENCES.brandVisible);
                    setPref("brandText", DEFAULT_PREFERENCES.brandText);
                    setPref("brandFont", DEFAULT_PREFERENCES.brandFont);
                    setPref("brandFontSize", DEFAULT_PREFERENCES.brandFontSize);
                    setPref("brandWeight", DEFAULT_PREFERENCES.brandWeight);
                    setPref("brandColor", DEFAULT_PREFERENCES.brandColor);
                    setPref("brandSpacing", DEFAULT_PREFERENCES.brandSpacing);
                  }}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </>
            )}

            {tab === "workspace" && (
              <div className="prefs-page">
                <section className="pref-section">
                  <h3 className="theme-section-title">分屏</h3>
                  <div className="pref-row">
                    <div className="pref-info"><b>最大分屏数量</b><span>双击标签逐步分屏，最多拆到此处设置的窗格数</span></div>
                    <Choice
                      value={String(preferences.maxPanes ?? 4)}
                      options={[{ v: "2", label: "2 屏" }, { v: "3", label: "3 屏" }, { v: "4", label: "4 屏" }]}
                      onChange={(v) => { setPref("maxPanes", Number(v) as 2 | 3 | 4); useAppStore.getState().clampPanes(); }}
                    />
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => setPref("maxPanes", DEFAULT_PREFERENCES.maxPanes)}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </div>
            )}

            {tab === "input" && (
              <div className="prefs-page">
                <section className="pref-section">
                  <h3 className="theme-section-title">鼠标</h3>
                  <div className="pref-row">
                    <div className="pref-info"><b>文件列表右键</b><span>右键单击文件时的行为</span></div>
                    <Choice value={preferences.rightClick} options={[{ v: "menu", label: "更多操作" }, { v: "copyPath", label: "复制路径" }]} onChange={(v) => setPref("rightClick", v)} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info"><b>终端右键粘贴</b><span>在终端内右键直接粘贴剪贴板内容</span></div>
                    <button
                      className={`switch ${preferences.terminalRightPaste ? "on" : ""}`}
                      role="switch"
                      aria-checked={preferences.terminalRightPaste}
                      aria-label="终端右键粘贴"
                      onClick={() => setPref("terminalRightPaste", !preferences.terminalRightPaste)}
                    ><i /></button>
                  </div>
                </section>

                <section className="pref-section">
                  <h3 className="theme-section-title">快捷键</h3>
                  <div className="pref-row"><div className="pref-info"><b>搜索命令</b><span>打开工作台的命令仓库并聚焦搜索框</span></div><KeyCap value={preferences.search} onChange={(v) => setPref("search", v)} /></div>
                  <div className="pref-row"><div className="pref-info"><b>新建连接</b><span>任何界面下都生效</span></div><KeyCap value={preferences.newConnection} onChange={(v) => setPref("newConnection", v)} /></div>
                  <div className="pref-row"><div className="pref-info"><b>关闭标签</b><span>焦点在终端内时不拦截，避免占用 shell 的按键</span></div><KeyCap value={preferences.closeTab} onChange={(v) => setPref("closeTab", v)} /></div>
                  <button className="btn tiny pref-reset" onClick={() => { for (const k of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) setPref(k, DEFAULT_PREFERENCES[k] as never); }}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </div>
            )}

            {tab === "terminal" && (
              <div className="prefs-page">
                <section className="pref-section">
                  <h3 className="theme-section-title">终端</h3>
                  <div className="settings-grid">
                    <ToggleRow label="连接断开自动重连" value={preferences.terminalAutoReconnect} onChange={(v) => setPref("terminalAutoReconnect", v)} />
                    <ToggleRow label="鼠标选中自动复制" value={preferences.terminalCopyOnSelect} onChange={(v) => setPref("terminalCopyOnSelect", v)} />
                    <ToggleRow label="终端声音" value={preferences.terminalBell} onChange={(v) => setPref("terminalBell", v)} />
                    <div className="pref-row">
                      <div className="pref-info"><b>鼠标中键执行</b></div>
                      <Choice value={preferences.terminalMiddleClick} options={[{ v: "none", label: "不执行" }, { v: "paste", label: "粘贴" }]} onChange={(v) => setPref("terminalMiddleClick", v)} />
                    </div>
                    <ToggleRow label="鼠标右键粘贴" value={preferences.terminalRightPaste} onChange={(v) => setPref("terminalRightPaste", v)} />
                    <ToggleRow label="Ctrl+V 粘贴拦截" value={preferences.terminalCtrlVPaste} onChange={(v) => setPref("terminalCtrlVPaste", v)} />
                    <ToggleRow
                      label="cd 跟随跳转"
                      desc="在终端 cd 到某目录时，文件面板的远程目录同步跳转过去"
                      value={preferences.terminalFollowCd}
                      onChange={(v) => setPref("terminalFollowCd", v)}
                    />
                    <NumberRow label="最大缓存行数" value={preferences.terminalScrollback} min={100} max={20000} onChange={(v) => setPref("terminalScrollback", v)} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info">
                      <b>命令历史</b>
                      <span>群发历史保存在本机，可能包含敏感参数，可随时清空</span>
                    </div>
                    <button className="btn tiny" onClick={() => { clearHistory(); showToast("命令历史已清空", "success"); }}>
                      <Trash2 size={13} /> 清空历史
                    </button>
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => { for (const k of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) setPref(k, DEFAULT_PREFERENCES[k] as never); }}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </div>
            )}

            {tab === "editor" && (
              <div className="prefs-page">
                <section className="pref-section">
                  <h3 className="theme-section-title">编辑器</h3>
                  <div className="settings-grid">
                    <NumberRow label="字号" value={preferences.editorFontSize} min={10} max={22} onChange={(v) => setPref("editorFontSize", v)} />
                    <div className="pref-row">
                      <div className="pref-info"><b>Tab 缩进</b></div>
                      <Choice value={String(preferences.editorTabSize)} options={[{ v: "2", label: "2 空格" }, { v: "4", label: "4 空格" }]} onChange={(v) => setPref("editorTabSize", Number(v))} />
                    </div>
                    <ToggleRow label="自动换行" value={preferences.editorWordWrap} onChange={(v) => setPref("editorWordWrap", v)} />
                  </div>
                  <div className="pref-row">
                    <div className="pref-info">
                      <b>本地缓存</b>
                      <span>草稿与远程文件内容以明文保存在本机，可随时清空</span>
                    </div>
                    <button className="btn tiny" onClick={() => { clearEditorCache(); showToast("编辑器缓存已清空", "success"); }}>
                      <Trash2 size={13} /> 清空缓存
                    </button>
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => { for (const k of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) setPref(k, DEFAULT_PREFERENCES[k] as never); }}><RotateCcw size={13} /> 恢复默认</button>
                </section>
                <section className="pref-section">
                  <div className="theme-section-head">
                    <h3 className="theme-section-title">快捷键</h3>
                    <span className="pref-hint">点击右侧按键可重新录制</span>
                  </div>
                  <div className="shortcut-grid">
                    {EDITOR_SHORTCUTS.map(({ id, label }) => (
                      <div className="shortcut-item" key={id}>
                        <span>{label}</span>
                        <KeyCap
                          value={preferences.editorShortcuts?.[id] ?? DEFAULT_EDITOR_SHORTCUTS[id]}
                          onChange={(v) => setPref("editorShortcuts", { ...DEFAULT_EDITOR_SHORTCUTS, ...preferences.editorShortcuts, [id]: v })}
                        />
                      </div>
                    ))}
                  </div>
                  <button className="btn tiny pref-reset" onClick={() => setPref("editorShortcuts", { ...DEFAULT_EDITOR_SHORTCUTS })}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </div>
            )}

            {tab === "window" && (
              <div className="prefs-page">
                <section className="pref-section">
                  <h3 className="theme-section-title">关闭窗口时</h3>
                  <div className="pref-row">
                    <div className="pref-info"><b>关闭行为</b><span>点击右上角 X 时执行的动作</span></div>
                    <Choice
                      value={preferences.closeAction}
                      options={[
                        { v: "ask", label: "每次询问" },
                        { v: "quit", label: "退出程序" },
                        { v: "tray", label: "隐藏到后台" },
                      ]}
                      onChange={(v) => setPref("closeAction", v)}
                    />
                  </div>
                  <p className="pref-note">选择「每次询问」时，关闭会弹出提示，可勾选记住选择。</p>
                  <button className="btn tiny pref-reset" onClick={() => setPref("closeAction", DEFAULT_PREFERENCES.closeAction)}><RotateCcw size={13} /> 恢复默认</button>
                </section>
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
