import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import {
	Button,
	Callout,
	Card,
	Dialog,
	Flex,
	IconButton,
	Spinner,
	Text,
	TextField,
} from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-shell";
import { useLiveQuery } from "dexie-react-hooks";
import {
	type FC,
	Fragment,
	useDeferredValue,
	useLayoutEffect,
	useState,
} from "react";
import { Trans, useTranslation } from "react-i18next";
import { db, type TTMLDBLyricEntry } from "../../dexie.ts";
import styles from "./index.module.css";

/** 圆圈 + 感叹号的 info 图标。用 inline SVG 避免引入新的 icon 包。 */
const ExclamationCircleIcon: FC = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		<title>metadata</title>
		<circle cx="12" cy="12" r="10" />
		<line x1="12" y1="8" x2="12" y2="13" />
		<circle cx="12" cy="16.5" r="0.75" fill="currentColor" stroke="none" />
	</svg>
);

const MAX_RESULTS = 10;

function getMetadataValue(ttml: TTMLLyric, key: string) {
	let result = "";
	for (const [k, v] of ttml.metadata) {
		if (k === key) {
			result += v.join(", ");
		}
	}
	return result;
}

/**
 * 把用户输入切成小写 token：按空白和常见分隔符拆分，去掉括号注解、过滤 <2 字符的噪声。
 * 保留 token 内的 "." 以兼容 "X.Y.Z" 这类缩写。
 */
function tokenizeQuery(raw: string): string[] {
	return raw
		.toLowerCase()
		.replace(/[(（[【].*?[)）\]】]/g, " ")
		.split(/[\s\-–—/\\,，;；、&|]+/)
		.filter((t) => t.length >= 2);
}

interface SearchMatch {
	name: string;
	raw: string;
	songName: string;
	songArtists: string;
	matchedLinePreview: string[];
	score: number;
	metadata: TTMLLyric["metadata"];
}

interface EntryHaystack {
	metaText: string;
	songName: string;
	songArtists: string;
	getLines: () => string[];
}

function buildHaystack(entry: TTMLDBLyricEntry): EntryHaystack {
	const songName = getMetadataValue(entry.content, "musicName");
	const songArtists = getMetadataValue(entry.content, "artists");
	const metaText = `${entry.name} ${songName} ${songArtists}`.toLowerCase();
	let cached: string[] | null = null;
	return {
		metaText,
		songName,
		songArtists,
		getLines: () => {
			if (!cached) {
				cached = entry.content.lines.map((l) =>
					l.words
						.map((w) => w.word)
						.join("")
						.toLowerCase(),
				);
			}
			return cached;
		},
	};
}

/**
 * 打分规则：每个 token 必须在元数据或歌词行中命中（否则整条丢弃）；
 * 元数据命中权重高于歌词行命中，token 越长加分越多。
 */
function matchTTMLEntry(
	entry: TTMLDBLyricEntry,
	tokens: string[],
): SearchMatch | null {
	if (tokens.length === 0) return null;
	const h = buildHaystack(entry);
	let score = 0;
	let firstMatchedLine = -1;
	for (const token of tokens) {
		if (h.metaText.includes(token)) {
			score += 10 + Math.min(token.length, 10);
			continue;
		}
		const lines = h.getLines();
		let found = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes(token)) {
				found = i;
				break;
			}
		}
		if (found < 0) return null;
		score += 3 + Math.min(token.length, 6);
		if (firstMatchedLine < 0) firstMatchedLine = found;
	}
	const matchedLinePreview: string[] = [];
	if (firstMatchedLine >= 0) {
		const end = Math.min(entry.content.lines.length, firstMatchedLine + 3);
		for (let j = firstMatchedLine; j < end; j++) {
			matchedLinePreview.push(
				entry.content.lines[j].words.map((w) => w.word).join(""),
			);
		}
	}
	return {
		name: entry.name,
		raw: entry.raw,
		songName: h.songName,
		songArtists: h.songArtists,
		matchedLinePreview,
		score,
		metadata: entry.content.metadata,
	};
}

