import { isLyricPageOpenedAtom } from "@applemusic-like-lyrics/react-full";
import { ClockIcon } from "@radix-ui/react-icons";
import {
	Button,
	Flex,
	IconButton,
	Popover,
	Slider,
	Text,
	TextField,
} from "@radix-ui/themes";
import { useAtom, useAtomValue } from "jotai";
import { type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	androidMediaCaptureLyricOffsetKeyAtom,
	androidMediaCaptureLyricOffsetMsAtom,
	androidMediaCaptureLyricTailMsAtom,
} from "../../states/appAtoms.ts";
import {
	LYRIC_OFFSET_PRESETS,
	LYRIC_OFFSET_TAIL_HINT_MS,
	setLyricOffset,
} from "../../utils/lyricOffsets.ts";
import styles from "./index.module.css";

// 提示横幅自动消失时间：足够用户看到 + 反应，不至于一直挂着遮挡歌词。
const BANNER_AUTO_HIDE_MS = 12000;

// 滑块单位是毫秒：负值代表歌词整体提前；正值代表歌词整体后移。
// 杜比全景声前导静音典型 1000-1500ms，给到 +5000ms 上限留足余量；
// 同时支持 -2000ms 处理罕见的「歌词比音频晚」场景。
const MIN_MS = -2000;
const MAX_MS = 5000;
const STEP_MS = 50;
const FINE_STEP_MS = 50;

/**
 * Android 媒体捕捉模式下的歌词时间轴微调控件。
 *
 * 仅在歌词页打开 + 已成功匹配到歌词（offsetKey 非空）时显示。
 * 拖动滑块实时投影到 musicLyricLinesAtom（由 AndroidMediaCaptureContext 订阅
 * offset 原子实现），松手时把当前值持久化到 Dexie，下次同一首歌自动套用。
 */
