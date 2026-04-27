import { Button, Flex, Text } from "@radix-ui/themes";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { type Id, toast } from "react-toastify";
import { importAudioFilesToPlaylist } from "./importMusic.ts";
import {
	cancelScanAudioInTreeUri,
	SCAN_CANCELED_TOKEN,
	scanAudioInTreeUri,
} from "./player.ts";

/** 扫描+导入一条龙并在 toast 上提供取消按钮。 */
export interface ScanAndImportResult {
	/** 是否在过程中（扫描或导入）被用户取消。 */
	canceled: boolean;
	/** 扫描出的音频文件总数（被取消时可能为 0）。 */
	scannedCount: number;
	/** 实际成功写入数据库的歌曲数。 */
	importedCount: number;
	/** 解析失败的文件列表，调用方可以渲染成对话框给用户排查。 */
	failedList: { path: string; error: string }[];
}

export async function scanFolderAndImportToPlaylist(opts: {
	playlistId: number;
	treeUri: string;
	t: TFunction;
	/**
	 * 是否递归进入所选目录的子文件夹。默认 true 维持升级前的行为；UI
	 * 上的「包含子文件夹」开关把这个参数明确暴露给用户。
	 */
	recursive?: boolean;
}): Promise<ScanAndImportResult> {
	const { playlistId, treeUri, t, recursive = true } = opts;

	const importController = new AbortController();
	let cancelRequested = false;

	const onCancelClick = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		// 两条通路都打一遍：要么 Rust 还在扫描，要么 JS 已经在导入了，
		// 两边都打一遍信号比维护一个细粒度状态机更稳。
		void cancelScanAudioInTreeUri();
		importController.abort();
	};

	const renderToast = (message: string): ReactNode => (
		<Flex align="center" justify="between" gap="3" width="100%">
			<Text size="2" style={{ flex: 1, minWidth: 0 }}>
				{message}
			</Text>
			<Button
				size="1"
				variant="soft"
				color="gray"
				onClick={onCancelClick}
				disabled={cancelRequested}
				style={{ flexShrink: 0 }}
			>
				{cancelRequested
					? t("page.playlist.folderScanRefresh.toast.canceling", "正在取消...")
					: t("common.dialog.cancel", "取消")}
			</Button>
		</Flex>
	);

	// 用 toast()（普通类型）而不是 toast.loading()：后者会塞入 spinner 并对内容
	// 做 truncate / 单行高度限制，导致自定义按钮在 Android 窄屏被裁掉。
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
