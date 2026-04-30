import { parseTTML } from "@applemusic-like-lyrics/lyric";
import { Button, Flex, Text } from "@radix-ui/themes";
import { path } from "@tauri-apps/api";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { platform } from "@tauri-apps/plugin-os";
import type { TFunction } from "i18next";
import { getDefaultStore } from "jotai";
import md5 from "md5";
import pLimit from "p-limit";
import { createElement, type ReactNode } from "react";
import { type Id, toast } from "react-toastify";
import { db, type Song, type TTMLDBLyricEntry } from "../dexie.ts";
import { findBestTTMLMatch, loadAllTTMLEntries } from "./lyricAutoMatch.ts";
import {
	buildCustomLyricSourceUrl,
	guessLyricFormat,
	type LyricSearchSongInfo,
	type LyricSourceConfig,
	type LyricSourceResult,
	lyricSourcesAtom,
	normalizeLyricSources,
} from "./lyricSources.ts";
import {
	cancelScanAudioInTreeUri,
	readLocalMusicMetadata,
	resolveContentUri,
	SCAN_CANCELED_TOKEN,
	scanAudioInTreeUri,
} from "./player.ts";

const IMPORT_CONCURRENCY = 8;
const PROGRESS_THROTTLE_MS = 80;
const DB_FLUSH_BATCH = 32;

export interface ImportFailure {
	path: string;
	error: string;
}

export interface ImportResult {
	successCount: number;
	failedList: ImportFailure[];
	canceled: boolean;
}

export interface ScanAndImportResult {
	canceled: boolean;
	scannedCount: number;
	importedCount: number;
	failedList: ImportFailure[];
}

type Translator = (
	key: string,
	defaultValue: string,
	opts?: Record<string, unknown>,
) => string;

async function fetchWithFallback(
	input: string,
	init?: RequestInit,
): Promise<Response> {
	try {
		return await tauriFetch(input, {
			...init,
			connectTimeout: 10_000,
		});
	} catch (err) {
		if (typeof fetch !== "function") throw err;
		return await fetch(input, init);
	}
}

type LocalLyricCandidate = {
	path: string;
	stem: string;
	format: string;
	raw: string;
	ttmlEntry?: TTMLDBLyricEntry;
};

type LocalLyricMatch = Pick<LocalLyricCandidate, "format" | "raw">;

type LocalLyricCache = Map<string, Promise<LocalLyricCandidate[]>>;

export async function scanFolderAndImportToPlaylist(opts: {
	playlistId: number;
	treeUri: string;
	t: TFunction;
	recursive?: boolean;
}): Promise<ScanAndImportResult> {
	const { playlistId, treeUri, t, recursive = true } = opts;
	const importController = new AbortController();
	let cancelRequested = false;

	const onCancelClick = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		void cancelScanAudioInTreeUri();
		importController.abort();
	};

	const renderToast = (message: string): ReactNode =>
		createElement(
			Flex,
			{ align: "center", justify: "between", gap: "3", width: "100%" },
			createElement(
				Text,
				{ size: "2", style: { flex: 1, minWidth: 0 } },
				message,
			),
			createElement(
				Button,
				{
					size: "1",
					variant: "soft",
					color: "gray",
					onClick: onCancelClick,
					disabled: cancelRequested,
					style: { flexShrink: 0 },
				},
				cancelRequested
					? t("page.playlist.folderScanRefresh.toast.canceling", "正在取消...")
					: t("common.dialog.cancel", "取消"),
			),
		);

	const toastId: Id = toast(
		renderToast(
			t(
				"page.playlist.folderScanRefresh.toast.scanning",
				"正在重新扫描文件夹...",
			),
		),
		{
			closeOnClick: false,
			autoClose: false,
			closeButton: false,
			draggable: false,
			isLoading: true,
		},
	);

	let uris: string[];
	try {
		uris = await scanAudioInTreeUri(treeUri, recursive);
	} catch (err) {
		toast.done(toastId);
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes(SCAN_CANCELED_TOKEN) || cancelRequested) {
			toast.info(
				t("page.playlist.folderScanRefresh.toast.scanCanceled", "已取消扫描"),
			);
			return {
				canceled: true,
				scannedCount: 0,
				importedCount: 0,
				failedList: [],
			};
		}
		toast.error(
			t(
				"page.playlist.folderScanRefresh.toast.scanFailed",
				"重新扫描失败：{error}",
				{ error: msg },
			),
		);
		return {
			canceled: false,
			scannedCount: 0,
			importedCount: 0,
			failedList: [],
		};
	}

	if (uris.length === 0) {
		toast.done(toastId);
		toast.warn(
			t(
				"page.playlist.folderScanRefresh.toast.empty",
				"该文件夹下未找到任何音频文件",
			),
		);
		return {
			canceled: false,
			scannedCount: 0,
			importedCount: 0,
			failedList: [],
		};
	}

	toast.done(toastId);

	const result = await importAudioFilesToPlaylist({
		playlistId,
		results: uris,
		t,
		signal: importController.signal,
	});

	return {
		canceled: result.canceled || cancelRequested,
		scannedCount: uris.length,
		importedCount: result.successCount,
		failedList: result.failedList,
	};
}

