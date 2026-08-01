import { debounce, prepareFuzzySearch, setIcon } from "obsidian";
import type { LibraryPane } from "./library";
import type StereoPlugin from "./main";
import type { Album, Artist, Song } from "./subsonic";

/**
 * As-you-type search (PRD §5.5). The server's `search3` does substring
 * matching; results are re-ranked client-side with Obsidian's fuzzy matcher.
 * While a query is active the results panel replaces the tab pages
 * (`onActiveChange` toggles that in the view).
 */
export interface SearchPaneOptions {
	/** The view toggles the results panel / tab pages on this. */
	onActiveChange: (active: boolean) => void;
	/** Navigation targets — the view activates the Library tab first. */
	openArtist: (id: string, name: string) => void;
	openAlbum: (id: string, name: string) => void;
}

export class SearchPane {
	private plugin: StereoPlugin;
	private library: LibraryPane;
	private inputEl: HTMLInputElement;
	private resultsEl: HTMLElement;
	private options: SearchPaneOptions;
	private active = false;
	/** Bumped per query; stale responses are dropped. */
	private token = 0;
	private runDebounced: (query: string) => void;

	constructor(
		plugin: StereoPlugin,
		library: LibraryPane,
		inputEl: HTMLInputElement,
		resultsEl: HTMLElement,
		options: SearchPaneOptions
	) {
		this.plugin = plugin;
		this.library = library;
		this.inputEl = inputEl;
		this.resultsEl = resultsEl;
		this.options = options;
		this.runDebounced = debounce(
			(query: string) => void this.run(query),
			plugin.settings.searchDebounceMs,
			false
		);

		inputEl.addEventListener("input", () => {
			this.handleInput();
		});
		inputEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				// Escape closes the search only — keep it from reaching the app.
				event.stopPropagation();
				this.close();
			}
		});
	}

	/** Clear the query and return to the tab pages. */
	close(): void {
		this.token += 1;
		this.inputEl.value = "";
		this.setActive(false);
	}

	private handleInput(): void {
		const query = this.inputEl.value.trim();
		if (!query) {
			this.close();
			return;
		}
		if (!this.active) {
			this.setActive(true);
			this.status("Searching…");
		}
		this.runDebounced(query);
	}

	private setActive(active: boolean): void {
		if (this.active === active) return;
		this.active = active;
		this.options.onActiveChange(active);
	}

	private async run(query: string): Promise<void> {
		if (!this.active) return;
		const token = ++this.token;
		const { searchArtistCount, searchAlbumCount, searchSongCount } =
			this.plugin.settings;
		try {
			// Over-fetch so the fuzzy re-rank has a pool to choose from.
			const result = await this.plugin.client.search3(query, {
				artistCount: searchArtistCount * 2,
				albumCount: searchAlbumCount * 2,
				songCount: searchSongCount * 2,
			});
			if (token !== this.token) return;
			this.renderResults(query, {
				artists: rank(result.artists, (a) => a.name, query, searchArtistCount),
				albums: rank(result.albums, (a) => a.name, query, searchAlbumCount),
				songs: rank(result.songs, (s) => s.title, query, searchSongCount),
			});
		} catch {
			if (token !== this.token) return;
			this.status("Search failed. Check the connection in settings.");
		}
	}

	// --- rendering ---

	private status(text: string): void {
		this.resultsEl.empty();
		this.resultsEl.createDiv({ cls: "stereo-library-status", text });
	}

	private renderResults(
		query: string,
		groups: { artists: Artist[]; albums: Album[]; songs: Song[] }
	): void {
		this.resultsEl.empty();

		if (
			groups.artists.length === 0 &&
			groups.albums.length === 0 &&
			groups.songs.length === 0
		) {
			this.status(`No results for "${query}".`);
			return;
		}

		if (groups.artists.length > 0) {
			this.groupHeading("Artists");
			for (const artist of groups.artists) this.artistRow(artist);
		}
		if (groups.albums.length > 0) {
			this.groupHeading("Albums");
			for (const album of groups.albums) this.albumRow(album);
		}
		if (groups.songs.length > 0) {
			this.groupHeading("Tracks");
			for (const song of groups.songs) this.songRow(song);
		}
	}

	private groupHeading(text: string): void {
		this.resultsEl.createDiv({ cls: "stereo-index-letter", text });
	}

	private artistRow(artist: Artist): void {
		const row = this.resultsEl.createDiv({ cls: "stereo-list-row" });
		const icon = row.createSpan({ cls: "stereo-list-row-icon" });
		setIcon(icon, "user");
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: artist.name });
		row.addEventListener("click", () => {
			this.close();
			this.options.openArtist(artist.id, artist.name);
		});
		row.addEventListener("contextmenu", (event) => {
			this.library.showArtistMenu(event, artist);
		});
	}

	private albumRow(album: Album): void {
		const row = this.resultsEl.createDiv({ cls: "stereo-list-row" });
		this.thumb(row, album.coverArt);
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: album.name });
		meta.createDiv({ cls: "stereo-list-row-sub", text: album.artist ?? "" });
		row.addEventListener("click", () => {
			this.close();
			this.options.openAlbum(album.id, album.name);
		});
		row.addEventListener("contextmenu", (event) => {
			this.library.showAlbumMenu(event, album);
		});
	}

	private songRow(song: Song): void {
		const row = this.resultsEl.createDiv({ cls: "stereo-list-row" });
		this.thumb(row, song.coverArt);
		const meta = row.createDiv({ cls: "stereo-list-row-meta" });
		meta.createDiv({ cls: "stereo-list-row-title", text: song.title });
		meta.createDiv({ cls: "stereo-list-row-sub", text: song.artist ?? "" });
		row.addEventListener("click", () => {
			switch (this.plugin.settings.trackClickAction) {
				case "play":
					void this.plugin.player.playTrack(song);
					break;
				case "addToQueue":
					void this.plugin.player.addToQueue([song]);
					break;
				case "none":
					break;
			}
		});
		row.addEventListener("contextmenu", (event) => {
			this.library.showSongMenu(event, song);
		});
	}

	private thumb(row: HTMLElement, coverArt: string | undefined): void {
		if (coverArt) {
			row.createEl("img", {
				cls: "stereo-list-row-thumb",
				attr: {
					src: this.plugin.client.coverArtUrl(coverArt, 64),
					alt: "",
					loading: "lazy",
				},
			});
		} else {
			const placeholder = row.createSpan({
				cls: "stereo-list-row-thumb stereo-list-row-thumb-empty",
			});
			setIcon(placeholder, "music");
		}
	}
}

/** Fuzzy-rank server results; unmatched items sink but are not dropped. */
function rank<T>(
	items: T[],
	text: (item: T) => string,
	query: string,
	limit: number
): T[] {
	const fuzzy = prepareFuzzySearch(query);
	return items
		.map((item, order) => ({
			item,
			order,
			score: fuzzy(text(item))?.score ?? Number.NEGATIVE_INFINITY,
		}))
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.slice(0, limit)
		.map((entry) => entry.item);
}