export const LyricOffsetControl: FC = () => {
	const { t } = useTranslation();
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const offsetKey = useAtomValue(androidMediaCaptureLyricOffsetKeyAtom);
	const [offsetMs, setOffsetMs] = useAtom(androidMediaCaptureLyricOffsetMsAtom);
	const tailMs = useAtomValue(androidMediaCaptureLyricTailMsAtom);

	const [popoverOpen, setPopoverOpen] = useState(false);
	// 同一首歌内 banner 关闭后不再骚扰；切歌（offsetKey 变化）才重置。
	const [bannerDismissed, setBannerDismissed] = useState(false);

	// 切歌：重置 banner 状态
	useEffect(() => {
		setBannerDismissed(false);
	}, [offsetKey]);

	// 通过比对音频总长 vs TTML 末行 endTime 触发：tail 越大越可疑。
	// 普通歌曲 outro ≤ 5s；超过该阈值大概率是 Atmos 前导静音 / 长 outro。
	// 用户已手动调过（offsetMs ≠ 0）说明本人意识到，无需再提示。
	const showBanner =
		isLyricPageOpened &&
		!!offsetKey &&
		tailMs >= LYRIC_OFFSET_TAIL_HINT_MS &&
		offsetMs === 0 &&
		!bannerDismissed &&
		!popoverOpen;

	// 自动隐藏
	useEffect(() => {
		if (!showBanner) return;
		const h = window.setTimeout(
			() => setBannerDismissed(true),
			BANNER_AUTO_HIDE_MS,
		);
		return () => window.clearTimeout(h);
	}, [showBanner]);

	// 拖动期间：只更新原子（实时预览），不写盘
	const handleSliderChange = useCallback(
		(value: number[]) => {
			setOffsetMs(value[0] ?? 0);
		},
		[setOffsetMs],
	);

	// 松手 / 微调按钮 / 重置 / 预设：写盘
	const persist = useCallback(
		(value: number) => {
			setOffsetMs(value);
			if (offsetKey) setLyricOffset(offsetKey, value);
		},
		[offsetKey, setOffsetMs],
	);

	if (!isLyricPageOpened || !offsetKey) return null;

	return (
		<>
			{showBanner && (
				<button
					type="button"
					className={styles.banner}
					onClick={() => {
						setPopoverOpen(true);
						setBannerDismissed(true);
					}}
				>
					{t(
						"amll.androidMediaCapture.lyricOffset.banner",
						"出现歌词延迟？点我试试 \u2192",
					)}
				</button>
			)}
			<Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
				<Popover.Trigger>
					<IconButton
						className={styles.floatBtn}
						variant="soft"
						color="gray"
						radius="full"
						size="3"
						title={t("amll.androidMediaCapture.lyricOffset.adjust", "歌词微调")}
						aria-label={t(
							"amll.androidMediaCapture.lyricOffset.adjust",
							"歌词微调",
						)}
					>
						<ClockIcon />
					</IconButton>
				</Popover.Trigger>
				<Popover.Content
					side="bottom"
					align="end"
					className={styles.popoverContent}
				>
					<Flex className={styles.headerRow}>
						<Text size="2" weight="bold">
							{t(
								"amll.androidMediaCapture.lyricOffset.title",
								"歌词时间轴微调",
							)}
						</Text>
						{LYRIC_OFFSET_PRESETS.map((preset) => (
							<button
								key={preset.id}
								type="button"
								className={styles.presetLink}
								onClick={() => persist(preset.offsetMs)}
								data-active={offsetMs === preset.offsetMs || undefined}
							>
								{t(preset.i18nLabelKey, preset.fallbackLabel)}
							</button>
						))}
					</Flex>
					<Text className={styles.hint}>
						{t(
							"amll.androidMediaCapture.lyricOffset.hint",
							"+ 让歌词后移（音频比歌词慢，常见于杜比全景声前导静音）。设置会自动记忆。",
						)}
					</Text>

					<Flex className={styles.row}>
						<Text size="2">
							{t("amll.androidMediaCapture.lyricOffset.adjust", "歌词微调")}
						</Text>
						{/* 直接用受控的 number input 显示 + 编辑当前值；
					    比依赖 i18n 插值显示更直观，且天然支持手动键入。 */}
						<TextField.Root
							type="number"
							size="1"
							style={{ width: "7em" }}
							value={offsetMs}
							min={MIN_MS}
							max={MAX_MS}
							step={STEP_MS}
							onChange={(e) => {
								const v = Number(e.currentTarget.value);
								if (!Number.isFinite(v)) return;
								// 输入过程不写盘，避免每按一键都触发 IndexedDB 写入
								setOffsetMs(Math.min(MAX_MS, Math.max(MIN_MS, v)));
							}}
							onBlur={(e) => {
								const v = Number(e.currentTarget.value);
								if (!Number.isFinite(v)) {
									persist(0);
									return;
								}
								persist(Math.min(MAX_MS, Math.max(MIN_MS, Math.round(v))));
							}}
						>
							<TextField.Slot side="right">
								<Text size="1" color="gray">
									ms
								</Text>
							</TextField.Slot>
						</TextField.Root>
						<Button
							size="1"
							variant="soft"
							color="gray"
							onClick={() => persist(0)}
							disabled={offsetMs === 0}
						>
							{t("amll.androidMediaCapture.lyricOffset.reset", "归零")}
						</Button>
					</Flex>

					<Slider
						min={MIN_MS}
						max={MAX_MS}
						step={STEP_MS}
						value={[offsetMs]}
						onValueChange={handleSliderChange}
						onValueCommit={(v) => persist(v[0] ?? 0)}
					/>

					<Flex className={styles.row}>
						<Button
							size="1"
							variant="soft"
							color="gray"
							onClick={() => persist(Math.max(MIN_MS, offsetMs - FINE_STEP_MS))}
						>
							-{FINE_STEP_MS} ms
						</Button>
						<Button
							size="1"
							variant="soft"
							color="gray"
							onClick={() => persist(Math.min(MAX_MS, offsetMs + FINE_STEP_MS))}
						>
							+{FINE_STEP_MS} ms
						</Button>
					</Flex>
				</Popover.Content>
			</Popover.Root>
		</>
	);
};

export default LyricOffsetControl;
