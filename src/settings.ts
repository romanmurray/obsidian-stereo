import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type StereoPlugin from "./main";
import { SubsonicError } from "./subsonic";

/** What left-clicking a track row in the library does. */
export type TrackClickAction = "play" | "addToQueue" | "none";

/** How the Now Playing screen presents the current track. */
export type NowPlayingView =
	| "record"
	| "square"
	| "bars"
	| "waveform"
	| "cover"
	| "radio"
	| "boombox"
	| "stereo";

/**
 * Which visualizer internet-radio streams show. Radio has no album art and
 * cannot be audio-analysed (streams are left un-captured, so the analyser stays
 * silent), so it overrides the chosen Now Playing view while a stream is the
 * source. "follow" keeps whatever the user picked. `radio` / `boombox` reuse the
 * matching NowPlayingView values so no mapping is needed.
 */
export type RadioVisualization = "radio" | "boombox" | "follow";

/** Horizontal alignment of the lyrics panel text. */
export type LyricsAlign = "left" | "center" | "right";

/** Options for the internet-radio visualization dropdown. */
export const RADIO_VISUALIZATIONS: {
	value: RadioVisualization;
	label: string;
}[] = [
	{ value: "radio", label: "Radio tower" },
	{ value: "boombox", label: "Portable radio (does not react on radio)" },
	{ value: "follow", label: "Follow my chosen view" },
];

/**
 * Single source of truth for the Now Playing presentation options. Both the
 * settings dropdown and the right-click menu are built from this list, and the
 * visualizer modes are a subset of it (see isVizView), so adding a new mode is
 * a one-line change here — it then appears in every picker automatically.
 * `icon` is a Lucide id used by the context menu.
 */
export const NOW_PLAYING_VIEWS: {
	value: NowPlayingView;
	label: string;
	icon: string;
}[] = [
	{ value: "square", label: "Album art", icon: "image" },
	{ value: "record", label: "Spinning record", icon: "disc-3" },
	{ value: "waveform", label: "Visualizer: waveform", icon: "audio-waveform" },
	{ value: "bars", label: "Visualizer: frequency bars", icon: "bar-chart-3" },
	{ value: "cover", label: "Visualizer: album bars", icon: "columns-3" },
	{ value: "boombox", label: "Visualizer: portable radio", icon: "radio" },
	{ value: "stereo", label: "Visualizer: boom box", icon: "boom-box" },
	{ value: "radio", label: "Visualizer: radio tower", icon: "radio-tower" },
];

export interface StereoSettings {
	serverUrl: string;
	username: string;
	password: string;
	trackClickAction: TrackClickAction;
	/** Report plays back to the server so play counts stay accurate. */
	scrobbleEnabled: boolean;
	/** Tracks added per station batch. */
	stationBatchSize: number;
	nowPlayingView: NowPlayingView;
	/** Which visualizer internet-radio streams show (overrides nowPlayingView). */
	radioVisualization: RadioVisualization;
	/** Look up lyrics on LRCLIB when the server has none. */
	lyricsOnlineLookup: boolean;
	lyricsFontSize: number;
	/** Scale the lyrics text with the panel size instead of the fixed px value. */
	lyricsAutoSize: boolean;
	/** Empty string means the theme's text font. */
	lyricsFontFamily: string;
	lyricsAlign: LyricsAlign;
	searchDebounceMs: number;
	searchArtistCount: number;
	searchAlbumCount: number;
	searchSongCount: number;
}

export const DEFAULT_SETTINGS: StereoSettings = {
	serverUrl: "",
	username: "",
	password: "",
	trackClickAction: "play",
	scrobbleEnabled: true,
	stationBatchSize: 30,
	nowPlayingView: "record",
	radioVisualization: "radio",
	lyricsOnlineLookup: true,
	lyricsFontSize: 16,
	lyricsAutoSize: false,
	lyricsFontFamily: "",
	lyricsAlign: "left",
	searchDebounceMs: 300,
	searchArtistCount: 4,
	searchAlbumCount: 4,
	searchSongCount: 10,
};

