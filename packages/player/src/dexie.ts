import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import type { EntityTable } from "dexie";
import Dexie from "dexie";
import type {
	LyricSourceConfig,
	SongLyricSourceInfo,
} from "./utils/lyricSources.ts";

export interface Playlist {
	id: number;
	name: string;
	playlistCover?: Blob;
	createTime: number;
	updateTime: number;
	playTime: number;
	songIds: string[];
	folderScanTreeUri?: string;
	folderScanRecursive?: boolean;
	lyricSources?: LyricSourceConfig[];
}

export interface Song {
	id: string;
	filePath: string;
	songName: string;
	songArtists: string;
	songAlbum: string;
	cover: Blob;
	cachedThumbnail?: Blob;
	duration: number;
	lyricFormat: string;
	lyric: string;
	lyricSource?: SongLyricSourceInfo;
	translatedLrc?: string;
	romanLrc?: string;
}

export interface TTMLDBLyricEntry {
	name: string;
	content: TTMLLyric;
	raw: string;
}

/**
 * 单首歌的歌词时间轴偏移（毫秒）。
 * 用途：杜比全景声 / 编码前导静音 (priming sample) 等导致音频时间轴比 TTML
 * 标记时间晚一段。+offsetMs 表示「歌词整体往后推」（用于音频比歌词慢的情况）。
 *
 * Key 由 `(packageName | title | artist | album | durationBucketSec)` 构造，
 * 其中 durationBucketSec = round(duration / 1000)，让同一首歌的 Atmos / 立体声
 * 两个版本（典型差 1.3s）落在不同 key 上分别记录。
 */
export interface LyricOffsetEntry {
	key: string;
	offsetMs: number;
	updateTime: number;
}

export const db = new Dexie("amll-player") as Dexie & {
	playlists: EntityTable<Playlist, "id">;
	songs: EntityTable<Song, "id">;
	ttmlDB: EntityTable<TTMLDBLyricEntry, "name">;
	lyricOffsets: EntityTable<LyricOffsetEntry, "key">;
};

db.version(1).stores({
	playlists: "++id,name,createTime,updateTime,playTime",
	songs: "&id,filePath,songName,songArtists",
	ttmlDB: "&name",
});

db.version(2).upgrade((trans) => {
	trans
		.table("songs")
		.toCollection()
		.modify((song) => {
			const raw = Uint8Array.from(atob(song.cover), (c) => c.charCodeAt(0));
			song.cover = new Blob([raw], { type: "image" });
		});
});

db.version(3).upgrade((trans) => {
	trans
		.table("songs")
		.toCollection()
		.modify((song) => {
			song.songAlbum = "";
			song.lyricFormat = "";
		});
});

// v4: 新增 lyricOffsets 表，用于存储每首歌的歌词时间轴偏移（毫秒），
// 主要用于补偿杜比全景声 m4a 的 encoder priming 前导静音（典型 1.0-1.3s）。
// 详见 LyricOffsetEntry 接口注释。
db.version(4).stores({
	lyricOffsets: "&key,updateTime",
});
