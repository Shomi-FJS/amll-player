import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import { parseTTML } from "@applemusic-like-lyrics/lyric";
import { platform } from "@tauri-apps/plugin-os";
import chalk from "chalk";
import type { Store } from "jotai/vanilla/store";
import JSZip from "jszip";
import pLimit from "p-limit";
import { db } from "../dexie";
import {
	lyricDBIntegrityVersionAtom,
	lyricDBVersionAtom,
} from "../states/appAtoms";

/**
 * 同步结果
 */
export enum SyncStatus {
	/**
	 * 因版本一致而跳过
	 */
	Skipped = "SKIPPED",
	/**
	 * 发现新版本并成功更新
	 */
	Updated = "UPDATED",
	/**
	 * 词库的 Release 没有数据或者解压出来是空的
	 */
	Empty = "EMPTY",
	/**
	 * 发生了错误
	 */
	Failed = "FAILED",
	/**
	 * 被其他标签页锁定
	 */
	Locked = "LOCKED",
}

/**
 * `syncLyricsDatabase` 用来表示返回值的接口
 */
export interface SyncResult {
	status: SyncStatus;
	count?: number;
	error?: unknown;
	strategy?: "full" | "incremental";
}

/**
 * 词库 Release 中 `version.json` 的结构
 */
interface RemoteVersion {
	build_date: string;
	commit: string;
	file_count: number;
	timestamp: number;
}

interface IndexEntry {
	rawLyricFile: string;
	// metadata: unknown; // 暂时不用
}

const INCREMENTAL_THRESHOLD = 200;
// Android WebView 上 IndexedDB 写入/事务代价明显高于桌面，
// 降低增量阈值让「缺口较多」的场景尽早退回全量拉取，避免长时间增量期间被中断。
const ANDROID_INCREMENTAL_THRESHOLD = 80;
// 增量同步时的并发解析/下载数。桌面 20 会让 Android 上峰值内存过高导致 WebView 崩溃。
const INCREMENTAL_PARSE_CONCURRENCY = 4;

const TTML_LOG_TAG = chalk.bgHex("#FF5577").hex("#FFFFFF")(" TTML DB ");

const MIRROR_BASE = "https://amlldb.bikonoo.com";

const getMirrorIndexUrl = (): string => {
	return `${MIRROR_BASE}/metadata/raw-lyrics-index.jsonl`;
};

const getMirrorLyricUrl = (fileName: string): string => {
	return `${MIRROR_BASE}/raw-lyrics/${fileName}`;
};

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
	for (let i = 0; i < retries; i++) {
		try {
			const res = await fetch(url);

			if (res.ok) return res;

			if (res.status === 404) {
				throw new Error("ABORT_RETRY_404");
			}

			if (res.status >= 500) {
				throw new Error(`HTTP Server Error ${res.status}`);
			}

			throw new Error(`HTTP Error ${res.status}`);
		} catch (err) {
			if (
				(err as Error).message === "ABORT_RETRY_404" ||
				(err as Error).message === "404 Not Found"
			) {
				throw new Error("404 Not Found");
			}

			if (i === retries - 1) throw err;
		}

		await new Promise((r) => setTimeout(r, 500 * (i + 1)));
	}
	throw new Error("重试后仍然失败");
}

