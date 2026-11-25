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
use russh::keys::known_hosts::{check_known_hosts, known_host_keys_path, learn_known_hosts};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, load_secret_key};
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
    /// 用户是否已确认信任这台新主机（首次连接才需要）
    trust_new_host: bool,
    /// 用户是否已确认「主机指纹变了但我认这个新指纹」（服务器重装系统等场景）
    trust_changed_host: bool,
}

/// 未知主机密钥时回传给前端的标记：前端据此弹「确认指纹」对话框。
/// 格式固定为 `HOSTKEY_UNKNOWN|<sha256 指纹>`，主机与端口前端本来就知道。
pub const HOSTKEY_UNKNOWN_PREFIX: &str = "HOSTKEY_UNKNOWN|";
/// 主机指纹变化时的标记：前端据此弹「指纹已变化」高危确认框。
/// 与未知主机分开，是因为这一种更可能是中间人攻击，必须用不同的文案警示。
pub const HOSTKEY_CHANGED_PREFIX: &str = "HOSTKEY_CHANGED|";

/// 定位用户自己的 known_hosts（与系统 OpenSSH 共用同一份文件）
fn known_hosts_file() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("找不到用户目录，无法定位 ~/.ssh/known_hosts"))?;
    Ok(home.join(".ssh").join("known_hosts"))
}

/// 从 known_hosts 删除某台主机**同算法**的旧记录，供"用户确认指纹已变化、替换旧记录"时使用。
///
/// russh 只提供 check / learn，没有删除接口，所以这里自己做：先用
/// `known_host_keys_path` 取到命中的行号（它同时支持明文 host 与 `|1|...` hash 条目），
/// 再按同样的计数规则（注释行不计入行号）把这些行剔除。
///
/// 只删与本次收到的新密钥同算法的行：同一台服务器在 known_hosts 里可能还存着
/// ecdsa / rsa / ed25519 好几条记录，把别的算法一起删掉的话，下次协商落到那个算法
/// 就会被当成"首次连接"，用户又得核对一遍。返回删除的行数。
fn forget_known_hosts(host: &str, port: u16, pk: &PublicKey) -> Result<usize> {
    forget_known_hosts_path(host, port, pk, &known_hosts_file()?)
}

