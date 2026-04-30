import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import type { EntityTable } from "dexie";
import Dexie from "dexie";

export interface Playlist {
	id: number;
	name: string;
	playlistCover?: Blob;
	createTime: number;
	updateTime: number;
	playTime: number;
	songIds: string[];
	/**
	 * 若该歌单是通过 Android「扫描指定文件夹建立索引」方式创建的，
	 * 这里会保存当时选定的 SAF tree URI（形如 `content://...tree/...`）。
	 *
	 * 后续在歌单详情页可以拿它再次调用 `scan_audio_in_tree_uri`
	 * 重新枚举原目录下的音频文件，从而把新增 / 改名的歌曲增量同步进来。
	 *
	 * 字段未填表示该歌单不是文件夹扫描来源的，刷新按钮也不会显示。
	 */
	folderScanTreeUri?: string;
	/** 配 `folderScanTreeUri`：false=仅本层，true/undefined=递归。 */
	folderScanRecursive?: boolean;
	/** 旧版 Android 歌单页本地歌词优先设置，现由全局歌词库优先级接管。 */
	localLyricFirst?: boolean;
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
	translatedLrc?: string;
	romanLrc?: string;
}

export interface TTMLDBLyricEntry {
	name: string;
	content: TTMLLyric;
	raw: string;
}

export const db = new Dexie("amll-player") as Dexie & {
	playlists: EntityTable<Playlist, "id">;
	songs: EntityTable<Song, "id">;
	ttmlDB: EntityTable<TTMLDBLyricEntry, "name">;
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
