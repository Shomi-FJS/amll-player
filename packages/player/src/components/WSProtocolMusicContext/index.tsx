import { FFTPlayer } from "@applemusic-like-lyrics/fft";
import { parseTTML } from "@applemusic-like-lyrics/lyric";
import {
	contributorSourceAtom,
	fftDataAtom,
	fftDataRangeAtom,
	hideLyricViewAtom,
	isLyricPageOpenedAtom,
	isShuffleActiveAtom,
	lyricContributorAtom,
	musicAlbumNameAtom,
	musicArtistsAtom,
	musicCoverAtom,
	musicDurationAtom,
	musicIdAtom,
	musicLyricLinesAtom,
	musicNameAtom,
	musicPlayingAtom,
	musicPlayingPositionAtom,
	musicVolumeAtom,
	onChangeVolumeAtom,
	onClickControlThumbAtom,
	onCycleRepeatModeAtom,
	onLyricLineClickAtom,
	onPlayOrResumeAtom,
	onRequestNextSongAtom,
	onRequestPrevSongAtom,
	onSeekPositionAtom,
	onToggleShuffleAtom,
	RepeatMode,
	repeatModeAtom,
	showLyricContributorAtom,
} from "@applemusic-like-lyrics/react-full";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type FC, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	MusicContextMode,
	musicContextModeAtom,
	wsProtocolConnectedAddrsAtom,
	wsProtocolListenAddrAtom,
	currentLyricAuthorsAtom,
	currentSongWritersAtom,
} from "../../states/appAtoms.ts";
import { emitAudioThread } from "../../utils/player.ts";
import {
	fetchLyricContributorByNCMId,
	setContributorSource,
} from "../../utils/ttml-contributor-search.ts";
import type { ContributorSourceMode } from "../../utils/ttml-contributor-search.ts";
import { FFTToLowPassContext } from "../LocalMusicContext/index.tsx";

interface WSArtist {
	id: string;
	name: string;
}

interface WSLyricWord {
	startTime: number;
	endTime: number;
	word: string;
	romanWord: string;
}

interface WSLyricLine {
	startTime: number;
	endTime: number;
	words: WSLyricWord[];
	isBG: boolean;
	isDuet: boolean;
	translatedLyric: string;
	romanLyric: string;
}

interface WSMusicInfo {
	musicId: string;
	musicName: string;
	albumId: string;
	albumName: string;
	artists: WSArtist[];
	duration: number;
}

interface WSImageData {
	mimeType: string;
	data: string;
}

type WSAlbumCover =
	| { source: "uri"; url: string }
	| { source: "data"; image: WSImageData };

type WSLyricContent =
	| { format: "structured"; lines: WSLyricLine[] }
	| { format: "ttml"; data: string };

type WSCommand =
	| { command: "pause" }
	| { command: "resume" }
	| { command: "forwardSong" }
	| { command: "backwardSong" }
	| { command: "setVolume"; volume: number }
	| { command: "seekPlayProgress"; progress: number }
	| { command: "setRepeatMode"; mode: RepeatMode }
	| { command: "setShuffleMode"; enabled: boolean };

type WSStateUpdate =
	| ({ update: "setMusic" } & WSMusicInfo)
	| ({ update: "setCover" } & WSAlbumCover)
	| ({ update: "setLyric" } & WSLyricContent)
	| { update: "progress"; progress: number }
	| { update: "volume"; volume: number }
	| { update: "paused" }
	| { update: "resumed" }
	| { update: "audioData"; data: number[] }
	| { update: "modeChanged"; repeat: RepeatMode; shuffle: boolean };

type WSPayload =
	| { type: "initialize" }
	| { type: "ping" }
	| { type: "pong" }
	| { type: "command"; value: WSCommand }
	| { type: "state"; value: WSStateUpdate };

interface WSProtocolMusicContextProps {
	isLyricOnly?: boolean;
}

