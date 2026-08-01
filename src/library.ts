import { Menu, Notice, requestUrl, setIcon } from "obsidian";
import {
	ConfirmModal,
	PlaylistNameModal,
	PlaylistPickerModal,
	RadioStationModal,
} from "./modals";
import { SubsonicError } from "./subsonic";
import type StereoPlugin from "./main";
import type {
	Album,
	Artist,
	ArtistIndex,
	Playlist,
	RadioStation,
	Song,
} from "./subsonic";

type SubTab = "albums" | "artists" | "playlists" | "radio";

type Page =
	| { kind: "root" }
	| { kind: "artist"; id: string; name: string }
	| { kind: "album"; id: string; name: string }
	| { kind: "playlist"; id: string; name: string }
	| { kind: "favorites" };

const SUB_TABS: { id: SubTab; label: string }[] = [
	{ id: "albums", label: "Albums" },
	{ id: "artists", label: "Artists" },
	{ id: "playlists", label: "Playlists" },
	{ id: "radio", label: "Radio" },
];

const ALBUM_PAGE_SIZE = 100;

/**
 * Library tab: sub-tabs (Albums / Artists / Playlists / Radio), drill-in
 * navigation, and context menus. Interaction conventions per PRD §5.1:
 * left-clicking an artist/album/playlist navigates into it; playback is
 * always explicit (play button, track click per setting, or context menu).
 */
export class LibraryPane {
	private plugin: StereoPlugin;
	private subTabButtons = {} as Record<SubTab, HTMLButtonElement>;
	/** "+" in the sub-tab bar; only shown on the Radio sub-tab. */
	private addStationButton!: HTMLButtonElement;
	/** Heart in the sub-tab bar; accent-highlighted while Favorites is open. */
	private favoritesButton!: HTMLButtonElement;
	private bodyEl: HTMLElement;
	private contentEl: HTMLElement;
	/** Alphabet rail overlaying the artists list; exists only on that page. */
	private scrubEl: HTMLElement | null = null;
	private activeSubTab: SubTab = "albums";
	private stack: Page[] = [{ kind: "root" }];
	/** Bumped per render; async loaders bail if a newer render started. */
	private loadToken = 0;

	// Root-list caches so sub-tab flips don't refetch. Refresh clears them.
	private albums: Album[] | null = null;
	private albumsExhausted = false;
	private artistIndexes: ArtistIndex[] | null = null;
	private playlists: Playlist[] | null = null;
	private stations: RadioStation[] | null = null;

