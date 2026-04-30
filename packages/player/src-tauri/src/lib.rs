use std::net::SocketAddr;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

use amll_player_core::AudioInfo;
use anyhow::Context;
use ffmpeg_next as ffmpeg;
use serde::*;
#[cfg(not(mobile))]
use serde_json::Value;
use tauri::{
    AppHandle, Manager, Runtime, State, WebviewWindowBuilder, ipc::Channel, path::BaseDirectory,
};
#[cfg(desktop)]
use tauri::{PhysicalSize, Size, utils::config::WindowEffectsConfig, window::Effect};
use tokio::sync::RwLock;
use tracing::*;

use crate::server::AMLLWebSocketServer;

mod player;
mod screen_capture;
mod server;

#[cfg(target_os = "windows")]
mod taskbar_lyric;
#[cfg(target_os = "windows")]
mod theme_watcher;

pub type AMLLWebSocketServerWrapper = RwLock<AMLLWebSocketServer>;
pub type AMLLWebSocketServerState<'r> = State<'r, AMLLWebSocketServerWrapper>;

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
async fn ws_reopen_connection(
    addr: &str,
    ws: AMLLWebSocketServerState<'_>,
    channel: Channel<ws_protocol::v2::Payload>,
) -> Result<(), String> {
    ws.write().await.reopen(addr.to_string(), channel);
    Ok(())
}

#[tauri::command]
async fn ws_close_connection(ws: AMLLWebSocketServerState<'_>) -> Result<(), String> {
    ws.write().await.close().await;
    Ok(())
}

#[tauri::command]
async fn ws_get_connections(ws: AMLLWebSocketServerState<'_>) -> Result<Vec<SocketAddr>, String> {
    let server_guard = ws.read().await;
    let connections = server_guard.get_connections().await;
    Ok(connections)
}

#[tauri::command]
async fn ws_broadcast_payload(
    ws: AMLLWebSocketServerState<'_>,
    payload: ws_protocol::v2::Payload,
) -> Result<(), String> {
    ws.write().await.broadcast_payload(payload).await;
    Ok(())
}

#[tauri::command]
fn restart_app<R: Runtime>(app: AppHandle<R>) {
    tauri::process::restart(&app.env())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_window_always_on_top<R: Runtime>(enabled: bool, app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())
    } else {
        Err("Main window not found.".to_string())
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric_format: String,
    pub lyric: String,
    pub comment: String,
    pub cover: Vec<u8>,
    pub duration: f64,
}

impl From<AudioInfo> for MusicInfo {
    fn from(v: AudioInfo) -> Self {
        Self {
            name: v.name,
            artist: v.artist,
            album: v.album,
            lyric_format: if v.lyric.is_empty() {
                "".into()
            } else {
                "lrc".into()
            },
            lyric: v.lyric,
            comment: v.comment,
            cover: v.cover.unwrap_or_default(),
            duration: v.duration,
        }
    }
}

