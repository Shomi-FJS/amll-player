import type { TTMLLyric } from "@applemusic-like-lyrics/lyric";
import {
	Button,
	Callout,
	Card,
	Dialog,
	Flex,
	Spinner,
	Text,
	TextField,
} from "@radix-ui/themes";
import { open } from "@tauri-apps/plugin-shell";
import { useLiveQuery } from "dexie-react-hooks";
import { type FC, useLayoutEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { db, type TTMLDBLyricEntry } from "../../dexie.ts";
import styles from "./index.module.css";

function getMetadataValues(ttml: TTMLLyric, key: string) {
	const result: string[] = [];
	for (const [k, v] of ttml.metadata) {
		if (k === key) {
			result.push(...v);
		}
	}
	return result;
}

function normalizeSearchText(text: string) {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isSearchTextIncluded(text: string, query: string) {
	const normalizedText = normalizeSearchText(text);
	const normalizedQuery = normalizeSearchText(query);
	if (normalizedText.includes(normalizedQuery)) return true;

	return normalizedText
		.replace(/\s+/g, "")
		.includes(normalizedQuery.replace(/\s+/g, ""));
}

function isPatternMatch(text: string, pattern: string | RegExp) {
	if (pattern instanceof RegExp) {
		return pattern.test(text);
	}
	return isSearchTextIncluded(text, pattern);
}

function isArtistTitleSearchMatch(
	query: string,
	songNames: string[],
	songArtists: string[],
) {
	const parts = query
		.split(/\s+-\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length !== 2) return false;

	const [left, right] = parts;
	const nameMatches = (part: string) =>
		songNames.some((name) => isSearchTextIncluded(name, part));
	const artistMatches = (part: string) =>
		songArtists.some((artist) => isSearchTextIncluded(artist, part));

	return (
		(artistMatches(left) && nameMatches(right)) ||
		(nameMatches(left) && artistMatches(right))
	);
}

function isTTMLEntryMatch(
	entry: TTMLDBLyricEntry,
	patterns: (string | RegExp)[],
	query = "",
) {
	const songNames = getMetadataValues(entry.content, "musicName");
	const songArtists = getMetadataValues(entry.content, "artists");
	const result = {
		name: entry.name,
		raw: entry.raw,
		songName: songNames.join(", "),
		songArtists: songArtists.join(", "),
		matchedLinePreview: [] as string[],
	};

	if (query && isArtistTitleSearchMatch(query, songNames, songArtists)) {
		return result;
	}

	for (const pattern of patterns) {
		for (let i = 0; i < entry.content.lines.length; i++) {
			const text = entry.content.lines[i].words.map((w) => w.word).join("");
			const matched = isPatternMatch(text, pattern);
			if (matched) {
				result.matchedLinePreview = entry.content.lines
					.slice(i, i + 3)
					.map((l) => l.words.map((w) => w.word).join(""));
				break;
			}
		}
		if (result.matchedLinePreview.length > 0) {
			return result;
		}
		if (isPatternMatch(result.songName, pattern)) {
			return result;
		}
		if (isPatternMatch(`${result.songName} - ${result.songArtists}`, pattern)) {
			return result;
		}
		if (isPatternMatch(`${result.songArtists} - ${result.songName}`, pattern)) {
			return result;
		}
		if (isPatternMatch(result.songArtists, pattern)) {
			return result;
		}
	}
	return undefined;
}

export const TTMLImportDialog: FC<{
	defaultValue?: string;
	onSelectedLyric?: (ttmlContent: string) => void;
}> = ({ onSelectedLyric, defaultValue }) => {
	const { t } = useTranslation();

	const [searchWord, setSearchWord] = useState("");
	const [opened, setOpened] = useState(false);

	const result = useLiveQuery(() => {
		const words = searchWord.trim();
		if (words.length > 0) {
			let pattern: string | RegExp = words;
			try {
				pattern = new RegExp(words, "i");
			} catch {}
			return db.ttmlDB
				.toCollection()
				.reverse()
				.filter((x) => !!isTTMLEntryMatch(x, [pattern], words))
				.limit(10)
				.sortBy("name")
				.then((x) =>
					x
						.map((x) => isTTMLEntryMatch(x, [pattern], words))
						.filter((v) => !!v),
				);
		}
		return [];
	}, [searchWord]);

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
							<Card key={v.name} asChild>
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
