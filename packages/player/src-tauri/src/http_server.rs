use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Json, Query, State};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, get_service, post};
use serde::{Deserialize, Serialize};
use reqwest::redirect::Policy;
use tauri::{AppHandle, Manager, Emitter};
use tokio::sync::{RwLock, broadcast, oneshot};
use tokio::task::JoinHandle;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tracing::*;

use crate::player::send_player_command;
use crate::server::AMLLWebSocketServer;
use crate::REMOTE_NOW_PLAYING;

#[derive(Clone)]
pub struct HttpServerState {
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    song_events: broadcast::Sender<PlaySongEvent>,
}

pub struct HttpServerController {
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    server_handle: Option<JoinHandle<()>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl HttpServerController {
    pub fn new(app: AppHandle, ws_server: Arc<RwLock<AMLLWebSocketServer>>) -> Self {
        Self {
            app,
            ws_server,
            server_handle: None,
            shutdown_tx: None,
        }
    }

    pub async fn set_enabled(&mut self, enabled: bool) {
        if enabled {
            self.start().await;
        } else {
            self.stop().await;
        }
    }

    async fn start(&mut self) {
        if self.server_handle.is_some() {
            return;
        }

        let Some(dist_dir) = find_dist_dir(&self.app) else {
            warn!("无法定位前端 dist 目录，HTTP 服务不会启动");
            return;
        };
        info!("HTTP 静态服务目录: {}", dist_dir.display());

        let addr: SocketAddr = ([0, 0, 0, 0], 13533).into();
        info!("HTTP 服务监听: http://{addr}/");

        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                error!("HTTP 服务启动失败: {e:?}");
                return;
            }
        };

