# Playback regression coverage

Run `npm test` and `npm run build` from the repository root. Tests use Node's
built-in runner and compile the playback store in memory with the existing
esbuild development dependency. The audio double models playback events,
metadata loading, source changes, and failed or interrupted play promises.

The suite covers 128 reorder combinations with duplicate occurrences and
playing/paused state, prefetch and persistence, move-to-next eligibility, undo
capture/consumption/invalidation, station replacement and extension, and failed
restoration. Browser media timing and native drag/menu behavior require live
Obsidian verification.

Repeat coverage checks all three modes with empty, unselected, single-song and
duplicate queues; automatic completion versus explicit next and media-session
handlers; unchanged previous behavior; prefetch after boundaries, removals and
shuffle; snapshot migration; queue undo and station interaction; per-play
scrobbling; rapid skips, stale completion events and failed playback; and radio
exclusion. The suite has 40 tests, including the existing queue regressions.

Live verification for issue #1 (2026-09-05, Obsidian with Navidrome):

- DOM drag moved a duplicate across the current occurrence without reloading
  audio or changing the paused position. The native Move to next menu worked.
- Empty queue showed enabled Undo. Closing/reopening the sidebar preserved it.
- Undo restored the selected duplicate, position, paused/playing state, and
  station seed. Starting a station from a paused current lead preserved pause.
- Reordered and restored queues survived plugin reload; undo did not persist.
- Restoring an unavailable song displayed the normal playback error on the
  queue page and consumed undo.
- Queue and empty-state screenshots were captured and visually checked.
- Final console/error capture was empty, including after plugin reload.
- The vault's original queue, position, volume, and scrobble preference were
  restored and verified in saved plugin data.

When automating these checks, wait for the final pause timeupdate before
comparing positions. A station started from a paused current lead stays paused.

Review against the local Obsidian guidelines: new UI uses DOM helpers,
sentence-case labels, native menus, registered listeners on the persistent
queue container, and theme variables. Undo remains in memory; no settings,
runtime dependencies, network endpoints, or server mutations were added.

Live verification for issue #2 (2026-09-05, Obsidian with Navidrome):

- The queue button cycled off, queue and track with matching accessible labels,
  tooltips, accent state and the repeat-one icon. Screenshots were checked locally.
- Seeking near the end let real audio complete naturally in all three modes,
  including single-song queues, middle entries and a final duplicate occurrence.
  Repeat track restarted that occurrence; repeat queue wrapped; off stopped.
- Manual next, button eligibility, rapid skips across a repeat boundary, shuffle,
  clear-to-empty, and paused undo with a changed repeat selection passed.
- Repeat track survived sidebar closure/reopening and persisted through plugin
  reload, restoring paused. The original saved data had no repeat property and
  loaded as off. Malformed values are covered by the automated tests.
- A configured radio station played with repeat track selected and next disabled.
  Simulated error/stale completion events did not reload it. Returning to a song
  retained repeat. Radio disconnect events and OS media handlers are also covered
  by the audio/media-session doubles; no physical media-key press was automated.
- Scrobbling was disabled during live seeks to avoid changing server play counts;
  repeat scrobble submissions are verified with the client double.
- A large CLI eval request triggered an Obsidian main-process socket JSON parser
  error before the test ran. Loading the same local harness through a short CLI
  request succeeded. Subsequent short calls and the post-reload console capture
  were clean. A later teardown capture contained one generic `app.js` "Disconnected"
  console entry without a Stereo stack; its source remains unconfirmed. The fresh
  idle capture was clean and `dev:errors` reported no captured errors. Short
  requests avoid the observed parser trigger; they do not fix Obsidian's parser.
- Original playback data and settings were restored after testing; playback was
  left paused. No server content or playlists were edited.

Repeat self-review: state and audio ownership remain in the store; UI calls store
actions, uses DOM helpers and registered listeners, and reuses theme styling.
Repeat adds one optional local snapshot field, no runtime dependency or settings
page control, and does not become part of queue undo.
