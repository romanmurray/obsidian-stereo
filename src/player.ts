import type { StereoSettings } from "./settings";
import { HistoryStore, historyConnection, type HistoryEntry } from "./history";
import { buildStationBatch, type StationSeed } from "./station";
import type { Song, SubsonicClient } from "./subsonic";

export type RepeatMode = "off" | "queue" | "track";

export interface PlayerState {
	/** The play queue. `queue[index]` is the current track. */
	queue: Song[];
	/** Index of the current track, or -1 when the queue is empty. */
	index: number;
	/** The current track (derived: queue[index]), or null when idle. */
	track: Song | null;
	playing: boolean;
	/** Playback position in seconds. */
	position: number;
	/** Track duration in seconds (from the audio element once known, else API metadata). */
	duration: number;
	/** 0..1 */
	volume: number;
	repeat: RepeatMode;
	/** Seed of the active station, or null when the queue is a plain queue. */
	station: StationSeed | null;
	/** A session-only queue replacement can be undone. */
	canUndo: boolean;
	/** Human-readable playback error, cleared on the next successful action. */
	error: string | null;
}

/** What survives a restart (written to the plugin data file). */
export interface PlayerSnapshot {
	queue: Song[];
	index: number;
	position: number;
	volume: number;
	/** Optional for saved sessions from before repeat support. */
	repeat?: RepeatMode;
	station?: StationSeed;
}

type Listener = (state: Readonly<PlayerState>) => void;

interface QueueUndoSnapshot {
	queue: Song[];
	index: number;
	position: number;
	playing: boolean;
	station: StationSeed | null;
}

/** Pressing previous after this many seconds restarts the track instead. */
const PREVIOUS_RESTARTS_AFTER_SECONDS = 3;
/** Persist playback position at most this often while playing. */
const POSITION_PERSIST_INTERVAL_SECONDS = 5;
/** A play scrobbles at half the track or after this many seconds, whichever first. */
const SCROBBLE_AFTER_SECONDS = 240;

/**
 * Framework-free playback store. Owns the single `<audio>` element for the
 * whole plugin; the element is never attached to the DOM, so playback
 * survives the view closing. UI components subscribe and render from state —
 * they never touch the audio element directly (AGENTS.md).
 */
export class PlayerStore {
	readonly history = new HistoryStore();
	private historyRecorded = false;
	private loadedConnection = "";
	private client: SubsonicClient;
	private getSettings: () => StereoSettings;
	private audio: HTMLAudioElement;
	private prefetchAudio: HTMLAudioElement | null = null;
	private prefetchedId: string | null = null;
	private listeners = new Set<Listener>();
	private persist: ((snapshot: PlayerSnapshot) => void) | null = null;
	private lastPersistedPosition = 0;
	/** Position to seek to once metadata loads (used when resuming a restored queue). */
	private pendingSeek: number | null = null;
	private undoSnapshot: QueueUndoSnapshot | null = null;
	private loadVersion = 0;
	// Visualizer plumbing (lazy — nothing is created unless a visualizer view
	// asks for the analyser). Playback never routes through the audio graph.
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private captureStream: MediaStream | null = null;
	private captureSource: MediaStreamAudioSourceNode | null = null;
	/** Whether the current load has already scrobbled a completed play. */
	private scrobbleSubmitted = false;
	/** Track the OS media session metadata was last built for. */
	private mediaSessionTrackKey: string | null = null;

	private state: PlayerState = {
		queue: [],
		index: -1,
		track: null,
		playing: false,
		position: 0,
		duration: 0,
		volume: 0.5,
		repeat: "off",
		station: null,
		canUndo: false,
		error: null,
	};

	constructor(client: SubsonicClient, getSettings: () => StereoSettings) {
		this.client = client;
		this.getSettings = getSettings;
		this.history.restore(undefined, historyConnection(getSettings()));
		this.audio = new Audio();
		this.audio.preload = "auto";
		this.audio.volume = this.state.volume;

		this.audio.addEventListener("play", this.onPlay);
		this.audio.addEventListener("playing", this.onPlaying);
		this.audio.addEventListener("pause", this.onPause);
		this.audio.addEventListener("timeupdate", this.onTimeUpdate);
		this.audio.addEventListener("durationchange", this.onDurationChange);
		this.audio.addEventListener("loadedmetadata", this.onLoadedMetadata);
		this.audio.addEventListener("ended", this.onEnded);
		this.audio.addEventListener("error", this.onError);
		this.registerMediaSessionHandlers();
	}