const SETTINGS_TABS = [
	{ id: "connection", label: "Connection" },
	{ id: "playback", label: "Playback" },
	{ id: "appearance", label: "Appearance" },
	{ id: "search", label: "Search" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

/** Search delay presets — users think in feel, not milliseconds. */
const SEARCH_SPEEDS: ReadonlyArray<{ ms: number; label: string }> = [
	{ ms: 100, label: "Instant" },
	{ ms: 200, label: "Fast" },
	{ ms: 300, label: "Normal" },
	{ ms: 500, label: "Relaxed" },
];

/** Suggestions for the lyrics font field; free text still accepts anything. */
const FONT_SUGGESTIONS = [
	"Inter",
	"Segoe UI",
	"Helvetica Neue",
	"Georgia",
	"Garamond",
	"Palatino",
	"Times New Roman",
	"JetBrains Mono",
	"Consolas",
];

type ConnectionState = "untested" | "testing" | "ok" | "error";

export class StereoSettingTab extends PluginSettingTab {
	plugin: StereoPlugin;
	private activeTab: SettingsTabId = "connection";

	private connectionState: ConnectionState = "untested";
	private connectionMessage = "Not tested yet.";
	private statusEl: HTMLElement | null = null;
	private autoTestTimer: number | null = null;

	constructor(app: App, plugin: StereoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("stereo-settings");
		this.statusEl = null;

		const tabBar = containerEl.createDiv({ cls: "stereo-settings-tabs" });
		for (const { id, label } of SETTINGS_TABS) {
			const button = tabBar.createEl("button", {
				cls: "stereo-settings-tab",
				text: label,
			});
			button.toggleClass("stereo-settings-tab-active", id === this.activeTab);
			button.addEventListener("click", () => {
				this.activeTab = id;
				this.display();
			});
		}

		const page = containerEl.createDiv({ cls: "stereo-settings-page" });
		switch (this.activeTab) {
			case "connection":
				this.displayConnection(page);
				break;
			case "playback":
				this.displayPlayback(page);
				break;
			case "appearance":
				this.displayAppearance(page);
				break;
			case "search":
				this.displaySearch(page);
				break;
		}
	}

	hide(): void {
		if (this.autoTestTimer !== null) {
			window.clearTimeout(this.autoTestTimer);
			this.autoTestTimer = null;
		}
	}

	/** A visually separated group of related settings with its own heading. */
	private section(containerEl: HTMLElement, name: string): HTMLElement {
		const section = containerEl.createDiv({ cls: "stereo-settings-section" });
		new Setting(section).setName(name).setHeading();
		return section;
	}

	// ------------------------------------------------------------------
	// Connection

	private displayConnection(containerEl: HTMLElement): void {
		const server = this.section(containerEl, "Server");

		new Setting(server)
			.setName("Server URL")
			.setDesc("Address of your Navidrome or Subsonic-compatible server.")
			.addText((text) =>
				text
					.setPlaceholder("https://music.example.com")
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim();
						await this.plugin.saveSettings();
						this.queueAutoTest();
					})
			);

		new Setting(server)
			.setName("Username")
			.setDesc("The account used to sign in.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.username)
					.onChange(async (value) => {
						this.plugin.settings.username = value.trim();
						await this.plugin.saveSettings();
						this.queueAutoTest();
					})
			);

		new Setting(server)
			.setName("Password")
			.setDesc(
				"Stored in plain text in this plugin's data file inside your vault."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.password).onChange(
					async (value) => {
						this.plugin.settings.password = value;
						await this.plugin.saveSettings();
						this.queueAutoTest();
					}
				);
			})
			.addExtraButton((button) => {
				button.setIcon("eye").setTooltip("Show password");
				button.onClick(() => {
					const input =
						button.extraSettingsEl.parentElement?.querySelector("input");
					if (!input) return;
					const reveal = input.type === "password";
					input.type = reveal ? "text" : "password";
					button.setIcon(reveal ? "eye-off" : "eye");
					button.setTooltip(reveal ? "Hide password" : "Show password");
				});
			});

		this.renderStatusRow(server);

		// A fresh look at the page gets a fresh answer, without button-pressing.
		if (this.hasCredentials() && this.connectionState === "untested") {
			void this.testConnection();
		}
	}

	private renderStatusRow(containerEl: HTMLElement): void {
		const row = containerEl.createDiv({ cls: "stereo-conn-status" });
		this.statusEl = row;

		const retest = createEl("button", {
			cls: "stereo-conn-retest",
			text: "Retest",
		});
		retest.addEventListener("click", () => void this.testConnection());

		this.updateStatusUi();
		row.appendChild(retest);
	}

	private updateStatusUi(): void {
		const row = this.statusEl;
		if (!row) return;

		const retest = row.querySelector(".stereo-conn-retest");
		row.empty();

		row.dataset.state = this.connectionState;
		const dot = row.createSpan({ cls: "stereo-conn-dot" });
		if (this.connectionState === "testing") setIcon(dot, "loader-2");
		row.createSpan({ cls: "stereo-conn-text", text: this.connectionMessage });
		if (retest) row.appendChild(retest);
	}

	private hasCredentials(): boolean {
		const { serverUrl, username, password } = this.plugin.settings;
		return !!(serverUrl && username && password);
	}

	/** Re-test shortly after the user stops editing credentials. */
	private queueAutoTest(): void {
		this.connectionState = "untested";
		this.connectionMessage = "Not tested yet.";
		this.updateStatusUi();
		if (this.autoTestTimer !== null) window.clearTimeout(this.autoTestTimer);
		if (!this.hasCredentials()) return;
		this.autoTestTimer = window.setTimeout(() => {
			this.autoTestTimer = null;
			void this.testConnection();
		}, 900);
	}

	private async testConnection(): Promise<void> {
		if (this.connectionState === "testing") return;
		if (!this.hasCredentials()) {
			this.connectionState = "error";
			this.connectionMessage =
				"Fill in the server URL, username, and password first.";
			this.updateStatusUi();
			return;
		}

		this.connectionState = "testing";
		this.connectionMessage = "Testing…";
		this.updateStatusUi();

		try {
			const info = await this.plugin.client.ping();
			const server = describeServer(info);
			this.connectionState = "ok";
			this.connectionMessage = `Connected to ${server} as ${this.plugin.settings.username}.`;
		} catch (error) {
			this.connectionState = "error";
			this.connectionMessage = describeConnectionError(
				error,
				this.plugin.settings.serverUrl
			);
		}
		this.updateStatusUi();
	}

	// ------------------------------------------------------------------
	// Playback

	private displayPlayback(containerEl: HTMLElement): void {
		const library = this.section(containerEl, "Library");

		const click = new Setting(library)
			.setName("Track click action")
			.setDesc(
				"What clicking a track does. Right-click always offers every action."
			);
		this.segmented(
			click,
			[
				{ value: "play", label: "Play" },
				{ value: "addToQueue", label: "Queue" },
				{ value: "none", label: "Nothing" },
			],
			() => this.plugin.settings.trackClickAction,
			async (value) => {
				this.plugin.settings.trackClickAction = value;
				await this.plugin.saveSettings();
			}
		);

		const serverSection = this.section(containerEl, "Server");

		new Setting(serverSection)
			.setName("Scrobble plays")
			.setDesc(
				"Report finished plays to the server so play counts and history stay accurate."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.scrobbleEnabled)
					.onChange(async (value) => {
						this.plugin.settings.scrobbleEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		const stations = this.section(containerEl, "Stations");

		const batch = new Setting(stations)
			.setName("Station batch size")
			.setDesc("Tracks added per station batch, including each More press.");
		this.stepper(
			batch,
			{ min: 10, max: 50, step: 5 },
			() => this.plugin.settings.stationBatchSize,
			async (value) => {
				this.plugin.settings.stationBatchSize = value;
				await this.plugin.saveSettings();
			}
		);
	}

	// ------------------------------------------------------------------
	// Appearance

	private displayAppearance(containerEl: HTMLElement): void {
		const nowPlaying = this.section(containerEl, "Now playing");

		new Setting(nowPlaying)
			.setName("Now playing view")
			.setDesc("How the current track is presented on the Now Playing screen.")
			.addDropdown((dropdown) => {
				for (const opt of NOW_PLAYING_VIEWS) dropdown.addOption(opt.value, opt.label);
				return dropdown
					.setValue(this.plugin.settings.nowPlayingView)
					.onChange(async (value) => {
						this.plugin.settings.nowPlayingView = value as NowPlayingView;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
					});
			});

		new Setting(nowPlaying)
			.setName("Internet-radio visualization")
			.setDesc(
				"What a radio stream shows instead of your chosen view. Radio has no album art and its audio can't be visualized, so the radio tower is the natural fit; the portable radio just idles."
			)
			.addDropdown((dropdown) => {
				for (const opt of RADIO_VISUALIZATIONS)
					dropdown.addOption(opt.value, opt.label);
				return dropdown
					.setValue(this.plugin.settings.radioVisualization)
					.onChange(async (value) => {
						this.plugin.settings.radioVisualization = value as RadioVisualization;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
					});
			});

		const lyrics = this.section(containerEl, "Lyrics");

		new Setting(lyrics)
			.setName("Look up lyrics online")
			.setDesc(
				"When your server has no lyrics for a track, ask the free LRCLIB database. Only the track's title, artist, album, and length are sent."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.lyricsOnlineLookup)
					.onChange(async (value) => {
						this.plugin.settings.lyricsOnlineLookup = value;
						await this.plugin.saveSettings();
					})
			);

		let preview: HTMLElement;
		const applyPreview = (): void => {
			preview.style.fontSize = `${this.plugin.settings.lyricsFontSize}px`;
			preview.style.fontFamily = this.plugin.settings.lyricsFontFamily || "";
			preview.style.textAlign = this.plugin.settings.lyricsAlign;
		};

		new Setting(lyrics)
			.setName("Auto-adjust size")
			.setDesc(
				"Scale the lyrics text with the panel size, the way the album art fills its space. When off, the fixed size below is used."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.lyricsAutoSize)
					.onChange(async (value) => {
						this.plugin.settings.lyricsAutoSize = value;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
					})
			);

		const size = new Setting(lyrics)
			.setName("Font size")
			.setDesc("Size of the lyrics text, in pixels. Used when auto-adjust is off.");
		this.stepper(
			size,
			{ min: 12, max: 28, step: 1 },
			() => this.plugin.settings.lyricsFontSize,
			async (value) => {
				this.plugin.settings.lyricsFontSize = value;
				await this.plugin.saveSettings();
				this.plugin.refreshNowPlayingViews();
				applyPreview();
			}
		);

		new Setting(lyrics)
			.setName("Font")
			.setDesc("Font family for the lyrics. Leave empty to use the theme font.")
			.addText((text) => {
				const listId = "stereo-font-suggestions";
				let datalist = document.getElementById(listId);
				if (!datalist) {
					datalist = createEl("datalist", { attr: { id: listId } });
					for (const font of FONT_SUGGESTIONS) {
						datalist.createEl("option", { attr: { value: font } });
					}
					text.inputEl.insertAdjacentElement("afterend", datalist);
				}
				text.inputEl.setAttr("list", listId);
				text
					.setPlaceholder("Theme font")
					.setValue(this.plugin.settings.lyricsFontFamily)
					.onChange(async (value) => {
						this.plugin.settings.lyricsFontFamily = value;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
						applyPreview();
					});
			});

		new Setting(lyrics)
			.setName("Alignment")
			.setDesc("How the lyrics text is aligned in the panel.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left")
					.addOption("center", "Centered")
					.addOption("right", "Right")
					.setValue(this.plugin.settings.lyricsAlign)
					.onChange(async (value) => {
						this.plugin.settings.lyricsAlign = value as LyricsAlign;
						await this.plugin.saveSettings();
						this.plugin.refreshNowPlayingViews();
						applyPreview();
					})
			);

		preview = lyrics.createDiv({ cls: "stereo-lyrics-preview" });
		preview.createDiv({ text: "So you go, and you stand on your own" });
		preview.createDiv({
			cls: "stereo-lyrics-preview-active",
			text: "And you leave on your own",
		});
		preview.createDiv({ text: "And you go home, and you cry" });
		applyPreview();
	}

	// ------------------------------------------------------------------
	// Search

	private displaySearch(containerEl: HTMLElement): void {
		const behavior = this.section(containerEl, "Behavior");

		new Setting(behavior)
			.setName("Search speed")
			.setDesc("How quickly results appear after you stop typing.")
			.addDropdown((dropdown) => {
				for (const { ms, label } of SEARCH_SPEEDS) {
					dropdown.addOption(String(ms), label);
				}
				dropdown
					.setValue(String(nearestSearchSpeed(this.plugin.settings.searchDebounceMs)))
					.onChange(async (value) => {
						this.plugin.settings.searchDebounceMs = Number(value);
						await this.plugin.saveSettings();
					});
			});

		const results = this.section(containerEl, "Results per group");
		this.countSetting(results, "Artists", "searchArtistCount");
		this.countSetting(results, "Albums", "searchAlbumCount");
		this.countSetting(results, "Tracks", "searchSongCount");
	}

	private countSetting(
		containerEl: HTMLElement,
		name: string,
		key: "searchArtistCount" | "searchAlbumCount" | "searchSongCount"
	): void {
		const setting = new Setting(containerEl).setName(name);
		this.stepper(
			setting,
			{ min: 1, max: 20, step: 1 },
			() => this.plugin.settings[key],
			async (value) => {
				this.plugin.settings[key] = value;
				await this.plugin.saveSettings();
			}
		);
	}

	// ------------------------------------------------------------------
	// Controls

	/** Connected buttons showing every choice at once; one is always active. */
	private segmented<T extends string>(
		setting: Setting,
		options: ReadonlyArray<{ value: T; label: string }>,
		get: () => T,
		set: (value: T) => Promise<void>
	): void {
		const group = setting.controlEl.createDiv({ cls: "stereo-segmented" });
		const buttons = new Map<T, HTMLButtonElement>();
		const refresh = (): void => {
			const active = get();
			for (const [value, button] of buttons) {
				button.toggleClass("stereo-segmented-active", value === active);
			}
		};
		for (const { value, label } of options) {
			const button = group.createEl("button", {
				cls: "stereo-segmented-option",
				text: label,
			});
			button.addEventListener("click", () => {
				void set(value).then(refresh);
			});
			buttons.set(value, button);
		}
		refresh();
	}

	/** Number field with −/+ buttons; typed values are clamped to the range. */
	private stepper(
		setting: Setting,
		range: { min: number; max: number; step: number },
		get: () => number,
		set: (value: number) => Promise<void>
	): void {
		const group = setting.controlEl.createDiv({ cls: "stereo-stepper" });

		const minus = group.createEl("button", { cls: "stereo-stepper-button" });
		setIcon(minus, "minus");
		const input = group.createEl("input", {
			cls: "stereo-stepper-input",
			attr: { type: "number", min: range.min, max: range.max },
		});
		input.value = String(get());
		const plus = group.createEl("button", { cls: "stereo-stepper-button" });
		setIcon(plus, "plus");

		const apply = (raw: number): void => {
			const value = Math.min(
				range.max,
				Math.max(range.min, Math.round(raw / range.step) * range.step)
			);
			input.value = String(value);
			minus.disabled = value <= range.min;
			plus.disabled = value >= range.max;
			if (value !== get()) void set(value);
		};

		minus.addEventListener("click", () => apply(get() - range.step));
		plus.addEventListener("click", () => apply(get() + range.step));
		input.addEventListener("change", () => {
			const raw = Number(input.value);
			apply(Number.isFinite(raw) ? raw : get());
		});
		apply(get());
	}
}

