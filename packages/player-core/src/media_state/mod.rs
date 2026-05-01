use std::fmt::Debug;

use tokio::sync::mpsc::UnboundedReceiver;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "android")]
mod android;

pub enum MediaStateMessage {
    Play,
    Pause,
    PlayOrPause,
    Seek(f64),
    Next,
    Previous,
    /// 要求立即重建底层音频输出流。
    ///
    /// 跨平台通用命令，目前由 Android backend 在音频焦点恢复时主动触发
    /// （Oboe/AAudio 焦点丢失后流会被系统断开且不会自愈）。其他后端若遇到
    /// 类似的外部中断（如桌面端音频设备热插拔），也可以发送此消息恢复。
    RecreateStream,
    /// 标记底层流可能已失效（通常在焦点丢失时发）。
    ///
    /// 与 `RecreateStream` 的区别：此命令**不立即**重建，仅打脏标。等到下一次
    /// `Play` / `PlayAudio` / `ResumeAudio` 真的需要出声时才重建，避免在没拿到
    /// 焦点的空窗期反复创建注定失败的流。
    StreamMaybeDirty,
}

pub(super) trait MediaStateManagerBackend: Sized + Send + Sync + Debug {
    fn new() -> anyhow::Result<(Self, UnboundedReceiver<MediaStateMessage>)>;
    fn set_enabled(&self, enabled: bool) -> anyhow::Result<()>;
    fn set_playing(&self, playing: bool) -> anyhow::Result<()>;
    fn set_title(&self, title: &str) -> anyhow::Result<()>;
    fn set_artist(&self, artist: &str) -> anyhow::Result<()>;
    fn set_cover_image(&self, cover_data: impl AsRef<[u8]>) -> anyhow::Result<()>;
    fn set_duration(&self, duration: f64) -> anyhow::Result<()>;
    fn set_position(&self, position: f64) -> anyhow::Result<()>;
    fn update(&self) -> anyhow::Result<()>;
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "android")))]
#[derive(Debug)]
pub struct EmptyMediaStateManager;

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "android")))]
impl MediaStateManagerBackend for EmptyMediaStateManager {
    fn new() -> anyhow::Result<(Self, UnboundedReceiver<MediaStateMessage>)> {
        Ok((Self, tokio::sync::mpsc::unbounded_channel().1))
    }

    fn set_enabled(&self, _enabled: bool) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_playing(&self, _playing: bool) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_title(&self, _title: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_artist(&self, _artist: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_cover_image(&self, _cover_data: impl AsRef<[u8]>) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_duration(&self, _duration: f64) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_position(&self, _position: f64) -> anyhow::Result<()> {
        Ok(())
    }

    fn update(&self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub type MediaStateManager = windows::MediaStateManagerWindowsBackend;
#[cfg(target_os = "macos")]
pub type MediaStateManager = macos::MediaStateManagerMacOSBackend;
#[cfg(target_os = "android")]
pub type MediaStateManager = android::MediaStateManagerAndroidBackend;
#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "android")))]
pub type MediaStateManager = EmptyMediaStateManager;
