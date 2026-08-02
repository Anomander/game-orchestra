# Plan: a "Playlist" node for the custom playback graph editor

> ## 📦 ARCHIVED — this feature has shipped
>
> This is the original implementation plan, kept for its **section ids** (`D1`–`D8`, `Phase 4.4`,
> …), which ~10 source comments cite by name. **Do not move, rename, or rewrite this file** — the
> citations would break.
>
> It is historically accurate but **no longer maintained**. For current documentation see
> [`docs/wiki/graph-engine.md`](wiki/graph-engine.md) § *Playlist nodes*, which folds in the
> durable content. Where the two disagree, the wiki and the code win.

**Audience:** the implementing model (Sonnet). Every decision below is **locked** — implement it
as written. If something here turns out to be impossible against the real code, stop and report
rather than inventing a different design.

**Goal:** a new graph node type, `playlist`, that plays *another* playlist according to that
playlist's own rules. The target can be named **directly** (a playlist id) or **indirectly**
(the current scene's area playlist, the current scene's combat playlist for a given mood, the
world's default-music equivalents).

---

## 0. Read these first

Do not start writing code until you have read, in full:

- `scripts/custom-playback-schema.mjs` — node/edge/graph shapes, durational vs instantaneous.
- `scripts/custom-playback-engine.mjs` — the token-walk engine. Read **every** comment; they
  record live-confirmed bugs, not speculation.
- `scripts/graph-drawflow-bridge.mjs` — CustomGraph ⇄ Drawflow JSON, and the `data.exits[]`
  parallel-array contract.
- `scripts/graph-validation.mjs`, `scripts/graph-presets.mjs`, `scripts/custom-playlist-inspector.mjs`,
  `scripts/custom-playlist-node-render.mjs`.
- `scripts/helpers.mjs` — `PlaylistContext`, `getCustomGraph`, `isCustomPlaylist`, `getPlaylistById`.
- `scripts/music-controller.mjs` — `transitionToContext`, `reconcileRestoredPlayback`,
  `onCustomGraphChanged`, `getGraphActivity`.

Existing house rules that this feature must not break:

- **H1** — a custom playlist is always stored in `UNSEQUENCED` mode.
- **H2** — a custom playlist must never be treated as a Soundboard (`isSoundboard` excludes it),
  and must never get an implicit `initialTrack`.
- **H7** — game-state conditions are evaluated *when a token arrives*, never re-evaluated live.
- **H8** — a live graph edit rebuilds the running engine, and `hooks.mjs#handleUpdatePlaylist`
  is the *single* designed trigger for that.
- **H11** — retiring an engine during a context change uses `stop({ stopAudio: false })` so the
  controller's fade-out loop can crossfade instead of hard-cutting.
- The editor **never** calls `this.render()` after the initial mount — only `_renderInspector()`.
  A full re-render tears down Drawflow's live canvas mid-mousedown and silently breaks dragging.

---

## 1. Locked design decisions

### D1 — The node

Type id `playlist`. **Durational** (it holds a token for real time), therefore subject to the
singleton rule exactly like `track` and `delay`. Ports: 1 input; 1 output, or 0 when
`infinite: true` (mirrors an infinite Track).

### D2 — Reference schema

```js
/**
 * @typedef {object} PlaylistRef
 * @property {'direct'|'scene'|'default'} source
 * @property {string|null} [playlistId]              source==='direct'
 * @property {'area'|'combat'} [section]             source!=='direct'
 * @property {'active'|'none'|'specific'} [moodMode] source!=='direct'
 * @property {string|null} [moodId]                  moodMode==='specific'
 */
```

- `source: 'direct'` — a literal playlist id.
- `source: 'scene'` — read the **currently active scene's** `music.<section>` flag.
- `source: 'default'` — read the world default-music setting
  (`game.settings.get('game-orchestra', 'defaultMusic')?.data?.['game-orchestra']?.music?.[section]`).

Mood modes, resolved against a section object (`{ playlist, initialTrack, priority, moods: {...} }`):

| `moodMode`   | resolves to                                                        |
| ------------ | ------------------------------------------------------------------ |
| `'none'`     | `section.playlist` — the section's base playlist, ignoring moods    |
| `'active'`   | `section.moods?.[activeMood]?.playlist \|\| section.playlist`       |
| `'specific'` | `section.moods?.[ref.moodId]?.playlist` — **no fallback**, null if unset |

`'active'` deliberately mirrors `PlaylistContext._extractSectionConfig()`, so an indirect
reference resolves to the same playlist the module itself would pick for that section.

**Not supported, on purpose:** referencing a token's/combatant's combat music. A graph has no way
to say *which* combatant it means. Do not add it.

### D3 — Runtime semantics: "a pass"

A Playlist node plays its target in **passes**. One pass = one complete run of a
`CustomPlaybackEngine` over a graph derived from the target:

- target **has** a stored `customPlayback` graph → run that graph verbatim (a **child engine**);
- target has **no** graph → synthesize a **one-pass graph from its native Foundry mode** (D5)
  and run that.

A pass **completes** when the child engine goes idle: no token is walking and no durational node
holds a token. Many graphs never complete (an infinite Track, a shuffle loop) — that is fine and
expected: the Playlist node then holds its token forever, exactly like a Loop Forever track.

`loopCount` / `infinite` mirror Track exactly:

- `infinite: true` → repeat passes forever; **no exit port**;
- otherwise → run `loopCount` passes (default 1), then release the token and follow the single exit.

### D4 — Resolution timing

The reference resolves **at the moment a token enters the node** — same rule as Condition (H7).
A scene change or mood change mid-pass does **not** re-resolve; the running context change is what
tears the whole engine down and rebuilds it.

### D5 — Native mode → one-pass graph

| target mode                       | synthesized one-pass graph                                         |
| --------------------------------- | ------------------------------------------------------------------ |
| `SEQUENTIAL` (0)                  | Start → Track(each, in `playbackOrder`) → … → End                   |
| `SHUFFLE` (1)                     | as above, over a **shuffled copy** of `playbackOrder`               |
| `SIMULTANEOUS` (2)                | Start → Fork → one finite Track per sound → a single shared End     |
| `UNSEQUENCED` (-1), no stored graph | same as `SEQUENTIAL` (+ an editor warning, see V9)                |
| no sounds at all                  | Start → End (the pass completes instantly; the throttle in D7 bounds it) |

Special cases: `SIMULTANEOUS` with exactly one sound emits Start → Track → End with **no Fork**
(a Fork with one exit is a degenerate shape). Every synthesized Track is finite with
`loopCount: 1` — repetition is the *parent* node's job, not the child graph's.

Because the graph is re-synthesized per pass, a `SHUFFLE` target genuinely reshuffles on each pass.

### D6 — Cycle, recursion and collision prevention

One mechanism covers all three: a **shared in-flight registry** — a `Set` of playlist ids,
created by the root engine (seeded with its own playlist id) and passed **by reference** into
every child engine.

Entering a Playlist node is **refused** (see D7) when any of:

1. the resolved target id is already in the registry (self-reference, an A→B→A cycle, or two
   concurrent Fork branches both targeting the same playlist);
2. the child's nesting depth would exceed `MAX_PLAYLIST_NESTING_DEPTH = 4`;
3. the reference resolves to nothing (unset scene flag, missing mood override, deleted playlist).

A registry entry is added when a Playlist node starts its first pass and removed when it releases
its token (all passes done, refused, or the engine stops).

### D7 — Refusal behavior

A refused or unresolvable Playlist node is treated as a **zero-length pass**: log at level 2, do
not hold the token, and follow the single exit immediately (or terminate, if `infinite`).

Terminating instead would leave a graph permanently silent because a GM forgot to set one scene's
mood override — too harsh. To keep "follow immediately" from becoming a runaway loop when the exit
cycles back, **entering a Playlist node is rate-limited by the same 300 ms floor Track uses**
(`MIN_CLEAN_START_INTERVAL_MS`) and counted by the same circuit breaker
(`_tripCircuitBreakerIfRunaway`). The same floor applies **between passes**.

### D8 — No new transport

Child engines emit the existing `gameOrchestraGraphActivity` hook with their **own** `playlistId`, so an
editor window open on a *child* playlist lights up for free — `editor-highlight-mixin.mjs` already
filters on `payload.playlistId !== this.playlist?.id`. Add no sockets, no new hooks.

---

## 2. Out of scope (do not "fix" these)

- **Pre-existing quirk you will observe:** in `MusicController.playCurrentTrack()`, the
  `contextUnchanged` check compares `this.currentTracks` (forced to `[]` for a custom playlist)
  against `winnerContext.tracks` (non-empty), so a custom-playlist context re-transitions on
  every re-resolution. It is unrelated to this feature. Leave it. Do not widen scope.
- Referencing a specific *track* of another playlist (that is what a Track node is for).
- Cross-world / compendium playlists.

---

## Phase 1 — Schema and pure reference resolution

### 1.1 `scripts/custom-playback-schema.mjs`

- Extend the `GraphNode` typedef: add `'playlist'` to the `type` union, and document
  `playlistRef`, plus that `loopCount`/`infinite` mean *passes* for this type.
- Add the `PlaylistRef` typedef from D2.
- `DURATIONAL_NODE_TYPES` → add `'playlist'`. Leave `INSTANTANEOUS_NODE_TYPES` alone.
- `ALL_NODE_TYPES` → add `'playlist'`.
- Bump nothing: `CUSTOM_GRAPH_VERSION` stays `1`. A graph saved before this feature is still
  valid and readers must keep tolerating a missing `playlistRef` the same way they tolerate a
  missing `label`.

### 1.2 New file `scripts/playlist-ref.mjs`

Pure — **no** `game`, `ui`, `CONST` globals, no DOM — so it is unit-testable in isolation, in the
same spirit as `graph-validation.mjs`.

```js
export const PLAYLIST_REF_SOURCES  = ['direct', 'scene', 'default'];
export const PLAYLIST_REF_SECTIONS = ['area', 'combat'];
export const PLAYLIST_REF_MOOD_MODES = ['active', 'none', 'specific'];

/** The ref a freshly-created Playlist node starts with. */
export function createDefaultPlaylistRef();      // -> { source: 'direct', playlistId: null }

/** Normalize a possibly-partial ref, filling defaults per source. Never returns null. */
export function normalizePlaylistRef(ref);

/**
 * Pick a playlist id out of an already-extracted music section object.
 * @param {{playlist?: string, moods?: Record<string, {playlist?: string}>}|null} section
 * @param {PlaylistRef} ref
 * @param {string} activeMood
 * @returns {string|null}
 */
export function selectSectionPlaylistId(section, ref, activeMood);

/**
 * Resolve a ref to a playlist id given already-read state. The Foundry-touching
 * wrapper lives in helpers.mjs (1.3); this half stays pure.
 * @param {PlaylistRef} ref
 * @param {{sceneSections?: {area?: object, combat?: object},
 *          defaultSections?: {area?: object, combat?: object},
 *          activeMood?: string}} state
 * @returns {string|null}
 */
export function resolvePlaylistRefId(ref, state);

/**
 * Short human-readable description of a ref, for the node's canvas detail line
 * and the inspector. Takes a resolver for names so it stays Foundry-free.
 * @param {PlaylistRef} ref
 * @param {{playlistName?: (id: string) => string|null,
 *          moodLabel?: (id: string) => string|null,
 *          localize?: (key: string, data?: object) => string}} lookups
 * @returns {string}   e.g. "Tavern Theme", "Scene · Area (active mood)", "Default · Combat (boss)"
 */
export function describePlaylistRef(ref, lookups);
```

`describePlaylistRef` must degrade gracefully: an unresolvable direct id renders as
`(missing playlist)` via a localized key, never as a raw id.

### 1.3 `scripts/helpers.mjs`

Add the thin Foundry-touching wrappers:

```js
/** Resolve a PlaylistRef against live game state. @returns {object|null} Playlist document */
export function resolvePlaylistRef(ref);
```

It reads `game.scenes?.active`, `game.settings.get(CONST.moduleId, CONST.settings.defaultMusic)`,
and `game.settings.get(CONST.moduleId, CONST.settings.activeMood)`, extracts the four section
objects, delegates to `resolvePlaylistRefId()`, and returns `getPlaylistById(id)`.

Section extraction, exactly:
- scene: `scene?.getFlag?.(CONST.moduleId, 'music.area' | 'music.combat')`
- default: `defaultMusicSetting?.data?.['game-orchestra']?.music?.area | .combat`

Also add:

```js
/**
 * Every playlist a Playlist node could target, with the metadata the editor and
 * validator need. Excludes nothing - the validator, not this, decides what is legal.
 * @returns {Array<{id, name, mode, isCustom, soundCount, graph}>}
 */
export function getGraphTargetPlaylists();
```

### 1.4 Tests

New `tests/playlist-ref.test.mjs`: the mood-mode table from D2 (including `'specific'` having no
fallback), each `source`, missing/partial refs, `normalizePlaylistRef`, and `describePlaylistRef`
degradation.

---

## Phase 2 — Synthesizing a native playlist's rules as a graph

### 2.1 Extract the shared builder

`graph-presets.mjs`'s internal `createBuilder()` (and its two construction rules — numeric string
ids, edges emitted in output-port order) is needed by the new synthesizer too.

