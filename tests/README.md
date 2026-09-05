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
