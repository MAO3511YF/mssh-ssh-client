//! SSH 会话层：真实 russh 连接 + 事件桥接。
//!
//! 前端只认三个事件（drivers/tauri.ts）：
//!   ssh://data   { sessionId, data }
//!   ssh://status { sessionId, status, message? }
//!   ssh://closed { sessionId }
//! sessionId 是前端的 runtimeId（store.ts 里 `${config.id}-${Date.now()}`），
//! 后端原样用 config.id，不另造标识。
//!
//! 事件通过 EventSink trait 抽象，Tauri 实现负责 emit，集成测试可以换成记录器。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use russh::client::{self, Config, Handler, Msg, Session as ClientSession};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};
use russh::{Channel, ChannelId, Disconnect};
use tokio::sync::Mutex as AsyncMutex;

use crate::model::SessionConfig;

/// 前端三个事件的发送口。Tauri 侧由 commands.rs 的 TauriSink 实现。
pub trait EventSink: Send + Sync {
    fn status(&self, session_id: &str, status: &str, message: Option<String>);
    fn data(&self, session_id: &str, data: &str);
    fn closed(&self, session_id: &str);
}

type Sink = Arc<dyn EventSink>;
pub type SessionHandle = client::Handle<ClientHandler>;

/// 通道路由：只有一个 shell 通道的数据该推给终端；SFTP/exec 子通道的数据
/// 由各自的读取方消费。russh 会把数据同时投递到通道内部 receiver 和 Handler
/// 回调，因此必须在回调里按通道过滤，否则二进制流会污染 xterm。
#[derive(Default)]
struct Routing {
    terminal: Option<ChannelId>,
    /// 已经交给 SFTP/exec 的通道，明确排除（双保险）
    subchannels: std::collections::HashSet<ChannelId>,
}

#[derive(Clone, Default)]
pub struct RoutingState(Arc<Mutex<Routing>>);

impl RoutingState {
    fn is_terminal(&self, id: ChannelId) -> bool {
        self.0
            .lock()
            .map(|r| r.terminal == Some(id) && !r.subchannels.contains(&id))
            .unwrap_or(false)
    }
    fn set_terminal(&self, id: ChannelId) {
        if let Ok(mut r) = self.0.lock() {
            r.terminal = Some(id);
            r.subchannels.remove(&id);
        }
    }
    fn reserve(&self, id: ChannelId) {
        if let Ok(mut r) = self.0.lock() {
            r.subchannels.insert(id);
        }
    }
    fn release(&self, id: ChannelId) {
        if let Ok(mut r) = self.0.lock() {
            r.subchannels.remove(&id);
        }
    }
    fn is_terminal_only_channel(&self, id: ChannelId) -> bool {
        self.0.lock().map(|r| r.terminal == Some(id)).unwrap_or(false)
    }
}

struct SshSession {
    handle: Arc<SessionHandle>,
    channel: Arc<AsyncMutex<Channel<Msg>>>,
    /// 与 Handler 共享，主动断开时先置位，避免回调里重复发 closed
    closed: Arc<AtomicBool>,
    routing: RoutingState,
    /// 建连配置快照，供 SFTP/监控在需要时重开连接使用
    config: SessionConfig,
}

/// sessionId -> 活动会话。std Mutex 只做极短的插入/取出，绝不跨 await 持有。
static SESSIONS: LazyLock<Mutex<HashMap<String, SshSession>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 把 "~/.ssh/id_ed25519" 展开成本机用户目录（前端不会展开 ~）
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// 远端断开 / 主动关闭都走这里，AtomicBool 保证只发一次 closed
fn mark_closed(sink: &Sink, session_id: &str, closed: &AtomicBool) {
    if closed.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut sessions) = SESSIONS.lock() {
        sessions.remove(session_id);
    }
    sink.closed(session_id);
    sink.status(session_id, "closed", None);
}

/// russh 客户端事件处理器。connect() 内部 spawn 了事件循环，
/// 这里把服务器推过来的数据直接转成前端事件，不再另开读取任务。
pub struct ClientHandler {
    sink: Sink,
    session_id: String,
    closed: Arc<AtomicBool>,
    routing: RoutingState,
}

