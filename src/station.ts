import type { Song, SubsonicClient } from "./subsonic";

/**
 * A station is a batch of tracks built around a seed (a song, album, or
 * artist). Batches are finite on purpose: the queue stays inspectable and
 * saveable as a playlist, and "More" appends another batch on demand.
 */
export interface StationSeed {
	kind: "song" | "album" | "artist";
	/** Id passed to `getSimilarSongs` (accepts song, album, and artist ids). */
	id: string;
	/** Shown in the queue header, e.g. `Station: My Girls`. */
	label: string;
	/** Fallback pool: pads the batch with genre-random tracks when needed. */
	genre?: string;
}

/** Default tracks per batch — roughly two hours of listening. */
export const DEFAULT_STATION_BATCH_SIZE = 30;
/**
 * No artist fills more than a fifth of a batch. The server's similar-songs
 * list front-loads the seed artist's own tracks; without a cap an artist
 * station comes out 80%+ seed artist.
 */
const MAX_ARTIST_SHARE = 5;
/** An artist never plays more than this many tracks back to back. */
const MAX_CONSECUTIVE_PER_ARTIST = 2;

/**
 * Build one station batch: similarity results first (needs last.fm configured
 * server-side; silently empty without it), padded from the seed's genre when
 * the similar pool runs short. Tracks in `exclude` are skipped, so repeated
 * calls with the queue's ids produce fresh batches until the pools run dry.
 * `precedingTracks` are the tracks at the end of the existing queue (newest
 * last), so an appended batch doesn't continue a streak across the seam.
 */
export async function buildStationBatch(
	client: SubsonicClient,
	seed: StationSeed,
	exclude: ReadonlySet<string>,
	precedingTracks: Song[] = [],
	batchSize: number = DEFAULT_STATION_BATCH_SIZE
): Promise<Song[]> {
	// Candidate headroom: capping and exclusions need a deep pool to draw from.
	const poolSize = batchSize * 5;
	const maxPerArtist = Math.ceil(batchSize / MAX_ARTIST_SHARE);
	const picked: Song[] = [];
	const seen = new Set(exclude);
	const perArtist = new Map<string, number>();

	const take = (songs: Song[]): void => {
		for (const song of songs) {
			if (picked.length >= batchSize) return;
			if (seen.has(song.id)) continue;
			const artist = artistKey(song);
			if ((perArtist.get(artist) ?? 0) >= maxPerArtist) continue;
			seen.add(song.id);
			perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
			picked.push(song);
		}
	};

	take(await client.getSimilarSongs(seed.id, poolSize));

	if (picked.length < batchSize && seed.genre) {
		take(await client.getRandomSongs(poolSize, seed.genre));
	}

	return spreadArtists(picked, precedingTracks);
}

/**
 * Reorder tracks so artists interleave: prefer an artist different from the
 * one that just played, and never allow more than MAX_CONSECUTIVE_PER_ARTIST
 * in a row. Relative relevance order is kept within those constraints (the
 * earliest eligible candidate wins each slot).
 */
function spreadArtists(pool: Song[], precedingTracks: Song[]): Song[] {
	const remaining = [...pool];
	const result: Song[] = [];
	// Seed the lookback with the queue tail so "More" respects the seam.
	const recent = precedingTracks.map(artistKey);

	const lastArtist = (): string | undefined => recent[recent.length - 1];
	const runLength = (): number => {
		const last = lastArtist();
		if (last === undefined) return 0;
		let run = 0;
		for (let i = recent.length - 1; i >= 0 && recent[i] === last; i--) run += 1;
		return run;
	};

	while (remaining.length > 0) {
		// First choice: a different artist than the last track.
		let pick = remaining.findIndex((song) => artistKey(song) !== lastArtist());
		// Fallback: same artist is fine while the run stays under the cap.
		if (pick === -1 && runLength() < MAX_CONSECUTIVE_PER_ARTIST) pick = 0;
		// Nothing eligible (single-artist tail): take it anyway — a long run of
		// one artist beats silently dropping tracks the cap already allowed.
		if (pick === -1) pick = 0;
		const song = remaining.splice(pick, 1)[0] as Song;
		result.push(song);
		recent.push(artistKey(song));
	}

	return result;
}

/** Group tracks by artist id when known, artist name otherwise. */
function artistKey(song: Song): string {
	return (song.artistId ?? song.artist ?? "").toLowerCase();
}