/** "Navidrome 0.52.5", "Gonic", or a generic fallback. */
function describeServer(info: { type?: string; version?: string }): string {
	if (!info.type) return "the server";
	const name = info.type.charAt(0).toUpperCase() + info.type.slice(1);
	return info.version ? `${name} ${info.version}` : name;
}

/** Snap an arbitrary stored delay to the nearest preset. */
function nearestSearchSpeed(ms: number): number {
	let best = SEARCH_SPEEDS[0]?.ms ?? 300;
	for (const { ms: preset } of SEARCH_SPEEDS) {
		if (Math.abs(preset - ms) < Math.abs(best - ms)) best = preset;
	}
	return best;
}

function describeConnectionError(error: unknown, serverUrl: string): string {
	if (error instanceof SubsonicError) {
		switch (error.kind) {
			case "config":
				return "Fill in the server URL, username, and password first.";
			case "auth":
				return "Server reached, but the username or password is wrong.";
			case "unreachable":
				if (serverUrl.startsWith("http://")) {
					return "Could not reach the server. If your server redirects to HTTPS, use an https:// URL here.";
				}
				return `Could not reach the server. Check the URL. (${error.message})`;
			case "server":
				return `The server returned an error: ${error.message}`;
		}
	}
	return "Connection test failed unexpectedly.";
}
