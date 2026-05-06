//! Android 跨进程 MediaSession 捕捉桥接。
//!
//! 与 [`taskbar_lyric`]、[`server`] 等模块同样通过 Tauri 命令暴露给 JS：
//! - 权限：`android_media_capture_has_permission` / `..._open_settings`
//! - 生命周期：`..._start` / `..._stop`
//! - 会话：`..._list_sessions` / `..._select_session`
//! - 控制：`..._send_command`
//!
//! 启动后会 spawn 一个后台 tokio 阻塞任务，反复调用 Java 侧
//! `MediaCaptureManager.pollEvent`，把事件 JSON 字符串通过
//! `android-media-capture-event` Tauri 事件转发给前端。
//!
//! 整个模块在非 Android 平台上空壳化，只暴露同名 command 但全部直接报错，
//! 这样 `tauri::generate_handler!` 列表能保持平台无关。

#![allow(clippy::needless_pass_by_value)]

use tauri::AppHandle;
#[cfg(target_os = "android")]
use tauri::Emitter;

#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "android")]
static POLLING: AtomicBool = AtomicBool::new(false);

/// 与 Kotlin 侧 push 的 JSON 一一对应；前端拿到的是这个 payload 的 raw 字符串，
/// 由前端再 `JSON.parse`，避免在 Rust 侧重复定义嵌套结构。
#[cfg(target_os = "android")]
#[derive(serde::Serialize, Clone)]
struct CaptureEventPayload {
    /// 直接是 Kotlin push 的 JSON 字符串。
    json: String,
}

#[cfg(target_os = "android")]
fn with_jni<F, R>(f: F) -> Result<R, String>
where
    F: for<'a> FnOnce(
        &mut jni::JNIEnv<'a>,
        &jni::objects::JClass<'a>,
    ) -> Result<R, String>,
{
    use jni::JavaVM;
    use jni::objects::{JClass, JObject};

    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        return Err("Android JNI 环境尚未初始化".into());
    }
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("attach JavaVM 失败: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("attach 当前线程失败: {e}"))?;

    // 通过 Activity 的 ClassLoader 解析 app 自己的业务类，否则
    // 默认 system class loader 找不到 net.stevexmh.* —— 参见 pickDirectoryTree
    // 那一段长注释里踩过的坑。
    let class_loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| format!("getClassLoader failed: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let class_name = env
        .new_string("net.stevexmh.amllplayer.MediaCaptureManager")
        .map_err(|e| format!("new_string failed: {e}"))?;
    let cls_obj = env
        .call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&class_name).into()],
        )
        .map_err(|e| format!("loadClass(MediaCaptureManager) failed: {e}"))?
        .l()
        .map_err(|e| e.to_string())?;
    let cls: JClass = cls_obj.into();
    f(&mut env, &cls)
}

#[cfg(target_os = "android")]
fn jstring_to_opt(env: &mut jni::JNIEnv, obj: jni::objects::JObject) -> Option<String> {
    use jni::objects::JString;
    if obj.is_null() {
        return None;
    }
    env.get_string(&JString::from(obj))
        .ok()
        .map(|s| s.into())
}

#[tauri::command]
pub async fn android_media_capture_has_permission() -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        tokio::task::spawn_blocking(|| -> Result<bool, String> {
            with_jni(|env, cls| {
                let v = env
                    .call_static_method(cls, "hasPermission", "()Z", &[])
                    .map_err(|e| e.to_string())?;
                v.z().map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_open_settings() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tokio::task::spawn_blocking(|| -> Result<(), String> {
            with_jni(|env, cls| {
                env.call_static_method(cls, "openPermissionSettings", "()V", &[])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_start(app: AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let started = tokio::task::spawn_blocking(|| -> Result<bool, String> {
            with_jni(|env, cls| {
                let v = env
                    .call_static_method(cls, "start", "()Z", &[])
                    .map_err(|e| e.to_string())?;
                v.z().map_err(|e| e.to_string())
            })
        })
        .await
        .map_err(|e| e.to_string())??;

        if started && !POLLING.swap(true, Ordering::SeqCst) {
            spawn_event_pump(app);
        }
        Ok(started)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_stop() -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        // 让 pump 线程在下一次 poll 超时后自然退出。
        POLLING.store(false, Ordering::SeqCst);
        tokio::task::spawn_blocking(|| -> Result<(), String> {
            with_jni(|env, cls| {
                env.call_static_method(cls, "stop", "()V", &[])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_list_sessions() -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        tokio::task::spawn_blocking(|| -> Result<String, String> {
            with_jni(|env, cls| {
                let r = env
                    .call_static_method(cls, "listSessions", "()Ljava/lang/String;", &[])
                    .map_err(|e| e.to_string())?
                    .l()
                    .map_err(|e| e.to_string())?;
                Ok(jstring_to_opt(env, r).unwrap_or_else(|| "[]".into()))
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_select_session(package_name: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            with_jni(|env, cls| {
                let pkg = env
                    .new_string(&package_name)
                    .map_err(|e| e.to_string())?;
                env.call_static_method(
                    cls,
                    "selectSession",
                    "(Ljava/lang/String;)V",
                    &[(&pkg).into()],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = package_name;
        Err("仅 Android 支持".into())
    }
}

#[tauri::command]
pub async fn android_media_capture_send_command(cmd: String, arg: i64) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            with_jni(|env, cls| {
                use jni::objects::JValue;
                let cmd_str = env.new_string(&cmd).map_err(|e| e.to_string())?;
                env.call_static_method(
                    cls,
                    "sendCommand",
                    "(Ljava/lang/String;J)V",
                    &[(&cmd_str).into(), JValue::Long(arg)],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (cmd, arg);
        Err("仅 Android 支持".into())
    }
}

#[cfg(target_os = "android")]
fn spawn_event_pump(app: AppHandle) {
    use tracing::warn;

    std::thread::Builder::new()
        .name("amll-media-capture-pump".into())
        .spawn(move || {
            // 与 Kotlin 侧 pollEvent 的 timeout 相关；500ms 既能保证 stop 后
            // 0.5s 内自然退出，也避免太短导致 JNI attach/detach 频繁开销。
            const POLL_TIMEOUT_MS: i64 = 500;
            while POLLING.load(Ordering::SeqCst) {
                let res = with_jni(|env, cls| {
                    use jni::objects::JValue;
                    let v = env
                        .call_static_method(
                            cls,
                            "pollEvent",
                            "(J)Ljava/lang/String;",
                            &[JValue::Long(POLL_TIMEOUT_MS)],
                        )
                        .map_err(|e| e.to_string())?
                        .l()
                        .map_err(|e| e.to_string())?;
                    Ok(jstring_to_opt(env, v))
                });
                match res {
                    Ok(Some(json)) => {
                        if let Err(e) = app.emit(
                            "android-media-capture-event",
                            CaptureEventPayload { json },
                        ) {
                            warn!("emit android-media-capture-event 失败: {e}");
                        }
                    }
                    Ok(None) => { /* 超时无事件，下个循环 */ }
                    Err(e) => {
                        warn!("pollEvent 失败，停止泵线程: {e}");
                        POLLING.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            }
        })
        .expect("spawn media capture pump thread failed");
}