Move `createBuilder`, `COLUMN_WIDTH_PX`, `ROW_HEIGHT_PX`, `ORIGIN_PX` and `sequencePosition` into a
new `scripts/graph-builder.mjs`, export them, and have `graph-presets.mjs` import them. Carry the
existing header comment explaining the two rules across to the new file — it is load-bearing
documentation, not decoration. `graph-presets.mjs`'s public surface (`GRAPH_PRESETS`, `getPreset`)
must not change, and `tests/graph-presets.test.mjs` must still pass untouched.

### 2.2 New file `scripts/native-mode-graph.mjs`

```js
/**
 * Express a native (non-custom) playlist's own playback rules as a one-pass
 * CustomGraph, so the engine can play any playlist through exactly one code
 * path (see docs/playlist-node-plan.md D3/D5). One pass only - repetition is
 * the calling Playlist node's job.
 * @param {{mode: number, playbackOrder?: string[], sounds?: object}} playlist
 * @param {{rng?: () => number}} [options] - Injectable RNG for deterministic tests.
 * @returns {import('./custom-playback-schema.mjs').CustomGraph}
 */
export function buildNativeModeGraph(playlist, { rng = Math.random } = {});
```

Implement the D5 table. Read the sound order as
`playlist.playbackOrder?.length ? playlist.playbackOrder : [...playlist.sounds.keys()]`, tolerating
both the Collection and Map-like shapes the rest of the codebase tolerates
(`sounds?.contents || Array.from(sounds?.values() || [])`). Resolve `CONST.PLAYLIST_MODES` the same
defensive way `helpers.mjs` does: `globalThis.CONST?.PLAYLIST_MODES ?? { UNSEQUENCED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 }`.