	// --- subscription & persistence wiring ---

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	getState(): Readonly<PlayerState> {
		return this.state;
	}

	/** Discard IDs and pending playback from the previous server/account. */
	syncConnection(): void {
		if (!this.history.changeConnection(historyConnection(this.getSettings()))) return;
		this.historyRecorded = true;
		this.invalidateUndo();
		this.emptyQueue();
	}

	async playHistoryEntry(entry: HistoryEntry, append = false): Promise<void> {
		this.syncConnection();
		// Also rejects a stale menu opened before clear or a connection change.
		if (!this.history.getEntries().includes(entry)) return;
		if (append) await this.addToQueue([entry.song]);
		else await this.playTrack(entry.song);
	}

	/** The plugin registers a (debounced) writer for restart persistence. */
	setPersistence(persist: (snapshot: PlayerSnapshot) => void): void {
		this.persist = persist;
	}

	/** Restore a previous session's queue without starting playback. */
	restore(snapshot: PlayerSnapshot): void {
		this.invalidateUndo();
		const index =
			snapshot.queue.length > 0 &&
			snapshot.index >= 0 &&
			snapshot.index < snapshot.queue.length
				? snapshot.index
				: snapshot.queue.length > 0
					? 0
					: -1;
		const track = index >= 0 ? (snapshot.queue[index] ?? null) : null;
		const volume = Math.max(0, Math.min(1, snapshot.volume));
		this.audio.volume = volume;
		this.pendingSeek = track ? Math.max(0, snapshot.position) : null;
		this.update({
			queue: snapshot.queue,
			index,
			track,
			playing: false,
			position: track ? Math.max(0, snapshot.position) : 0,
			duration: track?.duration ?? 0,
			volume,
			repeat: snapshot.repeat === "queue" || snapshot.repeat === "track" ? snapshot.repeat : "off",
			station: snapshot.station ?? null,
			error: null,
		});
	}

	private notify(): void {
		for (const listener of this.listeners) listener(this.state);
	}

	private update(patch: Partial<PlayerState>): void {
		this.state = { ...this.state, ...patch };
		this.notify();
		this.syncMediaSession();
	}

	private persistNow(): void {
		if (!this.persist) return;
		this.lastPersistedPosition = this.state.position;
		this.persist({
			queue: this.state.queue,
			index: this.state.index,
			position: this.state.position,
			volume: this.state.volume,
			repeat: this.state.repeat,
			station: this.state.station ?? undefined,
		});
	}

	// --- queue actions ---

	private captureUndo(): void {
		if (this.state.queue.length === 0) return;
		const { queue, index, position, playing, station } = this.state;
		this.undoSnapshot = { queue: [...queue], index, position, playing, station };
		this.state = { ...this.state, canUndo: true };
	}

	private invalidateUndo(): void {
		this.undoSnapshot = null;
		this.state = { ...this.state, canUndo: false };
	}

	/** Restore the last cleared/replaced queue. Volume and repeat are independent of undo. */
	async undoQueue(): Promise<void> {
		const snapshot = this.undoSnapshot;
		if (!snapshot) return;
		this.invalidateUndo();
		this.emptyQueue();
		const track = snapshot.queue[snapshot.index] ?? null;
		this.update({ ...snapshot, track, playing: false, duration: track?.duration ?? 0 });
		if (track) await this.loadCurrent(snapshot.playing, snapshot.position);
		else this.persistNow();
	}

	/** Move an occurrence by index; never replace or reload the playing audio. */
	moveQueueEntry(from: number, to: number): void {
		const { queue: previous, index: current } = this.state;
		if (
			!Number.isInteger(from) || !Number.isInteger(to) ||
			from < 0 || to < 0 || from >= previous.length || to >= previous.length || from === to
		) return;
		const queue = [...previous];
		const song = queue.splice(from, 1)[0]!;
		queue.splice(to, 0, song);
		let index = current;
		if (from === current) index = to;
		else if (from < current && to >= current) index--;
		else if (from > current && to <= current) index++;
		this.invalidateUndo();
		this.update({ queue, index });
		this.prefetchNext();
		this.persistNow();
	}

