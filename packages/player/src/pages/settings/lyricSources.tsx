import {
	ChevronDownIcon,
	ChevronUpIcon,
	PlusIcon,
	TrashIcon,
} from "@radix-ui/react-icons";
import {
	Box,
	Button,
	Card,
	Flex,
	IconButton,
	Select,
	Switch,
	Text,
	TextField,
} from "@radix-ui/themes";
import { type FC, useCallback } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
	type CustomLyricResponseFormat,
	DEFAULT_LYRIC_SOURCES,
	type LyricSourceConfig,
	type LyricSourceType,
	normalizeLyricSources,
} from "../../utils/lyricSources.ts";

const FORMAT_OPTIONS: CustomLyricResponseFormat[] = [
	"auto",
	"lrc",
	"eslrc",
	"lrcA2",
	"yrc",
	"qrc",
	"lys",
	"lyl",
	"ttml",
];

/** 内置源不允许删除/编辑名字，仅允许排序与启用切换。 */
function isBuiltinSource(type: LyricSourceType): boolean {
	return type === "amlldb" || type === "local";
}

function generateCustomId(): string {
	if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
		return `custom-${crypto.randomUUID()}`;
	}
	return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const LyricSourceRow: FC<{
	source: LyricSourceConfig;
	index: number;
	total: number;
	onUpdate: (patch: Partial<LyricSourceConfig>) => void;
	onMove: (delta: -1 | 1) => void;
	onDelete: () => void;
}> = ({ source, index, total, onUpdate, onMove, onDelete }) => {
	const { t } = useTranslation();
	const builtin = isBuiltinSource(source.type);
	const typeLabel = t(`page.settings.lyricSources.type.${source.type}`);

	return (
		<Card mt="2">
			<Flex direction="column" gap="3">
				<Flex direction="row" align="center" gap="3" wrap="wrap">
					<Flex direction="column" gap="1" flexGrow="1" minWidth="0">
						<Flex align="center" gap="2" wrap="wrap">
							<Text weight="medium">
								{builtin
									? t(`page.settings.lyricSources.type.${source.type}` as const)
									: source.name ||
										t("page.settings.lyricSources.emptyName", "（未命名来源）")}
							</Text>
							<Text size="1" color="gray">
								{typeLabel}
							</Text>
						</Flex>
						{builtin && (
							<Text size="1" color="gray">
								{source.type === "amlldb" ? (
									<Trans i18nKey="page.settings.lyricSources.tip">
										内置「AMLL TTML
										DB」「歌曲目录歌词」无法删除，但可以排序与启用/禁用。
									</Trans>
								) : null}
							</Text>
						)}
					</Flex>

					<Flex align="center" gap="1">
						<IconButton
							variant="ghost"
							color="gray"
							size="2"
							aria-label={t("page.settings.lyricSources.row.moveUp", "上移")}
							disabled={index === 0}
							onClick={() => onMove(-1)}
						>
							<ChevronUpIcon />
						</IconButton>
						<IconButton
							variant="ghost"
							color="gray"
							size="2"
							aria-label={t("page.settings.lyricSources.row.moveDown", "下移")}
							disabled={index === total - 1}
							onClick={() => onMove(1)}
						>
							<ChevronDownIcon />
						</IconButton>
						<Switch
							checked={source.enabled}
							onCheckedChange={(v) => onUpdate({ enabled: v })}
						/>
						{!builtin && (
							<IconButton
								variant="ghost"
								color="red"
								size="2"
								aria-label={t("page.settings.lyricSources.row.delete", "删除")}
								onClick={onDelete}
							>
								<TrashIcon />
							</IconButton>
						)}
					</Flex>
				</Flex>

				{!builtin && (
					<Flex direction="column" gap="2">
						<Box>
							<Text as="label" size="1" color="gray">
								<Trans i18nKey="page.settings.lyricSources.form.name.label">
									名称
								</Trans>
							</Text>
							<TextField.Root
								mt="1"
								value={source.name}
								placeholder={t(
									"page.settings.lyricSources.form.name.placeholder",
									"例如 KuGou Mirror",
								)}
								onChange={(e) => onUpdate({ name: e.currentTarget.value })}
							/>
						</Box>

						<Box>
							<Text as="label" size="1" color="gray">
								<Trans i18nKey="page.settings.lyricSources.form.url.label">
									URL 模板
								</Trans>
							</Text>
							<TextField.Root
								mt="1"
								value={source.url ?? ""}
								placeholder={t(
									"page.settings.lyricSources.form.url.placeholder",
									"https://example.com/api?title={songName}&artist={songArtists}",
								)}
								onChange={(e) => onUpdate({ url: e.currentTarget.value })}
							/>
							<Text size="1" color="gray" mt="1" as="div">
								{t(
									"page.settings.lyricSources.form.url.description",
									"支持占位符 {placeholder} ，将自动进行 URL 编码",
									{
										placeholder: "{songName} {songArtists} {songAlbum}",
									},
								)}
							</Text>
						</Box>

						<Flex align="center" gap="3" wrap="wrap">
							<Text as="label" size="1" color="gray">
								<Trans i18nKey="page.settings.lyricSources.form.format.label">
									返回格式
								</Trans>
							</Text>
							<Select.Root
								value={source.format ?? "auto"}
								onValueChange={(v) =>
									onUpdate({ format: v as CustomLyricResponseFormat })
								}
							>
								<Select.Trigger />
								<Select.Content>
									{FORMAT_OPTIONS.map((fmt) => (
										<Select.Item key={fmt} value={fmt}>
											{fmt === "auto"
												? t(
														"page.settings.lyricSources.form.format.auto",
														"自动识别",
													)
												: fmt.toUpperCase()}
										</Select.Item>
									))}
								</Select.Content>
							</Select.Root>
						</Flex>
					</Flex>
				)}
			</Flex>
		</Card>
	);
};