export const WSProtocolMusicContext: FC<WSProtocolMusicContextProps> = ({
	isLyricOnly = false,
}) => {
	const wsProtocolListenAddr = useAtomValue(wsProtocolListenAddrAtom);
	const setConnectedAddrs = useSetAtom(wsProtocolConnectedAddrsAtom);
	const setIsLyricPageOpened = useSetAtom(isLyricPageOpenedAtom);
	const store = useStore();
	const { t } = useTranslation();
	const fftPlayer = useRef<FFTPlayer | undefined>(undefined);
	const contributorFetchTimerRef = useRef<number | null>(null);
	const fftDataRange = useAtomValue(fftDataRangeAtom);

	useEffect(() => {
		const source = store.get(contributorSourceAtom);
		setContributorSource(source as ContributorSourceMode);
	}, [store]);

	useEffect(() => {
		if (!isLyricOnly) {
			emitAudioThread("pauseAudio");
		}
	}, [isLyricOnly]);

	useEffect(() => {
		let canceled = false;
		const fft = new FFTPlayer();
		fft.setFreqRange(fftDataRange[0], fftDataRange[1]);
		fftPlayer.current = fft;
		const result = new Float32Array(64);

		const onFFTFrame = () => {
			if (canceled) return;
			fftPlayer.current?.read(result);
			store.set(fftDataAtom, [...result]);
			requestAnimationFrame(onFFTFrame);
		};

		requestAnimationFrame(onFFTFrame);

		return () => {
			canceled = true;
			fftPlayer.current?.free();
			fftPlayer.current = undefined;
		};
	}, [fftDataRange, store]);

	useEffect(() => {
		if (!wsProtocolListenAddr && !isLyricOnly) {
			return;
		}

		setConnectedAddrs(new Set());

		if (!isLyricOnly) {
			store.set(musicNameAtom, "等待连接中");
			store.set(musicAlbumNameAtom, "");
			store.set(musicCoverAtom, "");
			store.set(musicArtistsAtom, []);
			store.set(isShuffleActiveAtom, false);
			store.set(repeatModeAtom, RepeatMode.Off);
		}

		function sendWSCommand(command: WSCommand) {
			const payload: WSPayload = { type: "command", value: command };
			invoke("ws_broadcast_payload", { payload });
		}

		if (!isLyricOnly) {
			const toEmit = <T,>(onEmit: T) => ({ onEmit });
			store.set(
				onToggleShuffleAtom,
				toEmit(() => {
					const currentShuffle = store.get(isShuffleActiveAtom);
					sendWSCommand({
						command: "setShuffleMode",
						enabled: !currentShuffle,
					});
				}),
			);
			store.set(
				onCycleRepeatModeAtom,
				toEmit(() => {
					const currentRepeat = store.get(repeatModeAtom);
					const nextMode: RepeatMode =
						currentRepeat === RepeatMode.Off
							? RepeatMode.All
							: currentRepeat === RepeatMode.All
								? RepeatMode.One
								: RepeatMode.Off;
					sendWSCommand({ command: "setRepeatMode", mode: nextMode });
				}),
			);
			store.set(
				onRequestNextSongAtom,
				toEmit(() => sendWSCommand({ command: "forwardSong" })),
			);
			store.set(
				onRequestPrevSongAtom,
				toEmit(() => sendWSCommand({ command: "backwardSong" })),
			);
			store.set(
				onPlayOrResumeAtom,
				toEmit(() => {
					const command = store.get(musicPlayingAtom) ? "pause" : "resume";
					sendWSCommand({ command });
				}),
			);
			store.set(
				onSeekPositionAtom,
				toEmit((progress) => {
					sendWSCommand({
						command: "seekPlayProgress",
						progress: progress | 0,
					});
				}),
			);
			store.set(
				onLyricLineClickAtom,
				toEmit((evt, playerRef) => {
					sendWSCommand({
						command: "seekPlayProgress",
						progress: evt.line.getLine().startTime | 0,
					});
					playerRef?.lyricPlayer?.resetScroll();
				}),
			);
			store.set(
				onChangeVolumeAtom,
				toEmit((volume) => {
					sendWSCommand({ command: "setVolume", volume });
				}),
			);
			store.set(
				onClickControlThumbAtom,
				toEmit(() => setIsLyricPageOpened(false)),
			);
		}

		const unlistenConnected = listen<string>(
			"on-ws-protocol-client-connected",
			(evt) => {
				invoke("ws_broadcast_payload", {
					payload: { type: "ping" },
				});
				setConnectedAddrs((prev) => new Set([...prev, evt.payload]));
			},
		);

		function getRemoteCommandMessage(cmd: WSCommand): string | null {
			switch (cmd.command) {
				case "pause":
					return t("ws-protocol.remoteCommand.pause", "远程用户执行：暂停");
				case "resume":
					return t(
						"ws-protocol.remoteCommand.resume",
						"远程用户执行：继续播放",
					);
				case "forwardSong":
					return t("ws-protocol.remoteCommand.next", "远程用户执行：下一首");
				case "backwardSong":
					return t("ws-protocol.remoteCommand.prev", "远程用户执行：上一首");
				case "setVolume":
					return t(
						"ws-protocol.remoteCommand.volume",
						"远程用户执行：调整音量",
					);
				case "seekPlayProgress":
					return t("ws-protocol.remoteCommand.seek", "远程用户执行：调整进度");
				case "setRepeatMode":
					return t(
						"ws-protocol.remoteCommand.repeat",
						"远程用户执行：切换循环模式",
					);
				case "setShuffleMode":
					return t(
						"ws-protocol.remoteCommand.shuffle",
						"远程用户执行：切换随机模式",
					);
				default:
					return null;
			}
		}

		function showRemoteNotification(message: string, duration = 2000) {
			toast.info(message, {
				containerId: "top-right-toast",
				autoClose: duration,
			});
		}

		const unlistenRemoteHttp = listen<WSCommand>(
			"remote-http-command",
			(evt) => {
				sendWSCommand(evt.payload);
				const message = getRemoteCommandMessage(evt.payload);
				if (message) {
					showRemoteNotification(message);
				}
			},
		);

		const onBodyChannel = new Channel<WSPayload>();

		function updateRemoteNowPlaying() {
			const currentMode = store.get(musicContextModeAtom);
			if (currentMode !== MusicContextMode.WSProtocol) {
				return;
			}
			const musicName = store.get(musicNameAtom);
			const musicArtists = store.get(musicArtistsAtom);
			const musicAlbum = store.get(musicAlbumNameAtom);
			const musicCover = store.get(musicCoverAtom);
			const musicPlaying = store.get(musicPlayingAtom);

			if (
				!musicName ||
				musicName === "等待连接中" ||
				musicArtists.length === 0
			) {
				return;
			}

			invoke("update_remote_now_playing", {
				info: {
					title: musicName,
					artist: musicArtists.map((a) => a.name).join("/"),
					album: musicAlbum,
					isPlaying: musicPlaying,
					cover: musicCover,
				},
			}).catch((err) => {
				console.error("更新远程播放信息失败", err);
			});
		}

		function onBody(payload: WSPayload) {
			if (payload.type === "ping") {
				invoke("ws_broadcast_payload", { payload: { type: "pong" } });
				return;
			}

			if (payload.type !== "state") {
				return;
			}

			if (isLyricOnly) {
				const isLyricUpdate =
					payload.value.update === "setLyric" ||
					payload.value.update === "setMusic";
				if (!isLyricUpdate) {
					return;
				}
			}

			const state = payload.value;
			switch (state.update) {
				case "setMusic": {
					const currentMusicId = state.musicId;
					store.set(musicIdAtom, state.musicId);
					store.set(musicNameAtom, state.musicName);
					store.set(musicAlbumNameAtom, state.albumName);
					store.set(musicDurationAtom, state.duration);
					store.set(
						musicArtistsAtom,
						state.artists.map((v) => ({ id: v.id, name: v.name })),
					);
					store.set(musicPlayingPositionAtom, 0);
					store.set(lyricContributorAtom, null);
					store.set(currentLyricAuthorsAtom, []);
					store.set(currentSongWritersAtom, []);
					if (contributorFetchTimerRef.current !== null) {
						window.clearTimeout(contributorFetchTimerRef.current);
						contributorFetchTimerRef.current = null;
					}
					if (
						currentMusicId &&
						/^\d+$/.test(currentMusicId)
					) {
						contributorFetchTimerRef.current = window.setTimeout(() => {
							fetchLyricContributorByNCMId(currentMusicId)
								.then((result) => {
									const latestMusicId = store.get(musicIdAtom);
									if (latestMusicId === currentMusicId) {
										if (result.contributor && store.get(showLyricContributorAtom)) {
											store.set(lyricContributorAtom, result.contributor);
										}
										if (result.lyricAuthors.length > 0) {
											store.set(currentLyricAuthorsAtom, result.lyricAuthors);
										}
										if (result.songWriters.length > 0) {
											store.set(currentSongWritersAtom, result.songWriters);
										}
									}
								})
								.catch((err) => {
									console.error("获取贡献者失败:", err);
								})
								.finally(() => {
									contributorFetchTimerRef.current = null;
								});
						}, 120);
					}
					updateRemoteNowPlaying();
					break;
				}
				case "setCover": {
					console.log("Received setCover message:", state);
					if (state.source === "uri") {
						console.log("Setting cover from URI:", state.url);
						store.set(musicCoverAtom, state.url);
					} else {
						try {
							const { mimeType, data: base64Data } = state.image;
							console.log(
								"Setting cover from base64, mimeType:",
								mimeType,
								"data length:",
								base64Data.length,
							);

							if (!base64Data || base64Data.length === 0) {
								console.error("Cover base64 data is empty");
								store.set(musicCoverAtom, "");
								break;
							}

							// Use data URL instead of blob URL to avoid "Not allowed to load local resource" error
							const dataUrl = `data:${mimeType};base64,${base64Data}`;
							console.log("Created data URL for cover");
							store.set(musicCoverAtom, dataUrl);
						} catch (error) {
							console.error("Failed to create cover data URL:", error);
							store.set(musicCoverAtom, "");
						}
					}
					updateRemoteNowPlaying();
					break;
				}
				case "setLyric": {
					let lines: WSLyricLine[];
					let contributor: string | null = null;
					let lyricAuthors: string[] = [];
					let songWriters: string[] = [];

					if (state.format === "structured") {
						lines = state.lines;
					} else {
						try {
							const ttmlResult = parseTTML(state.data);
							lines = ttmlResult.lines;
							const authorMeta = ttmlResult.metadata?.find(
								([key]) => key === "ttmlAuthorGithubLogin",
							);
							contributor = authorMeta?.[1]?.[0] ?? null;

							if (ttmlResult.metadata) {
								for (const [key, values] of ttmlResult.metadata) {
									if (key === "ttmlAuthorGithubLogin") {
										lyricAuthors = values;
									} else if (key === "songWriters") {
										songWriters = values;
									}
								}
							}
						} catch (e) {
							console.error(e);
							toast.error(
								t(
									"ws-protocol.toast.ttmlParseError",
									"解析来自 WS 发送端的 TTML 歌词时出错：{{error}}",
									{ error: String(e) },
								),
							);
							return;
						}
					}

					const processed = lines.map((line) => ({
						...line,
						words: line.words.map((word) => ({ ...word, obscene: false })),
					}));
					store.set(hideLyricViewAtom, processed.length === 0);
					store.set(musicLyricLinesAtom, processed);

					const hasWordLyrics = processed.some(
						(line) => line.words && line.words.length > 0,
					);
					if (contributor && hasWordLyrics) {
						store.set(lyricContributorAtom, contributor);
					}

					store.set(currentLyricAuthorsAtom, lyricAuthors);
					store.set(currentSongWritersAtom, songWriters);
					break;
				}
				case "progress": {
					store.set(musicPlayingPositionAtom, state.progress);
					break;
				}
				case "volume": {
					store.set(musicVolumeAtom, state.volume);
					break;
				}
				case "paused": {
					store.set(musicPlayingAtom, false);
					updateRemoteNowPlaying();
					break;
				}
				case "resumed": {
					store.set(musicPlayingAtom, true);
					updateRemoteNowPlaying();
					break;
				}
				case "audioData": {
					fftPlayer.current?.pushDataI16(
						48000,
						2,
						new Int16Array(new Uint8Array(state.data).buffer),
					);
					break;
				}
				case "modeChanged": {
					store.set(repeatModeAtom, state.repeat);
					store.set(isShuffleActiveAtom, state.shuffle);
					break;
				}
				default:
					console.log(
						"on-ws-protocol-client-body",
						"未处理的报文（暂不支持）",
						payload,
					);
			}
		}

		onBodyChannel.onmessage = onBody;

		// const unlistenBody = listen("on-ws-protocol-client-body", onBody);
		const unlistenDisconnected = listen<string>(
			"on-ws-protocol-client-disconnected",
			(evt) =>
				setConnectedAddrs(
					(prev) => new Set([...prev].filter((v) => v !== evt.payload)),
				),
		);
		invoke<string[]>("ws_get_connections").then((addrs) =>
			setConnectedAddrs(new Set(addrs)),
		);
		invoke("ws_close_connection").then(() => {
			const addr = wsProtocolListenAddr || "127.0.0.1:11444";
			invoke("ws_reopen_connection", { addr, channel: onBodyChannel });
		});
		return () => {
			if (contributorFetchTimerRef.current !== null) {
				window.clearTimeout(contributorFetchTimerRef.current);
				contributorFetchTimerRef.current = null;
			}

			unlistenConnected.then((u) => u());
			unlistenDisconnected.then((u) => u());
			unlistenRemoteHttp.then((u) => u());

			invoke("ws_close_connection");

			const doNothing = { onEmit: () => {} };
			store.set(onRequestNextSongAtom, doNothing);
			store.set(onRequestPrevSongAtom, doNothing);
			store.set(onPlayOrResumeAtom, doNothing);
			store.set(onSeekPositionAtom, doNothing);
			store.set(onLyricLineClickAtom, doNothing);
			store.set(onChangeVolumeAtom, doNothing);
			store.set(onClickControlThumbAtom, doNothing);
			store.set(onToggleShuffleAtom, doNothing);
			store.set(onCycleRepeatModeAtom, doNothing);

			if (!isLyricOnly) {
				store.set(musicNameAtom, "");
				store.set(musicAlbumNameAtom, "");
				store.set(musicCoverAtom, "");
				store.set(musicArtistsAtom, []);
				store.set(musicIdAtom, "");
				store.set(musicDurationAtom, 0);
				store.set(musicPlayingPositionAtom, 0);
				store.set(musicPlayingAtom, false);
				store.set(musicLyricLinesAtom, []);
				store.set(musicVolumeAtom, 1);
				store.set(lyricContributorAtom, null);
				store.set(currentLyricAuthorsAtom, []);
				store.set(currentSongWritersAtom, []);
			}
		};
	}, [
		wsProtocolListenAddr,
		setConnectedAddrs,
		store,
		t,
		isLyricOnly,
		setIsLyricPageOpened,
	]);

	if (isLyricOnly) {
		return null;
	}

	return <FFTToLowPassContext />;
};