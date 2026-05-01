import { Button, Flex, Text } from "@radix-ui/themes";
import { path } from "@tauri-apps/api";
import { platform } from "@tauri-apps/plugin-os";
import type { TFunction } from "i18next";
import md5 from "md5";
import pLimit from "p-limit";
import { createElement, type ReactNode } from "react";
import { type Id, toast } from "react-toastify";
import { db, type Song } from "../dexie.ts";
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
// 首次 Android 文件夹扫描时 SAF/JNI 冷启动明显慢于后续。用专属标记避免普通文件
// 导入影响首次扫描提示。
const FIRST_FOLDER_SCAN_FLAG_KEY = "amll-player:hadFirstFolderScan";
export const isFirstEverFolderScan = (): boolean => {
	try {
		return !localStorage.getItem(FIRST_FOLDER_SCAN_FLAG_KEY);
	} catch {
		return false;
	}
};
const markFirstFolderScanDone = (): void => {
	try {
		localStorage.setItem(FIRST_FOLDER_SCAN_FLAG_KEY, "1");
	} catch {
		// 隐私模式 / 配额满 → 忽略，下次仍当作首次提示一遍即可
	}
};

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

/** 解析阶段的进度回调，UI 用它在对话框/页面里显示实时数字。 */
export type ImportProgressCallback = (progress: {
	processed: number;
	total: number;
}) => void;

export async function scanFolderAndImportToPlaylist(opts: {
	playlistId: number;
	treeUri: string;
	t: TFunction;
	recursive?: boolean;
	/** 外部传入的中止信号；触发后等价于点击 toast 上的「取消」。 */
	signal?: AbortSignal;
	/** 解析阶段进度回调；扫描阶段不会触发。 */
	onProgress?: ImportProgressCallback;
}): Promise<ScanAndImportResult> {
	const { playlistId, treeUri, t, recursive = true, signal, onProgress } = opts;
	const importController = new AbortController();
	let cancelRequested = false;
	const currentMessage = t(
		"page.playlist.folderScanRefresh.toast.scanning",
		"正在重新扫描文件夹...",
	);

	// 首次扫描时给一个独立 loading toast。它只覆盖 scanAudioInTreeUri 这一段；
	// 扫描完成、取消或失败都会关闭，不混入扫描/解析进度 toast。
	const firstScanHintToastId: Id | null = isFirstEverFolderScan()
		? toast.loading(
				t(
					"page.playlist.addLocalMusic.toast.firstImportHint",
					"初始化导入中，请耐心等待",
				),
				{ closeOnClick: false, draggable: false, closeButton: false },
			)
		: null;
	const dismissFirstScanHint = () => {
		if (firstScanHintToastId !== null) toast.dismiss(firstScanHintToastId);
	};

	// toast 内容是静态 ReactNode；点击取消后必须主动 toast.update 才能让按钮变
	// 灰、文案变成「正在取消...」，否则用户会以为没响应而连点。
	const onCancelClick = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		void cancelScanAudioInTreeUri();
		importController.abort();
		toast.update(toastId, { render: renderToast(currentMessage) });
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
					onClick: () => onCancelClick(),
					disabled: cancelRequested,
					style: { flexShrink: 0 },
				},
				cancelRequested
					? t("page.playlist.folderScanRefresh.toast.canceling", "正在取消...")
					: t("common.dialog.cancel", "取消"),
			),
		);

	const toastId: Id = toast(renderToast(currentMessage), {
		closeOnClick: false,
		autoClose: false,
		closeButton: false,
		draggable: false,
		isLoading: true,
	});

	// 外部 signal（如新建歌单对话框的「取消」按钮）走和 toast 同一条取消路径，
	// 既能中止扫描/导入，又能让 toast UI 同步显示「正在取消...」。
	if (signal) {
		if (signal.aborted) onCancelClick();
		else signal.addEventListener("abort", onCancelClick, { once: true });
	}

	let uris: string[];
	try {
		uris = await scanAudioInTreeUri(treeUri, recursive);
	} catch (err) {
		toast.done(toastId);
		dismissFirstScanHint();
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

	markFirstFolderScanDone();

	if (uris.length === 0) {
		toast.done(toastId);
		dismissFirstScanHint();
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
	dismissFirstScanHint();

	const result = await importAudioFilesToPlaylist({
		playlistId,
		results: uris,
		t,
		signal: importController.signal,
		onProgress,
	});

	return {
		canceled: result.canceled || cancelRequested,
		scannedCount: uris.length,
		importedCount: result.successCount,
		failedList: result.failedList,
	};
}

export async function importAudioFilesToPlaylist(opts: {
	playlistId: number;
	results: string[];
	t: TFunction;
	signal?: AbortSignal;
	onProgress?: ImportProgressCallback;
}): Promise<ImportResult> {
	const { playlistId, results, t, signal, onProgress } = opts;
	const failedList: ImportFailure[] = [];
	if (!results || results.length === 0) {
		return { successCount: 0, failedList, canceled: false };
	}

	const renderProgressMessage = (): string =>
		t(
			"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
			"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
			{ current: processed, total: results.length },
		);

	let processed = 0;
	let successCount = 0;
	let canceled = false;
	const isMobile = platform() === "android" || platform() === "ios";

	const toastId = toast.loading(renderProgressMessage());

	const checkCanceled = () => {
		if (signal?.aborted) {
			canceled = true;
			return true;
		}
		return false;
	};

	let lastProgressAt = 0;
	const updateProgress = (force = false) => {
		const now = performance.now();
		const isLast = processed === results.length;
		if (!force && !isLast && now - lastProgressAt < PROGRESS_THROTTLE_MS) {
			return;
		}
		lastProgressAt = now;
		toast.update(toastId, {
			render: renderProgressMessage(),
			progress: processed / results.length,
		});
		onProgress?.({ processed, total: results.length });
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
			// 同一批次内可能出现同 md5（重复扫描结果或不同 raw 路径归一化到
			// 同一 path），用 seen 去重避免在 songIds 中产生重复条目。
			const seen = new Set<string>();
			const toAdd: string[] = [];
			for (const s of batch) {
				if (existing.has(s.id) || flushedIds.has(s.id) || seen.has(s.id))
					continue;
				seen.add(s.id);
				toAdd.push(s.id);
			}
			toAdd.reverse();
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
					const song: Song = {
						id: pathMd5,
						filePath: normalized,
						songName: musicInfo.name,
						songArtists: musicInfo.artist,
						songAlbum: musicInfo.album,
						lyricFormat: musicInfo.lyricFormat || "none",
						lyric: musicInfo.lyric,
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