#[tauri::command]
async fn resolve_content_uri(
    file_path: tauri_plugin_fs::FilePath,
    fs: State<'_, tauri_plugin_fs::Fs<tauri::Wry>>,
    app: AppHandle,
) -> Result<String, String> {
    // If it's already a real filesystem path, return it directly
    if let Some(p) = file_path.as_path() {
        return Ok(p.to_string_lossy().into_owned());
    }

    // For content:// URIs (Android), use the fs plugin to open via ContentResolver,
    // then copy to app data dir so FFmpeg can access the real file path.
    let uri_string = match &file_path {
        tauri_plugin_fs::FilePath::Url(u) => u.to_string(),
        tauri_plugin_fs::FilePath::Path(p) => p.to_string_lossy().into_owned(),
    };

    // Determine file extension from URI
    let ext = uri_string
        .rsplit('/')
        .next()
        .and_then(|segment| {
            let decoded = urlencoding::decode(segment).unwrap_or(segment.into());
            let name = decoded.rsplit('/').next().unwrap_or(&decoded);
            name.rsplit('.').next().map(|e| e.to_lowercase())
        })
        .filter(|e| {
            ["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma", "opus"].contains(&e.as_str())
        })
        .unwrap_or_else(|| "audio".to_string());

    // Create a hash-based filename to avoid duplicates
    let uri_hash = format!("{:x}", md5::compute(uri_string.as_bytes()));
    let filename = format!("{uri_hash}.{ext}");

    // Build target directory: app_data_dir/music_cache/
    let data_dir = app
        .path()
        .resolve("music_cache", BaseDirectory::AppData)
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create music_cache dir: {e}"))?;

    let target_path = data_dir.join(&filename);

    // If already cached, return directly
    if target_path.exists() {
        return Ok(target_path.to_string_lossy().into_owned());
    }

    // Open the content:// URI via tauri-plugin-fs (uses ContentResolver on Android)
    let mut open_opts = tauri_plugin_fs::OpenOptions::new();
    open_opts.read(true);
    let mut src_file = fs
        .open(file_path, open_opts)
        .map_err(|e| format!("Failed to open content URI: {e}"))?;

    let mut dst_file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create cache file: {e}"))?;

    std::io::copy(&mut src_file, &mut dst_file).map_err(|e| {
        // Clean up partial file on failure
        let _ = std::fs::remove_file(&target_path);
        format!("Failed to copy file: {e}")
    })?;

    info!("Resolved content URI to: {}", target_path.display());
    Ok(target_path.to_string_lossy().into_owned())
}

