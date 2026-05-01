//! Android `MediaSession` backend for the media state manager.
//!
//! 通过 JNI 调用 Kotlin 侧的 `MediaSessionHelper` 单例，由后者管理
//! `MediaSessionCompat`。Rust 侧只负责在合适的时机调用 Java 静态方法
//! 设置标题、歌手、封面、播放状态等，并通过 `pollCommand()` 轮询用户
//! 在通知栏 / 锁屏 / 蓝牙设备上按下的媒体按钮事件。

use std::fmt::Debug;

use tokio::sync::mpsc::UnboundedReceiver;
use tracing::{info, warn};

use super::{MediaStateManagerBackend, MediaStateMessage};

/// Android 媒体状态管理器。
///
/// 内部不持有 JNI 引用——每次方法调用都通过 `ndk_context` 重新 attach 当前
/// 线程并查找 Kotlin 类；开销极小（JNI attach 对已 attached 的线程是 no-op），
/// 而且避免了跨线程持有 JNI local ref 的安全性问题。
pub struct MediaStateManagerAndroidBackend {
    /// 回调发送端，让 `new()` 的调用方拿到对应的 receiver。
    /// 实际数据由后台轮询线程通过 `pollCommand()` 喂入。
    _poll_handle: tokio::task::JoinHandle<()>,
}

impl Debug for MediaStateManagerAndroidBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MediaStateManagerAndroidBackend").finish()
    }
}

// MediaSessionHelper 的 Java 全限定类名
const HELPER_CLASS: &str = "net.stevexmh.amllplayer.MediaSessionHelper";

/// 获取一个可用的 JNI 环境。调用方必须保证在 Android 平台运行。
fn with_jni<F, R>(f: F) -> anyhow::Result<R>
where
    F: FnOnce(&mut jni::JNIEnv, jni::objects::JClass) -> anyhow::Result<R>,
{
    use jni::JavaVM;
    use jni::objects::JObject;

    let ctx = ndk_context::android_context();
    if ctx.vm().is_null() || ctx.context().is_null() {
        anyhow::bail!("Android JNI 环境尚未初始化");
    }
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| anyhow::anyhow!("attach JavaVM 失败: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| anyhow::anyhow!("attach 当前线程失败: {e}"))?;

    // 同 lib.rs 中的做法：通过 Activity 的 ClassLoader 加载业务类，
    // 否则工作线程的默认 class loader 找不到 app 的类。
    let class_loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .map_err(|e| anyhow::anyhow!("getClassLoader failed: {e}"))?
        .l()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let class_name = env
        .new_string(HELPER_CLASS)
        .map_err(|e| anyhow::anyhow!("new_string failed: {e}"))?;
    let helper_class_obj = env
        .call_method(
            &class_loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&class_name).into()],
        )
        .map_err(|e| anyhow::anyhow!("loadClass(MediaSessionHelper) failed: {e}"))?
        .l()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let helper_class: jni::objects::JClass = helper_class_obj.into();

    f(&mut env, helper_class)
}

/// 调用无参无返回值的静态方法。
fn call_void(method: &str) -> anyhow::Result<()> {
    with_jni(|env, cls| {
        env.call_static_method(&cls, method, "()V", &[])
            .map_err(|e| anyhow::anyhow!("call {method} failed: {e}"))?;
        Ok(())
    })
}

/// 调用接受一个 boolean 参数的静态方法。
fn call_void_bool(method: &str, val: bool) -> anyhow::Result<()> {
    with_jni(|env, cls| {
        env.call_static_method(&cls, method, "(Z)V", &[jni::objects::JValue::Bool(val as u8)])
            .map_err(|e| anyhow::anyhow!("call {method} failed: {e}"))?;
        Ok(())
    })
}

/// 调用接受一个 String 参数的静态方法。
fn call_void_string(method: &str, val: &str) -> anyhow::Result<()> {
    with_jni(|env, cls| {
        let jstr = env
            .new_string(val)
            .map_err(|e| anyhow::anyhow!("new_string: {e}"))?;
        env.call_static_method(
            &cls,
            method,
            "(Ljava/lang/String;)V",
            &[(&jstr).into()],
        )
        .map_err(|e| anyhow::anyhow!("call {method} failed: {e}"))?;
        Ok(())
    })
}

/// 调用接受一个 double 参数的静态方法。
fn call_void_double(method: &str, val: f64) -> anyhow::Result<()> {
    with_jni(|env, cls| {
        env.call_static_method(&cls, method, "(D)V", &[jni::objects::JValue::Double(val)])
            .map_err(|e| anyhow::anyhow!("call {method} failed: {e}"))?;
        Ok(())
    })
}

