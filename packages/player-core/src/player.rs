use std::{
    fmt::Debug,
    fs::File,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use super::fft_player::FFTPlayer;
use crate::{
    AudioPlayerEventReceiver, AudioPlayerEventSender, AudioPlayerMessageReceiver,
    AudioPlayerMessageSender, AudioThreadEvent, AudioThreadEventMessage, AudioThreadMessage,
    SongData,
    audio_quality::AudioQuality,
    ffmpeg_decoder::{FFmpegDecoder, FFmpegDecoderHandle},
    media_state::{MediaStateManager, MediaStateManagerBackend, MediaStateMessage},
};
use anyhow::{Context, anyhow};
use parking_lot::RwLock as ParkingLotRwLock;
use rodio::{OutputStream, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock as TokioRwLock;
use tokio::{
    sync::mpsc::{UnboundedReceiver, UnboundedSender},
    task::JoinHandle,
};
use tracing::{info, warn};

pub struct AudioPlayer {
    evt_sender: AudioPlayerEventSender,
    evt_receiver: AudioPlayerEventReceiver,
    msg_sender: AudioPlayerMessageSender,
    msg_receiver: AudioPlayerMessageReceiver,
    sink: Arc<Sink>,
    current_decoder_handle: Option<FFmpegDecoderHandle>,
    stream_handle: OutputStream,
    volume: f64,
    current_song: Option<SongData>,
    current_audio_info: Arc<TokioRwLock<AudioInfo>>,
    current_samples_counter: Arc<TokioRwLock<Option<Arc<AtomicU64>>>>,

    current_audio_quality: Arc<TokioRwLock<AudioQuality>>,
    play_pos_sx: UnboundedSender<(bool, Option<f64>)>,
    tasks: Vec<JoinHandle<()>>,
    media_state_manager: Option<Arc<MediaStateManager>>,
    media_state_rx: Option<UnboundedReceiver<MediaStateMessage>>,
    fft_player: Arc<ParkingLotRwLock<FFTPlayer>>,

    fft_broadcast_task: Option<JoinHandle<()>>,
    target_channels: u16,
    target_sample_rate: u32,
    /// 最近一次已播到的位置（秒 × 1000，毫秒整数），由进度任务更新。
    /// `recreate_stream` 用它在重建完输出流后把曲目 seek 回原处。
    current_position_millis: Arc<AtomicU64>,
    /// 底层输出流可能已失效（典型场景：Android 焦点丢失后 Oboe 断流，
    /// 桌面端音频设备被拔出/切换）。为 true 时下次 Play/PlayAudio/ResumeAudio
    /// 会先自动重建再继续。各后端按需通过 `StreamMaybeDirty` 消息打标。
    stream_dirty: Arc<AtomicBool>,
}

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub name: String,
    pub artist: String,
    pub album: String,
    pub lyric: String,
    #[serde(skip)]
    pub cover_media_type: String,
    #[serde(skip)]
    pub cover: Option<Vec<u8>>,
    pub comment: String,
    pub duration: f64,
    pub position: f64,
}

impl Debug for AudioInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioInfo")
            .field("name", &self.name)
            .field("artist", &self.artist)
            .field("album", &self.album)
            .field("lyric", &self.lyric)
            .field("cover_media_type", &self.cover_media_type)
            .field("cover", &self.cover.as_ref().map(|x| x.len()))
            .field("comment", &self.comment)
            .field("duration", &self.duration)
            .field("position", &self.position)
            .finish()
    }
}

pub type CustomSongLoaderReturn =
    Box<dyn futures::Future<Output = anyhow::Result<Box<dyn Source<Item = f32> + Send>>> + Send>;
pub type CustomSongLoaderFn = Box<dyn Fn(String) -> CustomSongLoaderReturn + Send + Sync>;
pub type LocalSongLoaderReturn = Box<dyn futures::Future<Output = anyhow::Result<File>> + Send>;
pub type LocalSongLoaderFn = Box<dyn Fn(String) -> LocalSongLoaderReturn + Send + Sync>;

pub struct AudioPlayerConfig {}