/// 在 Android 上唤起系统的目录选择器（`ACTION_OPEN_DOCUMENT_TREE`）。
/// 实现方式：通过我们在 `MainActivity` 里写的伴生桥接静态方法
/// `pickDirectoryTree` 触发 SAF，返回用户最终选定的 tree URI 字符串；
/// 用户取消则返回 `None`。
///
/// 之所以要自实现，是因为上游 Tauri 2.6.x 的 `tauri-plugin-dialog`
/// 还没在移动端实现 `open({ directory: true })`，调用会报
/// "Folder picker is not implemented on mobile"。
#[cfg(target_os = "android")]
#[tauri::command]
async fn pick_directory_tree_uri() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| -> Result<Option<String>, String> {
        use jni::JavaVM;
        use jni::objects::{JClass, JObject, JString};

        let ctx = ndk_context::android_context();
        // 防御性检查：实际上 Tauri 在 JNI_OnLoad 阶段就把这两个指针填好了，
        // 任何 #[tauri::command] 触发时它们都不会为 null；这里多一层保险，
        // 万一以后初始化时序变化，也能拿到清晰的错误信息而不是诡异的下游失败。
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err("Android JNI 环境尚未初始化".to_string());
        }
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("attach JavaVM 失败: {e}"))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach 当前线程失败: {e}"))?;

        // 关键坑点：通过 attach_current_thread 拿到的工作线程 JNIEnv，其默认 class
        // loader 是系统级的，只能找到 android.* 这类系统类，找不到 app 自己打
        // 进 dex 里的业务类（这里就是 net.stevexmh.amllplayer.MainActivity）。
        // 直接 call_static_method("net/stevexmh/...", ...) 会抛
        // ClassNotFoundException 把进程整崩。所以要先通过 Activity 的
        // ClassLoader.loadClass 拿到正确的 Class 对象，再用它做静态方法调用。
        let class_loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("getClassLoader failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let class_name = env
            .new_string("net.stevexmh.amllplayer.MainActivity")
            .map_err(|e| format!("new_string failed: {e}"))?;
        let main_class_obj = env
            .call_method(
                &class_loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&class_name).into()],
            )
            .map_err(|e| format!("loadClass(MainActivity) failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let main_class: JClass = main_class_obj.into();

        let result = env
            .call_static_method(
                &main_class,
                "pickDirectoryTree",
                "()Ljava/lang/String;",
                &[],
            )
            .map_err(|e| format!("call pickDirectoryTree failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        if result.is_null() {
            return Ok(None);
        }
        let uri: String = env
            .get_string(&JString::from(result))
            .map(|s| s.into())
            .unwrap_or_default();
        if uri.is_empty() {
            Ok(None)
        } else {
            Ok(Some(uri))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn pick_directory_tree_uri() -> Result<Option<String>, String> {
    Err("pick_directory_tree_uri is only supported on Android".to_string())
}

/// 通过 `ContentResolver.query` + `OpenableColumns._display_name` 取出
/// Android `content://` URI 对应的真实文件名（例如 `xxx.js`、`歌曲.mp3`）。
///
/// 之所以要单写一个命令：Tauri 2 在 JS 侧的 `path.basename` 会把入参当 URL
/// 解析，遇到非 `file://` 协议直接抛 "URL is not a valid path"，
/// 所以从 SAF 选择器拿到的 content URI 没法走常规路径取文件名。Provider 不暴露
/// display name 时返回 `None`，调用方可以回退到 URI 末段。
#[cfg(target_os = "android")]
#[tauri::command]
async fn query_content_display_name(uri: String) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        use jni::JavaVM;
        use jni::objects::{JObject, JObjectArray, JString, JValue};

        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err("Android JNI 环境尚未初始化".to_string());
        }
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("attach JavaVM 失败: {e}"))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach 当前线程失败: {e}"))?;

        let uri_jstr = env
            .new_string(&uri)
            .map_err(|e| format!("new_string uri: {e}"))?;
        let uri_obj = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[(&uri_jstr).into()],
            )
            .map_err(|e| format!("Uri.parse failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        let resolver = env
            .call_method(
                &context,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|e| format!("getContentResolver failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        let str_class = env
            .find_class("java/lang/String")
            .map_err(|e| format!("find String class: {e}"))?;
        let projection: JObjectArray = env
            .new_object_array(1, &str_class, JObject::null())
            .map_err(|e| format!("new_object_array: {e}"))?;
        let display_name_col = env
            .new_string("_display_name")
            .map_err(|e| format!("new_string col: {e}"))?;
        env.set_object_array_element(&projection, 0, &display_name_col)
            .map_err(|e| format!("set_object_array_element: {e}"))?;

        let null_obj = JObject::null();
        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    (&uri_obj).into(),
                    (&projection).into(),
                    (&null_obj).into(),
                    (&null_obj).into(),
                    (&null_obj).into(),
                ],
            )
            .map_err(|e| format!("ContentResolver.query failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        if cursor.is_null() {
            return Ok(None);
        }

        let has_row = env
            .call_method(&cursor, "moveToFirst", "()Z", &[])
            .map_err(|e| format!("moveToFirst failed: {e}"))?
            .z()
            .unwrap_or(false);
        let mut out: Option<String> = None;
        if has_row {
            let name_obj = env
                .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(0)])
                .ok()
                .and_then(|v| v.l().ok())
                .unwrap_or(JObject::null());
            if !name_obj.is_null() {
                let s: String = env
                    .get_string(&JString::from(name_obj))
                    .map(|s| s.into())
                    .unwrap_or_default();
                if !s.is_empty() {
                    out = Some(s);
                }
            }
        }
        let _ = env.call_method(&cursor, "close", "()V", &[]);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn query_content_display_name(_uri: String) -> Result<Option<String>, String> {
    Err("query_content_display_name is only supported on Android".to_string())
}

/// 把 SAF document id（由系统文件 Provider `com.android.externalstorage.documents`
/// 产出的 `volume:相对路径` 形式标识）转换成 `/storage/...` 下的真实文件路径。
///
/// 可支持的几种格式：
/// - `primary:相对/路径` → `/storage/emulated/0/相对/路径`
/// - `primary:`         → `/storage/emulated/0`
/// - `XXXX-XXXX:rel/路径` → `/storage/XXXX-XXXX/rel/路径`（SD 卡 / OTG 等次存储）
/// - `raw:/绝对/路径`    → `/绝对/路径`（少数 Provider 直接暴露原始路径）
///
/// 对于无法映射到真实文件系统路径的 document id（比如云盘 Provider、仅
/// MediaStore 的内容），返回 `None`，调用方应当跳过这类条目。
#[cfg(target_os = "android")]
fn document_id_to_fs_path(doc_id: &str) -> Option<String> {
    if let Some(rest) = doc_id.strip_prefix("raw:") {
        return Some(rest.to_string());
    }
    let (volume, rel) = doc_id.split_once(':')?;
    let base = if volume == "primary" {
        "/storage/emulated/0".to_string()
    } else {
        format!("/storage/{volume}")
    };
    Some(if rel.is_empty() {
        base
    } else {
        format!("{base}/{rel}")
    })
}

/// SAF 扫描取消标记。扫描入口处置为 false，循环中定期查。
#[cfg(target_os = "android")]
static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

/// 请求中止当前扫描。幂等，无扫描在跑时调也安全。
#[cfg(target_os = "android")]
#[tauri::command]
fn cancel_scan_audio_in_tree_uri() {
    SCAN_CANCEL.store(true, Ordering::SeqCst);
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
fn cancel_scan_audio_in_tree_uri() {}

/// 递归扫描用户通过系统目录选择器（SAF）挑选的目录 URI，列出其中所有音频文件。
///
/// 返回的是 `/storage/...` 下的**真实文件系统路径**列表，而不是 content://URL
/// 这样做需要 `MANAGE_EXTERNAL_STORAGE` 权限（App 已在启动时通过
/// `MainActivity.checkAllFilesAccessPermission` 弹窗引导用户授予）；
/// 带来的好处是后续元数据解析与播放都能让 FFmpeg 直接打开原文件，
/// **这样似乎完全不需要把音频拷贝到 `music_cache` 占用双倍空间**。
///
/// 极少数情况下某个 document id 没法映射到真实路径（如来自云盘 Provider的条目），
/// 这类文件会被静默跳过。
#[cfg(target_os = "android")]
#[tauri::command]
async fn scan_audio_in_tree_uri(tree_uri: String, recursive: bool) -> Result<Vec<String>, String> {
    // 进入扫描就先把上一次可能遗留的取消标记清掉，确保本次从干净状态开始。
    SCAN_CANCEL.store(false, Ordering::SeqCst);
    tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        use jni::JavaVM;
        use jni::objects::{JObject, JObjectArray, JString, JValue};

        const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "m4a", "aac", "ogg", "wma", "opus"];
        const DIR_MIME: &str = "vnd.android.document/directory";

        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err("Android JNI 环境尚未初始化".to_string());
        }
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("attach JavaVM 失败: {e}"))?;
        let context = unsafe { JObject::from_raw(ctx.context().cast()) };
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach 当前线程失败: {e}"))?;

        // 把一个 Java String JObject 转成 Rust String，然后立刻释放掉它的
        // 本地引用。如果不及时释放，扫描大目录时会很快把 JNI 本地引用表
        // 撑满（默认上限 512 个），后续调用就会失败。
        fn jobj_to_string(env: &mut jni::JNIEnv, obj: JObject) -> String {
            if obj.is_null() {
                return String::new();
            }
            let raw = obj.as_raw();
            let s = env
                .get_string(&JString::from(obj))
                .map(|s| s.into())
                .unwrap_or_default();
            // SAFETY: `raw` 是从上面那个有效且已被消费掉的 JObject 里取出来的，
            // 这里重新包一下仅仅是为了当参数传给 `delete_local_ref`，不会被再读。
            let dup = unsafe { JObject::from_raw(raw) };
            let _ = env.delete_local_ref(dup);
            s
        }

        let tree_uri_jstr = env
            .new_string(&tree_uri)
            .map_err(|e| format!("new_string tree_uri: {e}"))?;
        let tree_uri_obj = env
            .call_static_method(
                "android/net/Uri",
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[(&tree_uri_jstr).into()],
            )
            .map_err(|e| format!("Uri.parse failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        let resolver = env
            .call_method(
                &context,
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|e| format!("getContentResolver failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;

        // 尽量持久化这次的 URI 读权限（FLAG_GRANT_READ_URI_PERMISSION = 1），
        // 这样 App 重启之后还能继续访问该目录。失败也无所谓，本次仍然有授权。
        let _ = env.call_method(
            &resolver,
            "takePersistableUriPermission",
            "(Landroid/net/Uri;I)V",
            &[(&tree_uri_obj).into(), JValue::Int(1)],
        );
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }

        // 取出树的根 document id（DFS 遍历的起点）
        let root_doc_id_obj = env
            .call_static_method(
                "android/provider/DocumentsContract",
                "getTreeDocumentId",
                "(Landroid/net/Uri;)Ljava/lang/String;",
                &[(&tree_uri_obj).into()],
            )
            .map_err(|e| format!("getTreeDocumentId failed: {e}"))?
            .l()
            .map_err(|e| e.to_string())?;
        let root_doc_id = jobj_to_string(&mut env, root_doc_id_obj);
        if root_doc_id.is_empty() {
            return Err("Empty root document id".into());
        }

        let str_class = env
            .find_class("java/lang/String")
            .map_err(|e| format!("find String class: {e}"))?;

        let mut results = Vec::new();
        let mut stack: Vec<String> = vec![root_doc_id];
        let mut canceled = false;

        while let Some(doc_id) = stack.pop() {
            if SCAN_CANCEL.load(Ordering::SeqCst) {
                canceled = true;
                break;
            }
            // 每扫描一个目录就开一个 local frame，让本轮产生的 JNI 临时引用
            // （Cursor、projection 数组、子 URI…）在 frame 退出时被统一回收，
            // 避免大目录场景下本地引用堆积导致 JNI 报错。
            let frame_res = env.with_local_frame::<_, _, jni::errors::Error>(64, |env| {
                let doc_id_jstr = match env.new_string(&doc_id) {
                    Ok(v) => v,
                    Err(_) => return Ok(()),
                };

                let children_uri = match env.call_static_method(
                    "android/provider/DocumentsContract",
                    "buildChildDocumentsUriUsingTree",
                    "(Landroid/net/Uri;Ljava/lang/String;)Landroid/net/Uri;",
                    &[(&tree_uri_obj).into(), (&doc_id_jstr).into()],
                ) {
                    Ok(v) => v.l().unwrap_or(JObject::null()),
                    Err(_) => {
                        if env.exception_check().unwrap_or(false) {
                            let _ = env.exception_clear();
                        }
                        return Ok(());
                    }
                };
                if children_uri.is_null() {
                    return Ok(());
                }

                let projection: JObjectArray = match env.new_object_array(3, &str_class, JObject::null()) {
                    Ok(v) => v,
                    Err(_) => return Ok(()),
                };
                for (i, name) in ["document_id", "mime_type", "_display_name"].iter().enumerate() {
                    if let Ok(s) = env.new_string(name) {
                        let _ = env.set_object_array_element(&projection, i as i32, &s);
                    }
                }

                let null_obj = JObject::null();
                let cursor = match env.call_method(
                    &resolver,
                    "query",
                    "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                    &[
                        (&children_uri).into(),
                        (&projection).into(),
                        (&null_obj).into(),
                        (&null_obj).into(),
                        (&null_obj).into(),
                    ],
                ) {
                    Ok(v) => v.l().unwrap_or(JObject::null()),
                    Err(_) => {
                        if env.exception_check().unwrap_or(false) {
                            let _ = env.exception_clear();
                        }
                        return Ok(());
                    }
                };
                if cursor.is_null() {
                    return Ok(());
                }

                loop {
                    if SCAN_CANCEL.load(Ordering::SeqCst) {
                        break;
                    }
                    let has_next = match env.call_method(&cursor, "moveToNext", "()Z", &[]) {
                        Ok(v) => v.z().unwrap_or(false),
                        Err(_) => {
                            if env.exception_check().unwrap_or(false) {
                                let _ = env.exception_clear();
                            }
                            false
                        }
                    };
                    if !has_next {
                        break;
                    }

                    let cdid = env
                        .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(0)])
                        .ok()
                        .and_then(|v| v.l().ok())
                        .unwrap_or(JObject::null());
                    let mt = env
                        .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(1)])
                        .ok()
                        .and_then(|v| v.l().ok())
                        .unwrap_or(JObject::null());
                    let nm = env
                        .call_method(&cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(2)])
                        .ok()
                        .and_then(|v| v.l().ok())
                        .unwrap_or(JObject::null());

                    let child_doc_id = jobj_to_string(env, cdid);
                    if child_doc_id.is_empty() {
                        continue;
                    }
                    let mime = jobj_to_string(env, mt);
                    let name = jobj_to_string(env, nm);

                    if mime == DIR_MIME {
                        if recursive {
                            stack.push(child_doc_id);
                        }
                    } else {
                        let lower = name.to_lowercase();
                        let is_audio = mime.starts_with("audio/")
                            || AUDIO_EXTS
                                .iter()
                                .any(|e| lower.ends_with(&format!(".{e}")));
                        if !is_audio {
                            continue;
                        }
                        // 直接把 SAF document id（形如 `primary:Music/x.mp3`）转成
                        // 真实路径 `/storage/emulated/0/Music/x.mp3` 后入库。这样
                        // 配合 MANAGE_EXTERNAL_STORAGE 权限就能直读原文件，不会
                        // 再触发 resolve_content_uri 把音频拷一份到 music_cache。
                        if let Some(fs_path) = document_id_to_fs_path(&child_doc_id) {
                            results.push(fs_path);
                        }
                    }
                }

                let _ = env.call_method(&cursor, "close", "()V", &[]);
                Ok(())
            });
            if let Err(e) = frame_res {
                warn!("scan_audio_in_tree_uri frame error: {e}");
            }
        }

        if canceled || SCAN_CANCEL.load(Ordering::SeqCst) {
            // 前端按这个特征串识别「用户主动取消」。
            info!(
                "scan_audio_in_tree_uri canceled by user after collecting {} files",
                results.len()
            );
            return Err("__CANCELED__".to_string());
        }
        info!("Scanned {} audio files under tree URI", results.len());
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn scan_audio_in_tree_uri(_tree_uri: String, _recursive: bool) -> Result<Vec<String>, String> {
    Err("scan_audio_in_tree_uri is only supported on Android".to_string())
}

