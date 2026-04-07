import { parseTTML } from "@applemusic-like-lyrics/lyric";

export interface LyricMatchResult {
	contributor: string | null;
	matchedFile: string | null;
	lyricAuthors: string[];
	songWriters: string[];
}

const TTML_DB_BASE_URL = "https://amll-ttml-db.gbclstudio.cn/ncm-lyrics";
const LOCAL_TTML_BASE_URL = "http://localhost:3000/api/ncm-lyrics";
const CONTRIBUTOR_SOURCE_STORAGE_KEY = "amll-react-full.contributorSource";

const contributorCache = new Map<string, string | null>();
const metadataCache = new Map<string, { lyricAuthors: string[]; songWriters: string[] }>();

export type ContributorSourceMode = "mirror" | "local";

const getInitialContributorSource = (): ContributorSourceMode => {
	const saved = localStorage.getItem(CONTRIBUTOR_SOURCE_STORAGE_KEY);
	if (!saved) {
		return "mirror";
	}

	try {
		const parsed = JSON.parse(saved);
		return parsed === "local" ? "local" : "mirror";
	} catch {
		return saved === "local" ? "local" : "mirror";
	}
};

let contributorSource: ContributorSourceMode = getInitialContributorSource();

export function setContributorSource(source: ContributorSourceMode): void {
	if (contributorSource === source) {
		return;
	}

	contributorSource = source;
	contributorCache.clear();
}

async function fetchTtmlFromUrl(
	url: string,
	signal: AbortSignal,
): Promise<string | null> {
	const response = await fetch(url, {
		method: "GET",
		signal,
	});

	if (!response.ok) {
		return null;
	}

	const ttmlText = await response.text();
	if (!ttmlText || ttmlText.length === 0) {
		return null;
	}

	return ttmlText;
}

function parseTtmlContributor(
	ttmlText: string,
	ncmId: string,
): LyricMatchResult {
	let ttmlResult;
	try {
		ttmlResult = parseTTML(ttmlText);
	} catch (parseError) {
		console.error("解析TTML失败:", parseError);
		contributorCache.set(ncmId, null);
		return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
	}

	const lines = ttmlResult?.lines;
	if (!lines || !Array.isArray(lines)) {
		contributorCache.set(ncmId, null);
		return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
	}

	const hasWordLyrics = lines.some(
		(line) => line && Array.isArray(line.words) && line.words.length > 0,
	);

	if (!hasWordLyrics) {
		contributorCache.set(ncmId, null);
		return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
	}

	const metadata = ttmlResult?.metadata;
	let contributor: string | null = null;
	let lyricAuthors: string[] = [];
	let songWriters: string[] = [];

	if (metadata && Array.isArray(metadata)) {
		const authorMeta = metadata.find(
			([key]) => key === "ttmlAuthorGithubLogin",
		);
		contributor = authorMeta?.[1]?.[0] ?? null;

		for (const [key, values] of metadata) {
			if (key === "ttmlAuthorGithubLogin") {
				lyricAuthors = values;
			} else if (key === "songWriters") {
				songWriters = values;
			}
		}
	}

	contributorCache.set(ncmId, contributor);
	metadataCache.set(ncmId, { lyricAuthors, songWriters });

	return {
		contributor,
		matchedFile: `${ncmId}.ttml`,
		lyricAuthors,
		songWriters,
	};
}

export async function fetchLyricContributorByNCMId(
	ncmId: string,
): Promise<LyricMatchResult> {
	if (!ncmId || typeof ncmId !== "string") {
		return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
	}

	if (contributorCache.has(ncmId) && metadataCache.has(ncmId)) {
		const cachedMetadata = metadataCache.get(ncmId)!;
		return {
			contributor: contributorCache.get(ncmId) ?? null,
			matchedFile: `${ncmId}.ttml`,
			lyricAuthors: cachedMetadata.lyricAuthors,
			songWriters: cachedMetadata.songWriters,
		};
	}

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const baseUrl =
			contributorSource === "local" ? LOCAL_TTML_BASE_URL : TTML_DB_BASE_URL;

		const ttmlText = await fetchTtmlFromUrl(
			`${baseUrl}/${ncmId}.ttml`,
			controller.signal,
		);

		clearTimeout(timeoutId);

		if (!ttmlText) {
			contributorCache.set(ncmId, null);
			metadataCache.set(ncmId, { lyricAuthors: [], songWriters: [] });
			return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
		}

		return parseTtmlContributor(ttmlText, ncmId);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			console.warn("获取歌词贡献者超时:", ncmId);
		} else {
			console.error("获取歌词贡献者时出错:", error);
		}
		contributorCache.set(ncmId, null);
		metadataCache.set(ncmId, { lyricAuthors: [], songWriters: [] });
		return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
	}
}

export function invalidateContributorCache(): void {
	contributorCache.clear();
	metadataCache.clear();
}

export async function findLyricContributor(
	_songName: string,
	_artistName: string,
): Promise<LyricMatchResult> {
	return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
}

export async function findLyricContributorBySong(
	_songName: string,
	_artists: string[],
): Promise<LyricMatchResult> {
	return { contributor: null, matchedFile: null, lyricAuthors: [], songWriters: [] };
}
