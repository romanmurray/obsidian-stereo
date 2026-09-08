import {
	App,
	PluginSettingTab,
	Setting,
	setIcon,
	type SettingDefinitionItem,
} from "obsidian";
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

/** Native-control keys whose change must repaint open Now Playing views. */
const VIEW_REFRESH_KEYS = new Set<string>([
	"nowPlayingView",
	"radioVisualization",
	"lyricsAutoSize",
	"lyricsAlign",
]);

export class StereoSettingTab extends PluginSettingTab {
	plugin: StereoPlugin;

	private connectionState: ConnectionState = "untested";
	private connectionMessage = "Not tested yet.";
	private statusEl: HTMLElement | null = null;
	private autoTestTimer: number | null = null;
	/** Set while the lyrics preview row is mounted; restyles it in place. */
	private applyLyricsPreview: (() => void) | null = null;

	constructor(app: App, plugin: StereoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.icon = "boom-box";
		this.containerEl.addClass("stereo-settings");
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Server",
				items: [
					{
						name: "Server URL",
						desc: "Address of your Navidrome or Subsonic-compatible server.",
						render: (setting) =>
							this.renderConnectionField(setting, "serverUrl", "https://music.example.com"),
					},
					{
						name: "Username",
						desc: "The account used to sign in.",
						render: (setting) => this.renderConnectionField(setting, "username"),
					},
					{
						name: "Password",
						desc: "Stored in plain text in this plugin's data file inside your vault.",
						render: (setting) => this.renderPassword(setting),
					},
					{
						name: "Connection status",
						searchable: false,
						render: (setting) => this.renderStatus(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Library",
				items: [
					{
						name: "Track click action",
						desc: "What clicking a track does. Right-click always offers every action.",
						render: (setting) =>
							this.segmented(
								setting,
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
							),
					},
				],
			},
			{
				type: "group",
				heading: "Playback",
				items: [
					{
						name: "Scrobble plays",
						desc: "Report finished plays to the server so play counts and history stay accurate.",
						control: { type: "toggle", key: "scrobbleEnabled" },
					},
					{
						name: "Station batch size",
						desc: "Tracks added per station batch, including each More press.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 10, max: 50, step: 5 },
								() => this.plugin.settings.stationBatchSize,
								async (value) => {
									this.plugin.settings.stationBatchSize = value;
									await this.plugin.saveSettings();
								}
							),
					},
				],
			},
			{
				type: "group",
				heading: "Now playing",
				items: [
					{
						name: "Now playing view",
						desc: "How the current track is presented on the Now Playing screen.",
						control: {
							type: "dropdown",
							key: "nowPlayingView",
							options: Object.fromEntries(
								NOW_PLAYING_VIEWS.map((opt) => [opt.value, opt.label])
							),
						},
					},
					{
						name: "Internet-radio visualization",
						desc: "What a radio stream shows instead of your chosen view. Radio has no album art and its audio can't be visualized, so the radio tower is the natural fit; the portable radio just idles.",
						control: {
							type: "dropdown",
							key: "radioVisualization",
							options: Object.fromEntries(
								RADIO_VISUALIZATIONS.map((opt) => [opt.value, opt.label])
							),
						},
					},
				],
			},
			{
				type: "group",
				heading: "Lyrics",
				items: [
					{
						name: "Look up lyrics online",
						desc: "When your server has no lyrics for a track, ask the free LRCLIB database. Only the track's title, artist, album, and length are sent.",
						control: { type: "toggle", key: "lyricsOnlineLookup" },
					},
					{
						name: "Auto-adjust size",
						desc: "Scale the lyrics text with the panel size, the way the album art fills its space. When off, the fixed size below is used.",
						control: { type: "toggle", key: "lyricsAutoSize" },
					},
					{
						name: "Font size",
						desc: "Size of the lyrics text, in pixels. Used when auto-adjust is off.",
						render: (setting) =>
							this.stepper(
								setting,
								{ min: 12, max: 28, step: 1 },
								() => this.plugin.settings.lyricsFontSize,
								async (value) => {
									this.plugin.settings.lyricsFontSize = value;
									await this.plugin.saveSettings();
									this.plugin.refreshNowPlayingViews();
									this.applyLyricsPreview?.();
								}
							),
					},
					{
						name: "Font",
						desc: "Font family for the lyrics. Leave empty to use the theme font.",
						render: (setting) => this.renderFontField(setting),
					},
					{
						name: "Alignment",
						desc: "How the lyrics text is aligned in the panel.",
						control: {
							type: "dropdown",
							key: "lyricsAlign",
							options: { left: "Left", center: "Centered", right: "Right" },
						},
					},
					{
						name: "",
						searchable: false,
						render: (setting) => this.renderLyricsPreview(setting),
					},
				],
			},
			{
				type: "group",
				heading: "Search",
				items: [
					{
						name: "Search speed",
						desc: "How quickly results appear after you stop typing.",
						control: {
							type: "dropdown",
							key: "searchDebounceMs",
							options: Object.fromEntries(
								SEARCH_SPEEDS.map(({ ms, label }) => [String(ms), label])
							),
						},
					},
					{
						name: "Artists",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchArtistCount"),
					},
					{
						name: "Albums",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchAlbumCount"),
					},
					{
						name: "Tracks",
						desc: "Search results shown for this group.",
						render: (setting) => this.countStepper(setting, "searchSongCount"),
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		// The speed dropdown deals in preset strings; the stored value is ms.
		if (key === "searchDebounceMs") {
			return String(nearestSearchSpeed(this.plugin.settings.searchDebounceMs));
		}
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key === "searchDebounceMs") value = Number(value);
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		if (VIEW_REFRESH_KEYS.has(key)) this.plugin.refreshNowPlayingViews();
		if (key === "lyricsAlign") this.applyLyricsPreview?.();
	}

	hide(): void {
		if (this.autoTestTimer !== null) {
			window.clearTimeout(this.autoTestTimer);
			this.autoTestTimer = null;
		}
		// Closing settings with a connection field still focused ends the edit too.
		void this.plugin.commitConnection();
	}

	// ------------------------------------------------------------------
	// Connection

	/** Server URL and username save as typed, but the account switch (which
	 * clears the old account's history and queue) waits until the field is left. */
	private renderConnectionField(
		setting: Setting,
		key: "serverUrl" | "username",
		placeholder = ""
	): void {
		setting.addText((text) => {
			text
				.setPlaceholder(placeholder)
				.setValue(this.plugin.settings[key])
				.onChange(async (value) => {
					this.plugin.settings[key] = value.trim();
					await this.plugin.saveSettings();
					this.queueAutoTest();
				});
			text.inputEl.addEventListener("blur", () => {
				void this.plugin.commitConnection();
			});
		});
	}

	/** Masked text field with an eye toggle; the declarative controls have no
	 * password type, so this row stays imperative. */
	private renderPassword(setting: Setting): void {
		setting
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
	}

	/** Live status dot + message + retest, in place of a normal setting row. */
	private renderStatus(setting: Setting): () => void {
		setting.settingEl.empty();
		const row = setting.settingEl.createDiv({ cls: "stereo-conn-status" });
		this.statusEl = row;

		const retest = createEl("button", {
			cls: "stereo-conn-retest",
			text: "Retest",
		});
		retest.addEventListener("click", () => void this.testConnection());

		this.updateStatusUi();
		row.appendChild(retest);

		// A fresh look at the page gets a fresh answer, without button-pressing.
		if (this.hasCredentials() && this.connectionState === "untested") {
			void this.testConnection();
		}

		return () => {
			if (this.statusEl === row) this.statusEl = null;
		};
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
	// Appearance

	/** Free-text font field with a datalist of suggestions. */
	private renderFontField(setting: Setting): void {
		setting.addText((text) => {
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
					this.applyLyricsPreview?.();
				});
		});
	}

	/** Three sample lines styled live by the size / font / alignment values. */
	private renderLyricsPreview(setting: Setting): () => void {
		setting.settingEl.empty();
		const preview = setting.settingEl.createDiv({
			cls: "stereo-lyrics-preview",
		});
		preview.createDiv({ text: "So you go, and you stand on your own" });
		preview.createDiv({
			cls: "stereo-lyrics-preview-active",
			text: "And you leave on your own",
		});
		preview.createDiv({ text: "And you go home, and you cry" });

		const apply = (): void => {
			preview.style.fontSize = `${this.plugin.settings.lyricsFontSize}px`;
			preview.style.fontFamily = this.plugin.settings.lyricsFontFamily || "";
			preview.style.textAlign = this.plugin.settings.lyricsAlign;
		};
		this.applyLyricsPreview = apply;
		apply();

		return () => {
			if (this.applyLyricsPreview === apply) this.applyLyricsPreview = null;
		};
	}

	// ------------------------------------------------------------------
	// Search

	private countStepper(
		setting: Setting,
		key: "searchArtistCount" | "searchAlbumCount" | "searchSongCount"
	): void {
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
