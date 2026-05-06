import type { LyricLine as CoreLyricLine } from "@applemusic-like-lyrics/core";
import {
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicDurationAtom,
	musicIdAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	onClickControlThumbAtom,
	onLyricLineClickAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	onSeekPositionAtom,
} from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSetAtom, useStore } from "jotai";
import { type FC, useEffect, useRef } from "react";
import type { TTMLDBLyricEntry } from "../../dexie.ts";
import {
	type AndroidMediaSessionInfo,
	androidMediaCaptureLyricOffsetKeyAtom,
	androidMediaCaptureLyricOffsetMsAtom,
	androidMediaCaptureLyricTailMsAtom,
	androidMediaCapturePermissionAtom,
	androidMediaCaptureSelectedPackageAtom,
	androidMediaCaptureSessionsAtom,
	currentLyricAuthorsAtom,
	currentSongWritersAtom,
} from "../../states/appAtoms.ts";
import {
	SyncStatus,
	syncLyricsDatabase,
} from "../../utils/lyric-sync-manager.ts";
import {
	findBestTTMLMatch,
	loadAllTTMLEntries,
} from "../../utils/lyricAutoMatch.ts";
import {
	applyOffsetToLines,
	buildLyricOffsetKey,
	computeLyricTailMs,
	getLyricOffset,
} from "../../utils/lyricOffsets.ts";
import { emitAudioThread } from "../../utils/player.ts";

interface CaptureEvent {
	json: string;
}

// Kotlin -> Rust -> 这里的事件类型；与 MediaCaptureManager.kt 保持一致
type CaptureMessage =
	| {
			type: "sessions";
			list: AndroidMediaSessionInfo[];
	  }
	| {
			type: "metadata";
			packageName: string;
			title: string;
			artist: string;
			album: string;
			duration: number;
			cover: string;
	  }
	| {
			type: "playbackState";
			playing: boolean;
			position: number;
			speed: number;
			updateTime: number;
			rawState?: number;
	  }
	| { type: "selected"; packageName: string }
	| { type: "selectionLost" }
	| { type: "selectionCleared" }
	| { type: "selectionFailed"; packageName: string };

/**
 * 捕捉其它 Android 应用的 MediaSession 状态并桥接到 react-full 的歌词页面 atom。
 *
 * 与 [`WSProtocolMusicContext`] 类似，本组件挂载即接管「正在播放」相关 atom；
 * 卸载时清空。除位置外推（基于 `position + (now - updateTime)`）外，所有
 * 元数据都直接来自系统 MediaSession 回调，不做缓存。
 */
