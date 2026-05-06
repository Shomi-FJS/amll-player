import type { SongData } from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export enum DarkMode {
	Auto = "auto",
	Light = "light",
	Dark = "dark",
}

export enum MusicContextMode {
	Local = "local",
	WSProtocol = "ws-protocol",
	AndroidMediaCapture = "android-media-capture",
}

export const displayLanguageAtom = atomWithStorage(
	"amll-player.displayLanguage",
	"zh-CN",
);

export const darkModeAtom = atomWithStorage(
	"amll-player.darkMode",
	DarkMode.Auto,
);

export const musicContextModeAtom = atomWithStorage(
	"amll-player.musicContextMode",
	MusicContextMode.Local,
);

/**
 * 歌词库的版本号，从 version.json 的 commit 字段获得
 */
export const lyricDBVersionAtom = atomWithStorage<string | null>(
	"amll-player.lyricDBVersion",
	null,
	undefined,
	{ getOnInit: true },
);

/**
 * 歌词库完整性校验版本：只有在本地条目数与远端 file_count 一致、
 * 且同步过程无任何失败条目时，才会被写入为对应 commit。
 * 用于在 Android WebView 上检测 IndexedDB 丢条目后触发重建。
 */
export const lyricDBIntegrityVersionAtom = atomWithStorage<string | null>(
	"amll-player.lyricDBIntegrityVersion",
	null,
	undefined,
	{ getOnInit: true },
);

export const advanceLyricDynamicLyricTimeAtom = atomWithStorage(
	"amll-player.advanceLyricDynamicLyricTimeAtom",
	false,
);

const enableMediaControlsInternalAtom = atomWithStorage(
	"amll-player.enableMediaControls",
	true,
);

export const enableMediaControlsAtom = atom(
	(get) => get(enableMediaControlsInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableMediaControlsInternalAtom, enabled);
		invoke("set_media_controls_enabled", { enabled }).catch((err) => {
			console.error("设置媒体控件的启用状态失败", err);
		});
	},
);

const enableAlwaysOnTopInternalAtom = atomWithStorage(
	"amll-player.enableAlwaysOnTop",
	false,
);

export const enableAlwaysOnTopAtom = atom(
	(get) => get(enableAlwaysOnTopInternalAtom),
	(_get, set, enabled: boolean) => {
		set(enableAlwaysOnTopInternalAtom, enabled);
		invoke("set_window_always_on_top", { enabled }).catch((err) => {
			console.error("设置窗口置顶状态失败", err);
		});
	},
);

export const wsProtocolListenAddrAtom = atomWithStorage(
	"amll-player.wsProtocolListenAddr",
	"localhost:11444",
);

export const showStatJSFrameAtom = atomWithStorage(
	"amll-player.showStatJSFrame",
	false,
);

export const autoDarkModeAtom = atom(true);

export const isDarkThemeAtom = atom(
	(get) =>
		get(darkModeAtom) === DarkMode.Auto
			? get(autoDarkModeAtom)
			: get(darkModeAtom) === DarkMode.Dark,
	(_get, set, newIsDark: boolean) =>
		set(darkModeAtom, newIsDark ? DarkMode.Dark : DarkMode.Light),
);

export const hasBackgroundAtom = atom(false);

export const playlistCardOpenedAtom = atom(false);

export const recordPanelOpenedAtom = atom(false);

export const amllMenuOpenedAtom = atom(false);

export const hideNowPlayingBarAtom = atom(false);

export const wsProtocolConnectedAddrsAtom = atom(new Set<string>());

export const isCheckingUpdateAtom = atom(false);

export const updateInfoAtom = atom<Update | false>(false);

export const autoUpdateAtom = atomWithStorage("amll-player.autoUpdate", true);

export const enableTaskbarLyricAtom = atomWithStorage(
	"amll-player.enableTaskbarLyric",
	false,
);

export const audioQualityDialogOpenedAtom = atom(false);

export const taskbarLyricThemeSettingAtom = atomWithStorage<
	"auto" | "light" | "dark"
>("amll-player.taskbarLyricTheme", "auto");
export const taskbarLyricAlignSettingAtom = atomWithStorage<
	"auto" | "left" | "right"
>("amll-player.taskbarLyricAlign", "auto");

export const taskbarLyricModeSettingAtom = atomWithStorage<
	"auto" | "single" | "double"
>("amll-player.taskbarLyricMode", "auto");

export enum BottomLyricDisplayMode {
	None = "none",
	OnlyLyricAuthors = "only-lyric-authors",
	OnlySongWriters = "only-song-writers",
	PreferLyricAuthors = "prefer-lyric-authors",
	PreferSongWriters = "prefer-song-writers",
}

export const bottomLyricDisplayModeAtom =
	atomWithStorage<BottomLyricDisplayMode>(
		"amll-player.bottomLyricDisplayMode",
		BottomLyricDisplayMode.PreferSongWriters,
	);

export const currentLyricAuthorsAtom = atom<string[]>([]);

export const currentSongWritersAtom = atom<string[]>([]);

export const currentPlaylistAtom = atom<SongData[]>([]);

export const currentPlaylistMusicIndexAtom = atom(0);

// ── Android 媒体会话捕捉相关 ──
export interface AndroidMediaSessionInfo {
	packageName: string;
	sessionId: number;
	isCurrent: boolean;
}

export const androidMediaCaptureSessionsAtom = atom<AndroidMediaSessionInfo[]>(
	[],
);

export const androidMediaCaptureSelectedPackageAtom = atom<string>("");

export const androidMediaCapturePermissionAtom = atom<boolean>(false);

/**
 * 当前 Android 捕捉会话播放的歌曲对应的 lyricOffsets 主键；空串代表当前没有
 * 已识别歌词的歌曲（无歌词或尚未匹配完成），UI 据此判断是否显示偏移滑块。
 * 由 AndroidMediaCaptureContext 在歌词匹配成功后写入。
 */
export const androidMediaCaptureLyricOffsetKeyAtom = atom<string>("");

/**
 * 当前歌曲歌词偏移量（毫秒，+ 表示歌词后移）。
 * UI 滑块拖动时实时写入；AndroidMediaCaptureContext 监听该原子重新对原始歌词
 * 行应用偏移并 set musicLyricLinesAtom。松手时由 UI 端持久化到 Dexie。
 */
export const androidMediaCaptureLyricOffsetMsAtom = atom<number>(0);

/**
 * 当前歌曲的「尾部时长」：音频总时长 - TTML 最后一行 endTime（毫秒）。
 * 大于阈值时 UI 推断歌词可能存在延迟（如杜比全景声前导静音），弹出顶部提示。
 * 0 表示尚未计算或不可用（无歌词 / 无 duration）。
 */
export const androidMediaCaptureLyricTailMsAtom = atom<number>(0);
