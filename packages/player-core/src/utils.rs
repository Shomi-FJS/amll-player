use crate::AudioInfo;
use ffmpeg_next as ffmpeg;

pub fn read_audio_info(input_ctx: &mut ffmpeg::format::context::Input) -> AudioInfo {
    let mut new_audio_info = AudioInfo::default();

    let metadata = input_ctx.metadata();
    if let Some(title) = metadata.get("title") {
        new_audio_info.name = title.to_string();
    }
    if let Some(artist) = metadata.get("artist") {
        new_audio_info.artist = artist.to_string();
    }
    if let Some(album) = metadata.get("album") {
        new_audio_info.album = album.to_string();
    }
    if let Some(lyrics) = metadata.get("lyrics") {
        new_audio_info.lyric = lyrics.to_string();
    }
    if let Some(comment) = metadata.get("comment") {
        new_audio_info.comment = comment.to_string();
    }

    // 先用 streams() 扫一遍 disposition：没有 ATTACHED_PIC 流就根本不用进
    // packets() 循环——否则会把整首歌全部 demux 完（Android FUSE 上 3 首
    // FLAC 并发 30+ 秒卡顿的元凶）。`packets()` 不受 probesize 限制，
    // 没有 ATTACHED_PIC 的文件会读到 EOF 才停。
    let has_attached_pic = input_ctx.streams().any(|s| {
        s.disposition()
            .contains(ffmpeg::format::stream::Disposition::ATTACHED_PIC)
    });

    if has_attached_pic {
        // 有 ATTACHED_PIC 流：只要拿到第一个属于该 stream 的 packet 就退出，
        // 不会把整首歌 demux 完——ffmpeg 的 av_read_frame 对 ATTACHED_PIC
        // 默认把图放在最前面几个 packet 里。
        'outer: for (stream, packet) in input_ctx.packets() {
            if stream
                .disposition()
                .contains(ffmpeg::format::stream::Disposition::ATTACHED_PIC)
                && let Some(data) = packet.data()
            {
                new_audio_info.cover = Some(data.to_vec());
                let codec_name = ffmpeg::codec::decoder::find(stream.parameters().id())
                    .map(|d| d.name().to_string())
                    .unwrap_or("unknown".to_string());
                new_audio_info.cover_media_type = format!("image/{}", codec_name.to_lowercase());
                break 'outer;
            }
        }
        input_ctx.seek(0, ..).ok();
    }

    new_audio_info
}