#[tauri::command]
async fn read_local_music_metadata(
    file_path: tauri_plugin_fs::FilePath,
    fs: State<'_, tauri_plugin_fs::Fs<tauri::Wry>>,
) -> Result<MusicInfo, String> {
    let path_clone = file_path
        .as_path()
        .context("Invalid file path")
        .map_err(|e| e.to_string())?
        .to_path_buf();

    let audio_info = tokio::task::spawn_blocking(move || -> anyhow::Result<AudioInfo> {
        let mut input_ctx = ffmpeg::format::input(&path_clone)
            .with_context(|| format!("无法打开文件: {}", path_clone.display()))?;
        let mut info = amll_player_core::utils::read_audio_info(&mut input_ctx);
        if let Some(stream) = input_ctx.streams().best(ffmpeg::media::Type::Audio) {
            let time_base = stream.time_base();
            let duration = stream.duration();
            info.duration = duration as f64 * time_base.0 as f64 / time_base.1 as f64;
        }
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let mut music_info: MusicInfo = audio_info.into();

    if let Some(file_path_ref) = file_path.as_path()
        && music_info.lyric.is_empty()
    {
        // 优先级从高到低：TTML > LyS > YRC > QRC > ESLRC > LRC。
        const LYRIC_FILE_EXTENSIONS: &[&str] = &["ttml", "lys", "yrc", "qrc", "eslrc", "lrc"];
        // 一次 read_dir 取目录列表，避免每首歌做 6 次 exists()，
        // 在 Android `/storage/emulated/0` 这类 FUSE 上的命中收益尤其明显。
        if let (Some(parent), Some(stem)) = (file_path_ref.parent(), file_path_ref.file_stem()) {
            let stem_lc = stem.to_string_lossy().to_lowercase();
            let mut sibling_exts: std::collections::HashMap<String, std::path::PathBuf> =
                std::collections::HashMap::new();
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let Some(file_stem) = p.file_stem() else {
                        continue;
                    };
                    if file_stem.to_string_lossy().to_lowercase() != stem_lc {
                        continue;
                    }
                    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                        sibling_exts.insert(ext.to_lowercase(), p.clone());
                    }
                }
            }
            for ext in LYRIC_FILE_EXTENSIONS {
                if let Some(lyric_file_path) = sibling_exts.get(*ext) {
                    match fs.read_to_string(lyric_file_path) {
                        Ok(lyric) => {
                            music_info.lyric_format = ext.to_string();
                            music_info.lyric = lyric;
                            break;
                        }
                        Err(_) => {
                            warn!("歌词文件存在但读取失败: {}", lyric_file_path.display());
                        }
                    }
                }
            }
        }
    }

    Ok(music_info)
}

