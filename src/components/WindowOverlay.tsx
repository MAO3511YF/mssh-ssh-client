import { Minus, Plane, Power } from "lucide-react";
import type { WindowState } from "../windowControl";

interface Props {
  state: Exclude<WindowState, "normal">;
  onRestore: () => void;
}

/** 浏览器预览下对最小化 / 隐藏后台 / 退出的可见模拟（Tauri 原生由系统窗口接管）。 */
export function WindowOverlay({ state, onRestore }: Props) {
  const cfg = {
    minimized: { icon: <Minus size={26} />, title: "窗口已最小化", desc: "MSSH 仍在运行，可随时恢复", btn: "恢复窗口" },
    hidden: { icon: <Plane size={26} />, title: "已隐藏到后台", desc: "所有 SSH 连接保持中，点击恢复", btn: "返回 MSSH" },
    quit: { icon: <Power size={26} />, title: "MSSH 已退出", desc: "所有连接已断开", btn: "重新启动" },
  }[state];

  return (
    <div className="window-overlay">
      <div className="window-overlay-card">
        <div className={`wo-ico ${state}`}>{cfg.icon}</div>
        <h1>{cfg.title}</h1>
        <p>{cfg.desc}</p>
        <button className="btn primary" onClick={onRestore}>{cfg.btn}</button>
        <span className="wo-note">预览模式模拟 · 打包后由系统窗口接管</span>
      </div>
    </div>
  );
}
