import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnectionStatus, Driver, FileContent, MonitorSnapshot, RemoteFileEntry,
  SessionConfig, SshEventHandlers,
} from "../types";

/** Tauri 原生驱动，与后端 russh 通过 invoke/event 通信。 */
export class TauriDriver implements Driver {
  readonly kind = "tauri" as const;
  private handlers = new Map<string, SshEventHandlers>();
  private unlisteners: (() => void)[] = [];
  private started = false;

  private async ensureListeners() {
    if (this.started) return;
    this.started = true;
    this.unlisteners.push(
      await listen<{ sessionId: string; data: string }>("ssh://data", (e) => {
        this.handlers.get(e.payload.sessionId)?.onData(e.payload.sessionId, e.payload.data);
      }),
      await listen<{ sessionId: string; status: ConnectionStatus; message?: string }>("ssh://status", (e) => {
        this.handlers.get(e.payload.sessionId)?.onStatus(e.payload.sessionId, e.payload.status, e.payload.message);
      }),
      await listen<{ sessionId: string }>("ssh://closed", (e) => {
        this.handlers.get(e.payload.sessionId)?.onClosed(e.payload.sessionId);
      }),
    );
  }

  async connect(config: SessionConfig, handlers: SshEventHandlers) {
    await this.ensureListeners();
    this.handlers.set(config.id, handlers);
    await invoke("ssh_connect", { config });
  }

  write(sessionId: string, data: string) {
    void invoke("ssh_write", { sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number) {
    void invoke("ssh_resize", { sessionId, cols, rows });
  }

  async disconnect(sessionId: string) {
    await invoke("ssh_disconnect", { sessionId });
    this.handlers.delete(sessionId);
  }

  // ===== SFTP 文件传输 =====
  sftpList(sessionId: string, path: string) {
    return invoke<RemoteFileEntry[]>("sftp_list", { sessionId, path });
  }
  sftpRead(sessionId: string, path: string) {
    return invoke<FileContent>("sftp_read", { sessionId, path });
  }
  sftpWrite(sessionId: string, path: string, data: string) {
    return invoke<number>("sftp_write", { sessionId, path, data });
  }
  sftpRename(sessionId: string, from: string, to: string) {
    return invoke<void>("sftp_rename", { sessionId, from, to });
  }
  sftpRemove(sessionId: string, path: string, isDir: boolean) {
    return invoke<void>("sftp_remove", { sessionId, path, isDir });
  }
  sftpCreate(sessionId: string, path: string, isDir: boolean) {
    return invoke<void>("sftp_create", { sessionId, path, isDir });
  }

  // ===== 本地文件系统 =====
  fsHome() {
    return invoke<string>("fs_home");
  }
  fsList(path: string) {
    return invoke<RemoteFileEntry[]>("fs_list", { path });
  }
  fsRead(path: string) {
    return invoke<FileContent>("fs_read", { path });
  }
  fsWrite(path: string, data: string) {
    return invoke<number>("fs_write", { path, data });
  }
  fsRename(from: string, to: string) {
    return invoke<void>("fs_rename", { from, to });
  }
  fsRemove(path: string, isDir: boolean) {
    return invoke<void>("fs_remove", { path, isDir });
  }
  fsCreate(path: string, isDir: boolean) {
    return invoke<void>("fs_create", { path, isDir });
  }

  // ===== 资源监控 =====
  collectMonitor(sessionId: string) {
    return invoke<MonitorSnapshot>("monitor_collect", { sessionId });
  }

  // ===== 凭据：密码交给后端 DPAPI 加密，明文不回传前端 =====
  secretSet(id: string, password: string, host: string, port: number, username: string) {
    return invoke<void>("secret_set", { id, password, host, port, username });
  }
  secretHas(id: string) {
    return invoke<boolean>("secret_has", { id });
  }
  secretRemove(id: string) {
    return invoke<void>("secret_remove", { id });
  }
}
