import type { StereoSettings } from "./settings";
import { buildStationBatch, type StationSeed } from "./station";
import type { Song, SubsonicClient } from "./subsonic";

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
	/** Seed of the active station, or null when the queue is a plain queue. */
	station: StationSeed | null;
	/** Human-readable playback error, cleared on the next successful action. */
	error: string | null;
}

/** What survives a restart (written to the plugin data file). */
export interface PlayerSnapshot {
	queue: Song[];
	index: number;
	position: number;
	volume: number;
	station?: StationSeed;
}

type Listener = (state: Readonly<PlayerState>) => void;

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
	// Visualizer plumbing (lazy — nothing is created unless a visualizer view
	// asks for the analyser). Playback never routes through the audio graph.
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private captureStream: MediaStream | null = null;
	private captureSource: MediaStreamAudioSourceNode | null = null;
	/** Whether the current load has already scrobbled a completed play. */
	private scrobbleSubmitted = false;

	private state: PlayerState = {
		queue: [],
		index: -1,
		track: null,
		playing: false,
		position: 0,
		duration: 0,
		volume: 0.5,
		station: null,
		error: null,
	};

	constructor(client: SubsonicClient, getSettings: () => StereoSettings) {
		this.client = client;
		this.getSettings = getSettings;
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

	/** The plugin registers a (debounced) writer for restart persistence. */
	setPersistence(persist: (snapshot: PlayerSnapshot) => void): void {
		this.persist = persist;
	}

	/** Restore a previous session's queue without starting playback. */
	restore(snapshot: PlayerSnapshot): void {
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
	}

	private persistNow(): void {
		if (!this.persist) return;
		this.lastPersistedPosition = this.state.position;
		this.persist({
			queue: this.state.queue,
			index: this.state.index,
			position: this.state.position,
			volume: this.state.volume,
			station: this.state.station ?? undefined,
		});
	}

	// --- queue actions ---

	/** Replace the queue and start playing at `startIndex`. Ends any station. */
	async setQueue(songs: Song[], startIndex = 0): Promise<void> {
		if (songs.length === 0) return;
		const index = Math.max(0, Math.min(startIndex, songs.length - 1));
		this.update({ queue: songs, index, station: null });
		await this.loadCurrent(true);
	}

	/** Append songs to the queue. Starts playback if nothing is loaded. */
	async addToQueue(songs: Song[]): Promise<void> {
		if (songs.length === 0) return;
		const queue = [...this.state.queue, ...songs];
		if (this.state.index < 0) {
			await this.setQueue(queue, this.state.queue.length);
			return;
		}
		this.update({ queue });
		this.prefetchNext();
		this.persistNow();
	}

	/** Insert songs immediately after the current track. */
	playNext(songs: Song[]): void {
		if (songs.length === 0) return;
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
		const queue = [...this.state.queue];
		queue.splice(index, 1);

		if (queue.length === 0) {
			this.clearQueue();
			return;
		}
		if (index < this.state.index) {
			this.update({ queue, index: this.state.index - 1 });
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

	/** Advance to the next queue entry. At the queue end this is a no-op. */
	async next(): Promise<void> {
		if (this.state.index + 1 >= this.state.queue.length) return;
		this.update({ index: this.state.index + 1 });
		await this.loadCurrent(true);
	}

	/**
	 * Shuffle the queue: the current track moves to the top and the rest are
	 * reordered randomly behind it. One-shot action, not a mode.
	 */
	shuffleQueue(): void {
		if (this.state.queue.length < 2) return;
		const current = this.state.queue[this.state.index];
		const rest = this.state.queue.filter((_, i) => i !== this.state.index);
		for (let i = rest.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			const a = rest[i] as Song;
			rest[i] = rest[j] as Song;
			rest[j] = a;
		}
		const queue = current ? [current, ...rest] : rest;
		this.update({ queue, index: current ? 0 : this.state.index });
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
		const exclude = new Set(lead ? [lead.id] : []);
		// The lead counts as already played, so the batch opens with someone else.
		const batch = await buildStationBatch(
			this.client,
			seed,
			exclude,
			lead ? [lead] : [],
			this.getSettings().stationBatchSize
		);
		if (batch.length === 0) return 0;
		const queue = lead ? [lead, ...batch] : batch;

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
		const exclude = new Set(this.state.queue.map((song) => song.id));
		// Hand over the queue tail so the seam doesn't create an artist streak.
		const batch = await buildStationBatch(
			this.client,
			seed,
			exclude,
			this.state.queue.slice(-2),
			this.getSettings().stationBatchSize
		);
		if (batch.length === 0) return 0;
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
		this.pendingSeek = startAt ?? null;
		this.update({
			track,
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
		this.audio.src = track.streamUrl ?? this.client.streamUrl(track.id);
		this.scrobbleSubmitted = false;
		if (!track.streamUrl && this.getSettings().scrobbleEnabled) {
			// "Now playing" notification; the completed play scrobbles later.
			this.client.scrobble(track.id, false).catch(() => {});
		}
		if (autoplay) await this.tryPlay();
		this.prefetchNext();
		this.persistNow();
	}

	private async tryPlay(): Promise<void> {
		try {
			await this.audio.play();
		} catch (error) {
			this.update({
				playing: false,
				error: error instanceof Error ? error.message : "Playback failed.",
			});
		}
	}

	/** Warm the browser cache for the next queue entry. */
	private prefetchNext(): void {
		const nextTrack = this.state.queue[this.state.index + 1];
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
		this.prefetchAudio.src = this.client.streamUrl(nextTrack.id);
		this.prefetchedId = nextTrack.id;
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
		if (!this.audioContext) return;
		this.rewireCapture();
		void this.audioContext.resume().catch(() => {});
	};

	private onPause = (): void => {
		this.update({ playing: false });
		this.persistNow();
	};

	private onTimeUpdate = (): void => {
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
		if (this.state.index + 1 < this.state.queue.length) {
			void this.next();
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
