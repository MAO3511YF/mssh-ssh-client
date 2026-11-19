import { useEffect } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";
import { useAppStore } from "../store";

export function Toast() {
  const toast = useAppStore((s) => s.toast);
  const clear = useAppStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(clear, 2600);
    return () => window.clearTimeout(timer);
  }, [toast, clear]);

  if (!toast) return null;
  const Icon = toast.kind === "success" ? CheckCircle2 : toast.kind === "error" ? XCircle : Info;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      <Icon size={16} />
      <span>{toast.message}</span>
    </div>
  );
}