// 优先级从高到低：
// 1. ttml：AMLL 原生格式，逐词 + 翻译 + 音译 + 元数据，最完整。
// 2. 逐词级：lys / yrc / qrc / alrc(LRC A2) / eslrc，按格式表达力排序。
// 3. 逐行级：lyl（带 end 时间）> lrc（仅 start 时间）。
// 同一首歌存在多个候选时挑优先级最高的，避免拿到逐行 lrc 而忽略了逐词版。
const LOCAL_LYRIC_EXTENSIONS = [
	"ttml",
	"lys",
	"yrc",
	"qrc",
	"alrc",
	"eslrc",
	"lyl",
	"lrc",
];
const LOCAL_LYRIC_EXTENSION_PRIORITY = new Map(
	LOCAL_LYRIC_EXTENSIONS.map((ext, index) => [ext, index]),
);

function getLocalLyricNameParts(fileName: string) {
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex <= 0) return null;
	const ext = fileName.slice(dotIndex + 1).toLowerCase();
	if (!LOCAL_LYRIC_EXTENSION_PRIORITY.has(ext)) return null;
	return {
		ext,
		stem: fileName.slice(0, dotIndex).toLowerCase(),
	};
}

async function loadLocalLyricCandidates(
	rootDir: string,
): Promise<LocalLyricCandidate[]> {
	const candidates: LocalLyricCandidate[] = [];
	const visited = new Set<string>();
	const walk = async (dir: string) => {
		if (visited.has(dir)) return;
		visited.add(dir);
		let entries: Awaited<ReturnType<typeof readDir>>;
		try {
			entries = await readDir(dir);
		} catch (err) {
			console.warn("读取本地歌词目录失败", dir, err);
			return;
		}
		await Promise.all(
			entries.map(async (entry) => {
				const entryPath = await path.join(dir, entry.name);
				if (entry.isDirectory) {
					await walk(entryPath);
					return;
				}
				if (!entry.isFile) return;
				const parts = getLocalLyricNameParts(entry.name);
				if (!parts) return;
				try {
					const raw = await readTextFile(entryPath);
					// .alrc 是我们约定的 LRC A2 扩展名，但解析器格式标识叫 lrcA2。
					const format = parts.ext === "alrc" ? "lrcA2" : parts.ext;
					const candidate: LocalLyricCandidate = {
						path: entryPath,
						stem: parts.stem,
						format,
						raw,
					};
					if (parts.ext === "ttml") {
						candidate.ttmlEntry = {
							name: entryPath,
							content: parseTTML(raw),
							raw,
						};
					}
					candidates.push(candidate);
				} catch (err) {
					console.warn("读取或解析本地歌词失败", entryPath, err);
				}
			}),
		);
	};
	await walk(rootDir);
	return candidates;
}

function getLocalLyricCandidates(
	cache: LocalLyricCache,
	rootDir: string,
): Promise<LocalLyricCandidate[]> {
	let promise = cache.get(rootDir);
	if (!promise) {
		promise = loadLocalLyricCandidates(rootDir);
		cache.set(rootDir, promise);
	}
	return promise;
}

