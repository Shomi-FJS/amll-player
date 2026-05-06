import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import { db, type Song, type TTMLDBLyricEntry } from "../dexie.ts";

/**
 * 基于 TTML `<amll:meta>` 元数据的评分匹配。
 *
 * 同名歌词由 read_local_music_metadata 处理；amll-ttml-db 命名以
 * 「歌名 - 歌手」或 ISRC 为主，本地音频文件名往往不一致（带音轨号/专辑等），
 * 因此需要按元数据打分匹配。阈值 MATCH_THRESHOLD 避免误挂歌词。
 */

export interface MatchedTTML {
	entry: TTMLDBLyricEntry;
	score: number;
}

const MATCH_THRESHOLD = 120;

/** 去括号注解、统一大小写、压缩空白后用于评分比对。 */
function normalizeForMatch(input: string | undefined | null): string {
	if (!input) return "";
	return (
		input
			.toLowerCase()
			// 去掉 (Live) / [Remastered] / 【翻唱】 这类注解。
			.replace(/[(（[【].*?[)）\]】]/g, " ")
			// 标点统一成空格。
			.replace(/[\s\-_/\\.,，。!?！？:：;；'"`~]+/g, " ")
			.trim()
	);
}

/** 把「张XX/王XX, Eason」这类多艺术家串拆成数组。 */
function splitArtists(input: string | undefined | null): string[] {
	if (!input) return [];
	return input
		.split(/[/、,，;；&]/g)
		.map((s) => normalizeForMatch(s))
		.filter((s) => s.length > 0);
}

interface TTMLMeta {
	name: string;
	artists: string[];
	album: string;
}

const metaCache = new WeakMap<TTMLDBLyricEntry, TTMLMeta>();

/** 抽出 TTML 元数据并归一化；按对象引用缓存，避免每次匹配重复计算。 */
export function extractTTMLMeta(entry: TTMLDBLyricEntry): TTMLMeta {
	const cached = metaCache.get(entry);
	if (cached) return cached;
	const result: TTMLMeta = {
		name: "",
		artists: [],
		album: "",
	};
	const ttml: TTMLLyric = entry.content;
	if (!ttml || !Array.isArray(ttml.metadata)) {
		metaCache.set(entry, result);
		return result;
	}
	for (const [k, v] of ttml.metadata) {
		if (!Array.isArray(v) || v.length === 0) continue;
		switch (k) {
			case "musicName":
				result.name = normalizeForMatch(v[0]);
				break;
			case "artists":
				for (const a of v) {
					const norm = normalizeForMatch(a);
					if (norm) result.artists.push(norm);
				}
				break;
			case "album":
				result.album = normalizeForMatch(v[0]);
				break;
		}
	}
	metaCache.set(entry, result);
	return result;
}

/**
 * 给一条 TTML 候选项相对一首歌打分。
 *
 * 歌名：完全相等 +100，包含 +60，词级交集 +25。
 * 艺术家：完全相等 +50，部分包含 +20。
 * 专辑：完全相等 +30，部分 +10。
 * 「歌名 + 至少一个艺术家」同时命中再 +50（避免同名歌串台）。
 */
export function scoreTTMLEntry(
	entry: TTMLDBLyricEntry,
	song: Pick<Song, "songName" | "songArtists" | "songAlbum">,
): number {
	const meta = extractTTMLMeta(entry);
	const songName = normalizeForMatch(song.songName);
	const songArtists = splitArtists(song.songArtists);
	const songAlbum = normalizeForMatch(song.songAlbum);

	// 没有歌名信息的 TTML 不参与评分（基本上是脏数据）。
	if (!meta.name && meta.artists.length === 0) return 0;

	let nameScore = 0;
	if (meta.name && songName) {
		if (meta.name === songName) {
			nameScore = 100;
		} else if (meta.name.includes(songName) || songName.includes(meta.name)) {
			nameScore = 60;
		} else {
			// 词级交集（不分先后），照顾「歌名 (Live)」/ 不同译名的场景。
			const a = new Set(meta.name.split(" "));
			const b = new Set(songName.split(" "));
			let overlap = 0;
			for (const w of a) if (w.length > 1 && b.has(w)) overlap += 1;
			if (overlap > 0) nameScore = Math.min(40, overlap * 15);
		}
	}

	let artistScore = 0;
	let artistHit = false;
	if (meta.artists.length > 0 && songArtists.length > 0) {
		for (const a of songArtists) {
			let best = 0;
			for (const b of meta.artists) {
				if (a === b) {
					best = Math.max(best, 50);
				} else if (a.includes(b) || b.includes(a)) {
					best = Math.max(best, 20);
				}
			}
			if (best > 0) {
				artistHit = true;
				artistScore += best;
			}
		}
	}

	let albumScore = 0;
	if (meta.album && songAlbum) {
		if (meta.album === songAlbum) albumScore = 30;
		else if (meta.album.includes(songAlbum) || songAlbum.includes(meta.album))
			albumScore = 10;
	}

	let total = nameScore + artistScore + albumScore;
	if (nameScore >= 60 && artistHit) total += 50;
	return total;
}

/**
 * 给一首歌从一组候选 TTML 里挑最佳匹配；不足阈值返回 null。
 * 候选数组通常由 `db.ttmlDB.toArray()` 一次性读出，供导入循环复用。
 */
export function findBestTTMLMatch(
	song: Pick<Song, "songName" | "songArtists" | "songAlbum">,
	candidates: TTMLDBLyricEntry[],
): MatchedTTML | null {
	if (candidates.length === 0) return null;
	if (!song.songName && !song.songArtists) return null;
	let best: MatchedTTML | null = null;
	for (const entry of candidates) {
		const score = scoreTTMLEntry(entry, song);
		if (score < MATCH_THRESHOLD) continue;
		if (!best || score > best.score) {
			best = { entry, score };
		}
	}
	return best;
}

/** 一次性读出整张 TTML DB 给评分匹配用；调用方控制读时机。 */
export async function loadAllTTMLEntries(): Promise<TTMLDBLyricEntry[]> {
	return db.ttmlDB.toArray();
}

/** 单首歌按需匹配；用于已入库歌曲的事后补匹配。 */
export async function autoMatchTTMLForSong(
	song: Pick<Song, "songName" | "songArtists" | "songAlbum">,
): Promise<MatchedTTML | null> {
	const all = await loadAllTTMLEntries();
	return findBestTTMLMatch(song, all);
}
