import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

// Compile the source in memory; no runtime dependencies or checked-in bundles.
const result = await build({
	entryPoints: ["src/player.ts"], bundle: true, write: false, format: "esm", platform: "node",
});
const { PlayerStore } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

class FakeAudio extends EventTarget {
	static instances = [];
	_src = "";
	currentTime = 0;
	duration = 240;
	paused = true;
	assignments = 0;
	loads = 0;
	playError = null;
	playPromise = null;
	constructor() { super(); FakeAudio.instances.push(this); }
	get src() { return this._src; }
	set src(value) { this._src = value; this.assignments++; this.currentTime = 0; this.paused = true; }
	load() { this.loads++; this.currentTime = 0; }
	removeAttribute(name) { if (name === "src") this._src = ""; }
	async play() {
		if (this.playError) throw this.playError;
		if (this.playPromise) return this.playPromise;
		this.paused = false;
		this.dispatchEvent(new Event("play"));
		this.dispatchEvent(new Event("playing"));
	}
	pause() {
		if (this.paused) return;
		this.paused = true;
		this.dispatchEvent(new Event("pause"));
	}
	metadata() { this.dispatchEvent(new Event("loadedmetadata")); }
	tick(seconds) { this.currentTime = seconds; this.dispatchEvent(new Event("timeupdate")); }
}
globalThis.Audio = FakeAudio;

const song = (id) => ({ id, title: id, artistId: id, duration: 240 });
const a = song("a"), b = song("b"), c = song("c"), d = song("d");
const seed = { kind: "song", id: "a", label: "A station" };
function setup(t) {
	const client = {
		streamUrl: (id) => `https://music.invalid/${id}`,
		getSimilarSongs: async () => [b, c, d],
		getRandomSongs: async () => [],
		scrobble: async () => {},
	};
	const store = new PlayerStore(client, () => ({ scrobbleEnabled: false, stationBatchSize: 5 }));
	const audio = FakeAudio.instances.at(-1);
	const saved = [];
	store.setPersistence((snapshot) => saved.push(structuredClone(snapshot)));
	t.after(() => store.destroy());
	return { store, audio, client, saved };
}

test("every reorder preserves the selected occurrence, audio, position, and persisted index", async (t) => {
	for (const paused of [false, true]) {
		for (let current = 0; current < 4; current++) {
			for (let from = 0; from < 4; from++) {
				for (let to = 0; to < 4; to++) {
					const { store, audio, saved } = setup(t);
					// The exact same object occurs twice; identity and song ID are insufficient.
					await store.setQueue([a, b, a, c], current);
					audio.tick(37);
					if (paused) await store.togglePlayPause();
					const assignments = audio.assignments, loads = audio.loads;
					const labels = ["a-first", "b", "a-second", "c"];
					const selected = labels[current];
					labels.splice(to, 0, labels.splice(from, 1)[0]);
					store.moveQueueEntry(from, to);
					const state = store.getState();
					assert.equal(labels[state.index], selected);
					assert.equal(state.track, [a, b, a, c][current]);
					assert.equal(state.queue[state.index], state.track);
					assert.equal(state.position, 37);
					assert.equal(state.playing, !paused);
					assert.equal(audio.currentTime, 37);
					assert.equal(audio.assignments, assignments);
					assert.equal(audio.loads, loads);
					assert.deepEqual(saved.at(-1).queue, state.queue);
					assert.equal(saved.at(-1).index, state.index);
				}
			}
		}
	}
});

test("reorder refreshes prefetch and survives restart without an undo snapshot", async (t) => {
	const { store, audio, saved } = setup(t);
	await store.setQueue([a, b, c]);
	audio.tick(31);
	store.moveQueueEntry(2, 1);
	assert.equal(FakeAudio.instances.at(-1).src, "https://music.invalid/c");
	const restored = setup(t);
	restored.store.restore(saved.at(-1));
	assert.deepEqual(restored.store.getState().queue, [a, c, b]);
	assert.equal(restored.store.getState().position, 31);
	assert.equal(restored.store.getState().canUndo, false);
	assert.equal(restored.audio.src, "");
});

