import type { LyricLine as CoreLyricLine } from "@applemusic-like-lyrics/core";
import { db, type LyricOffsetEntry } from "../dexie.ts";

/**
 * 歌词时间轴偏移管理。
 *
 * 应用场景：杜比全景声 m4a 容器内 E-AC-3 JOC 编码会插入固定的 priming 前导
 * 样本（典型 ~1.3s），导致播放器报告的 PTS=0 比真实音乐时间提前 1.3s；
 * 我们的 TTML 是按真实音乐时间轴标的，所以歌词需要整体后移 1.3s。
 *
 * 同一首歌的 Atmos 与立体声两个版本时长不同（典型差 1.3s）→ 把 duration
 * 按秒分桶进 key，让两个版本各自记一份 offset。
 */

/**
 * 构造 offset 表的主键。
 *
 * @param packageName  Android MediaSession 的 packageName，跨 app 不串台
 * @param title        曲目标题
 * @param artist       艺术家（已用 "/" 拼接的字符串，与 Song.songArtists 同格式）
 * @param album        专辑名
 * @param durationMs   播放器报告的曲目时长（毫秒）；按秒分桶吸收码率/编码差异
 */
export function buildLyricOffsetKey(
	packageName: string,
	title: string,
	artist: string,
	album: string,
	durationMs: number,
): string {
	const durBucket = Math.max(0, Math.round(durationMs / 1000));
	// \u0001 是 SOH 控制符，用作分隔符在常规歌曲元数据里几乎不可能出现，
	// 比 "|" 更安全。
	return `${packageName}\u0001${title}\u0001${artist}\u0001${album}\u0001${durBucket}`;
}

/** 读取保存的 offset；未保存返回 0。 */
export async function getLyricOffset(key: string): Promise<number> {
	if (!key) return 0;
	try {
		const row = await db.lyricOffsets.get(key);
		const v = row?.offsetMs ?? 0;
		return Number.isFinite(v) ? v : 0;
	} catch (e) {
		console.warn("[lyricOffsets] 读取失败", e);
		return 0;
	}
}

/**
 * 写入 offset；offsetMs === 0 时删除条目避免占空间。
 * 写入失败时仅打 warn——这是一个 best-effort 的体验优化，不应中断歌词显示。
 */
export async function setLyricOffset(
	key: string,
	offsetMs: number,
): Promise<void> {
	if (!key) return;
	try {
		const rounded = Math.round(offsetMs);
		if (rounded === 0) {
			await db.lyricOffsets.delete(key);
			return;
		}
		const entry: LyricOffsetEntry = {
			key,
			offsetMs: rounded,
			updateTime: Date.now(),
		};
		await db.lyricOffsets.put(entry);
	} catch (e) {
		console.warn("[lyricOffsets] 写入失败", e);
	}
}

/**
 * 内置 offset 预设。一键套用时把 offset 写成对应值。
 *
 * `i18nLabelKey` 走 `t(key, fallbackLabel)`；新增预设记得同时往 5 份 locales 加。
 */
export interface LyricOffsetPreset {
	id: string;
	i18nLabelKey: string;
	fallbackLabel: string;
	offsetMs: number;
}

export const LYRIC_OFFSET_PRESETS: LyricOffsetPreset[] = [
	{
		id: "dolby-atmos",
		i18nLabelKey: "amll.androidMediaCapture.lyricOffset.preset.dolbyAtmos",
		fallbackLabel: "杜比全景声对齐",
		// E-AC-3 JOC 容器实测前导静音 ≈ 950ms，此值在 Apple Music 上覆盖度最好
		offsetMs: 950,
	},
];

/**
 * 计算 TTML 末尾相对于音频总长的「尾部时长」：当音频显著长于歌词最后一行 endTime
 * 时，强烈暗示音频含前导静音 / outro 仪器段，是触发偏移提示的依据。
 *
 * 之所以不靠 title/album 关键词检测——多数歌曲根本没有 "Atmos / Dolby" 字样，
 * 只能靠时间轴长度差兜底。
 */
export function computeLyricTailMs(
	durationMs: number,
	lyricLastEndMs: number,
): number {
	if (!Number.isFinite(durationMs) || !Number.isFinite(lyricLastEndMs))
		return 0;
	if (durationMs <= 0 || lyricLastEndMs <= 0) return 0;
	const tail = durationMs - lyricLastEndMs;
	return tail > 0 ? Math.round(tail) : 0;
}

/**
 * 触发「歌词可能延迟」提示的 tail 阈值。
 * 经验值：普通歌曲 outro ≤ 5s；超过此值大概率是 Atmos 前导静音 / 长 outro，
 * 给一个不太骚扰但能覆盖大多数 Atmos 歌的阈值。
 */
export const LYRIC_OFFSET_TAIL_HINT_MS = 5000;

/**
 * 把 offsetMs 应用到一组歌词行：所有 line / word 的 startTime / endTime 都加上
 * 偏移。返回新数组（不修改入参），方便上游做 diff 比较。
 *
 * - offsetMs > 0：歌词整体延后（音频比歌词慢，例如 Atmos priming 场景）
 * - offsetMs < 0：歌词整体提前
 * - offsetMs === 0：返回入参本身（零拷贝优化，避免 React 误判 props 变化）
 */
export function applyOffsetToLines(
	lines: CoreLyricLine[],
	offsetMs: number,
): CoreLyricLine[] {
	if (!offsetMs || !Number.isFinite(offsetMs)) return lines;
	const dt = Math.round(offsetMs);
	return lines.map((line) => ({
		...line,
		startTime: line.startTime + dt,
		endTime: line.endTime + dt,
		words: line.words.map((w) => ({
			...w,
			startTime: w.startTime + dt,
			endTime: w.endTime + dt,
		})),
	}));
}