impl AudioPlayer {
    pub fn new(_config: AudioPlayerConfig, handle: OutputStream) -> Self {
        let (evt_sender, evt_receiver) = tokio::sync::mpsc::unbounded_channel();
        let (msg_sender, msg_receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink = Arc::new(Sink::connect_new(handle.mixer()));

        sink.pause();

        let stream_config = handle.config();
        let target_channels = stream_config.channel_count();
        let target_sample_rate = stream_config.sample_rate();

        info!("音频输出设备 声道数:{target_channels}, 采样率:{target_sample_rate}");

        let current_audio_info = Arc::new(TokioRwLock::new(AudioInfo::default()));
        let current_samples_counter: Arc<TokioRwLock<Option<Arc<AtomicU64>>>> =
            Arc::new(TokioRwLock::new(None));
        let current_audio_quality = Arc::new(TokioRwLock::new(AudioQuality::default()));
        let fft_player = Arc::new(ParkingLotRwLock::new(FFTPlayer::new()));

        let mut tasks = Vec::new();

        let (media_state_manager, media_state_rx) = match MediaStateManager::new() {
            Ok((manager, ms_rx)) => (Some(Arc::new(manager)), Some(ms_rx)),
            Err(err) => {
                tracing::warn!("初始化媒体状态管理器时出错：{err:?}");
                (None, None)
            }
        };

        let audio_info_reader = current_audio_info.clone();
        let samples_counter_reader = current_samples_counter.clone();
        let emitter_pos = AudioPlayerEventEmitter::new(evt_sender.clone());
        let (play_pos_sx, mut play_pos_rx) =
            tokio::sync::mpsc::unbounded_channel::<(bool, Option<f64>)>();
        let media_state_manager_clone = media_state_manager.clone();
        let current_position_millis = Arc::new(AtomicU64::new(0));
        let position_writer = current_position_millis.clone();

        tasks.push(tokio::task::spawn(async move {
            let mut time_it = tokio::time::interval(Duration::from_secs(1));

            let mut is_playing = false;
            let mut base_time = 0.0;
            let mut local_current_pos = 0.0;

            loop {
                tokio::select! {
                    msg = play_pos_rx.recv() => {
                        if let Some((new_is_playing, new_base_time_opt)) = msg {
                            is_playing = new_is_playing;

                            if let Some(new_base_time) = new_base_time_opt {
                                base_time = new_base_time;
                                local_current_pos = base_time;
                                position_writer.store(
                                    (local_current_pos * 1000.0) as u64,
                                    Ordering::Relaxed,
                                );

                                let _ = emitter_pos
                                    .emit(AudioThreadEvent::PlayPosition {
                                        position: base_time,
                                    })
                                    .await;
                            }

                            if is_playing
                                && let Some(manager) = &media_state_manager_clone
                                && let Err(e) = manager.set_position(local_current_pos)
                            {
                                warn!("更新系统媒体控件进度失败: {e:?}");
                            }
                        } else {
                            break;
                        }
                    }

                    _ = time_it.tick() => {
                        if is_playing {
                            let duration = audio_info_reader.read().await.duration;
                            if duration > 0.0 {
                                let played_time = if let Some(counter) = samples_counter_reader.read().await.as_ref() {
                                    let samples = counter.load(Ordering::Relaxed) as f64;
                                    let rate = target_sample_rate as f64;
                                    let ch = target_channels as f64;
                                    samples / (rate * ch)
                                } else {
                                    0.0
                                };

                                local_current_pos = (base_time + played_time).min(duration);
                                position_writer.store(
                                    (local_current_pos * 1000.0) as u64,
                                    Ordering::Relaxed,
                                );

                                let _ = emitter_pos
                                    .emit(AudioThreadEvent::PlayPosition {
                                        position: local_current_pos,
                                    })
                                    .await;

                                if let Some(manager) = &media_state_manager_clone
                                    && let Err(e) = manager.set_position(local_current_pos) {
                                        tracing::warn!("更新系统媒体控件进度失败: {e:?}");
                                    }
                            }
                        }
                    }
                }
            }
        }));

        let fft_player_clone = fft_player.clone();
        let emitter_clone = AudioPlayerEventEmitter::new(evt_sender.clone());
        let fft_broadcast_task = Some(tokio::task::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            let mut fft_buffer = vec![0.0; 128];

            loop {
                interval.tick().await;

                let data_to_send: Option<Vec<f32>> = {
                    if let Some(mut player) = fft_player_clone.try_write() {
                        if player.has_data() && player.read(&mut fft_buffer) {
                            Some(fft_buffer.clone())
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                if let Some(data) = data_to_send {
                    let _ = emitter_clone.emit(AudioThreadEvent::FFTData { data }).await;
                }
            }
        }));

        Self {
            evt_sender,
            evt_receiver,
            msg_sender,
            msg_receiver,
            stream_handle: handle,
            sink,
            current_decoder_handle: None,
            volume: 1.0,
            current_song: None,
            current_audio_info,
            current_samples_counter,
            current_audio_quality,
            play_pos_sx,
            tasks,
            media_state_manager,
            media_state_rx,
            fft_player,
            fft_broadcast_task,
            target_channels,
            target_sample_rate,
            current_position_millis,
            stream_dirty: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn handler(&self) -> AudioPlayerHandle {
        AudioPlayerHandle::new(self.msg_sender.clone())
    }

    fn emitter(&self) -> AudioPlayerEventEmitter {
        AudioPlayerEventEmitter::new(self.evt_sender.clone())
    }

    async fn update_media_manager_metadata(&self) -> anyhow::Result<()> {
        if let Some(manager) = self.media_state_manager.as_ref() {
            let audio_info = self.current_audio_info.read().await;
            manager.set_title(&audio_info.name)?;
            manager.set_artist(&audio_info.artist)?;
            manager.set_duration(audio_info.duration)?;
            if let Some(cover_data) = &audio_info.cover {
                manager.set_cover_image(cover_data)?;
            } else {
                manager.set_cover_image(&[] as &[u8])?;
            }
            manager.update()?;
        }
        Ok(())
    }

    async fn update_media_manager_playback_state(&self, is_playing: bool) -> anyhow::Result<()> {
        if let Some(manager) = self.media_state_manager.as_ref() {
            manager.set_playing(is_playing)?;
        }
        Ok(())
    }

    pub async fn run(
        mut self,
        on_event: impl Fn(AudioThreadEventMessage<AudioThreadEvent>) + Send + 'static,
    ) {
        let mut check_end_interval = tokio::time::interval(Duration::from_millis(50));

        loop {
            let media_state_fut = async {
                if let Some(rx) = self.media_state_rx.as_mut() {
                    rx.recv().await
                } else {
                    futures::future::pending().await
                }
            };

            tokio::select! {
                biased;
                msg = self.msg_receiver.recv() => {
                    if let Some(msg) = msg {
                        if let Some(AudioThreadMessage::Close) = &msg.data { break; }
                        if let Err(err) = self.process_message(msg).await {
                            warn!("处理音频线程消息时出错：{err:?}");
                        }
                    } else { break; }
                },
                msg = media_state_fut => {
                    if let Some(msg) = msg {
                        self.on_media_state_msg(msg).await;
                    } else {
                        self.media_state_rx = None;
                    }
                }
                evt = self.evt_receiver.recv() => {
                    if let Some(evt) = evt { on_event(evt); }
                    else { break; }
                }
                _ = check_end_interval.tick() => {
                    if self.sink.empty() && !self.sink.is_paused() && self.current_song.is_some() {
                        let _ = self.play_pos_sx.send((false, Some(0.0)));
                        self.current_song = None;

                        if let Err(e) = self.emitter().emit(AudioThreadEvent::TrackEnded).await {
                            warn!("发送 TrackEnded 事件失败：{e:?}");
                        }
                    }
                }
            }
        }
    }

    pub async fn on_media_state_msg(&mut self, msg: MediaStateMessage) {
        let handler = self.handler();
        let result = match msg {
            MediaStateMessage::Play => {
                handler
                    .send_anonymous(AudioThreadMessage::ResumeAudio)
                    .await
            }
            MediaStateMessage::Pause => {
                handler.send_anonymous(AudioThreadMessage::PauseAudio).await
            }
            MediaStateMessage::PlayOrPause => {
                handler
                    .send_anonymous(AudioThreadMessage::ResumeOrPauseAudio)
                    .await
            }
            MediaStateMessage::Next => {
                self.emitter()
                    .emit(AudioThreadEvent::HardwareMediaCommand {
                        command: "next".into(),
                    })
                    .await
            }
            MediaStateMessage::Previous => {
                self.emitter()
                    .emit(AudioThreadEvent::HardwareMediaCommand {
                        command: "prev".into(),
                    })
                    .await
            }
            MediaStateMessage::Seek(pos) => {
                handler
                    .send_anonymous(AudioThreadMessage::SeekAudio { position: pos })
                    .await
            }
            MediaStateMessage::RecreateStream => {
                // 重建流是需要持有 &mut self 的重活，直接在这里干，不走消息队列
                if let Err(e) = self.recreate_stream().await {
                    warn!("重建音频输出流失败: {e:?}");
                }
                Ok(())
            }
            MediaStateMessage::StreamMaybeDirty => {
                // 只打标，真正的重建推迟到下一次 Play/Resume/PlayAudio 时做，
                // 避免在还没拿回焦点时就反复尝试新建 Oboe 流。
                self.stream_dirty.store(true, Ordering::Relaxed);
                Ok(())
            }
        };
        if let Err(e) = result {
            warn!("发送媒体状态消息失败: {e:?}");
        }
    }

    /// 仅替换 `stream_handle` 和 `sink`，不重载歌曲。
    /// 用于紧接着就会调用 `start_playing_song(true)` 的路径（例如 `PlayAudio`），
    /// 避免重复解码老歌浪费 CPU。
    async fn recreate_stream_only(&mut self) -> anyhow::Result<()> {
        info!("正在重建音频输出流（不重载歌曲）");
        self.stream_dirty.store(false, Ordering::Relaxed);

        self.sink.stop();
        let new_stream = OutputStreamBuilder::open_default_stream()
            .context("重建 OutputStream 失败")?;
        self.stream_handle = new_stream;
        self.sink = Arc::new(Sink::connect_new(self.stream_handle.mixer()));
        self.sink.set_volume(self.volume as f32);
        self.current_decoder_handle = None;
        Ok(())
    }

    /// 重建底层 `OutputStream` 与 `Sink`，保留当前歌曲和播放位置。
    ///
    /// 典型触发场景：Android 焦点丢失/音频设备切换后 Oboe 流被断开；桌面端也
    /// 可能在默认输出设备变更时遇到旧流失声。重建后当前曲目会以**暂停**状态
    /// 重新就位（seek 回原位置），上层据 `PlayStatus` 决定是否再发 `Play`。
    pub async fn recreate_stream(&mut self) -> anyhow::Result<()> {
        info!("正在重建音频输出流");
        self.stream_dirty.store(false, Ordering::Relaxed);

        let saved_position_secs =
            self.current_position_millis.load(Ordering::Relaxed) as f64 / 1000.0;
        let saved_song = self.current_song.clone();

        // 先停掉老的 sink，这样残余回调不会写到即将被丢弃的 mixer。
        self.sink.stop();

        // 让旧 OutputStream 先被 drop，再申请新的。
        // 某些后端（Oboe、部分 WASAPI exclusive mode）对同一 app 同时打开
        // 两个输出流会拒绝服务，所以顺序不能反。
        let new_stream = OutputStreamBuilder::open_default_stream()
            .context("重建 OutputStream 失败")?;
        self.stream_handle = new_stream;

        self.sink = Arc::new(Sink::connect_new(self.stream_handle.mixer()));
        self.sink.set_volume(self.volume as f32);
        self.sink.pause();
        self.current_decoder_handle = None;

        if let Some(song) = saved_song {
            self.current_song = Some(song);
            // 重新装载曲目（解码器 + 新 sink），内部会 append 并把 sink 置为播放态
            self.start_playing_song(false).await?;
            // 立即暂停：恢复播放由上层根据用户意图决定
            self.sink.pause();
            // 尽量恢复原播放位置
            if saved_position_secs > 0.0
                && let Some(handle) = &self.current_decoder_handle
                && handle
                    .seek(Duration::from_secs_f64(saved_position_secs))
                    .is_ok()
            {
                if let Some(counter) = self.current_samples_counter.read().await.as_ref() {
                    counter.store(0, Ordering::SeqCst);
                }
                let _ = self
                    .play_pos_sx
                    .send((false, Some(saved_position_secs)));
            }
            self.update_media_manager_playback_state(false).await?;
            let _ = self
                .emitter()
                .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                .await;
        }

        info!("音频输出流已重建完毕，位置={saved_position_secs:.2}s");
        Ok(())
    }

    pub async fn process_message(
        &mut self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        let emitter = self.emitter();
        if let Some(ref data) = msg.data {
            match data {
                AudioThreadMessage::ResumeAudio => {
                    // 脏标志由 backend 打上（例如 Android 音频焦点丢失、桌面端
                    // 设备变更），表示底层流已经不可信。此时直接 sink.play()
                    // 会静默失败，所以先重建再继续。desktop 上该分支常年为 false。
                    if self.stream_dirty.load(Ordering::Relaxed)
                        && let Err(e) = self.recreate_stream().await
                    {
                        warn!("ResumeAudio 前重建流失败: {e:?}");
                    }
                    self.sink.play();
                    let _ = self.play_pos_sx.send((true, None));
                    self.update_media_manager_playback_state(true).await?;
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: true })
                        .await;
                }
                AudioThreadMessage::PauseAudio => {
                    self.sink.pause();
                    let _ = self.play_pos_sx.send((false, None));
                    self.update_media_manager_playback_state(false).await?;
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus { is_playing: false })
                        .await;
                }
                AudioThreadMessage::ResumeOrPauseAudio => {
                    let was_paused = self.sink.is_paused();
                    if was_paused {
                        self.sink.play();
                    } else {
                        self.sink.pause();
                    }

                    let is_playing_now = was_paused;
                    let _ = self.play_pos_sx.send((is_playing_now, None));
                    self.update_media_manager_playback_state(is_playing_now)
                        .await?;
                    let _ = emitter
                        .emit(AudioThreadEvent::PlayStatus {
                            is_playing: is_playing_now,
                        })
                        .await;
                }
                AudioThreadMessage::SeekAudio { position } => {
                    if let Some(handle) = &self.current_decoder_handle {
                        let seek_pos = Duration::from_secs_f64(*position);

                        if handle.seek(seek_pos).is_err() {
                            warn!("发送跳转命令失败, 解码器可能已关闭");
                        } else {
                            if let Some(counter) =
                                self.current_samples_counter.read().await.as_ref()
                            {
                                counter.store(0, Ordering::SeqCst);
                            }

                            let fft_player_clone = self.fft_player.clone();
                            tokio::task::spawn_blocking(move || {
                                fft_player_clone.write().clear();
                            })
                            .await?;
                            let is_playing = !self.sink.is_paused();
                            let _ = self.play_pos_sx.send((is_playing, Some(*position)));
                            self.update_media_manager_playback_state(is_playing).await?;
                        }
                    } else {
                        warn!("找不到解码器句柄, 无法执行跳转");
                    }
                }
                AudioThreadMessage::PlayAudio { song } => {
                    // 切歌时如果流是脏的（如前端在 Android 焦点丢失期间点了别的歌），
                    // 先替换 OutputStream 再走常规加载；否则 start_playing_song
                    // 里新建的 sink 仍然接在一个死 mixer 上，照样没声。
                    if self.stream_dirty.load(Ordering::Relaxed)
                        && let Err(e) = self.recreate_stream_only().await
                    {
                        warn!("PlayAudio 前重建流失败: {e:?}");
                    }
                    self.current_song = Some(song.clone());
                    self.start_playing_song(true).await?;
                }
                AudioThreadMessage::SetVolume { volume } => {
                    self.volume = volume.clamp(0.0, 1.0);
                    self.sink.set_volume(self.volume as f32);
                    let _ = emitter
                        .emit(AudioThreadEvent::VolumeChanged {
                            volume: self.volume,
                        })
                        .await;
                }
                AudioThreadMessage::SetFFTRange { from_freq, to_freq } => {
                    let fft_player_clone = self.fft_player.clone();
                    let (from_freq, to_freq) = (*from_freq, *to_freq);
                    tokio::task::spawn_blocking(move || {
                        fft_player_clone.write().set_freq_range(from_freq, to_freq);
                    })
                    .await?;
                }
                AudioThreadMessage::SetMediaControlsEnabled { enabled } => {
                    if let Some(manager) = self.media_state_manager.as_ref()
                        && let Err(e) = manager.set_enabled(*enabled)
                    {
                        warn!("设置媒体控制启用状态失败: {e:?}");
                    }
                }
                _ => {}
            }
        }
        emitter.ret_none(msg).await?;
        Ok(())
    }

    async fn start_playing_song(&mut self, clear_sink: bool) -> anyhow::Result<()> {
        if clear_sink {
            self.sink.stop();

            let fft_player_clone = self.fft_player.clone();
            tokio::task::spawn_blocking(move || {
                fft_player_clone.write().clear();
            })
            .await?;

            self.sink = Arc::new(Sink::connect_new(self.stream_handle.mixer()));
            self.sink.set_volume(self.volume as f32);
            self.current_decoder_handle = None;
        }

        let song_data = self.current_song.clone().context("没有当前歌曲可播放")?;
        let file_path = match &song_data {
            SongData::Local { file_path, .. } => file_path.clone(),
            _ => return Err(anyhow!("当前实现仅支持本地文件")),
        };

        let target_channels = self.target_channels;
        let target_sample_rate = self.target_sample_rate;

        let fft_player_clone = self.fft_player.clone();
        let file_path_clone = file_path.clone();

        let source_result = tokio::task::spawn_blocking(move || {
            FFmpegDecoder::new(
                file_path_clone,
                fft_player_clone,
                target_channels,
                target_sample_rate,
            )
        })
        .await?;

        let (source, handle, samples_counter) = source_result?;
        self.current_decoder_handle = Some(handle);
        *self.current_samples_counter.write().await = Some(samples_counter);

        let info = source.audio_info();
        let quality = source.audio_quality();

        *self.current_audio_info.write().await = info.clone();
        *self.current_audio_quality.write().await = quality.clone();

        self.sink.append(source);
        self.update_media_manager_metadata().await?;

        let is_playing = !self.sink.is_paused();
        self.update_media_manager_playback_state(is_playing).await?;
        let _ = self.play_pos_sx.send((is_playing, Some(0.0)));

        let status_event = AudioThreadEvent::LoadAudio {
            music_id: song_data.get_id(),
            music_info: Box::new(info),
            quality,
        };
        self.emitter().emit(status_event).await?;
        self.emitter()
            .emit(AudioThreadEvent::PlayStatus { is_playing })
            .await?;

        Ok(())
    }
}

impl Drop for AudioPlayer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        if let Some(handle) = self.fft_broadcast_task.take() {
            handle.abort();
        }
    }
}

#[derive(Debug, Clone)]
pub struct AudioPlayerHandle {
    msg_sender: AudioPlayerMessageSender,
}
impl AudioPlayerHandle {
    pub(crate) fn new(msg_sender: AudioPlayerMessageSender) -> Self {
        Self { msg_sender }
    }
    pub async fn send(
        &self,
        msg: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.msg_sender.send(msg)?;
        Ok(())
    }
    pub async fn send_anonymous(&self, msg: AudioThreadMessage) -> anyhow::Result<()> {
        self.msg_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AudioPlayerEventEmitter {
    evt_sender: AudioPlayerEventSender,
}
impl AudioPlayerEventEmitter {
    pub(crate) fn new(evt_sender: AudioPlayerEventSender) -> Self {
        Self { evt_sender }
    }
    pub async fn emit(&self, msg: AudioThreadEvent) -> anyhow::Result<()> {
        self.evt_sender
            .send(AudioThreadEventMessage::new("".into(), Some(msg)))?;
        Ok(())
    }
    pub async fn ret_none(
        &self,
        req: AudioThreadEventMessage<AudioThreadMessage>,
    ) -> anyhow::Result<()> {
        self.evt_sender.send(req.to_none())?;
        Ok(())
    }
}