	canMoveToNext(index: number): boolean {
		return (
			Number.isInteger(index) && index >= 0 && index < this.state.queue.length &&
			this.state.index >= 0 && index !== this.state.index && index !== this.state.index + 1
		);
	}

	moveToNext(index: number): void {
		if (!this.canMoveToNext(index)) return;
		this.moveQueueEntry(index, index < this.state.index ? this.state.index : this.state.index + 1);
	}

	/** Replace the queue and start playing at `startIndex`. Ends any station. */
	async setQueue(songs: Song[], startIndex = 0): Promise<void> {
		if (songs.length === 0) return;
		const index = Math.max(0, Math.min(startIndex, songs.length - 1));
		this.captureUndo();
		this.update({ queue: [...songs], index, station: null });
		await this.loadCurrent(true);
	}

	/** Append songs to the queue. Starts playback if nothing is loaded. */
	async addToQueue(songs: Song[]): Promise<void> {
		if (songs.length === 0) return;
		this.invalidateUndo();
		const queue = [...this.state.queue, ...songs];
		if (this.state.index < 0) {
			this.update({ queue, index: this.state.queue.length, station: null });
			await this.loadCurrent(true);
			return;
		}
		this.update({ queue });
		this.prefetchNext();
		this.persistNow();
	}

	/** Insert songs immediately after the current track. */
	playNext(songs: Song[]): void {
		if (songs.length === 0) return;
		this.invalidateUndo();
		const queue = [...this.state.queue];
		queue.splice(this.state.index + 1, 0, ...songs);
		this.update({ queue });
		this.prefetchNext();
		this.persistNow();
	}

	/** Jump to a specific queue position and play it. */
	async playAt(index: number): Promise<void> {
		if (index < 0 || index >= this.state.queue.length) return;
		this.update({ index });
		await this.loadCurrent(true);
	}

	/** Remove the track at `index`. Removing the current track advances playback. */
	async removeAt(index: number): Promise<void> {
		if (index < 0 || index >= this.state.queue.length) return;
		this.invalidateUndo();
		const queue = [...this.state.queue];
		queue.splice(index, 1);

		if (queue.length === 0) {
			this.emptyQueue();
			return;
		}
		if (index < this.state.index) {
			this.update({ queue, index: this.state.index - 1 });
			this.prefetchNext();
			this.persistNow();
			return;
		}
		if (index === this.state.index) {
			const wasPlaying = this.state.playing;
			const nextIndex = Math.min(index, queue.length - 1);
			this.update({ queue, index: nextIndex });
			await this.loadCurrent(wasPlaying);
			return;
		}
		this.update({ queue });
		this.prefetchNext();
		this.persistNow();
	}

	/**
	 * Patch every queue entry (and the current track) matching `id` — used to
	 * reflect annotation changes like star/unstar. Playback is untouched.
	 */
	updateSong(id: string, patch: Partial<Song>): void {
		if (!this.state.queue.some((song) => song.id === id)) return;
		const queue = this.state.queue.map((song) =>
			song.id === id ? { ...song, ...patch } : song
		);
		const track =
			this.state.track?.id === id
				? { ...this.state.track, ...patch }
				: this.state.track;
		this.update({ queue, track });
		this.persistNow();
	}

	/** Empty the queue and stop playback. */
	clearQueue(): void {
		if (this.state.queue.length === 0) return;
		this.captureUndo();
		this.emptyQueue();
	}

	private emptyQueue(): void {
		this.loadVersion++;
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.audio.load();
		this.dropPrefetch();
		this.pendingSeek = null;
		this.update({
			queue: [],
			index: -1,
			track: null,
			playing: false,
			position: 0,
			duration: 0,
			station: null,
			error: null,
		});
		this.persistNow();
	}

	/**
	 * Automatic completion honors repeat track; explicit next skips it. Live
	 * radio still advances to whatever follows it, but never restarts itself:
	 * no repeat track, and no wrap that would land on the same stream.
	 */
	private nextIndex(automatic: boolean): number {
		const { queue, index, track, repeat } = this.state;
		if (!track || index < 0 || queue.length === 0) return -1;
		const radio = !!track.streamUrl;
		if (automatic && repeat === "track" && !radio) return index;
		const next = index + 1 < queue.length ? index + 1 : repeat === "queue" ? 0 : -1;
		// Compare streams, not positions: a duplicate entry is the same reconnect.
		return radio && queue[next]?.streamUrl === track.streamUrl ? -1 : next;
	}