/// 调用 pollCommand() → String?
fn poll_command() -> anyhow::Result<Option<String>> {
    with_jni(|env, cls| {
        let result = env
            .call_static_method(&cls, "pollCommand", "()Ljava/lang/String;", &[])
            .map_err(|e| anyhow::anyhow!("call pollCommand failed: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("{e}"))?;

        if result.is_null() {
            return Ok(None);
        }
        let jstr = jni::objects::JString::from(result);
        let s: String = env
            .get_string(&jstr)
            .map(|s| s.into())
            .unwrap_or_default();
        if s.is_empty() {
            Ok(None)
        } else {
            Ok(Some(s))
        }
    })
}

impl MediaStateManagerBackend for MediaStateManagerAndroidBackend {
    fn new() -> anyhow::Result<(Self, UnboundedReceiver<MediaStateMessage>)> {
        // 初始化 Kotlin 侧 MediaSession
        call_void("init")?;
        info!("Android MediaSession 初始化完成");

        let (sx, rx) = tokio::sync::mpsc::unbounded_channel();

        // 启动后台线程轮询 Kotlin 命令队列
        let poll_handle = tokio::task::spawn_blocking(move || {
            loop {
                match poll_command() {
                    Ok(Some(cmd)) => {
                        if let Some(msg) = parse_command(&cmd)
                            && sx.send(msg).is_err()
                        {
                            // receiver 被 drop 了，退出轮询
                            break;
                        }
                    }
                    Ok(None) => {
                        // 没有命令，继续轮询
                    }
                    Err(e) => {
                        warn!("pollCommand 失败: {e:?}");
                        // 短暂休眠后重试，避免疯狂刷错误日志
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                }
            }
        });

        Ok((
            Self {
                _poll_handle: poll_handle,
            },
            rx,
        ))
    }

    fn set_enabled(&self, enabled: bool) -> anyhow::Result<()> {
        call_void_bool("setEnabled", enabled)
    }

    fn set_playing(&self, playing: bool) -> anyhow::Result<()> {
        call_void_bool("setPlaying", playing)
    }

    fn set_title(&self, title: &str) -> anyhow::Result<()> {
        call_void_string("setTitle", title)
    }

    fn set_artist(&self, artist: &str) -> anyhow::Result<()> {
        call_void_string("setArtist", artist)
    }

    fn set_cover_image(&self, cover_data: impl AsRef<[u8]>) -> anyhow::Result<()> {
        let data = cover_data.as_ref();
        with_jni(|env, cls| {
            let byte_array = env
                .new_byte_array(data.len() as i32)
                .map_err(|e| anyhow::anyhow!("new_byte_array: {e}"))?;
            env.set_byte_array_region(&byte_array, 0, bytemuck_cast_u8_to_i8(data))
                .map_err(|e| anyhow::anyhow!("set_byte_array_region: {e}"))?;
            env.call_static_method(&cls, "setCoverImage", "([B)V", &[(&byte_array).into()])
                .map_err(|e| anyhow::anyhow!("call setCoverImage failed: {e}"))?;
            Ok(())
        })
    }

    fn set_duration(&self, duration: f64) -> anyhow::Result<()> {
        call_void_double("setDuration", duration)
    }

    fn set_position(&self, position: f64) -> anyhow::Result<()> {
        call_void_double("setPosition", position)
    }

    fn update(&self) -> anyhow::Result<()> {
        call_void("updateMetadata")
    }
}

/// 把 `&[u8]` 安全地转为 `&[i8]` 以满足 JNI `set_byte_array_region` 的签名。
fn bytemuck_cast_u8_to_i8(data: &[u8]) -> &[i8] {
    // SAFETY: u8 和 i8 有相同的大小和对齐方式，reinterpret 是安全的。
    unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<i8>(), data.len()) }
}

/// 解析从 Kotlin `pollCommand()` 拿到的字符串命令。
fn parse_command(cmd: &str) -> Option<MediaStateMessage> {
    if cmd == "play" {
        Some(MediaStateMessage::Play)
    } else if cmd == "pause" {
        Some(MediaStateMessage::Pause)
    } else if cmd == "next" {
        Some(MediaStateMessage::Next)
    } else if cmd == "previous" {
        Some(MediaStateMessage::Previous)
    } else if cmd == "recreate" {
        Some(MediaStateMessage::RecreateStream)
    } else if cmd == "dirty" {
        Some(MediaStateMessage::StreamMaybeDirty)
    } else if let Some(pos_str) = cmd.strip_prefix("seek:") {
        pos_str.parse::<f64>().ok().map(MediaStateMessage::Seek)
    } else {
        warn!("未知的媒体命令: {cmd}");
        None
    }
}
