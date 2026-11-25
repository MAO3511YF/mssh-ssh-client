import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Save, PlugZap, X } from "lucide-react";
import { useAppStore } from "../store";
import { driver } from "../drivers";
import { AUTH_METHODS, COLOR_LABELS } from "../constants";
import type { AuthType, SessionConfig } from "../types";
import { useModal } from "../useModal";

interface Props {
  editing?: SessionConfig;
  onClose: () => void;
}

export function SessionDialog({ editing, onClose }: Props) {
  const upsert = useAppStore((s) => s.upsertSession);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const showToast = useAppStore((s) => s.showToast);
  const folders = useAppStore((s) => s.folders);
  const sessions = useAppStore((s) => s.sessions);
  const dialogRef = useModal<HTMLDivElement>(onClose);

  // 可选工作区 = 侧栏已有的工作区（含空工作区）+ 连接里出现过的工作区，去重保序
  const workspaceNames = useMemo(() => {
    const names: string[] = [];
    const push = (v?: string) => {
      const n = (v ?? "").trim();
      if (n && !names.includes(n)) names.push(n);
    };
    folders.forEach(push);
    sessions.forEach((s) => push(s.directory));
    push(editing?.directory);
    return names;
  }, [folders, sessions, editing]);

  const hasWorkspace = workspaceNames.length > 0;

  const [name, setName] = useState(editing?.name ?? "");
  const [directory, setDirectory] = useState(editing?.directory ?? workspaceNames[0] ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "root");
  const [auth, setAuth] = useState<AuthType>(editing?.authMethod ?? "password");
  const [password, setPassword] = useState(editing?.password ?? "");
  const [keyPath, setKeyPath] = useState(editing?.privateKeyPath ?? "");
  const [color, setColor] = useState(editing?.color ?? "#3b6ef5");
  const [showPwd, setShowPwd] = useState(false);
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 只问后端"有没有存过密码"，不把明文取回前端
  useEffect(() => {
    let alive = true;
    if (editing?.id && auth === "password") {
      void driver.secretHas(editing.id)
        .then((v) => { if (alive) setHasSavedPassword(v); })
        .catch(() => { if (alive) setHasSavedPassword(false); });
    } else {
      setHasSavedPassword(false);
    }
    return () => { alive = false; };
  }, [editing?.id, auth]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "请输入名称";
    if (!directory.trim()) e.directory = "请先新建并选择一个工作区";
    if (!host.trim()) e.host = "请输入主机地址";
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) e.port = "端口无效";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const build = (): SessionConfig => ({
    id: editing?.id ?? `s-${Date.now()}`,
    type: "ssh", name: name.trim(), directory: directory.trim(),
    host: host.trim(), port: +port, username: username.trim(),
    authMethod: auth,
    password: auth === "password" ? password : undefined,
    privateKeyPath: auth === "privateKey" ? keyPath : undefined,
    color, createdAt: editing?.createdAt ?? Date.now(),
  });

  const save = () => {
    if (!validate()) return;
    upsert(build());
    showToast("已保存连接配置", "success");
    onClose();
  };

  const saveAndConnect = () => {
    if (!validate()) return;
    const cfg = build();
    upsert(cfg);
    openWorkspace(cfg);
    onClose();
  };

  const test = async () => {
    if (!host.trim()) { showToast("请先填写主机地址", "error"); return; }
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) { showToast("端口无效", "error"); return; }
    if (testing) return;
    setTesting(true);
    try {
      // 测试用表单当前值；编辑已保存连接且密码留空时，后端会从凭据库取回（带绑定校验）
      const cfg: SessionConfig = {
        ...build(),
        // build() 要求名称/工作区，但测试连接只需要地址与认证信息，这里放宽
        name: name.trim() || "测试连接",
        directory: directory.trim() || "测试",
        id: editing?.id ?? `test-${Date.now()}`,
        secretId: editing?.id,
      };
      const message = await driver.testConnection(cfg);
      showToast(message, "success");
    } catch (e) {
      showToast(`测试连接失败：${String(e)}`, "error");
    } finally {
      setTesting(false);
    }
  };

  const clearSavedPassword = () => {
    if (!editing) return;
    void driver.secretRemove(editing.id).then(() => {
      setHasSavedPassword(false);
      showToast("已清除该连接保存的密码", "success");
    }).catch((e) => showToast(`清除失败: ${String(e)}`, "error"));
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="session-title" ref={dialogRef}>
        <div className="modal-head">
          <div>
            <h2 id="session-title">{editing ? "Edit Connection" : "New Connection"}</h2>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="modal-body">
          <div className="form-grid">
            <label className="field">
              <span>名称 <b>*</b></span>
              <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setErrors((x) => ({ ...x, name: "" })); }} placeholder="例如：生产 Web 服务器" />
              {errors.name && <small className="err">{errors.name}</small>}
            </label>

            <label className="field">
              <span>工作区 <b>*</b></span>
              <select value={directory} onChange={(e) => { setDirectory(e.target.value); setErrors((x) => ({ ...x, directory: "" })); }} disabled={!hasWorkspace}>
                {!hasWorkspace && <option value="">尚无工作区，请先新建</option>}
                {workspaceNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {!hasWorkspace && <small className="err hint">请先在左侧点右上角图标新建一个工作区</small>}
              {errors.directory && <small className="err">{errors.directory}</small>}
            </label>

            <label className="field wide">
              <span>主机地址 <b>*</b></span>
              <input value={host} onChange={(e) => { setHost(e.target.value); setErrors((x) => ({ ...x, host: "" })); }} placeholder="example.com 或 192.168.1.10" spellCheck={false} />
              {errors.host && <small className="err">{errors.host}</small>}
            </label>

            <label className="field">
              <span>端口</span>
              <input value={port} onChange={(e) => { setPort(e.target.value); setErrors((x) => ({ ...x, port: "" })); }} inputMode="numeric" />
              {errors.port && <small className="err">{errors.port}</small>}
            </label>

            <label className="field">
              <span>用户名</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>

            <div className="field wide">
              <span>认证方式</span>
              <div className="seg-group wrap">
                {AUTH_METHODS.map((a) => (
                  <button key={a.value} className={`seg ${auth === a.value ? "on" : ""}`} onClick={() => setAuth(a.value)}>{a.label}</button>
                ))}
              </div>
            </div>

            {auth === "password" && (
              <label className="field wide">
                <span>密码</span>
                <div className="input-with-action">
                  <input
                    type={showPwd ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={hasSavedPassword ? "留空则继续使用已保存密码" : "••••••••"}
                  />
                  <button className="icon-btn" title={showPwd ? "隐藏" : "显示"} onClick={() => setShowPwd((v) => !v)}>
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {hasSavedPassword && (
                  <small className="hint">
                    密码已由系统加密保存，留空即沿用；
                    <button type="button" className="link-btn" onClick={clearSavedPassword}>清除已保存密码</button>
                  </small>
                )}
              </label>
            )}

            {auth === "privateKey" && (
              <label className="field wide">
                <span>私钥路径</span>
                <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
              </label>
            )}

            <div className="field wide">
              <span>标记颜色</span>
              <div className="color-row">
                {COLOR_LABELS.map((c) => (
                  <button key={c.value} title={c.label} className={`color-dot ${color === c.value ? "on" : ""}`} style={{ background: c.value }} onClick={() => setColor(c.value)} />
                ))}
              </div>
              <small className="hint">显示在侧栏和标签页的圆点上，用来区分不同服务器。</small>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => void test()} disabled={testing}><PlugZap size={15} /> {testing ? "测试中…" : "测试连接"}</button>
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn secondary" onClick={save}><Save size={15} /> 保存</button>
          <button className="btn primary" onClick={saveAndConnect}>保存并连接</button>
        </div>
      </div>
    </div>
  );
}
