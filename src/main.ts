import { Notice, Plugin, WorkspaceLeaf, debounce } from "obsidian";
import { PlayerSnapshot, PlayerStore } from "./player";
import { DEFAULT_SETTINGS, StereoSettings, StereoSettingTab } from "./settings";
import type { StationSeed } from "./station";
import { Song, SubsonicClient } from "./subsonic";
import { STEREO_VIEW_TYPE, StereoView } from "./view";

interface StereoData {
	settings: StereoSettings;
	playerState?: PlayerSnapshot;
}

export default class StereoPlugin extends Plugin {
	settings: StereoSettings = { ...DEFAULT_SETTINGS };
	client: SubsonicClient = new SubsonicClient(() => this.settings);
	player: PlayerStore = new PlayerStore(this.client, () => this.settings);

	private playerState: PlayerSnapshot | undefined;
	private savePlayerState = debounce(
		(snapshot: PlayerSnapshot) => {
			this.playerState = snapshot;
			void this.saveAll();
		},
		1000,
		true
	);

	async onload(): Promise<void> {
		await this.loadDataFile();

		if (this.playerState) {
			this.player.restore(this.playerState);
		}
		this.player.setPersistence((snapshot) => this.savePlayerState(snapshot));

		this.registerView(STEREO_VIEW_TYPE, (leaf) => new StereoView(leaf, this));
		this.addSettingTab(new StereoSettingTab(this.app, this));

		this.addRibbonIcon("boom-box", "Open Stereo", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-player",
			name: "Open player",
			callback: () => {
				void this.activateView();
			},
		});
	}

	onunload(): void {
		// Per Obsidian guidelines: do not detach leaves of our view type here.
		// Registered events/DOM listeners are cleaned up automatically.
		this.player.destroy();
	}

	/**
	 * Toggle a song's favorite flag on the server and mirror it into the play
	 * queue. Returns the new `starred` value so callers can update their own
	 * copies. Throws on server failure.
	 */
	async toggleSongFavorite(song: Song): Promise<string | undefined> {
		const starred = song.starred ? undefined : new Date().toISOString();
		if (song.starred) {
			await this.client.unstar({ id: song.id });
		} else {
			await this.client.star({ id: song.id });
		}
		this.player.updateSong(song.id, { starred });
		return starred;
	}

	/**
	 * Start a station and report the outcome — the shared entry point for the
	 * player button and the context menus. `lead` is the seeded track when the
	 * seed is a song; it plays first (or keeps playing, if it already is).
	 */
	async startStation(seed: StationSeed, lead?: Song): Promise<void> {
		try {
			const queued = await this.player.startStation(seed, lead);
			if (queued === 0) {
				new Notice("The server had no tracks to build this station from.");
				return;
			}
			new Notice(`Station started: ${seed.label}`);
		} catch {
			new Notice("Could not build the station from the server.");
		}
	}

	/** Re-apply the Now Playing view choice to open players (settings change). */
	refreshNowPlayingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(STEREO_VIEW_TYPE)) {
			if (leaf.view instanceof StereoView) leaf.view.applyNowPlayingView();
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(STEREO_VIEW_TYPE)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: STEREO_VIEW_TYPE, active: true });
		}

		await workspace.revealLeaf(leaf);
	}

	private async loadDataFile(): Promise<void> {
		const raw = (await this.loadData()) as
			| (Partial<StereoData> & Partial<StereoSettings>)
			| null;
		if (!raw) return;

		// Current shape: { settings, playerState }. Legacy shape: flat settings.
		const settings = raw.settings ?? raw;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.playerState = raw.playerState;
	}

	async saveSettings(): Promise<void> {
		await this.saveAll();
	}

	private async saveAll(): Promise<void> {
		const data: StereoData = {
			settings: this.settings,
			playerState: this.playerState,
		};
		await this.saveData(data);
	}
}