Pure — no Foundry globals beyond that `globalThis.CONST` read, no DOM.

### 2.3 Tests

New `tests/native-mode-graph.test.mjs`: one case per mode; assert each output passes
`validateGraph()`, that shuffle uses the injected rng and differs across calls, that the
one-sound `SIMULTANEOUS` case has no Fork, and that the empty-playlist case is Start → End.

---

## Phase 3 — Engine: idle detection, child engines, `_enterPlaylist`

This is the risky phase. Work in the order below and run
`npx vitest run tests/custom-playback-engine.test.mjs` after each step — every existing test must
stay green throughout.

### 3.1 Idle detection

The engine currently lets tokens vanish silently at End nodes and dead ends. A Playlist node needs
to know when its child has nothing left to do.

Add to the constructor:

```js
this._pendingWalks = 0;   // token walks currently in flight
this._idleFired = false;  // onIdle fires at most once per run
```

Introduce a single wrapper and route **every** token advance through it:

```js
/**
 * Run a token-advancing continuation as a tracked walk. Idle detection must
 * never observe the instant between a durational node releasing its token and
 * the next node receiving it - so the release and the follow-up hop happen
 * inside one tracked walk, not as two unrelated callbacks.
 * @param {() => Promise<void>|void} fn
 * @private
 */
async _walk(fn) {
  this._pendingWalks++;
  try { return await fn(); }
  finally { this._pendingWalks--; this._checkIdle(); }
}

/** @private */
_checkIdle() {
  if (this._runId === -1 || this._idleFired) return;
  if (this._pendingWalks > 0 || this._activeNodes.size > 0) return;
  this._idleFired = true;
  this._onIdle?.();
}
```