test("move to next handles entries before and after current, and disables no-ops", async (t) => {
	const { store } = setup(t);
	await store.setQueue([a, b, a, c, d], 2);
	for (const index of [-1, 2, 3, 5, NaN]) assert.equal(store.canMoveToNext(index), false);
	store.moveToNext(0);
	assert.deepEqual(store.getState().queue, [b, a, a, c, d]);
	assert.equal(store.getState().index, 1);
	store.moveToNext(4);
	assert.deepEqual(store.getState().queue, [b, a, d, a, c]);
	assert.equal(store.getState().index, 1);
	store.clearQueue();
	store.playNext([a, b]);
	assert.equal(store.canMoveToNext(0), false);
});

for (const paused of [false, true]) {
	test(`clear then undo restores duplicates, position, and ${paused ? "paused" : "playing"} state`, async (t) => {
		const { store, audio, saved } = setup(t);
		await store.setQueue([a, b, a, c], 2);
		audio.tick(43);
		if (paused) await store.togglePlayPause();
		store.clearQueue();
		assert.equal(store.getState().canUndo, true);
		assert.equal(store.getState().track, null);
		assert.equal(audio.src, "");
		store.setVolume(0.2);
		await store.undoQueue();
		assert.deepEqual(store.getState().queue, [a, b, a, c]);
		assert.equal(store.getState().index, 2);
		assert.equal(store.getState().position, 43);
		assert.equal(store.getState().playing, !paused);
		assert.equal(store.getState().volume, 0.2);
		assert.equal(store.getState().canUndo, false);
		// Early timeupdate from source reset must not erase the pending restore seek.
		audio.tick(0);
		assert.equal(store.getState().position, 43);
		audio.metadata();
		assert.equal(audio.currentTime, 43);
		assert.deepEqual(saved.at(-1).queue, [a, b, a, c]);
		assert.equal(saved.at(-1).position, 43);
		assert.equal("canUndo" in saved.at(-1), false);
		await store.undoQueue();
		assert.equal(store.getState().index, 2);
	});
}

test("the latest replacement supersedes undo; progression and view subscriptions preserve it", async (t) => {
	const { store, audio } = setup(t);
	await store.playTrack(a);
	await store.setQueue([b, c]);
	audio.tick(29);
	await store.setQueue([c, d]);
	await store.next();
	await store.togglePlayPause();
	await store.togglePlayPause();
	const closeView = store.subscribe(() => {});
	closeView();
	let canUndo;
	store.subscribe((state) => { canUndo = state.canUndo; })();
	assert.equal(canUndo, true);
	await store.undoQueue();
	assert.deepEqual(store.getState().queue, [b, c]);
	assert.equal(store.getState().position, 29);
});

test("empty, invalid and unchanged queue actions retain useful undo", async (t) => {
	const { store, client } = setup(t);
	await store.setQueue([a, b]);
	store.clearQueue();
	store.clearQueue();
	await store.setQueue([]);
	await store.addToQueue([]);
	store.playNext([]);
	await store.removeAt(0);
	store.moveQueueEntry(0, 0);
	store.shuffleQueue();
	client.getSimilarSongs = async () => [];
	assert.equal(await store.startStation(seed), 0);
	assert.equal(store.getState().canUndo, true);
	await store.setQueue([c, d]); // Replacement of an empty queue retains the saved clear.
	store.moveQueueEntry(0, 0);
	store.moveQueueEntry(NaN, 1);
	store.moveToNext(1);
	store.shuffleQueue(); // Two entries with current first cannot change order.
	await store.undoQueue();
	assert.deepEqual(store.getState().queue, [a, b]);
});

for (const [name, edit] of [
	["append", (store) => store.addToQueue([d])],
	["play next", (store) => store.playNext([d])],
	["remove", (store) => store.removeAt(2)],
	["reorder", (store) => store.moveQueueEntry(0, 2)],
	["move to next", (store) => store.moveToNext(0)],
	["shuffle", (store) => store.shuffleQueue()],
]) {
	test(`${name} invalidates undo after an explicit queue edit`, async (t) => {
		const { store } = setup(t);
		await store.playTrack(d);
		await store.setQueue([a, b, c], 1);
		assert.equal(store.getState().canUndo, true);
		await edit(store);
		assert.equal(store.getState().canUndo, false);
	});
}