impl ClientHandler {
    fn push(&self, data: &[u8]) {
        // SSH 数据流是 UTF-8/ANSI 控制序列，lossy 转换不会丢失可打印内容
        let text = String::from_utf8_lossy(data).into_owned();
        self.sink.data(&self.session_id, &text);
    }
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    /// 前端没有主机密钥确认 UI，这里接受服务端密钥（与浏览器 mock 行为一致）。
    /// 若后续要接 known_hosts，可在这里校验并返回 false。
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut ClientSession,
    ) -> std::result::Result<(), Self::Error> {
        // 只把 shell 通道的输出推给 xterm；SFTP/exec 子通道由各自读取方消费
        if self.routing.is_terminal(channel) {
            self.push(data);
        }
        Ok(())
    }

    /// stderr 也并到终端输出（如 sshd 的提示信息），同样只限 shell 通道
    async fn extended_data(
        &mut self,
        channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut ClientSession,
    ) -> std::result::Result<(), Self::Error> {
        if self.routing.is_terminal(channel) {
            self.push(data);
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut ClientSession,
    ) -> std::result::Result<(), Self::Error> {
        // SFTP/exec 子通道关闭是正常现象，不能当成整个 SSH 会话断开
        if self.routing.is_terminal_only_channel(channel) {
            mark_closed(&self.sink, &self.session_id, &self.closed);
        }
        Ok(())
    }

    async fn disconnected(
        &mut self,
        _reason: russh::client::DisconnectReason<Self::Error>,
    ) -> std::result::Result<(), Self::Error> {
        mark_closed(&self.sink, &self.session_id, &self.closed);
        Ok(())
    }
}