export async function syncLyricsDatabase(store: Store): Promise<SyncResult> {
	return navigator.locks.request(
		"lyric-sync-lock",
		{ ifAvailable: true },
		async (lock) => {
			if (!lock) {
				console.log(TTML_LOG_TAG, "另一个标签页正在同步，跳过同步");
				return { status: SyncStatus.Locked };
			}

			try {
				const versionUrl = `${MIRROR_BASE}/raw-lyrics/version.json`;
				const versionRes = await fetch(versionUrl, { cache: "no-cache" });
				if (!versionRes.ok)
					throw new Error(`版本检查失败: ${versionRes.status}`);

				const remoteVersion: RemoteVersion = await versionRes.json();

				const localCommit = store.get(lyricDBVersionAtom);
				const localIntegrityCommit = store.get(lyricDBIntegrityVersionAtom);
				const localCount = await db.ttmlDB.count();
				console.log(
					TTML_LOG_TAG,
					`本地歌词库状态: count=${localCount}, version=${
						localCommit?.slice(0, 7) || "None"
					}, integrity=${localIntegrityCommit?.slice(0, 7) || "None"}, remote=${remoteVersion.commit.slice(0, 7)}, remoteCount=${remoteVersion.file_count}`,
				);

				if (localCommit === remoteVersion.commit) {
					// 仅当条目数与远端 file_count 一致、且上次同步整体成功（integrity 已落到同一 commit）才真正跳过。
					// 否则可能是 Android IndexedDB 丢条目、或上次同步中途失败，需要重新同步。
					if (
						localCount === remoteVersion.file_count &&
						localIntegrityCommit === remoteVersion.commit
					) {
						console.log(TTML_LOG_TAG, "歌词库已是最新，无需更新。");
						return { status: SyncStatus.Skipped };
					}
					console.warn(
						TTML_LOG_TAG,
						`本地歌词库需要完整性校验 (${localCount}/${remoteVersion.file_count})，重新同步。`,
					);
				}

				console.log(
					TTML_LOG_TAG,
					`检测到新版本 (Local: ${localCommit?.slice(0, 7) || "None"} -> Remote: ${remoteVersion.commit.slice(0, 7)})，开始下载...`,
				);

				let result: SyncResult;

				if (localCount === 0) {
					result = await performFullSync(store, remoteVersion);
				} else {
					try {
						result = await performIncrementalSync(store, remoteVersion);
					} catch (err) {
						console.warn(TTML_LOG_TAG, "增量更新失败:", err);
						result = await performFullSync(store, remoteVersion);
					}
				}

				return result;
			} catch (error) {
				console.error(TTML_LOG_TAG, "同步歌词时发生错误:", error);
				return { status: SyncStatus.Failed, error };
			}
		},
	);
}

// 每处理这么多 TTML 就让出一次主线程（setTimeout 0），避免 `parseTTML` 连续跑
// 几千次把 JS 主线程独占数十秒——那会让同一时刻的 Tauri IPC 响应、用户点击
// 全部卡住（Android WebView 上最明显）。50 是经验值：足够摊销 setTimeout 开销，
// 又不会让单个批次跑超过 100ms。
const PARSE_YIELD_BATCH = 50;

// macrotask 让渡，比 Promise.resolve()（microtask）更彻底——后者不会真正
// 让浏览器跑渲染/输入。
const yieldToEventLoop = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

async function performFullSync(
	store: Store,
	remoteVersion: RemoteVersion,
): Promise<SyncResult> {
	const zipUrl = `${MIRROR_BASE}/raw-lyrics/raw-lyrics.zip`;

	const res = await fetch(zipUrl);
	if (!res.ok) throw new Error(`下载zip失败: ${res.status}`);

	const zipBlob = await res.blob();
	const zip = await JSZip.loadAsync(zipBlob);

	const lyricsToInsert: { name: string; content: TTMLLyric; raw: string }[] =
		[];

	const ttmlEntries: { path: string; entry: JSZip.JSZipObject }[] = [];
	zip.forEach((relativePath, entry) => {
		if (entry.dir || !relativePath.endsWith(".ttml")) return;
		ttmlEntries.push({ path: relativePath, entry });
	});

	// 分批串行处理，每批内并发解压，批与批之间 setTimeout(0) 让渡事件循环
	for (let i = 0; i < ttmlEntries.length; i += PARSE_YIELD_BATCH) {
		const batch = ttmlEntries.slice(i, i + PARSE_YIELD_BATCH);
		await Promise.all(
			batch.map(async ({ path, entry }) => {
				try {
					const raw = await entry.async("string");
					lyricsToInsert.push({
						name: path,
						content: parseTTML(raw),
						raw: raw,
					});
				} catch (e) {
					console.warn(TTML_LOG_TAG, `解析歌词文件 ${path} 失败:`, e);
				}
			}),
		);
		if (i + PARSE_YIELD_BATCH < ttmlEntries.length) {
			await yieldToEventLoop();
		}
	}

	// 全量同步解析完成后，条目数必须和远端 file_count 一致；否则本次结果不可信，
	// 不能写入 integrity atom，让下次启动重新触发同步。
	if (lyricsToInsert.length !== remoteVersion.file_count) {
		throw new Error(
			`全量同步条目数不完整 (${lyricsToInsert.length}/${remoteVersion.file_count})`,
		);
	}

	if (lyricsToInsert.length > 0) {
		await db.transaction("rw", db.ttmlDB, async () => {
			// 清空后再 bulkPut：bulkPut 只覆盖同 key，不会删除远端已移除的旧条目。
			await db.ttmlDB.clear();
			await db.ttmlDB.bulkPut(lyricsToInsert);
		});
		store.set(lyricDBVersionAtom, remoteVersion.commit);
		store.set(lyricDBIntegrityVersionAtom, remoteVersion.commit);
		return {
			status: SyncStatus.Updated,
			count: lyricsToInsert.length,
			strategy: "full",
		};
	}

	return { status: SyncStatus.Empty };
}

