// Run through Obsidian CLI eval in the dev vault; requires an in-memory backup.
// Does not print settings, credentials or authenticated URLs.
(async () => {
	const p = app.plugins.plugins.stereo;
	if (!window.stereoHistoryBackup) throw new Error("Back up Stereo data before running live checks.");
	const check = (condition, message) => { if (!condition) throw new Error(message); };
	const waitFor = async (predicate) => {
		const deadline = Date.now() + 20000;
		while (!predicate()) {
			if (Date.now() > deadline) throw new Error("Timed out waiting for playback");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	};
	p.settings.scrobbleEnabled = false;
	await p.saveSettings();
	p.player.setVolume(0);
	p.player.history.clear();
	const songs = await p.client.getRandomSongs(3);
	check(songs.length >= 2, "Need two live tracks");
	window.stereoHistorySongs = songs;
	await p.activateView();
	const view = app.workspace.getLeavesOfType("stereo-player")[0].view;
	view.setActiveTab("library");
	view.contentEl.querySelector('[aria-label="Recently played"]').click();
	check(view.contentEl.textContent.includes("No recently played tracks"), "Missing empty state");
	await p.player.setQueue([songs[0], songs[1], songs[0]]);
	await waitFor(() => p.player.history.getEntries().length === 1);
	check(view.contentEl.querySelectorAll(".stereo-history-row").length === 1, "List did not update on start");
	await p.player.togglePlayPause();
	await p.player.togglePlayPause();
	p.player.seek(4);
	await new Promise((resolve) => setTimeout(resolve, 600));
	check(p.player.history.getEntries().length === 1, "Resume or seek duplicated history");
	await p.player.playAt(2);
	await waitFor(() => p.player.history.getEntries().length === 2);
	while (p.player.getState().repeat !== "track") p.player.cycleRepeat();
	p.player.seek(p.player.getState().duration - 1);
	await waitFor(() => p.player.history.getEntries().length === 3);
	check(p.player.getState().index === 2, "Repeat lost duplicate occurrence");
	while (p.player.getState().repeat !== "off") p.player.cycleRepeat();
	view.contentEl.querySelector('[data-history-action="append"]').click();
	check(p.player.getState().queue.length === 4, "Add to queue failed");
	view.contentEl.querySelector('[data-history-action="play"]').click();
	await waitFor(() => p.player.history.getEntries().length === 4);
	check(p.player.getState().canUndo, "History replay did not capture undo");
	await p.player.togglePlayPause();
	await p.pendingSave;
	const saved = await p.loadData();
	check(saved.history.entries.length === 4, "History was not saved");
	return JSON.stringify({ passed: ["empty state", "real song start", "pause/resume", "seek", "duplicate replay", "natural repeat", "add to queue", "play again with undo", "persistence"], rows: 4 });
})()
