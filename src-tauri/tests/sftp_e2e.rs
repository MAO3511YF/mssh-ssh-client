//! SFTP 端到端验证：本地起 SSH + SFTP 子系统服务端，
//! 通过 mssh 的 sftp::list 确认子通道数据流正确（不污染终端、不和会话关闭冲突）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use mssh_lib::model::SessionConfig;
use mssh_lib::sftp;
use mssh_lib::ssh::{self, EventSink};
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{Auth, ChannelOpenHandle, Msg as ServerMsg, Server as _, Session as ServerSession};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{File, FileAttributes, Handle, Name, Status, StatusCode, Version};
use tokio::net::TcpListener;

#[derive(Clone, Default)]
struct NoopSink;
impl EventSink for NoopSink {
    fn status(&self, _: &str, _: &str, _: Option<String>) {}
    fn data(&self, _: &str, _: &str) {}
    fn closed(&self, _: &str) {}
}

#[derive(Clone)]
struct SftpSshServer;

impl russh::server::Server for SftpSshServer {
    type Handler = SftpHandler;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        SftpHandler::default()
    }
}

#[derive(Default)]
struct SftpHandler {
    clients: Arc<tokio::sync::Mutex<HashMap<ChannelId, Channel<ServerMsg>>>>,
}

impl russh::server::Handler for SftpHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _: &str, _: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<ServerMsg>,
        reply: ChannelOpenHandle,
        _session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        self.clients.lock().await.insert(channel.id(), channel);
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

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut ServerSession,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.clients.lock().await.remove(&channel_id).unwrap();
            session.channel_success(channel_id)?;
            // 必须 spawn：若在 handler 内 await，会阻塞 russh server 的 session 事件循环，
            // 后续 CHANNEL_DATA 无法投递，SFTP 握手死锁。
            tokio::spawn(async move {
                russh_sftp::server::run(channel.into_stream(), SftpProto::default()).await;
            });
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

#[derive(Default)]
struct SftpProto {
    root_read_done: bool,
}

impl russh_sftp::server::Handler for SftpProto {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        self.root_read_done = false;
        Ok(Handle { id, handle: path })
    }

    async fn readdir(&mut self, id: u32, _handle: String) -> Result<Name, Self::Error> {
        if !self.root_read_done {
            self.root_read_done = true;
            return Ok(Name {
                id,
                files: vec![
                    File::new("alpha.txt", FileAttributes::dummy()),
                    File::new("beta_dir", FileAttributes::dummy()),
                ],
            });
        }
        Err(StatusCode::Eof)
    }

    async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, Self::Error> {
        Ok(Name { id, files: vec![File::dummy("/")] })
    }
}

fn config(host: &str, port: u16) -> SessionConfig {
    SessionConfig {
        id: "sftp-e2e".into(),
        kind: "transfer".into(),
        name: "sftp-e2e".into(),
        host: host.into(),
        port,
        username: "tester".into(),
        directory: "测试".into(),
        auth_method: "password".into(),
        password: Some("secret".into()),
        private_key_path: None,
        protocol: Some("sftp".into()),
        env: None,
        note: None,
        color: None,
        created_at: 0,
    }
}

#[tokio::test]
async fn sftp_list_over_real_channel() {
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
    let server_impl: &'static mut SftpSshServer = Box::leak(Box::new(SftpSshServer));
    let server = server_impl.run_on_socket(server_config, listener);
    let shutdown = server.handle();
    tokio::spawn(server);

    let sink = Arc::new(NoopSink);
    ssh::connect(sink.clone(), config(&addr.ip().to_string(), addr.port()))
        .await
        .unwrap();

    // 等 connected
    for _ in 0..100 {
        if !ssh::session_handle("sftp-e2e").is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let entries = sftp::list("sftp-e2e", ".").await.expect("sftp list 应成功");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"alpha.txt"), "应列出 alpha.txt，实际: {:?}", names);
    assert!(names.contains(&"beta_dir"), "应列出 beta_dir，实际: {:?}", names);
    assert!(entries.iter().all(|e| !e.path.is_empty()), "每个条目都应有完整路径");

    let dyn_sink: Arc<dyn EventSink> = sink.clone();
    ssh::disconnect(&dyn_sink, "sftp-e2e").await.unwrap();
    shutdown.shutdown("done".into());
}
