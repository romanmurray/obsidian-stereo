import { App, FuzzySuggestModal, Modal, Setting } from "obsidian";
import type { Playlist } from "./subsonic";

interface PlaylistNameOptions {
	title?: string;
	cta?: string;
	initial?: string;
}

/** Playlist name prompt: saving the queue, creating, and renaming. */
export class PlaylistNameModal extends Modal {
	private onSubmit: (name: string) => void;
	private name: string;
	private options: Required<PlaylistNameOptions>;

	constructor(
		app: App,
		onSubmit: (name: string) => void,
		options: PlaylistNameOptions = {}
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.options = {
			title: options.title ?? "Save queue as playlist",
			cta: options.cta ?? "Save",
			initial: options.initial ?? "",
		};
		this.name = this.options.initial;
	}

	onOpen(): void {
		this.setTitle(this.options.title);

		new Setting(this.contentEl).setName("Name").addText((text) => {
			text
				.setPlaceholder("Playlist name")
				.setValue(this.options.initial)
				.onChange((value) => {
					this.name = value.trim();
				});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					this.submit();
				}
			});
			text.inputEl.focus();
			text.inputEl.select();
		});

		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(this.options.cta)
				.setCta()
				.onClick(() => {
					this.submit();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (!this.name) return;
		this.close();
		this.onSubmit(this.name);
	}
}

export type PlaylistChoice =
	| { kind: "new" }
	| { kind: "existing"; playlist: Playlist };

/** Fuzzy picker over the user's playlists, with a "New playlist" entry. */
export class PlaylistPickerModal extends FuzzySuggestModal<PlaylistChoice> {
	private choices: PlaylistChoice[];
	private onPick: (choice: PlaylistChoice) => void;

	constructor(
		app: App,
		playlists: Playlist[],
		onPick: (choice: PlaylistChoice) => void
	) {
		super(app);
		this.setPlaceholder("Add to playlist…");
		this.choices = [
			{ kind: "new" },
			...playlists.map((playlist) => ({
				kind: "existing" as const,
				playlist,
			})),
		];
		this.onPick = onPick;
	}

	getItems(): PlaylistChoice[] {
		return this.choices;
	}

	getItemText(choice: PlaylistChoice): string {
		return choice.kind === "new" ? "New playlist…" : choice.playlist.name;
	}

	onChooseItem(choice: PlaylistChoice): void {
		this.onPick(choice);
	}
}

export interface RadioStationInput {
	name: string;
	streamUrl: string;
	homePageUrl?: string;
}

/** Add/edit form for a server-side radio station. */
export class RadioStationModal extends Modal {
	private onSubmit: (station: RadioStationInput) => void;
	private values: RadioStationInput;
	private isEdit: boolean;

	constructor(
		app: App,
		initial: RadioStationInput | null,
		onSubmit: (station: RadioStationInput) => void
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.isEdit = initial !== null;
		this.values = {
			name: initial?.name ?? "",
			streamUrl: initial?.streamUrl ?? "",
			homePageUrl: initial?.homePageUrl ?? "",
		};
	}

	onOpen(): void {
		this.setTitle(this.isEdit ? "Edit radio station" : "Add radio station");

		new Setting(this.contentEl).setName("Name").addText((text) => {
			text.setValue(this.values.name).onChange((value) => {
				this.values.name = value.trim();
			});
			text.inputEl.placeholder = "Station name";
			text.inputEl.focus();
		});

		new Setting(this.contentEl)
			.setName("Stream URL")
			.setDesc("Direct stream, or an .m3u/.pls playlist URL.")
			.addText((text) => {
				text.setValue(this.values.streamUrl).onChange((value) => {
					this.values.streamUrl = value.trim();
				});
				text.inputEl.placeholder = "https://…";
			});

		new Setting(this.contentEl)
			.setName("Homepage")
			.setDesc("Optional.")
			.addText((text) => {
				text.setValue(this.values.homePageUrl ?? "").onChange((value) => {
					this.values.homePageUrl = value.trim();
				});
				text.inputEl.placeholder = "https://…";
			});

		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(this.isEdit ? "Save" : "Add")
				.setCta()
				.onClick(() => {
					this.submit();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private submit(): void {
		if (!this.values.name || !this.values.streamUrl) return;
		if (!/^https?:\/\//i.test(this.values.streamUrl)) return;
		this.close();
		this.onSubmit({
			name: this.values.name,
			streamUrl: this.values.streamUrl,
			homePageUrl: this.values.homePageUrl || undefined,
		});
	}
}

/** Danger confirm used before destructive server-side actions. */
export class ConfirmModal extends Modal {
	private message: string;
	private confirmLabel: string;
	private onConfirm: () => void;

	constructor(
		app: App,
		title: string,
		message: string,
		confirmLabel: string,
		onConfirm: () => void
	) {
		super(app);
		this.setTitle(title);
		this.message = message;
		this.confirmLabel = confirmLabel;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				})
			)
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setWarning()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