async fn create_common_win<'a>(
    app: &'a AppHandle,
    url: tauri::WebviewUrl,
    label: &str,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let win = WebviewWindowBuilder::new(app, label, url);
    #[cfg(target_os = "windows")]
    let win = win.transparent(true);
    #[cfg(not(desktop))]
    let win = win;

    #[cfg(desktop)]
    let win = win
        .center()
        .inner_size(800.0, 600.0)
        .effects(WindowEffectsConfig {
            effects: vec![Effect::Tabbed, Effect::Mica],
            ..Default::default()
        })
        .theme(None)
        .title({
            #[cfg(target_os = "macos")]
            {
                ""
            }
            #[cfg(not(target_os = "macos"))]
            {
                "AMLL Player"
            }
        })
        .visible({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        })
        .decorations({
            #[cfg(target_os = "macos")]
            {
                true
            }
            #[cfg(not(target_os = "macos"))]
            {
                false
            }
        });

    #[cfg(target_os = "macos")]
    let win = win.title_bar_style(tauri::TitleBarStyle::Overlay);

    win
}

async fn recreate_window(app: &AppHandle, label: &str, path: Option<&str>) {
    info!("Recreating window: {}", label);
    if let Some(_win) = app.get_webview_window(label) {
        #[cfg(desktop)]
        {
            let _ = _win.show();
            let _ = _win.set_focus();
        }
        return;
    }
    #[cfg(debug_assertions)]
    let url = {
        tauri::WebviewUrl::External(
            app.config()
                .build
                .dev_url
                .clone()
                .unwrap()
                .join(path.unwrap_or(""))
                .expect("Failed to create external URL"),
        )
    };
    #[cfg(not(debug_assertions))]
    let url = tauri::WebviewUrl::App(path.unwrap_or("index.html").into());
    let win = create_common_win(app, url, label).await;

    let _win = win.build().expect("can't show original window");

    #[cfg(desktop)]
    {
        let _ = _win.set_focus();
        if let Ok(orig_size) = _win.inner_size() {
            let _ = _win.set_size(Size::Physical(PhysicalSize::new(0, 0)));
            let _ = _win.set_size(orig_size);
        }
    }

    info!("Created window: {}", label);
}

