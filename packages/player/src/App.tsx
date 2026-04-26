import { Box, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import classNames from "classnames";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { lazy, StrictMode, Suspense, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { RouterProvider } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import styles from "./App.module.css";
import { AppContainer } from "./components/AppContainer/index.tsx";
import { ExtensionInjectPoint } from "./components/ExtensionInjectPoint/index.tsx";
import { LocalMusicContext } from "./components/LocalMusicContext/index.tsx";
import { NowPlayingBar } from "./components/NowPlayingBar/index.tsx";
import { ShotcutContext } from "./components/ShotcutContext/index.tsx";
import { TaskbarLyricBridge } from "./components/TaskbarLyricBridge/index.tsx";
import { ThemeManager } from "./components/ThemeManager/index.tsx";
import { UpdateContext } from "./components/UpdateContext/index.tsx";
import { WSProtocolMusicContext } from "./components/WSProtocolMusicContext/index.tsx";
import { enableTaskbarLyricAtom } from "./states/appAtoms.ts";
import "./i18n";
import {
	enableLyricTranslationLineAtom,
	isLyricPageOpenedAtom,
	lyricSizePresetAtom,
	lyricContributorAtom as reactFullLyricContributorAtom,
	showLyricContributorAtom as reactFullShowLyricContributorAtom,
} from "@applemusic-like-lyrics/react-full";
import { toast } from "react-toastify";
import { StatsComponent } from "./components/StatsComponent/index.tsx";
import { router } from "./router.tsx";
import {
	displayLanguageAtom,
	enableHttpServerAtom,
	hasBackgroundAtom,
	isDarkThemeAtom,
	lyricContributorAtom,
	MusicContextMode,
	musicContextModeAtom,
	showLyricContributorAtom,
	showStatJSFrameAtom,
	wsProtocolListenAddrAtom,
} from "./states/appAtoms.ts";
import { useInitializeWindow } from "./utils/useInitializeWindow.ts";

const ExtensionContext = lazy(() => import("./components/ExtensionContext"));
const AMLLWrapper = lazy(() => import("./components/AMLLWrapper"));

function App() {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const showStatJSFrame = useAtomValue(showStatJSFrameAtom);
	const enableTaskbarLyric = useAtomValue(enableTaskbarLyricAtom);
	const musicContextMode = useAtomValue(musicContextModeAtom);
	const displayLanguage = useAtomValue(displayLanguageAtom);
	const isDarkTheme = useAtomValue(isDarkThemeAtom);
	const hasBackground = useAtomValue(hasBackgroundAtom);
	const { i18n } = useTranslation();

	useInitializeWindow();

	const store = useStore();

	// 将本地贡献者 atom 镜像到 react-full 内部 atom,让其内置的 LyricContributorBadge
	// （进度条下方「逐词创作者：@xxx」那个）能读到同步状态
	const lyricContributor = useAtomValue(lyricContributorAtom);
	const showLyricContributor = useAtomValue(showLyricContributorAtom);
	const setReactFullLyricContributor = useSetAtom(
		reactFullLyricContributorAtom,
	);
	const setReactFullShowLyricContributor = useSetAtom(
		reactFullShowLyricContributorAtom,
	);
	useEffect(() => {
		setReactFullLyricContributor(lyricContributor);
	}, [lyricContributor, setReactFullLyricContributor]);
	useEffect(() => {
		setReactFullShowLyricContributor(showLyricContributor);
	}, [showLyricContributor, setReactFullShowLyricContributor]);
	useEffect(() => {
		const enabled = store.get(enableHttpServerAtom);
		invoke("set_http_server_enabled", { enabled }).catch((err) => {
			console.error("同步 HTTP 服务器状态失败", err);
		});
	}, [store]);

	// 远程 HTTP 控制：字体大小 / 歌词翻译开关
	useEffect(() => {
		const unlisten = listen<{ command: string; [k: string]: unknown }>(
			"remote-http-command",
			(event) => {
				const payload = event.payload;
				if (payload.command === "setFontSize") {
					const newSize = payload.size as string;
					store.set(lyricSizePresetAtom, newSize as never);
					const sizeLabels: Record<string, string> = {
						tiny: "超小",
						"extra-small": "极小",
						small: "小",
						medium: "中",
						large: "大",
						"extra-large": "极大",
						huge: "超大",
					};
					const label = sizeLabels[newSize] ?? newSize;
					toast.info(`远程控制：歌词大小已设为“${label}”`, {
						containerId: "top-right-toast",
					});
				} else if (payload.command === "toggleTranslation") {
					const enabled = payload.enabled as boolean;
					store.set(enableLyricTranslationLineAtom, enabled);
					toast.info(`远程控制：歌词翻译已${enabled ? "开启" : "关闭"}`, {
						containerId: "top-right-toast",
					});
				}
			},
		);
		return () => {
			unlisten.then((f) => f());
		};
	}, [store]);

	// 远程 HTTP 控制：WS 开放地址
	useEffect(() => {
		const unlisten = listen<string>("remote-set-ws-listen-addr", (event) => {
			const addr = event.payload;
			if (typeof addr === "string" && addr.length > 0) {
				store.set(wsProtocolListenAddrAtom, addr);
				toast.info(`远程控制：WS 开放地址已设为 ${addr}`, {
					containerId: "top-right-toast",
				});
			}
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, [store]);

	// 远程 HTTP 控制：全屏 / 窗口置顶 状态反馈
	useEffect(() => {
		const unlistenFullscreen = listen<{ enabled: boolean }>(
			"remote-fullscreen",
			(event) => {
				const enabled = event.payload?.enabled;
				toast.info(`远程控制：${enabled ? "进入" : "退出"}全屏播放`, {
					containerId: "top-right-toast",
				});
			},
		);
		const unlistenAlwaysOnTop = listen<{ enabled: boolean }>(
			"remote-always-on-top",
			(event) => {
				const enabled = event.payload?.enabled;
				toast.info(`远程控制：窗口置顶已${enabled ? "开启" : "关闭"}`, {
					containerId: "top-right-toast",
				});
			},
		);
		return () => {
			unlistenFullscreen.then((f) => f());
			unlistenAlwaysOnTop.then((f) => f());
		};
	}, []);

	useLayoutEffect(() => {
		i18n.changeLanguage(displayLanguage);
	}, [displayLanguage]);

	return (
		<>
			{/* 上下文组件均不建议被 StrictMode 包含，以免重复加载扩展程序发生问题  */}
			{showStatJSFrame && <StatsComponent />}
			{musicContextMode === MusicContextMode.Local && (
				<LocalMusicContext key={MusicContextMode.Local} />
			)}
			{enableTaskbarLyric && <TaskbarLyricBridge />}
			{musicContextMode === MusicContextMode.WSProtocol && (
				<WSProtocolMusicContext
					key={MusicContextMode.WSProtocol}
					isLyricOnly={false}
				/>
			)}

			<UpdateContext />
			<ShotcutContext />
			<ThemeManager />
			<Suspense>
				<ExtensionContext />
			</Suspense>
			<ExtensionInjectPoint injectPointName="context" hideErrorCallout />

			<StrictMode>
				<Theme
					appearance={isDarkTheme ? "dark" : "light"}
					panelBackground="solid"
					hasBackground={hasBackground}
					className={styles.radixTheme}
				>
					<Box
						className={classNames(
							styles.body,
							isLyricPageOpened && styles.amllOpened,
						)}
					>
						<AppContainer playbar={<NowPlayingBar />}>
							<RouterProvider router={router} />
						</AppContainer>
						{/* <Box className={styles.container}>
							<RouterProvider router={router} />
						</Box> */}
					</Box>
					<Suspense>
						<AMLLWrapper />
					</Suspense>
					<ToastContainer
						theme="dark"
						position="bottom-right"
						style={{
							marginBottom: "150px",
						}}
					/>
					<ToastContainer
						theme="dark"
						position="top-right"
						autoClose={1800}
						containerId="top-right-toast"
					/>
				</Theme>
			</StrictMode>
		</>
	);
}

export default App;
