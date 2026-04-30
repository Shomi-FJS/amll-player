import { atomWithStorage } from "jotai/utils";

// 内置歌词来源类型：本地文件或 AMLLDB 在线数据库
export type BuiltinLyricSourceType = "local" | "amlldb";
export type LyricSourceType = BuiltinLyricSourceType | "custom";
export type CustomLyricResponseFormat =
	| "auto"
	| "lrc"
	| "eslrc"
	| "lrcA2"
	| "yrc"
	| "qrc"
	| "lys"
	| "lyl"
	| "ttml";

/** 歌词源配置项 */
export interface LyricSourceConfig {
	id: string;
	type: LyricSourceType;
	name: string;
	enabled: boolean;
	/** 自定义歌词源的请求地址模板 */
	url?: string;
	format?: CustomLyricResponseFormat;
}

/** 用于搜索歌词的歌曲基本信息 */
export interface LyricSearchSongInfo {
	songName: string;
	songArtists: string;
	songAlbum: string;
	filePath?: string;
}

/** 歌词搜索返回结果 */
export interface LyricSourceResult {
	format: string;
	lyric: string;
	translatedLrc?: string;
}

/** 默认歌词源列表：AMLLDB 优先，本地次之 */
export const DEFAULT_LYRIC_SOURCES: LyricSourceConfig[] = [
	{
		id: "amlldb",
		type: "amlldb",
		name: "AMLLDB",
		enabled: true,
	},
	{
		id: "local",
		type: "local",
		name: "本地歌词",
		enabled: true,
	},
];

// 持久化到 localStorage 的歌词源配置
export const lyricSourcesAtom = atomWithStorage<LyricSourceConfig[]>(
	"amll-player.lyricSources",
	DEFAULT_LYRIC_SOURCES,
);

/**
 * 校验并补全歌词源列表：去重 + 确保内置源始终存在
 */
export function normalizeLyricSources(
	sources: LyricSourceConfig[],
): LyricSourceConfig[] {
	const result: LyricSourceConfig[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (!source.id || seen.has(source.id)) continue;
		seen.add(source.id);
		result.push(source);
	}
	for (const source of DEFAULT_LYRIC_SOURCES) {
		if (seen.has(source.id)) continue;
		seen.add(source.id);
		result.push(source);
	}
	return result;
}

/**
 * 根据歌词内容或用户偏好猜测歌词格式
 * preferred 非 auto 时直接返回指定格式
 */
export function guessLyricFormat(
	content: string,
	preferred: CustomLyricResponseFormat = "auto",
): string {
	if (preferred !== "auto") return preferred;
	const trimmed = content.trimStart();
	if (trimmed.startsWith("<")) return "ttml";
	// LYL：[type:LyricifyLines] 或 [数字,数字]开头的行
	if (
		trimmed.startsWith("[type:LyricifyLines]") ||
		/^\[\d+,\d+\]/m.test(trimmed)
	) {
		return "lyl";
	}
	// QRC：通常以 [offset:0] 开头并含 (start,duration) 标记
	if (/\[\d+,\d+\]/.test(trimmed) && /\(\d+,\d+\)/.test(trimmed))
		return "qrc";
	// LYS：行首是 [属性数字] 后接 ((start,dur)) 词块
	if (/^\[\d+\]/m.test(trimmed) && /\(\d+,\d+\)/.test(trimmed)) return "lys";
	// YRC：行级 [start,dur] + 词级 (start,dur,0)
	if (/^\[\d+,\d+\]/m.test(trimmed) && /\(\d+,\d+,\d+\)/.test(trimmed))
		return "yrc";
	// LRC A2：标准 LRC 行内嵌 <时间> 词级戳
	if (/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\][^[\n]*<\d/i.test(trimmed))
		return "lrcA2";
	// ESLrc：词级 <开始,结束> 标记
	if (/<\d+,\d+>/.test(trimmed)) return "eslrc";
	if (/\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(content)) return "lrc";
	return "lrc";
}

// 将自定义歌词源 URL 模板中的占位符替换为实际歌曲信息
// 支持的占位符：{name} {songName} {artist} {songArtists} {album} {songAlbum}
export function buildCustomLyricSourceUrl(
	template: string,
	song: LyricSearchSongInfo,
): string {
	const values: Record<string, string> = {
		name: song.songName,
		songName: song.songName,
		artist: song.songArtists,
		songArtists: song.songArtists,
		album: song.songAlbum ?? "",
		songAlbum: song.songAlbum ?? "",
	};
	return template.replace(
		/\{(name|songName|artist|songArtists|album|songAlbum)\}/g,
		(_, key) => encodeURIComponent(values[key] ?? ""),
	);
}
