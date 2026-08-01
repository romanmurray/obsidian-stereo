import { requestUrl } from "obsidian";
import type { Song, StructuredLyrics, SubsonicClient } from "./subsonic";

/** One display line; `time` is seconds into the track when synced. */
export interface LyricsLine {
	time?: number;
	text: string;
}

export interface Lyrics {
	/** True when every line carries a timestamp, so the view can follow along. */
	synced: boolean;
	lines: LyricsLine[];
}

/**
 * Per-session cache. Only definitive answers are stored — lyrics found, or
 * both sources confirming there are none — so a network hiccup retries on
 * the next look instead of caching a false "no lyrics".
 */
const cache = new Map<string, Lyrics | null>();

/**
 * Lyrics for a song: the server first (embedded/LRC files it already has),
 * then the LRCLIB public database as a fallback (free, keyless — most
 * libraries have no lyrics files, and the server never fetches any itself).
 * Never throws; resolves null when nothing is found. The online fallback can
 * be disabled in settings (`allowOnline`); answers are cached per mode so
 * flipping the setting takes effect without a restart.
 */
export async function getLyrics(
	client: SubsonicClient,
	song: Song,
	allowOnline = true
): Promise<Lyrics | null> {
	const cacheKey = `${song.id}:${allowOnline ? "online" : "server"}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return cached;

	let definitive = true;
	let result: Lyrics | null = null;

	try {
		result = fromStructured(await client.getLyricsBySongId(song.id));
	} catch {
		definitive = false;
	}

	if (!result && allowOnline) {
		try {
			result = await fromLrclib(song);
		} catch {
			definitive = false;
		}
	}

	if (result || definitive) cache.set(cacheKey, result);
	return result;
}

/** Pick the best server variant (synced wins) and normalize it. */
function fromStructured(variants: StructuredLyrics[]): Lyrics | null {
	const best = variants.find((v) => v.synced && v.line?.length) ??
		variants.find((v) => v.line?.length);
	if (!best?.line?.length) return null;

	const offset = (best.offset ?? 0) / 1000;
	const lines: LyricsLine[] = best.line.map((line) => ({
		time:
			line.start != null ? Math.max(0, line.start / 1000 + offset) : undefined,
		text: line.value ?? "",
	}));
	const synced = !!best.synced && lines.every((line) => line.time != null);
	return { synced, lines };
}

/** LRCLIB lookup by track metadata. A 404 is a definitive "no lyrics". */
async function fromLrclib(song: Song): Promise<Lyrics | null> {
	// The endpoint matches on artist + title; without an artist it's guesswork.
	if (!song.artist || !song.title) return null;

	const params = new URLSearchParams({
		artist_name: song.artist,
		track_name: song.title,
	});
	if (song.album) params.set("album_name", song.album);
	if (song.duration) params.set("duration", String(song.duration));

	const response = await requestUrl({
		url: `https://lrclib.net/api/get?${params.toString()}`,
		throw: false,
	});
	if (response.status === 404) return null;
	if (response.status !== 200) {
		throw new Error(`LRCLIB responded with HTTP ${response.status}.`);
	}

	const data = response.json as {
		syncedLyrics?: string | null;
		plainLyrics?: string | null;
	};
	if (data.syncedLyrics) {
		const lines = parseLrc(data.syncedLyrics);
		if (lines.length > 0) return { synced: true, lines };
	}
	if (data.plainLyrics) {
		return {
			synced: false,
			lines: data.plainLyrics.split(/\r?\n/).map((text) => ({ text })),
		};
	}
	return null;
}

/**
 * Parse LRC text into timed lines. Handles multiple timestamps per line
 * (`[00:12.00][00:50.00]chorus`) and ignores metadata tags like `[ar:…]`.
 */
function parseLrc(lrc: string): LyricsLine[] {
	const TIME_TAG = /\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g;
	const lines: LyricsLine[] = [];

	for (const raw of lrc.split(/\r?\n/)) {
		const times: number[] = [];
		let match: RegExpExecArray | null;
		let textStart = 0;
		TIME_TAG.lastIndex = 0;
		while ((match = TIME_TAG.exec(raw)) !== null) {
			if (match.index !== textStart) break; // tags only lead a line
			times.push(Number(match[1]) * 60 + Number(match[2]));
			textStart = TIME_TAG.lastIndex;
		}
		if (times.length === 0) continue;
		const text = raw.slice(textStart).trim();
		for (const time of times) lines.push({ time, text });
	}

	lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
	return lines;
}