export const AndroidMediaCaptureContext: FC = () => {
	const store = useStore();
	const setSessions = useSetAtom(androidMediaCaptureSessionsAtom);
	const setSelectedPackage = useSetAtom(androidMediaCaptureSelectedPackageAtom);
	const setPermission = useSetAtom(androidMediaCapturePermissionAtom);
	const setIsLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);

	const setLyricAuthors = useSetAtom(currentLyricAuthorsAtom);
	const setSongWriters = useSetAtom(currentSongWritersAtom);

	// TTML 全表 promise 的组件级缓存。在 Android WebView 上 `db.ttmlDB.toArray()`
	// 反序列化几千条已 parse 好的 TTML 需要 1-3 秒并阻塞主线程；如果每次切歌都重读
	// 全表，连续切歌时旧 lookup 会被新 token 反复作废，结果歌词永远卡在最初一首。
	// 这里只在第一次需要 / 同步完成后失效一次，所有 lookup 共用同一份。
	const ttmlEntriesPromiseRef = useRef<Promise<TTMLDBLyricEntry[]> | null>(
		null,
	);
	const getCachedTTMLEntries = (): Promise<TTMLDBLyricEntry[]> => {
		if (!ttmlEntriesPromiseRef.current) {
			ttmlEntriesPromiseRef.current = loadAllTTMLEntries();
		}
		return ttmlEntriesPromiseRef.current;
	};

	// 进入此模式立刻暂停本地播放器，避免双声道混播
	useEffect(() => {
		emitAudioThread("pauseAudio");
	}, []);

	// 触发歌词库同步（与 LocalMusicContext 同款 idle 调度）。
	// 捕捉模式不挂载 LocalMusicContext，否则歌词库永远不会被同步/更新。
	useEffect(() => {
		const start = () => {
			syncLyricsDatabase(store).then((result) => {
				if (result.status === SyncStatus.Updated) {
					console.log(
						`[AndroidMediaCapture] 歌词库更新完成，新增 ${result.count} 个`,
					);
					// 同步带来了新条目，必须失效缓存让下次 lookup 重新拉
					ttmlEntriesPromiseRef.current = null;
				}
			});
		};
		if (typeof window.requestIdleCallback === "function") {
			const handle = window.requestIdleCallback(start, { timeout: 10_000 });
			return () => window.cancelIdleCallback(handle);
		}
		const timer = window.setTimeout(start, 3_000);
		return () => window.clearTimeout(timer);
	}, [store]);

	useEffect(() => {
		let canceled = false;
		// 位置外推：playbackState 报上来的 (position, updateTime, speed)
		// 是采样时刻的进度；播放过程中要本地按速度推进，否则 UI 会一直停在采样点。
		let basePosition = 0;
		let baseUpdateTime = 0;
		let curSpeed = 1.0;
		let curPlaying = false;

		// 初始权限检查 + 启动捕捉
		(async () => {
			try {
				const has = await invoke<boolean>(
					"android_media_capture_has_permission",
				);
				if (canceled) return;
				setPermission(has);
				if (!has) return;
				const started = await invoke<boolean>("android_media_capture_start");
				if (canceled) return;
				setPermission(started);
			} catch (e) {
				console.error("启动 Android 媒体捕捉失败", e);
			}
		})();

		const sendCmd = (cmd: string, arg = 0) => {
			invoke("android_media_capture_send_command", { cmd, arg }).catch((err) =>
				console.warn("send_command 失败", cmd, err),
			);
		};

		const toEmit = <T,>(onEmit: T) => ({ onEmit });

		store.set(
			onPlayOrResumeAtom,
			toEmit(() => {
				sendCmd(curPlaying ? "pause" : "play");
			}),
		);
		store.set(
			onRequestNextSongAtom,
			toEmit(() => sendCmd("next")),
		);
		store.set(
			onRequestPrevSongAtom,
			toEmit(() => sendCmd("previous")),
		);
		store.set(
			onSeekPositionAtom,
			toEmit((progress) => {
				// react-full 给的是毫秒数（与 musicPlayingPositionAtom 同单位）。
				// 避免用 `| 0`——JS 的 int32 截断会把超过 24.8 天的毫秒值变负数。
				sendCmd("seek", Math.round(progress));
			}),
		);
		store.set(
			onLyricLineClickAtom,
			toEmit((evt, playerRef) => {
				sendCmd("seek", Math.round(evt.line.getLine().startTime));
				playerRef?.lyricPlayer?.resetScroll();
			}),
		);
		store.set(
			onClickControlThumbAtom,
			toEmit(() => setIsLyricPageOpened(false)),
		);

		// 每次 metadata 变更生成的 token；新查询会作废旧查询的回调，避免快速切歌
		// 时旧匹配结果在新结果之后回来覆盖最新歌词。
		let lyricLookupToken = 0;
		// 上一次实际触发过 lookup 的歌曲键，避免同一首歌的 metadata 事件重复匹配
		// （某些播放器会因封面/进度变化重发 onMetadataChanged）。
		let lastLyricKey = "";
		// 当前匹配到的「原始」歌词行（未应用 offset）。offset 变化时基于这份
		// 数据重算 musicLyricLinesAtom；切歌或清空时被置空。
		let rawLyricLines: CoreLyricLine[] = [];

		const clearLyric = () => {
			rawLyricLines = [];
			store.set(musicLyricLinesAtom, []);
			store.set(hideLyricViewAtom, true);
			setLyricAuthors([]);
			setSongWriters([]);
			// 清掉 offset 相关原子：UI 滑块据此隐藏。
			store.set(androidMediaCaptureLyricOffsetKeyAtom, "");
			store.set(androidMediaCaptureLyricOffsetMsAtom, 0);
			store.set(androidMediaCaptureLyricTailMsAtom, 0);
		};

		// 监听 offset 原子变化（UI 滑块拖动时实时更新），把当前 raw lines 重新
		// 应用 offset 后写入 musicLyricLinesAtom。这是单向的 raw → lyric 投影，
		// raw 仅在 applyLyricFromTTML 成功匹配时被 set。
		const unsubOffset = store.sub(androidMediaCaptureLyricOffsetMsAtom, () => {
			if (rawLyricLines.length === 0) return;
			const offset = store.get(androidMediaCaptureLyricOffsetMsAtom);
			store.set(musicLyricLinesAtom, applyOffsetToLines(rawLyricLines, offset));
		});

		const applyLyricFromTTML = async (
			title: string,
			artist: string,
			album: string,
			packageName: string,
			durationMs: number,
		) => {
			const myToken = ++lyricLookupToken;
			if (!title) {
				clearLyric();
				return;
			}
			try {
				// 复用组件级缓存的全表 promise；首次切歌仍要等 IDB 反序列化，
				// 之后所有切歌都是 in-memory，几乎瞬时。
				const all = await getCachedTTMLEntries();
				if (myToken !== lyricLookupToken || canceled) return;
				const matched = findBestTTMLMatch(
					{
						songName: title,
						// 与 Song.songArtists 同格式：用 "/" 拼接
						songArtists: artist,
						songAlbum: album,
					},
					all,
				);
				if (myToken !== lyricLookupToken || canceled) return;
				if (!matched) {
					clearLyric();
					return;
				}
				const ttml = matched.entry.content;
				const lines: CoreLyricLine[] = ttml.lines.map((line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						obscene: false,
					})),
				}));
				rawLyricLines = lines;

				// 计算「尾部时长」：音频总长 - 末行 endTime；UI 据此判断是否
				// 弹出顶部「歌词可能延迟」提示。0 表示无可用数据或恰好对齐。
				const lastEnd = lines.reduce((m, l) => Math.max(m, l.endTime), 0);
				store.set(
					androidMediaCaptureLyricTailMsAtom,
					computeLyricTailMs(durationMs, lastEnd),
				);

				// 查持久化的 offset：按 (packageName | title | artist | album |
				// durBucketSec) 找；找到就立刻应用，没有就 0。Atmos 与立体声两个
				// mix 因 duration 差 ~1.3s 会落在不同 bucket → 各自独立 offset。
				const offsetKey = buildLyricOffsetKey(
					packageName,
					title,
					artist,
					album,
					durationMs,
				);
				const offsetMs = await getLyricOffset(offsetKey);
				if (myToken !== lyricLookupToken || canceled) return;
				store.set(androidMediaCaptureLyricOffsetKeyAtom, offsetKey);
				store.set(androidMediaCaptureLyricOffsetMsAtom, offsetMs);
				// 上面 set offset 会触发订阅器投影；但首次匹配时订阅可能还没把
				// rawLyricLines 当成新值处理（订阅是从 set 之后才触发的，已经
				// 包含本次新 raw），保险起见这里直接显式投影一次。
				store.set(
					musicLyricLinesAtom,
					applyOffsetToLines(rawLyricLines, offsetMs),
				);
				store.set(hideLyricViewAtom, lines.length === 0);

				let lyricAuthors: string[] = [];
				let songWriters: string[] = [];
				if (Array.isArray(ttml.metadata)) {
					for (const [k, v] of ttml.metadata) {
						if (k === "ttmlAuthorGithubLogin") lyricAuthors = v;
						else if (k === "songWriters") songWriters = v;
					}
				}
				setLyricAuthors(lyricAuthors);
				setSongWriters(songWriters);
			} catch (e) {
				if (myToken === lyricLookupToken && !canceled) {
					console.warn("[AndroidMediaCapture] 歌词匹配失败", e);
					clearLyric();
				}
			}
		};

		let curCoverUrl = "";
		const setCoverFromBase64 = (b64: string) => {
			if (curCoverUrl) {
				URL.revokeObjectURL(curCoverUrl);
				curCoverUrl = "";
			}
			if (!b64) {
				store.set(musicCoverAtom, "");
				return;
			}
			try {
				const bin = atob(b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const url = URL.createObjectURL(
					new Blob([bytes], { type: "image/jpeg" }),
				);
				curCoverUrl = url;
				store.set(musicCoverAtom, url);
			} catch (e) {
				console.warn("解析 cover base64 失败", e);
				store.set(musicCoverAtom, "");
			}
		};

		const handle = (msg: CaptureMessage) => {
			switch (msg.type) {
				case "sessions":
					setSessions(msg.list);
					break;
				case "selected":
					setSelectedPackage(msg.packageName);
					break;
				case "selectionLost":
				case "selectionCleared":
					setSelectedPackage("");
					store.set(musicNameAtom, "");
					store.set(musicArtistsAtom, []);
					store.set(musicAlbumNameAtom, "");
					store.set(musicDurationAtom, 0);
					store.set(musicPlayingPositionAtom, 0);
					store.set(musicPlayingAtom, false);
					setCoverFromBase64("");
					clearLyric();
					break;
				case "selectionFailed":
					setSelectedPackage("");
					break;
				case "metadata": {
					// 系统报上来的 artist 字段在多人合作时通常是 "A / B" 或 "A、B"。
					// 这里按 "/" 拆分，与 importMusic 写入 Song.songArtists 的约定保持一致。
					const artistList = msg.artist
						? msg.artist
								.split(/[/、]/)
								.map((s) => s.trim())
								.filter(Boolean)
						: [];
					const songArtists = artistList.join("/");

					// 元数据相关 atom 总是写入 + 封面总是更新：
					// 很多播放器切歌后分两次推 metadata（第一次没封面，第二次封面就绪），
					// 这里不做 dedup 才能保证封面能被第二次事件填上。Kotlin 端已经
					// 通过 (title|artist|album|duration|coverFp) 拦截了真正不变的事件，
					// 所以这里的写入次数有上限（每首歌最多 1~2 次）。
					store.set(musicIdAtom, `android-media:${msg.packageName}`);
					store.set(musicNameAtom, msg.title);
					store.set(musicAlbumNameAtom, msg.album);
					store.set(
						musicArtistsAtom,
						artistList.map((name) => ({ id: name, name })),
					);
					// duration 单位是毫秒
					store.set(musicDurationAtom, msg.duration);
					setCoverFromBase64(msg.cover);

					// 仅歌词查找做 dedup：title/artist/album 不变就不重新跑全表评分，
					// 避免播放器为了补封面重发 metadata 时把已加载的歌词又抹掉重查。
					const newKey = `${msg.packageName}\u0001${msg.title}\u0001${songArtists}\u0001${msg.album}`;
					if (newKey !== lastLyricKey) {
						lastLyricKey = newKey;
						// 切歌瞬间立即清空旧歌词，避免显示上一首的内容；首次缓存
						// 加载完成（≤几秒）后会被新匹配结果替换。
						clearLyric();
						applyLyricFromTTML(
							msg.title,
							songArtists,
							msg.album,
							msg.packageName,
							msg.duration,
						);
					}
					break;
				}
				case "playbackState": {
					curPlaying = msg.playing;
					curSpeed =
						Number.isFinite(msg.speed) && msg.speed > 0 ? msg.speed : 1;
					basePosition = Math.max(0, msg.position);
					// Kotlin 侧已把 updateTime 换算成 System.currentTimeMillis() 时基，
					// 直接作为本地 Date.now() 上的采样时刻使用。
					// 兜底：若设备时钟跳变导致 updateTime 在未来，退回 now 避免外推爆炸。
					const now = Date.now();
					baseUpdateTime =
						msg.updateTime > 0 && msg.updateTime <= now ? msg.updateTime : now;
					store.set(musicPlayingAtom, curPlaying);
					store.set(musicPlayingPositionAtom, basePosition);
					break;
				}
			}
		};

		const unlistenPromise = listen<CaptureEvent>(
			"android-media-capture-event",
			(evt) => {
				try {
					const parsed = JSON.parse(evt.payload.json) as CaptureMessage;
					handle(parsed);
				} catch (e) {
					console.warn("解析 capture 事件失败", e, evt.payload.json);
				}
			},
		);

		// 本地位置推进：每 250ms tick 一次
		const ticker = window.setInterval(() => {
			if (!curPlaying) return;
			const pos = basePosition + (Date.now() - baseUpdateTime) * curSpeed;
			store.set(musicPlayingPositionAtom, Math.max(0, Math.round(pos)));
		}, 250);

		return () => {
			canceled = true;
			window.clearInterval(ticker);
			unsubOffset();
			unlistenPromise.then((u) => u());
			invoke("android_media_capture_stop").catch(() => {});

			const doNothing = { onEmit: () => {} };
			store.set(onRequestNextSongAtom, doNothing);
			store.set(onRequestPrevSongAtom, doNothing);
			store.set(onPlayOrResumeAtom, doNothing);
			store.set(onSeekPositionAtom, doNothing);
			store.set(onLyricLineClickAtom, doNothing);
			store.set(onClickControlThumbAtom, doNothing);

			if (curCoverUrl) {
				URL.revokeObjectURL(curCoverUrl);
				curCoverUrl = "";
			}

			store.set(musicNameAtom, "");
			store.set(musicArtistsAtom, []);
			store.set(musicAlbumNameAtom, "");
			store.set(musicCoverAtom, "");
			store.set(musicIdAtom, "");
			store.set(musicDurationAtom, 0);
			store.set(musicPlayingPositionAtom, 0);
			store.set(musicPlayingAtom, false);
			store.set(musicLyricLinesAtom, []);
			store.set(androidMediaCaptureLyricOffsetKeyAtom, "");
			store.set(androidMediaCaptureLyricOffsetMsAtom, 0);
			store.set(androidMediaCaptureLyricTailMsAtom, 0);
			setLyricAuthors([]);
			setSongWriters([]);
			setSessions([]);
			setSelectedPackage("");
		};
	}, [
		store,
		setSessions,
		setSelectedPackage,
		setPermission,
		setIsLyricPageOpened,
		setLyricAuthors,
		setSongWriters,
	]);

	return null;
};
