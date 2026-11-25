import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { useAppStore } from "../store";
import { useModal } from "../useModal";

/**
 * 主机密钥确认。
 *
 * 两种情况必须分开警示，因为后果完全不同：
 * - `new`：known_hosts 里没有这台主机，属于首次连接，核对指纹即可；
 * - `changed`：记录里的指纹和服务器现在出示的不一致。更可能是服务器重装，
 *   但也可能是中间人——所以用红色警示、危险的确认按钮，并且明确写出"旧记录会被删除"。
 *
 * 两种情况都不会自动信任：后端只会中止握手并回传指纹，用户点了确认才写 known_hosts。
 */
export function HostKeyDialog() {
  const prompt = useAppStore((s) => s.hostKeyPrompt);
  const queued = useAppStore((s) => s.hostKeyQueue.length);
  const confirm = useAppStore((s) => s.confirmHostKey);
  const dismiss = useAppStore((s) => s.dismissHostKey);
  const ref = useModal<HTMLDivElement>(dismiss);
  if (!prompt) return null;

  const changed = prompt.kind === "changed";

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="modal small" role="dialog" aria-modal="true" ref={ref}>
        <div className="modal-head">
          <div><h2>{changed ? "主机指纹已变化" : "首次连接：确认主机指纹"}</h2></div>
          <button className="icon-btn" aria-label="关闭" onClick={dismiss}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {changed ? (
            <>
              <div className="hostkey-warn">
                <AlertTriangle size={16} />
                <span>
                  <b>{prompt.name}</b>（{prompt.host}:{prompt.port}）出示的密钥与 known_hosts 里的记录不一致。
                  可能是服务器重装 / 换了主机密钥，也可能是<b>中间人冒充这台服务器</b>，
                  届时你的密码和所有命令都会经过对方。
                </span>
              </div>
              <p className="confirm-text">当前服务器出示的指纹：</p>
              <code className="fingerprint">{prompt.fingerprint}</code>
              <p className="confirm-hint">
                只有你能确认这台机器确实重装过系统时才继续。确认后会<b>删除旧记录</b>，
                并把新指纹写入 <b>~/.ssh/known_hosts</b>。拿不准就点「取消」，先用系统 ssh 登录核对指纹。
              </p>
            </>
          ) : (
            <>
              <p className="confirm-text">
                <b>{prompt.name}</b>（{prompt.host}:{prompt.port}）是第一次连接，
                known_hosts 里没有它的记录。请与服务器管理员核对下面的指纹：
              </p>
              <code className="fingerprint">{prompt.fingerprint}</code>
              <p className="confirm-hint">
                指纹不一致说明链路可能被中间人劫持，请点「取消」。
                确认后指纹会写入 <b>~/.ssh/known_hosts</b>，以后该主机指纹一旦变化将直接拒绝连接。
              </p>
            </>
          )}
          {queued > 0 && (
            <p className="confirm-hint">另有 {queued} 台主机在等待确认，这台处理完会接着显示。</p>
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button className="btn secondary" onClick={dismiss}>{changed ? "取消（不连接）" : "取消"}</button>
          {changed ? (
            <button className="btn danger-solid" onClick={confirm}>
              <AlertTriangle size={15} /> 我确认替换指纹并连接
            </button>
          ) : (
            <button className="btn primary" onClick={confirm}>
              <ShieldAlert size={15} /> 信任并连接
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