	constructor(plugin: StereoPlugin, containerEl: HTMLElement) {
		this.plugin = plugin;

		// The sub-tab bar stays put; only the content below it scrolls.
		const subTabBar = containerEl.createDiv({ cls: "stereo-subtabs" });
		for (const { id, label } of SUB_TABS) {
			const button = subTabBar.createEl("button", {
				cls: "stereo-subtab clickable-icon",
				text: label,
			});
			button.addEventListener("click", () => {
				this.setSubTab(id);
			});
			this.subTabButtons[id] = button;
		}
		this.favoritesButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Favorites" },
		});
		setIcon(this.favoritesButton, "heart");
		this.favoritesButton.addEventListener("click", () => {
			this.openFavorites();
		});
		this.addStationButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Add radio station" },
		});
		setIcon(this.addStationButton, "plus");
		this.addStationButton.addEventListener("click", () => {
			this.addStation();
		});
		const refreshButton = subTabBar.createEl("button", {
			cls: "stereo-button clickable-icon stereo-subtab-refresh",
			attr: { "aria-label": "Refresh" },
		});
		setIcon(refreshButton, "refresh-cw");
		refreshButton.addEventListener("click", () => {
			this.refresh();
		});

		// The body hosts the scrolling content plus the (non-scrolling) scrub rail.
		this.bodyEl = containerEl.createDiv({ cls: "stereo-library-body" });
		this.contentEl = this.bodyEl.createDiv({ cls: "stereo-library-content" });
		this.render();
	}

	// --- external navigation (Now Playing links, context menus) ---

	openArtist(id: string, name: string): void {
		this.activeSubTab = "artists";
		this.stack = [{ kind: "root" }, { kind: "artist", id, name }];
		this.render();
	}

	openAlbum(id: string, name: string): void {
		this.activeSubTab = "albums";
		this.stack = [{ kind: "root" }, { kind: "album", id, name }];
		this.render();
	}

	/** Drop the cached playlist list (e.g. after saving the queue as one). */
	invalidatePlaylists(): void {
		this.playlists = null;
		const page = this.stack[this.stack.length - 1];
		if (this.activeSubTab === "playlists" && page?.kind === "root") {
			this.render();
		}
	}

	// --- navigation internals ---

	private setSubTab(tab: SubTab): void {
		this.activeSubTab = tab;
		this.stack = [{ kind: "root" }];
		this.render();
	}

	private push(page: Page): void {
		this.stack.push(page);
		this.render();
	}

	private back(): void {
		if (this.stack.length > 1) this.stack.pop();
		this.render();
	}

	private refresh(): void {
		switch (this.activeSubTab) {
			case "albums":
				this.albums = null;
				this.albumsExhausted = false;
				break;
			case "artists":
				this.artistIndexes = null;
				break;
			case "playlists":
				this.playlists = null;
				break;
			case "radio":
				this.stations = null;
				break;
		}
		this.render();
	}

	// --- rendering ---

	private render(): void {
		this.loadToken += 1;
		for (const { id } of SUB_TABS) {
			this.subTabButtons[id].toggleClass(
				"stereo-subtab-active",
				id === this.activeSubTab
			);
		}
		this.addStationButton.toggleClass(
			"stereo-hidden",
			this.activeSubTab !== "radio"
		);
		this.scrubEl?.remove();
		this.scrubEl = null;
		this.contentEl.removeClass("stereo-has-scrub");
		this.contentEl.empty();
		this.contentEl.scrollTop = 0;

		const page = this.stack[this.stack.length - 1] ?? { kind: "root" as const };
		this.favoritesButton.toggleClass(
			"stereo-button-active",
			page.kind === "favorites"
		);
		if (page.kind !== "root") this.buildBackRow(this.pageTitle(page));

		switch (page.kind) {
			case "root":
				this.renderRoot();
				break;
			case "artist":
				void this.renderArtistPage(page.id);
				break;
			case "album":
				void this.renderAlbumPage(page.id);
				break;
			case "playlist":
				void this.renderPlaylistPage(page.id);
				break;
			case "favorites":
				void this.renderFavoritesPage();
				break;
		}
	}

	/** Heart in the sub-tab bar: one page for all favorites, every kind. */
	private openFavorites(): void {
		const top = this.stack[this.stack.length - 1];
		// Already there — re-render so the list reflects fresh toggles.
		if (top?.kind === "favorites") {
			this.render();
			return;
		}
		this.push({ kind: "favorites" });
	}

	private pageTitle(page: Page): string {
		if (page.kind === "root") return "";
		if (page.kind === "favorites") return "Favorites";
		return page.name;
	}

	private buildBackRow(title: string): void {
		const row = this.contentEl.createDiv({ cls: "stereo-back-row" });
		const backButton = row.createEl("button", {
			cls: "stereo-button clickable-icon",
			attr: { "aria-label": "Back" },
		});
		setIcon(backButton, "chevron-left");
		backButton.addEventListener("click", () => {
			this.back();
		});
		row.createSpan({ cls: "stereo-back-title", text: title });
	}

	private renderRoot(): void {
		switch (this.activeSubTab) {
			case "albums":
				void this.renderAlbumsRoot();
				break;
			case "artists":
				void this.renderArtistsRoot();
				break;
			case "playlists":
				void this.renderPlaylistsRoot();
				break;
			case "radio":
				void this.renderRadioRoot();
				break;
		}
	}

	/** Run a loader with loading/error affordances; returns null when stale. */
	private async load<T>(fetcher: () => Promise<T>): Promise<T | null> {
		const token = this.loadToken;
		const loadingEl = this.contentEl.createDiv({
			cls: "stereo-library-status",
			text: "Loading…",
		});
		try {
			const result = await fetcher();
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			return result;
		} catch {
			if (token !== this.loadToken) return null;
			loadingEl.remove();
			const errorEl = this.contentEl.createDiv({ cls: "stereo-library-status" });
			errorEl.createSpan({ text: "Could not load from the server. " });
			const retry = errorEl.createEl("a", { text: "Retry" });
			retry.addEventListener("click", () => {
				this.render();
			});
			return null;
		}
	}

	// --- root lists ---

	private async renderAlbumsRoot(): Promise<void> {
		if (!this.albums) {
			const page = await this.load(() =>
				this.plugin.client.getAlbumList2("alphabeticalByName", ALBUM_PAGE_SIZE, 0)
			);
			if (!page) return;
			this.albums = page;
			this.albumsExhausted = page.length < ALBUM_PAGE_SIZE;
		}

		const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
		for (const album of this.albums) this.albumCard(grid, album);

		if (!this.albumsExhausted) {
			const moreRow = this.contentEl.createDiv({ cls: "stereo-more-row" });
			const moreButton = moreRow.createEl("button", {
				cls: "stereo-button stereo-text-button clickable-icon",
				text: "Load more",
			});
			const loadMore = async (): Promise<void> => {
				moreButton.disabled = true;
				const token = this.loadToken;
				try {
					const next = await this.plugin.client.getAlbumList2(
						"alphabeticalByName",
						ALBUM_PAGE_SIZE,
						this.albums?.length ?? 0
					);
					if (token !== this.loadToken || !this.albums) return;
					this.albums = [...this.albums, ...next];
					this.albumsExhausted = next.length < ALBUM_PAGE_SIZE;
					this.render();
				} catch {
					if (token !== this.loadToken) return;
					moreButton.disabled = false;
					new Notice("Could not load more albums.");
				}
			};
			moreButton.addEventListener("click", () => {
				void loadMore();
			});
		}
	}

	private async renderArtistsRoot(): Promise<void> {
		if (!this.artistIndexes) {
			const indexes = await this.load(() => this.plugin.client.getArtists());
			if (!indexes) return;
			this.artistIndexes = indexes;
		}

		if (this.artistIndexes.length === 0) {
			this.emptyStatus("No artists found.");
			return;
		}
		const headings = new Map<string, HTMLElement>();
		for (const group of this.artistIndexes) {
			const heading = this.contentEl.createDiv({
				cls: "stereo-index-letter",
				text: group.name,
			});
			headings.set(group.name, heading);
			for (const artist of group.artist) this.artistRow(artist);
		}
		this.buildScrubber(
			this.artistIndexes.map((group) => group.name),
			headings
		);
	}

	/**
	 * Alphabet rail on the right edge of the artists list. Works like a
	 * scrollbar: click or drag along it and the list jumps to that letter; the
	 * letter under the pointer grows slightly while scrubbing.
	 */
	private buildScrubber(letters: string[], headings: Map<string, HTMLElement>): void {
		if (letters.length < 2) return;
		this.contentEl.addClass("stereo-has-scrub");
		const rail = this.bodyEl.createDiv({ cls: "stereo-scrub" });
		this.scrubEl = rail;
		// Multi-character group names (e.g. "[Unknown]") get a compact glyph.
		const letterEls = letters.map((letter) =>
			rail.createDiv({
				cls: "stereo-scrub-letter",
				text: letter.length === 1 ? letter : "•",
			})
		);

		const clearActive = () => {
			for (const el of letterEls) el.removeClass("stereo-scrub-letter-active");
		};
		const scrubTo = (clientY: number) => {
			// Hit-test the letter glyphs themselves. The letters are centered
			// inside the rail, so mapping the pointer as a fraction of the rail's
			// height picks the wrong letter — the glyph under the cursor is the
			// only measurement that is always aligned with what the user sees.
			let index = -1;
			let bestDistance = Number.POSITIVE_INFINITY;
			letterEls.forEach((el, i) => {
				const rect = el.getBoundingClientRect();
				const distance =
					clientY < rect.top
						? rect.top - clientY
						: clientY > rect.bottom
							? clientY - rect.bottom
							: 0;
				if (distance < bestDistance) {
					bestDistance = distance;
					index = i;
				}
			});
			if (index < 0) return;
			letterEls.forEach((el, i) => {
				el.toggleClass("stereo-scrub-letter-active", i === index);
			});
			const heading = headings.get(letters[index] as string);
			if (heading) this.contentEl.scrollTop = heading.offsetTop;
		};

		rail.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			try {
				rail.setPointerCapture(event.pointerId);
			} catch {
				// Capture is best-effort; scrubbing still works without it.
			}
			scrubTo(event.clientY);
		});
		rail.addEventListener("pointermove", (event) => {
			if (event.buttons === 0) return;
			scrubTo(event.clientY);
		});
		rail.addEventListener("pointerup", clearActive);
		rail.addEventListener("pointercancel", clearActive);
	}

	private async renderPlaylistsRoot(): Promise<void> {
		if (!this.playlists) {
			const playlists = await this.load(() => this.plugin.client.getPlaylists());
			if (!playlists) return;
			this.playlists = playlists;
		}

		if (this.playlists.length === 0) {
			this.emptyStatus("No playlists yet.");
			return;
		}
		for (const playlist of this.playlists) this.playlistRow(playlist);
	}

	private async renderRadioRoot(): Promise<void> {
		if (!this.stations) {
			const stations = await this.load(() =>
				this.plugin.client.getInternetRadioStations()
			);
			if (!stations) return;
			this.stations = stations;
		}

		if (this.stations.length === 0) {
			this.emptyStatus("No radio stations yet — add one with the + button above.");
			return;
		}
		for (const station of this.stations) this.radioRow(station);
	}

	/** All favorites on one page: artists, then albums, then tracks. */
	private async renderFavoritesPage(): Promise<void> {
		const result = await this.load(() => this.plugin.client.getStarred2());
		if (!result) return;
		const { artists, albums, songs } = result;

		if (artists.length === 0 && albums.length === 0 && songs.length === 0) {
			this.emptyStatus(
				"No favorites yet — use the heart on tracks, albums, and artists."
			);
			return;
		}

		if (artists.length > 0) {
			this.sectionHeading("Artists");
			for (const artist of artists) this.artistRow(artist);
		}
		if (albums.length > 0) {
			this.sectionHeading("Albums");
			const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
			for (const album of albums) this.albumCard(grid, album);
		}
		if (songs.length > 0) {
			this.sectionHeading("Tracks");
			const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
			songs.forEach((_, i) => {
				this.trackRow(list, songs, i, { showNumber: false, hideArtist: false });
			});
		}
	}

	private sectionHeading(text: string): void {
		this.contentEl.createDiv({ cls: "stereo-section-heading", text });
	}

	// --- detail pages ---

	private async renderArtistPage(id: string): Promise<void> {
		const result = await this.load(() => this.plugin.client.getArtist(id));
		if (!result) return;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		header.createDiv({ cls: "stereo-detail-title", text: result.artist.name });
		header.createDiv({
			cls: "stereo-detail-meta",
			text: albumCountLabel(result.albums.length),
		});
		const actions = header.createDiv({ cls: "stereo-detail-actions" });
		this.heartButton(
			actions,
			() => !!result.artist.starred,
			() => this.toggleArtistFavorite(result.artist)
		);

		const grid = this.contentEl.createDiv({ cls: "stereo-grid" });
		for (const album of result.albums) this.albumCard(grid, album, true);
	}

	private async renderAlbumPage(id: string): Promise<void> {
		const result = await this.load(() => this.plugin.client.getAlbum(id));
		if (!result) return;
		const { album, songs } = result;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		if (album.coverArt) {
			header.createEl("img", {
				cls: "stereo-detail-cover",
				attr: {
					src: this.plugin.client.coverArtUrl(album.coverArt, 300),
					alt: "Album cover",
				},
			});
		}
		const headerText = header.createDiv({ cls: "stereo-detail-text" });
		headerText.createDiv({ cls: "stereo-detail-title", text: album.name });
		const artistLine = headerText.createDiv({
			cls: "stereo-detail-meta",
			text: album.artist ?? "",
		});
		if (album.artistId) {
			artistLine.addClass("stereo-link");
			artistLine.addEventListener("click", () => {
				this.openArtist(album.artistId as string, album.artist ?? "");
			});
		}
		const metaParts: string[] = [];
		if (album.year) metaParts.push(String(album.year));
		metaParts.push(songCountLabel(songs.length));
		headerText.createDiv({ cls: "stereo-detail-meta", text: metaParts.join(" · ") });

		const playRow = headerText.createDiv({ cls: "stereo-detail-actions" });
		const playButton = playRow.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Play",
		});
		playButton.addEventListener("click", () => {
			void this.plugin.player.setQueue(songs, 0);
		});
		this.heartButton(
			playRow,
			() => !!album.starred,
			() => this.toggleAlbumFavorite(album)
		);

		const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
		songs.forEach((song, i) => {
			this.trackRow(list, songs, i, { showNumber: true, hideArtist: true });
		});
	}

	private async renderPlaylistPage(id: string): Promise<void> {
		const result = await this.load(() => this.plugin.client.getPlaylist(id));
		if (!result) return;
		const { playlist, songs } = result;

		const header = this.contentEl.createDiv({ cls: "stereo-detail-header" });
		const headerText = header.createDiv({ cls: "stereo-detail-text" });
		headerText.createDiv({ cls: "stereo-detail-title", text: playlist.name });
		headerText.createDiv({
			cls: "stereo-detail-meta",
			text: songCountLabel(songs.length),
		});
		const playRow = headerText.createDiv({ cls: "stereo-detail-actions" });
		const playButton = playRow.createEl("button", {
			cls: "stereo-button stereo-text-button clickable-icon",
			text: "Play",
		});
		playButton.addEventListener("click", () => {
			void this.plugin.player.setQueue(songs, 0);
		});

		if (songs.length === 0) {
			this.emptyStatus("This playlist is empty.");
			return;
		}
		const list = this.contentEl.createDiv({ cls: "stereo-track-list" });
		songs.forEach((song, i) => {
			this.trackRow(list, songs, i, {
				showNumber: false,
				hideArtist: false,
				removeFromPlaylist: (index) => {
					void this.managePlaylist("Removed from playlist.", () =>
						this.plugin.client.updatePlaylist(playlist.id, {
							removeIndexes: [index],
						})
					).then((ok) => {
						// Rebuild the page so row indexes match the server again.
						if (ok) this.render();
					});
				},
			});
		});
	}

	// --- favorites plumbing (shared by detail-page hearts and context menus) ---

	/** Heart toggle for detail-page headers; keeps its own filled state fresh. */
	private heartButton(
		parent: HTMLElement,
		isStarred: () => boolean,
		toggle: () => Promise<void>
	): void {
		const button = parent.createEl("button", {
			cls: "stereo-button clickable-icon",
		});
		setIcon(button, "heart");
		const sync = () => {
			button.toggleClass("stereo-button-active", isStarred());
			button.setAttribute(
				"aria-label",
				isStarred() ? "Remove from favorites" : "Add to favorites"
			);
		};
		sync();
		button.addEventListener("click", () => {
			void toggle()
				.catch(() => {
					new Notice("Could not update favorites on the server.");
				})
				.finally(() => {
					sync();
				});
		});
	}

	private async toggleAlbumFavorite(album: Album): Promise<void> {
		if (album.starred) {
			await this.plugin.client.unstar({ albumId: album.id });
			album.starred = undefined;
		} else {
			await this.plugin.client.star({ albumId: album.id });
			album.starred = new Date().toISOString();
		}
	}

	private async toggleArtistFavorite(artist: Artist): Promise<void> {
		if (artist.starred) {
			await this.plugin.client.unstar({ artistId: artist.id });
			artist.starred = undefined;
		} else {
			await this.plugin.client.star({ artistId: artist.id });
			artist.starred = new Date().toISOString();
		}
	}

	// --- row/card builders ---

	private albumCard(grid: HTMLElement, album: Album, hideArtist = false): void {
		const card = grid.createDiv({ cls: "stereo-card" });
		if (album.coverArt) {
			card.createEl("img", {
				cls: "stereo-card-cover",
				attr: {
					src: this.plugin.client.coverArtUrl(album.coverArt, 300),
					alt: "",
					loading: "lazy",
				},
			});
		} else {
			const placeholder = card.createDiv({ cls: "stereo-card-cover stereo-card-cover-empty" });
			setIcon(placeholder, "music");
		}
		card.createDiv({ cls: "stereo-card-title", text: album.name });
		if (!hideArtist) {
			card.createDiv({ cls: "stereo-card-artist", text: album.artist ?? "" });
		}

		card.addEventListener("click", () => {
			this.push({ kind: "album", id: album.id, name: album.name });
		});
		card.addEventListener("contextmenu", (event) => {
			this.showAlbumMenu(event, album);
		});
	}

	private artistRow(artist: Artist): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: artist.name });
		meta.createDiv({
			cls: "stereo-list-row-sub",
			text: albumCountLabel(artist.albumCount ?? 0),
		});
		row.addEventListener("click", () => {
			this.push({ kind: "artist", id: artist.id, name: artist.name });
		});
		row.addEventListener("contextmenu", (event) => {
			this.showArtistMenu(event, artist);
		});
	}

	private playlistRow(playlist: Playlist): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: playlist.name });
		meta.createDiv({
			cls: "stereo-list-row-sub",
			text: songCountLabel(playlist.songCount ?? 0),
		});
		row.addEventListener("click", () => {
			this.push({ kind: "playlist", id: playlist.id, name: playlist.name });
		});
		row.addEventListener("contextmenu", (event) => {
			this.showPlaylistMenu(event, playlist);
		});
	}

	private radioRow(station: RadioStation): void {
		const row = this.contentEl.createDiv({ cls: "stereo-list-row" });
		const icon = row.createSpan({ cls: "stereo-list-row-icon" });
		setIcon(icon, "radio");
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: station.name });
		// Radio is click-to-play (PRD §5.4) — a station has nothing to drill into.
		row.addEventListener("click", () => {
			void this.playStation(station);
		});
		row.addEventListener("contextmenu", (event) => {
			this.showRadioMenu(event, station);
		});
	}

	private trackRow(
		list: HTMLElement,
		songs: Song[],
		index: number,
		options: {
			showNumber: boolean;
			hideArtist: boolean;
			/** Present on playlist pages: removes this row from the playlist. */
			removeFromPlaylist?: (index: number) => void;
		}
	): void {
		const song = songs[index] as Song;
		const row = list.createDiv({ cls: "stereo-list-row" });
		if (options.showNumber) {
			row.createSpan({
				cls: "stereo-list-row-number",
				text: String(song.track ?? index + 1),
			});
		}
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: song.title });
		if (!options.hideArtist) {
			meta.createDiv({ cls: "stereo-list-row-sub", text: song.artist ?? "" });
		}
		if (song.duration) {
			row.createSpan({
				cls: "stereo-list-row-duration",
				text: formatDuration(song.duration),
			});
		}

		row.addEventListener("click", () => {
			switch (this.plugin.settings.trackClickAction) {
				case "play":
					void this.plugin.player.setQueue([...songs], index);
					break;
				case "addToQueue":
					void this.plugin.player.addToQueue([song]);
					break;
				case "none":
					break;
			}
		});
		row.addEventListener("contextmenu", (event) => {
			const remove = options.removeFromPlaylist;
			this.showSongMenu(
				event,
				song,
				remove ? { removeFromPlaylist: () => remove(index) } : undefined
			);
		});
	}

	private emptyStatus(text: string): void {
		this.contentEl.createDiv({ cls: "stereo-library-status", text });
	}

	// --- context menus (PRD §5.1) — public: search results reuse them ---

	showSongMenu(
		event: MouseEvent,
		song: Song,
		context?: { removeFromPlaylist?: () => void }
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.plugin.player.playTrack(song);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				this.plugin.player.playNext([song]);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.plugin.player.addToQueue([song]);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation(
					{ kind: "song", id: song.id, label: song.title, genre: song.genre },
					song
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to playlist…").setIcon("list-music").onClick(() => {
				void this.addToPlaylist([song]);
			})
		);
		if (context?.removeFromPlaylist) {
			const remove = context.removeFromPlaylist;
			menu.addItem((item) =>
				item
					.setTitle("Remove from playlist")
					.setIcon("list-x")
					.onClick(() => {
						remove();
					})
			);
		}
		if (song.artistId || song.albumId) menu.addSeparator();
		if (song.artistId) {
			menu.addItem((item) =>
				item.setTitle("Go to artist").setIcon("user").onClick(() => {
					this.openArtist(song.artistId as string, song.artist ?? "");
				})
			);
		}
		if (song.albumId) {
			menu.addItem((item) =>
				item.setTitle("Go to album").setIcon("disc").onClick(() => {
					this.openAlbum(song.albumId as string, song.album ?? "");
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(song.starred ? "Remove from favorites" : "Add to favorites")
				.setIcon("heart")
				.onClick(async () => {
					try {
						song.starred = await this.plugin.toggleSongFavorite(song);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	showAlbumMenu(event: MouseEvent, album: Album): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.withAlbumSongs(album, (songs) =>
					this.plugin.player.setQueue(songs, 0)
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				void this.withAlbumSongs(album, (songs) => {
					this.plugin.player.playNext(songs);
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.withAlbumSongs(album, (songs) =>
					this.plugin.player.addToQueue(songs)
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation({
					kind: "album",
					id: album.id,
					label: album.name,
					genre: album.genre,
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to playlist…").setIcon("list-music").onClick(() => {
				void this.withAlbumSongs(album, (songs) => this.addToPlaylist(songs));
			})
		);
		if (album.artistId) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Go to artist").setIcon("user").onClick(() => {
					this.openArtist(album.artistId as string, album.artist ?? "");
				})
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(album.starred ? "Remove from favorites" : "Add to favorites")
				.setIcon("heart")
				.onClick(async () => {
					try {
						await this.toggleAlbumFavorite(album);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	showArtistMenu(event: MouseEvent, artist: Artist): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Start station").setIcon("disc-3").onClick(() => {
				void this.plugin.startStation({
					kind: "artist",
					id: artist.id,
					label: artist.name,
				});
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(artist.starred ? "Remove from favorites" : "Add to favorites")
				.setIcon("heart")
				.onClick(async () => {
					try {
						await this.toggleArtistFavorite(artist);
					} catch {
						new Notice("Could not update favorites on the server.");
					}
				})
		);
		menu.showAtMouseEvent(event);
	}

	private showPlaylistMenu(event: MouseEvent, playlist: Playlist): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) =>
					this.plugin.player.setQueue(songs, 0)
				);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Play next").setIcon("corner-down-right").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) => {
					this.plugin.player.playNext(songs);
				});
			})
		);
		menu.addItem((item) =>
			item.setTitle("Add to queue").setIcon("list-plus").onClick(() => {
				void this.withPlaylistSongs(playlist, (songs) =>
					this.plugin.player.addToQueue(songs)
				);
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Rename…").setIcon("pencil").onClick(() => {
				new PlaylistNameModal(
					this.plugin.app,
					(name) => {
						void this.managePlaylist(`Renamed to "${name}".`, () =>
							this.plugin.client.updatePlaylist(playlist.id, { name })
						);
					},
					{ title: "Rename playlist", cta: "Rename", initial: playlist.name }
				).open();
			})
		);
		menu.addItem((item) =>
			item.setTitle("Delete playlist").setIcon("trash-2").onClick(() => {
				new ConfirmModal(
					this.plugin.app,
					"Delete playlist",
					`Delete "${playlist.name}" from the server?`,
					"Delete",
					() => {
						void this.managePlaylist(`Deleted "${playlist.name}".`, () =>
							this.plugin.client.deletePlaylist(playlist.id)
						);
					}
				).open();
			})
		);
		menu.showAtMouseEvent(event);
	}

	private showRadioMenu(event: MouseEvent, station: RadioStation): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle("Play").setIcon("play").onClick(() => {
				void this.playStation(station);
			})
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Edit station…").setIcon("pencil").onClick(() => {
				new RadioStationModal(this.plugin.app, station, (input) => {
					void this.manageStation("update", () =>
						this.plugin.client.updateInternetRadioStation(
							station.id,
							input.name,
							input.streamUrl,
							input.homePageUrl
						)
					);
				}).open();
			})
		);
		menu.addItem((item) =>
			item.setTitle("Remove station").setIcon("trash-2").onClick(() => {
				new ConfirmModal(
					this.plugin.app,
					"Remove radio station",
					`Remove "${station.name}" from the server?`,
					"Remove",
					() => {
						void this.manageStation("remove", () =>
							this.plugin.client.deleteInternetRadioStation(station.id)
						);
					}
				).open();
			})
		);
		menu.showAtMouseEvent(event);
	}

	private addStation(): void {
		new RadioStationModal(this.plugin.app, null, (input) => {
			void this.manageStation("add", () =>
				this.plugin.client.createInternetRadioStation(
					input.name,
					input.streamUrl,
					input.homePageUrl
				)
			);
		}).open();
	}

	/** Run a station write against the server, then refresh the radio list. */
	private async manageStation(
		verb: "add" | "update" | "remove",
		action: () => Promise<void>
	): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (error instanceof SubsonicError && error.code === 50) {
				new Notice("Your account is not allowed to manage radio stations.");
			} else {
				new Notice(`Could not ${verb} the radio station on the server.`);
			}
			return;
		}
		this.stations = null;
		if (this.activeSubTab === "radio") this.render();
	}

	private async withAlbumSongs(
		album: Album,
		action: (songs: Song[]) => void | Promise<void>
	): Promise<void> {
		try {
			const { songs } = await this.plugin.client.getAlbum(album.id);
			if (songs.length === 0) {
				new Notice("This album has no tracks.");
				return;
			}
			await action(songs);
		} catch {
			new Notice("Could not load the album from the server.");
		}
	}

	private async playStation(station: RadioStation): Promise<void> {
		let streamUrl: string;
		try {
			streamUrl = await resolveStreamUrl(station.streamUrl);
		} catch {
			new Notice("Could not resolve this station's stream URL.");
			return;
		}
		await this.plugin.player.playTrack({ ...radioSong(station), streamUrl });
	}

	/** "Add to playlist…" flow shared by the song and album menus. */
	private async addToPlaylist(songs: Song[]): Promise<void> {
		let playlists: Playlist[];
		try {
			playlists = await this.plugin.client.getPlaylists();
		} catch {
			new Notice("Could not load playlists from the server.");
			return;
		}
		const ids = songs.map((song) => song.id);
		const added = `Added ${songs.length === 1 ? "1 track" : `${songs.length} tracks`}`;
		new PlaylistPickerModal(this.plugin.app, playlists, (choice) => {
			if (choice.kind === "new") {
				new PlaylistNameModal(
					this.plugin.app,
					(name) => {
						void this.managePlaylist(`${added} to "${name}".`, () =>
							this.plugin.client.createPlaylist(name, ids)
						);
					},
					{ title: "New playlist", cta: "Create" }
				).open();
				return;
			}
			void this.managePlaylist(`${added} to "${choice.playlist.name}".`, () =>
				this.plugin.client.updatePlaylist(choice.playlist.id, {
					addSongIds: ids,
				})
			);
		}).open();
	}

	/** Run a playlist write against the server, then refresh cached lists. */
	private async managePlaylist(
		successNotice: string,
		action: () => Promise<void>
	): Promise<boolean> {
		try {
			await action();
		} catch {
			new Notice("Could not update the playlist on the server.");
			return false;
		}
		new Notice(successNotice);
		this.invalidatePlaylists();
		return true;
	}

	private async withPlaylistSongs(
		playlist: Playlist,
		action: (songs: Song[]) => void | Promise<void>
	): Promise<void> {
		try {
			const { songs } = await this.plugin.client.getPlaylist(playlist.id);
			if (songs.length === 0) {
				new Notice("This playlist is empty.");
				return;
			}
			await action(songs);
		} catch {
			new Notice("Could not load the playlist from the server.");
		}
	}
}