	canNext(): boolean {
		return this.nextIndex(false) >= 0;
	}

	/** Advance explicitly, wrapping only for repeat queue on songs. */
	async next(): Promise<void> {
		const index = this.nextIndex(false);
		if (index < 0) return;
		this.update({ index });
		await this.loadCurrent(true);
	}

	cycleRepeat(): void {
		const repeat = this.state.repeat === "off" ? "queue" : this.state.repeat === "queue" ? "track" : "off";
		this.update({ repeat });
		this.prefetchNext();
		this.persistNow();
	}

	/**
	 * Shuffle the queue: the current track moves to the top and the rest are
	 * reordered randomly behind it. One-shot action, not a mode.
	 */
	shuffleQueue(): void {
		if (this.state.queue.length < 2) return;
		const current = this.state.index;
		const rest = this.state.queue.map((_, i) => i).filter((i) => i !== current);
		for (let i = rest.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const a = rest[i]!;
			rest[i] = rest[j]!;
			rest[j] = a;
		}
		const order = current >= 0 ? [current, ...rest] : rest;
		if (order.every((original, i) => original === i)) return;
		const queue = order.map((i) => this.state.queue[i]!);
		this.invalidateUndo();
		this.update({ queue, index: current >= 0 ? 0 : current });
		this.prefetchNext();
		this.persistNow();
	}

	/**
	 * Build a station around `seed` and play it. When `lead` is given it plays
	 * first — and if it is already the loaded track, playback is left alone and
	 * only the rest of the queue is swapped out behind it. Returns the queue
	 * length, or 0 when the server had no tracks for this seed (queue untouched).
	 * Throws on server failure.
	 */
	async startStation(seed: StationSeed, lead?: Song): Promise<number> {
		const connection = historyConnection(this.getSettings());
		const exclude = new Set(lead ? [lead.id] : []);
		// The lead counts as already played, so the batch opens with someone else.
		const batch = await buildStationBatch(
			this.client,
			seed,
			exclude,
			lead ? [lead] : [],
			this.getSettings().stationBatchSize
		);
		if (batch.length === 0 || connection !== historyConnection(this.getSettings())) return 0;
		const queue = lead ? [lead, ...batch] : batch;
		this.captureUndo();

		if (lead && this.state.track?.id === lead.id && this.audio.src) {
			this.update({ queue, index: 0, station: seed, error: null });
			this.prefetchNext();
			this.persistNow();
			return queue.length;
		}
		this.update({ queue, index: 0, station: seed, error: null });
		await this.loadCurrent(true);
		return queue.length;
	}

	/**
	 * Append one more batch to the active station, skipping everything already
	 * queued. Returns the number of tracks added — 0 when the station's pools
	 * are exhausted. Throws on server failure.
	 */
	async extendStation(): Promise<number> {
		const seed = this.state.station;
		if (!seed) return 0;
		const originalQueue = this.state.queue;
		const exclude = new Set(this.state.queue.map((song) => song.id));
		// Hand over the queue tail so the seam doesn't create an artist streak.
		const batch = await buildStationBatch(
			this.client,
			seed,
			exclude,
			this.state.queue.slice(-2),
			this.getSettings().stationBatchSize
		);
		if (
			batch.length === 0 || this.state.queue !== originalQueue || this.state.station !== seed
		) return 0;
		this.invalidateUndo();
		this.update({ queue: [...this.state.queue, ...batch] });
		this.prefetchNext();
		this.persistNow();
		return batch.length;
	}

	/** Restart the current track, or go to the previous one near a track's start. */
	async previous(): Promise<void> {
		if (
			this.state.position > PREVIOUS_RESTARTS_AFTER_SECONDS ||
			this.state.index <= 0
		) {
			this.seek(0);
			return;
		}
		this.update({ index: this.state.index - 1 });
		await this.loadCurrent(true);
	}

	// --- playback actions ---

	/** Replace the queue with a single track and play it. */
	async playTrack(track: Song): Promise<void> {
		await this.setQueue([track], 0);
	}

	async togglePlayPause(): Promise<void> {
		if (!this.state.track) return;
		if (!this.audio.src) {
			// Restored session: the track is known but nothing is loaded yet.
			await this.loadCurrent(true, this.state.position);
			return;
		}
		if (this.audio.paused) {
			if (this.audio.ended) {
				await this.loadCurrent(true);
				return;
			}
			await this.tryPlay();
		} else {
			this.audio.pause();
		}
	}

