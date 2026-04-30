import { PlusIcon } from "@radix-ui/react-icons";
import {
	Button,
	Dialog,
	Flex,
	RadioGroup,
	Select,
	Text,
	TextField,
} from "@radix-ui/themes";
import { platform } from "@tauri-apps/plugin-os";
import { type FC, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { db } from "../../dexie.ts";
import { scanFolderAndImportToPlaylist } from "../../utils/importMusic.ts";
import { pickDirectoryTreeUri } from "../../utils/player.ts";

type PlaylistSource =
	| "amll-player:local"
	| "amll-player:android-music"
	| "amll-player:android-folder-scan";

export const NewPlaylistButton: FC = () => {
	const [name, setName] = useState("");
	const [source, setSource] = useState<PlaylistSource>("amll-player:local");
	const [open_, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [folderScanRecursive, setFolderScanRecursive] = useState(true);
	const { t } = useTranslation();

	const isAndroid = useMemo(() => {
		try {
			return platform() === "android";
		} catch {
			return false;
		}
	}, []);

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

		if (source !== "amll-player:android-folder-scan") {
			await createEmptyPlaylist();
			setName("");
			setSource("amll-player:local");
			setOpen(false);
			return;
		}

		setBusy(true);
		try {
			let treeUri: string | null;
			try {
				treeUri = await pickDirectoryTreeUri();
			} catch (err) {
				toast.error(
					t(
						"newPlaylist.dialog.folderScan.toast.pickerFailed",
						"无法打开文件夹选择器：{error}",
						{ error: err instanceof Error ? err.message : String(err) },
					),
				);
				return;
			}
			if (!treeUri) return;

			const playlistId = await createEmptyPlaylist({
				folderScanTreeUri: treeUri,
				folderScanRecursive,
			});

			await scanFolderAndImportToPlaylist({
				playlistId,
				treeUri,
				t,
				recursive: folderScanRecursive,
			});

			setName("");
			setSource("amll-player:local");
			setOpen(false);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root open={open_} onOpenChange={setOpen}>
			<Dialog.Trigger>
				<Button variant="soft">
					<PlusIcon />
					<Trans i18nKey="newPlaylist.buttonLabel">新建播放列表</Trans>
				</Button>
			</Dialog.Trigger>
			<Dialog.Content maxWidth="450px">
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
							{isAndroid && (
								<>
									<Select.Item value="amll-player:android-folder-scan">
										{t(
											"newPlaylist.dialog.source.androidFolderScan",
											"扫描文件夹建立索引（Android）",
										)}
									</Select.Item>
									<Select.Item value="amll-player:android-music">
										{t(
											"newPlaylist.dialog.source.androidMedia",
											"Android 内容提供者 - 音频媒体（未实现）",
										)}
									</Select.Item>
								</>
							)}
						</Select.Content>
					</Select.Root>
					{source === "amll-player:android-folder-scan" && (
						<>
							<Text>
								{t("newPlaylist.dialog.folderScan.depthLabel", "扫描深度")}
							</Text>
							<RadioGroup.Root
								value={folderScanRecursive ? "recursive" : "shallow"}
								onValueChange={(v) => setFolderScanRecursive(v === "recursive")}
							>
								<Flex gap="2" align="center">
									<RadioGroup.Item value="recursive" id="recursive" />
									<Text as="label" htmlFor="recursive">
										{t(
											"newPlaylist.dialog.folderScan.depth.recursive",
											"包含所有子文件夹（推荐）",
										)}
									</Text>
								</Flex>
								<Flex gap="2" align="center">
									<RadioGroup.Item value="shallow" id="shallow" />
									<Text as="label" htmlFor="shallow">
										{t(
											"newPlaylist.dialog.folderScan.depth.shallow",
											"仅扫描所选文件夹",
										)}
									</Text>
								</Flex>
							</RadioGroup.Root>
						</>
					)}
				</Flex>
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button type="button" variant="soft" color="gray">
							<Trans i18nKey="common.dialog.cancel">取消</Trans>
						</Button>
					</Dialog.Close>
					<Dialog.Close disabled={cannotCreate}>
						<Button
							type="submit"
							disabled={cannotCreate}
							onClick={onAddPlaylist}
						>
							<Trans i18nKey="common.dialog.confirm">确认</Trans>
						</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
