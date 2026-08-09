import { ItemView, Menu, Notice, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { getLyrics, type Lyrics } from "./lyrics";
import { LibraryPane } from "./library";
import { PlaylistNameModal } from "./modals";
import { SearchPane } from "./search";
import { Visualizer, type VisualizerMode } from "./visualizer";
import type StereoPlugin from "./main";
import type { PlayerState } from "./player";
import { NOW_PLAYING_VIEWS, type NowPlayingView } from "./settings";
import type { Song } from "./subsonic";

export const STEREO_VIEW_TYPE = "stereo-player";

/** Queue is a full page like the others, but has no top tab — the player's
 * list icon (and the mini player's) navigates to it. */
type TabId = "nowPlaying" | "library" | "queue";

const TAB_IDS: TabId[] = ["nowPlaying", "library", "queue"];

/** Views that render on the canvas visualizer rather than the album-art image. */
function isVizView(view: NowPlayingView): view is VisualizerMode {
	return (
		view === "bars" ||
		view === "waveform" ||
		view === "radio" ||
		view === "boombox" ||
		view === "stereo" ||
		view === "cover"
	);
}

/**
 * View shell. All pages stay mounted and are display-toggled so scroll
 * position and playback UI are never disturbed (AGENTS.md). Renders purely
 * from PlayerStore state. The full player lives on Now Playing; every other
 * screen shows a mini player bar at the bottom.
 */
export class StereoView extends ItemView {
	plugin: StereoPlugin;
	private unsubscribe: (() => void) | null = null;

	// Tabs (queue has a page but no tab button)
	private tabButtons: Partial<Record<TabId, HTMLButtonElement>> = {};
	private pages: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
	private activeTab: TabId = "nowPlaying";

	// Now Playing elements
	private artWrap!: HTMLElement;
	private artImg!: HTMLImageElement;
	private artPlaceholder!: HTMLElement;
	private viz!: Visualizer;
	private nowPlayingView: NowPlayingView = "record";
	private trackInfoEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private artistEl!: HTMLElement;
	private albumEl!: HTMLElement;
	private elapsedEl!: HTMLElement;
	private remainingEl!: HTMLElement;
	private seekSlider!: HTMLInputElement;
	private previousButton!: HTMLButtonElement;
	private playButton!: HTMLButtonElement;
	private nextButton!: HTMLButtonElement;
	private volumeSlider!: HTMLInputElement;
	private shuffleButton!: HTMLButtonElement;
	private queueButton!: HTMLButtonElement;
	private stationButton!: HTMLButtonElement;
	private favoriteButton!: HTMLButtonElement;
	private errorEl!: HTMLElement;

	// Lyrics panel (swaps in for the art area while toggled on)
	private lyricsButton!: HTMLButtonElement;
	private lyricsWrap!: HTMLElement;
	private lyricsScroll!: HTMLElement;
	private lyricsVisible = false;
	/** Track id the panel currently shows; null forces a reload. */
	private lyricsLoadedFor: string | null = null;
	/** Bumped per load; stale async loads bail. */
	private lyricsToken = 0;
	private lyricsData: Lyrics | null = null;
	private lyricsLineEls: HTMLElement[] = [];
	private lyricsActiveLine = -1;

	// Queue page
	private queueTitleEl!: HTMLElement;
	private moreButton!: HTMLButtonElement;
	private queueList!: HTMLElement;

	// Mini player (visible on every screen except Now Playing)
	private miniEl!: HTMLElement;
	private miniThumbImg!: HTMLImageElement;
	private miniThumbPlaceholder!: HTMLElement;
	private miniTitleEl!: HTMLElement;
	private miniArtistEl!: HTMLElement;
	private miniPlayButton!: HTMLButtonElement;

	// Library & search
	private library!: LibraryPane;
	private search: SearchPane | null = null;
	private pagesEl!: HTMLElement;
	private searchResultsEl!: HTMLElement;
	private searchActive = false;

	// Keeps the controls clear of the floating status bar
	private statusBarObserver: ResizeObserver | null = null;

	// Shrinks the album art to fit short panes without scrolling
	private artSizeObserver: ResizeObserver | null = null;

	// Render guards (render() fires on every timeupdate)
	private renderedCoverArt: string | null = null;
	private renderedQueue: Song[] | null = null;
	private renderedIndex = -1;
	private seeking = false;

	constructor(leaf: WorkspaceLeaf, plugin: StereoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return STEREO_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Stereo";
	}

	getIcon(): string {
		return "boom-box";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("stereo-view");

		// Search
		const searchRow = root.createDiv({ cls: "stereo-search-row" });
		setIcon(searchRow.createSpan({ cls: "stereo-search-icon" }), "search");
		const searchInput = searchRow.createEl("input", {
			cls: "stereo-search-input",
			type: "search",
			attr: {
				placeholder: "Search artists, albums, songs…",
				"aria-label": "Search",
			},
		});

		// Tabs
		const tabBar = root.createDiv({ cls: "stereo-tabs" });
		this.tabButtons.nowPlaying = this.tabButton(tabBar, "Now playing", "nowPlaying");
		this.tabButtons.library = this.tabButton(tabBar, "Library", "library");

		this.pagesEl = root.createDiv({ cls: "stereo-pages" });
		this.pages.nowPlaying = this.pagesEl.createDiv({
			cls: "stereo-page stereo-page-scroll",
		});
		this.pages.library = this.pagesEl.createDiv({ cls: "stereo-page" });
		this.pages.queue = this.pagesEl.createDiv({ cls: "stereo-page" });
		this.searchResultsEl = root.createDiv({
			cls: "stereo-search-results stereo-hidden",
		});

		this.buildNowPlaying(this.pages.nowPlaying);
		this.buildQueuePage(this.pages.queue);
		this.buildMiniPlayer(root);
		this.library = new LibraryPane(this.plugin, this.pages.library);
		this.search = new SearchPane(
			this.plugin,
			this.library,
			searchInput,
			this.searchResultsEl,
			{
				onActiveChange: (active) => {
					this.searchActive = active;
					this.searchResultsEl.toggleClass("stereo-hidden", !active);
					this.pagesEl.toggleClass("stereo-hidden", active);
					this.updateMiniVisibility();
					this.updateVizRunning();
				},
				openArtist: (id, name) => {
					this.setActiveTab("library");
					this.library.openArtist(id, name);
				},
				openAlbum: (id, name) => {
					this.setActiveTab("library");
					this.library.openAlbum(id, name);
				},
			}
		);

		// The status bar floats over the window's bottom-right corner; watch
		// it so the clearance tracks status items appearing and disappearing.
		const statusBar = document.body.querySelector(".status-bar");
		if (statusBar) {
			this.statusBarObserver = new ResizeObserver(() => {
				this.updateStatusBarClearance();
			});
			this.statusBarObserver.observe(statusBar);
		}
		this.updateStatusBarClearance();

		// Re-fit the art when the page changes height or the track text
		// wraps to a different number of lines.
		this.artSizeObserver = new ResizeObserver(() => {
			this.updateArtSize();
		});
		this.artSizeObserver.observe(this.pages.nowPlaying);
		this.artSizeObserver.observe(this.trackInfoEl);

		this.setActiveTab("nowPlaying");
		this.applyNowPlayingView();
		this.unsubscribe = this.plugin.player.subscribe((state) => {
			this.render(state);
		});
	}

	async onClose(): Promise<void> {
		this.viz.stop();
		this.statusBarObserver?.disconnect();
		this.statusBarObserver = null;
		this.artSizeObserver?.disconnect();
		this.artSizeObserver = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	/** Fires when the leaf is resized or dragged to a new spot in the layout. */
	onResize(): void {
		this.updateStatusBarClearance();
		this.updateArtSize();
	}

	/**
	 * Size the album art to the height left over after the fixed rows, so
	 * shrinking the pane shrinks the art instead of showing a scrollbar.
	 * Below the floor the page scrolls — better a scrollbar than a stamp.
	 */
	private updateArtSize(): void {
		// No upper cap: the art grows to the largest square the pane allows,
		// bounded by width via the CSS `min(92%, …)` rule and by the leftover
		// height measured here. ART_MIN is the floor below which the page scrolls.
		const ART_MIN = 120;
		const page = this.pages.nowPlaying;
		if (!page || page.clientHeight === 0) return;
		let others = 0;
		for (const child of Array.from(page.children)) {
			// The art wrap and the lyrics panel both flex-grow into the leftover
			// space, so neither counts toward the fixed rows we subtract.
			if (child === this.artWrap || child === this.lyricsWrap) continue;
			others += (child as HTMLElement).offsetHeight;
		}
		const pageStyle = getComputedStyle(page);
		const gaps =
			(parseFloat(pageStyle.rowGap) || 0) * Math.max(0, page.children.length - 1);
		const wrapStyle = getComputedStyle(this.artWrap);
		const padding =
			(parseFloat(wrapStyle.paddingTop) || 0) +
			(parseFloat(wrapStyle.paddingBottom) || 0);
		const available = page.clientHeight - others - gaps - padding;
		const size = Math.floor(Math.max(ART_MIN, available));
		page.style.setProperty("--stereo-art-size", `${size}px`);
		// Auto-sized lyrics track the pane width, so re-scale on the same pass.
		this.updateLyricsSize();
	}

	/**
	 * Measure how much of this pane the floating status bar covers and expose
	 * it as a CSS variable. Zero when the pane sits anywhere the status bar
	 * does not reach, so the player hugs the pane bottom normally there.
	 */
	private updateStatusBarClearance(): void {
		const statusBar = document.body.querySelector(".status-bar");
		const view = this.contentEl.getBoundingClientRect();
		let clearance = 0;
		if (statusBar instanceof HTMLElement && view.height > 0) {
			const bar = statusBar.getBoundingClientRect();
			const sharesColumn = view.left < bar.right && view.right > bar.left;
			if (sharesColumn && bar.height > 0 && view.bottom > bar.top) {
				clearance = Math.round(view.bottom - bar.top);
			}
		}
		this.contentEl.style.setProperty(
			"--stereo-status-bar-clearance",
			`${clearance}px`
		);
	}

	/** Right-click context menu for switching the Now Playing presentation.
	 * Persists the choice and refreshes every open view, matching the settings
	 * dropdown exactly. */
	private showNowPlayingMenu(evt: MouseEvent): void {
		evt.preventDefault();
		const menu = new Menu();
		const current = this.plugin.settings.nowPlayingView;
		for (const opt of NOW_PLAYING_VIEWS) {
			menu.addItem((item) =>
				item
					.setTitle(opt.label)
					.setIcon(opt.icon)
					.setChecked(opt.value === current)
					.onClick(async () => {
						if (this.plugin.settings.nowPlayingView === opt.value) return;
						this.plugin.settings.nowPlayingView = opt.value;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** The effective Now Playing view for a track. Internet-radio streams have no
	 * album art and can't be audio-analysed, so they override the chosen view with
	 * the internet-radio visualization (unless it's set to follow); library tracks
	 * always use the user's choice. Re-evaluated on track change in render(). */
	private effectiveNowPlayingView(track: Song | null): NowPlayingView {
		if (track?.streamUrl) {
			const radio = this.plugin.settings.radioVisualization;
			if (radio !== "follow") return radio;
		}
		return this.plugin.settings.nowPlayingView;
	}

	/** Apply the configured Now Playing view (art shape / visualizer). */
	applyNowPlayingView(): void {
		this.applyLyricsStyle();
		const state = this.plugin.player.getState();
		this.setEffectiveView(this.effectiveNowPlayingView(state.track));
		this.render(state);
	}

	/** Switch the active presentation (art shape / visualizer mode). Does not
	 * re-render — the caller does — so it's safe to call from render() itself. */
	private setEffectiveView(view: NowPlayingView): void {
		this.nowPlayingView = view;
		const isViz = isVizView(view);
		this.artWrap.toggleClass("stereo-art-wrap-viz", isViz);
		this.artImg.toggleClass("stereo-art-square", view !== "record");
		this.artPlaceholder.toggleClass("stereo-art-square", view !== "record");
		if (isViz) {
			this.viz.setMode(view);
		}
		this.updateVizRunning();
	}

	/** The visualizer animates only while it is actually on screen. */
	private updateVizRunning(): void {
		const isViz = isVizView(this.nowPlayingView);
		if (
			isViz &&
			this.activeTab === "nowPlaying" &&
			!this.searchActive &&
			!this.lyricsVisible
		) {
			this.viz.start();
		} else {
			this.viz.stop();
		}
	}

	// --- lyrics ---

	/** Apply configured lyrics font settings as CSS variables. */
	applyLyricsStyle(): void {
		const { lyricsFontFamily, lyricsAlign } = this.plugin.settings;
		this.contentEl.style.setProperty(
			"--stereo-lyrics-font",
			lyricsFontFamily.trim() || "inherit"
		);
		this.contentEl.style.setProperty("--stereo-lyrics-align", lyricsAlign);
		this.updateLyricsSize();
	}

	/** Lyrics text size: either the fixed px setting, or — when auto-adjust is on
	 * — scaled to the pane width so it fills the panel the way the album art
	 * fills its space. Re-run on resize via updateArtSize(). */
	private updateLyricsSize(): void {
		const s = this.plugin.settings;
		let px = s.lyricsFontSize;
		if (s.lyricsAutoSize) {
			const width = this.pages.nowPlaying?.clientWidth ?? 0;
			if (width > 0) {
				// Tunable: font as a fraction of pane width, clamped to a readable range.
				const LYRICS_AUTO_RATIO = 0.05;
				const LYRICS_AUTO_MIN = 14;
				const LYRICS_AUTO_MAX = 40;
				px = Math.round(
					Math.min(LYRICS_AUTO_MAX, Math.max(LYRICS_AUTO_MIN, width * LYRICS_AUTO_RATIO))
				);
			}
		}
		this.contentEl.style.setProperty("--stereo-lyrics-size", `${px}px`);
	}

	/** Swap the art area and the lyrics panel; (re)load lyrics when shown. */
	private applyLyricsVisibility(): void {
		this.artWrap.toggleClass("stereo-hidden", this.lyricsVisible);
		this.lyricsWrap.toggleClass("stereo-hidden", !this.lyricsVisible);
		this.lyricsButton.toggleClass("stereo-button-active", this.lyricsVisible);
		this.updateVizRunning();
		this.updateArtSize();
		if (this.lyricsVisible) {
			void this.loadLyrics(this.plugin.player.getState().track);
		}
	}

	private async loadLyrics(track: Song | null): Promise<void> {
		const token = ++this.lyricsToken;
		this.lyricsData = null;
		this.lyricsLineEls = [];
		this.lyricsActiveLine = -1;
		this.lyricsLoadedFor = track?.id ?? null;
		this.lyricsScroll.empty();
		this.lyricsScroll.removeClass("stereo-lyrics-synced");

		if (!track || track.streamUrl) {
			this.lyricsStatus(
				track ? "Lyrics are not available for radio." : "Nothing playing."
			);
			return;
		}

		this.lyricsStatus("Looking for lyrics…");
		const lyrics = await getLyrics(
			this.plugin.client,
			track,
			this.plugin.settings.lyricsOnlineLookup
		);
		if (token !== this.lyricsToken) return;

		this.lyricsScroll.empty();
		if (!lyrics) {
			this.lyricsStatus("No lyrics found for this track.");
			return;
		}

		this.lyricsData = lyrics;
		this.lyricsScroll.toggleClass("stereo-lyrics-synced", lyrics.synced);
		for (const line of lyrics.lines) {
			const el = this.lyricsScroll.createDiv({
				cls: "stereo-lyrics-line",
				// Empty lines keep their height so verses stay visually grouped.
				text: line.text || " ",
			});
			if (lyrics.synced && line.time != null) {
				const time = line.time;
				this.registerDomEvent(el, "click", () => {
					this.plugin.player.seek(time);
				});
			}
			this.lyricsLineEls.push(el);
		}
		this.updateLyricsHighlight(this.plugin.player.getState().position, true);
	}

	private lyricsStatus(text: string): void {
		this.lyricsScroll.createDiv({ cls: "stereo-lyrics-empty", text });
	}

	/** Highlight and center the line for `position`; runs per timeupdate. */
	private updateLyricsHighlight(position: number, jump: boolean): void {
		const lyrics = this.lyricsData;
		if (!lyrics?.synced) return;

		let index = -1;
		for (let i = 0; i < lyrics.lines.length; i++) {
			const time = lyrics.lines[i]?.time;
			if (time == null) continue;
			if (time <= position + 0.2) index = i;
			else break;
		}
		if (index === this.lyricsActiveLine && !jump) return;

		const previous = this.lyricsLineEls[this.lyricsActiveLine];
		previous?.removeClass("stereo-lyrics-line-active");
		this.lyricsActiveLine = index;
		const current = this.lyricsLineEls[index];
		if (!current) return;
		current.addClass("stereo-lyrics-line-active");

		// Center manually — scrollIntoView would also scroll ancestor panes.
		const target =
			current.offsetTop - this.lyricsScroll.clientHeight / 2 + current.clientHeight / 2;
		this.lyricsScroll.scrollTo({
			top: Math.max(0, target),
			behavior: jump ? "auto" : "smooth",
		});
	}

	// --- construction ---

	private buildNowPlaying(page: HTMLElement): void {
		// Album art / visualizer area (which one shows is a setting)
		this.artWrap = page.createDiv({ cls: "stereo-art-wrap" });
		this.artImg = this.artWrap.createEl("img", {
			cls: "stereo-art",
			attr: { alt: "Album cover" },
		});
		this.artPlaceholder = this.artWrap.createDiv({ cls: "stereo-art-placeholder" });
		setIcon(this.artPlaceholder, "music");
		this.registerDomEvent(this.artImg, "error", () => {
			this.artImg.addClass("stereo-hidden");
			this.artPlaceholder.removeClass("stereo-hidden");
		});
		const vizCanvas = this.artWrap.createEl("canvas", { cls: "stereo-viz" });
		this.viz = new Visualizer(
			vizCanvas,
			() => this.plugin.player.getAnalyser(),
			() => this.plugin.player.getState().playing
		);
		// Right-click the art / visualizer to switch presentation without opening
		// settings. The menu is built from NOW_PLAYING_VIEWS (the same source the
		// settings dropdown uses), so any mode added there shows up here too.
		this.registerDomEvent(this.artWrap, "contextmenu", (evt) =>
			this.showNowPlayingMenu(evt)
		);
		// Radio-tower view's base illustration ships in the plugin folder.
		const dir = this.plugin.manifest.dir ?? "";
		const towerUrl = this.app.vault.adapter.getResourcePath(
			normalizePath(`${dir}/radio-tower.svg`)
		);
		this.viz.setTowerImage(towerUrl);
		const boomboxUrl = this.app.vault.adapter.getResourcePath(
			normalizePath(`${dir}/boombox.svg`)
		);
		this.viz.setBoomboxImage(boomboxUrl);
		const stereoUrl = this.app.vault.adapter.getResourcePath(
			normalizePath(`${dir}/stereo-boombox.svg`)
		);
		this.viz.setStereoImage(stereoUrl);

		// Lyrics panel: swaps in for the art area, sized by the same variable.
		this.lyricsWrap = page.createDiv({ cls: "stereo-lyrics-wrap stereo-hidden" });
		this.lyricsScroll = this.lyricsWrap.createDiv({ cls: "stereo-lyrics" });

		// Track info — one tight block so the three lines read as a unit.
		// Artist and album navigate into the library when known.
		this.trackInfoEl = page.createDiv({ cls: "stereo-track-info" });
		this.titleEl = this.trackInfoEl.createDiv({ cls: "stereo-track-title", text: "Nothing playing" });
		this.artistEl = this.trackInfoEl.createDiv({ cls: "stereo-track-artist" });
		this.albumEl = this.trackInfoEl.createDiv({ cls: "stereo-track-album" });
		this.registerDomEvent(this.artistEl, "click", () => {
			const track = this.plugin.player.getState().track;
			if (!track?.artistId) return;
			this.setActiveTab("library");
			this.library.openArtist(track.artistId, track.artist ?? "");
		});
		this.registerDomEvent(this.albumEl, "click", () => {
			const track = this.plugin.player.getState().track;
			if (!track?.albumId) return;
			this.setActiveTab("library");
			this.library.openAlbum(track.albumId, track.album ?? "");
		});

		// Seek row: elapsed | slider | −remaining
		const seekRow = page.createDiv({ cls: "stereo-seek-row" });
		this.elapsedEl = seekRow.createDiv({ cls: "stereo-time", text: "0:00" });
		this.seekSlider = seekRow.createEl("input", {
			cls: "stereo-seek",
			type: "range",
			attr: { min: "0", max: "0", step: "1", "aria-label": "Seek" },
		});
		this.remainingEl = seekRow.createDiv({ cls: "stereo-time", text: "0:00" });

		this.registerDomEvent(this.seekSlider, "input", () => {
			this.seeking = true;
			const position = Number(this.seekSlider.value);
			this.elapsedEl.setText(formatTime(position));
			this.setRemaining(position, Number(this.seekSlider.max));
		});
		this.registerDomEvent(this.seekSlider, "change", () => {
			this.plugin.player.seek(Number(this.seekSlider.value));
			this.seeking = false;
		});

		// Transport row
		const transportRow = page.createDiv({ cls: "stereo-transport-row" });
		this.previousButton = this.iconButton(transportRow, "skip-back", "Previous", () => {
			void this.plugin.player.previous();
		});
		this.playButton = this.iconButton(transportRow, "play", "Play or pause", () => {
			void this.plugin.player.togglePlayPause();
		});
		this.playButton.addClass("stereo-play-button");
		this.nextButton = this.iconButton(transportRow, "skip-forward", "Next", () => {
			void this.plugin.player.next();
		});

		// Volume row
		const volumeRow = page.createDiv({ cls: "stereo-volume-row" });
		setIcon(volumeRow.createSpan({ cls: "stereo-volume-icon" }), "volume-2");
		this.volumeSlider = volumeRow.createEl("input", {
			cls: "stereo-volume",
			type: "range",
			attr: { min: "0", max: "100", step: "1", "aria-label": "Volume" },
		});
		this.registerDomEvent(this.volumeSlider, "input", () => {
			this.plugin.player.setVolume(Number(this.volumeSlider.value) / 100);
		});

		// Extras row below volume: queue · lyrics · station · favorite (playback
		// modes live on the queue page — they operate on the queue).
		const extrasRow = page.createDiv({ cls: "stereo-extras-row" });
		this.queueButton = this.iconButton(extrasRow, "list-music", "Queue", () => {
			this.setActiveTab("queue");
		});
		this.lyricsButton = this.iconButton(extrasRow, "mic-vocal", "Lyrics", () => {
			this.lyricsVisible = !this.lyricsVisible;
			this.applyLyricsVisibility();
		});
		this.iconButton(extrasRow, "dices", "Play a random song", () => {
			void (async () => {
				try {
					const songs = await this.plugin.client.getRandomSongs(1);
					const song = songs[0];
					if (!song) {
						new Notice("The server returned no random song.");
						return;
					}
					await this.plugin.player.playTrack(song);
				} catch {
					new Notice("Could not fetch a random song from the server.");
				}
			})();
		});
		this.stationButton = this.iconButton(
			extrasRow,
			"disc-3",
			"Start station from this track",
			() => {
				const track = this.plugin.player.getState().track;
				if (!track || track.streamUrl) return;
				void this.plugin.startStation(
					{
						kind: "song",
						id: track.id,
						label: track.title,
						genre: track.genre,
					},
					track
				);
			}
		);
		this.favoriteButton = this.iconButton(extrasRow, "heart", "Add to favorites", () => {
			const track = this.plugin.player.getState().track;
			if (!track || track.streamUrl) return;
			this.plugin.toggleSongFavorite(track).catch(() => {
				new Notice("Could not update favorites on the server.");
			});
		});

		this.errorEl = page.createDiv({ cls: "stereo-error" });
	}

	private buildQueuePage(page: HTMLElement): void {
		const header = page.createDiv({ cls: "stereo-queue-header" });
		this.queueTitleEl = header.createSpan({ cls: "stereo-queue-title", text: "Queue" });
		const actions = header.createDiv({ cls: "stereo-queue-actions" });
		// "More" appends another station batch; visible only while one is active.
		this.moreButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "More",
			attr: { "aria-label": "Add more station tracks" },
		});
		this.registerDomEvent(this.moreButton, "click", async () => {
			this.moreButton.disabled = true;
			try {
				const added = await this.plugin.player.extendStation();
				if (added === 0) {
					new Notice("The station has no more tracks to add.");
				}
			} catch {
				new Notice("Could not fetch more station tracks.");
			} finally {
				this.moreButton.disabled = false;
			}
		});
		this.shuffleButton = this.iconButton(actions, "shuffle", "Shuffle queue", () => {
			this.plugin.player.shuffleQueue();
		});
		const saveButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Save",
			attr: { "aria-label": "Save queue as playlist" },
		});
		this.registerDomEvent(saveButton, "click", () => {
			this.saveQueueAsPlaylist();
		});
		const clearButton = actions.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Clear",
		});
		this.registerDomEvent(clearButton, "click", () => {
			this.plugin.player.clearQueue();
		});
		this.queueList = page.createDiv({ cls: "stereo-queue-list" });
	}

	private buildMiniPlayer(root: HTMLElement): void {
		this.miniEl = root.createDiv({ cls: "stereo-mini" });

		const thumb = this.miniEl.createDiv({ cls: "stereo-mini-thumb" });
		this.miniThumbImg = thumb.createEl("img", {
			cls: "stereo-mini-cover stereo-hidden",
			attr: { alt: "" },
		});
		this.miniThumbPlaceholder = thumb.createDiv({
			cls: "stereo-mini-cover stereo-mini-cover-empty",
		});
		setIcon(this.miniThumbPlaceholder, "music");

		// Clicking the track info opens the full player.
		const meta = this.miniEl.createDiv({ cls: "stereo-mini-meta" });
		this.miniTitleEl = meta.createDiv({
			cls: "stereo-mini-title",
			text: "Nothing playing",
		});
		this.miniArtistEl = meta.createDiv({ cls: "stereo-mini-artist" });
		this.registerDomEvent(meta, "click", () => {
			this.setActiveTab("nowPlaying");
		});

		this.miniPlayButton = this.iconButton(this.miniEl, "play", "Play or pause", () => {
			void this.plugin.player.togglePlayPause();
		});
		this.iconButton(this.miniEl, "list-music", "Queue", () => {
			this.setActiveTab("queue");
		});
	}

	private saveQueueAsPlaylist(): void {
		// Radio entries are live streams, not server tracks — leave them out.
		const songIds = this.plugin.player
			.getState()
			.queue.filter((song) => !song.streamUrl)
			.map((song) => song.id);
		if (songIds.length === 0) {
			new Notice("The queue has no tracks to save.");
			return;
		}
		new PlaylistNameModal(this.app, (name) => {
			this.plugin.client
				.createPlaylist(name, songIds)
				.then(() => {
					new Notice(`Saved "${name}" with ${songIds.length} tracks.`);
					this.library.invalidatePlaylists();
				})
				.catch(() => {
					new Notice("Could not save the playlist on the server.");
				});
		}).open();
	}

	private tabButton(parent: HTMLElement, label: string, tab: TabId): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: "stereo-tab clickable-icon",
			text: label,
		});
		this.registerDomEvent(button, "click", () => {
			this.setActiveTab(tab);
		});
		return button;
	}

	private setActiveTab(tab: TabId): void {
		// Picking a tab always returns to the pages, ending any active search.
		this.search?.close();
		this.activeTab = tab;
		for (const id of TAB_IDS) {
			this.pages[id].toggleClass("stereo-page-active", id === tab);
			this.tabButtons[id]?.toggleClass("stereo-tab-active", id === tab);
		}
		this.queueButton?.toggleClass("stereo-button-active", tab === "queue");
		this.updateMiniVisibility();
		this.updateVizRunning();
		this.updateArtSize();
	}

	/** The mini player shows on every screen except the full player. */
	private updateMiniVisibility(): void {
		const showMini = this.activeTab !== "nowPlaying" || this.searchActive;
		this.miniEl.toggleClass("stereo-hidden", !showMini);
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		// `clickable-icon` is Obsidian's native flat icon-button treatment —
		// no card chrome, themes style it consistently.
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": label },
		});
		setIcon(button, icon);
		this.registerDomEvent(button, "click", onClick);
		return button;
	}

	// --- rendering ---

	/** Right-hand seek time counts down; empty duration shows a plain 0:00. */
	private setRemaining(position: number, duration: number): void {
		this.remainingEl.setText(
			duration > 0 ? `-${formatTime(duration - position)}` : "0:00"
		);
	}

	private render(state: Readonly<PlayerState>): void {
		// Radio streams override the chosen view with the radio visualizer; snap
		// back to the user's choice for library tracks. Re-evaluated here so a
		// track change (which emits state) switches the presentation automatically.
		const effective = this.effectiveNowPlayingView(state.track);
		if (effective !== this.nowPlayingView) {
			this.setEffectiveView(effective);
		}

		this.renderArt(state);

		this.titleEl.setText(state.track?.title ?? "Nothing playing");
		this.artistEl.setText(state.track?.artist ?? "");
		this.albumEl.setText(state.track?.album ?? "");
		this.artistEl.toggleClass("stereo-link", !!state.track?.artistId);
		this.albumEl.toggleClass("stereo-link", !!state.track?.albumId);

		setIcon(this.playButton, state.playing ? "pause" : "play");
		this.playButton.disabled = !state.track;
		this.miniTitleEl.setText(state.track?.title ?? "Nothing playing");
		this.miniArtistEl.setText(state.track?.artist ?? "");
		setIcon(this.miniPlayButton, state.playing ? "pause" : "play");
		this.miniPlayButton.disabled = !state.track;
		this.favoriteButton.disabled = !state.track || !!state.track.streamUrl;
		this.favoriteButton.toggleClass("stereo-button-active", !!state.track?.starred);
		this.favoriteButton.setAttribute(
			"aria-label",
			state.track?.starred ? "Remove from favorites" : "Add to favorites"
		);
		this.previousButton.disabled = !state.track;
		this.nextButton.disabled =
			!state.track || state.index + 1 >= state.queue.length;
		this.shuffleButton.disabled = state.queue.length < 2;
		this.stationButton.disabled = !state.track || !!state.track.streamUrl;
		this.stationButton.toggleClass("stereo-button-active", !!state.station);

		if (this.lyricsVisible) {
			if ((state.track?.id ?? null) !== this.lyricsLoadedFor) {
				void this.loadLyrics(state.track);
			} else {
				this.updateLyricsHighlight(state.position, false);
			}
		}

		this.queueTitleEl.setText(
			state.station ? `Station: ${state.station.label}` : "Queue"
		);
		this.moreButton.toggleClass("stereo-hidden", !state.station);

		this.seekSlider.max = String(Math.floor(state.duration));
		if (!this.seeking) {
			this.seekSlider.value = String(Math.floor(state.position));
			this.elapsedEl.setText(formatTime(state.position));
			this.setRemaining(state.position, state.duration);
		}

		this.volumeSlider.value = String(Math.round(state.volume * 100));

		this.errorEl.setText(state.error ?? "");
		this.errorEl.toggleClass("stereo-error-visible", state.error != null);

		this.artImg.toggleClass(
			"stereo-art-spinning",
			state.playing && this.nowPlayingView === "record"
		);

		// Rebuild the queue list only when the queue or current index changes —
		// render() fires on every timeupdate.
		if (state.queue !== this.renderedQueue || state.index !== this.renderedIndex) {
			this.renderedQueue = state.queue;
			this.renderedIndex = state.index;
			this.renderQueue(state);
		}
	}

	private renderArt(state: Readonly<PlayerState>): void {
		const coverArt = state.track?.coverArt ?? null;
		if (coverArt === this.renderedCoverArt) return;
		this.renderedCoverArt = coverArt;

		if (!coverArt) {
			this.artImg.addClass("stereo-hidden");
			this.artImg.removeAttribute("src");
			this.artPlaceholder.removeClass("stereo-hidden");
			this.miniThumbImg.addClass("stereo-hidden");
			this.miniThumbImg.removeAttribute("src");
			this.miniThumbPlaceholder.removeClass("stereo-hidden");
			this.viz.setCoverImage(null);
			return;
		}
		this.artImg.removeClass("stereo-hidden");
		this.artPlaceholder.addClass("stereo-hidden");
		this.artImg.src = this.plugin.client.coverArtUrl(coverArt, 600);
		// Feed the album-art bars view the same cover (masked, never read back).
		this.viz.setCoverImage(this.plugin.client.coverArtUrl(coverArt, 600));
		this.miniThumbImg.removeClass("stereo-hidden");
		this.miniThumbPlaceholder.addClass("stereo-hidden");
		this.miniThumbImg.src = this.plugin.client.coverArtUrl(coverArt, 120);
	}

	private renderQueue(state: Readonly<PlayerState>): void {
		this.queueList.empty();
		if (state.queue.length === 0) {
			this.queueList.createDiv({
				cls: "stereo-queue-empty",
				text: "The queue is empty.",
			});
			return;
		}
		state.queue.forEach((song, i) => {
			const row = this.queueList.createDiv({ cls: "stereo-queue-row" });
			row.toggleClass("stereo-queue-row-current", i === state.index);

			// Queue position (1-based) — not the album track number.
			row.createDiv({ cls: "stereo-queue-row-number", text: String(i + 1) });

			const meta = row.createDiv({ cls: "stereo-queue-row-meta" });
			meta.createDiv({ cls: "stereo-queue-row-title", text: song.title });
			meta.createDiv({ cls: "stereo-queue-row-artist", text: song.artist ?? "" });
			this.registerDomEvent(meta, "click", () => {
				void this.plugin.player.playAt(i);
			});

			const removeButton = row.createEl("button", {
				cls: "stereo-button clickable-icon stereo-queue-row-remove",
				attr: { "aria-label": "Remove from queue" },
			});
			setIcon(removeButton, "x");
			this.registerDomEvent(removeButton, "click", () => {
				void this.plugin.player.removeAt(i);
			});
		});
	}
}

function formatTime(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
