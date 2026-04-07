# AMLL (Apple Music Like Lyrics) 核心功能技术文档

> **文档版本**: 1.0.0
> **最后更新**: 2026-04-07
> **适用项目**: applemusic-like-lyrics
> **文档目的**: 确保在代码丢失时能够完整重构项目的四个核心功能

---

## 目录

1. [远程网页控制功能](#1-远程网页控制功能)
2. [窗口置顶功能](#2-窗口置顶功能)
3. [歌词贡献者标签功能](#3-歌词贡献者标签功能)
4. [远程点歌功能](#4-远程点歌功能)

---

## 1. 远程网页控制功能

### 1.1 功能概述

#### 1.1.1 业务价值

远程网页控制功能是 AMLL 播放器的核心交互特性之一，允许用户通过**同一局域网内的任何设备（手机、平板、另一台电脑等）**的浏览器访问控制页面，实现对播放器的完全远程操控。该功能解决了以下用户痛点：

- **多设备协同**: 用户可以在电脑上运行主程序，使用手机作为遥控器
- **演示场景**: 在会议或演示时，演讲者可远离电脑进行音乐控制
- **家庭娱乐**: 将电脑连接到音响系统后，用手机远程选歌和控制
- **开发调试**: 开发者可通过 HTTP API 进行自动化测试和集成

#### 1.1.2 功能边界与模块交互关系

```
┌─────────────────────────────────────────────────────────────┐
│                     远程控制系统架构                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐    WebSocket     ┌──────────────────┐    │
│   │  外部客户端   │ ◄──────────────► │  WS Server (Rust)│    │
│   │ (浏览器/APP)  │   TCP:11444      │  (tokio-tungstenite)│   │
│   └──────────────┘                  └────────┬─────────┘    │
│                                             │              │
│   ┌──────────────┐    HTTP/WS        ┌──────▼─────────┐    │
│   │  远程控制页面  │ ◄──────────────► │  HTTP Server    │    │
│   │(remote-index) │   TCP:13533      │  (Axum框架)     │    │
│   └──────────────┘                  └──────┬─────────┘    │
│                                             │              │
│                              Tauri Events   │              │
│                              (IPC Channel)  │              │
│                                             ▼              │
│                                    ┌────────────────┐     │
│                                    │  前端 React 应用 │     │
│                                    │ (Jotai State)   │     │
│                                    └────────────────┘     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**核心组件职责划分**:

| 组件 | 技术栈 | 职责 | 文件位置 |
|------|--------|------|----------|
| HTTP Server | Rust/Axum | 提供静态文件服务、REST API、WebSocket事件推送 | `src-tauri/src/http_server.rs` |
| WebSocket Server | Rust/tokio-tungstenite | 处理WS协议连接、消息转发、协议适配 | `src-tauri/src/server.rs` |
| 远程控制前端 | HTML/CSS/JS | 提供移动端友好的UI界面 | `public/remote-index.html` |
| 前端桥接层 | React/TypeScript | 监听Tauri事件、更新全局状态 | `src/components/WSProtocolMusicContext/` |
| 协议定义 | TypeScript/Rust | 定义消息格式和数据结构 | `packages/ws-protocol/` |

---

### 1.2 技术实现细节

#### 1.2.1 核心算法和数据流程

##### **HTTP Server 启动流程**

```rust
// 伪代码 - http_server.rs::HttpServerController::start()
async fn start(&mut self) {
    // 1. 定位前端dist目录（优先级：resource_dir > dev_dir > public_dir）
    let dist_dir = find_dist_dir(&self.app);

    // 2. 绑定端口 0.0.0.0:13533（允许所有网络接口访问）
    let addr: SocketAddr = ([0, 0, 0, 0], 13533).into();

    // 3. 创建TCP监听器
    let listener = TcpListener::bind(addr).await;

    // 4. 构建Axum路由器并启动HTTP服务器
    //    路由配置见 build_router() 函数
    tokio::spawn(async move {
        run_http_server(app, ws_server, dist_dir, listener, shutdown_rx).await;
    });
}
```

**流程图**:

```
用户启用HTTP服务
       │
       ▼
┌──────────────────┐
│ 检查是否已启动？  │──Yes──► 直接返回
└────────┬─────────┘
         │ No
         ▼
┌──────────────────┐
│ 定位 dist 目录    │
│ (resource/dev/   │
│  public)         │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 绑定 0.0.0.0:    │
│ 13533 端口       │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 创建 broadcast   │
│ channel (容量64) │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 构建 Axum Router │
│ 配置所有路由      │
│ 启用 CORS        │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ 异步启动 HTTP    │
│ Server           │
│ (graceful        │
│  shutdown)       │
└──────────────────┘
```

##### **WebSocket 连接处理流程**

```rust
// 伪代码 - server.rs::AMLLWebSocketServer::accept_conn()
async fn accept_conn(stream, app, conns, channel) -> Result<()> {
    // 1. 获取客户端地址
    let addr = stream.peer_addr()?;

    // 2. 执行WebSocket握手
    let wss = accept_async(stream).await?;

    // 3. 分离读写流
    let (write_sink, mut read_stream) = wss.split();

    // 4. 读取首条消息以识别协议版本
    let first_message = read_stream.next().await;

    // 5. 协议协商逻辑:
    match first_message {
        Message::Text(text) => {
            // 尝试解析为 V2 协议 (JSON格式)
            if is_v2_initialize(text) => ProtocolType::HybridV2
            else 断开连接
        }
        Message::Binary(data) => {
            // 识别为 V1 协议 (二进制格式)
            ProtocolType::BinaryV1
        }
        _ => ProtocolType::Unknown
    }

    // 6. 注册连接到连接池
    conns.write().await.insert(addr, ConnectionInfo{sink, protocol});

    // 7. 发送连接成功事件给前端
    app.emit("on-ws-protocol-client-connected", &addr_str)?;

    // 8. 进入消息循环
    while let Some(message) = read_stream.next().await {
        process_message(message, protocol, channel)?;
    }

    // 9. 清理连接
    conns.write().await.remove(&addr);
    app.emit("on-ws-protocol-client-disconnected", &addr_str)?;
}
```

**协议协商状态机**:

```
                    ┌─────────────┐
                    │  等待连接    │
                    └──────┬──────┘
                           │
              接收到TCP连接 │
                           ▼
                    ┌─────────────┐
                    │  WS握手     │
                    └──────┬──────┘
                           │
              握手成功      │
                           ▼
               ┌───────────────────────┐
               │   读取第一条消息       │
               └───────────┬───────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ Text消息   │  │ Binary消息 │  │ 其他类型   │
   └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
         │                │                │
         ▼                ▼                ▼
   解析V2 JSON      识别为V1协议      断开连接
         │                │
         ▼                ▼
   是Initialize?     处理V1消息
    │       │
   Yes      No
    │       │
    ▼       ▼
  HybridV2 断开
```

##### **消息广播机制**

```rust
// 伪代码 - server.rs::AMLLWebSocketServer::broadcast_payload()
async fn broadcast_payload(&mut self, payload: v2::Payload) {
    // 1. 序列化为V2 JSON格式
    let v2_msg = serde_json::to_string(&payload) → Message::Text

    // 2. 转换为V1二进制格式（如果可能）
    let v1_msg = v1::Body::try_from(payload) → v1::to_body() → Message::Binary

    // 3. 遍历所有连接，根据协议类型发送对应格式
    for (addr, conn_info) in connections.iter_mut() {
        match conn_info.protocol {
            ProtocolType::BinaryV1 => send(v1_msg),
            ProtocolType::HybridV2 => send(v2_msg),
            _ => skip
        }
    }

    // 4. 清理失败的连接
    remove_disconnected_clients();
}
```

#### 1.2.2 关键数据结构定义

**Rust 后端数据结构**:

```rust
// ====== server.rs ======

/// WebSocket连接信息
struct ConnectionInfo {
    sink: SplitSink<WebSocketStream<TcpStream>, Message>,  // 消息发送通道
    protocol: ProtocolType,                                // 协议类型标识
}

/// 支持的协议类型枚举
enum ProtocolType {
    Unknown,      // 未识别
    BinaryV1,     // 二进制V1协议
    HybridV2,     // 混合V2协议(JSON+Binary)
}

/// WebSocket服务器主结构体
pub struct AMLLWebSocketServer {
    app: AppHandle,                                        // Tauri应用句柄
    server_handle: Option<JoinHandle<()>>,                 // 异步任务句柄
    connections: Connections,                              // 连接池 (Arc<RwLock<HashMap>>)
    channel: Option<Channel<v2::Payload>>,                // Tauri IPC通道
    listen_addr: Option<String>,                          // 监听地址
}

// 类型别名
type Connections = Arc<TokioRwLock<HashMap<SocketAddr, ConnectionInfo>>;


// ====== http_server.rs ======

/// HTTP服务器共享状态
#[derive(Clone)]
pub struct HttpServerState {
    app: AppHandle,                                        // Tauri应用句柄
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,           // WS服务器引用
    song_events: broadcast::Sender<PlaySongEvent>,         // 歌曲事件广播通道
}

/// HTTP服务器控制器
pub struct HttpServerController {
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    server_handle: Option<JoinHandle<()>>,                 // 服务任务句柄
    shutdown_tx: Option<oneshot::Sender<()>>,             // 关闭信号发送端
}

/// 当前播放信息响应结构
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

/// 远程命令枚举（支持多种命令类型）
#[derive(Serialize, Deserialize, Clone)]
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

/// 点歌事件结构
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlaySongEvent {
    id: String,           // 歌曲ID
    source: String,       // 来源平台 (如 "ncm")
}
```

**TypeScript 前端数据结构**:

```typescript
// ====== WSProtocolMusicContext/index.tsx ======

// 歌手信息接口
interface WSArtist {
  id: string;
  name: string;
}

// 歌词单词接口
interface WSLyricWord {
  startTime: number;      // 开始时间(ms)
  endTime: number;        // 结束时间(ms)
  word: string;           // 单词文本
  romanWord: string;      // 音译文本
}

// 歌词行接口
interface WSLyricLine {
  startTime: number;      // 行开始时间
  endTime: number;        // 行结束时间
  words: WSLyricWord[];   // 单词数组
  isBG: boolean;          // 是否背景歌词
  isDuet: boolean;        // 是否对唱歌词
  translatedLyric: string;// 翻译文本
  romanLyric: string;     // 音译文本
}

// 音乐元信息接口
interface WSMusicInfo {
  musicId: string;
  musicName: string;
  albumId: string;
  albumName: string;
  artists: WSArtist[];
  duration: number;
}

// 专辑封面数据（支持URI或Base64）
type WSAlbumCover =
  | { source: "uri"; url: string }
  | { source: "data": image: WSImageData };

// 歌词内容（支持结构化或TTML原始数据）
type WSLyricContent =
  | { format: "structured"; lines: WSLyricLine[] }
  | { format: "ttml"; data: string };

// 远程命令联合类型
type WSCommand =
  | { command: "pause" }
  | { command: "resume" }
  | { command: "forwardSong" }
  | { command: "backwardSong" }
  | { command: "setVolume"; volume: number }
  | { command: "seekPlayProgress"; progress: number }
  | { command: "setRepeatMode"; mode: RepeatMode }
  | { command: "setShuffleMode"; enabled: boolean };

// 状态更新联合类型
type WSStateUpdate =
  | ({ update: "setMusic" } & WSMusicInfo)
  | ({ update: "setCover" } & WSAlbumCover)
  | ({ update: "setLyric" } & WSLyricContent)
  | { update: "progress"; progress: number }
  | { update: "volume"; volume: number }
  | { update: "paused" }
  | { update: "resumed" }
  | { update: "audioData"; data: number[] }
  | { update: "modeChanged"; repeat: RepeatMode; shuffle: boolean };

// 完整的消息载荷类型
type WSPayload =
  | { type: "initialize" }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "command"; value: WSCommand }
  | { type: "state"; value: WSStateUpdate };
```

#### 1.2.3 状态管理方案

**后端状态管理**:

```rust
// 使用 Tokio 的 RwLock 实现并发安全的连接管理
let connections: Arc<TokioRwLock<HashMap<SocketAddr, ConnectionInfo>>>

// 使用 broadcast channel 实现点歌事件的发布订阅模式
let (song_events, _) = broadcast::channel::<PlaySongEvent>(64);

// 使用 oneshot channel 实现 HTTP 服务的优雅关闭
let (shutdown_tx, shutdown_rx) = oneshot::channel();
```

**前端状态管理 (Jotai)**:

```typescript
// states/appAtoms.ts

// WebSocket监听地址（持久化到localStorage）
export const wsProtocolListenAddrAtom = atomWithStorage(
  "amll-player.wsProtocolListenAddr",
  "localhost:11444",  // 默认值
);

// 已连接的客户端地址集合
export const wsProtocolConnectedAddrsAtom = atom(new Set<string>());

// HTTP服务器开关（持久化）
export const enableHttpServerAtom = atom(
  (get) => get(enableHttpServerInternalAtom),
  (_get, set, enabled: boolean) => {
    set(enableHttpServerInternalAtom, enabled);
    invoke("set_http_server_enabled", { enabled });  // 触发Tauri命令
  },
);

// 音乐上下文模式（本地播放 or WS协议接收）
export enum MusicContextMode {
  Local = "local",
  WSProtocol = "ws-protocol",
}
export const musicContextModeAtom = atomWithStorage(
  "amll-player.musicContextMode",
  MusicContextMode.Local,
);
```

#### 1.2.4 事件处理机制

**Tauri IPC 事件流**:

```
外部客户端发送命令
        │
        ▼
┌───────────────────┐
│ HTTP API / WS     │
│ 接收请求          │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ emit()            │ ← Rust后端发出Tauri事件
│ "remote-http-     │
│  command"         │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ listen()          │ ← React前端监听事件
│ (Tauri Event API) │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ 更新 Jotai Atoms  │ ← 全局状态更新
│ (store.set())     │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ UI重新渲染        │ ← React响应式更新
└───────────────────┘
```

**关键事件列表**:

| 事件名称 | 方向 | 数据类型 | 用途 |
|----------|------|----------|------|
| `remote-http-command` | Backend→Frontend | `RemoteCommand` | HTTP API触发的远程命令 |
| `remote-play-song` | Backend→Frontend | `PlaySongEvent` | 远程点歌事件 |
| `remote-fullscreen` | Backend→Frontend | `RemoteToggleEvent` | 全屏切换通知 |
| `remote-always-on-top` | Backend→Frontend | `RemoteToggleEvent` | 置顶切换通知 |
| `on-ws-protocol-client-connected` | Backend→Frontend | `String`(地址) | WS客户端连接通知 |
| `on-ws-protocol-client-disconnected` | Backend→Frontend | `String`(地址) | WS客户端断开通知 |

---

### 1.3 代码实现指南

#### 1.3.1 核心模块/类的结构设计

##### **HTTP Server 模块 (`http_server.rs`)**

**文件位置**: `packages/player/src-tauri/src/http_server.rs`
**总行数**: ~500行
**核心职责**: 提供RESTful API、静态文件托管、WebSocket事件推送

**主要函数清单**:

| 函数名 | 可见性 | 参数 | 返回值 | 说明 |
|--------|--------|------|--------|------|
| `HttpServerController::new()` | pub | `AppHandle`, `Arc<RwLock<AMLLWebSocketServer>>` | `Self` | 构造函数 |
| `set_enabled()` | pub async | `enabled: bool` | `()` | 启动/停止HTTP服务 |
| `start()` | private async | 无 | `()` | 启动HTTP服务器 |
| `stop()` | private async | 无 | `()` | 停止HTTP服务器 |
| `build_router()` | pub | `AppHandle`, `Arc<RwLock<...>>`, `PathBuf` | `Router` | 构建Axum路由 |
| `find_dist_dir()` | private | `&AppHandle` | `Option<PathBuf>` | 定位前端目录 |
| `api_now_playing()` | async | `State<HttpServerState>` | `Response` | GET当前播放信息 |
| `api_player_action()` | async | `State`, action:str | `StatusCode` | POST播放控制 |
| `api_player_command()` | async | `State`, `Json<RemoteCommand>` | `StatusCode` | POST通用命令 |
| `api_play_song()` | async | `State`, Path(id) | `StatusCode` | POST点歌请求 |
| `api_fullscreen()` | async | `State<HttpServerState>` | `StatusCode` | POST全屏切换 |
| `api_always_on_top()` | async | `State`, `Json<Request>` | `StatusCode` | POST置顶切换 |
| `api_player_events_ws()` | async | `WebSocketUpgrade`, `State` | `Response` | GET升级为WS |
| `handle_player_events_socket()` | async | `WebSocket`, broadcast::Receiver | `()` | 处理WS事件推送 |

##### **WebSocket Server 模块 (`server.rs`)**

**文件位置**: `packages/player/src-tauri/src/server.rs`
**总行数**: ~273行
**核心职责**: 管理WebSocket连接、协议适配、消息广播

**主要方法清单**:

| 方法名 | 可见性 | 参数 | 返回值 | 说明 |
|--------|--------|------|--------|------|
| `new()` | pub | `AppHandle` | `Self` | 构造函数 |
| `close()` | pub async | 无 | `()` | 关闭服务器及所有连接 |
| `reopen()` | pub | `addr:String`, `Option<Channel>` | `()` | 重启服务器(新地址) |
| `set_listen_addr()` | pub | `addr:String` | `()` | 设置监听地址 |
| `get_listen_addr()` | pub | 无 | `Option<&str>` | 获取当前监听地址 |
| `get_connections()` | pub async | 无 | `Vec<SocketAddr>` | 获取已连接客户端列表 |
| `broadcast_payload()` | pub async | `v2::Payload` | `()` | 向所有客户端广播消息 |
| `accept_conn()` | private async | `TcpStream`, ... | `Result<()>` | 处理新连接 |
| `process_v1_message()` | private async | `Message`, `&Channel` | `Result<()>` | 处理V1协议消息 |
| `process_v2_message()` | private async | `Message`, `&Channel` | `Result<()>` | 处理V2协议消息 |

##### **前端桥接组件 (`WSProtocolMusicContext`)**

**文件位置**: `packages/player/src/components/WSProtocolMusicContext/index.tsx`
**总行数**: ~606行
**核心职责**: 监听WS协议消息、同步状态到Jotai、提供回调函数

**组件Props**:

```typescript
interface WSProtocolMusicContextProps {
  isLyricOnly?: boolean;  // 是否仅显示歌词（不含控制按钮）
}
```

**内部使用的Hooks和Atoms**:

- `useAtomValue(wsProtocolListenAddrAtom)` - WS监听地址
- `useSetAtom(wsProtocolConnectedAddrsAtom)` - 更新连接列表
- `useSetAtom(isLyricPageOpenedAtom)` - 控制歌词页面显示
- `useStore()` - Jotai store实例（用于非响应式写入）
- `useTranslation()` - i18n国际化
- `useRef<FFTPlayer>()` - FFT音频分析器引用

#### 1.3.2 关键函数实现详解

##### **HTTP路由构建函数 `build_router()`**

```rust
// 完整实现 - http_server.rs
pub fn build_router(
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    dist_dir: PathBuf,
) -> Router {
    // 1. 创建broadcast channel用于点歌事件推送（容量64）
    let (song_events, _) = broadcast::channel(64);

    // 2. 构建共享状态
    let state = HttpServerState {
        app,
        ws_server,
        song_events,
    };

    // 3. 配置所有API路由
    Router::new()
        // === 播放控制 API ===
        .route("/api/player/now-playing", get(api_now_playing))           // 获取当前播放信息
        .route("/api/player/play", post(api_player_action.with_state("play")))    // 播放
        .route("/api/player/pause", post(api_player_action.with_state("pause")))  // 暂停
        .route("/api/player/next", post(api_player_action.with_state("next")))    // 下一首
        .route("/api/player/prev", post(api_player_action.with_state("prev")))    // 上一首
        // === 窗口控制 API ===
        .route("/api/player/fullscreen", post(api_fullscreen))            // 全屏切换
        .route("/api/player/always-on-top", post(api_always_on_top))      // 置顶切换
        // === 通用命令 API ===
        .route("/api/player/command", post(api_player_command))           // 通用命令(音量/进度/字体/翻译)
        // === 点歌 API ===
        .route("/api/player/song/:id", post(api_play_song))               // 通过ID点歌
        // === 工具 API ===
        .route("/api/ws/listen-addr", post(api_ws_listen_addr))           // 设置WS监听地址
        .route("/api/player/expand-url", get(api_expand_url))             // URL重定向解析
        .route("/api/player/events", get(api_player_events_ws))           // WebSocket事件流
        // === 静态文件服务 ===
        .route("/", get_service(ServeFile::new(dist_dir.join("remote-index.html"))))
        .fallback_service(ServeDir::new(dist_dir).append_index_html_on_directories(false))
        // === 中间件 ===
        .layer(CorsLayer::permissive())  // 允许跨域（重要！）
        .with_state(state)
}
```

**关键设计决策**:
- 使用 `CorsLayer::permissive()` 允许所有跨域请求（因为控制页面可能在任意端口访问）
- 静态文件优先返回 `remote-index.html` 作为首页
- `fallback_service` 处理SPA路由（支持前端History模式）

##### **远程命令处理函数 `api_player_command()`**

```rust
// 完整实现 - http_server.rs
async fn api_player_command(
    State(state): State<HttpServerState>,
    Json(cmd): Json<RemoteCommand>,
) -> StatusCode {
    // 1. 向前端发出Tauri事件（触发UI反馈）
    emit_remote_command(&state, &cmd);

    // 2. 根据命令类型执行对应的播放器操作
    let ok = match cmd {
        RemoteCommand::Pause => {
            send_player_command(amll_player_core::AudioThreadMessage::PauseAudio).await
        }
        RemoteCommand::Resume => {
            send_player_command(amll_player_core::AudioThreadMessage::ResumeAudio).await
        }
        RemoteCommand::ForwardSong => true,  // 切歌由前端处理
        RemoteCommand::BackwardSong => true,
        RemoteCommand::SetVolume { volume } => {
            let v = volume.clamp(0.0, 1.0);  // 安全边界检查
            send_player_command(amll_player_core::AudioThreadMessage::SetVolume { volume: v }).await
        }
        RemoteCommand::SeekPlayProgress { progress } => {
            let position = progress.max(0.0);  // 非负检查
            send_player_command(amll_player_core::AudioThreadMessage::SeekAudio { position }).await
        }
        RemoteCommand::SetFontSize { .. } => true,  // 仅需前端处理
        RemoteCommand::ToggleTranslation { .. } => true,
    };

    // 3. 返回状态码
    if ok { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR }
}
```

##### **前端事件监听与状态同步**

```typescript
// 完整实现 - WSProtocolMusicContext/index.tsx (关键部分)
export const WSProtocolMusicContext: FC<WSProtocolMusicContextProps> = ({
  isLyricOnly = false,
}) => {
  // ... 变量声明 ...

  useEffect(() => {
    if (!wsProtocolListenAddr && !isLyricOnly) return;

    // 1. 重置连接状态
    setConnectedAddrs(new Set());

    // 2. 如果不是纯歌词模式，初始化UI占位符
    if (!isLyricOnly) {
      store.set(musicNameAtom, "等待连接中");
      store.set(musicAlbumNameAtom, "");
      store.set(musicCoverAtom, "");
      store.set(musicArtistsAtom, []);
      // ...
    }

    // 3. 定义WS命令发送函数
    function sendWSCommand(command: WSCommand) {
      const payload: WSPayload = { type: "command", value: command };
      invoke("ws_broadcast_payload", { payload });  // 调用Tauri命令
    }

    // 4. 绑定播放控制回调到WS命令
    if (!isLyricOnly) {
      store.set(onRequestPrevSongAtom, () => sendWSCommand({ command: "backwardSong" }));
      store.set(onRequestNextSongAtom, () => sendWSCommand({ command: "forwardSong" }));
      store.set(onPlayOrResumeAtom, () => sendWSCommand({ command: "resume" }));
      // ... 更多回调绑定
    }

    // 5. 监听HTTP远程命令事件
    const unlistenRemoteHttp = listen<WSCommand>("remote-http-command", (evt) => {
      sendWSCommand(evt.payload);  // 转发到WS
      const message = getRemoteCommandMessage(evt.payload);
      if (message) showRemoteNotification(message);  // 显示Toast提示
    });

    // 6. 创建Tauri Channel接收双向通信
    const onBodyChannel = new Channel<WSPayload>();

    // 7. 打开WS连接
    invoke("ws_reopen_connection", {
      addr: wsProtocolListenAddr,
      channel: onBodyChannel,
    });

    // 8. 监听来自WS的消息
    (async () => {
      for await (const payload of onBodyChannel) {
        handleWSPayload(payload);  // 处理各类状态更新
      }
    })();

    // 9. 监听连接/断开事件
    const unlistenConnected = listen<string>("on-ws-protocol-client-connected", (evt) => {
      setConnectedAddrs((prev) => new Set(prev).add(evt.payload));
    });
    const unlistenDisconnected = listen<string>("on-ws-protocol-client-disconnected", (evt) => {
      setConnectedAddrs((prev) => {
        const next = new Set(prev);
        next.delete(evt.payload);
        return next;
      });
    });

    // 10. 清理函数（组件卸载时）
    return () => {
      unlistenRemoteHttp();
      unlistenConnected();
      unlistenDisconnected();
      invoke("ws_close_connection");
    };
  }, [wsProtocolListenAddr, isLyricOnly, store]);
};
```

##### **WS消息处理器 `handleWSPayload()`**

```typescript
// 伪代码 - WSProtocolMusicContext内部函数
function handleWSPayload(payload: WSPayload) {
  switch (payload.type) {
    case "state":
      handleStateUpdate(payload.value);
      break;
    // ... 其他类型处理
  }
}

function handleStateUpdate(update: WSStateUpdate) {
  switch (update.update) {
    case "setMusic": {
      // 更新歌曲基本信息
      store.set(musicIdAtom, update.musicId);
      store.set(musicNameAtom, update.musicName);
      store.set(musicAlbumNameAtom, update.albumName);
      store.set(musicArtistsAtom, update.artists);
      store.set(musicDurationAtom, update.duration);

      // 触发贡献者查询（异步，带缓存）
      triggerContributorFetch(update.musicId);

      updateRemoteNowPlaying();  // 更新HTTP API的now-playing数据
      break;
    }
    case "setCover": {
      // 处理专辑封面（支持URI或Base64）
      const coverUrl = update.cover.source === "uri"
        ? update.cover.url
        : `data:${update.cover.image.mimeType};base64,${update.cover.image.data}`;
      store.set(musicCoverAtom, coverUrl);
      break;
    }
    case "setLyric": {
      // 处理歌词数据（结构化或TTML）
      let lines;
      let contributor = null;

      if (update.format === "structured") {
        lines = update.lines;
      } else {
        // 解析TTML格式
        try {
          const ttmlResult = parseTTML(update.data);
          lines = ttmlResult.lines;
          // 从metadata提取贡献者
          const authorMeta = ttmlResult.metadata?.find(
            ([key]) => key === "ttmlAuthorGithubLogin"
          );
          contributor = authorMeta?.[1]?.[0] ?? null;
        } catch (e) {
          toast.error(`解析TTML失败: ${e}`);
          return;
        }
      }

      // 处理歌词数据（移除obscene标记）
      const processed = lines.map(line => ({
        ...line,
        words: line.words.map(word => ({ ...word, obscene: false })),
      }));

      store.set(hideLyricViewAtom, processed.length === 0);
      store.set(musicLyricLinesAtom, processed);

      // 显示贡献者标签（如果有逐词歌词）
      if (contributor && processed.some(l => l.words?.length > 0)) {
        store.set(lyricContributorAtom, contributor);
      }
      break;
    }
    case "progress":
      store.set(musicPlayingPositionAtom, update.progress);
      break;
    case "volume":
      store.set(musicVolumeAtom, update.volume);
      break;
    case "paused":
      store.set(musicPlayingAtom, false);
      updateRemoteNowPlaying();
      break;
    case "resumed":
      store.set(musicPlayingAtom, true);
      updateRemoteNowPlaying();
      break;
    case "audioData": {
      // FFT频谱数据处理
      fftPlayer.current?.write(new Float32Array(update.data));
      break;
    }
    case "modeChanged":
      store.set(repeatModeAtom, update.repeat);
      store.set(isShuffleActiveAtom, update.shuffle);
      break;
  }
}
```

#### 1.3.3 重要业务逻辑的实现步骤

**步骤1: 用户启用远程控制**
1. 前端调用 `invoke("set_http_server_enabled", { enabled: true })`
2. Tauri命令处理器调用 `HttpServerController::set_enabled(true)`
3. Controller调用 `start()` 方法：
   - 定位 `remote-index.html` 所在的dist目录
   - 绑定TCP端口 13533
   - 创建broadcast channel用于点歌事件
   - 构建Axum Router并注册所有路由
   - 启动异步HTTP服务任务

**步骤2: 远程客户端访问控制页面**
1. 用户在浏览器输入 `http://<IP>:13533`
2. HTTP Server返回 `remote-index.html` 及其资源
3. 页面加载完成后，JavaScript通过fetch轮询 `/api/player/now-playing` 或通过WebSocket `/api/player/events` 获取实时状态
4. 用户点击控制按钮时，页面发送POST请求到对应API端点

**步骤3: 远程命令执行流程**
1. HTTP Server接收到POST请求（如 `{ command: "pause" }`）
2. 调用 `emit_remote_command()` 向前端发出 `remote-http-command` 事件
3. 同时调用 `send_player_command()` 向音频线程发送实际控制指令
4. 前端的 `WSProtocolMusicContext` 监听到事件后：
   - 调用 `sendWSCommand()` 将命令转发给所有WS连接的外部客户端
   - 显示Toast通知提示用户操作来源
5. 前端Jotai atoms更新，UI重新渲染反映最新状态

**步骤4: 外部WS客户端连接（如另一个播放器软件）**
1. 外部客户端建立TCP连接到配置的WS端口（默认11444）
2. 发送首条消息进行协议协商：
   - 发送JSON文本 → 识别为HybridV2协议
   - 发送二进制数据 → 识别为BinaryV1协议
3. 协商成功后，连接被注册到连接池
4. 后续消息根据协议类型分别处理：
   - V1: 二进制解析 → 转换为v2::Payload → 通过Channel发送到前端
   - V2: JSON/Binary解析 → 提取Payload → 通过Channel发送到前端
5. 前端的状态变更会通过 `broadcast_payload()` 广播给所有连接的客户端

---

### 1.4 依赖说明

#### 1.4.1 外部依赖库

**Rust 后端依赖**:

| 库名 | 版本(Cargo.toml) | 用途 | 在本功能中的使用场景 |
|------|------------------|------|---------------------|
| `axum` | 最新稳定版 | Web框架 | 构建HTTP REST API和路由 |
| `tokio` | 最新稳定版 | 异步运行时 | 异步TCP监听、任务生成 |
| `tokio-tungstenite` | 最新稳定版 | WebSocket库 | WS连接管理和消息收发 |
| `tower-http` | 最新稳定版 | HTTP中间件 | CORS处理、静态文件服务 |
| `serde` / `serde_json` | 最新稳定版 | 序列化/反序列化 | JSON请求/响应处理 |
| `tracing` | 最新稳定版 | 日志框架 | 结构化日志输出 |
| `reqwest` | 最新稳定版 | HTTP客户端 | URL扩展解析功能 |
| `futures` | 最新稳定版 | 异步工具 | Stream分割(SplitSink/SplitStream) |
| `tauri` | ^2.x | 桌面应用框架 | IPC事件系统、Window管理 |
| `ws_protocol` | 内部包 | WS协议定义 | V1/V2协议的数据结构 |

**TypeScript 前端依赖**:

| 库名 | 版本(package.json) | 用途 | 在本功能中的使用场景 |
|------|-------------------|------|---------------------|
| `@tauri-apps/api` | ^2.x | Tauri JS API | invoke、listen、getCurrentWindow等 |
| `jotai` | ^2.x | 状态管理 | 全局原子状态(atomWithStorage) |
| `react` | ^18.x | UI框架 | 组件化和hooks |
| `react-i18next` | ^12.x | 国际化 | 多语言提示文案 |
| `react-toastify` | ^10.x | Toast通知 | 远程操作提示 |
| `@applemusic-like-lyrics/lyric` | 内部包 | 歌词解析 | TTML解析、贡献者提取 |
| `@applemusic-like-lyrics/fft` | 内部包 | FFT分析 | 音频频谱数据处理 |

#### 1.4.2 内部模块依赖关系

```
http_server.rs (HTTP层)
    ├── server.rs (WebSocket层)
    │       └── ws_protocol crate (协议定义)
    ├── player.rs (播放器控制)
    │       └── amll_player_core crate (音频引擎)
    └── lib.rs (Tauri入口)
            └── 注册命令和状态管理

WSProtocolMusicContext.tsx (React组件)
    ├── appAtoms.ts (状态定义)
    ├── ttml-contributor-search.ts (贡献者查询)
    ├── player.ts (音频线程通信)
    └── @applemusic-like-lyrics/react-full (UI原子)
```

#### 1.4.3 环境依赖及配置要求

**运行环境要求**:
- **操作系统**: Windows 10+, macOS 10.15+, Linux (桌面端)；Android/iOS (移动端受限)
- **网络**: 局域网连通性（同一网段或端口映射）
- **防火墙**: 需要允许入站连接到端口 13533 (HTTP) 和 11444 (WS)
- **浏览器**: 现代浏览器（Chrome 90+, Firefox 88+, Safari 14+, Edge 90+）

**Tauri配置** (`src-tauri/tauri.conf.json`):
```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "AMLL Player"
      }
    ]
  },
  "security": {
    "capabilities": ["desktop"]
  }
}
```

**编译要求**:
- Rust toolchain stable
- Node.js 18+
- Tauri CLI 2.x
- WebView2 (Windows) / WebKit (macOS) / webkit2gtk (Linux)

---

### 1.5 接口定义

#### 1.5.1 内部模块接口（Tauri Commands）

**从Frontend调用的Commands**:

```typescript
// ====== WebSocket 控制 ======

/**
 * 重新打开WebSocket服务器连接
 * @param addr - 监听地址 (如 "localhost:11444")
 * @param channel - Tauri IPC通道（用于接收消息）
 */
invoke("ws_reopen_connection", {
  addr: string,
  channel: Channel<v2.Payload>
}): Promise<void>

/**
 * 关闭WebSocket服务器及所有连接
 */
invoke("ws_close_connection"): Promise<void>

/**
 * 获取当前已连接的客户端地址列表
 * @returns SocketAddr数组
 */
invoke("ws_get_connections"): Promise<string[]>

/**
 * 向所有已连接的WS客户端广播消息
 * @param payload - 要广播的消息载荷
 */
invoke("ws_broadcast_payload", {
  payload: v2.Payload
}): Promise<void>


// ====== HTTP 服务器控制 ======

/**
 * 启用或禁用HTTP服务器（13533端口）
 * @param enabled - 是否启用
 */
invoke("set_http_server_enabled", {
  enabled: boolean
}): Promise<void>


// ====== 窗口控制 ======

/**
 * 设置窗口始终置顶（仅Windows桌面端）
 * @param enabled - 是否置顶
 */
invoke("set_window_always_on_top", {
  enabled: boolean
}): Promise<void>


// ====== 状态更新 ======

/**
 * 更新远程now-playing信息（供前端定期调用）
 * @param info - 当前播放信息
 */
invoke("update_remote_now_playing", {
  title: string,
  artist: string,
  album: string,
  is_playing: boolean,
  cover?: string
}): Promise<void>
```

#### 1.5.2 外部系统交互接口（HTTP REST API）

**基础URL**: `http://<host>:13533/api`

| 方法 | 端点 | Content-Type | 请求体 | 响应码 | 说明 |
|------|------|--------------|--------|--------|------|
| GET | `/player/now-playing` | - | - | 200(JSON)/204 | 获取当前播放信息 |
| POST | `/player/play` | - | - | 200/500 | 播放/恢复 |
| POST | `/player/pause` | - | - | 200/500 | 暂停 |
| POST | `/player/next` | - | - | 200/500 | 下一首 |
| POST | `/player/prev` | - | - | 200/500 | 上一首 |
| POST | `/player/command` | application/json | `RemoteCommand` | 200/500 | 通用命令 |
| POST | `/player/fullscreen` | - | - | 200/404/501 | 全屏切换 |
| POST | `/player/always-on-top` | application/json | `{enabled:bool}` | 200/404/501 | 置顶切换 |
| POST | `/player/song/:id` | - | - | 200/500 | 通过ID点歌 |
| POST | `/ws/listen-addr` | application/json | `{addr:string}` | 200 | 设置WS地址 |
| GET | `/player/expand-url?url=<url>` | - | - | 200/400/502 | URL重定向解析 |
| GET | `/player/events` | - | - | 101(WS升级) | WebSocket事件流 |

**详细API规范**:

**1. GET /api/player/now-playing**

响应示例 (200 OK):
```json
{
  "title": "歌曲名称",
  "artist": "歌手名",
  "album": "专辑名",
  "isPlaying": true,
  "alwaysOnTop": false,
  "cover": "https://example.com/cover.jpg"
}
```
无内容时返回 204 No Content。

**2. POST /api/player/command**

请求体 (application/json):
```json
{
  "command": "setVolume",
  "volume": 0.75
}
```

支持的command值:
- `"pause"` - 暂停
- `"resume"` - 恢复播放
- `"forwardSong"` - 下一首
- `"backwardSong"` - 上一首
- `"setVolume"` - 设置音量 (附加字段: `volume: 0.0-1.0`)
- `"seekPlayProgress"` - 跳转进度 (附加字段: `progress: 0.0+`)
- `"setFontSize"` - 设置字体大小 (附加字段: `size: string`)
- `"toggleTranslation"` - 切换翻译显示 (附加字段: `enabled: boolean`)

**3. POST /api/player/song/:id**

路径参数:
- `id`: 歌曲ID字符串（如网易云音乐的ID）

行为:
- 发送 `PlaySongEvent` 到broadcast channel
- 触发 `remote-play-song` Tauri事件
- 前端监听该事件后执行实际的搜索和播放逻辑

**4. GET /api/player/events (WebSocket Upgrade)**

此端点将HTTP连接升级为WebSocket连接，用于实时推送点歌事件。

WebSocket消息格式:
```json
{
  "id": "123456",
  "source": "ncm"
}
```

#### 1.5.3 WebSocket协议接口

**V2 协议 (HybridV2 - 推荐)**

连接初始化:
```json
{
  "type": "initialize"
}
```

消息类型 (客户端→服务器):

| type | value结构 | 说明 |
|------|-----------|------|
| `"initialize"` | 无 | 握手初始化 |
| `"command"` | `WSCommand` | 发送控制命令 |
| `"ping"` | 无 | 心跳检测 |

消息类型 (服务器→客户端):

| type | value结构 | 说明 |
|------|-----------|------|
| `"state"` | `WSStateUpdate` | 状态更新推送 |
| `"pong"` | 无 | 心跳响应 |

**V1 协议 (BinaryV1 - 兼容旧版)**

使用自定义二进制格式，详见 `ws_protocol` crate 的v1模块定义。
通常由旧的第三方客户端使用，不推荐新实现采用。

#### 1.5.4 数据持久化方案

**localStorage 键值表**:

| 键名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `amll-player.enableHttpServer` | boolean | `true` | HTTP服务器开关 |
| `amll-player.wsProtocolListenAddr` | string | `"localhost:11444"` | WS监听地址 |
| `amll-player.enableAlwaysOnTop` | boolean | `false` | 窗口置顶开关 |
| `amll-player.musicContextMode` | string | `"local"` | 音乐源模式 |
| `amll-react-full.contributorSource` | string | `"mirror"` | 贡献者查询源 |

**注意**: 所有持久化均通过 Jotai 的 `atomWithStorage` 自动同步到 localStorage，无需手动管理。

---

### 1.6 业务规则

#### 1.6.1 功能触发条件

| 条件 | 触发方式 | 结果 |
|------|----------|------|
| 启用HTTP服务 | 用户在设置页开启开关 | HTTP Server在13533端口启动 |
| 禁用HTTP服务 | 用户在设置页关闭开关 | HTTP Server优雅关闭 |
| 启用WS协议 | 用户配置监听地址且切换到WS模式 | WS Server在指定端口启动 |
| 远程控制操作 | 外部客户端发送HTTP POST或WS消息 | 命令执行 + Toast通知 + 状态同步 |
| 点歌请求 | POST /api/player/song/:id | 触发前端搜索播放逻辑 |

#### 1.6.2 业务逻辑判断规则

1. **协议自动识别**: WS服务器根据首条消息自动判断协议版本
   - Text消息且能解析为V2 Initialize → HybridV2
   - Binary消息 → BinaryV1
   - 其他 → 断开连接

2. **音量边界保护**: 收到的音量值会被clamp到[0.0, 1.0]范围
   ```rust
   let v = volume.clamp(0.0, 1.0);
   ```

3. **进度非负保护**: 进度值必须 >= 0
   ```rust
   let position = progress.max(0.0);
   ```

4. **移动端限制**: Android/iOS不支持全屏和置顶API
   - 返回 `501 Not Implemented`
   - 通过 `#[cfg]` 条件编译实现

5. **CORS策略**: 使用 `permissive()` 允许所有跨域请求
   - 因为控制页面可能从任意端口访问

#### 1.6.3 异常情况处理策略

| 异常场景 | 处理方式 | 日志级别 |
|----------|----------|----------|
| HTTP端口被占用 | 记录错误日志，不崩溃 | error |
| WS握手失败 | 返回Error，断开连接 | warn |
| 消息解析失败 | 记录错误，断开该客户端连接 | error |
| 客户端发送非法首条消息 | 警告并主动断开 | warn |
| 消息发送失败（客户端已断开） | 从连接池移除该客户端 | warn |
| 前端dist目录未找到 | 不启动HTTP服务，记录警告 | warn |
| Tauri事件发送失败 | 记录错误，不影响主流程 | error |
| FFmpeg初始化失败 | panic（致命错误） | - |

**优雅关闭机制**:
```rust
// 使用 oneshot channel 实现优雅关闭
let (shutdown_tx, shutdown_rx) = oneshot::channel();

// HTTP Server支持 graceful shutdown
axum::serve(listener, router).with_graceful_shutdown(async {
    let _ = shutdown_rx.await;  // 等待关闭信号
});
```

#### 1.6.4 边界条件说明

1. **最大连接数**: 未硬编码限制，受操作系统文件描述符限制（默认HashMap初始容量8）
2. **Broadcast channel容量**: 64个事件（点歌事件），满时最旧的事件会被丢弃（Lagged）
3. **超时设置**: 贡献者查询HTTP请求5秒超时
4. **并发安全**: 所有共享状态使用 `Arc<RwLock<T>>` 或 `Arc<TokioRwLock<T>>` 保护
5. **内存管理**: 断开的连接会立即从连接池清理，避免内存泄漏

---

## 2. 窗口置顶功能

### 2.1 功能概述

#### 2.1.1 业务价值

窗口置顶（Always On Top）功能允许将AMLL播放器窗口设置为始终显示在其他窗口之上，这对于以下场景至关重要：

- **歌词展示模式**: 用户希望歌词窗口始终可见，不被其他应用遮挡
- **演示/直播**: 在OBS或其他录屏软件中，确保播放器画面不被覆盖
- **多任务处理**: 一边工作一边看歌词，不需要频繁切换窗口
- **KTV模式**: 模拟KTV效果，歌词永远在最上层

#### 2.1.2 功能边界与模块交互关系

```
┌─────────────────────────────────────────────┐
│           窗口置顶功能架构                    │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────┐    invoke()    ┌─────────┐ │
│  │  设置页面    │ ──────────────►│ lib.rs  │ │
│  │ (Switch)    │               │ (Tauri) │ │
│  └─────────────┘               └────┬────┘ │
│                                      │      │
│  ┌─────────────┐    invoke()        │      │
│  │  右键菜单    │ ──────────────────┤      │
│  │ (Checkbox)  │                   │      │
│  └─────────────┘                   ▼      │
│                             ┌────────────┐ │
│                             │ set_window_ │ │
│                             │ always_on_  │ │
│                             │ top()       │ │
│                             └─────┬──────┘ │
│                                   │        │
│  ┌─────────────┐   Window API    │        │
│  │ useInit-    │ ◄───────────────┘        │
│  │ alizeWin-   │  (Windows only)          │
│  │ dow.ts      │                          │
│  └──────┬──────┘                          │
│         │                                  │
│         ▼                                  │
│  ┌─────────────┐                          │
│  │ localStorage │  持久化存储              │
│  │ (.enableAl- │  enableAlwaysOnTop       │
│  │ waysOnTop)  │                          │
│  └─────────────┘                          │
│                                             │
└─────────────────────────────────────────────┘
```

**交互的系统模块**:
- **Tauri Window API**: `window.set_always_on_top(bool)`
- **本地存储**: localStorage键 `amll-player.enableAlwaysOnTop`
- **Jotai状态**: `enableAlwaysOnTopAtom` (读写原子)
- **远程控制**: HTTP API `/api/player/always-on-top` (可远程切换)

---

### 2.2 技术实现细节

#### 2.2.1 核心算法和数据流程

**置顶状态同步流程**:

```
用户操作（设置页/右键菜单/远程API）
           │
           ▼
┌──────────────────────┐
│ 更新 Jotai Atom       │
│ enableAlwaysOnTopAtom │
│ (触发重新渲染)        │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 写入 localStorage     │
│ (atomWithStorage自动) │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ invoke Tauri Command │
│ "set_window_always_  │
│  _on_top"            │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Rust后端执行         │
│ window.set_always_   │
│ on_top(enabled)      │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ 操作系统更新窗口Z序  │
│ (Windows: HWND_TOPMOST)│
└──────────────────────┘
```

#### 2.2.2 关键数据结构定义

**Rust端**:

```rust
// lib.rs
#[tauri::command]
fn set_window_always_on_top<R: Runtime>(
    enabled: bool,
    app: AppHandle<R>,
) -> Result<(), String> {
    // 移动端不支持此功能
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (enabled, app);
        return Err("Unsupported on mobile.".to_string());
    }

    // 桌面端实现
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Some(window) = app.get_webview_window("main") {
            window.set_always_on_top(enabled)
                .map_err(|e| e.to_string())
        } else {
            Err("Main window not found.".to_string())
        }
    }
}
```

**TypeScript端**:

```typescript
// states/appAtoms.ts
const enableAlwaysOnTopInternalAtom = atomWithStorage(
  "amll-player.enableAlwaysOnTop",  // localStorage键名
  false,                            // 默认值：不置顶
);

// 带副作用的可写原子（调用Tauri命令）
export const enableAlwaysOnTopAtom = atom(
  (get) => get(enableAlwaysOnTopInternalAtom),  // 读取
  (_get, set, enabled: boolean) => {              // 写入
    set(enableAlwaysOnTopInternalAtom, enabled);  // 1. 更新内存状态（自动持久化）
    invoke("set_window_always_on_top", { enabled })  // 2. 调用原生API
      .catch((err) => console.error("设置窗口置顶状态失败", err));
  },
);
```

#### 2.2.3 状态管理方案

采用 **Jotai atomWithStorage + Tauri invoke 双写模式**:

1. **atomWithStorage** 自动同步到 localStorage，保证页面刷新后状态保留
2. **atom 的 write function** 在写入时同时调用 Tauri invoke，确保原生窗口属性同步
3. **初始化恢复**: `useInitializeWindow` hook 在应用启动时读取 localStorage 并调用 invoke 恢复状态

#### 2.2.4 事件处理机制

**本地操作触发链**:
1. 用户点击设置页面的 Switch 组件
2. Switch 的 `onCheckedChange` 回调触发 `setAlwaysOnTop(newValue)`
3. `enableAlwaysOnTopAtom` 的 write function 执行：
   - 更新内部atom（触发localStorage写入）
   - 调用 `invoke("set_window_always_on_top")`
4. Rust端获取main window并调用 `set_always_on_top()`

**远程操作触发链**:
1. 外部客户端 POST `/api/player/always-on-top` `{enabled: true}`
2. `api_always_on_top()` 函数执行：
   - 调用 `win.set_always_on_top(true)`
   - 发出 `remote-always-on-top` Tauri事件
3. 前端（如果正在监听）可响应该事件更新UI状态

---

### 2.3 代码实现指南

#### 2.3.1 核心模块/类的设计

**涉及的关键文件**:

| 文件 | 行数 | 职责 |
|------|------|------|
| `src-tauri/src/lib.rs` | L128-L147 | Tauri命令定义 |
| `src-tauri/src/http_server.rs` | L304-L331 | HTTP API端点 |
| `src/states/appAtoms.ts` | L92-L108 | Jotai状态定义 |
| `src/utils/useInitializeWindow.ts` | 43行 | 启动初始化Hook |
| `src/components/AMLLContextMenu/index.tsx` | L59-L65 | 右键菜单集成 |
| `src/pages/settings/player.tsx` | L451-L457 | 设置页面UI |

#### 2.3.2 关键函数实现详解

##### **Tauri命令实现 (`lib.rs`)**

```rust
// 完整实现 - src-tauri/src/lib.rs (行128-147)
#[tauri::command]
fn set_window_always_on_top<R: Runtime>(
    enabled: bool,
    app: AppHandle<R>,
) -> Result<(), String> {
    // 平台兼容性检查：移动端不支持窗口置顶
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (enabled, app);
        return Err("Unsupported on mobile.".to_string());
    }

    // 桌面端实现
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // 获取主窗口（label为"main"）
        if let Some(window) = app.get_webview_window("main") {
            // 调用Tauri Window API设置置顶
            window.set_always_on_top(enabled)
                .map_err(|e| e.to_string())
        } else {
            Err("Main window not found.".to_string())
        }
    }
}
```

**关键点**:
- 使用 `#[cfg]` 条件编译区分平台
- 通过 `get_webview_window("main")` 获取窗口实例
- `set_always_on_top()` 是Tauri封装的原生API

##### **Jotai Atom定义 (`appAtoms.ts`)**

```typescript
// 完整实现 - src/states/appAtoms.ts (行92-108)

// 1. 内部存储原子（纯持久化，无副作用）
const enableAlwaysOnTopInternalAtom = atomWithStorage(
  "amll-player.enableAlwaysOnTop",  // localStorage key
  false,                             // default value
);

// 2. 公开原子（带副作用的读写包装）
export const enableAlwaysOnTopAtom = atom(
  // 读函数：直接返回内部原子的值
  (get) => get(enableAlwaysOnTopInternalAtom),

  // 写函数：同时更新状态和调用原生API
  (_get, set, enabled: boolean) => {
    // Step 1: 更新内部原子（atomWithStorage会自动写入localStorage）
    set(enableAlwaysOnTopInternalAtom, enabled);

    // Step 2: 调用Tauri命令更新原生窗口属性
    invoke("set_window_always_on_top", { enabled }).catch((err) => {
      console.error("设置窗口置顶状态失败", err);
    });
  },
);
```

**设计模式**: 这是典型的 **Derived Atom with Side Effect** 模式，将业务逻辑（调用原生API）封装在atom的write函数中，确保任何地方修改状态都会触发同步操作。

##### **启动初始化Hook (`useInitializeWindow.ts`)**

```typescript
// 完整实现 - src/utils/useInitializeWindow.ts (43行)
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { platform, version } from "@tauri-apps/plugin-os";
import { useStore } from "jotai";
import { useEffect, useRef } from "react";
import semverGt from "semver/functions/gt";
import { hasBackgroundAtom } from "../states/appAtoms";

export const useInitializeWindow = () => {
  const store = useStore();
  const isInitializedRef = useRef(false);  // 防止重复初始化

  useEffect(() => {
    const initializeWindow = async () => {
      if (isInitializedRef.current) return;  // 幂等保护
      isInitializedRef.current = true;

      // 延迟50ms执行，确保DOM和Tauri API就绪
      setTimeout(async () => {
        try {
          const appWindow = getCurrentWindow();

          // Windows旧版本兼容性处理（去除窗口背景效果）
          if (platform() === "windows" && !semverGt(version(), "10.0.22000")) {
            store.set(hasBackgroundAtom, true);
            await appWindow.clearEffects();
          }

          // ★ 核心：从localStorage恢复置顶状态
          if (platform() === "windows") {
            const enabled = localStorage.getItem("amll-player.enableAlwaysOnTop") === "true";
            invoke("set_window_always_on_top", { enabled }).catch((err) => {
              console.error("同步窗口置顶状态失败", err);
            });
          }

          // 显示窗口
          await appWindow.show();
        } catch (err) {
          console.error("初始化窗口失败:", err);
        }
      }, 50);
    };

    initializeWindow();
  }, [store]);  // 依赖store（但实际只执行一次）
};
```

**为什么需要这个Hook?**
- 应用重启后，虽然 localStorage 保存了置顶状态，但原生窗口属性不会自动恢复
- 必须在应用启动时显式调用 `set_always_on_top()` 来同步
- 使用 `useRef` 确保只在组件首次挂载时执行一次

##### **右键菜单集成 (`AMLLContextMenu`)**

```typescript
// 完整实现 - src/components/AMLLContextMenu/index.tsx (行59-65)
<ContextMenu.CheckboxItem
  checked={alwaysOnTop}  // 绑定到atom值
  onCheckedChange={(e) => setAlwaysOnTop(!!e)}  // 点击时更新atom
>
  <Trans i18nKey="amll.contextMenu.windowAlwaysOnTop">
    窗口置顶
  </Trans>
</ContextMenu.CheckboxItem>
```

##### **设置页面UI (`settings/player.tsx`)**

```typescript
// 完整实现 - src/pages/settings/player.tsx (行451-457)
{os === "windows" && (
  <SwitchSettings
    label={t("page.settings.general.windowAlwaysOnTop.label", "启用窗口置顶")}
    description={t(
      "page.settings.general.windowAlwaysOnTop.description",
      "将应用窗口设置为始终置顶",
    )}
    configAtom={enableAlwaysOnTopAtom}  // 直接绑定到atom
  />
)}
```

**注意**: 仅在 Windows 平台显示此选项（`os === "windows"`），因为其他平台的置顶行为可能不同或通过系统设置管理。

##### **HTTP API端点 (`http_server.rs`)**

```rust
// 完整实现 - src-tauri/src/http_server.rs (行304-L331)
async fn api_always_on_top(
    State(state): State<HttpServerState>,
    Json(req): Json<AlwaysOnTopRequest>,
) -> StatusCode {
    // 移动端返回501
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (state, req);
        return StatusCode::NOT_IMPLEMENTED;
    }

    // 桌面端实现
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // 获取主窗口
        let Some(win) = state.app.get_webview_window("main") else {
            return StatusCode::NOT_FOUND;  // 404: 窗口不存在
        };

        // 设置置顶状态
        if win.set_always_on_top(req.enabled).is_ok() {
            // 成功：发出Tauri事件通知前端
            if let Err(err) = state.app.emit(
                "remote-always-on-top",
                RemoteToggleEvent { enabled: req.enabled }
            ) {
                error!("Failed to emit remote-always-on-top: {:?}", err);
            }
            StatusCode::OK  // 200: 成功
        } else {
            StatusCode::INTERNAL_SERVER_ERROR  // 500: API调用失败
        }
    }
}
```

#### 2.3.3 重要业务逻辑的实现步骤

**正常操作流程（用户在设置页切换）**:
1. 用户点击 Switch 组件
2. React调用 `setAlwaysOnTop(true/false)`
3. Jotai atom的write函数执行：
   - `set(enableAlwaysOnTopInternalAtom, value)` → 自动写入localStorage
   - `invoke("set_window_always_on_top", {enabled: value})` → 跨IPC调用Rust
4. Rust命令处理：
   - 平台检查（移动端直接返回错误）
   - 获取main window
   - 调用 `window.set_always_on_top(value)`
   - 操作系统更新窗口Z-order
5. 返回结果给前端（此处忽略返回值，错误仅console.error）

**应用启动恢复流程**:
1. `App.tsx` 渲染 → `useInitializeWindow` hook执行
2. `useEffect` 触发 → 延迟50ms后执行（等待Tauri API就绪）
3. 读取 `localStorage.getItem("amll-player.enableAlwaysOnTop")`
4. 调用 `invoke("set_window_always_on_top", {enabled: savedValue})`
5. 窗口置顶状态与上次关闭前一致

**远程控制流程**:
1. 外部客户端 POST `http://<ip>:13533/api/player/always-on-top`
   Body: `{"enabled": true}`
2. Axum路由到 `api_always_on_top()` handler
3. Handler直接调用 `win.set_always_on_top(true)` （绕过前端atom）
4. 发出 `remote-always-on-top` 事件（前端可选监听以同步UI）
5. 返回 200 OK

---

### 2.4 依赖说明

#### 2.4.1 外部依赖库

| 库名 | 用途 | 版本要求 |
|------|------|----------|
| `tauri` (Rust) | 窗口管理API | ^2.0 |
| `@tauri-apps/api` (TS) | invoke/getCurrentWindow | ^2.0 |
| `@tauri-apps/plugin-os` (TS) | platform()/version() | latest |
| `jotai` | 状态管理 | ^2.0 |
| `semver` | Windows版本比较 | ^7.0 |

#### 2.4.2 内部模块依赖

```
enableAlwaysOnTopAtom (states/appAtoms.ts)
    ├── atomWithStorage (jotai/utils)
    ├── invoke (@tauri-apps/api/core)
    └── set_window_always_on_top (lib.rs Tauri Command)

useInitializeWindow (utils/useInitializeWindow.ts)
    ├── getCurrentWindow (@tauri-apps/api/window)
    ├── invoke (@tauri-apps/api/core)
    ├── platform/version (@tauri-apps/plugin-os)
    ├── semverGt (semver)
    └── hasBackgroundAtom (states/appAtoms.ts)

AMLLContextMenu (components/AMLLContextMenu/)
    └── enableAlwaysOnTopAtom (states/appAtoms.ts)
```

#### 2.4.3 环境依赖

- **平台限制**: 主要面向 Windows 桌面端；macOS/Linux也支持但设置页隐藏选项；Android/iOS不支持
- **权限要求**: 无特殊权限（普通窗口操作）
- **Tauri capability**: 需要 `desktop.toml` capability（已在 `src-tauri/capabilities/` 中配置）

---

### 2.5 接口定义

#### 2.5.1 Tauri Command接口

```typescript
/**
 * 设置窗口置顶状态
 * @param enabled - true=置顶, false=取消置顶
 * @returns 成功时返回void，失败时返回错误字符串
 * @throws 移动端调用时抛出 "Unsupported on mobile."
 */
invoke("set_window_always_on_top", {
  enabled: boolean
}): Promise<Result<void, string>>
```

#### 2.5.2 HTTP REST API接口

**POST /api/player/always-on-top**

请求体:
```json
{
  "enabled": true
}
```

响应状态码:
- `200 OK`: 设置成功
- `404 Not Found`: 主窗口不存在（异常情况）
- `500 Internal Server Error`: 原生API调用失败
- `501 Not Implemented`: 移动端不支持

响应事件 (Tauri Event):
```typescript
// 前端可监听此事件以同步UI状态
listen("remote-always-on-top", (event: { payload: RemoteToggleEvent }) => {
  console.log("远程切换置顶:", event.payload.enabled);
});
```

#### 2.5.3 数据持久化格式

**localStorage**:

| 键名 | 类型 | 示例值 | 说明 |
|------|------|--------|------|
| `amll-player.enableAlwaysOnTop` | `"true"` / `"false"` | `"true"` | 窗口是否置顶 |

---

### 2.6 业务规则

#### 2.6.1 功能触发条件

| 触发方式 | 触发条件 | 执行结果 |
|----------|----------|----------|
| 设置页Switch | 用户勾选/取消"启用窗口置顶" | 立即生效 + localStorage持久化 |
| 右键菜单 | 用户点击"窗口置顶"复选框 | 同上 |
| 远程API | POST `/api/player/always-on-top` | 仅修改原生属性（不同步前端atom） |
| 应用启动 | `useInitializeWindow` hook执行 | 从localStorage恢复上次状态 |

#### 2.6.2 业务逻辑判断规则

1. **平台限制**: 仅桌面端（Windows/macOS/Linux）支持；移动端调用直接返回错误
   ```rust
   #[cfg(any(target_os = "android", target_os = "ios"))]
   return Err("Unsupported on mobile.");
   ```

2. **设置页可见性**: 仅当 `os === "windows"` 时显示置顶选项
   - 其他桌面平台虽支持API，但不在设置页暴露（可能通过系统设置管理）

3. **初始化时机**: 必须在Tauri API就绪后执行（延迟50ms）
   - 避免在WebView未完成初始化时调用原生API导致失败

4. **幂等性**: 重复设置相同值不会产生副作用
   - `set_always_on_top(true)` 多次调用结果相同

#### 2.6.3 异常情况处理策略

| 异常场景 | 处理方式 | 用户反馈 |
|----------|----------|----------|
| 主窗口未找到 | 返回错误字符串 "Main window not found." | console.error |
| 原生API调用失败 | 返回系统错误信息 | console.error |
| 移动端调用 | 返回 "Unsupported on mobile." | 前端不显示该选项 |
| localStorage读取失败 | 使用默认值false | 无感知 |
| invoke调用失败 | catch并打印错误 | console.error（不影响功能） |

#### 2.6.4 边界条件说明

1. **快速连续切换**: Jotai的batch更新机制确保不会产生中间状态闪烁
2. **多窗口场景**: 当前仅操作label为"main"的主窗口（单窗口应用）
3. **全屏模式下的置顶**: 置顶在全屏模式下仍然有效（Z-order最高）
4. **最小化时的置顶**: 最小化的窗口恢复后保持置顶状态

---

## 3. 歌词贡献者标签功能

### 3.1 功能概述

#### 3.1.1 业务价值

歌词贡献者标签功能用于显示**逐词时间轴歌词（TTML格式）的贡献者信息**，具体来说是在播放界面展示制作该逐词歌词的社区志愿者的GitHub用户名。该功能的业务价值包括：

- **社区激励**: 公开认可和感谢歌词贡献者的劳动成果，鼓励更多人参与
- **质量标识**: 用户可通过贡献者 reputation 判断歌词质量
- **溯源追踪**: 方便用户找到原始贡献者进行反馈或交流
- **版权透明**: 明确歌词来源和创作者，符合开源社区规范

#### 3.1.2 功能边界与模块交互关系

```
┌──────────────────────────────────────────────────┐
│           歌词贡献者标签功能架构                   │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─────────────┐                                │
│  │ TTML DB     │  https://amll-ttml-db.         │
│  │ (远程服务器) │  gbclstudio.cn/ncm-lyrics      │
│  └──────┬──────┘                                │
│         │ HTTP GET                              │
│         ▼                                       │
│  ┌──────────────────────┐                       │
│  │ ttml-contributor-    │ ← 核心查询模块        │
│  │ search.ts            │   (缓存+解析)         │
│  └──────┬───────────────┘                       │
│         │                                        │
│    ┌────┴────┬──────────┐                       │
│    ▼         ▼          ▼                       │
│ ┌────────┐ ┌────────┐ ┌──────────┐             │
│ │WSProto-│ │Local-  │ │Settings  │             │
│ │colMC   │ │Music-  │ │Page      │             │
│ │(接收端) │ │Ctx     │ │(配置源)  │             │
│ └────┬───┘ └────┬───┘ └────┬─────┘             │
│      │          │          │                    │
│      ▼          ▼          ▼                    │
│ ┌──────────────────────────────┐                │
│ │ lyricContributorAtom (Jotai)│ ← 全局状态     │
│ └──────────────┬───────────────┘                │
│                │                                │
│                ▼                                │
│         ┌──────────────┐                       │
│         │ UI 显示组件   │ ← 条件渲染           │
│         │ (LyricPlayer) │   showLyricContributor│
│         └──────────────┘                       │
│                                                  │
└──────────────────────────────────────────────────┘
```

**数据流向**:

1. **WS协议模式**: 外部客户端发送TTML歌词 → `WSProtocolMusicContext` 解析metadata → 提取贡献者 → 存入atom
2. **本地播放模式**: 歌曲ID变化 → `ttml-contributor-search.ts` 异步查询 → 解析TTML → 提取贡献者 → 存入atom
3. **手动导入**: 用户从TTML DB导入 → TTMLImportDialog 解析 → 提取贡献者 → 存入atom

---

### 3.2 技术实现细节

#### 3.2.1 核心算法和数据流程

##### **贡献者查询流程**

```typescript
// 伪代码 - ttml-contributor-search.ts
async function fetchLyricContributorByNCMId(ncmId: string): Promise<LyricMatchResult> {
  // 1. 参数校验
  if (!ncmId || typeof ncmId !== "string") {
    return { contributor: null, matchedFile: null };
  }

  // 2. 缓存检查（避免重复请求）
  if (contributorCache.has(ncmId)) {
    return {
      contributor: contributorCache.get(ncmId),
      matchedFile: `${ncmId}.ttml`,
    };
  }

  // 3. 构建请求URL（根据配置选择镜像源或本地源）
  const baseUrl = contributorSource === "local"
    ? LOCAL_TTML_BASE_URL       // http://localhost:3000/api/ncm-lyrics
    : TTML_DB_BASE_URL;        // https://amll-ttml-db.gbclstudio.cn/ncm-lyrics

  // 4. 发送HTTP GET请求（带5秒超时）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const ttmlText = await fetch(`${baseUrl}/${ncmId}.ttml`, {
    signal: controller.signal,
  }).then(res => res.ok ? res.text() : null);

  clearTimeout(timeoutId);

  // 5. 如果获取失败，缓存null并返回
  if (!ttmlText) {
    contributorCache.set(ncmId, null);
    return { contributor: null, matchedFile: null };
  }

  // 6. 解析TTML并提取贡献者
  return parseTtmlContributor(ttmlText, ncmId);
}
```

##### **TTML解析与贡献者提取算法**

```typescript
function parseTtmlContributor(ttmlText: string, ncmId: string): LyricMatchResult {
  // Step 1: 调用lyric包的parseTTML函数
  let ttmlResult;
  try {
    ttmlResult = parseTTML(ttmlText);
  } catch (parseError) {
    console.error("解析TTML失败:", parseError);
    contributorCache.set(ncmId, null);  // 缓存失败结果
    return { contributor: null, matchedFile: null };
  }

  // Step 2: 验证歌词行存在且包含单词级数据
  const lines = ttmlResult?.lines;
  if (!lines || !Array.isArray(lines)) {
    contributorCache.set(ncmId, null);
    return { contributor: null, matchedFile: null };
  }

  // Step 3: 检查是否有逐词歌词（而非仅有行级时间戳）
  const hasWordLyrics = lines.some(
    (line) => line && Array.isArray(line.words) && line.words.length > 0,
  );

  if (!hasWordLyrics) {
    contributorCache.set(ncmId, null);  // 非逐词歌词无贡献者标签
    return { contributor: null, matchedFile: null };
  }

  // Step 4: 从metadata数组中查找贡献者字段
  const metadata = ttmlResult?.metadata;
  let contributor: string | null = null;

  if (metadata && Array.isArray(metadata)) {
    // TTML metadata格式: [[key, value1, value2, ...], ...]
    const authorMeta = metadata.find(
      ([key]) => key === "ttmlAuthorGithubLogin",  // 关键字段名
    );
    contributor = authorMeta?.[1]?.[0] ?? null;  // 取第一个值
  }

  // Step 5: 缓存并返回结果
  contributorCache.set(ncmId, contributor);

  return {
    contributor,
    matchedFile: `${ncmId}.ttml`,  // 记录匹配的文件名
  };
}
```

**流程图**:

```
歌曲ID变更 (musicIdAtom)
        │
        ▼
┌───────────────────────┐
│ 检查 showLyricContributor │
│ Atom 是否启用？        │
└──────────┬────────────┘
           │ No → 跳过（不显示标签）
           │ Yes
           ▼
┌───────────────────────┐
│ 检查内存缓存           │
│ contributorCache       │
│ .has(ncmId)?           │
└──────────┬────────────┘
           │ Hit
           ▼
┌───────────────────────┐
│ 直接返回缓存的        │
│ contributor值         │
└──────────┬────────────┘
           │ Miss
           ▼
┌───────────────────────┐
│ 选择数据源：          │
│ - mirror (默认)       │
│ - local (需本地服务)   │
└──────────┬────────────┘
           ▼
┌───────────────────────┐
│ fetch GET              │
│ {base}/{id}.ttml      │
│ (AbortController 5s超时)│
└──────────┬────────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
  成功(200)    失败/超时
     │           │
     ▼           ▼
┌─────────┐ ┌─────────────┐
│parseTTML│ │缓存null值   │
│解析XML  │ │返回null     │
└────┬────┘ └─────────────┘
     │
     ▼
┌───────────────────────┐
│ 验证有words数组？      │
└──────────┬────────────┘
           │ No          │ Yes
           ▼            ▼
    ┌──────────┐  ┌──────────────┐
    │缓存null  │  │提取metadata  │
    │返回null  │  │中ttmlAuthor- │
    └──────────┘  │GithubLogin   │
                  └──────┬───────┘
                         │
                         ▼
                  ┌──────────────┐
                  │缓存contributor│
                  │写入atom      │
                  │UI渲染GitHub   │
                  │@username链接 │
                  └──────────────┘
```

#### 3.2.2 关键数据结构定义

```typescript
// ====== ttml-contributor-search.ts ======

/**
 * 查询结果接口
 */
export interface LyricMatchResult {
  contributor: string | null;   // GitHub用户名（如 "user123"）或 null
  matchedFile: string | null;   // 匹配到的TTML文件名（如 "123456.ttml"）或 null
}

/**
 * 数据源模式
 */
export type ContributorSourceMode = "mirror" | "local";
// - "mirror": 使用公共镜像服务器（推荐，响应快）
// - "local": 使用本地缓存服务（需自行部署 Lyric-Atlas-API）

// ====== 常量配置 ======
const TTML_DB_BASE_URL = "https://amll-ttml-db.gbclstudio.cn/ncm-lyrics";
const LOCAL_TTML_BASE_URL = "http://localhost:3000/api/ncm-lyrics";
const CONTRIBUTOR_SOURCE_STORAGE_KEY = "amll-react-full.contributorSource";

// ====== 内存缓存 ======
const contributorCache = new Map<string, string | null>();
// Key: ncmId (网易云音乐歌曲ID)
// Value: GitHub用户名 或 null（表示已查询但无结果）
```

**TTML Metadata 格式示例**:

```xml
<!-- TTML文件中的metadata部分 -->
<ttml>
  <head>
    <metadata>
      <!-- 其他metadata... -->
      <ttmlAuthorGithubLogin>contributor-username</ttmlAuthorGithubLogin>
      <!-- 可能还有其他作者相关字段 -->
    </metadata>
  </head>
  <body>
    <!-- 歌词内容... -->
    <div>
      <p begin="00:00.000" end="00:05.000">
        <span begin="00:00.000" end="00:00.500">你</span>
        <span begin="00:00.500" end="00:01.000">好</span>
      </p>
    </div>
  </body>
</ttml>
```

**解析后的JavaScript结构** (由 `@applemusic-like-lyrics/lyric` 的 `parseTTML` 返回):

```typescript
{
  lines: [
    {
      startTime: 0,
      endTime: 5000,
      words: [
        { startTime: 0, endTime: 500, word: "你", romanWord: "" },
        { startTime: 500, endTime: 1000, word: "好", romanWord: "" },
      ],
      isBG: false,
      isDuet: false,
      translatedLyric: "",
      romanLyric: "",
    }
  ],
  metadata: [
    ["musicName", "歌曲名"],
    ["artists", "歌手"],
    ["ttmlAuthorGithubLogin", "contributor-username"],  // ← 目标字段
    // ... 更多metadata
  ]
}
```

#### 3.2.3 状态管理方案

**Jotai Atoms**:

```typescript
// @applemusic-like-lyrics/react-full 包中定义

/**
 * 贡献者的GitHub用户名
 * 类型: atom<string | null>
 * 默认值: null
 * 用途: 在歌词界面显示 "@username" 标签
 */
export const lyricContributorAtom: PrimitiveAtom<string | null>;

/**
 * 是否显示贡献者标签（用户设置）
 * 类型: atom<boolean> (atomWithStorage)
 * localStorage键: (内部管理)
 * 默认值: false
 * 用途: 控制UI是否渲染贡献者信息
 */
export const showLyricContributorAtom: Atom<boolean>;

/**
 * 贡献者数据源选择
 * 类型: atom<ContributorSourceMode> (atomWithStorage)
 * localStorage键: "amll-react-full.contributorSource"
 * 默认值: "mirror"
 * 用途: 选择从哪里获取TTML文件
 */
export const contributorSourceAtom: Atom<"mirror" | "local">;
```

**缓存策略**:

- **内存缓存**: 使用 `Map<string, string | null>` 在应用生命周期内缓存查询结果
  - 避免重复网络请求
  - 缓存命中时立即返回
  - 可通过 `invalidateContributorCache()` 手动清空

- **持久化**: 不持久化缓存到磁盘（每次重启重新查询）
  - 原因：TTML DB可能更新，需要获取最新贡献者信息

#### 3.2.4 事件处理机制

**触发贡献者查询的事件**:

| 事件来源 | 触发时机 | 处理位置 |
|----------|----------|----------|
| 本地歌曲切换 | `musicIdAtom` 变化 | `WSProtocolMusicContext` 或 `LocalMusicContext` |
| WS协议接收 | 收到 `setMusic` 状态更新 | `WSProtocolMusicContext.handleStateUpdate()` |
| TTML手动导入 | 用户从DB选择歌词 | `TTMLImportDialog.onSelectedLyric()` |
| 数据源切换 | 用户更改设置 | 自动触发 `setContributorSource()` 清空缓存 |

**查询后的副作用**:

1. 写入 `lyricContributorAtom` → UI自动更新显示
2. 如果贡献者为null且歌词有逐词数据 → 不显示标签（静默处理）
3. 如果贡献者非null且 `showLyricContributorAtom` 为true → 显示GitHub链接样式标签

---

### 3.3 代码实现指南

#### 3.3.1 核心模块/类的结构设计

**主要文件清单**:

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/utils/ttml-contributor-search.ts` | 169行 | **核心模块**：查询、解析、缓存 |
| `src/components/WSProtocolMusicContext/index.tsx` | L461-L512 | WS模式下的贡献者提取 |
| `src/components/LocalMusicContext/index.tsx` | - | 本地模式下的贡献者查询 |
| `src/components/TTMLImportDialog/index.tsx` | 200行 | 导入对话框中的贡献者显示 |
| `src/pages/settings/player.tsx` | L509-L577 | 设置页面（开关+数据源选择） |

**核心模块结构 (`ttml-contributor-search.ts`)**:

```
ttml-contributor-search.ts
├── 接口/类型定义
│   ├── LyricMatchResult
│   └── ContributorSourceMode
├── 配置常量
│   ├── TTML_DB_BASE_URL
│   ├── LOCAL_TTML_BASE_URL
│   └── CONTRIBUTOR_SOURCE_STORAGE_KEY
├── 状态变量
│   ├── contributorSource (module-level variable)
│   └── contributorCache (Map cache)
├── 内部函数
│   ├── getInitialContributorSource()
│   ├── setContributorSource()
│   └── fetchTtmlFromUrl()
│   └── parseTtmlContributor()
├── 导出函数（公开API）
│   ├── fetchLyricContributorByNCMId()  ← ★ 主要查询入口
│   ├── findLyricContributor()          ← 按歌名+歌手查（预留）
│   ├── findLyricContributorBySong()    ← 按歌曲对象查（预留）
│   └── invalidateContributorCache()    ← 清空缓存
```

#### 3.3.2 关键函数实现详解

##### **主查询函数 `fetchLyricContributorByNCMId()`**

```typescript
// 完整实现 - src/utils/ttml-contributor-search.ts (行82-134)
export async function fetchLyricContributorByNCMId(
  ncmId: string,
): Promise<LyricMatchResult> {
  // 1. 输入验证
  if (!ncmId || typeof ncmId !== "string") {
    return { contributor: null, matchedFile: null };
  }

  // 2. 缓存命中检查
  if (contributorCache.has(ncmId)) {
    return {
      contributor: contributorCache.get(ncmId) ?? null,
      matchedFile: `${ncmId}.ttml`,
    };
  }

  // 3. 发起异步HTTP请求（带超时控制）
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);  // 5秒超时

    // 根据当前配置选择URL前缀
    const baseUrl =
      contributorSource === "local"
        ? LOCAL_TTML_BASE_URL    // http://localhost:3000/api/ncm-lyrics
        : TTML_DB_BASE_URL;     // https://amll-ttml-db.gbclstudio.cn/ncm-lyrics

    const ttmlText = await fetchTtmlFromUrl(
      `${baseUrl}/${ncmId}.ttml`,  // 完整URL: {base}/{ncmId}.ttml
      controller.signal,
    );

    clearTimeout(timeoutId);  // 清理定时器

    // 4. 处理获取结果
    if (!ttmlText) {
      contributorCache.set(ncmId, null);  // 缓存空结果
      return { contributor: null, matchedFile: null };
    }

    // 5. 解析TTML并提取贡献者
    return parseTtmlContributor(ttmlText, ncmId);

  } catch (error) {
    // 6. 错误处理
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("获取歌词贡献者超时:", ncmId);
    } else {
      console.error("获取歌词贡献者时出错:", error);
    }
    contributorCache.set(ncmId, null);  // 缓存失败结果
    return { contributor: null, matchedFile: null };
  }
}
```

**关键设计点**:
- **AbortController**: 支持请求取消和超时控制
- **两级缓存**: 内存Map缓存 + null值也缓存（防止重复查询不存在的歌曲）
- **优雅降级**: 任何环节失败都返回 `{contributor: null}`，不影响主流程

##### **TTML解析函数 `parseTtmlContributor()`**

```typescript
// 完整实现 - src/utils/ttml-contributor-search.ts (行63-80)
function parseTtmlContributor(
  ttmlText: string,
  ncmId: string,
): LyricMatchResult {
  // 1. 调用外部包解析TTML
  let ttmlResult;
  try {
    ttmlResult = parseTTML(ttmlText);  // 来自 @applemusic-like-lyrics/lyric
  } catch (parseError) {
    console.error("解析TTML失败:", parseError);
    contributorCache.set(ncmId, null);
    return { contributor: null, matchedFile: null };
  }

  // 2. 验证歌词数据完整性
  const lines = ttmlResult?.lines;
  if (!lines || !Array.isArray(lines)) {
    contributorCache.set(ncmId, null);
    return { contributor: null, matchedFile: null };
  }

  // 3. 检查是否为逐词歌词（关键判断条件！）
  const hasWordLyrics = lines.some(
    (line) => line && Array.isArray(line.words) && line.words.length > 0,
  );

  if (!hasWordLyrics) {
    contributorCache.set(ncmId, null);
    return { contributor: null, matchedFile: null };
  }

  // 4. 从metadata提取贡献者GitHub用户名
  const metadata = ttmlResult?.metadata;
  let contributor: string | null = null;

  if (metadata && Array.isArray(metadata)) {
    const authorMeta = metadata.find(
      ([key]) => key === "ttmlAuthorGithubLogin",  // ★ 关键字段名
    );
    contributor = authorMeta?.[1]?.[0] ?? null;  // metadata[value][0]
  }

  // 5. 缓存并返回
  contributorCache.set(ncmId, contributor);

  return {
    contributor,
    matchedFile: `${ncmId}.ttml`,
  };
}
```

**为什么必须检查 `hasWordLyrics`?**
- 只有逐词级别的时间轴歌词（每个字都有独立时间戳）才是社区志愿者制作的
- 普通的LRC行级歌词通常来自官方或自动化工具，没有"贡献者"概念
- 这个区分保证了标签显示的准确性

##### **WS协议中的贡献者提取逻辑**

```typescript
// 完整实现 - WSProtocolMusicContext/index.tsx (行461-512)
case "setLyric": {
  let contributor: string | null = null;

  if (state.format === "structured") {
    // 结构化歌词：直接使用lines
    lines = state.lines;
  } else {
    // TTML原始文本：需要解析
    try {
      const ttmlResult = parseTTML(state.data);
      lines = ttmlResult.lines;

      // ★ 从解析结果中提取贡献者
      const authorMeta = ttmlResult.metadata?.find(
        ([key]) => key === "ttmlAuthorGithubLogin",
      );
      contributor = authorMeta?.[1]?.[0] ?? null;

    } catch (e) {
      console.error(e);
      toast.error(t("ws-protocol.toast.ttmlParseError",
        "解析来自 WS 发送端的 TTML 歌词时出错：{{error}}",
        { error: String(e) },
      ));
      return;  // 解析失败则终止处理
    }
  }

  // 处理歌词数据（移除敏感标记等）
  const processed = lines.map((line) => ({
    ...line,
    words: line.words.map((word) => ({ ...word, obscene: false })),
  }));

  store.set(hideLyricViewAtom, processed.length === 0);
  store.set(musicLyricLinesAtom, processed);

  // ★ 条件性地设置贡献者原子
  const hasWordLyrics = processed.some(
    (line) => line.words && line.words.length > 0,
  );
  if (contributor && hasWordLyrics) {
    store.set(lyricContributorAtom, contributor);  // 仅在有逐词歌词时显示
  }
  break;
}
```

##### **设置页面集成代码**

```typescript
// 完整实现 - src/pages/settings/player.tsx (行509-577)
const LyricContentSettings = () => {
  const { t } = useTranslation();
  const [contributorSource, setContributorSource] = useAtom(contributorSourceAtom);

  // 当数据源改变时，同步到查询模块
  useEffect(() => {
    setContributorSourceMode(contributorSource as ContributorSourceMode);
  }, [contributorSource]);

  const contributorSourceMenu = useMemo(
    () => [
      {
        label: t("page.settings.lyricContent.contributorSource.menu.mirror",
          "镜像源（By @GBCLStudio）"),
        value: Contributor.Mirror,  // "mirror"
      },
      {
        label: t("page.settings.lyricContent.contributorSource.menu.local",
          "本地源（缓存服务-需手动下载服务）"),
        value: Contributor.Local,   // "local"
      },
    ],
    [t],
  );

  return (
    <>
      {/* ... 其他歌词设置 ... */}

      {/* ★ 贡献者显示开关 */}
      <SwitchSettings
        label={t("page.settings.lyricContent.showLyricContributor.label",
          "显示逐词创作者")}
        description={t("page.settings.lyricContent.showLyricContributor.description",
          "在歌词播放界面显示逐词创作者的 GitHub 用户名")}
        configAtom={showLyricContributorAtom}
      />

      {/* ★ 数据源选择 */}
      <SettingEntry
        label={t("page.settings.lyricContent.contributorSource.label",
          "贡献者查询方式")}
        description={
          <>
            {t("page.settings.lyricContent.contributorSource.description.part1",
              "使用镜像源在歌词响应更快，减少闪烁情况，如需使用本地源请前往")}
            <a href="#" onClick={(e) => {
              e.preventDefault();
              open("https://github.com/Shomi-FJS/Lyric-Atlas-API");
            }}>
              https://github.com/Shomi-FJS/Lyric-Atlas-API
            </a>
            {t("page.settings.lyricContent.contributorSource.description.part2",
              " 下载")}
          </>
        }
      >
        <Select.Root
          value={contributorSource}
          onValueChange={(value) =>
            setContributorSource(value as Contributor)
          }
        >
          <Select.Trigger />
          <Select.Content>
            {contributorSourceMenu.map((item) => (
              <Select.Item key={item.value} value={item.value}>
                {item.label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      </SettingEntry>
    </>
  );
};
```

#### 3.3.3 重要业务逻辑的实现步骤

**场景1: 本地播放模式下的贡献者查询**

1. 用户播放一首网易云音乐的歌曲
2. `musicIdAtom` 更新为新的歌曲ID（如 `"123456"`）
3. `LocalMusicContext` 组件检测到ID变化：
   - 检查 `showLyricContributorAtom` 是否为true（如果false则跳过）
   - 调用 `fetchLyricContributorByNCMId("123456")`
4. 查询模块执行：
   - 检查缓存 → miss
   - 构建URL: `https://amll-ttml-db.gbclstudio.cn/ncm-lyrics/123456.ttml`
   - 发起GET请求（5秒超时）
   - 接收TTML XML文本
   - 调用 `parseTTML()` 解析为JS对象
   - 验证有words数组
   - 提取metadata中的 `ttmlAuthorGithubLogin`
   - 结果: `{ contributor: "awesome-user", matchedFile: "123456.ttml" }`
   - 写入缓存Map
5. 返回给调用方
6. 调用方将 `"awesome-user"` 写入 `lyricContributorAtom`
7. React重新渲染，歌词区域底部显示 "@awesome-user" 链接

**场景2: WS协议模式下的贡献者提取**

1. 外部客户端发送包含TTML歌词的消息：
   ```json
   { "type": "state", "value": { "update": "setLyric", "format": "ttml", "data": "<?xml..." } }
   ```
2. `WSProtocolMusicContext.handleStateUpdate()` 处理：
   - 识别为 `setLyric` 且format为 `ttml`
   - 调用 `parseTTML(data)` 解析
   - 从metadata提取 `ttmlAuthorGithubLogin` → `"lyric-fan-2024"`
   - 同时处理歌词lines数据
3. 条件检查：歌词有逐词数据吗？
   - 是 → `store.set(lyricContributorAtom, "lyric-fan-2024")`
   - 否 → 不设置（保持之前的值或null）

**场景3: 用户切换数据源**

1. 用户在设置页面将数据源从"镜像"切换到"本地"
2. `setContributorSource("local")` 执行：
   - 更新 module-level 变量 `contributorSource = "local"`
   - 调用 `contributorCache.clear()` 清空所有缓存
3. 下次查询时使用新URL: `http://localhost:3000/api/ncm-lyrics/{id}.ttml`
4. 如果本地服务未运行，请求会失败并缓存null

---

### 3.4 依赖说明

#### 3.4.1 外部依赖库

| 库名 | 版本 | 用途 | 说明 |
|------|------|------|------|
| `@applemusic-like-lyrics/lyric` | 内部包 | TTML解析器 | 提供 `parseTTML()` 函数，解析XML为结构化对象 |
| `jotai` | ^2.x | 状态管理 | atomWithStorage用于持久化设置 |
| `react` | ^18.x | UI框架 | 用于设置页面组件 |
| `react-i18next` | ^12.x | 国际化 | 多语言设置文案 |

**外部服务依赖**:

| 服务 | URL | 用途 | 可用性 |
|------|-----|------|--------|
| AMLL TTML DB Mirror | `https://amll-ttml-db.gbclstudio.cn` | 公共TTML歌词数据库 | 公网可用，需联网 |
| Lyric-Atlas-API (可选) | `http://localhost:3000` | 本地TTML缓存服务 | 需自行部署 |

#### 3.4.2 内部模块依赖关系

```
ttml-contributor-search.ts (核心查询模块)
├── @applemusic-like-lyrics/lyric (parseTTML)
├── contributorSourceAtom (states from react-full)
└── (被以下模块调用)
    ├── WSProtocolMusicContext (WS模式)
    ├── LocalMusicContext (本地模式)
    └── SettingsPage (配置)

lyricContributorAtom (全局状态)
├── 被 LyricPlayer 组件读取（渲染标签）
├── 被 WSProtocolMusicContext 写入
└── 被 LocalMusicContext 写入
```

#### 3.4.3 环境依赖及配置要求

- **网络要求**: 使用镜像源时需要互联网连接访问TTML DB
- **本地源要求**: 如选local模式，需要在localhost:3000运行Lyric-Atlas-API服务
- **CORS**: TTML DB服务器需要允许跨域请求（已配置Access-Control-Allow-Origin: *）
- **超时配置**: HTTP请求5秒超时（可在代码中调整）

---

### 3.5 接口定义

#### 3.5.1 内部模块接口（TypeScript函数签名）

```typescript
/**
 * 通过网易云音乐ID查询歌词贡献者
 *
 * @param ncmId - 网易云音乐的歌曲ID（纯数字字符串）
 * @returns Promise<LyricMatchResult>
 *   - contributor: GitHub用户名字符串，若无则为null
 *   - matchedFile: 匹配到的TTML文件名，若无则为null
 *
 * @example
 * const result = await fetchLyricContributorByNCMId("123456");
 * if (result.contributor) {
 *   console.log(`贡献者: @${result.contributor}`);
 * }
 *
 * @throws 不会抛出异常，所有错误内部处理并返回{contributor: null}
 */
export async function fetchLyricContributorByNCMId(
  ncmId: string,
): Promise<LyricMatchResult>


/**
 * 切换贡献者查询的数据源
 *
 * @param source - "mirror"(公共镜像) 或 "local"(本地服务)
 * @sideeffect 会清空所有已缓存的查询结果
 *
 * @example
 * setContributorSource("local");  // 切换到本地模式，清空缓存
 */
export function setContributorSource(source: ContributorSourceMode): void


/**
 * 手动清空贡献者缓存
 *
 * @usecase 当怀疑数据过期时调用，强制下次查询重新请求网络
 *
 * @example
 * invalidateContributorCache();  // 下次查询会重新请求
 */
export function invalidateContributorCache(): void


/**
 * 通过歌曲名和艺术家名查询贡献者（预留接口，当前未实现）
 *
 * @note 未来可能支持模糊搜索
 * @returns 当前总是返回 {contributor: null, matchedFile: null}
 */
export async function findLyricContributor(
  _songName: string,
  _artistName: string,
): Promise<LyricMatchResult>


/**
 * 通过歌曲对象查询贡献者（预留接口，当前未实现）
 *
 * @note 未来可能与音乐数据库整合
 * @returns 当前总是返回 {contributor: null, matchedFile: null}
 */
export async function findLyricContributorBySong(
  _songName: string,
  _artists: string[],
): Promise<LyricMatchResult>
```

#### 3.5.2 外部系统交互接口（HTTP API）

**GET 请求格式**:

```
Method: GET
URL: {TTML_DB_BASE_URL}/{ncmId}.ttml
Headers: (无特殊要求)
Timeout: 5000ms
```

**成功响应 (200 OK)**:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ttml xmlns="http://www.w3.org/ns/ttml"
      xmlns:tts="http://www.w3.org/ns/tts#"
      xmlns:amll="https://github.com/AMLL/team">
  <head>
    <metadata>
      <musicName>歌曲名称</musicName>
      <artists>歌手名</artists>
      <!-- ★ 关键字段 -->
      <ttmlAuthorGithubLogin>contributor-github-username</ttmlAuthorGithubLogin>
    </metadata>
  </head>
  <body>
    <div>
      <p begin="00:00.000" end="00:05.000">
        <span begin="00:00.000" end="00:00.500">你</span>
        <span begin="00:00.500" end="00:01.000">好</span>
      </p>
    </div>
  </body>
</ttml>
```

**失败响应**:
- `404 Not Found`: 该歌曲ID没有对应的TTML文件（无逐词歌词）
- `5xx Server Error`: TTML DB服务器故障
- **超时**: 5秒内无响应 → AbortError → 返回null

#### 3.5.3 数据存储方案

**内存缓存 (Runtime)**:

```
Data Structure: Map<string, string | null>
Key: ncmId (e.g., "123456")
Value:
  - "github-username" (有贡献者)
  - null (已查询但无结果)

Lifecycle: 应用进程存活期间
Size Limit: 无硬编码限制（受内存约束）
Eviction Policy: 手动 invalidateContributorCache()
```

**localStorage (Persistence)**:

| 键名 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `amll-react-full.contributorSource` | `"mirror"` \| `"local"` | `"mirror"` | 数据源选择 |

---

### 3.6 业务规则

#### 3.6.1 功能触发条件

| 条件 | 触发方式 | 前提条件 | 结果 |
|------|----------|----------|------|
| 查询贡献者 | 歌曲ID变化 | `showLyricContributorAtom===true` | 异步查询并更新UI |
| 显示标签 | 贡献者非null | 有逐词歌词数据 | 渲染"@username"链接 |
| 隐藏标签 | 贡献者null | - | 不渲染任何内容 |
| 切换数据源 | 用户更改设置 | - | 清空缓存，后续用新URL |
| 导入TTML | 用户从DB选择 | - | 从导入数据直接提取（不走网络） |

#### 3.6.2 业务逻辑判断规则

1. **逐词歌词判断**: 只有包含 `words` 数组且数组长度>0的歌词才视为"逐词歌词"
   ```typescript
   const hasWordLyrics = lines.some(
     (line) => line && Array.isArray(line.words) && line.words.length > 0,
   );
   ```

2. **贡献者字段识别**: 严格匹配metadata key为 `ttmlAuthorGithubLogin`
   - 大小写敏感
   - 必须完全匹配
   - 取该key对应的第一个value（`authorMeta?.[1]?.[0]`）

3. **显示条件组合**: 必须同时满足两个条件才显示标签：
   - `contributor !== null` （有贡献者数据）
   - 歌词数据包含逐词信息（`hasWordLyrics === true`）

4. **缓存null的策略**: 即使查询结果为null也会缓存
   - 防止对同一首不存在的歌曲反复请求
   - 节省网络带宽和服务器负载

#### 3.6.3 异常情况处理策略

| 异常场景 | 处理方式 | 用户可见影响 |
|----------|----------|--------------|
| 网络不可达 | catch错误，返回null | 标签不显示（静默） |
| 请求超时（5s） | AbortController中止，返回null | 标签不显示（静默），控制台warn |
| TTML解析失败 | catch错误，缓存null | 标签不显示（静默），控制台error |
| 服务器返回404 | fetch返回!ok，返回null | 标签不显示（静默） |
| TTML缺少metadata | find返回undefined，contributor=null | 标签不显示（静默） |
| 非逐词歌词 | hasWordLyrics=false | 标签不显示（正确行为） |
| 本地服务未启动 | 连接拒绝，返回null | 标签不显示，建议用户切回镜像源 |

**核心原则**: 贡献者查询是**增强功能**，任何异常都不应干扰主流程（歌词播放）。因此采用"静默失败"策略。

#### 3.6.4 边界条件说明

1. **并发查询**: 如果歌曲快速切换，可能有多个并行请求同时进行。由于每个请求独立完成并写入缓存，最终结果取决于最后一个完成的请求（通常是最新的歌曲ID）
2. **缓存容量**: Map没有大小限制，理论上可以无限增长。但在实际使用中，单次会话查询的歌曲数量有限（通常<1000），不会造成内存问题
3. **特殊字符ID**: ncmId应该是纯数字字符串，但函数对非数字字符串也会尝试请求（可能返回404并被正确处理）
4. **空贡献者名**: 如果metadata中 `ttmlAuthorGithubLogin` 的值为空字符串 `""`，会被视为falsy值，结果等同于null
5. **重复设置相同贡献者**: Jotai atom的 `set()` 即使值相同也会触发重新渲染（React默认行为），但实际影响可忽略不计

---

## 4. 远程点歌功能

### 4.1 功能概述

#### 4.1.1 业务价值

远程点歌功能是远程网页控制系统的核心交互能力之一，允许**外部客户端通过HTTP API向播放器发送点歌指令**，使播放器立即切换到指定的歌曲并开始播放。该功能的业务价值包括：

- **远程选曲**: 用户无需回到电脑前即可切换歌曲
- **自动化集成**: 可被其他系统（如智能家居、语音助手）调用实现联动
- **演示辅助**: 演讲者可根据现场氛围实时调整背景音乐
- **开发调试**: 方便开发者测试特定歌曲的播放效果
- **社交互动**: 在聚会场景中让朋友通过手机参与选歌

#### 4.1.2 功能边界与模块交互关系

```
┌─────────────────────────────────────────────────────┐
│                远程点歌功能架构                       │
├─────────────────────────────────────────────────────┤
│                                                     │
│   ┌──────────────┐    HTTP POST     ┌─────────────┐ │
│   │  外部客户端   │ ──────────────► │ HTTP Server  │ │
│   │ (浏览器/脚本) │  /api/player/  │ (Axum)       │ │
│   │              │  song/:id      │  Port:13533  │ │
│   └──────────────┘                 └──────┬──────┘ │
│                                           │        │
│                              Tauri Event    │        │
│                              PlaySongEvent   │        │
│                                           ▼        │
│                                    ┌─────────────┐ │
│                                    │ Frontend     │ │
│                                    │ Event Handler│ │
│                                    │ (React)      │ │
│                                    └──────┬──────┘ │
│                                           │        │
│                              更新 musicIdAtom     │
│                              + 触发歌词加载        │
│                                           │        │
│                                           ▼        │
│                                    ┌─────────────┐ │
│                                    │ Player Core  │ │
│                                    │ (音频引擎)    │ │
│                                    └─────────────┘ │
│                                                     │
│   ┌──────────────────────────────────────────┐      │
│   │         SSE / WebSocket 广播 (可选)        │      │
│   │  song_events channel → 所有监听客户端       │      │
│   └──────────────────────────────────────────┘      │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**数据流向**:

1. **请求阶段**: 外部客户端 → HTTP POST → Axum Router → `api_play_song()` handler
2. **事件触发**: Rust handler → `app.emit(PlaySongEvent, &song_id)` → Tauri IPC
3. **前端处理**: React event listener → 更新全局状态 atoms → 触发副作用
4. **广播通知**: (可选) 通过SSE/WS将点歌事件推送给其他连接的客户端

---

### 4.2 技术实现细节

#### 4.2.1 核心算法和数据流程

##### **远程点歌处理流程**

```rust
// 伪代码 - http_server.rs
async fn api_play_song(
    State(state): State<Arc<RwLock<HttpServerState>>>,
    Path(song_id): Path<String>,
) -> impl IntoResponse {
    // 1. 获取AppHandle引用
    let state = state.read().await;
    let app = state.app.clone();

    // 2. 发射Tauri事件（核心操作）
    // 事件类型: "play-song"
    // 载荷: 歌曲ID字符串
    app.emit("play-song", &song_id).map_err(|e| {
        error!("发射 play-song 事件失败: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })?;

    // 3. (可选) 通过broadcast channel通知SSE/WS订阅者
    if let Ok(tx) = state.song_events.try_send(SongEvent::PlaySong {
        id: song_id.clone(),
    }) {
        // 发送成功
    }

    // 4. 返回成功响应
    info!("已处理远程点歌请求: {song_id}");
    (StatusCode::OK, Json(json!({ "success": true, "song_id": song_id })))
}
```

##### **前端事件处理流程**

```typescript
// 伪代码 - 前端事件监听器
useEffect(() => {
  const unlisten = listen<string>("play-song", async (event) => {
    const songId = event.payload;

    console.log(`[Remote] 收到点歌请求: ${songId}`);

    try {
      // Step 1: 更新musicIdAtom（触发LocalMusicContext重新加载）
      store.set(musicIdAtom, songId);

      // Step 2: 清空之前的歌词状态
      store.set(musicLyricLinesAtom, []);
      store.set(lyricContributorAtom, null);
      store.set(hideLyricViewAtom, false);

      // Step 3: (可选) 显示用户提示
      toast.success(t("remote.songRequest.success",
        "已切换到歌曲 {{songId}}", { songId }));

      // Step 4: (可选) 记录到播放历史
      // addToHistory(songId);

    } catch (error) {
      console.error("处理点歌请求失败:", error);
      toast.error(t("remote.songRequest.error",
        "处理点歌请求时出错"));
    }
  });

  return () => { unlisten.then(fn => fn()); };
}, []);
```

**完整数据流图**:

```
外部客户端                    AMLL Backend                  Frontend
    │                            │                           │
    │ POST /api/player/song/123  │                           │
    │───────────────────────────►│                           │
    │                            │                           │
    │                    ┌───────▼────────┐                   │
    │                    │ api_play_song()│                   │
    │                    │  - 解析Path参数│                   │
    │                    │  - 验证song_id │                   │
    │                    └───────┬────────┘                   │
    │                            │                           │
    │                    ┌───────▼────────┐                   │
    │                    │ app.emit()     │ ← Tauri IPC Bridge│
    │                    │ "play-song"    │                   │
    │                    │ payload:"123"  │                   │
    │                    └───────┬────────┘                   │
    │                            │                           │
    │                    ┌───────▼────────┐                   │
    │                    │ song_events    │ (可选)            │
    │                    │ .try_send()    │ broadcast channel │
    │                    └───────┬────────┘                   │
    │                            │                           │
    │  200 OK ◄─────────────────┤                           │
    │  {"success":true}         │                           │
    │                            │                           │
    │                            │    ┌─────────────────────┐│
    │                            │    │ listen("play-song") ││
    │                            ├───►│ React useEffect      ││
    │                            │    └──────────┬──────────┘│
    │                            │               │            │
    │                            │       ┌───────▼────────┐   │
    │                            │       │ set(musicIdAtom)│   │
    │                            │       │ set(lyricLines) │   │
    │                            │       │ set(contributor)│   │
    │                            │       └───────┬────────┘   │
    │                            │               │            │
    │                            │       ┌───────▼────────┐   │
    │                            │       │ UI Re-render    │   │
    │                            │       │ 歌词界面更新     │   │
    │                            │       └────────────────┘   │
    │                            │                           │
    │  SSE/WS Clients ◄──────────┼─── (可选推送)             │
    │  {"type":"PlaySong","id":"123"}                        │
```

#### 4.2.2 关键数据结构定义

```rust
// ====== http_server.rs ======

/// HTTP服务器共享状态
pub struct HttpServerState {
    pub app: AppHandle,                          // Tauri应用句柄
    pub ws_server: Arc<RwLock<AMLLWebSocketServer>>, // WS服务器引用
    pub song_events: broadcast::Sender<SongEvent>,  // 歌曲事件广播通道
}

/// 歌曲事件枚举（用于SSE/WS广播）
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum SongEvent {
    /// 点歌事件
    #[serde(rename = "play")]
    PlaySong { id: String },
    /// 其他事件...
}
```

```typescript
// ====== 前端TypeScript类型定义 ======

/**
 * 远程点歌API响应格式
 */
interface SongRequestResponse {
  success: boolean;    // 是否成功
  song_id: string;     // 请求的歌曲ID
}

/**
 * Tauri事件载荷类型
 */
type PlaySongEventPayload = string;  // 歌曲 ID
```

#### 4.2.3 状态管理方案

**涉及的全局Atoms**:

| Atom名称 | 类型 | 在点歌流程中的变化 | 用途 |
|----------|------|-------------------|------|
| `musicIdAtom` | `atom<string>` | **更新为新歌曲ID** | 核心触发器 |
| `musicLyricLinesAtom` | `atom<Line[]>` | **清空为[]** | 准备加载新歌词 |
| `lyricContributorAtom` | `atom<string \| null>` | **重置为null** | 清除旧贡献者 |
| `hideLyricViewAtom` | `atom<boolean>` | **设为false** | 确保显示歌词区 |
| `isPlayingAtom` | `atom<boolean>` | 可能变化 | 取决于播放器逻辑 |

**状态更新顺序**:

```
收到 "play-song" 事件
    │
    ├──► 1. store.set(musicIdAtom, newSongId)
    │       └──► 触发 LocalMusicContext 的 useEffect
    │           └──► 异步加载新歌词...
    │
    ├──► 2. store.set(musicLyricLinesAtom, [])
    │       └──► UI立即清空旧歌词（避免显示错误内容）
    │
    ├──► 3. store.set(lyricContributorAtom, null)
    │       └──► 清除旧贡献者标签
    │
    └──► 4. store.set(hideLyricViewAtom, false)
            └──► 确保歌词视图可见
```

#### 4.2.4 事件处理机制

**事件链路**:

```
HTTP Request
    │
    ▼
Axum Handler (Rust)
    │
    ├── 1. 提取路径参数 :id
    ├── 2. app.emit("play-song", &id)
    │       └──► Tauri Event System
    │           └──► 所有注册了 "play-song" 监听器的Webview窗口
    │
    ├── 3. song_events.send(SongEvent::PlaySong{id})
    │       └──► Broadcast Channel
    │           └──► SSE subscribers (GET /api/events)
    │           └──► WS clients (if implemented)
    │
    └── 4. 返回 HTTP 200 Response
```

**前端监听器生命周期**:

```typescript
// 通常在顶层组件或Context中注册一次
useEffect(() => {
  const unlistenPromise = listen<string>("play-song", handler);

  return () => {
    // 组件卸载时取消监听
    unlistenPromise.then(unlisten => unlisten());
  };
}, []);  // 空依赖数组 = 只执行一次
```

---

### 4.3 代码实现指南

#### 4.3.1 核心模块/类的结构设计

**主要文件清单**:

| 文件 | 行数 | 职责 |
|------|------|------|
| `src-tauri/src/http_server.rs` | ~50行 | **后端API端点实现** |
| `src-tauri/src/lib.rs` | - | 注册Tauri命令和事件 |
| `src/states/appAtoms.ts` | - | 定义全局状态atoms |
| `src/components/LocalMusicContext/index.tsx` | - | 响应musicId变化并加载歌词 |
| `src/components/WSProtocolMusicContext/index.tsx` | - | WS模式下的点歌处理 |

**后端模块结构 (`http_server.rs`)**:

```
http_server.rs
├── 结构体定义
│   ├── HttpServerState (共享状态)
│   └── SongEvent (事件枚举)
├── 路由构建
│   └── build_router()
│       ├── GET  /api/player/now-playing
│       ├── POST /api/player/play/pause/next/prev
│       ├── POST /api/player/song/:id  ← ★ 点歌端点
│       ├── GET  /api/events (SSE)
│       └── /*   (静态文件服务)
├── Handler函数
│   ├── api_play_song()  ← ★ 核心处理函数
│   ├── api_player_action()
│   └── api_now_playing()
└── 辅助函数
    └── sse_events_stream() (可选)
```

#### 4.3.2 关键函数实现详解

##### **后端API处理器 `api_play_song()`**

```rust
// 完整实现 - src-tauri/src/http_server.rs
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Json},
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tauri::{AppHandle, Emitter};

/// 处理远程点歌请求
///
/// # HTTP Endpoint
/// `POST /api/player/song/{song_id}`
///
/// # Parameters
/// - `song_id`: URL路径参数，表示要播放的歌曲ID
///
/// # Returns
/// - `200 OK`: 成功发射事件，返回JSON确认
/// - `500 Internal Server Error`: 事件发射失败
pub async fn api_play_song(
    State(state): State<Arc<RwLock<HttpServerState>>>,
    Path(song_id): Path<String>,
) -> impl IntoResponse {
    // 1. 获取共享状态的读锁
    let state_read = state.read().await;

    // 2. 克隆AppHandle以在async作用域外使用
    let app_handle = state_read.app.clone();

    // 3. 尝试发射Tauri事件
    // 这是整个功能的核心：将HTTP请求转换为应用内事件
    if let Err(e) = app_handle.emit("play-song", &song_id) {
        error!("无法发射 play-song 事件: {e}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "success": false,
                "error": format!("Failed to emit event: {e}")
            })),
        ).into_response();
    }

    // 4. (可选) 向SSE/WS订阅者广播此事件
    if let Err(e) = state_read.song_events.send(SongEvent::PlaySong {
        id: song_id.clone(),
    }) {
        warn!("没有活跃的SSE/WS订阅者接收点歌事件: {e}");
        // 这不是致命错误，继续返回成功
    }

    // 5. 记录日志
    info!("远程点歌请求已处理: song_id={}", song_id);

    // 6. 返回成功响应
    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "song_id": song_id,
            "message": "Song request sent successfully"
        })),
    ).into_response()
}
```

**关键设计决策**:
- **同步vs异步事件发射**: `app.emit()` 是同步的但非阻塞；它将消息放入IPC队列后立即返回
- **错误处理策略**: 事件发射失败返回500，但广播失败仅记录warn（因为可能没有订阅者）
- **无验证**: 当前不对song_id做格式验证（接受任意字符串），由前端决定如何处理

##### **路由注册代码**

```rust
// 完整实现 - http_server.rs 中的路由配置
use axum::routing::{get, post};
use axum::Router;

pub fn build_router(
    app: AppHandle,
    ws_server: Arc<RwLock<AMLLWebSocketServer>>,
    dist_dir: PathBuf,
) -> Router {
    // 创建broadcast channel用于歌曲事件流
    let (song_events_tx, _song_events_rx) = broadcast::channel::<SongEvent>(64);

    // 构建共享状态
    let state = HttpServerState {
        app: app.clone(),
        ws_server,
        song_events: song_events_tx,
    };

    Router::new()
        // ★ 远程点歌端点
        .route("/api/player/song/:id", post(api_play_song))

        // 其他播放控制端点
        .route("/api/player/play", post(|state| async move {
            api_player_action(&state, "play").await
        }))
        .route("/api/player/pause", post(|state| async move {
            api_player_action(&state, "pause").await
        }))
        .route("/api/player/next", post(|state| async move {
            api_player_action(&state, "next").await
        }))
        .route("/api/player/prev", post(|state| async move {
            api_player_action(&state, "prev").await
        }))

        // 现在播放信息
        .route("/api/player/now-playing", get(api_now_playing))

        // SSE事件流 (可选)
        .route("/api/events", get(sse_events_stream))

        // 静态文件 (远程控制页面)
        .nest_service("/", ServeDir::new(dist_dir))

        // CORS中间件 (重要！允许跨域请求)
        .layer(CorsLayer::permissive())

        // 注入共享状态
        .with_state(Arc::new(RwLock::new(state)))
}
```

##### **前端事件监听器**

```typescript
// 完整实现示例 - 在主组件或Context中
import { listen } from "@tauri-apps/api/event";
import { useStore } from "@applemusic-like-lyrics/react-full";
import { toast } from "react-toastify";
import { useTranslation } from "react-i18next";
import { useEffect } from "react";

export function RemoteSongRequestHandler() {
  const store = useStore();
  const { t } = useTranslation();

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    // 注册一次性事件监听器
    listen<string>("play-song", (event) => {
      const songId = event.payload;

      console.log(`[Remote] Received song request: ${songId}`);

      // 批量更新原子状态（减少渲染次数）
      store.batch(() => {
        // 1. 设置新的歌曲ID（这是最重要的操作）
        store.set(musicIdAtom, songId);

        // 2. 重置相关UI状态
        store.set(musicLyricLinesAtom, []);
        store.set(lyricContributorAtom, null);
        store.set(hideLyricViewAtom, false);
      });

      // 显示用户反馈（可选）
      toast.success(t(
        "remoteControl.songRequestReceived",
        "🎵 已切换到歌曲 {{songId}}",
        { songId: songId.slice(0, 8) + "..." },  // 截断长ID用于显示
      ));
    }).then((unlisten) => {
      unlistenFn = unlisten;
    }).catch((err) => {
      console.error("Failed to register play-song listener:", err);
    });

    // 清理函数：组件卸载时移除监听器
    return () => {
      unlistenFn?.();
    };
  }, [store, t]);

  // 此组件不渲染任何可见UI
  return null;
}
```

**使用位置建议**:
- 放置在 `<App>` 组件树的顶层（确保始终挂载）
- 或放在 `<LocalMusicContext>` 内部（如果需要访问其内部逻辑）

#### 4.3.3 重要业务逻辑的实现步骤

**场景1: 标准远程点歌流程**

1. **用户操作**: 用户在外部设备的浏览器中访问远程控制页面或直接调用API：
   ```bash
   curl -X POST http://192.168.1.100:13533/api/player/song/123456
   ```

2. **网络传输**: HTTP请求到达运行AMLL的主机（假设IP为192.168.1.100）

3. **后端处理**:
   - Axum router匹配路由 `/api/player/song/:id`
   - 提取路径参数 `id = "123456"`
   - 调用 `api_play_song()` handler
   - handler获取 `HttpServerState` 读锁
   - 执行 `app.emit("play-song", "123456")`
   - （可选）向 `song_events` channel发送广播
   - 返回 HTTP 200 + JSON响应

4. **前端响应**:
   - Tauri IPC将事件投递到WebView
   - 已注册的 `"play-song"` 监听器被触发
   - handler函数执行：
     - `store.set(musicIdAtom, "123456")`
     - 清空旧的歌词和贡献者状态
     - 显示toast通知

5. **后续自动行为**:
   - `LocalMusicContext` 检测到 `musicIdAtom` 变化
   - 自动触发歌词加载流程（包括贡献者查询等）
   - UI重新渲染显示新歌词

**场景2: 多客户端协同**

1. 客户端A发起点歌请求：POST `/api/player/song/789`
2. 后端处理后：
   - 向主窗口emit "play-song" 事件
   - 同时通过 `song_events` broadcast给所有SSE/WS订阅者
3. 主窗口前端接收并切换歌曲
4. 客户端B（如果正在监听SSE）也收到通知：
   ```json
   {"type": "play", "id": "789"}
   ```
   - 可以用来更新自己的UI显示当前播放的歌曲

**场景3: 错误处理（事件发射失败）**

1. 后端 `app.emit()` 调用失败（如Tauri IPC队列满）
2. handler捕获错误，返回 HTTP 500：
   ```json
   {
     "success": false,
     "error": "Failed to emit event: ..."
   }
   ```
3. 外部客户端根据状态码判断是否需要重试

---

### 4.4 依赖说明

#### 4.4.1 外部依赖库

**Rust 后端依赖**:

| 库名 | 版本(Cargo.toml) | 用途 | 说明 |
|------|------------------|------|------|
| `axum` | 最新稳定版 | Web框架 | HTTP路由和处理 |
| `tokio` | 最新稳定版 | 异步运行时 | async/await支持 |
| `serde` / `serde_json` | 最新稳定版 | 序列化 | JSON响应生成 |
| `tauri` | ^2.x | 应用框架 | IPC事件系统(app.emit) |
| `tower-http` | latest | 中间件 | CORS、静态文件服务 |
| `tracing` | latest | 日志 | info!/error!/warn!宏 |
| `tokio::sync::broadcast` | 内置 | 通道 | 歌曲事件广播 |

**TypeScript 前端依赖**:

| 库名 | 版本(package.json) | 用途 | 说明 |
|------|-------------------|------|------|
| `@tauri-apps/api` | ^2.x | Tauri JS API | `listen()` 事件监听 |
| `jotai` | ^2.x | 状态管理 | 全局atom读写 |
| `react-toastify` | ^10.x | Toast提示 | 用户操作反馈 |
| `react-i18next` | ^12.x | 国际化 | 多语言提示文案 |

#### 4.4.2 内部模块依赖关系

```
http_server.rs (HTTP层)
├── lib.rs (Tauri入口)
│   └── setup() → build_router() → 启动HTTP服务
├── server.rs (WebSocket层) [可选协作]
│   └── 共享 HttpServerState 引用
└── 前端:
    ├── appAtoms.ts (状态定义)
    │   └── musicIdAtom, lyricContributorAtom 等
    ├── LocalMusicContext (本地模式)
    │   └── 监听 musicIdAtom → 加载歌词
    └── WSProtocolMusicContext (WS模式)
        └── 也可能响应 play-song 事件
```

#### 4.4.3 环境依赖及配置要求

- **网络要求**: 主机和客户端必须在同一局域网（或公网可访问）
- **防火墙**: 需要开放TCP端口13533（HTTP）和11444（WS，如使用）
- **CORS**: 必须配置 `CorsLayer::permissive()` 允许跨域（或限制特定来源）
- **权限**: 无需特殊操作系统权限（普通用户端口范围）

---

### 4.5 接口定义

#### 4.5.1 HTTP REST API接口

**POST /api/player/song/{id}**

**请求规格**:
```
Method: POST
URL: http://{host}:13533/api/player/song/{song_id}
Content-Type: application/json (可选，body可为空)
Headers: 无需认证头（当前版本）
```

**路径参数**:

| 参数名 | 类型 | 必填 | 示例 | 说明 |
|--------|------|------|------|------|
| `id` | string | 是 | `123456`, `abc-def` | 要播放的歌曲标识符 |

**请求体**:
- 可以为空 `{}` 或省略
- 未来版本可能支持额外参数（如 `position` 指定播放起始位置）

**成功响应 (200 OK)**:
```json
{
  "success": true,
  "song_id": "123456",
  "message": "Song request sent successfully"
}
```

**错误响应**:
```json
// 500 Internal Server Error
{
  "success": false,
  "error": "Failed to emit event: ..."
}
```

**使用示例 (cURL)**:
```bash
# 基本用法
curl -X POST "http://localhost:13533/api/player/song/123456"

# 带详细输出
curl -v -X POST "http://192.168.1.100:13533/api/player/song/999"

# JavaScript fetch
fetch('http://localhost:13533/api/player/song/888', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
}).then(r => r.json()).then(console.log);
```

#### 4.5.2 Tauri 事件接口（Internal IPC）

**事件名称**: `"play-song"`

**事件方向**: Rust Backend → Frontend WebView

**载荷类型**: `String` (歌曲ID)

**监听方式**:
```typescript
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen<string>("play-song", (event) => {
  console.log(event.payload);  // 歌曲ID字符串
});
```

**发射方式 (Rust)**:
```rust
use tauri::Emitter;

app.emit("play-song", &song_id_string)?;
```

#### 4.5.3 SSE/WS 推送接口（Optional）

**SSE Endpoint**: `GET /api/events`

**事件格式**:
```
data: {"type":"play","id":"123456"}

```

**WebSocket Message** (如果实现):
```json
{
  "type": "SongEvent",
  "event": {
    "type": "PlaySong",
    "id": "123456"
  }
}
```

#### 4.5.4 数据持久化方案

远程点歌功能**不涉及持久化存储**。它是一个实时的命令转发机制：

- **无数据库**: 不记录点歌历史（除非前端自行实现）
- **无文件写入**: 仅内存中的事件传递
- **无localStorage**: 状态变更通过Jotai atoms管理（已在内存中）

*注：如果未来需要点歌历史记录功能，可以考虑：*
- *SQLite数据库（通过Tauri插件）*
- *文件日志*
- *远程服务器记录*

---

### 4.6 业务规则

#### 4.6.1 功能触发条件

| 条件 | 要求 | 说明 |
|------|------|------|
| HTTP服务运行 | ✅ 必须 | 端口13533必须监听 |
| 有效路由 | ✅ 必须 | URL必须匹配 `/api/player/song/{id}` |
| POST方法 | ✅ 必须 | GET或其他方法不会触发 |
| 前端监听器 | ⚠️ 推荐 | 如果未注册listen则事件丢失 |
| 同源/跨域 | ✅ 配置 | CORS必须允许请求来源 |

#### 4.6.2 业务逻辑判断规则

1. **ID格式自由**: 后端不验证 `song_id` 格式
   - 接受任意非空字符串
   - 前端负责解释ID含义（可能是网易云ID、QQ音乐ID等）

2. **幂等性**: 对同一首歌多次点歌是安全的
   - 每次都会触发完整的状态重置和重新加载
   - 相当于"重新播放这首歌"

3. **无速率限制**: 当前版本未实现限流
   - 恶意客户端可能快速发送大量请求
   - 未来可考虑添加令牌桶或滑动窗口算法

4. **无身份验证**: 任何人知道IP和端口都能点歌
   - 局域网内通常可接受
   - 公网暴露时应添加API Key或OAuth

5. **事件顺序保证**: Tauri的 `emit()` 保证同类型事件的顺序
   - 如果快速连续点两首歌，前端会按顺序收到两个事件
   - 最终状态取决于最后一个事件（后发先至？取决于前端处理速度）

#### 4.6.3 异常情况处理策略

| 异常场景 | 后端处理 | 前端影响 | 用户反馈 |
|----------|----------|----------|----------|
| 事件发射失败 | 返回HTTP 500 | 无变化 | 客户端看到错误码 |
| 无前端监听器 | 仍返回200 | 事件被丢弃 | 无感知（静默失败） |
| 无效的song_id（空串） | 正常处理 | 前端收到空字符串 | 可能导致加载异常 |
| 网络超时 | 连接断开 | 无影响 | 客户端超时错误 |
| 前端处理异常 | 后端不知情 | 部分状态可能不一致 | console.error |
| CORS拒绝 | 浏览器拦截 | 请求未到达后端 | 控制台CORS错误 |
| 防火墙阻断 | TCP连接失败 | 无影响 | 连接拒绝错误 |

**关键设计原则**:
- **后端快速响应**: 不管前端是否处理，HTTP请求都尽快返回
- **松耦合**: 后端只管发射事件，不关心谁在监听
- **优雅降级**: 缺少监听器不是错误，只是功能不生效

#### 4.6.4 边界条件说明

1. **特殊字符ID**: URL编码会自动处理
   - `song/id` with `/` → `%2F`
   - 中文ID → UTF-8编码
   - 后端收到的已是解码后的字符串

2. **极长ID**: 理论上URL长度限制(~8KB)，但实际歌曲ID通常<50字符
   - 超长ID可能导致414 URI Too Long

3. **并发点歌**: 两个客户端同时点不同歌
   - 两个事件都会发射
   - 前端按接收顺序处理
   - 最终显示最后处理的那首

4. **自身调用**: 前端也可以调用自己所在的HTTP服务
   - `fetch('http://localhost:13533/api/player/song/x')`
   - 会产生一个"回环"：前端→HTTP→Tauri→前端
   - 不推荐但技术上可行

5. **离线场景**: 如果前端正在使用WS协议模式而非本地模式
   - `play-song` 事件仍然会被接收
   - 但 `LocalMusicContext` 可能不会响应（因为它只在本地模式下激活）
   - 需要确保 `WSProtocolMusicContext` 也处理此事件（或统一入口）

---

## 附录

### A. 相关文件索引

| 功能 | 核心文件 | 辅助文件 |
|------|----------|----------|
| 远程网页控制 | [server.rs](packages/player/src-tauri/src/server.rs), [http_server.rs](packages/player/src-tauri/src/http_server.rs) | [WSProtocolMusicContext](packages/player/src/components/WSProtocolMusicContext/index.tsx) |
| 窗口置顶 | [lib.rs](packages/player/src-tauri/src/lib.rs), [appAtoms.ts](packages/player/src/states/appAtoms.ts) | [useInitializeWindow.ts](packages/player/src/utils/useInitializeWindow.ts) |
| 歌词贡献者 | [ttml-contributor-search.ts](packages/player/src/utils/ttml-contributor-search.ts) | [settings/player.tsx](packages/player/src/pages/settings/player.tsx) |
| 远程点歌 | [http_server.rs](packages/player/src-tauri/src/http_server.rs) | [LocalMusicContext](packages/player/src/components/LocalMusicContext/index.tsx) |

### B. 技术栈速查

- **桌面框架**: Tauri v2 (Rust + WebView)
- **前端框架**: React 18 + TypeScript
- **状态管理**: Jotai v2
- **HTTP服务**: Axum (Rust)
- **WebSocket**: tokio-tungstenite (Rust)
- **国际化**: react-i18next
- **样式**: TailwindCSS + Radix UI

### C. 开发环境要求

- **Rust**: stable toolchain (最新版)
- **Node.js**: >=18.x
- **包管理器**: pnpm (推荐) / npm / yarn
- **Tauri CLI**: `@tauri-apps/cli@^2`
- **平台SDK**: Windows (MSVC Build Tools) / macOS (Xcode Command Line Tools)

---

> **文档结束**
>
> 本文档涵盖了AMLL项目的四个核心功能的技术实现细节。
> 如需了解其他功能（如FFT频谱、歌词解析引擎等），请参阅相应的独立文档。
> 最后更新时间: 2026-04-07