async function performIncrementalSync(
	store: Store,
	remoteVersion: RemoteVersion,
): Promise<SyncResult> {
	const indexUrl = getMirrorIndexUrl();
	console.log(TTML_LOG_TAG, "下载索引:", indexUrl);

	const indexRes = await fetchWithRetry(indexUrl);
	const indexText = await indexRes.text();

	const remoteFiles = new Set<string>();
	indexText.split("\n").forEach((line) => {
		if (!line.trim()) return;
		try {
			const entry: IndexEntry = JSON.parse(line);
			if (entry.rawLyricFile) remoteFiles.add(entry.rawLyricFile);
		} catch (e) {
			console.warn(TTML_LOG_TAG, `解析索引文件失败:`, e);
		}
	});

	const localKeys = await db.ttmlDB.toCollection().keys();
	// IndexedDB 主键类型广义，这里统一成 string 才能正确与 remoteFiles 比较。
	const localFiles = new Set(localKeys.map(String));

	const toDownload: string[] = [];
	remoteFiles.forEach((file) => {
		if (!localFiles.has(file)) {
			toDownload.push(file);
		}
	});
	const toDelete: string[] = [];
	localFiles.forEach((file) => {
		if (!remoteFiles.has(file)) {
			toDelete.push(file);
		}
	});

	console.log(
		TTML_LOG_TAG,
		`需要下载 ${toDownload.length}, 删除 ${toDelete.length}, 远程有 ${remoteFiles.size}`,
	);

	const incrementalThreshold =
		platform() === "android"
			? ANDROID_INCREMENTAL_THRESHOLD
			: INCREMENTAL_THRESHOLD;
	if (toDownload.length > incrementalThreshold) {
		console.log(TTML_LOG_TAG, "转为全量下载", toDownload.length);
		return performFullSync(store, remoteVersion);
	}

	if (toDownload.length === 0 && toDelete.length === 0) {
		store.set(lyricDBVersionAtom, remoteVersion.commit);
		store.set(lyricDBIntegrityVersionAtom, remoteVersion.commit);
		return { status: SyncStatus.Skipped, count: 0, strategy: "incremental" };
	}

	const limit = pLimit(INCREMENTAL_PARSE_CONCURRENCY);
	const lyricsToInsert: { name: string; content: TTMLLyric; raw: string }[] =
		[];
	const errors: string[] = [];

	const tasks = toDownload.map((fileName) => {
		return limit(async () => {
			try {
				const rawUrl = getMirrorLyricUrl(fileName);
				const res = await fetchWithRetry(rawUrl);
				const raw = await res.text();

				lyricsToInsert.push({
					name: fileName,
					content: parseTTML(raw),
					raw: raw,
				});
			} catch (err) {
				errors.push(fileName);
				console.warn(TTML_LOG_TAG, `下载 ${fileName} 失败:`, err);
			}
		});
	});

	await Promise.all(tasks);

	if (lyricsToInsert.length > 0 || toDelete.length > 0) {
		await db.transaction("rw", db.ttmlDB, async () => {
			if (lyricsToInsert.length > 0) {
				await db.ttmlDB.bulkPut(lyricsToInsert);
			}
			if (toDelete.length > 0) {
				await db.ttmlDB.bulkDelete(toDelete);
			}
		});
	}

	// 任何一个文件下载失败都视作未完成：不写 integrity atom，下次启动会重试。
	if (errors.length > 0) {
		throw new Error(
			`增量同步未完整完成，失败 ${errors.length} 个文件: ${errors
				.slice(0, 5)
				.join(", ")}`,
		);
	}

	if (lyricsToInsert.length > 0 || toDelete.length > 0) {
		store.set(lyricDBVersionAtom, remoteVersion.commit);
		store.set(lyricDBIntegrityVersionAtom, remoteVersion.commit);

		console.log(
			TTML_LOG_TAG,
			`增量同步 ${lyricsToInsert.length}, 删除 ${toDelete.length}, 失败 ${errors.length}`,
		);
		return {
			status: SyncStatus.Updated,
			count: lyricsToInsert.length,
			strategy: "incremental",
		};
	}

	return {
		status: SyncStatus.Failed,
		error: "所有文件都下载失败了",
	};
}
