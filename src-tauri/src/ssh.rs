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
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use russh::client::{self, Config, Handler, Msg, Session as ClientSession};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::known_hosts::{check_known_hosts, learn_known_hosts};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, load_secret_key};
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

/// SSH 握手（含密钥交换与认证前的协议协商）最长等待时间。
/// 没有这个上限时，对端接受 TCP 却不响应 SSH 协议会让连永远挂着。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

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
    // 会话结束就丢掉它的监控历史，否则每次重连都会留一条永不释放的记录
    crate::monitor::forget(session_id);
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
    /// 校验 known_hosts 需要知道连的是哪台机器
    host: String,
    port: u16,
    /// 主机密钥校验不通过时的具体原因，connect() 失败后取出来给用户看
    reject: Arc<Mutex<Option<String>>>,
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

    /// 主机密钥校验（TOFU：首次连接记录指纹并放行，之后指纹必须完全一致）。
    ///
    /// 之前这里无条件 `Ok(true)`，等于完全不校验 host key，任何中间人都能
    /// 劫持会话、读取密码、篡改下发命令。现在改为：
    /// - 未知主机 → 记入 ~/.ssh/known_hosts（与系统 ssh 共用同一份文件）并提示指纹
    /// - 已知主机且一致 → 放行
    /// - 已知主机但变了 → 拒绝握手，把新旧差异信息交给 connect() 报给用户
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let pk = server_public_key.public_key();
        let fingerprint = pk.fingerprint(HashAlg::Sha256).to_string();
        let target = format!("{}:{}", self.host, self.port);

        match check_known_hosts(&self.host, self.port, &pk) {
            Ok(true) => Ok(true),
            Ok(false) => {
                // 首次连接：记录指纹后放行（TOFU），同时把指纹显示给用户核对
                match learn_known_hosts(&self.host, self.port, &pk) {
                    Ok(()) => self.sink.status(
                        &self.session_id,
                        "connecting",
                        Some(format!("首次连接 {target}，已记录主机指纹 {fingerprint}")),
                    ),
                    Err(err) => self.sink.status(
                        &self.session_id,
                        "connecting",
                        Some(format!(
                            "首次连接 {target}，主机指纹 {fingerprint}（写入 known_hosts 失败: {err}）"
                        )),
                    ),
                }
                Ok(true)
            }
            Err(err) => {
                let message = match &err {
                    russh::keys::Error::KeyChanged { line } => format!(
                        "主机密钥校验失败：{target} 的密钥与 known_hosts 第 {line} 行记录不一致。\n\
                         这可能是中间人攻击，也可能是服务器重装过系统。\n\
                         当前收到的指纹：{fingerprint}\n\
                         确认无误后，删除 ~/.ssh/known_hosts 中对应行再重连。"
                    ),
                    other => format!("主机密钥校验失败：{target} — {other}"),
                };
                if let Ok(mut slot) = self.reject.lock() {
                    *slot = Some(message);
                }
                Ok(false)
            }
        }
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
            // 密码只存在于内存：前端保存连接时把密码交给 secrets 模块加密，
            // 连接前再取回并随 config 传进来，因此这里拿不到就是真的没有。
            // Zeroizing<String> 的 Deref 得到 &String；russh 认证接口要 Into<String>，
            // 这里显式取 &str 交给它（russh 内部副本我们控制不到，但进程内的副本全程 Zeroizing）。
            let password = config.password.clone().unwrap_or_default();
            if password.is_empty() {
                bail!("该连接没有可用密码：请编辑这个连接重新输入密码");
            }
            handle.authenticate_password(&user, password.as_str()).await?
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
pub async fn connect(sink: Sink, mut config: SessionConfig) -> Result<()> {
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
    let reject: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        sink: sink.clone(),
        session_id: session_id.clone(),
        closed: closed.clone(),
        routing: routing.clone(),
        host: config.host.clone(),
        port: config.port,
        reject: reject.clone(),
    };
    let mut client_config = Config::default();
    // 终端是长连接，inactivity_timeout 会让长时间挂机的会话被断开。
    // 但完全没有超时又会让半开连接（NAT 静默丢包、对端宕机）永远挂着：
    // 界面一直显示"已连接"、输入无反应、也没有任何报错。
    // 改用 keepalive：每 30 秒发心跳，连续 3 次无响应判定链路已断。
    client_config.inactivity_timeout = None;
    client_config.keepalive_interval = Some(Duration::from_secs(30));
    client_config.keepalive_max = 3;
    client_config.nodelay = true;

    let result = async {
        // TCP 能连上但 SSH 握手卡死时（对端不响应、防火墙半开）不能无限等待
        let connect_fut = client::connect(
            Arc::new(client_config),
            (config.host.as_str(), config.port),
            handler,
        );
        let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_fut)
            .await
            .map_err(|_| {
                anyhow!(
                    "连接 {}:{} 超时（{} 秒内未完成 SSH 握手）",
                    config.host,
                    config.port,
                    CONNECT_TIMEOUT.as_secs()
                )
            })?
            .with_context(|| format!("无法连接 {}:{}", config.host, config.port))?;

        authenticate(&mut handle, &config).await?;

        // 认证完成后明文密码就不再需要了：置 None 会 drop 掉 Zeroizing，
        // 自动把堆内存里的密码字节清零（不是仅丢弃引用），避免它跟着会话
        // 在整个连接生命周期里一直留在内存中。
        config.password = None;
        config.secret_id = None;

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
                },
            );
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(err) = result {
        // 主机密钥校验失败时，russh 只会给一句笼统的错误，
        // 真正的差异说明放在 reject 里，优先用它
        let message = reject
            .lock()
            .ok()
            .and_then(|m| m.clone())
            .unwrap_or_else(|| format!("{err:#}"));
        sink.status(&session_id, "error", Some(message));
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
