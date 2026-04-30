import { musicPlayingPositionAtom } from "@applemusic-like-lyrics/react-full";
import {
	ArrowLeftIcon,
	Pencil1Icon,
	PlayIcon,
	PlusIcon,
	UpdateIcon,
} from "@radix-ui/react-icons";
import {
	Box,
	Button,
	ContextMenu,
	Dialog,
	Flex,
	Heading,
	IconButton,
	RadioGroup,
	ScrollArea,
	Text,
	TextField,
} from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { useLiveQuery } from "dexie-react-hooks";
import { motion, useMotionTemplate, useScroll } from "framer-motion";
import { useSetAtom } from "jotai";
import { type FC, useCallback, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { ViewportList } from "react-viewport-list";
import { PageContainer } from "../../components/PageContainer/index.tsx";
import { PlaylistCover } from "../../components/PlaylistCover/index.tsx";
import { PlaylistSongCard } from "../../components/PlaylistSongCard/index.tsx";
import { db } from "../../dexie.ts";
import {
	currentPlaylistAtom,
	currentPlaylistMusicIndexAtom,
} from "../../states/appAtoms.ts";
import {
	importAudioFilesToPlaylist,
	scanFolderAndImportToPlaylist,
} from "../../utils/importMusic.ts";
import { emitAudioThread, pickDirectoryTreeUri } from "../../utils/player.ts";
import styles from "./index.module.css";

export type Loadable<Value> =
	| {
			state: "loading";
	  }
	| {
			state: "hasError";
			error: unknown;
	  }
	| {
			state: "hasData";
			data: Awaited<Value>;
	  };

const EditablePlaylistName: FC<{
	playlistName: string;
	onPlaylistNameChange: (newName: string) => void;
}> = ({ playlistName, onPlaylistNameChange }) => {
	const [editing, setEditing] = useState(false);
	const [newName, setNewName] = useState(playlistName);

	return (
		<Heading className={styles.title}>
			{!editing && playlistName}
			{!editing && (
				<IconButton
					ml="2"
					style={{
						verticalAlign: "middle",
					}}
					size="1"
					variant="ghost"
					onClick={() => {
						setNewName(playlistName);
						setEditing(true);
					}}
				>
					<Pencil1Icon />
				</IconButton>
			)}
			{editing && (
				<TextField.Root
					value={newName}
					autoFocus
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							if (newName !== playlistName) onPlaylistNameChange(newName);
							setEditing(false);
						}
					}}
					onBlur={() => {
						if (newName !== playlistName) onPlaylistNameChange(newName);
						setEditing(false);
					}}
				/>
			)}
		</Heading>
	);
};

