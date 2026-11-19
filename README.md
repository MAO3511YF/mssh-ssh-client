# MSSH

一个基于 **Tauri v2 + React + Rust** 构建的现代化 SSH 客户端。它把多标签分屏终端、SFTP 文件传输和服务器资源监控整合在一个轻量级桌面应用里，前端是 Web 技术，底层 SSH 协议栈由纯 Rust 实现，不依赖系统 OpenSSH。

> 当前版本：`v0.2.0` · 平台：Windows（其他平台需自行构建）

## 功能特性

- **多会话与分屏终端** — 按目录分组管理连接，支持多标签页与面板分屏，基于 xterm.js 的终端体验
- **真实 SSH 连接** — 由 Rust + russh 实现的 SSH 协议栈，支持密码、私钥、SSH agent 等多种认证方式
- **SFTP 文件传输** — 浏览远端与本地目录，支持上传、下载、重命名、删除、新建文件/目录，可直接用内置编辑器打开远端文本
- **服务器资源监控** — 采集并展示 CPU、内存、磁盘、网络、进程与连接数；未连接时明确显示状态，不展示模拟数据
- **命令仓库** — 保存常用命令并分组，一键执行
- **内置代码编辑器** — 查找、跳行、注释、缩进、撤销重做等常用编辑能力
- **主题与外观定制** — 多套主题、侧栏分隔条样式，以及可自定义文字/字体/颜色/字号的品牌标识（内置 6 款开源字体）
- **本地化体验** — 完整的中文界面

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 桌面框架 | Tauri v2 |
| 前端 | React 18 · TypeScript · Vite 6 |
| 状态管理 | zustand |
| 终端 | xterm.js + addon-fit |
| UI | lucide-react · react-resizable-panels |
| 后端 | Rust · russh · russh-sftp · tokio |
| 图标字体 | 站酷快乐体 / 黄油体 / 小薇体 / 马善政楷书 / Quicksand / Fredoka（均遵循 SIL OFL 许可） |

## 快速开始

### 环境要求

- Node.js 18+
- Rust 1.90+（edition 2024）
- Tauri v2 的系统依赖（Windows 需安装 MSVC Build Tools 与 WebView2 Runtime）

### 开发运行

```bash
npm install
npm run tauri dev
```

### 构建

```bash
# 只构建前端
npm run build

# 构建桌面应用（debug，产物在 src-tauri/target/debug/）
npm run tauri build -- --debug --no-bundle

# 正式发布构建
npm run tauri build
```

构建完成后，可执行文件位于 `src-tauri/target/debug/mssh.exe`（debug）或 `src-tauri/target/<target>/release/`（release）。

### 运行测试

```bash
cd src-tauri
cargo test
```

## 项目结构

```
MSSH/
├── src/                    # 前端源码
│   ├── components/         # UI 组件（终端、侧栏、文件传输、监控、设置等）
│   ├── drivers/            # 驱动层（Tauri 原生驱动 / Mock 驱动）
│   ├── App.tsx             # 应用入口与布局
│   ├── store.ts            # zustand 状态与持久化
│   └── styles.css          # 全局样式与主题变量
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── ssh.rs          # SSH 会话与通道管理
│   │   ├── sftp.rs         # SFTP 子系统
│   │   ├── fs_local.rs     # 本地文件系统
│   │   ├── monitor.rs      # 远程资源采集
│   │   └── commands.rs     # Tauri 命令注册
│   └── tests/              # 集成测试
├── public/fonts/           # 内置字体文件
└── assets/                 # 应用图标资源
```

## 架构说明

前端通过 Tauri 的 `invoke` 与事件机制调用后端能力：SSH 连接、数据读写、窗口缩放、SFTP 操作、本地文件读写与监控采集。后端将 SSH 会话集中管理，按通道 ID 路由数据，只把 shell 通道的数据推送给终端，SFTP 操作则按需开启临时子系统通道。监控数据通过远程执行命令采集（如 `/proc`、`df`、`ps`、`ss`）并做两次采样计算速率。

## 许可证

MIT
