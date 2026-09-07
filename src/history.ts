import { md5Hex } from "./md5";
import type { StereoSettings } from "./settings";
import type { Song } from "./subsonic";

export interface HistoryEntry {
	song: Song;
	playedAt: number;
}

export interface HistorySnapshot {
	connection: string;
	entries: readonly HistoryEntry[];
}

/** Identifies the configured account without persisting connection credentials. */
export function historyConnection(settings: StereoSettings): string {
	return md5Hex(JSON.stringify([settings.serverUrl, settings.username]));
}

function metadata(raw: unknown): Song | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (typeof value.id !== "string" || !value.id || typeof value.title !== "string" || value.streamUrl) return null;
	const song: Song = { id: value.id, title: value.title };
	for (const key of ["artist", "artistId", "album", "albumId", "genre", "coverArt"] as const) {
		const field = value[key];
		// Artwork is a server ID, never a persisted authenticated URL.
		if (typeof field === "string" && (key !== "coverArt" || !/[:/?#]/.test(field))) song[key] = field;
	}
	if (typeof value.duration === "number" && Number.isFinite(value.duration) && value.duration >= 0) song.duration = value.duration;
	return song;
}

/** Local play events, independent of the queue and its undo snapshot. */
export class HistoryStore {
	private connection = "";
	private entries: readonly HistoryEntry[] = [];
	private listeners = new Set<() => void>();
	private persist: ((snapshot: HistorySnapshot) => void) | null = null;

	getEntries(): readonly HistoryEntry[] { return this.entries; }
	getConnection(): string { return this.connection; }
	getSnapshot(): HistorySnapshot { return { connection: this.connection, entries: this.entries }; }

	restore(raw: unknown, connection: string): void {
		this.connection = connection;
		this.entries = [];
		if (!raw || typeof raw !== "object") return;
		const snapshot = raw as Record<string, unknown>;
		if (snapshot.connection !== connection || !Array.isArray(snapshot.entries)) return;
		const entries: HistoryEntry[] = [];
		for (const rawEntry of snapshot.entries) {
			if (!rawEntry || typeof rawEntry !== "object") continue;
			const entry = rawEntry as Record<string, unknown>;
			const song = metadata(entry.song);
			if (song && typeof entry.playedAt === "number" && entry.playedAt > 0 && entry.playedAt <= 8.64e15) {
				entries.push({ song, playedAt: entry.playedAt });
			}
		}
		this.entries = entries.sort((a, b) => b.playedAt - a.playedAt).slice(0, 200);
	}

	setPersistence(persist: (snapshot: HistorySnapshot) => void): void { this.persist = persist; }
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changeConnection(connection: string): boolean {
		if (connection === this.connection) return false;
		this.connection = connection;
		this.clear();
		return true;
	}

	record(track: Song, connection: string): void {
		if (connection !== this.connection) return;
		const song = metadata(track);
		if (!song) return;
		this.entries = [{ song, playedAt: Date.now() }, ...this.entries].slice(0, 200);
		this.changed();
	}

	clear(): void {
		this.entries = [];
		this.changed();
	}

	private changed(): void {
		this.persist?.(this.getSnapshot());
		for (const listener of this.listeners) listener();
	}

	destroy(): void { this.listeners.clear(); this.persist = null; }
}