test("removing the last entry never creates a clear-queue undo", async (t) => {
	const { store } = setup(t);
	await store.playTrack(a);
	await store.playTrack(b);
	await store.removeAt(0);
	assert.equal(store.getState().queue.length, 0);
	assert.equal(store.getState().canUndo, false);
});

test("station replacement preserves a playing lead and undo restores the previous station", async (t) => {
	const { store, audio } = setup(t);
	await store.startStation(seed, a);
	audio.tick(56);
	const original = store.getState().queue;
	const assignments = audio.assignments;
	await store.startStation({ ...seed, label: "Another station" }, a);
	assert.equal(audio.assignments, assignments);
	assert.equal(store.getState().position, 56);
	await store.undoQueue();
	assert.deepEqual(store.getState().queue, original);
	assert.deepEqual(store.getState().station, seed);
	assert.equal(store.getState().position, 56);
	await store.playTrack(d);
	await store.undoQueue();
	assert.deepEqual(store.getState().station, seed);
});

test("station More invalidates undo only when it adds tracks, and ignores a replaced station", async (t) => {
	const { store, client } = setup(t);
	await store.playTrack(a);
	await store.startStation(seed);
	assert.equal(await store.extendStation(), 0);
	assert.equal(store.getState().canUndo, true);
	client.getSimilarSongs = async () => [song("new")];
	assert.equal(await store.extendStation(), 1);
	assert.equal(store.getState().canUndo, false);
	let resolve;
	client.getSimilarSongs = () => new Promise((done) => { resolve = done; });
	const extension = store.extendStation();
	await store.playTrack(d);
	resolve([song("late")]);
	assert.equal(await extension, 0);
	assert.deepEqual(store.getState().queue, [d]);
	assert.equal(store.getState().canUndo, true);
});

test("unavailable-track undo reports normal playback errors, persists the restored queue, and consumes undo", async (t) => {
	const { store, audio, saved } = setup(t);
	await store.playTrack(a);
	audio.tick(44);
	await store.playTrack(b);
	audio.playError = new Error("Track unavailable");
	await store.undoQueue();
	assert.equal(store.getState().error, "Track unavailable");
	assert.equal(store.getState().playing, false);
	assert.equal(store.getState().canUndo, false);
	assert.deepEqual(saved.at(-1).queue, [a]);
	assert.equal(saved.at(-1).position, 44);
	audio.playError = null;
	await store.playTrack(c);
	assert.equal(store.getState().error, null);
});

test("paused restoration reports media errors and stream configuration failures", async (t) => {
	const { store, audio, client } = setup(t);
	await store.playTrack(a);
	await store.togglePlayPause();
	store.clearQueue();
	await store.undoQueue();
	audio.dispatchEvent(new Event("error"));
	assert.equal(store.getState().error, "Could not play this track.");
	store.clearQueue();
	client.streamUrl = () => { throw new Error("Configure the server"); };
	await store.undoQueue();
	assert.equal(store.getState().error, "Configure the server");
	assert.equal(store.getState().playing, false);
});

test("a stale play rejection cannot overwrite playback restored by undo", async (t) => {
	const { store, audio } = setup(t);
	await store.playTrack(a);
	let reject;
	audio.playPromise = new Promise((_, fail) => { reject = fail; });
	const replacement = store.playTrack(b);
	audio.playPromise = null;
	await store.undoQueue();
	reject(new Error("Interrupted load"));
	await replacement;
	assert.equal(store.getState().track.id, "a");
	assert.equal(store.getState().playing, true);
	assert.equal(store.getState().error, null);
});

test("undo can restore a queue that had no selected track", async (t) => {
	const { store, audio } = setup(t);
	store.playNext([a, b]);
	store.clearQueue();
	await store.undoQueue();
	assert.deepEqual(store.getState().queue, [a, b]);
	assert.equal(store.getState().index, -1);
	assert.equal(store.getState().track, null);
	assert.equal(audio.src, "");
});
