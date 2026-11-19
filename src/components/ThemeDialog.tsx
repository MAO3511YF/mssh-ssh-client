import { useEffect, useMemo, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import {
  applyCustomVars, COLOR_GROUPS, COLOR_TOKENS, getEffectiveVars,
  resetToPreset, themes, type ThemePreset,
} from "../theme";
import { useModal } from "../useModal";

interface Props {
  onClose: () => void;
  currentId: string;
  onApply: (id: string) => void;
}

export function ThemeDialog({ onClose, currentId, onApply }: Props) {
  const dialogRef = useModal<HTMLDivElement>(onClose);
  const [presetId, setPresetId] = useState(() => (themes.some((t) => t.id === currentId) ? currentId : themes[0].id));
  const [vars, setVars] = useState<Record<string, string>>(() => getEffectiveVars());

  // 打开时同步一次实际生效的色值（含自定义）
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
    applyCustomVars(next, presetId === "custom" ? themes[0].id : presetId);
    onApply("custom");
  };

  const doReset = () => {
    const t = themes.find((x) => x.id === presetId) ?? themes[0];
    setVars({ ...t.vars });
    resetToPreset(t.id);
    onApply(t.id);
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal theme-page" role="dialog" aria-modal="true" aria-labelledby="theme-title" ref={dialogRef}>
        <div className="modal-head">
          <div><h2 id="theme-title">主题设置</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="theme-page-body">
          <section className="theme-section">
            <h3 className="theme-section-title">预设主题</h3>
            <div className="theme-presets">
              {themes.map((t) => (
                <button
                  key={t.id}
                  className={`theme-item ${presetId === t.id ? "on" : ""}`}
                  onClick={() => pickPreset(t)}
                >
                  <span className="theme-swatch" style={{ background: t.vars["--bg"], borderColor: t.vars["--line"] }}>
                    <span style={{ background: t.vars["--accent"] }} />
                    <span style={{ background: t.vars["--text"] }} />
                  </span>
                  <span className="theme-name">{t.name}</span>
                  {presetId === t.id && <Check size={16} className="theme-check" />}
                </button>
              ))}
            </div>
          </section>

          <section className="theme-section">
            <div className="theme-section-head">
              <div>
                <h3 className="theme-section-title">自定义颜色</h3>
                <p className="theme-section-desc">修改后即时预览，设置会自动保存</p>
              </div>
              <button className="btn tiny" onClick={doReset} title="恢复当前预设配色">
                <RotateCcw size={13} /> 重置
              </button>
            </div>

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
                            <input
                              type="color"
                              value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
                              onChange={(e) => setColor(t.key, e.target.value)}
                              aria-label={t.label}
                            />
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
        </div>

        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
