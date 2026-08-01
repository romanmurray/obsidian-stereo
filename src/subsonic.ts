import { createHash, randomBytes } from "crypto";
import type { StereoSettings } from "./settings";

/**
 * Error taxonomy (see docs/subsonic-api.md):
 * - config: settings incomplete; no request was made.
 * - auth: server rejected credentials (Subsonic codes 40/41/50).
 * - unreachable: network failure, non-2xx HTTP, or invalid JSON.
 * - server: any other Subsonic `status: failed` response.
 */
export type SubsonicErrorKind = "config" | "auth" | "unreachable" | "server";

export class SubsonicError extends Error {
	kind: SubsonicErrorKind;
	code: number | undefined;

	constructor(kind: SubsonicErrorKind, message: string, code?: number) {
		super(message);
		this.name = "SubsonicError";
		this.kind = kind;
		this.code = code;
	}
}

/** A track as returned by the Subsonic API (see docs/subsonic-api.md). */
export interface Song {
	id: string;
	title: string;
	album?: string;
	albumId?: string;
	artist?: string;
	artistId?: string;
	track?: number;
	year?: number;
	genre?: string;
	coverArt?: string;
	duration?: number;
	contentType?: string;
	starred?: string;
	/**
	 * Direct playback URL. Set only for internet radio entries; regular tracks
	 * stream via `streamUrl(id)`.
	 */
	streamUrl?: string;
}

export interface Artist {
	id: string;
	name: string;
	coverArt?: string;
	albumCount?: number;
	starred?: string;
}

/** One letter group from `getArtists` (maps onto the alphabet scrubber later). */
export interface ArtistIndex {
	name: string;
	artist: Artist[];
}

export interface Album {
	id: string;
	name: string;
	artist?: string;
	artistId?: string;
	coverArt?: string;
	songCount?: number;
	duration?: number;
	year?: number;
	genre?: string;
	starred?: string;
}

export type AlbumListType =
	| "alphabeticalByName"
	| "alphabeticalByArtist"
	| "newest"
	| "recent"
	| "frequent"
	| "random"
	| "starred";

export interface Playlist {
	id: string;
	name: string;
	songCount?: number;
	duration?: number;
	owner?: string;
	coverArt?: string;
}

export interface RadioStation {
	id: string;
	name: string;
	streamUrl: string;
	homePageUrl?: string;
}

/** One lyrics line; `start` is milliseconds into the track when time-synced. */
export interface SubsonicLyricsLine {
	start?: number;
	value: string;
}

/** One lyrics variant from `getLyricsBySongId` (OpenSubsonic `songLyrics`). */
export interface StructuredLyrics {
	lang?: string;
	synced?: boolean;
	offset?: number;
	line?: SubsonicLyricsLine[];
}

interface SubsonicEnvelope {
	"subsonic-response": {
		status: "ok" | "failed";
		version: string;
		error?: { code: number; message?: string };
	} & Record<string, unknown>;
}

type RequestParams = Record<string, string | number | Array<string | number>>;

/** Exactly one of these identifies what `star`/`unstar` applies to. */
export interface StarTarget {
	id?: string;
	albumId?: string;
	artistId?: string;
}

const PROTOCOL_VERSION = "1.16.1";
const CLIENT_NAME = "stereo";
const AUTH_ERROR_CODES = new Set([40, 41, 50]);

/** Normalize possibly-single-object payloads into arrays (legacy server quirk). */
export function toArray<T>(value: T | T[] | undefined | null): T[] {
	if (value == null) return [];
	return Array.isArray(value) ? value : [value];
}

function starParams(target: StarTarget): RequestParams {
	const params: RequestParams = {};
	if (target.id) params.id = target.id;
	if (target.albumId) params.albumId = target.albumId;
	if (target.artistId) params.artistId = target.artistId;
	return params;
}

export class SubsonicClient {
	private getSettings: () => StereoSettings;

	constructor(getSettings: () => StereoSettings) {
		this.getSettings = getSettings;
	}

	/**
	 * Build a full request URL with auth params. Used directly for binary
	 * endpoints (`stream`, `getCoverArt`) whose URLs are handed to the DOM.
	 * Throws a `config` error when settings are incomplete.
	 */
	buildUrl(endpoint: string, params: RequestParams = {}): string {
		const { serverUrl, username, password } = this.getSettings();
		if (!serverUrl || !username || !password) {
			throw new SubsonicError(
				"config",
				"Server URL, username, and password must all be set."
			);
		}

		const base = serverUrl.replace(/\/+$/, "");
		const salt = randomBytes(8).toString("hex");
		const token = createHash("md5").update(password + salt).digest("hex");

		const query = new URLSearchParams({
			u: username,
			t: token,
			s: salt,
			v: PROTOCOL_VERSION,
			c: CLIENT_NAME,
			f: "json",
		});
		for (const [key, value] of Object.entries(params)) {
			// Arrays become repeated params (e.g. one `songId` per track).
			for (const item of Array.isArray(value) ? value : [value]) {
				query.append(key, String(item));
			}
		}

		return `${base}/rest/${endpoint}.view?${query.toString()}`;
	}

