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
handling. A radio entry that ends advances to the entry after it (wrapping under
repeat queue), but never restarts itself through repeat track, a wrap or
duplicate entry carrying the same stream URL, or an error.

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

Recently played coverage brings the suite to 54 tests. It checks actual audio
starts versus play requests, resume/seek/buffering deduplication, repeat and
explicit replay, retention of 200 play events, metadata sanitization, invalid
saved data, account separation, clear during playback, unavailable tracks,
radio exclusion, stale history actions, and queue undo. The plugin persistence
tests exercise legacy loading, saved queue/history consistency, overlapping
writes followed by clearing, connection changes, and flushing on unload.

Live verification for issue #3 (2026-09-07, Obsidian with Navidrome):

- Actual song starts, pause/resume, seeking, explicit duplicate playback, and
  natural repeat-track completion produced the expected history entries.
- Library's history button, row playback, append, queue undo capture, and live
  list updates worked. Populated and empty screenshots were visually checked.
- Plugin reload restored four entries without starting playback or adding a
  new entry. Closing/reopening the sidebar preserved entries and did not leak
  a history subscription.
- Clearing while playing immediately emptied the UI and saved history without
  interrupting audio. Resume after clear did not recreate the current entry.
- Changing username or server URL cleared history and old queue/undo IDs.
  A stale history action could not play after switching accounts.
- A missing song displayed the normal playback error and kept the history list
  intact. A simulated artwork error removed the image, exposing the placeholder.
- No Stereo console errors were captured. The vault repeatedly reported an
  unrelated `folder-graph-view` exception accessing `originalSetData` during
  leaf/reload operations, so the whole-vault error log was not clean.
- Scrobbling was disabled and playback muted during tests. Original settings
  and queue data were restored and checked against the saved backup; playback
  was left paused. No playlists or other server content were edited.
- Retention, corrupted persistence, radio exclusion and save ordering were
  checked with automated doubles; the 200-play limit was not exercised by
  streaming 200 live songs. Restart checks used plugin reload, not an OS restart.

The optional `history-live.cjs` and `history-live-followup.cjs` scripts are for
the Obsidian CLI, not `npm test`. They require the original plugin data saved in
`window.stereoHistoryBackup` before execution. Run the first script, reload the
plugin, then run the followup. They modify local playback/settings and must be
followed by restoring that backup. Never print the backup: it contains server
credentials. Tests use private view/store access only inside the dev harness.

History self-review: playback ownership stays in the store; new UI uses DOM
helpers, registered events/subscriptions, accessible labels, and theme variables.
History adds no runtime dependencies, endpoints, settings controls or server
writes. Local storage and clearing behavior are documented in README. Existing
lyrics/radio networking and the rest of the plugin are unchanged by this slice.
