//! 端到端验证：本地起一个 russh SSH 服务端，走真实的 connect/write/resize/disconnect，
//! 检查前端三个事件是否按约定发出。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use mssh_lib::model::SessionConfig;
use mssh_lib::ssh::{self, EventSink};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, ChannelOpenHandle, Msg as ServerMsg, Server as _, Session as ServerSession};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

#[derive(Clone, Default)]
struct Recorder {
    events: Arc<Mutex<Vec<(String, String)>>>,
}

impl Recorder {
    fn push(&self, kind: &str, value: String) {
        self.events.lock().unwrap().push((kind.to_string(), value));
    }

    fn has(&self, kind: &str, needle: &str) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|(k, v)| k == kind && v.contains(needle))
    }

    fn count(&self, kind: &str, needle: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, v)| k == kind && v.contains(needle))
            .count()
    }

    fn dump(&self) -> String {
        format!("{:?}", self.events.lock().unwrap())
    }
}

impl EventSink for Recorder {
    fn status(&self, session_id: &str, status: &str, message: Option<String>) {
        self.push("status", format!("{session_id}:{status}:{}", message.unwrap_or_default()));
    }

    fn data(&self, _session_id: &str, data: &str) {
        self.push("data", data.to_string());
    }

    fn closed(&self, session_id: &str) {
        self.push("closed", session_id.to_string());
    }
}

async fn wait_until(rec: &Recorder, kind: &str, needle: &str) {
    for _ in 0..120 {
        if rec.has(kind, needle) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("等待 {kind}={needle} 超时，实际事件：{}", rec.dump());
}

/// 测试用 SSH 服务端：接受任意密码，开 shell 后把收到的数据原样回显。
#[derive(Clone)]
struct EchoServer;

impl server::Server for EchoServer {
    type Handler = Self;

    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for EchoServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<ServerMsg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _px: u32,
        _py: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        let mut out = b"ECHO:".to_vec();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
        session.data(channel, out)?;
        Ok(())
    }
}

fn config(id: &str, host: &str, port: u16) -> SessionConfig {
    SessionConfig {
        id: id.into(),
        kind: "ssh".into(),
        name: "e2e".into(),
        host: host.into(),
        port,
        username: "tester".into(),
        directory: "测试".into(),
        auth_method: "password".into(),
        password: Some(Zeroizing::new("secret".into())),
        secret_id: None,
        private_key_path: None,
        protocol: None,
        env: None,
        note: None,
        color: None,
        created_at: 0,
    }
}

/// 与 russh 内部一致的主目录解析（它用的是 std::env::home_dir）。
/// 注意不能用 dirs::home_dir()：Windows 上那是 SHGetKnownFolderPath，
/// 与 USERPROFILE 环境变量可能指向不同目录，测试会把伪造记录写到别处。
fn test_home() -> std::path::PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .expect("测试环境既没有 USERPROFILE 也没有 HOME")
}

#[tokio::test]
async fn ssh_round_trip() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let server_config = Arc::new(russh::server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(10)),
        keys: vec![key],
        ..Default::default()
    });

    let listener = Box::leak(Box::new(TcpListener::bind("127.0.0.1:0").await.unwrap()));
    let addr = listener.local_addr().unwrap();
    let server_impl: &'static mut EchoServer = Box::leak(Box::new(EchoServer));
    let server = server_impl.run_on_socket(server_config, listener);
    let shutdown = server.handle();
    tokio::spawn(server);

    let sink = Arc::new(Recorder::default());
    let id = "e2e-roundtrip";
    ssh::connect(sink.clone(), config(id, &addr.ip().to_string(), addr.port()))
        .await
        .unwrap();

    wait_until(&sink, "status", "connected").await;
    ssh::write(id, "hello-from-mssh".into()).await.unwrap();
    wait_until(&sink, "data", "ECHO:hello-from-mssh").await;
    ssh::resize(id, 120, 40).await.unwrap();

    let dyn_sink: Arc<dyn EventSink> = sink.clone();
    ssh::disconnect(&dyn_sink, id).await.unwrap();
    wait_until(&sink, "closed", id).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sink.count("closed", id), 1, "closed 事件不应重复：{}", sink.dump());
    shutdown.shutdown("test done".into());
}

#[tokio::test]
async fn ssh_auth_failure_reports_error_status() {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let server_config = Arc::new(russh::server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(10)),
        keys: vec![key],
        ..Default::default()
    });

    let listener = Box::leak(Box::new(TcpListener::bind("127.0.0.1:0").await.unwrap()));
    let addr = listener.local_addr().unwrap();
    let server_impl: &'static mut RejectServer = Box::leak(Box::new(RejectServer));
    let server = server_impl.run_on_socket(server_config, listener);
    let shutdown = server.handle();
    tokio::spawn(server);

    let sink = Arc::new(Recorder::default());
    ssh::connect(sink.clone(), config("e2e-authfail", &addr.ip().to_string(), addr.port()))
        .await
        .unwrap();
    wait_until(&sink, "status", "error").await;
    shutdown.shutdown("test done".into());
}

/// 拒绝所有密码，验证失败时发出 ssh://status(error) 而不是抛异常
#[derive(Clone)]
struct RejectServer;

impl server::Server for RejectServer {
    type Handler = Self;
    fn new_client(&mut self, _addr: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for RejectServer {
    type Error = russh::Error;
}

/// 主机密钥校验：先在 known_hosts 里伪造一条同 host:port 但不同公钥的记录，
/// 连接必须被拒绝（这正是防中间人的核心行为）。
#[tokio::test]
async fn host_key_mismatch_is_rejected() {
    let server_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let server_config = Arc::new(russh::server::Config {
        inactivity_timeout: None,
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::from_millis(10)),
        keys: vec![server_key],
        ..Default::default()
    });

    let listener = Box::leak(Box::new(TcpListener::bind("127.0.0.1:0").await.unwrap()));
    let addr = listener.local_addr().unwrap();
    let server_impl: &'static mut EchoServer = Box::leak(Box::new(EchoServer));
    let server = server_impl.run_on_socket(server_config, listener);
    let shutdown = server.handle();
    tokio::spawn(server);

    // 伪造一条记录：同一个 host:port，但换成另一把完全不相关的公钥
    let fake_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let path = test_home().join(".ssh").join("known_hosts");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let before = std::fs::read_to_string(&path).unwrap_or_default();
    let bogus = format!(
        "[{}]:{} {}\n",
        addr.ip(),
        addr.port(),
        fake_key.public_key().to_openssh().unwrap()
    );
    std::fs::write(&path, format!("{before}{bogus}")).unwrap();

    let sink = Arc::new(Recorder::default());
    ssh::connect(sink.clone(), config("e2e-hostkey", &addr.ip().to_string(), addr.port()))
        .await
        .unwrap();

    let mut rejected = false;
    for _ in 0..120 {
        if sink.has("status", "主机密钥校验失败") {
            rejected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // 无论结果如何先还原 known_hosts，避免污染开发机
    std::fs::write(&path, before).unwrap();

    assert!(
        rejected,
        "指纹不一致时必须拒绝连接，实际事件：{}",
        sink.dump()
    );
    // 被拒绝时不应该出现 connected
    assert!(!sink.has("status", "connected"), "不应建立连接：{}", sink.dump());
    shutdown.shutdown("test done".into());
}
