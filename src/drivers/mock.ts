import type {
  Driver, FileContent, MonitorSnapshot, RemoteFileEntry, SessionConfig, SshEventHandlers,
} from "../types";

const FILES: Record<string, string[]> = {
  "/home/deploy": ["app/", "logs/", "README.md 1.2K", "docker-compose.yml 890B", "package.json 2.1K", "config.yaml 456B"],
  "/var/log": ["syslog 12M", "nginx/ ", "auth.log 340K", "dmesg 88K"],
};

function mockPrefs(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem("mssh.v2.preferences") ?? "{}"); } catch { return {}; }
}

/** 浏览器本地 Mock 驱动，让前端在没有 Tauri 后端时也能演示。 */
export class MockDriver implements Driver {
  readonly kind = "mock" as const;
  private handlers = new Map<string, SshEventHandlers>();
  private cwd = new Map<string, string>();

  async connect(config: SessionConfig, handlers: SshEventHandlers) {
    this.handlers.set(config.id, handlers);
    this.cwd.set(config.id, "/home/deploy");
    handlers.onStatus(config.id, "connecting");
    await new Promise((r) => setTimeout(r, 420));
    handlers.onStatus(config.id, "connected");
    if (mockPrefs().terminalPrompt !== false) {
      const banner = [
        `\x1b[38;2;79;124;255mSSH\x1b[0m 已连接到 \x1b[1m${config.username}@${config.host}\x1b[0m:${config.port}`,
        `工作区: ${config.directory}`,
        "",
      ].join("\r\n");
      handlers.onData(config.id, banner);
    }
  }

  write(sessionId: string, data: string) {
    const h = this.handlers.get(sessionId);
    if (!h) return;
    // 逐字符回显并检测回车执行
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        h.onData(sessionId, "\r\n");
        continue;
      }
      h.onData(sessionId, ch);
    }
    // 简化：把整段当作一行命令，在末尾回车时执行
    if (data.includes("\r")) {
      const cmd = data.replace(/\r/g, "").trim();
      if (cmd) this.execute(sessionId, cmd);
    }
  }

  private execute(sessionId: string, line: string) {
    const h = this.handlers.get(sessionId);
    if (!h) return;
    const [cmd, ...args] = line.split(/\s+/);
    let out = "";
    switch (cmd.toLowerCase()) {
      case "help":
        out = [
          "可用命令:",
          "  help        显示帮助",
          "  ls [路径]    列出目录",
          "  pwd         显示当前目录",
          "  cd <路径>    切换目录",
          "  echo <文本>  输出文本",
          "  whoami      当前用户",
          "  clear       清屏",
          "  exit        断开连接",
        ].join("\r\n");
        break;
      case "pwd":
        out = this.cwd.get(sessionId) ?? "/";
        break;
      case "ls": {
        const p = args[0] ?? this.cwd.get(sessionId) ?? "/home/deploy";
        out = FILES[p]?.join("\r\n") ?? `ls: 无法访问 '${p}': 无此文件或目录`;
        break;
      }
      case "cd": {
        const p = args[0] ?? "/";
        this.cwd.set(sessionId, p);
        out = "";
        break;
      }
      case "echo":
        out = args.join(" ");
        break;
      case "whoami":
        out = "deploy";
        break;
      case "clear":
        h.onData(sessionId, mockPrefs().terminalKeepOnClear === false ? "\x1b[2J\x1b[H\x1b[3J" : "\x1b[2J\x1b[H");
        out = "";
        break;
      case "exit":
        h.onStatus(sessionId, "closed");
        h.onClosed(sessionId);
        out = "连接已关闭。";
        break;
      default:
        out = `${cmd}: command not found`;
    }
    if (out) h.onData(sessionId, out + "\r\n");
    h.onData(sessionId, "deploy@mssh:~$ ");
  }

  resize() {
    // Mock 无需处理
  }

  async disconnect(sessionId: string) {
    const h = this.handlers.get(sessionId);
    h?.onStatus(sessionId, "closed");
    this.handlers.delete(sessionId);
  }

  // ===== SFTP：浏览器演示用本地假数据 =====
  async sftpList(_sessionId: string, path: string): Promise<RemoteFileEntry[]> {
    const names = FILES[path] ?? FILES["/home/deploy"] ?? [];
    return names.map((raw) => {
      const isDir = raw.endsWith("/");
      const parts = raw.trim().split(/\s+/);
      const name = isDir ? raw.trim().replace(/\/$/, "") : parts[0];
      return {
        name,
        size: isDir || parts.length < 2 ? "—" : parts.slice(1).join(" "),
        modified: new Date().toLocaleString("zh-CN", { hour12: false }),
        type: isDir ? "dir" : "file",
        path: `${path === "/" ? "" : path}/${name}`,
      } as RemoteFileEntry;
    });
  }
  async sftpRead(_sessionId: string, path: string): Promise<FileContent> {
    const content = `# ${path}\n\n浏览器演示模式：这是本地模拟内容。\n安装桌面端后将读取真实远程文件。`;
    return {
      path,
      contentBase64: btoa(unescape(encodeURIComponent(content))),
      isText: true,
      size: content.length,
    };
  }
  async sftpWrite(): Promise<number> {
    return 0;
  }
  async sftpRename(): Promise<void> { /* noop */ }
  async sftpRemove(): Promise<void> { /* noop */ }
  async sftpCreate(): Promise<void> { /* noop */ }

  // ===== 本地文件系统：浏览器演示用假数据 =====
  async fsHome(): Promise<string> { return "~/Downloads"; }
  async fsList(_path: string): Promise<RemoteFileEntry[]> {
    return [
      { name: "Documents", size: "—", modified: "—", type: "dir", path: "~/Downloads/Documents" },
      { name: "deploy.sh", size: "1.2K", modified: "—", type: "file", path: "~/Downloads/deploy.sh" },
      { name: "config.local.yaml", size: "456B", modified: "—", type: "file", path: "~/Downloads/config.local.yaml" },
    ] as RemoteFileEntry[];
  }
  async fsRead(p: string): Promise<FileContent> {
    return { path: p, contentBase64: "", isText: true, size: 0 };
  }
  async fsWrite(): Promise<number> { return 0; }
  async fsRename(): Promise<void> { /* noop */ }
  async fsRemove(): Promise<void> { /* noop */ }
  async fsCreate(): Promise<void> { /* noop */ }

  // ===== 监控：复用本地随机生成器，保持浏览器演示 =====
  async collectMonitor(sessionId: string): Promise<MonitorSnapshot> {
    const { mockSnapshot } = await import("../monitor");
    return mockSnapshot(sessionId);
  }

  // ===== 凭据：浏览器演示环境只放内存，不落盘 =====
  private mockSecrets = new Map<string, string>();
  async secretSet(id: string, password: string): Promise<void> {
    this.mockSecrets.set(id, password);
  }
  async secretGet(id: string): Promise<string | null> {
    return this.mockSecrets.get(id) ?? null;
  }
  async secretRemove(id: string): Promise<void> {
    this.mockSecrets.delete(id);
  }
}