export const Component: FC = () => {
	const param = useParams();
	const playlist = useLiveQuery(() => db.playlists.get(Number(param.id)));
	const { t } = useTranslation();
	const playlistViewRef = useRef<HTMLDivElement>(null);
	const playlistViewScroll = useScroll({
		container: playlistViewRef,
	});
	const playlistCoverSize = useMotionTemplate`clamp(6em,calc(12em - ${playlistViewScroll.scrollY}px),12em)`;
	const playlistInfoGapSize = useMotionTemplate`clamp(var(--space-1), calc(var(--space-4) - ${playlistViewScroll.scrollY}px / 5), var(--space-4))`;
	const [failedImports, setFailedImports] = useState<
		{ path: string; error: string }[]
	>([]);
	const [refreshingFolder, setRefreshingFolder] = useState(false);
	/** 弹窗问扫描深度：resolve(true|false|null)。 */
	const [scanDepthAsk, setScanDepthAsk] = useState<{
		defaultRecursive: boolean;
		resolve: (recursive: boolean | null) => void;
	} | null>(null);
	const [scanDepthDraft, setScanDepthDraft] = useState(true);

	const setPlaylist = useSetAtom(currentPlaylistAtom);
	const setPlayIndex = useSetAtom(currentPlaylistMusicIndexAtom);
	const setPosition = useSetAtom(musicPlayingPositionAtom);

	const askScanDepth = useCallback(
		(defaultRecursive: boolean) =>
			new Promise<boolean | null>((resolve) => {
				setScanDepthDraft(defaultRecursive);
				setScanDepthAsk({ defaultRecursive, resolve });
			}),
		[],
	);

	const closeScanDepthAsk = useCallback(
		(value: boolean | null) => {
			scanDepthAsk?.resolve(value);
			setScanDepthAsk(null);
		},
		[scanDepthAsk],
	);

	const importMusicPaths = useCallback(
		async (results: string[]) => {
			const { failedList } = await importAudioFilesToPlaylist({
				playlistId: Number(param.id),
				results,
				t,
			});
			if (failedList.length > 0) {
				setFailedImports(failedList);
			}
		},
		[param.id, t],
	);

	const onAddLocalMusics = useCallback(async () => {
		let filters = [
			{
				name: t("page.playlist.addLocalMusic.filterName", "音频文件"),
				extensions: ["mp3", "flac", "wav", "m4a", "aac", "ogg"],
			},
			{
				name: t("page.playlist.addLocalMusic.allFiles", "所有文件"),
				extensions: ["*"],
			},
		];
		if (platform() === "android") {
			filters = [
				{
					name: t("page.playlist.addLocalMusic.filterName", "音频文件"),
					extensions: ["audio/*"],
				},
				{
					name: t("page.playlist.addLocalMusic.allFiles", "所有文件"),
					extensions: ["*/*"],
				},
			];
		}
		if (platform() === "ios") {
			filters.length = 0;
		}
		const results = await open({
			multiple: true,
			title: t("page.playlist.addLocalMusic.dialogTitle", "选择本地音乐"),
			filters,
		});
		if (!results) return;
		await importMusicPaths(results);
	}, [importMusicPaths, t]);

	const onAddLocalMusicFolder = useCallback(async () => {
		const treeUri = await pickDirectoryTreeUri();
		if (!treeUri) return;
		// 一次性导入：不改歌单偏好，默认沿用已存偏好。
		const recursive = await askScanDepth(playlist?.folderScanRecursive ?? true);
		if (recursive === null) return;
		const result = await scanFolderAndImportToPlaylist({
			playlistId: Number(param.id),
			treeUri,
			t,
			recursive,
		});
		if (result.failedList.length > 0) {
			setFailedImports(result.failedList);
		}
	}, [param.id, t, askScanDepth, playlist?.folderScanRecursive]);

	/**
	 * 文件夹扫描歌单的「刷新」入口：用建歌单时记下的 SAF tree URI 重新枚举
	 * 目录下的音频文件，把新增 / 改名 / 元数据有变动的歌曲增量同步进当前
	 * 歌单。当前实现只做「新增 + 元数据更新」，不会主动剔除被外部删掉的
	 * 歌曲条目（避免误删用户额外添加的曲目），用户如有需要可在歌单里手
	 * 动右键删除。
	 */
	const onRefreshFolderScan = useCallback(async () => {
		const treeUri = playlist?.folderScanTreeUri;
		if (!treeUri) return;
		setRefreshingFolder(true);
		try {
			// 刷新走静默路径，直接沿用建歌单时保存的递归偏好；老歌单没存
			// 这个字段时按 true 兜底，行为和升级前一致。
			const result = await scanFolderAndImportToPlaylist({
				playlistId: Number(param.id),
				treeUri,
				t,
				recursive: playlist?.folderScanRecursive ?? true,
			});
			if (result.failedList.length > 0) {
				setFailedImports(result.failedList);
			}
		} finally {
			setRefreshingFolder(false);
		}
	}, [playlist?.folderScanTreeUri, playlist?.folderScanRecursive, param.id, t]);

	/**
	 * 给一个老歌单（或想换目录的歌单）补上 / 替换 `folderScanTreeUri`，
	 * 并立刻执行一次刷新，把目录下的音频导入。导入失败不会回滚关联，
	 * 这样下次还能重试刷新。
	 */
	const onLinkFolderScan = useCallback(async () => {
		const treeUri = await pickDirectoryTreeUri();
		if (!treeUri) return;
		// 首次挂目录，写入偏好供后续刷新复用。
		const recursive = await askScanDepth(playlist?.folderScanRecursive ?? true);
		if (recursive === null) return;
		// 「换源」语义：清空原来源残留的歌曲，避免旧目录条目和新目录混在一起。
		await db.playlists.update(Number(param.id), (obj) => {
			obj.folderScanTreeUri = treeUri;
			obj.folderScanRecursive = recursive;
			obj.songIds = [];
		});
		toast.success(
			t(
				"page.playlist.folderScanRefresh.toast.linked",
				"已关联本地文件夹，开始扫描...",
			),
		);
		const result = await scanFolderAndImportToPlaylist({
			playlistId: Number(param.id),
			treeUri,
			t,
			recursive,
		});
		if (result.failedList.length > 0) {
			setFailedImports(result.failedList);
		}
	}, [param.id, t, askScanDepth, playlist?.folderScanRecursive]);

	const onUnlinkFolderScan = useCallback(async () => {
		await db.playlists.update(Number(param.id), (obj) => {
			obj.folderScanTreeUri = undefined;
			obj.folderScanRecursive = undefined;
		});
		toast.info(
			t(
				"page.playlist.folderScanRefresh.toast.unlinked",
				"已解除该歌单的文件夹关联",
			),
		);
	}, [param.id, t]);

	const onPlayList = useCallback(
		async (songIndex = 0, shuffle = false) => {
			if (playlist === undefined) return;
			const collected = await db.songs
				.toCollection()
				.filter((v) => playlist.songIds.includes(v.id))
				.toArray();
			if (shuffle) {
				for (let i = 0; i < collected.length; i++) {
					const j = Math.floor(Math.random() * (i + 1));
					[collected[i], collected[j]] = [collected[j], collected[i]];
				}
			} else {
				collected.sort((a, b) => {
					return (
						playlist.songIds.indexOf(a.id) - playlist.songIds.indexOf(b.id)
					);
				});
			}

			const newPlaylist = collected.map((v, i) => ({
				type: "local" as const,
				filePath: v.filePath,
				origOrder: i,
			}));

			setPlaylist(newPlaylist);
			setPlayIndex(songIndex);
			setPosition(0);

			await emitAudioThread("playAudio", {
				song: newPlaylist[songIndex],
			});
		},
		[playlist, setPlaylist, setPlayIndex, setPosition],
	);

	const onDeleteSong = useCallback(
		async (songId: string) => {
			if (playlist === undefined) return;
			await db.playlists.update(Number(param.id), (obj) => {
				obj.songIds = obj.songIds.filter((v) => v !== songId);
			});
		},
		[playlist, param.id],
	);

	const onPlaylistDefault = useCallback(onPlayList.bind(null, 0), [onPlayList]);
	const onPlaylistShuffle = useMemo(
		() => onPlayList.bind(null, 0, true),
		[onPlayList],
	);

	return (
		<PageContainer>
			<Flex direction="column" height="100%">
				<Flex gap="4" direction="column" flexGrow="0" pb="4" mt="5">
					<Flex align="end" pt="4">
						<Button variant="soft" onClick={() => history.back()}>
							<ArrowLeftIcon />
							<Trans i18nKey="common.page.back">返回</Trans>
						</Button>
					</Flex>
					<Flex align="end" gap="3">
						<motion.div
							style={{
								width: playlistCoverSize,
							}}
						>
							<ContextMenu.Root>
								<ContextMenu.Trigger>
									<PlaylistCover
										playlistId={Number(param.id)}
										style={{
											width: "100%",
										}}
									/>
								</ContextMenu.Trigger>
								<ContextMenu.Content>
									<ContextMenu.Item
										onClick={() => {
											db.playlists.update(Number(param.id), (obj) => {
												obj.playlistCover = undefined;
											});
										}}
									>
										<Trans i18nKey="page.playlist.cover.changeCoverToAuto">
											更换成自动封面
										</Trans>
									</ContextMenu.Item>
									<ContextMenu.Item
										onClick={() => {
											const inputEl = document.createElement("input");
											inputEl.type = "file";
											inputEl.accept = "image/*";
											inputEl.addEventListener(
												"change",
												() => {
													const file = inputEl.files?.[0];
													if (!file) return;
													db.playlists.update(Number(param.id), (obj) => {
														obj.playlistCover = file;
													});
												},
												{
													once: true,
												},
											);
											inputEl.click();
										}}
									>
										<Trans i18nKey="page.playlist.cover.uploadCoverImage">
											上传封面图片
										</Trans>
									</ContextMenu.Item>
									{platform() === "android" && (
										<>
											<ContextMenu.Separator />
											<ContextMenu.Item onClick={onLinkFolderScan}>
												{playlist?.folderScanTreeUri
													? t(
															"page.playlist.folderScanRefresh.relink",
															"重新关联本地文件夹",
														)
													: t(
															"page.playlist.folderScanRefresh.link",
															"关联到本地文件夹",
														)}
											</ContextMenu.Item>
											{playlist?.folderScanTreeUri && (
												<ContextMenu.Item
													color="red"
													onClick={onUnlinkFolderScan}
												>
													{t(
														"page.playlist.folderScanRefresh.unlink",
														"解除文件夹关联",
													)}
												</ContextMenu.Item>
											)}
										</>
									)}
								</ContextMenu.Content>
							</ContextMenu.Root>
						</motion.div>
						<Flex
							direction="column"
							display={{
								initial: "none",
								sm: "flex",
							}}
							gap={playlistInfoGapSize.get()}
							asChild
						>
							<motion.div
								style={{
									gap: playlistInfoGapSize,
								}}
							>
								<EditablePlaylistName
									playlistName={playlist?.name || ""}
									onPlaylistNameChange={(newName) =>
										db.playlists.update(Number(param.id), (obj) => {
											obj.name = newName;
										})
									}
								/>
								<Text>
									{t(
										"page.playlist.totalMusicLabel",
										"{count, plural, other {#}} 首歌曲",
										{
											count: playlist?.songIds?.length || 0,
										},
									)}
								</Text>
								<Flex gap="2">
									<Button onClick={() => onPlaylistDefault()}>
										<PlayIcon />
										<Trans i18nKey="page.playlist.playAll">播放全部</Trans>
									</Button>
									<Button variant="soft" onClick={onPlaylistShuffle}>
										<Trans i18nKey="page.playlist.shufflePlayAll">
											随机播放
										</Trans>
									</Button>
									{/*
									  歌单源是「文件夹扫描索引」时，单首散文件导入不适用——
									  它们下次刷新不会被剔除，混进来反而难管理。
									  「添加本地文件夹」保留：用户可能想把另一个目录的内容
									  并入当前索引歌单。
									*/}
									{!playlist?.folderScanTreeUri && (
										<Button variant="soft" onClick={onAddLocalMusics}>
											<PlusIcon />
											{t("page.playlist.addLocalMusic.label", "添加本地歌曲")}
										</Button>
									)}
									{platform() === "android" && (
										<Button variant="soft" onClick={onAddLocalMusicFolder}>
											<PlusIcon />
											{t(
												"page.playlist.addLocalMusicFolder.label",
												"添加本地文件夹",
											)}
										</Button>
									)}
									{playlist?.folderScanTreeUri && (
										<Button
											variant="soft"
											onClick={onRefreshFolderScan}
											loading={refreshingFolder}
											disabled={refreshingFolder}
										>
											<UpdateIcon />
											{t("page.playlist.folderScanRefresh.label", "刷新文件夹")}
										</Button>
									)}
								</Flex>
							</motion.div>
						</Flex>
						<Flex
							direction="column"
							display={{
								xs: "flex",
								sm: "none",
							}}
							asChild
						>
							<motion.div
								style={{
									gap: playlistInfoGapSize,
								}}
							>
								<EditablePlaylistName
									playlistName={playlist?.name || ""}
									onPlaylistNameChange={(newName) =>
										db.playlists.update(Number(param.id), (obj) => {
											obj.name = newName;
										})
									}
								/>
								<Text>
									{t(
										"page.playlist.totalMusicLabel",
										"{count, plural, other {#}} 首歌曲",
										{
											count: playlist?.songIds?.length || 0,
										},
									)}
								</Text>
								<Flex gap="2">
									<IconButton onClick={() => onPlaylistDefault()}>
										<PlayIcon />
									</IconButton>
									{!playlist?.folderScanTreeUri && (
										<IconButton
											variant="soft"
											onClick={onAddLocalMusics}
											title={t(
												"page.playlist.addLocalMusic.label",
												"添加本地歌曲",
											)}
										>
											<PlusIcon />
										</IconButton>
									)}
									{playlist?.folderScanTreeUri && (
										<IconButton
											variant="soft"
											onClick={onRefreshFolderScan}
											loading={refreshingFolder}
											disabled={refreshingFolder}
											title={t(
												"page.playlist.folderScanRefresh.label",
												"刷新文件夹",
											)}
										>
											<UpdateIcon />
										</IconButton>
									)}
								</Flex>
							</motion.div>
						</Flex>
					</Flex>
				</Flex>
				<Box
					flexGrow="1"
					overflowY="auto"
					minHeight="0"
					pb="4"
					ref={playlistViewRef}
				>
					{playlist?.songIds && (
						<ViewportList
							items={playlist.songIds}
							viewportRef={playlistViewRef}
						>
							{(songId, index) => (
								<PlaylistSongCard
									key={`playlist-song-card-${songId}`}
									songId={songId}
									songIndex={index}
									onPlayList={onPlayList}
									onDeleteSong={onDeleteSong}
								/>
							)}
						</ViewportList>
					)}
				</Box>
			</Flex>

			<Dialog.Root
				open={!!scanDepthAsk}
				onOpenChange={(open) => {
					if (!open) closeScanDepthAsk(null);
				}}
			>
				<Dialog.Content style={{ maxWidth: 420 }}>
					<Dialog.Title>
						{t(
							"page.playlist.folderScanRefresh.depthDialog.title",
							"选择扫描范围",
						)}
					</Dialog.Title>
					<Flex direction="column" gap="3" mt="4">
						<RadioGroup.Root
							value={scanDepthDraft ? "recursive" : "shallow"}
							onValueChange={(value) =>
								setScanDepthDraft(value === "recursive")
							}
						>
							<Flex gap="2" align="center">
								<RadioGroup.Item value="recursive" id="recursive" />
								<Text as="label" htmlFor="recursive">
									{t(
										"page.playlist.folderScanRefresh.depthDialog.recursive",
										"递归扫描子文件夹",
									)}
								</Text>
							</Flex>
							<Flex gap="2" align="center">
								<RadioGroup.Item value="shallow" id="shallow" />
								<Text as="label" htmlFor="shallow">
									{t(
										"page.playlist.folderScanRefresh.depthDialog.shallow",
										"仅扫描当前文件夹",
									)}
								</Text>
							</Flex>
						</RadioGroup.Root>
						<Flex gap="2" justify="end">
							<Button variant="soft" onClick={() => closeScanDepthAsk(null)}>
								{t("common.cancel", "取消")}
							</Button>
							<Button onClick={() => closeScanDepthAsk(scanDepthDraft)}>
								{t("common.confirm", "确认")}
							</Button>
						</Flex>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>

			<Dialog.Root
				open={failedImports.length > 0}
				onOpenChange={(open) => {
					if (!open) setFailedImports([]);
				}}
			>
				<Dialog.Content style={{ maxWidth: 600 }}>
					<Dialog.Title>
						{t(
							"page.playlist.addLocalMusic.dialog.failedTitle",
							"部分歌曲导入失败",
						)}
					</Dialog.Title>
					<Dialog.Description size="2" mb="4" color="gray">
						{t(
							"page.playlist.addLocalMusic.dialog.failedDescription",
							"以下 {count, plural, other {#}} 首歌曲添加失败：",
							{
								count: failedImports.length,
							},
						)}
					</Dialog.Description>

					<ScrollArea
						type="always"
						scrollbars="vertical"
						style={{ maxHeight: 300 }}
					>
						<Flex direction="column" gap="3" pr="3">
							{failedImports.map((item, index) => (
								<Box
									key={index}
									p="3"
									style={{
										backgroundColor: "var(--gray-a2)",
										borderRadius: "var(--radius-3)",
									}}
								>
									<Text
										as="div"
										size="2"
										weight="bold"
										style={{ wordBreak: "break-all" }}
									>
										{item.path}
									</Text>
									<Text
										as="div"
										size="1"
										color="red"
										mt="1"
										style={{ wordBreak: "break-all" }}
									>
										{item.error}
									</Text>
								</Box>
							))}
						</Flex>
					</ScrollArea>

					<Flex gap="3" mt="4" justify="end">
						<Dialog.Close>
							<Button variant="soft" color="gray">
								<Trans i18nKey="common.dialog.close">关闭</Trans>
							</Button>
						</Dialog.Close>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>
		</PageContainer>
	);
};

Component.displayName = "PlaylistPage";

export default Component;