export const LyricSourcesEditor: FC<{
	value?: LyricSourceConfig[];
	onChange: (sources: LyricSourceConfig[]) => void;
	showTitle?: boolean;
}> = ({ value, onChange, showTitle = true }) => {
	const sources = normalizeLyricSources(value ?? DEFAULT_LYRIC_SOURCES);

	const updateAt = useCallback(
		(index: number, patch: Partial<LyricSourceConfig>) => {
			const next = sources.slice();
			const target = next[index];
			if (!target) return;
			next[index] = { ...target, ...patch };
			onChange(next);
		},
		[onChange, sources],
	);

	const moveAt = useCallback(
		(index: number, delta: -1 | 1) => {
			const next = sources.slice();
			const target = index + delta;
			if (target < 0 || target >= next.length) return;
			const tmp = next[index];
			next[index] = next[target];
			next[target] = tmp;
			onChange(next);
		},
		[onChange, sources],
	);

	const deleteAt = useCallback(
		(index: number) => {
			const next = sources.slice();
			const target = next[index];
			// 内置源不允许删除，防御性兜底：UI 已经隐藏了删除按钮。
			if (!target || isBuiltinSource(target.type)) return;
			next.splice(index, 1);
			onChange(next);
		},
		[onChange, sources],
	);

	const addCustom = useCallback(() => {
		onChange([
			...sources,
			{
				id: generateCustomId(),
				type: "custom",
				name: "",
				enabled: true,
				url: "",
				format: "auto",
			},
		]);
	}, [onChange, sources]);

	return (
		<>
			{showTitle && (
				<>
					<Text weight="bold" size="7" my="4" as="div">
						<Trans i18nKey="page.settings.lyricSources.subtitle">
							歌词来源
						</Trans>
					</Text>
					<Text as="div" color="gray" size="2" mb="3">
						<Trans i18nKey="page.settings.lyricSources.description">
							控制导入歌曲时按何种顺序、从哪些来源获取歌词。列表越靠前优先级越高，第一个返回结果的来源获胜。
						</Trans>
					</Text>
				</>
			)}

			{sources.map((source, i) => (
				<LyricSourceRow
					key={source.id}
					source={source}
					index={i}
					total={sources.length}
					onUpdate={(patch) => updateAt(i, patch)}
					onMove={(delta) => moveAt(i, delta)}
					onDelete={() => deleteAt(i)}
				/>
			))}

			<Box mt="3">
				<Button onClick={addCustom} variant="soft">
					<PlusIcon />
					<Trans i18nKey="page.settings.lyricSources.addCustom">
						添加自定义歌词源
					</Trans>
				</Button>
			</Box>
		</>
	);
};