	/** Seek to a position in seconds. */
	seek(seconds: number): void {
		if (!this.state.track) return;
		if (!this.audio.src) {
			this.pendingSeek = Math.max(0, seconds);
			this.update({ position: Math.max(0, seconds) });
			return;
		}
		const target = Math.max(0, Math.min(seconds, this.state.duration));
		this.audio.currentTime = target;
		// Update state immediately rather than waiting for `timeupdate`, so
		// consecutive actions (e.g. double-pressing previous) see the new position.
		this.update({ position: target });
	}

	setVolume(volume: number): void {
		const clamped = Math.max(0, Math.min(1, volume));
		this.audio.volume = clamped;
		this.update({ volume: clamped });
		this.persistNow();
	}

	// --- OS media session (media keys, system playback overlay) ---

	/** Wire the OS transport controls to the store. Handlers live for the
	 * store's lifetime; destroy() detaches them. */
	private registerMediaSessionHandlers(): void {
		const session = navigator.mediaSession;
		if (!session) return;
		try {
			session.setActionHandler("play", () => {
				if (!this.state.playing) void this.togglePlayPause();
			});
			session.setActionHandler("pause", () => {
				if (this.state.playing) void this.togglePlayPause();
			});
			session.setActionHandler("previoustrack", () => {
				void this.previous();
			});
			session.setActionHandler("nexttrack", () => {
				void this.next();
			});
			session.setActionHandler("seekto", (details) => {
				if (details.seekTime != null) this.seek(details.seekTime);
			});
		} catch {
			// An engine without one of these actions throws — the rest still work.
		}
	}

	/** Mirror state into the OS media session. Metadata rebuilds only on track
	 * change; playback/position state follow every update. */
	private syncMediaSession(): void {
		const session = navigator.mediaSession;
		if (!session) return;
		const track = this.state.track;
		if (!track) {
			session.metadata = null;
			session.playbackState = "none";
			this.mediaSessionTrackKey = null;
			return;
		}
		session.playbackState = this.state.playing ? "playing" : "paused";
		const key = track.streamUrl ?? track.id;
		if (key !== this.mediaSessionTrackKey) {
			this.mediaSessionTrackKey = key;
			session.metadata = new MediaMetadata({
				title: track.title,
				artist: track.artist ?? "",
				album: track.album ?? "",
				artwork: track.coverArt
					? [{ src: this.client.coverArtUrl(track.coverArt, 512) }]
					: [],
			});
		}
		// Radio streams have no meaningful duration — leave the position bar off.
		const { position, duration } = this.state;
		if (Number.isFinite(duration) && duration > 0 && position <= duration) {
			try {
				session.setPositionState({ duration, position, playbackRate: 1 });
			} catch {
				/* out-of-range race during a track switch — next update corrects it */
			}
		} else {
			session.setPositionState();
		}
	}

	/**
	 * Analyser fed by a capture of the audio element's output (PRD §5.8). The
	 * element keeps playing directly — the graph only listens to a copy — so
	 * no failure here can ever affect playback. Returns null until captured
	 * audio exists (nothing loaded yet, or capture unsupported).
	 */
	getAnalyser(): AnalyserNode | null {
		try {
			const audio = this.audio as HTMLAudioElement & {
				captureStream?: () => MediaStream;
			};
			if (!audio.captureStream) return null;
			if (!this.captureStream) {
				this.captureStream = audio.captureStream();
				// The element gets a new capture track per loaded source; follow it.
				this.captureStream.addEventListener("addtrack", () => {
					this.rewireCapture();
				});
			}
			this.audioContext ??= new AudioContext();
			if (!this.analyser) {
				this.analyser = this.audioContext.createAnalyser();
				// 8192 gives ~5.9 Hz bins, enough low-end resolution for the
				// frequency-bars view's log axis (smaller FFTs make the bass bars
				// snap to shared bins and plateau). Time-domain views are unaffected.
				this.analyser.fftSize = 8192;
				this.analyser.smoothingTimeConstant = 0.8;
			}
			if (!this.captureSource) this.rewireCapture();
			void this.audioContext.resume().catch(() => {});
			return this.analyser;
		} catch {
			return null;
		}
	}