fn forget_known_hosts_path(
    host: &str,
    port: u16,
    pk: &PublicKey,
    path: &std::path::Path,
) -> Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let recorded = known_host_keys_path(host, port, path)?;
    let mut targets: std::collections::HashSet<usize> = recorded
        .iter()
        .filter(|(_, old)| old.algorithm() == pk.algorithm())
        .map(|(line, _)| *line)
        .collect();
    if targets.is_empty() && !recorded.is_empty() {
        // KeyChanged 只会在"同算法、不同公钥"时出现，走到这里说明算法名对不上
        // （例如新旧 rust 的算法字符串不同）。兜底全删，保证"先删后写"不留旧行。
        targets = recorded.iter().map(|(line, _)| *line).collect();
    }
    if targets.is_empty() {
        return Ok(0);
    }

    let content = std::fs::read_to_string(path)
        .with_context(|| format!("读取 {} 失败", path.display()))?;
    let mut kept = String::with_capacity(content.len());
    let mut no = 0usize;
    // 按原始行尾切分（保留 \n / \r\n），未删除的行逐字节写回：
    // known_hosts 是系统 ssh 也在用的文件，不该因为一次信任就把 CRLF 悄悄改成 LF
    for line in content.split_inclusive('\n') {
        // 与 russh 的行号语义保持一致：注释行不参与计数
        if !line.starts_with('#') {
            no += 1;
            if targets.contains(&no) {
                continue;
            }
        }
        kept.push_str(line);
    }

    // 先写临时文件再 rename：中途失败也不会把 known_hosts 写坏——系统 ssh 也在用它
    let tmp = path.with_extension("mssh-tmp");
    std::fs::write(&tmp, kept).with_context(|| format!("写入 {} 失败", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("替换 {} 失败", path.display()))?;
    Ok(targets.len())
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

    /// 主机密钥校验（首次连接必须由用户确认指纹）。
    ///
    /// 之前这里无条件 `Ok(true)`，等于完全不校验 host key，任何中间人都能
    /// 劫持会话、读取密码、篡改下发命令。现在改为：
    /// - 未知主机 + 用户未确认 → 中止握手，把指纹回传前端弹确认框（不再静默信任）
    /// - 未知主机 + 用户已确认 → 记入 ~/.ssh/known_hosts（与系统 ssh 共用）并放行
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
                if !self.trust_new_host {
                    // 静默信任等于把首连交给中间人：中止握手，等用户核对指纹后再连
                    if let Ok(mut slot) = self.reject.lock() {
                        *slot = Some(format!("{HOSTKEY_UNKNOWN_PREFIX}{fingerprint}"));
                    }
                    // 先置位再返回 false：russh 随后触发的 disconnected 回调就不会再发
                    // 一次 closed，避免前端把它当成掉线并自动重连进死循环
                    self.closed.store(true, Ordering::SeqCst);
                    return Ok(false);
                }
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
                // 只有 KeyChanged（同算法、不同公钥）才可能被用户"确认替换"；
                // 其它解析错误说明 known_hosts 本身有问题，不该让用户点一下就绕过。
                if !matches!(&err, russh::keys::Error::KeyChanged { .. }) {
                    let message = format!("主机密钥校验失败：{target} — {err}");
                    if let Ok(mut slot) = self.reject.lock() {
                        *slot = Some(message);
                    }
                    return Ok(false);
                }

                if self.trust_changed_host {
                    // 用户在看到新旧指纹、读完警告后明确确认过：替换旧记录再放行。
                    // 注意顺序是先删后写，否则 learn 会把新指纹追加成第二行，
                    // 下次连接时旧行仍会命中并再次报 KeyChanged。
                    match forget_known_hosts(&self.host, self.port, &pk)
                        .and_then(|_| learn_known_hosts(&self.host, self.port, &pk).map_err(Into::into))
                    {
                        Ok(()) => {
                            self.sink.status(
                                &self.session_id,
                                "connecting",
                                Some(format!("已按用户确认替换 {target} 的主机指纹为 {fingerprint}")),
                            );
                            return Ok(true);
                        }
                        Err(e) => {
                            let message = format!(
                                "主机密钥校验失败：{target} 的密钥已变化，且更新 ~/.ssh/known_hosts 失败：{e}\n\
                                 旧记录可能已删除。请把下面这枚新指纹手动写入 ~/.ssh/known_hosts 后重连：{fingerprint}"
                            );
                            if let Ok(mut slot) = self.reject.lock() {
                                *slot = Some(message);
                            }
                            return Ok(false);
                        }
                    }
                }

                // 未确认：中止握手，把新指纹交给前端弹高危确认框。
                // 这里不放行也不自动改写 known_hosts——那正是中间人最想要的结果。
                if let Ok(mut slot) = self.reject.lock() {
                    *slot = Some(format!("{HOSTKEY_CHANGED_PREFIX}{fingerprint}"));
                }
                self.closed.store(true, Ordering::SeqCst);
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
        trust_new_host: config.trust_new_host_key,
        trust_changed_host: config.trust_changed_host_key,
    };
    let mut client_config = Config::default();
    // 终端是长连接，inactivity_timeout 会让长时间挂机的会话被断开。
    // 但完全没有超时又会让半开连接（NAT 静默丢包、对端宕机）永远挂着：
    // 界面一直显示"已连接"、输入无反应、也没有任何报错。
    // 改用 keepalive：心跳要确保"服务器收到"，才能既防 NAT 静默丢包又不误杀活跃会话。
    // russh 会在收到服务器任意回包（含对心跳的 REQUEST_FAILURE 应答）时清零超时计数，
    // 所以这里缩短间隔以穿透 NAT 空闲超时，同时放宽容忍次数，避免服务器短暂高负载时
    // 连续几次没回包就把仍可用的会话判死——那会让用户正打字的会话突然无法输入。
    client_config.inactivity_timeout = None;
    client_config.keepalive_interval = Some(Duration::from_secs(20));
    client_config.keepalive_max = 5;
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

/// 退出程序 / 关窗时主动断开所有会话。
///
/// 进程直接退出会把 TCP 连接硬生生掐断，服务器侧要等超时才能回收；
/// 这里对每条会话发标准的 SSH disconnect，让远端立刻释放。
/// 事件走 QuietSink——窗口都要关了，没必要再往前端推状态。
pub async fn disconnect_all() {
    let ids: Vec<String> = match SESSIONS.lock() {
        Ok(sessions) => sessions.keys().cloned().collect(),
        Err(_) => return,
    };
    if ids.is_empty() {
        return;
    }
    let sink: Sink = Arc::new(QuietSink);
    for id in ids {
        let _ = disconnect(&sink, &id).await;
    }
}

/// 测试连接专用的静默事件口：不往前端发任何事件
struct QuietSink;
impl EventSink for QuietSink {
    fn status(&self, _session_id: &str, _status: &str, _message: Option<String>) {}
    fn data(&self, _session_id: &str, _data: &str) {}
    fn closed(&self, _session_id: &str) {}
}