Wrap:

- `_enterNode()` — rename the existing body to `_enterNodeInner()`; the public `_enterNode()`
  becomes `return this._walk(() => this._enterNodeInner(nodeId, depth))`.
- The `watcher.watch()` natural-end callback in `_enterTrack()` — wrap its whole body
  (`stopTrack` → `_releaseTrackNode` → `_followSingleExit`).
- Both `this.clock.schedule(...)` callbacks in `_scheduleLoopStop()` (the give-up branch and the
  loop-completion branch).
- The `this.clock.schedule(...)` callback in `_enterDelay()`.
- Anything you add in 3.3 that releases a node and follows an exit.

Do **not** wrap the `:throttle` / `:probe` scheduling helpers — those run while the node is still
registered in `_activeNodes`, so idle cannot fire spuriously.

In `start()`: reset `this._pendingWalks = 0; this._idleFired = false;` alongside the other
per-run resets, and — critically — when there is **no Start node**, call `this._checkIdle()` before
returning, or a parent waits forever on a graph that can never produce a token.

### 3.2 Constructor options and child plumbing

Change the signature to:

```js
/**
 * @param {PlaylistContext} playlistContext
 * @param {MusicController} controller
 * @param {object} [options]
 * @param {CustomGraph} [options.graph]   - Overrides the playlist's stored graph. Used for a
 *   native target, whose rules are synthesized rather than stored (native-mode-graph.mjs).
 * @param {number} [options.depth]        - Playlist-node nesting depth; 0 for a root engine.
 * @param {Set<string>} [options.registry] - Playlist ids in flight anywhere in this engine tree,
 *   shared BY REFERENCE with every child. The single mechanism preventing self-reference,
 *   indirect cycles, and two branches driving one playlist at once (plan D6).
 * @param {() => void} [options.onIdle]   - Called once when this run has no token left.
 */
constructor(playlistContext, controller, options = {})
```

- `this.graph = options.graph ?? getCustomGraph(this.playlist) ?? { version: 1, nodes: [], edges: [] }`
- `this._depth = options.depth ?? 0`
- `this._registry = options.registry ?? new Set(this.playlist?.id ? [this.playlist.id] : [])`
- `this._onIdle = options.onIdle ?? null`
- `this._children = new Set()`

`options` must be optional and every existing two-argument call site must keep working unchanged.

Add:

```js
/** Playlist ids this engine tree is currently driving, itself included. */
get activePlaylistIds() { return new Set(this._registry); }

/** True if this engine tree is currently driving that playlist (root or any descendant). */
isPlayingPlaylist(playlistId) { return !!playlistId && this._registry.has(playlistId); }
```

Extend `get activeSounds()` to include every child's `activeSounds`, recursively.

Extend `stop({ stopAudio })`: before stopping its own sounds, take a snapshot of `this._children`,
clear the set, and `await Promise.all(children.map((c) => c.stop({ stopAudio })))`. Then delete
from `this._registry` every playlist id this engine itself added (track them on the `_activeNodes`
entry, see 3.3). Keep the existing `this._runId = -1` first-line ordering and the existing
awaited-stop rationale intact — re-read that comment before touching the method.

### 3.3 Extract the entry throttle

`_enterTrack()`'s "clean start" throttle is needed verbatim by `_enterPlaylist()`. Extract it:

```js
/**
 * Enforce MIN_CLEAN_START_INTERVAL_MS between two starts of the same node.
 * See that constant for why a durational cycle needs an explicit floor.
 * @returns {Promise<boolean>} false if the engine was stopped/restarted while waiting.
 * @private
 */
async _throttleNodeEntry(nodeId, runId)
```

Rewrite `_enterTrack()` to use it. Its behavior — including stamping `_lastCleanStartAt` — must be
identical; the existing Track tests are the proof.

### 3.4 `_enterPlaylist(node)`

Dispatch it from `_enterNodeInner()`'s switch (`case 'playlist': return this._enterPlaylist(node);`).

