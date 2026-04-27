import { invoke } from "@tauri-apps/api/core";
import { type EventCallback, listen } from "@tauri-apps/api/event";
import chalk from "chalk";
import { uid } from "uid";

export interface AudioThreadEventMessage<T> {
	callbackId: string;
	data: T;
}

export interface AudioQuality {
	sampleRate?: number;
	bitsPerCodedSample?: number;
	bitsPerSample?: number;
	channels?: number;
	sampleFormat?: string;
	codec?: string;
}

export interface AudioInfo {
	name: string;
	artist: string;
	album: string;
	lyric: string;
	duration: number;
	position: number;
}

export type SongData =
	| {
			type: "local";
			filePath: string;
			origOrder: number;
	  }
	| {
			type: "custom";
			id: string;
			songJsonData: string;
			origOrder: number;
	  };

export type AudioThreadMessageMap = {
	resumeAudio: undefined;
	pauseAudio: undefined;
	resumeOrPauseAudio: undefined;
	seekAudio: {
		position: number;
	};
	playAudio: {
		song: SongData;
	};
	setVolume: {
		volume: number;
	};
	setVolumeRelative: {
		volume: number;
	};
	setAudioOutput: {
		name: string;
	};
	setFFTRange: {
		fromFreq: number;
		toFreq: number;
	};
	setMediaControlsEnabled: {
		enabled: boolean;
	};
	close: undefined;
};

export type AudioThreadMessageKeys = keyof AudioThreadMessageMap;

export type AudioThreadMessagePayloadMap = {
	[T in AudioThreadMessageKeys]: AudioThreadMessageMap[T] extends undefined
		? { type: T }
		: { type: T } & AudioThreadMessageMap[T];
};

export type AudioThreadMessage =
	AudioThreadMessagePayloadMap[AudioThreadMessageKeys];

export type AudioThreadEvent =
	| {
			type: "playPosition";
			data: { position: number };
	  }
	| {
			type: "loadProgress";
			data: { position: number };
	  }
	| {
			type: "loadAudio";
			data: {
				musicId: string;
				musicInfo: AudioInfo;
				quality: AudioQuality;
			};
	  }
	| {
			type: "loadingAudio";
			data: { musicId: string };
	  }
	| {
			type: "audioPlayFinished";
			data: { musicId: string };
	  }
	| {
			type: "trackEnded";
	  }
	| {
			type: "hardwareMediaCommand";
			data: { command: string };
	  }
	| {
			type: "playStatus";
			data: { isPlaying: boolean };
	  }
	| {
			type: "loadError";
			data: { error: string };
	  }
	| {
			type: "playError";
			data: { error: string };
	  }
	| {
			type: "volumeChanged";
			data: { volume: number };
	  }
	| {
			type: "fftData";
			data: { data: number[] };
	  };

const msgTasks = new Map<string, (value: AudioThreadEvent) => void>();
const eventListeners = new Set<
	EventCallback<AudioThreadEventMessage<AudioThreadEvent>>
>();

let isInitialized = false;

export async function initAudioThread() {
	if (isInitialized) {
		return;
	}
	isInitialized = true;

	console.log(
		chalk.bgHex("#FF7700").hex("#FFFFFF")(" BACKEND  "),
		"后台线程连接初始化中",
	);

	await listen<AudioThreadEventMessage<AudioThreadEvent>>(
		"plugin:player-core-event",
		(evt) => {
			const resolve = msgTasks.get(evt.payload.callbackId);
			if (resolve) {
				msgTasks.delete(evt.payload.callbackId);
				resolve(evt.payload.data);
			}

			eventListeners.forEach((listener) => {
				try {
					listener(evt);
				} catch (e) {
					console.error("Error in audio event listener callback:", e);
				}
			});
		},
	);
	console.log(
		chalk.bgHex("#FF7700").hex("#FFFFFF")(" BACKEND "),
		"后台线程连接初始化完成",
	);
}

