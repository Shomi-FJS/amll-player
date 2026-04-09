import { Box, Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import classNames from "classnames";
import { useAtomValue, useStore } from "jotai";
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
} from "@applemusic-like-lyrics/react-full";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "react-toastify";
import { StatsComponent } from "./components/StatsComponent/index.tsx";
import { router } from "./router.tsx";
import {
	displayLanguageAtom,
	enableAlwaysOnTopAtom,
	enableHttpServerAtom,
	hasBackgroundAtom,
	isDarkThemeAtom,
	MusicContextMode,
	musicContextModeAtom,
	showStatJSFrameAtom,
} from "./states/appAtoms.ts";
import { useInitializeWindow } from "./utils/useInitializeWindow.ts";

const ExtensionContext = lazy(() => import("./components/ExtensionContext"));
const AMLLWrapper = lazy(() => import("./components/AMLLWrapper"));

const STARTUP_DISCLAIMER_NOTICE =
	"免责声明与更新通告：\n特此声明：本项目的部分模块经 @Shomi-FJS 重新设计、调整。所有变更衍生功能、代码修改均为独立行为，与原始上游组织无涉责任，相关责任由本维护方独立承担。将根据更新周期，定期同步上游版本。谢谢~";

function App() {
	const store = useStore();

	useEffect(() => {
		const showWindow = async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				const win = getCurrentWindow();
				await win.show();
			} catch (e) {
				console.error("Failed to show window:", e);
			}
		};
		showWindow();
		if (import.meta.env.DEV) {
			setTimeout(showWindow, 150);
		}
	}, []);

	useEffect(() => {
		toast.info(
			<div
				style={{
					whiteSpace: "pre-line",
					lineHeight: 1.5,
				}}
			>
				{STARTUP_DISCLAIMER_NOTICE}
			</div>,
			{
				containerId: "top-right-toast",
				autoClose: 5000,
			},
		);
	}, []);

	useEffect(() => {
		const unlisten = listen("remote-http-command", (event: any) => {
			const payload = event.payload;
			if (payload.command === "setFontSize") {
				const newSize = payload.size as any;
				store.set(lyricSizePresetAtom, newSize);

				const sizeLabels: Record<string, string> = {
					tiny: "超小",
					"extra-small": "极小",
					small: "小",
					medium: "中",
					large: "大",
					"extra-large": "极大",
					huge: "超大",
				};

				const label = sizeLabels[newSize] || newSize;
				toast.info(`远程控制：歌词大小已设为"${label}"`, {
					containerId: "top-right-toast",
				});
			} else if (payload.command === "toggleTranslation") {
				const enabled = payload.enabled;
				store.set(enableLyricTranslationLineAtom, enabled);
				toast.info(`远程控制：歌词翻译已${enabled ? "开启" : "关闭"}`, {
					containerId: "top-right-toast",
				});
			}
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, [store]);

	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const showStatJSFrame = useAtomValue(showStatJSFrameAtom);
	const enableTaskbarLyric = useAtomValue(enableTaskbarLyricAtom);
	const musicContextMode = useAtomValue(musicContextModeAtom);
	const displayLanguage = useAtomValue(displayLanguageAtom);
	const isDarkTheme = useAtomValue(isDarkThemeAtom);
	const hasBackground = useAtomValue(hasBackgroundAtom);
	const { i18n } = useTranslation();

	useInitializeWindow();

	useEffect(() => {
		const enabled = store.get(enableHttpServerAtom);
		invoke("set_http_server_enabled", { enabled }).catch((err) => {
			console.error("同步 13533 端口控制服务状态失败", err);
		});
	}, [store]);

	useEffect(() => {
		const enabled = store.get(enableAlwaysOnTopAtom);
		invoke("set_window_always_on_top", { enabled }).catch((err) => {
			console.error("同步窗口置顶状态失败", err);
		});
	}, [store]);

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