	/** (Re)connect the capture's current audio track to the analyser. */
	private rewireCapture(): void {
		if (!this.audioContext || !this.analyser || !this.captureStream) return;
		const tracks = this.captureStream.getAudioTracks();
		// The element adds a NEW capture track on every source change and leaves the
		// old ones in the stream as "ended". A MediaStreamAudioSourceNode binds to
		// the FIRST track in its stream, so after the first skip/seek that would be
		// a dead, muted track and the analyser reads pure silence. Always bind the
		// current LIVE track wrapped in its own stream, and drop the stale ones so
		// they can't pile up over a session.
		const live =
			tracks.filter((track) => track.readyState === "live").pop() ??
			tracks[tracks.length - 1];
		if (!live) return;
		for (const track of tracks) {
			if (track === live) continue;
			try {
				track.stop();
			} catch {
				/* already ended */
			}
			this.captureStream.removeTrack(track);
		}
		try {
			this.captureSource?.disconnect();
			this.captureSource = this.audioContext.createMediaStreamSource(
				new MediaStream([live])
			);
			this.captureSource.connect(this.analyser);
		} catch {
			// Transient (e.g. no live track yet) — the next addtrack retries.
			this.captureSource = null;
		}
	}

	/** Stop playback and release resources. Called from plugin onunload. */
	destroy(): void {
		this.persistNow();
		this.loadVersion++;
		this.invalidateUndo();
		const session = navigator.mediaSession;
		if (session) {
			for (const action of [
				"play",
				"pause",
				"previoustrack",
				"nexttrack",
				"seekto",
			] as MediaSessionAction[]) {
				try {
					session.setActionHandler(action, null);
				} catch {
					/* action unsupported by this engine */
				}
			}
			session.metadata = null;
			session.playbackState = "none";
		}
		this.audio.pause();
		this.audio.removeEventListener("play", this.onPlay);
		this.audio.removeEventListener("playing", this.onPlaying);
		this.audio.removeEventListener("pause", this.onPause);
		this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
		this.audio.removeEventListener("durationchange", this.onDurationChange);
		this.audio.removeEventListener("loadedmetadata", this.onLoadedMetadata);
		this.audio.removeEventListener("ended", this.onEnded);
		this.audio.removeEventListener("error", this.onError);
		this.audio.removeAttribute("src");
		this.audio.load();
		this.dropPrefetch();
		this.listeners.clear();
		this.history.destroy();
		this.persist = null;
		this.captureSource?.disconnect();
		this.captureSource = null;
		this.analyser = null;
		this.captureStream = null;
		void this.audioContext?.close().catch(() => {});
		this.audioContext = null;
	}

	// --- internals ---

	/** Load queue[index] into the audio element. */
	private async loadCurrent(autoplay: boolean, startAt?: number): Promise<void> {
		const track = this.state.queue[this.state.index] ?? null;
		if (!track) return;
		const version = ++this.loadVersion;
		this.historyRecorded = false;
		this.loadedConnection = historyConnection(this.getSettings());
		this.audio.pause();
		this.pendingSeek = startAt ?? null;
		this.update({
			track,
			playing: false,
			position: startAt ?? 0,
			duration: track.duration ?? 0,
			error: null,
		});
		// Server streams are fetched with CORS so the visualizer's capture is
		// audible to the analyser. Radio URLs may not send CORS headers, and a
		// crossorigin request to such a server refuses to play at all — leave
		// the attribute off for them (their capture is just silent instead).
		if (track.streamUrl) {
			this.audio.removeAttribute("crossorigin");
		} else {
			this.audio.crossOrigin = "anonymous";
		}
		try {
			this.audio.src = track.streamUrl ?? this.client.streamUrl(track.id);
		} catch (error) {
			this.audio.removeAttribute("src");
			this.audio.load();
			this.dropPrefetch();
			this.update({ error: error instanceof Error ? error.message : "Playback failed." });
			this.persistNow();
			return;
		}
		this.scrobbleSubmitted = false;
		if (!track.streamUrl && this.getSettings().scrobbleEnabled) {
			// "Now playing" notification; the completed play scrobbles later.
			this.client.scrobble(track.id, false).catch(() => {});
		}
		this.prefetchNext();
		this.persistNow();
		if (autoplay) await this.tryPlay(version);
	}