export const listenAudioThreadEvent = (
	handler: EventCallback<AudioThreadEventMessage<AudioThreadEvent>>,
): Promise<() => void> => {
	eventListeners.add(handler);
	const unlisten = () => {
		eventListeners.delete(handler);
	};
	return Promise.resolve(unlisten);
};

export async function resolveContentUri(filePath: string): Promise<string> {
	return await invoke("resolve_content_uri", { filePath });
}

/**
 * 在 Android 上弹出系统 SAF 目录选择器（`ACTION_OPEN_DOCUMENT_TREE`），
 * 返回选中的 tree URI 字符串；用户取消时返回 `null`。
 *
 * 由于 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })` 在 mobile
 * 端未实现（"Folder picker is not implemented on mobile"），本项目通过
 * `MainActivity.pickDirectoryTree` 桥接实现。仅 Android 可用。
 */
export async function pickDirectoryTreeUri(): Promise<string | null> {
	return await invoke("pick_directory_tree_uri");
}

/**
 * 在 Android 上通过 `ContentResolver` + `OpenableColumns.DISPLAY_NAME`
 * 查询 `content://` URI 的真实文件名（如 `xxx.js`）。
 *
 * Tauri 2 的 `path.basename` 会拒绝非 `file://` 协议的 URL（抛
 * "URL is not a valid path"），所以从 SAF 选择器拿到的 content URI 必须
 * 走这个命令拿文件名。Provider 不暴露 display name 时返回 `null`。
 */
export async function queryContentDisplayName(
	uri: string,
): Promise<string | null> {
	return await invoke("query_content_display_name", { uri });
}

/**
 * 扫描 SAF 目录树返回音频文件真实路径列表（仅 Android）。
 * @param recursive false=只扫本层；true=递归子目录。
 */
export async function scanAudioInTreeUri(
	treeUri: string,
	recursive = true,
): Promise<string[]> {
	return await invoke("scan_audio_in_tree_uri", { treeUri, recursive });
}

/** 后端取消扫描时报的错误特征串，前端据此识别「用户取消」。 */
export const SCAN_CANCELED_TOKEN = "__CANCELED__";

/** 中断当前 `scan_audio_in_tree_uri`，幂等。 */
export async function cancelScanAudioInTreeUri(): Promise<void> {
	await invoke("cancel_scan_audio_in_tree_uri");
}

export async function readLocalMusicMetadata(filePath: string): Promise<{
	name: string;
	artist: string;
	album: string;
	lyricFormat: string;
	lyric: string;
	cover: number[];
	duration: number;
}> {
	return await invoke("read_local_music_metadata", { filePath });
}

export async function restartApp(): Promise<never> {
	return await invoke("restart_app");
}

export async function emitAudioThread<T extends keyof AudioThreadMessageMap>(
	msgType: T,
	...args: AudioThreadMessageMap[T] extends undefined
		? []
		: [data: AudioThreadMessageMap[T]]
): Promise<void> {
	const id = uid(32) + Date.now();

	const payloadData = args[0]
		? { type: msgType, ...args[0] }
		: { type: msgType };

	await invoke("local_player_send_msg", {
		msg: {
			callbackId: id,
			data: payloadData,
		},
	});
}

export function emitAudioThreadRet<T extends keyof AudioThreadMessageMap>(
	msgType: T,
	...args: AudioThreadMessageMap[T] extends undefined
		? []
		: [data: AudioThreadMessageMap[T]]
): Promise<AudioThreadEvent> {
	const id = `${uid(32)}-${Date.now()}`;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			msgTasks.delete(id);
			reject(new Error(`等待 ${msgType} 的回应超时`));
		}, 5000);

		msgTasks.set(id, (val) => {
			clearTimeout(timeout);
			resolve(val);
		});

		const payloadData = args[0]
			? { type: msgType, ...args[0] }
			: { type: msgType };

		invoke("local_player_send_msg", {
			msg: { callbackId: id, data: payloadData },
		}).catch((err) => {
			clearTimeout(timeout);
			msgTasks.delete(id);
			reject(err);
		});
	});
}