        let app = self.app.clone();
        let ws_server = self.ws_server.clone();
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);

        // Windows 防火墙自动放行端口
        #[cfg(target_os = "windows")]
        {
            add_firewall_rule("AMLL Player HTTP", 13533);
            add_firewall_rule("AMLL Player WS", 11444);
        }

        self.server_handle = Some(tokio::spawn(async move {
            run_http_server(app, ws_server, dist_dir, listener, shutdown_rx).await;
        }));
    }

    async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.server_handle.take() {
            handle.abort();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NowPlayingResponse {
    title: String,
    artist: String,
    album: String,
    is_playing: bool,
    always_on_top: bool,
    cover: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(tag = "command", rename_all = "camelCase")]
enum RemoteCommand {
    Pause,
    Resume,
    ForwardSong,
    BackwardSong,
    SetVolume { volume: f64 },
    SeekPlayProgress { progress: f64 },
    SetFontSize { size: String },
    ToggleTranslation { enabled: bool },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlwaysOnTopRequest {
    enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RemoteToggleEvent {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsListenAddrRequest {
    addr: String,
}

#[derive(Deserialize)]
struct ExpandUrlQuery {
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpandUrlResponse {
    url: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlaySongEvent {
    id: String,
    source: String,
}

fn find_dist_dir(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok();
    if let Some(resource_dir) = resource_dir {
        let candidates = [
            resource_dir.join("dist"),
            resource_dir.clone(),
            resource_dir.join("_up_").join("dist"),
        ];
        for c in candidates {
            if c.join("remote-index.html").exists() && c.join("assets").exists() {
                return Some(c);
            }
        }
    }

    let dev_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist");
    if dev_dir.join("remote-index.html").exists() && dev_dir.join("assets").exists() {
        return Some(dev_dir);
    }

    let public_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("public");
    if public_dir.join("remote-index.html").exists() {
        return Some(public_dir);
    }

    None
}

fn emit_remote_command(state: &HttpServerState, cmd: &RemoteCommand) {
    if let Err(err) = state.app.emit("remote-http-command", cmd) {
        error!("Failed to emit remote-http-command: {:?}", err);
    }
}

async fn api_now_playing(State(state): State<HttpServerState>) -> Response {
    let info = REMOTE_NOW_PLAYING.read().ok().and_then(|guard| guard.clone());
    let Some(info) = info else {
        return StatusCode::NO_CONTENT.into_response();
    };

    if info.title.is_empty() && info.artist.is_empty() && info.album.is_empty() {
        return StatusCode::NO_CONTENT.into_response();
    }

    let always_on_top = state
        .app
        .get_webview_window("main")
        .and_then(|w| w.is_always_on_top().ok())
        .unwrap_or(false);

    Json(NowPlayingResponse {
        title: info.title,
        artist: info.artist,
        album: info.album,
        is_playing: info.is_playing,
        always_on_top,
        cover: info.cover,
    })
    .into_response()
}

async fn api_player_action(
    State(state): State<HttpServerState>,
    action: &'static str,
) -> StatusCode {
    match action {
        "play" => {
            emit_remote_command(&state, &RemoteCommand::Resume);
            send_player_command(amll_player_core::AudioThreadMessage::ResumeAudio).await;
        }
        "pause" => {
            emit_remote_command(&state, &RemoteCommand::Pause);
            send_player_command(amll_player_core::AudioThreadMessage::PauseAudio).await;
        }
        "next" => {
            emit_remote_command(&state, &RemoteCommand::ForwardSong);
        }
        "prev" => {
            emit_remote_command(&state, &RemoteCommand::BackwardSong);
        }
        _ => return StatusCode::BAD_REQUEST,
    };
    StatusCode::OK
}

async fn api_player_command(
    State(state): State<HttpServerState>,
    Json(cmd): Json<RemoteCommand>,
) -> StatusCode {
    emit_remote_command(&state, &cmd);
    let ok = match cmd {
        RemoteCommand::Pause => {
            send_player_command(amll_player_core::AudioThreadMessage::PauseAudio).await
        }
        RemoteCommand::Resume => {
            send_player_command(amll_player_core::AudioThreadMessage::ResumeAudio).await
        }
        RemoteCommand::ForwardSong => true,
        RemoteCommand::BackwardSong => true,
        RemoteCommand::SetVolume { volume } => {
            let v = volume.clamp(0.0, 1.0);
            send_player_command(amll_player_core::AudioThreadMessage::SetVolume { volume: v }).await
        }
        RemoteCommand::SeekPlayProgress { progress } => {
            let position = progress.max(0.0);
            send_player_command(amll_player_core::AudioThreadMessage::SeekAudio { position }).await
        }
        RemoteCommand::SetFontSize { .. } => true,
        RemoteCommand::ToggleTranslation { .. } => true,
    };
    if ok {
        StatusCode::OK
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn api_fullscreen(State(state): State<HttpServerState>) -> StatusCode {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = state;
        return StatusCode::NOT_IMPLEMENTED;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
    let Some(win) = state.app.get_webview_window("main") else {
        return StatusCode::NOT_FOUND;
    };
    let current = win.is_fullscreen().unwrap_or(false);
    let next = !current;
    if win.set_fullscreen(next).is_ok() {
        if let Err(err) = state
            .app
            .emit("remote-fullscreen", RemoteToggleEvent { enabled: next })
        {
            error!("Failed to emit remote-fullscreen: {:?}", err);
        }
        StatusCode::OK
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
    }
}

async fn api_always_on_top(
    State(state): State<HttpServerState>,
    Json(req): Json<AlwaysOnTopRequest>,
) -> StatusCode {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (state, req);
        return StatusCode::NOT_IMPLEMENTED;
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
    let Some(win) = state.app.get_webview_window("main") else {
        return StatusCode::NOT_FOUND;
    };
    if win.set_always_on_top(req.enabled).is_ok() {
        if let Err(err) = state
            .app
            .emit("remote-always-on-top", RemoteToggleEvent { enabled: req.enabled })
        {
            error!("Failed to emit remote-always-on-top: {:?}", err);
        }
        StatusCode::OK
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
    }
}

async fn api_ws_listen_addr(
    State(state): State<HttpServerState>,
    Json(req): Json<WsListenAddrRequest>,
) -> StatusCode {
    let addr = req.addr.trim().to_string();
    if addr.is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    state.ws_server.write().await.reopen(addr, None);

    StatusCode::OK
}

async fn api_play_song(
    State(state): State<HttpServerState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> StatusCode {
    let event = PlaySongEvent {
        id,
        source: "ncm".to_string(),
    };
    let _ = state.song_events.send(event.clone());
    if let Err(err) = state.app.emit("remote-play-song", &event) {
        error!("Failed to emit remote-play-song: {:?}", err);
        return StatusCode::INTERNAL_SERVER_ERROR;
    }
    StatusCode::OK
}

async fn api_expand_url(Query(query): Query<ExpandUrlQuery>) -> Response {
    let raw = query.url.trim();
    if !(raw.starts_with("http://") || raw.starts_with("https://")) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let client = match reqwest::Client::builder()
        .redirect(Policy::limited(8))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            error!("Failed to build http client: {:?}", err);
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let resp = match client.get(raw).send().await {
        Ok(resp) => resp,
        Err(err) => {
            error!("Failed to expand url {}: {:?}", raw, err);
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let final_url = resp.url().to_string();
    Json(ExpandUrlResponse { url: final_url }).into_response()
}

async fn api_player_events_ws(
    ws: WebSocketUpgrade,
    State(state): State<HttpServerState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_player_events_socket(socket, state.song_events.subscribe()))
        .into_response()
}

async fn handle_player_events_socket(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<PlaySongEvent>,
) {
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let event = match msg {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let Ok(text) = serde_json::to_string(&event) else {
                    continue;
                };
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(v))) => {
                        if socket.send(Message::Pong(v)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}

pub fn build_router(
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    dist_dir: PathBuf,
) -> Router {
    let (song_events, _) = broadcast::channel(64);
    let state = HttpServerState {
        app,
        ws_server,
        song_events,
    };
    Router::new()
        .route("/api/player/now-playing", get(api_now_playing))
        .route(
            "/api/player/play",
            post(|state: State<HttpServerState>| async move {
                api_player_action(state, "play").await
            }),
        )
        .route(
            "/api/player/pause",
            post(|state: State<HttpServerState>| async move {
                api_player_action(state, "pause").await
            }),
        )
        .route(
            "/api/player/next",
            post(|state: State<HttpServerState>| async move {
                api_player_action(state, "next").await
            }),
        )
        .route(
            "/api/player/prev",
            post(|state: State<HttpServerState>| async move {
                api_player_action(state, "prev").await
            }),
        )
        .route("/api/player/fullscreen", post(api_fullscreen))
        .route("/api/player/command", post(api_player_command))
        .route("/api/player/always-on-top", post(api_always_on_top))
        .route("/api/ws/listen-addr", post(api_ws_listen_addr))
        .route("/api/player/song/:id", post(api_play_song))
        .route("/api/player/expand-url", get(api_expand_url))
        .route("/api/player/events", get(api_player_events_ws))
        .route(
            "/",
            get_service(ServeFile::new(dist_dir.join("remote-index.html"))),
        )
        .fallback_service(ServeDir::new(dist_dir).append_index_html_on_directories(false))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn run_http_server(
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    dist_dir: PathBuf,
    listener: tokio::net::TcpListener,
    shutdown_rx: oneshot::Receiver<()>,
) {
    let router = build_router(app, ws_server, dist_dir);
    let server = axum::serve(listener, router).with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });
    if let Err(e) = server.await {
        error!("HTTP 服务异常退出: {e:?}");
    }
}

/// Windows 平台：尝试添加防火墙入站规则放行指定端口。
/// 需要管理员权限，如果权限不足则静默失败并打印警告。
#[cfg(target_os = "windows")]
fn add_firewall_rule(rule_name: &str, port: u16) {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let output = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={rule_name}"),
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &format!("localport={port}"),
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output();
    match output {
        Ok(out) if out.status.success() => {
            info!("防火墙规则已添加: {rule_name} (TCP:{port})");
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            warn!("添加防火墙规则失败: {rule_name} (TCP:{port}) - {stderr}");
        }
        Err(e) => {
            warn!("执行 netsh 命令失败: {rule_name} (TCP:{port}) - {e:?}");
        }
    }
}
