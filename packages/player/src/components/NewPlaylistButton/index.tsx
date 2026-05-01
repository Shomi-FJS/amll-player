import { PlusIcon } from "@radix-ui/react-icons";
import {
	Button,
	Callout,
	Dialog,
	Flex,
	RadioGroup,
	Select,
	Text,
	TextField,
} from "@radix-ui/themes";
import { platform } from "@tauri-apps/plugin-os";
import { type FC, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { db } from "../../dexie.ts";
import { scanFolderAndImportToPlaylist } from "../../utils/importMusic.ts";
import { pickDirectoryTreeUri } from "../../utils/player.ts";

type PlaylistSource =
	| "amll-player:local"
	| "amll-player:android-music"
	| "amll-player:android-folder-scan";

// 平台运行时不会变，提到模块级；Android 上文件夹扫描是主用例，默认即选它
const IS_ANDROID = (() => {
	try {
		return platform() === "android";
	} catch {
		return false;
	}
})();
const DEFAULT_SOURCE: PlaylistSource = IS_ANDROID
	? "amll-player:android-folder-scan"
	: "amll-player:local";

export const NewPlaylistButton: FC = () => {
	const [name, setName] = useState("");
	const [source, setSource] = useState<PlaylistSource>(DEFAULT_SOURCE);
	const [open_, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [parseProgress, setParseProgress] = useState<{
		processed: number;
		total: number;
	} | null>(null);
	// 「文件夹扫描」源专属的扫描深度选择，默认递归（兼容旧行为）。
	const [folderScanRecursive, setFolderScanRecursive] = useState(true);
	// busy 期间点击「取消」要求中止 picker / 扫描 / 导入；存在 ref 里避免重渲
	// 染导致丢失。每次 onAddPlaylist 走到扫描分支时重新赋值。
	const abortRef = useRef<AbortController | null>(null);
	const { t } = useTranslation();

	const isAndroid = IS_ANDROID;

	const cannotCreate = useMemo(
		() => name.trim().length === 0 || busy,
		[name, busy],
	);

	const createEmptyPlaylist = async (extra?: {
		folderScanTreeUri?: string;
		folderScanRecursive?: boolean;
	}): Promise<number> => {
		const id = await db.playlists.add({
			name: name.trim(),
			createTime: Date.now(),
			updateTime: Date.now(),
			playTime: 0,
			songIds: [],
			...(extra ?? {}),
		});
		return Number(id);
	};

	const onAddPlaylist = async () => {
		if (cannotCreate) return;

		// 默认流程：源不是安卓文件夹扫描时，只需创建一个空歌单即可。
		if (source !== "amll-player:android-folder-scan") {
			await createEmptyPlaylist();
			setName("");
			setSource(DEFAULT_SOURCE);
			setOpen(false);
			return;
		}

		// 安卓文件夹扫描流程：唤起选择器 → 扫描音频 → 创建歌单 → 导入。
		const ac = new AbortController();
		abortRef.current = ac;
		setParseProgress(null);
		setBusy(true);
		try {
			let treeUri: string | null;
			try {
				treeUri = await pickDirectoryTreeUri();
			} catch (err) {
				if (ac.signal.aborted) return;
				toast.error(
					t(
						"newPlaylist.dialog.folderScan.toast.pickerFailed",
						"无法打开文件夹选择器：{error}",
						{ error: err instanceof Error ? err.message : String(err) },
					),
				);
				return;
			}
			// picker 无法从 JS 侧中途关闭；picker 返回后才能检查中止状态。
			if (!treeUri || ac.signal.aborted) return;

			// 先创建歌单拿到 id，后面导入才有一个明确的写入目标。
			// 把 tree URI 一并存进歌单，便于以后在详情页一键刷新该目录。
			// 即使本次扫描被取消，歌单本身也已建好，下次进详情页可以直接点
			// 「刷新文件夹」继续。
			const playlistId = await createEmptyPlaylist({
				folderScanTreeUri: treeUri,
				folderScanRecursive,
			});
			await scanFolderAndImportToPlaylist({
				playlistId,
				treeUri,
				t,
				recursive: folderScanRecursive,
				signal: ac.signal,
				onProgress: setParseProgress,
			});

			setName("");
			setSource(DEFAULT_SOURCE);
			setOpen(false);
		} finally {
			if (abortRef.current === ac) abortRef.current = null;
			setBusy(false);
		}
	};

	// 对话框「取消」按钮：busy 期间中止 picker/扫描/导入，仍然立即关闭对话框；
	// 后台扫描会通过共享的 toast UI 展示「正在取消...」。
	const onCancelDialog = () => {
		abortRef.current?.abort();
		setOpen(false);
	};

	return (
		<Dialog.Root
			open={open_}
			onOpenChange={(o) => {
				// ESC / 点遮罩关闭走与「取消」按钮同一条路径，保证后台任务会被中止。
				if (!o) {
					onCancelDialog();
					return;
				}
				setOpen(o);
			}}
		>
			<Dialog.Trigger>
				<Button variant="soft">
					<PlusIcon />
					<Trans i18nKey="newPlaylist.buttonLabel">新建播放列表</Trans>
				</Button>
			</Dialog.Trigger>
			<Dialog.Content
				maxWidth="450px"
				onInteractOutside={(e) => {
					// Android 上手抖很容易点到对话框外面就把刚填的歌单名/选项弄丢了；
					// 强制要求显式点「取消」或「确认」才能关闭。桌面端保持默认行为。
					if (IS_ANDROID) e.preventDefault();
				}}
				onEscapeKeyDown={(e) => {
					if (IS_ANDROID) e.preventDefault();
				}}
			>
				<Dialog.Title>
					<Trans i18nKey="newPlaylist.dialog.title">新建歌单</Trans>
				</Dialog.Title>
				<Flex gap="3" direction="column">
					<Text>
						<Trans i18nKey="newPlaylist.dialog.name">歌单名称</Trans>
					</Text>
					<TextField.Root
						placeholder={t("newPlaylist.dialog.namePlaceholder", "歌单名称")}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						autoFocus
					/>
					<Text>{t("newPlaylist.dialog.sourceLabel", "歌单管理源")}</Text>
					<Select.Root
						value={source}
						onValueChange={(v) => setSource(v as PlaylistSource)}
					>
						<Select.Trigger
							placeholder={t(
								"newPlaylist.dialog.sourcePlaceholder",
								"歌单管理源",
							)}
						/>
						<Select.Content>
							<Select.Item value="amll-player:local">
								{t("newPlaylist.dialog.source.local", "本地歌曲源")}
							</Select.Item>
							<Select.Item value="amll-player:android-music" disabled>
								{t(
									"newPlaylist.dialog.source.androidMedia",
									"安卓内容提供者 - 音频媒体源（暂未实现）",
								)}
							</Select.Item>
							{isAndroid && (
								<Select.Item value="amll-player:android-folder-scan">
									{t(
										"newPlaylist.dialog.source.androidFolderScan",
										"扫描指定文件夹建立索引（Android）",
									)}
								</Select.Item>
							)}
						</Select.Content>
					</Select.Root>
					{source === "amll-player:android-folder-scan" && (
						<Flex direction="column" gap="2">
							<Text>
								{t("newPlaylist.dialog.folderScan.depthLabel", "扫描范围")}
							</Text>
							<RadioGroup.Root
								value={folderScanRecursive ? "recursive" : "shallow"}
								onValueChange={(v) => setFolderScanRecursive(v === "recursive")}
							>
								<RadioGroup.Item value="recursive">
									{t(
										"newPlaylist.dialog.folderScan.depth.recursive",
										"包含所有子文件夹（推荐）",
									)}
								</RadioGroup.Item>
								<RadioGroup.Item value="shallow">
									{t(
										"newPlaylist.dialog.folderScan.depth.shallow",
										"仅扫描所选文件夹本层",
									)}
								</RadioGroup.Item>
							</RadioGroup.Root>
							{busy && (
								<Callout.Root color="amber" variant="surface">
									<Callout.Text>
										{parseProgress
											? t(
													"page.playlist.addLocalMusic.toast.parsingMusicMetadata",
													"正在解析音乐元数据以添加歌曲 ({current, plural, other {#}} / {total, plural, other {#}})",
													{
														current: parseProgress.processed,
														total: parseProgress.total,
													},
												)
											: t(
													"page.playlist.addLocalMusic.toast.firstImportHint",
													"初始化导入中，请耐心等待",
												)}
									</Callout.Text>
								</Callout.Root>
							)}
						</Flex>
					)}
				</Flex>
				<Flex gap="3" mt="4" justify="end">
					<Button
						type="button"
						variant="soft"
						color="gray"
						onClick={onCancelDialog}
					>
						<Trans i18nKey="common.dialog.cancel">取消</Trans>
					</Button>
					<Button
						type="submit"
						disabled={cannotCreate}
						onClick={onAddPlaylist}
						loading={busy}
					>
						<Trans i18nKey="common.dialog.confirm">确认</Trans>
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