```
_enterPlaylist(node):
  runId = this._runId
  if (_tripCircuitBreakerIfRunaway(node.id)) return
  if (_activeNodes.has(node.id)) return                  // singleton: drop this token

  target = resolvePlaylistRef(node.playlistRef)           // synchronous - no await before the
                                                          // registration below, same reason as
                                                          // _enterTrack's reservation comment
  reason = null
  if (!target)                              reason = 'unresolved'
  else if (this._registry.has(target.id))   reason = 'already playing'
  else if (this._depth + 1 > MAX_PLAYLIST_NESTING_DEPTH) reason = 'too deeply nested'
  if (reason) { log(2, ...); return this._skipPlaylistNode(node, runId) }

  _activeNodes.set(node.id, { sound: null, targetPlaylistId: target.id })
  _registry.add(target.id)
  _emitActivity()

  if (!await this._throttleNodeEntry(node.id, runId)) { this._releasePlaylistNode(node); return }
  this._runPlaylistPass(node, target, runId, 1)
```

Supporting methods:

```js
/**
 * Release a Playlist node's claim on _activeNodes and on the shared in-flight
 * registry. Always use this rather than _activeNodes.delete, so the two can
 * never drift apart and strand a registry entry - which would make that
 * playlist permanently unreferenceable for the rest of the session.
 * @private
 */
_releasePlaylistNode(node)

/**
 * A Playlist node that could not run (unresolvable, refused, or too deep) is a
 * zero-length pass: it keeps the graph moving instead of stranding the token
 * on a scene flag someone forgot to set (plan D7). Bounded by the same entry
 * throttle a real pass gets, so a self-looping exit cannot spin.
 * @private
 */
async _skipPlaylistNode(node, runId)   // throttle, then _followSingleExit(node.id, 0) unless node.infinite

/**
 * Run pass `passIndex` of a Playlist node: build a child engine over the
 * target's own graph (or the graph synthesized from its native mode), and
 * chain the next pass - or the node's exit - off that child going idle.
 * @private
 */
_runPlaylistPass(node, target, runId, passIndex)
```

`_runPlaylistPass` detail:

```
graph = getCustomGraph(target) ?? buildNativeModeGraph(target, { rng: this._rng })
child = new CustomPlaybackEngine(
  new PlaylistContext(this.playlistContext?.context ?? 'area', this.playlistContext?.contextEntity ?? null,
                      target, null, 0, null, false),
  this.controller,
  { graph, depth: this._depth + 1, registry: this._registry,
    onIdle: () => this._onPassComplete(node, target, runId, passIndex, child) }
)
this._children.add(child)
await child.start()
```

`onIdle` may fire **synchronously inside `child.start()`** (a Start → End graph). Write
`_onPassComplete` so it is safe there: do not depend on anything assigned after the `await`.

`_onPassComplete(node, target, runId, passIndex, child)`:

```
if (this._runId !== runId) return                       // superseded
this._children.delete(child)
await child.stop({ stopAudio: true })                   // MUST be awaited before the next pass
                                                        // starts - same race CustomPlaybackEngine.stop()
                                                        // documents for shared sounds
if (this._runId !== runId) return
const total = node.infinite ? Infinity : Math.max(1, node.loopCount || 1)
if (passIndex < total) {
  if (!await this._throttleNodeEntry(node.id, runId)) { this._releasePlaylistNode(node); return }
  return this._runPlaylistPass(node, target, runId, passIndex + 1)
}
this._walk(async () => { this._releasePlaylistNode(node); await this._followSingleExit(node.id, 0) })
```

Note `node.infinite` never reaches the release branch — that node holds its token until the engine
stops, exactly like an infinite Track.

Add the constant next to the others, with a comment explaining what it bounds:

```js
/** How many Playlist nodes may nest before the engine refuses to go deeper (plan D6). */
const MAX_PLAYLIST_NESTING_DEPTH = 4;
```

### 3.5 Tests — `tests/custom-playback-engine.test.mjs`

Add a `describe('playlist nodes')` block covering, at minimum:

- a direct ref to a playlist with its own graph plays that graph's sounds, then advances on idle;
- a direct ref to a native `SEQUENTIAL` playlist plays its sounds in `playbackOrder` and advances;
- `loopCount: 2` runs two passes before following the exit;
- `infinite: true` never follows an exit and holds `_activeNodes` forever;
- a self-reference (direct id === the running playlist) is refused, logs, and follows the exit;
- an A→B→A cycle is refused at the second hop;
- nesting deeper than `MAX_PLAYLIST_NESTING_DEPTH` is refused;
- an unresolvable indirect ref follows the exit rather than stranding the token;
- `stop()` tears down child engines and stops their sounds;
- `stop({ stopAudio: false })` leaves child sounds audible (H11);
- `isPlayingPlaylist()` is true for a descendant's playlist while a pass runs and false after;
- the entry throttle prevents a Playlist node whose exit loops back to itself from spinning
  (assert on the fake-timer clock, not wall time).

Follow the file's existing mock/fake-timer style; do not introduce a new harness.

---

## Phase 4 — Controller, hooks, context

### 4.1 `MusicController.onCustomGraphChanged(playlist)`

Currently returns early unless the changed playlist *is* the playing context. A graph edited on a
playlist that is currently running **as a child** must rebuild too. Change the guard to:

