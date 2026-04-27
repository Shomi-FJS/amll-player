import { path } from "@tauri-apps/api";
import { platform } from "@tauri-apps/plugin-os";
import md5 from "md5";
import pLimit from "p-limit";
import { toast } from "react-toastify";
import { db, type Song } from "../dexie.ts";
import { readLocalMusicMetadata, resolveContentUri } from "./player.ts";

// 8 路并发：避开 Android 冷启动首次导入时 FFmpeg `.so` 的 dlopen 全局锁。
const IMPORT_CONCURRENCY = 8;

export interface ImportFailure {
	path: string;
	error: string;
}

export interface ImportResult {
	successCount: number;
	failedList: ImportFailure[];
	/** 为 true 表示被用户中途取消；`successCount` 仅计已写入部分。 */
	canceled: boolean;
}

type Translator = (
	key: string,
	defaultValue: string,
	opts?: Record<string, unknown>,
) => string;

/**
 * 将一组本地音频文件路径（或 Android `content://` URI）导入到指定歌单：
 * - 解析元数据 / 封面 / 同名歌词文件
 * - 写入 `db.songs`，并把新增 ID 推到歌单 `songIds` 头部
 * - 通过 toast 显示进度 / 成功 / 部分失败 / 全部失败
 *
 * 返回成功条数与失败明细，失败明细可由调用方进一步在 UI 上展示。
 */
export async function importAudioFilesToPlaylist(opts: {
	playlistId: number;
	results: string[];
	t: Translator;
	/** abort 后跳过剩余文件、把已解析的部分入库。 */
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

	const checkCanceled = () => {
		if (signal?.aborted) {
			canceled = true;
			return true;
		}
		return false;
	};

	const limit = pLimit(IMPORT_CONCURRENCY);

	const transformed = (
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
						toast.update(toastId, {
							render: t(
								"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
								"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
								{ current: processed, total: results.length },
							),
							progress: processed / results.length,
						});
						return null;
					}

					if (checkCanceled()) return null;
					try {
						const pathMd5 = md5(normalized);
						const musicInfo = await readLocalMusicMetadata(normalized);

						const coverData = new Uint8Array(musicInfo.cover);
						const coverBlob = new Blob([coverData], { type: "image" });

						successCount += 1;
						return {
							id: pathMd5,
							filePath: normalized,
							songName: musicInfo.name,
							songArtists: musicInfo.artist,
							songAlbum: musicInfo.album,
							lyricFormat: musicInfo.lyricFormat || "none",
							lyric: musicInfo.lyric,
							cover: coverBlob,
							duration: musicInfo.duration,
						} satisfies Song;
					} catch (err) {
						console.warn("解析歌曲元数据以添加歌曲失败", normalized, err);
						failedList.push({
							path: normalized,
							error: err instanceof Error ? err.message : String(err),
						});
						return null;
					} finally {
						processed += 1;
						toast.update(toastId, {
							render: t(
								"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
								"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
								{ current: processed, total: results.length },
							),
							progress: processed / results.length,
						});
					}
				}),
			),
		)
	).filter((v): v is Song => !!v);

	if (transformed.length > 0) {
		await db.songs.bulkPut(transformed);
		const playlist = await db.playlists.get(playlistId);
		const existing = new Set(playlist?.songIds ?? []);
		const shouldAddIds = transformed
			.map((s) => s.id)
			.filter((id) => !existing.has(id))
			.reverse();
		await db.playlists.update(playlistId, (obj) => {
			obj.songIds.unshift(...shouldAddIds);
			obj.updateTime = Date.now();
		});
	}

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