export async function importAudioFilesToPlaylist(opts: {
	playlistId: number;
	results: string[];
	t: Translator;
	signal?: AbortSignal;
}): Promise<ImportResult> {
	const { playlistId, results, t, signal } = opts;
	const failedList: ImportFailure[] = [];
	if (!results || results.length === 0) {
		return { successCount: 0, failedList, canceled: false };
	}

	const toastId = toast.loading(
		t(
			"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
			"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
			{ current: 0, total: results.length },
		),
	);

	let processed = 0;
	let successCount = 0;
	let canceled = false;
	const isMobile = platform() === "android" || platform() === "ios";
	const isAndroid = platform() === "android";
	const shouldMatchLocalLyric = isAndroid;
	const localLyricCache: LocalLyricCache = new Map();
	const lyricSources = normalizeLyricSources(
		getDefaultStore()
			.get(lyricSourcesAtom)
			.filter((source) => source.enabled),
	);

	const checkCanceled = () => {
		if (signal?.aborted) {
			canceled = true;
			return true;
		}
		return false;
	};

	let ttmlCandidates: TTMLDBLyricEntry[] = [];
	try {
		ttmlCandidates = await loadAllTTMLEntries();
	} catch (err) {
		console.warn("加载 TTML DB 用于自动匹配失败", err);
	}

	let lastProgressAt = 0;
	const updateProgress = (force = false) => {
		const now = performance.now();
		const isLast = processed === results.length;
		if (!force && !isLast && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
			return;
		}
		lastProgressAt = now;
		toast.update(toastId, {
			render: t(
				"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
				"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
				{ current: processed, total: results.length },
			),
			progress: processed / results.length,
		});
	};

	const pendingFlush: Song[] = [];
	const flushedIds = new Set<string>();
	let flushChain: Promise<void> = Promise.resolve();
	const flushPending = (): Promise<void> => {
		flushChain = flushChain.then(async () => {
			if (pendingFlush.length === 0) return;
			const batch = pendingFlush.splice(0, pendingFlush.length);
			await db.songs.bulkPut(batch);
			const playlist = await db.playlists.get(playlistId);
			const existing = new Set(playlist?.songIds ?? []);
			const toAdd = batch
				.map((s) => s.id)
				.filter((id) => !existing.has(id) && !flushedIds.has(id))
				.reverse();
			if (toAdd.length > 0) {
				for (const id of toAdd) flushedIds.add(id);
				await db.playlists.update(playlistId, (obj) => {
					obj.songIds.unshift(...toAdd);
					obj.updateTime = Date.now();
				});
			}
		});
		return flushChain;
	};

	const limit = pLimit(IMPORT_CONCURRENCY);

	const ttmlCandidateEntries = () => ttmlCandidates;

	const matchLocalLyric = async (
		filePath: string,
		songForMatch: Pick<Song, "songName" | "songArtists" | "songAlbum">,
	): Promise<LocalLyricMatch | null> => {
		if (!shouldMatchLocalLyric) return null;
		try {
			const fileStem = (await path.basename(filePath))
				.replace(/\.[^.]*$/, "")
				.toLowerCase();
			const candidates = await getLocalLyricCandidates(
				localLyricCache,
				await path.dirname(filePath),
			);
			const sameStem = candidates
				.filter((candidate) => candidate.stem === fileStem)
				.sort(
					(a, b) =>
						(LOCAL_LYRIC_EXTENSION_PRIORITY.get(a.format) ??
							Number.MAX_SAFE_INTEGER) -
						(LOCAL_LYRIC_EXTENSION_PRIORITY.get(b.format) ??
							Number.MAX_SAFE_INTEGER),
				)[0];
			if (sameStem) return sameStem;
			const matchedTTML = findBestTTMLMatch(
				songForMatch,
				candidates
					.map((candidate) => candidate.ttmlEntry)
					.filter((entry): entry is TTMLDBLyricEntry => !!entry),
			);
			return matchedTTML
				? {
						format: "ttml",
						raw: matchedTTML.entry.raw,
					}
				: null;
		} catch (err) {
			console.warn("本地歌词自动匹配失败", filePath, err);
			return null;
		}
	};

	const fetchCustomLyricSource = async (
		source: LyricSourceConfig,
		songForMatch: LyricSearchSongInfo,
	): Promise<LyricSourceResult | null> => {
		if (!source.url) return null;
		const url = buildCustomLyricSourceUrl(source.url, songForMatch);
		const res = await fetchWithFallback(url);
		if (!res.ok) return null;
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			const data = (await res.json()) as {
				lyric?: string;
				lrc?: string;
				yrc?: string;
				ttml?: string;
				translatedLrc?: string;
				format?: string;
			};
			const lyric = data.lyric ?? data.yrc ?? data.ttml ?? data.lrc ?? "";
			if (!lyric.trim()) return null;
			return {
				format: data.format ?? guessLyricFormat(lyric, source.format),
				lyric,
				translatedLrc: data.translatedLrc,
			};
		}
		const lyric = await res.text();
		if (!lyric.trim()) return null;
		return {
			format: guessLyricFormat(lyric, source.format),
			lyric,
		};
	};

	const resolveLyricBySource = async (
		source: LyricSourceConfig,
		songForMatch: LyricSearchSongInfo,
	): Promise<LyricSourceResult | null> => {
		switch (source.type) {
			case "local": {
				if (!songForMatch.filePath) return null;
				const matched = await matchLocalLyric(
					songForMatch.filePath,
					songForMatch,
				);
				return matched
					? {
							format: matched.format,
							lyric: matched.raw,
						}
					: null;
			}
			case "amlldb": {
				const matched = findBestTTMLMatch(songForMatch, ttmlCandidateEntries());
				return matched
					? {
							format: "ttml",
							lyric: matched.entry.raw,
						}
					: null;
			}
			case "custom":
				return await fetchCustomLyricSource(source, songForMatch);
		}
	};

	const resolveLyricBySources = async (
		songForMatch: LyricSearchSongInfo,
	): Promise<LyricSourceResult | null> => {
		for (const source of lyricSources) {
			try {
				const result = await resolveLyricBySource(source, songForMatch);
				if (result?.lyric) return result;
			} catch (err) {
				console.warn(`歌词源 ${source.name} 获取失败`, err);
			}
		}
		return null;
	};

	await Promise.all(
		results.map((raw) =>
			limit(async () => {
				if (checkCanceled()) return null;
				let normalized = raw;
				try {
					if (isMobile) {
						normalized = await resolveContentUri(raw);
					} else {
						normalized = (await path.normalize(raw)).replace(/\\/gi, "/");
					}
				} catch (err) {
					if (checkCanceled()) return null;
					failedList.push({
						path: raw,
						error: err instanceof Error ? err.message : String(err),
					});
					processed += 1;
					updateProgress();
					return null;
				}

				if (checkCanceled()) return null;
				try {
					const pathMd5 = md5(normalized);
					const musicInfo = await readLocalMusicMetadata(normalized);

					const coverBlob = new Blob([new Uint8Array(musicInfo.cover)], {
						type: "image",
					});

					successCount += 1;
					let lyricFormat = musicInfo.lyricFormat || "none";
					let lyric = musicInfo.lyric;
					let translatedLrc = "";
					const songForMatch = {
						songName: musicInfo.name,
						songArtists: musicInfo.artist,
						songAlbum: musicInfo.album,
						filePath: normalized,
					};
					// 源列表（含 AMLLDB）优先级高于内嵌歌词；任何源命中即覆盖。
					// 全部失败才回退到内嵌歌词。
					const matched = await resolveLyricBySources(songForMatch);
					if (matched?.lyric) {
						lyric = matched.lyric;
						lyricFormat = matched.format;
						translatedLrc = matched.translatedLrc ?? "";
					}
					const song: Song = {
						id: pathMd5,
						filePath: normalized,
						songName: musicInfo.name,
						songArtists: musicInfo.artist,
						songAlbum: musicInfo.album,
						lyricFormat,
						lyric,
						translatedLrc,
						cover: coverBlob,
						duration: musicInfo.duration,
					};
					pendingFlush.push(song);
					return song;
				} catch (err) {
					console.warn("解析歌曲元数据以添加歌曲失败", normalized, err);
					failedList.push({
						path: normalized,
						error: err instanceof Error ? err.message : String(err),
					});
					return null;
				} finally {
					processed += 1;
					updateProgress();
					if (pendingFlush.length >= DB_FLUSH_BATCH) {
						flushPending().catch((e) => console.warn("分批写入歌单失败", e));
					}
				}
			}),
		),
	);

	await flushPending();
	updateProgress(true);

	toast.done(toastId);
	if (canceled) {
		toast.info(
			t(
				"page.playlist.addLocalMusic.toast.canceled",
				"已取消导入，已添加 {count, plural, other {#}} 首歌曲",
				{ count: successCount },
			),
		);
		return { successCount, failedList, canceled: true };
	}
	if (failedList.length > 0) {
		if (successCount > 0) {
			toast.warn(
				t(
					"page.playlist.addLocalMusic.toast.partiallyFailed",
					"已添加 {succeed, plural, other {#}} 首歌曲，其中 {errored, plural, other {#}} 首歌曲添加失败",
					{ succeed: successCount, errored: failedList.length },
				),
			);
		} else {
			toast.error(
				t(
					"page.playlist.addLocalMusic.toast.allFailed",
					"{errored, plural, other {#}} 首歌曲添加失败",
					{ errored: failedList.length },
				),
			);
		}
	} else if (successCount > 0) {
		toast.success(
			t(
				"page.playlist.addLocalMusic.toast.success",
				"已全部添加 {count, plural, other {#}} 首歌曲",
				{ count: successCount },
			),
		);
	}

	return { successCount, failedList, canceled: false };
}