```js
const isCurrent = this.currentContext?.playlist?.id === playlist?.id;
const isNested = this._customEngine?.isPlayingPlaylist?.(playlist?.id) ?? false;
if (!isCurrent && !isNested) return;
```

Keep everything after that unchanged, including the comment on why the stop must be awaited.

### 4.2 `MusicController.getGraphActivity(playlist)`

Today it only matches the root engine's playlist, so opening the editor on a child playlist
mid-playback shows nothing until the next activity broadcast. Walk the engine tree and return the
matching engine's `activityState`. Add a small `CustomPlaybackEngine#findEngineFor(playlistId)`
(returns `this` or a descendant, else `null`) rather than reaching into `_children` from the
controller.

### 4.3 `MusicController.reconcileRestoredPlayback()`

It stops sounds Foundry resurrected from a previous session, but only scans playlists that
themselves have a graph. A sub-playlist driven through a Playlist node is usually a *native*
playlist, so its resurrected sounds are missed entirely and play forever.

Extend the scan: for every custom playlist, collect the playlists its Playlist nodes target —
resolving indirect refs too via `resolvePlaylistRef()` (this runs on the head GM with a ready
game, so scene/settings state is available), transitively, with a visited set. Stop still-`playing`
sounds in those as well. Keep the existing log line's shape, just with the wider set.

### 4.4 `PlaylistContext._resolveTracks()`

For a custom playlist it currently returns the graph's Track-node sounds. Extend it to also
include sounds reachable through **direct** Playlist references, transitively, guarded by a
visited set of playlist ids:

- referenced playlist has a graph → its Track-node sounds (recurse);
- referenced playlist has no graph → all of its sounds.

Why: `transitionToContext()` builds `targetTrackIds` from this and fades out every *managed* sound
not in it. Without this, a sub-playlist's audio gets cut on every re-resolution of the same
context. **Indirect** references are deliberately not followed here — they cannot be resolved
statically. Document that limitation in the method's comment: worst case is a brief crossfade of
an indirectly-referenced sub-playlist, never wrong playback.

### 4.5 Tests

Extend `tests/music-controller.test.mjs` and `tests/helpers.test.mjs`:

- `onCustomGraphChanged` rebuilds for a nested playlist;
- `getGraphActivity` returns a child engine's state;
- `reconcileRestoredPlayback` stops a resurrected sound in a directly- **and** indirectly-referenced
  playlist;
- `_resolveTracks` includes direct-ref sub-playlist sounds and terminates on a reference cycle.

---

## Phase 5 — Validation

`scripts/graph-validation.mjs` stays **Foundry-free**: it emits i18n *keys*, and the caller
localizes. Extend `validateGraph`'s options:

```js
/**
 * @param {object} [options]
 * @param {{sounds?: {get: Function}, id?: string}} [options.playlist] - The playlist being edited.
 * @param {Array<{id, name, mode, isCustom, soundCount, graph}>} [options.playlists] - Every
 *   playlist a Playlist node could target; when omitted, target-existence checks are skipped.
 * @param {string[]} [options.moodIds] - Configured mood ids, for validating a 'specific' mood ref.
 */
```

Add `case 'playlist':` with these rules (keys under `GameOrchestra.CustomEditor.Validation.*`):

| # | Severity | Key | Condition |
|---|----------|-----|-----------|
| V1 | error | `PlaylistMustHaveOneExit` | not infinite and `exits.length !== 1` |
| V2 | error | `InfinitePlaylistMustHaveNoExit` | infinite and `exits.length !== 0` |
| V3 | error | `PlaylistLoopCountMin` | not infinite and not `loopCount >= 1` |
| V4 | error | `PlaylistNoReference` | `playlistRef` missing, or `source` not in `PLAYLIST_REF_SOURCES` |
| V5 | error | `PlaylistNoTarget` | `source === 'direct'` and no `playlistId` |
| V6 | error | `PlaylistMissingTarget` | direct id not found in `options.playlists` (only when provided) |
| V7 | error | `PlaylistSelfReference` | direct id === `options.playlist?.id` |
| V8 | error | `PlaylistInvalidSection` | indirect and `section` not in `PLAYLIST_REF_SECTIONS`, or `moodMode` not in `PLAYLIST_REF_MOOD_MODES`, or `moodMode === 'specific'` with an empty `moodId` |
| V9 | warning | `PlaylistSoundboardTarget` | direct target is `UNSEQUENCED` with no graph (no native play order — it will be played in list order) |
| V10 | warning | `PlaylistEmptyTarget` | direct target has no graph and no sounds |
| V11 | warning | `PlaylistUnknownMood` | `moodMode === 'specific'` and `moodId` not in `options.moodIds` (only when provided) |
| V12 | warning | `PlaylistReferenceCycle` | following **direct** refs from the target leads back to `options.playlist?.id` |

V12 needs a small helper in `graph-validation.mjs`:

```js
/**
 * Whether following direct Playlist references out of `startId` can reach
 * `targetId`. Only direct references are traceable statically - an indirect one
 * depends on live scene/mood state, so a cycle through one is caught at runtime
 * by the engine's in-flight registry instead (plan D6), not here.
 * @returns {boolean}
 */
export function reachesPlaylist(startId, targetId, playlistsById);
```

Breadth-first with a visited set; the `graph` on each entry is the stored `customPlayback` graph.