	/** Perform a JSON request and unwrap the Subsonic envelope. */
	private async request(
		endpoint: string,
		params: RequestParams = {}
	): Promise<SubsonicEnvelope["subsonic-response"]> {
		const url = this.buildUrl(endpoint, params);

		let response: Response;
		try {
			response = await fetch(url);
		} catch {
			throw new SubsonicError("unreachable", "Could not reach the server.");
		}
		if (!response.ok) {
			throw new SubsonicError(
				"unreachable",
				`Server responded with HTTP ${response.status}.`,
				response.status
			);
		}

		let envelope: SubsonicEnvelope;
		try {
			envelope = (await response.json()) as SubsonicEnvelope;
		} catch {
			throw new SubsonicError(
				"unreachable",
				"Server response was not valid JSON. Is the URL a Subsonic server?"
			);
		}

		const body = envelope["subsonic-response"];
		if (!body) {
			throw new SubsonicError(
				"unreachable",
				"Unexpected response shape. Is the URL a Subsonic server?"
			);
		}

		if (body.status === "failed") {
			const code = body.error?.code ?? 0;
			const message = body.error?.message ?? "Unknown server error.";
			throw new SubsonicError(
				AUTH_ERROR_CODES.has(code) ? "auth" : "server",
				message,
				code
			);
		}

		return body;
	}

	/** Test connectivity and credentials. Resolves on success, throws SubsonicError otherwise. */
	/** Reachability check; reports what the server says about itself. */
	async ping(): Promise<{ type?: string; version?: string }> {
		const body = (await this.request("ping")) as {
			type?: string;
			serverVersion?: string;
		};
		return { type: body.type, version: body.serverVersion };
	}

	/** All artists, grouped by index letter. */
	async getArtists(): Promise<ArtistIndex[]> {
		const body = await this.request("getArtists");
		const payload = body.artists as
			| { index?: ArtistIndex | ArtistIndex[] }
			| undefined;
		return toArray(payload?.index).map((group) => ({
			name: group.name,
			artist: toArray(group.artist),
		}));
	}

	/** One artist with their albums. */
	async getArtist(id: string): Promise<{ artist: Artist; albums: Album[] }> {
		const body = await this.request("getArtist", { id });
		const payload = body.artist as (Artist & { album?: Album | Album[] }) | undefined;
		if (!payload) {
			throw new SubsonicError("server", "The server returned no artist.");
		}
		const { album, ...artist } = payload;
		return { artist, albums: toArray(album) };
	}

	/** One album with its tracks. */
	async getAlbum(id: string): Promise<{ album: Album; songs: Song[] }> {
		const body = await this.request("getAlbum", { id });
		const payload = body.album as (Album & { song?: Song | Song[] }) | undefined;
		if (!payload) {
			throw new SubsonicError("server", "The server returned no album.");
		}
		const { song, ...album } = payload;
		return { album, songs: toArray(song) };
	}

	/** A page of albums. `size` max 500. */
	async getAlbumList2(
		type: AlbumListType,
		size: number,
		offset = 0
	): Promise<Album[]> {
		const body = await this.request("getAlbumList2", { type, size, offset });
		const payload = body.albumList2 as { album?: Album | Album[] } | undefined;
		return toArray(payload?.album);
	}

	/** All playlists visible to the user. */
	async getPlaylists(): Promise<Playlist[]> {
		const body = await this.request("getPlaylists");
		const payload = body.playlists as
			| { playlist?: Playlist | Playlist[] }
			| undefined;
		return toArray(payload?.playlist);
	}

	/** One playlist with its tracks. */
	async getPlaylist(id: string): Promise<{ playlist: Playlist; songs: Song[] }> {
		const body = await this.request("getPlaylist", { id });
		const payload = body.playlist as
			| (Playlist & { entry?: Song | Song[] })
			| undefined;
		if (!payload) {
			throw new SubsonicError("server", "The server returned no playlist.");
		}
		const { entry, ...playlist } = payload;
		return { playlist, songs: toArray(entry) };
	}

	/** Everything marked as a favorite, in one call. */
	async getStarred2(): Promise<{
		artists: Artist[];
		albums: Album[];
		songs: Song[];
	}> {
		const body = await this.request("getStarred2");
		const payload = body.starred2 as
			| {
					artist?: Artist | Artist[];
					album?: Album | Album[];
					song?: Song | Song[];
			  }
			| undefined;
		return {
			artists: toArray(payload?.artist),
			albums: toArray(payload?.album),
			songs: toArray(payload?.song),
		};
	}

	/** Mark a song, album, or artist as a favorite. */
	async star(target: StarTarget): Promise<void> {
		await this.request("star", starParams(target));
	}

	/** Remove a song, album, or artist from favorites. */
	async unstar(target: StarTarget): Promise<void> {
		await this.request("unstar", starParams(target));
	}

