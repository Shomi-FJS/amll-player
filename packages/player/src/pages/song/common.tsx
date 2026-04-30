import { Flex, Text } from "@radix-ui/themes";
import type { FC, PropsWithChildren } from "react";

export const Option: FC<
	PropsWithChildren<{
		label: string;
	}>
> = ({ label, children }) => (
	<Text as="label">
		<Flex gap="2" direction="column">
			{label}
			{children}
		</Flex>
	</Text>
);

export function getLyricFormatFromExtension(filename: string): string | null {
	const ext = filename.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "lrc":
			return "lrc";
		case "eslrc":
			return "eslrc";
		case "yrc":
			return "yrc";
		case "qrc":
			return "qrc";
		case "lys":
			return "lys";
		// LRC A2 也可能用 .lrc，无法仅靠扩展名区分；约定 .alrc 走 A2，普通 .lrc 走标准 LRC。
		case "alrc":
			return "lrcA2";
		case "lyl":
			return "lyl";
		case "ttml":
			return "ttml";
		default:
			return null;
	}
}