/// 逐个尝试 agent 里的公钥。AgentClient 实现了 russh::Signer，
/// 签名请求会转给 agent，私钥永远不会进入本进程。
async fn try_agent<S>(handle: &mut SessionHandle, user: &str, agent: &mut AgentClient<S>) -> Result<bool>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
    AgentClient<S>: russh::Signer,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow!("读取 agent 密钥失败: {}", e))?;
    for identity in identities {
        let key = match identity {
            AgentIdentity::PublicKey { key, .. } => key,
            AgentIdentity::Certificate { .. } => continue,
        };
        if let Ok(result) = handle.authenticate_publickey_with(user, key, None, agent).await {
            if result.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 按前端 authMethod 做认证。前端 demo 覆盖了四种方式。
async fn authenticate(handle: &mut SessionHandle, config: &SessionConfig) -> Result<()> {
    let user = config.username.clone();
    let success = match config.auth_method.as_str() {
        "password" => {
            let password = config.password.clone().unwrap_or_default();
            handle.authenticate_password(&user, password).await?
        }
        "privateKey" => {
            let raw = config.private_key_path.as_deref().unwrap_or("");
            if raw.trim().is_empty() {
                bail!("未配置私钥路径");
            }
            let path = expand_tilde(raw);
            let key = load_secret_key(&path, None)
                .with_context(|| format!("读取私钥失败: {}", path.display()))?;
            // RSA key 需要告诉服务端支持哪种签名 hash
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(&user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
        "agent" => {
            #[cfg(unix)]
            {
                if let Ok(mut agent) = AgentClient::connect_env().await {
                    if try_agent(handle, &user, &mut agent).await? {
                        return Ok(());
                    }
                }
            }
            #[cfg(windows)]
            {
                // Windows OpenSSH Agent 的命名管道
                if let Ok(mut agent) =
                    AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
                {
                    if try_agent(handle, &user, &mut agent).await? {
                        return Ok(());
                    }
                }
                // PuTTY Pageant 兜底
                if let Ok(mut agent) = AgentClient::connect_pageant().await {
                    if try_agent(handle, &user, &mut agent).await? {
                        return Ok(());
                    }
                }
            }
            bail!("未找到可用的 SSH agent，或 agent 中没有匹配的密钥");
        }
        "none" | _ => handle.authenticate_none(&user).await?,
    };
    if !success.success() {
        bail!("认证失败（用户 {}），请检查密码或密钥", user);
    }
    Ok(())
}

/// `ssh_connect`：始终返回 Ok，失败通过 status(error) 告诉前端，
/// 避免前端 `void driver.connect()` 产生未处理的 Promise rejection。
pub async fn connect(sink: Sink, config: SessionConfig) -> Result<()> {
    let session_id = config.id.clone();
    sink.status(&session_id, "connecting", None);

    // 同 id 重连（自动重连场景）时先清掉旧会话
    if let Ok(mut sessions) = SESSIONS.lock() {
        if let Some(old) = sessions.remove(&session_id) {
            old.closed.store(true, Ordering::SeqCst);
        }
    }

    let closed = Arc::new(AtomicBool::new(false));
    let routing = RoutingState::default();
    let handler = ClientHandler {
        sink: sink.clone(),
        session_id: session_id.clone(),
        closed: closed.clone(),
        routing: routing.clone(),
    };
    let mut client_config = Config::default();
    // 终端是长连接， inactivity_timeout 会让长时间挂机的会话被断开
    client_config.inactivity_timeout = None;
    client_config.nodelay = true;

    let result = async {
        let mut handle = client::connect(
            Arc::new(client_config),
            (config.host.as_str(), config.port),
            handler,
        )
        .await
        .with_context(|| format!("无法连接 {}:{}", config.host, config.port))?;

        authenticate(&mut handle, &config).await?;

        let channel = handle.channel_open_session().await?;
        // 标记这是终端通道，只有它的数据推给 xterm
        routing.set_terminal(channel.id());
        // 前端 xterm 默认 80x24；实际尺寸随后由 ssh_resize 同步
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await?;
        if let Some(env) = &config.env {
            for (key, value) in env {
                let _ = channel.set_env(false, key, value).await;
            }
        }
        channel.request_shell(true).await?;

        if let Ok(mut sessions) = SESSIONS.lock() {
            sessions.insert(
                config.id.clone(),
                SshSession {
                    handle: Arc::new(handle),
                    channel: Arc::new(AsyncMutex::new(channel)),
                    closed: closed.clone(),
                    routing: routing.clone(),
                    config: config.clone(),
                },
            );
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(err) = result {
        sink.status(&session_id, "error", Some(format!("{err:#}")));
        closed.store(true, Ordering::SeqCst);
    } else {
        sink.status(&session_id, "connected", None);
    }
    Ok(())
}

pub async fn write(session_id: &str, data: String) -> Result<()> {
    let channel = {
        let sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
        sessions.get(session_id).map(|s| s.channel.clone())
    };
    if let Some(channel) = channel {
        let channel = channel.lock().await;
        channel.data_bytes(Bytes::from(data)).await?;
    }
    Ok(())
}

pub async fn resize(session_id: &str, cols: u32, rows: u32) -> Result<()> {
    let channel = {
        let sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
        sessions.get(session_id).map(|s| s.channel.clone())
    };
    if let Some(channel) = channel {
        let channel = channel.lock().await;
        channel.window_change(cols, rows, 0, 0).await?;
    }
    Ok(())
}

pub async fn disconnect(sink: &Sink, session_id: &str) -> Result<()> {
    let session = {
        let mut sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
        sessions.remove(session_id)
    };
    if let Some(session) = session {
        // 先置位再关通道：channel_close / disconnected 回调就不会再发一次 closed
        session.closed.store(true, Ordering::SeqCst);
        {
            let channel = session.channel.lock().await;
            let _ = channel.close().await;
        }
        let _ = session
            .handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
    }
    // 前端需要在主动断开时也收到 closed（mock 驱动同样发这个事件）
    sink.closed(session_id);
    sink.status(session_id, "closed", None);
    Ok(())
}

/// 供 SFTP/监控模块使用：取出会话 handle 与路由状态。
/// handle 用 Arc 共享，channel_open_session 只需 &self，可安全跨 await。
pub fn session_handle(session_id: &str) -> Result<(Arc<SessionHandle>, RoutingState)> {
    let sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
    let s = sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("会话不存在或已断开: {}", session_id))?;
    if s.closed.load(Ordering::SeqCst) {
        bail!("会话已断开: {}", session_id);
    }
    Ok((s.handle.clone(), s.routing.clone()))
}

/// 供 SFTP/监控模块使用：取会话配置快照（重连场景）。
pub fn session_config(session_id: &str) -> Result<SessionConfig> {
    let sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
    let s = sessions
        .get(session_id)
        .ok_or_else(|| anyhow!("会话不存在或已断开: {}", session_id))?;
    Ok(s.config.clone())
}

/// 开一个子通道并登记到路由（数据不会污染终端）。
/// 调用方负责用完后 release_subchannel。
pub async fn open_subchannel(
    handle: &SessionHandle,
    routing: &RoutingState,
) -> Result<Channel<Msg>> {
    let channel = handle.channel_open_session().await?;
    routing.reserve(channel.id());
    Ok(channel)
}

pub fn release_subchannel(routing: &RoutingState, id: ChannelId) {
    routing.release(id);
}

/// 重新导出路由状态别名，供其他模块引用
pub use RoutingState as ChannelRouting;

/// 在子通道上执行一条远程命令并收集完整输出（stdout+stderr），带超时。
/// 供资源采集使用；子通道数据不会进入终端。
pub async fn exec_capture(session_id: &str, command: &str) -> Result<String> {
    use tokio::io::AsyncReadExt;
    use tokio::time::{Duration, timeout};

    let (handle, routing) = session_handle(session_id)?;
    let channel = open_subchannel(&handle, &routing).await?;
    let id = channel.id();
    channel.exec(true, command).await?;

    let mut stream = channel.into_stream();
    let mut buf = Vec::new();
    let read = timeout(Duration::from_secs(12), stream.read_to_end(&mut buf)).await;
    routing.release(id);
    read.map_err(|_| anyhow!("远程命令超时: {}", command))??;

    Ok(String::from_utf8_lossy(&buf).into_owned())
}