#[tauri::command]
async fn open_screenshot_window(app: AppHandle) {
    recreate_window(&app, "screenshot", Some("screenshot.html")).await;
}

fn init_logging() {
    #[cfg(not(debug_assertions))]
    {
        let log_file = std::fs::File::create("amll-player.log");
        if let Ok(log_file) = log_file {
            tracing_subscriber::fmt()
                .map_writer(move |_| log_file)
                .with_thread_names(true)
                .with_ansi(false)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        } else {
            tracing_subscriber::fmt()
                .with_thread_names(true)
                .with_timer(tracing_subscriber::fmt::time::uptime())
                .init();
        }
    }
    #[cfg(debug_assertions)]
    {
        tracing_subscriber::fmt()
            .with_env_filter("amll_player=trace,wry=info,taskbar_lyric=trace")
            .with_thread_names(true)
            .with_timer(tracing_subscriber::fmt::time::uptime())
            .init();
    }
    std::panic::set_hook(Box::new(move |info| {
        error!("Fatal error occurred! AMLL Player will exit now.");
        error!("Error: {info}");
        error!("{info:#?}");
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    info!("AMLL Player is starting!");
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();

    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    #[cfg(not(mobile))]
    let pubkey = {
        if let Some(Value::Object(updater_config)) = context.config().plugins.0.get("updater") {
            if let Some(Value::String(pubkey)) = updater_config.get("pubkey") {
                pubkey.clone()
            } else {
                "".into()
            }
        } else {
            "".into()
        }
    };
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());

    #[cfg(mobile)]
    {
        context
            .config_mut()
            .app
            .windows
            .push(tauri::utils::config::WindowConfig {
                ..Default::default()
            })
    }

    ffmpeg::init().expect("初始化 ffmpeg 失败");

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            ws_reopen_connection,
            ws_get_connections,
            ws_broadcast_payload,
            ws_close_connection,
            open_screenshot_window,
            screen_capture::take_screenshot,
            player::local_player_send_msg,
            player::set_media_controls_enabled,
            resolve_content_uri,
            pick_directory_tree_uri,
            query_content_display_name,
            scan_audio_in_tree_uri,
            cancel_scan_audio_in_tree_uri,
            read_local_music_metadata,
            restart_app,
            #[cfg(target_os = "windows")]
            set_window_always_on_top,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::set_click_interception,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::set_forwarding_enabled,
            #[cfg(target_os = "windows")]
            taskbar_lyric::mouse_forward::stop_mouse_hook,
            #[cfg(target_os = "windows")]
            taskbar_lyric::close_taskbar_lyric,
            #[cfg(target_os = "windows")]
            taskbar_lyric::open_taskbar_lyric,
            #[cfg(target_os = "windows")]
            taskbar_lyric::open_taskbar_lyric_devtools,
            #[cfg(target_os = "windows")]
            theme_watcher::get_system_theme
        ])
        .setup(|app| {
            player::init_local_player(app.handle().clone());

            // 预热 FFmpeg：让 libav* 的 `.so` 在后台 dlopen 好，避免首次导入时被全局锁串行化。
            tauri::async_runtime::spawn_blocking(|| {
                let dummy = std::path::PathBuf::from("/__amll_ffmpeg_warmup__");
                let _ = ffmpeg::format::input(&dummy);
                debug!("FFmpeg 预热完成");
            });

            #[cfg(target_os = "windows")]
            app.manage(taskbar_lyric::TaskbarLyricState::default());

            #[cfg(target_os = "windows")]
            {
                match theme_watcher::ThemeWatcher::new(app.handle().clone()) {
                    Ok(watcher) => {
                        app.manage(watcher);
                    }
                    Err(e) => {
                        warn!("启动系统主题监听失败: {e}");
                    }
                }
            }

            #[cfg(desktop)]
            let _ = app
                .handle()
                .plugin(tauri_plugin_global_shortcut::Builder::new().build());
            app.manage::<AMLLWebSocketServerWrapper>(RwLock::new(AMLLWebSocketServer::new(
                app.handle().clone(),
            )));
            #[cfg(not(mobile))]
            {
                tauri::async_runtime::block_on(recreate_window(app.handle(), "main", None));
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::Destroyed = _event
                && _window.label() == "main"
                && let Some(taskbar_win) = _window.app_handle().get_webview_window("taskbar-lyric")
            {
                let _ = taskbar_win.destroy();
            }
        })
        .run(context)
        .expect("error while running tauri application");
}
