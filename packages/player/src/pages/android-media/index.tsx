import { ArrowLeftIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import {
	Box,
	Button,
	Callout,
	Card,
	Container,
	Flex,
	Heading,
	Text,
} from "@radix-ui/themes";
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useCallback, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	androidMediaCapturePermissionAtom,
	androidMediaCaptureSelectedPackageAtom,
	androidMediaCaptureSessionsAtom,
	MusicContextMode,
	musicContextModeAtom,
} from "../../states/appAtoms.ts";

export const Component: FC = () => {
	const { t } = useTranslation();
	const setMusicContextMode = useSetAtom(musicContextModeAtom);
	const sessions = useAtomValue(androidMediaCaptureSessionsAtom);
	const selectedPackage = useAtomValue(androidMediaCaptureSelectedPackageAtom);
	const hasPermission = useAtomValue(androidMediaCapturePermissionAtom);

	useEffect(() => {
		setMusicContextMode(MusicContextMode.AndroidMediaCapture);
		return () => setMusicContextMode(MusicContextMode.Local);
	}, [setMusicContextMode]);

	const onOpenSettings = useCallback(() => {
		invoke("android_media_capture_open_settings").catch(() => {});
	}, []);

	const onSelect = useCallback((pkg: string) => {
		invoke("android_media_capture_select_session", { packageName: pkg }).catch(
			() => {},
		);
	}, []);

	const onRefresh = useCallback(async () => {
		// 重新触发权限检测 + 启动；前端切到此页面已经会跑一次，这里仅供用户在
		// 系统设置里授权完毕后回到本页一键刷新。
		try {
			const has = await invoke<boolean>("android_media_capture_has_permission");
			if (has) {
				await invoke("android_media_capture_start");
			}
		} catch (e) {
			console.warn(e);
		}
	}, []);

	return (
		<Container
			mx={{
				initial: "4",
				sm: "9",
			}}
			pt="env(safe-area-inset-top)"
			mb="150px"
		>
			<Flex align="center" mt="7" gap="4">
				<Button variant="soft" onClick={() => history.back()}>
					<ArrowLeftIcon />
					<Trans i18nKey="common.page.back">返回</Trans>
				</Button>
				<Heading size="5">
					<Trans i18nKey="page.androidMediaCapture.title">
						捕捉系统媒体会话
					</Trans>
				</Heading>
			</Flex>

			<Callout.Root mt="4">
				<Callout.Icon>
					<InfoCircledIcon />
				</Callout.Icon>
				<Callout.Text>
					<Trans i18nKey="page.androidMediaCapture.tip">
						本功能会读取其它应用通过系统媒体会话（MediaSession）暴露的当前播放信息（标题、艺术家、封面、进度），并允许你播放/暂停/切歌/拖动进度。需要授予「通知使用权」才能工作。
					</Trans>
				</Callout.Text>
			</Callout.Root>

			{!hasPermission && (
				<Card mt="3">
					<Flex direction="column" gap="2">
						<Text weight="bold">
							<Trans i18nKey="page.androidMediaCapture.permissionRequired">
								需要授予通知使用权
							</Trans>
						</Text>
						<Text color="gray" size="2">
							<Trans i18nKey="page.androidMediaCapture.permissionHint">
								点击下方按钮跳转到系统设置，找到 AMLL Player 并打开开关。
							</Trans>
						</Text>
						<Flex gap="2">
							<Button onClick={onOpenSettings}>
								<Trans i18nKey="page.androidMediaCapture.openSettings">
									打开通知使用权设置
								</Trans>
							</Button>
							<Button variant="soft" onClick={onRefresh}>
								<Trans i18nKey="page.androidMediaCapture.refresh">
									已授权，刷新
								</Trans>
							</Button>
						</Flex>
					</Flex>
				</Card>
			)}

			<Card mt="3">
				<Flex direction="column" gap="2">
					<Flex align="center">
						<Box flexGrow="1">
							<Text weight="bold">
								<Trans i18nKey="page.androidMediaCapture.sessionList">
									活跃媒体会话
								</Trans>
							</Text>
						</Box>
						<Button size="1" variant="soft" onClick={onRefresh}>
							<Trans i18nKey="page.androidMediaCapture.refreshList">刷新</Trans>
						</Button>
					</Flex>
					{sessions.length === 0 && (
						<Text color="gray" size="2">
							<Trans i18nKey="page.androidMediaCapture.noSessions">
								当前没有可捕捉的媒体会话。先在其它应用里开始播放音乐，再回来。
							</Trans>
						</Text>
					)}
					{sessions.map((s) => {
						const isSelected = s.packageName === selectedPackage || s.isCurrent;
						return (
							<Flex
								key={`${s.packageName}-${s.sessionId}`}
								align="center"
								gap="2"
							>
								<Box flexGrow="1">
									<Text>{s.packageName}</Text>
								</Box>
								<Button
									size="1"
									variant={isSelected ? "solid" : "soft"}
									onClick={() => onSelect(s.packageName)}
								>
									{isSelected
										? t("page.androidMediaCapture.captured", "正在捕捉")
										: t("page.androidMediaCapture.capture", "捕捉此会话")}
								</Button>
							</Flex>
						);
					})}
					{selectedPackage && (
						<Flex justify="end">
							<Button
								size="1"
								color="gray"
								variant="soft"
								onClick={() => onSelect("")}
							>
								<Trans i18nKey="page.androidMediaCapture.disconnect">
									断开当前会话
								</Trans>
							</Button>
						</Flex>
					)}
				</Flex>
			</Card>
		</Container>
	);
};

Component.displayName = "AndroidMediaCapturePage";

export default Component;