/// 真实测试连接：完成 TCP + SSH 握手 + 主机密钥校验 + 认证后立即断开。
/// 不写入会话表、不占用终端通道，因此不会影响正常连接。
/// 成功返回可读提示（含端口/认证方式），失败返回具体原因。
pub async fn test_connection(config: &SessionConfig) -> Result<String> {
    let sink: Sink = Arc::new(QuietSink);
    let closed = Arc::new(AtomicBool::new(false));
    let routing = RoutingState::default();
    let reject: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        sink: sink.clone(),
        session_id: config.id.clone(),
        closed: closed.clone(),
        routing: routing.clone(),
        host: config.host.clone(),
        port: config.port,
        reject: reject.clone(),
        trust_new_host: false,
        trust_changed_host: false,
    };
    let mut client_config = Config::default();
    client_config.inactivity_timeout = None;
    client_config.nodelay = true;

    let result = async {
        let connect_fut = client::connect(
            Arc::new(client_config),
            (config.host.as_str(), config.port),
            handler,
        );
        let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_fut)
            .await
            .map_err(|_| anyhow!("连接超时（{} 秒内未完成 SSH 握手）", CONNECT_TIMEOUT.as_secs()))?
            .with_context(|| format!("无法连接 {}:{}", config.host, config.port))?;
        authenticate(&mut handle, config).await?;
        // 认证成功即断开（disconnect 失败无所谓，句柄 drop 会关闭底层连接）
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "test ok", "en").await;
        Ok::<(), anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => Ok(format!(
            "连接成功：{}:{}（{} 认证通过）",
            config.host, config.port, config.auth_method
        )),
        Err(err) => {
            let message = reject
                .lock()
                .ok()
                .and_then(|m| m.clone())
                .unwrap_or_else(|| format!("{err:#}"));
            // 未知主机：测试连接不替用户做信任决定，转成人话让他去工作区正式连接时确认
            if let Some(fp) = message.strip_prefix(HOSTKEY_UNKNOWN_PREFIX) {
                bail!(
                    "首次连接该主机，主机指纹 {fp}。请在工作区里连接一次并在弹窗中核对确认。"
                );
            }
            // 指纹变化属于高危事件，测试连接更不该静默替用户决定
            if let Some(fp) = message.strip_prefix(HOSTKEY_CHANGED_PREFIX) {
                bail!(
                    "主机指纹与 known_hosts 记录不一致（当前指纹 {fp}）。\
                     若确认是服务器重装系统，请在工作区里连接并按提示确认替换。"
                );
            }
            bail!(message)
        }
    }
}

pub async fn write(session_id: &str, data: String) -> Result<()> {
    // 之前会话不存在时静默返回 Ok，导致服务器重启/链路被判定断开后，
    // 前端界面看着还"连着"，打字全部石沉大海、没有提示也不会重连。
    // 现在明确报错，让前端能感知写入失败并触发自动重连。
    let (channel, closed) = {
        let sessions = SESSIONS.lock().map_err(|_| anyhow!("会话表已损坏"))?;
        sessions
            .get(session_id)
            .map(|s| (s.channel.clone(), s.closed.clone()))
            .ok_or_else(|| anyhow!("会话不存在或已断开"))?
    };
    if closed.load(Ordering::SeqCst) {
        bail!("会话已断开");
    }
    let channel = channel.lock().await;
    channel.data_bytes(Bytes::from(data)).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 固定公钥，用来拼 known_hosts 记录
    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";

    /// 与 KEY 同一枚公钥（算法相同、公钥相同），用来验证按算法过滤的分支
    fn key() -> PublicKey {
        russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .expect("测试公钥应能解析")
    }

    fn temp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut p = std::env::temp_dir();
        p.push(format!("mssh-kh-{}-{nanos}-{tag}", std::process::id()));
        p
    }

    /// 只删命中主机的那几行：注释行与其它主机必须原样保留，
    /// 否则用户点一次"信任新指纹"就会把系统 known_hosts 里别的机器一起清掉。
    #[test]
    fn forget_known_hosts_removes_only_target_lines() {
        let path = temp_path("plain");
        let content = format!(
            "# 注释行不该被动\n\
             example.com {KEY}\n\
             192.168.1.9 {KEY}\n\
             localhost {KEY}\n"
        );
        std::fs::write(&path, &content).unwrap();

        assert_eq!(forget_known_hosts_path("localhost", 22, &key(), &path).unwrap(), 1);
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("# 注释行不该被动"), "注释行被误删: {after}");
        assert!(after.contains("example.com"), "其它主机的记录被误删: {after}");
        assert!(!after.contains("localhost"), "目标行没被删掉: {after}");

        // 没有记录时不应改动文件
        assert_eq!(forget_known_hosts_path("nope.example", 22, &key(), &path).unwrap(), 0);

        // 非 22 端口用 [host]:port 形式匹配
        let p2 = temp_path("port");
        std::fs::write(&p2, format!("[myhost]:2222 {KEY}\nother.example {KEY}\n")).unwrap();
        assert_eq!(forget_known_hosts_path("myhost", 2222, &key(), &p2).unwrap(), 1);
        let after2 = std::fs::read_to_string(&p2).unwrap();
        assert!(after2.contains("other.example"), "其它主机被误删: {after2}");
        assert!(!after2.contains("myhost"), "目标行没被删掉: {after2}");

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&p2);
    }
}