Extend `tests/graph-validation.test.mjs` with one case per rule, plus: a graph containing a valid
Playlist node validates clean, and `reachesPlaylist` terminates on a cycle.

---

## Phase 6 — Editor, inspector, rendering

### 6.1 `scripts/graph-drawflow-bridge.mjs`

- `outputCountFor`: `if (node.type === 'playlist') return node.infinite ? 0 : 1;`
- `nodeDataFor`: add a `case 'playlist'` writing
  `{ ...base, playlistRef, infinite }` plus `loopCount` when finite — mirror the Track case exactly,
  including the infinite/finite split.
- `drawflowExportToGraph`: read `playlistRef` (through `normalizePlaylistRef`), `infinite`, and
  `loopCount` back out for `type === 'playlist'`.

Extend `tests/graph-drawflow-bridge.test.mjs` with a round-trip of a Playlist node in both the
finite and infinite shapes.

### 6.2 `scripts/custom-playlist-node-render.mjs`

- `NODE_ICONS.playlist = 'fa-compact-disc'` (FontAwesome 6 **free** solid — verify the glyph
  exists before committing; if not, fall back to `fa-list-ul`).
- `NODE_LABELS.playlist = 'Playlist'`.
- `computeNodeDetail`: `case 'playlist'` → `` `${refLabel || '(no playlist)'} × ${node.infinite ? '∞' : (node.loopCount ?? 1)}` ``, where `refLabel` is a new entry in the options bag (the editor
  supplies it, since resolving names needs live documents).

### 6.3 `scripts/custom-playlist-inspector.mjs`

Add a `selectedNode.type === 'playlist'` branch. New params on `buildInspectorHtml`:
`playlistOptions` (`{id, name, selected}[]`) and `moodOptions` (`{id, label, selected}[]`).

Controls, in order:

1. **Source** `<select>` → `data-change-action="updatePlaylistSource"` — Direct / This scene / World default.
2. If `source === 'direct'`: **Playlist** `<select>` → `updatePlaylistTarget`. The edited playlist
   itself must be **absent** from the options (V7 makes it an error anyway; do not offer it).
   Render a `hint` when `playlistOptions` is empty, mirroring the Track branch's `NoSounds` hint.
3. Otherwise: **Section** `<select>` (Area / Combat) → `updatePlaylistSection`; **Mood**
   `<select>` (Active mood / Ignore moods / A specific mood) → `updatePlaylistMoodMode`; and when
   `moodMode === 'specific'`, a **Mood** `<select>` of configured moods → `updatePlaylistMoodId`.
4. **Loop Forever** checkbox → `updatePlaylistInfinite`; when unchecked, a **Passes** number input
   (min 1) → `updatePlaylistLoopCount`.
5. A `hint` paragraph explaining pass semantics (`Inspector.PlaylistHint`).

Escape every interpolated value with the existing `escapeHtml` — playlist and mood names are
user-authored.

### 6.4 `scripts/custom-playlist-editor.mjs`

- `NODE_DEFAULTS.playlist = { inputs: 1, outputs: 1, data: { playlistRef: createDefaultPlaylistRef(), loopCount: 1, infinite: false } }`
- `NODE_PALETTE`: add `{ type: 'playlist', label: 'GameOrchestra.CustomEditor.NodeType.Playlist' }`,
  positioned right after `track`.
- `_outputCountForPastedEntry`: add `case 'playlist': return data.infinite ? 0 : 1;`
- `_prepareContext`: build and return `playlistOptions` (from `getGraphTargetPlaylists()`, minus
  `this.playlist.id`, marking the selected one) and `moodOptions` (from
  `game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods`,
  localizing `GameOrchestra.*` labels the way `mood-config.mjs` does). Pass
  `playlists` and `moodIds` into `validateGraph()` here too.
- `_renderInspector`: destructure and forward the two new option lists.
- `_refreshNodeDisplay`: for a playlist node, compute
  `refLabel = describePlaylistRef(node.playlistRef, { playlistName, moodLabel, localize })` and pass
  it into `computeNodeDetail`. Build the name lookups once per call from the same data
  `_prepareContext` uses; if that turns out to be hot, extend `_buildGraphLookup()` instead.
- `_CHANGE_ACTIONS`: register `updatePlaylistSource`, `updatePlaylistTarget`,
  `updatePlaylistSection`, `updatePlaylistMoodMode`, `updatePlaylistMoodId`,
  `updatePlaylistInfinite`, `updatePlaylistLoopCount`.
- Handlers: follow the existing static-handler shape exactly — read `this._liveNode(nodeId)`,
  mutate `node.data`, call `this._patchNodeData(nodeId, node.data)`. Two need extra care:
  - `handleUpdatePlaylistInfinite` must add/remove the output **port** on the live Drawflow node,
    exactly like `handleUpdateTrackInfinite` does (`_patchNodeData` only touches `data`).
  - `handleUpdatePlaylistSource` must re-normalize the ref through `normalizePlaylistRef()` so
    switching direct ⇄ indirect leaves a coherent object rather than a mix of both shapes' fields.

### 6.5 `styles/game-orchestra.css`