	private async tryPlay(version = this.loadVersion): Promise<void> {
		try {
			await this.audio.play();
		} catch (error) {
			if (version !== this.loadVersion) return;
			this.update({
				playing: false,
				error: error instanceof Error ? error.message : "Playback failed.",
			});
		}
	}

	/** Warm the browser cache for the next automatic playback target. */
	private prefetchNext(): void {
		const nextTrack = this.state.queue[this.nextIndex(true)];
		// Never prefetch direct-URL entries (internet radio): they are live
		// streams, so "warming" one would hold an open connection.
		if (!nextTrack || nextTrack.streamUrl) {
			this.dropPrefetch();
			return;
		}
		if (this.prefetchedId === nextTrack.id) return;
		this.dropPrefetch();
		this.prefetchAudio = new Audio();
		this.prefetchAudio.preload = "auto";
		try {
			this.prefetchAudio.src = this.client.streamUrl(nextTrack.id);
			this.prefetchedId = nextTrack.id;
		} catch {
			// A cache warm-up failure must not interrupt playback or repeat changes.
			this.dropPrefetch();
		}
	}

	/** Record the play once it passes half the track or SCROBBLE_AFTER_SECONDS. */
	private maybeScrobble(): void {
		const track = this.state.track;
		if (this.scrobbleSubmitted || !track || track.streamUrl) return;
		if (!this.getSettings().scrobbleEnabled) return;
		const { position, duration } = this.state;
		if (duration <= 0) return;
		if (position >= duration / 2 || position >= SCROBBLE_AFTER_SECONDS) {
			this.scrobbleSubmitted = true;
			this.client.scrobble(track.id, true).catch(() => {});
		}
	}

	private dropPrefetch(): void {
		if (this.prefetchAudio) {
			this.prefetchAudio.removeAttribute("src");
			this.prefetchAudio.load();
			this.prefetchAudio = null;
		}
		this.prefetchedId = null;
	}

	// --- audio element events ---

	private onPlay = (): void => {
		this.update({ playing: true, error: null });
	};

	/**
	 * Fires when audio actually starts flowing (initial play, and after every
	 * track change / seek buffering). This is the reliable moment to (re)bind the
	 * analyser capture to the *current* live audio track — we do NOT depend on the
	 * capture stream's own "addtrack" event, which misses on source changes in the
	 * embedded engine and leaves the visualizer stuck on a dead/silent track.
	 * Only acts once the capture graph already exists (i.e. a visualizer has been
	 * shown); otherwise the next getAnalyser() call bootstraps it against the
	 * already-playing track. Never touches playback itself.
	 */
	private onPlaying = (): void => {
		if (!this.historyRecorded && this.state.track && this.audio.src && !this.audio.paused && !this.audio.error && this.audio.readyState >= 2) {
			this.historyRecorded = true;
			if (this.loadedConnection === historyConnection(this.getSettings())) {
				this.history.record(this.state.track, this.loadedConnection);
			}
		}
		if (!this.audioContext) return;
		this.rewireCapture();
		void this.audioContext.resume().catch(() => {});
	};

	private onPause = (): void => {
		this.update({ playing: false });
		this.persistNow();
	};

	private onTimeUpdate = (): void => {
		if (this.pendingSeek != null) return;
		this.update({ position: this.audio.currentTime });
		this.maybeScrobble();
		if (
			Math.abs(this.state.position - this.lastPersistedPosition) >=
			POSITION_PERSIST_INTERVAL_SECONDS
		) {
			this.persistNow();
		}
	};

	private onDurationChange = (): void => {
		if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
			this.update({ duration: this.audio.duration });
		}
	};

	private onLoadedMetadata = (): void => {
		if (this.pendingSeek != null) {
			this.audio.currentTime = Math.min(this.pendingSeek, this.audio.duration);
			this.pendingSeek = null;
		}
	};

	private onEnded = (): void => {
		// A queued event from a replaced source, or a failed load, is not completion.
		if (!this.audio.ended || this.audio.error || this.state.error || !this.state.track) return;
		const index = this.nextIndex(true);
		if (index >= 0) {
			this.update({ index });
			void this.loadCurrent(true);
		} else {
			this.update({ playing: false, position: 0 });
			this.persistNow();
		}
	};

	private onError = (): void => {
		if (!this.audio.src) return;
		this.update({ playing: false, error: "Could not play this track." });
	};
}