	/** Create a playlist from an ordered list of song ids. */
	async createPlaylist(name: string, songIds: string[]): Promise<void> {
		await this.request("createPlaylist", { name, songId: songIds });
	}

	/** Rename a playlist, append songs, and/or remove songs by position. */
	async updatePlaylist(
		id: string,
		changes: { name?: string; addSongIds?: string[]; removeIndexes?: number[] }
	): Promise<void> {
		const params: RequestParams = { playlistId: id };
		if (changes.name) params.name = changes.name;
		if (changes.addSongIds?.length) params.songIdToAdd = changes.addSongIds;
		if (changes.removeIndexes?.length) {
			params.songIndexToRemove = changes.removeIndexes;
		}
		await this.request("updatePlaylist", params);
	}

	async deletePlaylist(id: string): Promise<void> {
		await this.request("deletePlaylist", { id });
	}

	/** Configured internet radio stations. */
	async getInternetRadioStations(): Promise<RadioStation[]> {
		const body = await this.request("getInternetRadioStations");
		const payload = body.internetRadioStations as
			| { internetRadioStation?: RadioStation | RadioStation[] }
			| undefined;
		return toArray(payload?.internetRadioStation);
	}

	/**
	 * Lyrics stored on the server for a song (OpenSubsonic `songLyrics`
	 * extension). Empty when the file has no embedded/LRC lyrics.
	 */
	async getLyricsBySongId(id: string): Promise<StructuredLyrics[]> {
		const body = await this.request("getLyricsBySongId", { id });
		const payload = body.lyricsList as
			| { structuredLyrics?: StructuredLyrics | StructuredLyrics[] }
			| undefined;
		return toArray(payload?.structuredLyrics);
	}

	/** Add a radio station on the server. Requires an admin account (error 50). */
	async createInternetRadioStation(
		name: string,
		streamUrl: string,
		homepageUrl?: string
	): Promise<void> {
		const params: RequestParams = { name, streamUrl };
		if (homepageUrl) params.homepageUrl = homepageUrl;
		await this.request("createInternetRadioStation", params);
	}

	/** Update a radio station on the server. Requires an admin account. */
	async updateInternetRadioStation(
		id: string,
		name: string,
		streamUrl: string,
		homepageUrl?: string
	): Promise<void> {
		const params: RequestParams = { id, name, streamUrl };
		if (homepageUrl) params.homepageUrl = homepageUrl;
		await this.request("updateInternetRadioStation", params);
	}

	/** Delete a radio station on the server. Requires an admin account. */
	async deleteInternetRadioStation(id: string): Promise<void> {
		await this.request("deleteInternetRadioStation", { id });
	}

	/**
	 * Server-side search across artists, albums, and songs. The server does
	 * substring matching; callers layer fuzzy ranking on top.
	 */
	async search3(
		query: string,
		counts: { artistCount: number; albumCount: number; songCount: number }
	): Promise<{ artists: Artist[]; albums: Album[]; songs: Song[] }> {
		const body = await this.request("search3", { query, ...counts });
		const payload = body.searchResult3 as
			| {
					artist?: Artist | Artist[];
					album?: Album | Album[];
					song?: Song | Song[];
			  }
			| undefined;
		return {
			artists: toArray(payload?.artist),
			albums: toArray(payload?.album),
			songs: toArray(payload?.song),
		};
	}

	/**
	 * Report a play to the server so play counts stay accurate.
	 * `submission=false` marks the track as "now playing"; `true` records the play.
	 */
	async scrobble(id: string, submission: boolean): Promise<void> {
		await this.request("scrobble", {
			id,
			submission: String(submission),
			time: Date.now(),
		});
	}

	/**
	 * Tracks similar to a song, album, or artist. Backed by the server's
	 * last.fm integration — returns an empty list when that is not configured.
	 */
	async getSimilarSongs(id: string, count: number): Promise<Song[]> {
		const body = await this.request("getSimilarSongs", { id, count });
		const payload = body.similarSongs as { song?: Song | Song[] } | undefined;
		return toArray(payload?.song);
	}

	/** Random tracks from the server. `size` max 500. */
	async getRandomSongs(size: number, genre?: string): Promise<Song[]> {
		const params: Record<string, string | number> = { size };
		if (genre) params.genre = genre;
		const body = await this.request("getRandomSongs", params);
		const payload = body.randomSongs as { song?: Song | Song[] } | undefined;
		return toArray(payload?.song);
	}

	/** URL for the `<audio>` element. Binary endpoint — never fetch this. */
	streamUrl(songId: string): string {
		return this.buildUrl("stream", { id: songId });
	}

	/** URL for an `<img>` element. `coverArt` ids are opaque — pass them through. */
	coverArtUrl(coverArtId: string, size?: number): string {
		const params: Record<string, string | number> = { id: coverArtId };
		if (size) params.size = size;
		return this.buildUrl("getCoverArt", params);
	}
}