Give `.game-orchestra-node-playlist` a shape distinct from every existing one (start=triangle,
end=octagon, track=pill, delay=circle, fork/random=vertical bar, condition=rectangle). Use a
**rounded rectangle with a doubled outline** (an inset `box-shadow` ring reads as "a container of
tracks"), accent `--game-orchestra-node-accent: #14b8a6`. Follow the existing per-type block layout:
the shape rule, the `::before` accent rule, a `.game-orchestra-node-content` padding rule, and — if the
shape clips its corners — a matching `.selected` / `.game-orchestra-multi-selected` `::after` rule
alongside the ones at the top of that section.

### 6.6 `lang/en.json` **and** `lang/pt-BR.json`

`tests/lang.test.mjs` enforces exact key parity, so every key must land in **both** files with a
real translation (not an English copy pasted into pt-BR, and never an empty string).

Keys to add:

```
GameOrchestra.CustomEditor.NodeType.Playlist
GameOrchestra.CustomEditor.Inspector.PlaylistSource
GameOrchestra.CustomEditor.Inspector.PlaylistSource.Direct
GameOrchestra.CustomEditor.Inspector.PlaylistSource.Scene
GameOrchestra.CustomEditor.Inspector.PlaylistSource.Default
GameOrchestra.CustomEditor.Inspector.PlaylistTarget
GameOrchestra.CustomEditor.Inspector.PlaylistSection
GameOrchestra.CustomEditor.Inspector.PlaylistSection.Area
GameOrchestra.CustomEditor.Inspector.PlaylistSection.Combat
GameOrchestra.CustomEditor.Inspector.PlaylistMoodMode
GameOrchestra.CustomEditor.Inspector.PlaylistMoodMode.Active
GameOrchestra.CustomEditor.Inspector.PlaylistMoodMode.None
GameOrchestra.CustomEditor.Inspector.PlaylistMoodMode.Specific
GameOrchestra.CustomEditor.Inspector.PlaylistMoodId
GameOrchestra.CustomEditor.Inspector.PlaylistPasses
GameOrchestra.CustomEditor.Inspector.PlaylistInfinite
GameOrchestra.CustomEditor.Inspector.PlaylistInfiniteHint
GameOrchestra.CustomEditor.Inspector.PlaylistHint
GameOrchestra.CustomEditor.Inspector.NoPlaylists
GameOrchestra.CustomEditor.Ref.MissingPlaylist
GameOrchestra.CustomEditor.Ref.SceneSection
GameOrchestra.CustomEditor.Ref.DefaultSection
GameOrchestra.CustomEditor.Validation.PlaylistMustHaveOneExit
GameOrchestra.CustomEditor.Validation.InfinitePlaylistMustHaveNoExit
GameOrchestra.CustomEditor.Validation.PlaylistLoopCountMin
GameOrchestra.CustomEditor.Validation.PlaylistNoReference
GameOrchestra.CustomEditor.Validation.PlaylistNoTarget
GameOrchestra.CustomEditor.Validation.PlaylistMissingTarget
GameOrchestra.CustomEditor.Validation.PlaylistSelfReference
GameOrchestra.CustomEditor.Validation.PlaylistInvalidSection
GameOrchestra.CustomEditor.Validation.PlaylistSoundboardTarget
GameOrchestra.CustomEditor.Validation.PlaylistEmptyTarget
GameOrchestra.CustomEditor.Validation.PlaylistUnknownMood
GameOrchestra.CustomEditor.Validation.PlaylistReferenceCycle
```

`Inspector.PlaylistHint` should say, in plain terms: *"Plays another playlist by its own rules. It
moves on when that playlist finishes a full pass — a playlist that loops forever never finishes,
so playback stays here until the music context changes."*

### 6.7 Editor tests

Extend `tests/custom-playlist-editor.test.mjs`, `tests/custom-playlist-inspector.test.mjs` and
`tests/custom-playlist-node-render.test.mjs`:

- adding a Playlist node from the palette creates it with one output and a default ref;
- toggling Loop Forever adds/removes the output port;
- each change handler writes the expected `data` shape and re-normalizes on a source switch;
- the inspector renders the direct branch and the indirect branch, and omits the edited playlist
  from the target options;
- `computeNodeDetail` renders `refLabel × n` and `refLabel × ∞`.

---

## Phase 7 — Finish

1. `npm test` — the **whole** suite green, including the untouched pre-existing tests.
2. Add a short "Playlist node" paragraph to `README.md` beside the existing custom-playback
   section, describing direct vs indirect references and the pass rule.
3. Do not bump `module.json`'s version or touch `release_notes.txt` unless asked.

---

## Definition of done

- A Playlist node can target a playlist directly, or indirectly via the active scene's / world
  default's area or combat section, with mood handling per D2.
- A targeted playlist with its own graph runs that graph; one without runs by its native Foundry
  mode (D5).
- `loopCount` / `infinite` behave as passes, per D3.
- Self-reference, indirect cycles, over-deep nesting and unresolvable references are all refused
  safely, are logged, and keep the graph moving (D6/D7) — none of them can spin the browser.
- Tearing down an engine tears down its children; H11 crossfade behavior is preserved.
- Validation reports every case in the Phase 5 table, and the editor UI can express every legal
  reference shape.
- `npm test` is green and `lang/en.json` / `lang/pt-BR.json` are at exact key parity.