/**
 * 从 amll-ttml-db 的文件名解析提交时间。
 *
 * 文件名格式：`<unixMs>-<githubUserId>-<hash>.ttml`，按 `-` 拆分后第一段即
 * 毫秒时间戳。用合理区间校验数值，避开「本地用户自己挂的同名文件」等噪声。
 */
function extractSubmitTimeMs(entryName: string): number | null {
	const first = entryName.split("-")[0];
	if (!first) return null;
	const n = Number(first);
	// 合理区间：2001-09 ~ 2603-xx，基本涵盖 ttml-db 出现后的所有提交。
	if (!Number.isFinite(n) || n < 1e12 || n > 2e13) return null;
	return n;
}

/** 本地时区下把毫秒时间戳格式化为 `yyyy-mm-dd hh:mm:ss`。 */
function formatSubmitTime(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return String(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
		`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
	);
}

/**
 * 试图给常见 metadata key 一个易读中文 label，没命中则原样返回。
 */
function metadataKeyLabel(key: string): string {
	switch (key) {
		case "musicName":
			return "歌曲名";
		case "artists":
			return "艺术家";
		case "album":
			return "专辑";
		case "isrc":
			return "ISRC";
		case "ncmMusicId":
			return "网易云 ID";
		case "qqMusicId":
			return "QQ 音乐 ID";
		case "spotifyId":
			return "Spotify ID";
		case "appleMusicId":
			return "Apple Music ID";
		case "ttmlAuthorGithub":
		case "ttmlAuthorGithubLogin":
			return "投稿者";
		case "songwriters":
			return "词曲作者";
		case "duration":
			return "时长";
		case "recordedAt":
			return "发行日期";
		default:
			return key;
	}
}

const MetadataDialog: FC<{
	entryName: string;
	metadata: TTMLLyric["metadata"];
}> = ({ entryName, metadata }) => {
	const submitTimeMs = extractSubmitTimeMs(entryName);
	const hasContent = submitTimeMs !== null || metadata.length > 0;
	return (
		<Dialog.Root>
			<Dialog.Trigger>
				<IconButton
					className={styles.metaButton}
					variant="ghost"
					color="gray"
					size="2"
					aria-label="查看元数据"
					onClick={(e) => e.stopPropagation()}
				>
					<ExclamationCircleIcon />
				</IconButton>
			</Dialog.Trigger>
			{/* maxWidth 比搜索弹窗略窄，避免父弹窗被遮太多。 */}
			<Dialog.Content maxWidth="480px" onClick={(e) => e.stopPropagation()}>
				<Dialog.Title size="3">歌词元数据</Dialog.Title>
				<Dialog.Description size="1" color="gray" mb="3">
					{entryName}
				</Dialog.Description>
				{!hasContent ? (
					<Text size="2" color="gray">
						该歌词文件未携带元数据
					</Text>
				) : (
					<dl className={styles.metaList}>
						{submitTimeMs !== null && (
							<>
								<dt className={styles.metaKey}>提交时间</dt>
								<dd className={styles.metaValue}>
									{formatSubmitTime(submitTimeMs)}
								</dd>
							</>
						)}
						{metadata.map(([key, values], i) => (
							<Fragment key={`${key}-${i}`}>
								<dt className={styles.metaKey}>{metadataKeyLabel(key)}</dt>
								<dd className={styles.metaValue}>
									{values.map((v, j) => (
										<div key={`${j}-${v}`}>{v}</div>
									))}
								</dd>
							</Fragment>
						))}
					</dl>
				)}
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button variant="soft">
							<Trans i18nKey="common.dialog.close">关闭</Trans>
						</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};

export const TTMLImportDialog: FC<{
	defaultValue?: string;
	onSelectedLyric?: (ttmlContent: string) => void;
}> = ({ onSelectedLyric, defaultValue }) => {
	const { t } = useTranslation();

	const [searchWord, setSearchWord] = useState("");
	const [opened, setOpened] = useState(false);
	// 用 useDeferredValue 避免输入过程中每一帧都重新扫 DB，React 会把它降为全局低优先级。
	const deferredSearchWord = useDeferredValue(searchWord);

	const result = useLiveQuery(async () => {
		const tokens = tokenizeQuery(deferredSearchWord);
		if (tokens.length === 0) return [];
		const entries = await db.ttmlDB.toArray();
		const matches: SearchMatch[] = [];
		for (const entry of entries) {
			const m = matchTTMLEntry(entry, tokens);
			if (m) matches.push(m);
		}
		matches.sort((a, b) => b.score - a.score);
		return matches.slice(0, MAX_RESULTS);
	}, [deferredSearchWord]);

	useLayoutEffect(() => {
		setSearchWord(defaultValue ?? "");
	}, [defaultValue]);

	return (
		<Dialog.Root open={opened} onOpenChange={setOpened}>
			<Dialog.Trigger>
				<Button>
					<Trans i18nKey="amll.ttmlImportDialog.openButtonLabel">
						从 AMLL TTML DB 搜索 / 导入歌词
					</Trans>
				</Button>
			</Dialog.Trigger>
			<Dialog.Content>
				<Dialog.Title>
					<Trans i18nKey="amll.ttmlImportDialog.title">
						从 AMLL TTML DB 搜索 / 导入歌词
					</Trans>
				</Dialog.Title>
				<TextField.Root
					placeholder={t(
						"amll.ttmlImportDialog.searchInput.placeholder",
						"搜索歌曲、歌词内容、歌手等……",
					)}
					type="text"
					onChange={(v) => setSearchWord(v.target.value)}
					value={searchWord}
				/>
				<Callout.Root mt="4">
					<Trans i18nKey="amll.ttmlImportDialog.tip">
						在上方输入搜索关键词，点击候选项即可将歌词内容直接导入到歌词数据中。
					</Trans>
				</Callout.Root>
				<Callout.Root mt="4" color="grass">
					<Text>
						<Trans i18nKey="amll.ttmlImportDialog.supportText">
							AMLL TTML DB 是由 AMLL
							社区爱好者们一同建设的开源无版权歌词数据库，想为 AMLL TTML DB
							贡献歌词吗？前往
							<Button
								variant="outline"
								onClick={() => open("https://github.com/amll-dev/amll-ttml-db")}
								style={{
									verticalAlign: "baseline",
									margin: "0 0.5em",
									fontWeight: "bold",
								}}
							>
								GitHub 仓库
							</Button>
							即可知晓提交歌词流程！
						</Trans>
					</Text>
				</Callout.Root>
				{result ? (
					result.length === 0 ? (
						<div style={{ margin: "1em", textAlign: "center", opacity: "0.5" }}>
							<Trans i18nKey="amll.ttmlImportDialog.noResults">无结果</Trans>
						</div>
					) : (
						result.map((v) => (
							<div key={v.name} className={styles.resultRow}>
								<Card asChild>
									<button
										className={styles.resultCard}
										type="button"
										onClick={() => {
											onSelectedLyric?.(v.raw);
											setOpened(false);
										}}
									>
										<div className={styles.name}>{v.name}</div>
										<div>
											{v.songArtists} - {v.songName}
										</div>
										{v.matchedLinePreview.length > 0 && (
											<ul>
												{v.matchedLinePreview.map((l, i) => (
													<li key={`${l}-${i}`}>{l}</li>
												))}
											</ul>
										)}
									</button>
								</Card>
								<MetadataDialog entryName={v.name} metadata={v.metadata} />
							</div>
						))
					)
				) : (
					<Spinner />
				)}
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button variant="soft">
							<Trans i18nKey="common.dialog.close">关闭</Trans>
						</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
