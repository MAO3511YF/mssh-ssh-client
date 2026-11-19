import { useMemo, useState } from "react";
import { Eye, EyeOff, Save, PlugZap, X } from "lucide-react";
import { useAppStore } from "../store";
import { AUTH_METHODS, COLOR_LABELS, ENV_OPTIONS } from "../constants";
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
    if (names.length === 0) names.push("常用");
    return names;
  }, [folders, sessions, editing]);

  const [name, setName] = useState(editing?.name ?? "");
  const [directory, setDirectory] = useState(editing?.directory ?? workspaceNames[0]);
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "root");
  const [auth, setAuth] = useState<AuthType>(editing?.authMethod ?? "password");
  const [password, setPassword] = useState(editing?.password ?? "");
  const [keyPath, setKeyPath] = useState(editing?.privateKeyPath ?? "");
  const [color, setColor] = useState(editing?.color ?? "#3b6ef5");
  const [env, setEnv] = useState(editing?.env?.stage ?? "开发环境");
  const [note, setNote] = useState(editing?.note ?? "");
  const [showPwd, setShowPwd] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = "请输入名称";
    if (!directory.trim()) e.directory = "请选择工作区";
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
    color, note, env: { stage: env }, createdAt: editing?.createdAt ?? Date.now(),
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

  const test = () => {
    if (!host.trim()) { showToast("请先填写主机地址", "error"); return; }
    showToast("测试连接成功（演示）", "success");
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
              <select value={directory} onChange={(e) => { setDirectory(e.target.value); setErrors((x) => ({ ...x, directory: "" })); }}>
                {workspaceNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
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
                  <input type={showPwd ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                  <button className="icon-btn" title={showPwd ? "隐藏" : "显示"} onClick={() => setShowPwd((v) => !v)}>
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            )}

            {auth === "privateKey" && (
              <label className="field wide">
                <span>私钥路径</span>
                <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
              </label>
            )}

            <label className="field">
              <span>环境</span>
              <select value={env} onChange={(e) => setEnv(e.target.value)}>
                {ENV_OPTIONS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>

            <div className="field">
              <span>标记颜色</span>
              <div className="color-row">
                {COLOR_LABELS.map((c) => (
                  <button key={c.value} title={c.label} className={`color-dot ${color === c.value ? "on" : ""}`} style={{ background: c.value }} onClick={() => setColor(c.value)} />
                ))}
              </div>
            </div>

            <label className="field wide">
              <span>备注</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="可选备注信息" />
            </label>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={test}><PlugZap size={15} /> 测试连接</button>
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>取消</button>
          <button className="btn secondary" onClick={save}><Save size={15} /> 保存</button>
          <button className="btn primary" onClick={saveAndConnect}>保存并连接</button>
        </div>
      </div>
    </div>
  );
}
