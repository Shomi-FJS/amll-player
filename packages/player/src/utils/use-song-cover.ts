import { useLayoutEffect, useState } from "react";
import { db, type Song } from "../dexie.ts";
import { getVideoThumbnail } from "./video-thumbnail.ts";

export const useSongCover = (song?: Song) => {
	const [songImgUrl, setSongImgUrl] = useState<string>("");

	useLayoutEffect(() => {
		let canceled = false;
		if (song?.cover) {
			if (song.cover.type.startsWith("image") && song.cover.size > 0) {
				const newUri = URL.createObjectURL(song.cachedThumbnail || song.cover);
				setSongImgUrl(newUri);
				return () => {
					canceled = true;
					URL.revokeObjectURL(newUri);
				};
			}
			if (song.cachedThumbnail) {
				const newUri = URL.createObjectURL(song.cachedThumbnail);
				setSongImgUrl(newUri);
				return () => {
					canceled = true;
					URL.revokeObjectURL(newUri);
				};
			}
			if (song.cover.type.startsWith("video")) {
				const promise = getVideoThumbnail(song.cover).then((blob) => {
					const newUri = URL.createObjectURL(blob);
					db.songs.update(song.id, (newSong) => {
						newSong.cachedThumbnail = blob;
					});
					if (!canceled) setSongImgUrl(newUri);
					return newUri;
				});
				return () => {
					canceled = true;
					promise.then((uri) => {
						URL.revokeObjectURL(uri);
					});
				};
			}
			setSongImgUrl("");
		}
		return () => {
			canceled = true;
		};
	}, [song]);

	return songImgUrl;
};
