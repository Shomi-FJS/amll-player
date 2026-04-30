import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import { db, type Song, type TTMLDBLyricEntry } from "../dexie.ts";

/**
 * 基于 TTML `<amll:meta>` 元数据的评分匹配。
 *
 * 设计思路：
 * - 同名歌词文件（read_local_music_metadata 已处理）覆盖最规整的私库场景；
 *   但官方 amll-ttml-db 里的歌词是按"歌名 - 歌手"或 ISRC 命名的，本地音频
 *   文件名往往不一致（带音轨号、带专辑名等），所以需要按元数据打分匹配。
 * - 评分维度：musicName / artists / album，做归一化后比对。
 * - 阈值：总分 ≥ MATCH_THRESHOLD 才算可信匹配，避免随便给一首陌生歌乱挂歌词。
 */

export interface MatchedTTML {
	entry: TTMLDBLyricEntry;
	score: number;
}

const MATCH_THRESHOLD = 120;

/** 将字符串归一化，用于评分比对：去括号注解、统一大小写、压缩空白。 */
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

/** 把"张XX/王XX, Eason"这类多艺术家串拆成数组。 */
function splitArtists(input: string | undefined | null): string[] {
	if (!input) return [];
	return input
		.split(/[/、,，;；&]/g)
		.map((s) => normalizeForMatch(s))
		.filter((s) => s.length > 0);
}

interface TTMLMeta {
	name: string; // 归一化后的 musicName
	artists: string[]; // 归一化后的 artists 数组
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
 * 评分表：
 * - 歌名完全相等 +100，包含/被包含 +60，部分词重合 +25。
 * - 每个艺术家命中：完全相等 +50，部分包含 +20。
 * - 专辑：完全相等 +30，部分相等 +10。
 * - 「歌名 + 至少一个艺术家」同时命中再加 +50 加权（避免同名歌串台）。
 */
export function scoreTTMLEntry(
	entry: TTMLDBLyricEntry,
	song: Pick<Song, "songName" | "songArtists" | "songAlbum">,
): number {
	const meta = extractTTMLMeta(entry);
	const songName = normalizeForMatch(song.songName);
	const songArtists = splitArtists(song.songArtists);
	const songAlbum = normalizeForMatch(song.songAlbum);

	// 没有歌名信息的 TTML 不参与评分（基本上是脏数据，且和任何歌都能"部分命中"）。
	if (!meta.name && meta.artists.length === 0) return 0;

	let nameScore = 0;
	if (meta.name && songName) {
		if (meta.name === songName) {
			nameScore = 100;
		} else if (meta.name.includes(songName) || songName.includes(meta.name)) {
			nameScore = 60;
		} else {
			// 词级交集（不分先后），主要照顾「歌名 (Live)」/ 不同译名的场景。
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
 *
 * 候选数组通常来自 `db.ttmlDB.toArray()` 一次性读出，让调用方能在导入循环里
 * 复用同一份候选，避免每首歌都打开一次事务。
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

/**
 * 一次性读出整张 TTML DB 给评分匹配用。
 *
 * 单独抽出是为了让调用方能控制读时机：导入大量歌曲时只读一次，后续都用同一份；
 * 单首场景调一次也可以。
 */
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