/**
 * Stations are often configured with a `.m3u`/`.pls` playlist URL rather than
 * the stream itself, which `<audio>` cannot play. Fetch the playlist (via
 * `requestUrl`, which is CORS-exempt) and extract the first stream entry.
 * `.m3u8` (HLS) is deliberately excluded — Chromium has no native HLS support.
 */
async function resolveStreamUrl(url: string): Promise<string> {
	const path = (url.split("?")[0] ?? url).toLowerCase();
	if (!path.endsWith(".m3u") && !path.endsWith(".pls")) return url;

	const response = await requestUrl({ url });
	for (const raw of response.text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("[")) continue;
		// PLS entries look like `File1=http://…`; M3U lines are bare URLs.
		const candidate = /^file\d*=/i.test(line)
			? line.slice(line.indexOf("=") + 1).trim()
			: line;
		if (/^https?:\/\//i.test(candidate)) return candidate;
	}
	throw new Error("The playlist contained no stream URL.");
}

/** Represent a radio station as a queue entry with a direct stream URL. */
function radioSong(station: RadioStation): Song {
	return {
		id: `radio-${station.id}`,
		title: station.name,
		artist: "Internet radio",
		streamUrl: station.streamUrl,
	};
}

function albumCountLabel(count: number): string {
	return count === 1 ? "1 album" : `${count} albums`;
}

function songCountLabel(count: number): string {
	return count === 1 ? "1 track" : `${count} tracks`;
}

function formatDuration(totalSeconds: number): string {
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
}
