# Agent playbook

Recipes for common changes. Each lists what to read, what to touch, and the specific way that
change has broken before.

---

## Before any task

1. **Run `npm test`.** Establish the baseline (931 passing) before you change anything. If it's
   already red, say so rather than absorbing it into your diff.
2. **Read the relevant wiki page**, and skim [invariants.md](invariants.md) regardless.
3. **Read the comments in the file you're changing.** They record live-confirmed failures. A
   comment explaining why the obvious approach doesn't work is usually explaining why *your* first
   instinct doesn't work.
4. **Check whether the module you're touching is [pure](../../CLAUDE.md#conventions).** If it is,
   keep it that way — reach for dependency injection, not a `game.*` read.

## Before finishing

- `npm test` green, with no reduction in test count.
- New behavior has tests. Pure modules: test directly. Foundry-touching: use the mock.
- New user-facing strings in **both** `lang/en.json` and `lang/pt-BR.json`
  (`tests/lang.test.mjs` will catch you, but adding them together is cheaper).
- New exports have JSDoc matching the surrounding density.
- If you changed something a comment describes, **update the comment.**
- If you discovered a new hazard, add it to [invariants.md](invariants.md) — that's what the page
  is for.
- State plainly what you could not verify. Drawflow interop, real audio timing, and live Foundry
  hook names are **not** covered by the suite.

---

## Recipe: add a node type

Read: [graph-engine.md](graph-engine.md), `custom-playback-schema.mjs`, `custom-playback-engine.mjs`.

Decide first: **durational or instantaneous?** That single choice determines the singleton rule,
the safety nets that apply, and how idle detection sees it.

1. `custom-playback-schema.mjs` — add to `ALL_NODE_TYPES` and to **exactly one** of
   `DURATIONAL_NODE_TYPES` / `INSTANTANEOUS_NODE_TYPES`. Extend the `GraphNode` typedef.
2. `custom-playback-engine.mjs` — add a `case` in `_enterNodeInner`, and an `_enterX(node)`.
   - Durational: register in `_activeNodes` **before the first `await`**; release through a
     dedicated `_releaseX()` helper; release + advance inside **one** `_walk()`.
   - Instantaneous: respect the `depth` parameter and pass `depth + 1` onward.
3. `graph-drawflow-bridge.mjs` — port counts in `inputCountFor`/`outputCountFor`.
4. `graph-validation.mjs` — exit arity and any field rules. New message keys.
5. `custom-playlist-node-render.mjs` — icon, label, detail line, size.
6. `custom-playlist-inspector.mjs` — the properties form.
7. `custom-playlist-editor.mjs` — `_CHANGE_ACTIONS` entries + static handlers; `NODE_DEFAULTS` +
   `NODE_PALETTE` entry (the chip reads its icon from `NODE_ICONS`, never a second list).
8. `styles/game-orchestra.css` — a shape. **Match the existing selector depth exactly** (HR-C), and
   name `.game-orchestra-node-swatch` in the same rules so the palette chip gets the shape too.
9. Both lang files.
10. Tests: engine behavior, bridge round-trip, validation, render.

**How this breaks:** forgetting the singleton registration is pre-`await`, so two converging Fork
branches both start it. Or releasing `_activeNodes` without releasing the paired map/registry,
stranding the resource for the session.

### Sub-recipe: add a `loop` mode (Track/Playlist)

`loop: { mode }` is a discriminated union (`custom-playback-schema.mjs`), not a per-mode boolean —
see [graph-engine.md](graph-engine.md) § *`loop`*. Adding a fourth mode touches the same six files
as a new node type, but node-type-shaped, not port-shaped:

1. `custom-playback-schema.mjs` — extend `LoopSpec`'s JSDoc union and `resolveLoop()`'s
   normalization. **Always** read a loop through `resolveLoop(node)`, in every file below — a
   reader that pattern-matches `node.loop.mode` directly will silently mis-handle a
   missing/malformed value differently than everywhere else.
2. `custom-playback-engine.mjs` — a branch in `_enterTrack`'s mode dispatch (after
   `resolveLoop(node)`), mirroring `_scheduleLoopStop`/`_scheduleConditionalExit`'s shape. This is
   the highest-hazard file in the module (H3/H6/H9) — read its comments before touching it, and do
   not restructure the surrounding logic while you're there.
3. `graph-validation.mjs` — a branch in the `track`/`playlist` `switch (loop.mode)`. New message
   keys in both lang files.
4. `graph-drawflow-bridge.mjs` — **must** round-trip the new mode's full shape via `resolveLoop()`
   on both `nodeDataFor()` (export) and `drawflowExportToGraph()` (import), not a partial
   forever/count-style binary. This module previously only understood `forever`/`count`, so the
   new `until` mode was silently collapsed back to `count: 1` on every edit that touched any other
   field on the node — confirmed and fixed, not hypothetical, and exactly the kind of no-console-
   error bug this whole page exists to warn about. Write a round-trip test for the new mode
   specifically, not just a "the union still validates" test.
5. `custom-playlist-inspector.mjs` — the mode-specific fields, additive alongside the existing
   ones rather than replacing a well-tested control (see `until`'s own toggle vs. the Forever
   checkbox for the precedent).
6. `custom-playlist-editor.mjs` — new `_CHANGE_ACTIONS` + handlers. Only touch the live Drawflow
   node's **port count** if the new mode changes exit arity (like `forever`'s zero exits) — a mode
   that keeps one exit, like `until`, never needs to.
7. `graph-presets.mjs` — a preset is how a new mode becomes discoverable at all.

## Recipe: change context resolution or priority

Read: [architecture.md](architecture.md) § *Context resolution*, `music-controller.mjs`,
`helpers.mjs#PlaylistContext`.

Touch: `getAllCurrentPlaylists` / `filterPlaylists` / `excludeAreaWhenCombatApplies` /
`sortPlaylists`, and `_extractSectionConfig` for the overlay (mood/phase — see
[architecture.md](architecture.md) § *Overlay axes*).

**How this breaks:** combat overriding area is *categorical*, not a priority contest — don't
"simplify" it into a priority number. The overlay `+10` offset is what makes a mood/phase override
win; a change to base priorities in `config.mjs` can silently invert that. And any new context
source must be reachable from `reconcileRestoredPlayback()` if it can involve a custom playlist.

## Recipe: add a new source of additive layers

Read: [architecture.md](architecture.md) § *Layers*, [invariants.md](invariants.md) H15,
`music-controller.mjs`.

A layer is **not** a context in the winner pool — it has no priority, never competes, and cannot be
beaten. Adding one is therefore not a change to resolution at all; it is a new entry in
`_collectLayerContexts()`.

1. **A factory that returns the context**, or null. `PlaylistContext.layerFromDocument` is the
   model: build with `isLayer: true` and priority `0`, and carry `overlayId` when the layer's
   settings live on an overlay entry rather than on the section.
2. **A stable key** in `_collectLayerContexts()` (`combatant`, `overlay:area`, `overlay:combat`).
   The key is what makes a layer replaceable in place — two sources sharing one key would evict
   each other on every re-resolution, silently.
3. **Whatever hides the layer's playlist from base resolution.** For an overlay entry that is
   `_extractSectionConfig` skipping it, so the section's own base still resolves and there is
   something to play *over*. Get this wrong and the same playlist both replaces the base and
   layers over its own replacement.
4. **`_resolveDuckFactor`** — say where this source's `duck` is stored. Section level and entry
   level are both already in use.
5. **`_collectLayerPlaylists()`** — every playlist the new source *could* pick, so
   `reconcileRestoredPlayback()` can clean up sounds a previous session left marked as playing.
   Walk every candidate, not just the live one: last session's state is unknowable from here.
6. **A UI surface that shows it is playing.** A layer never wins the base resolution, so the
   `is-resolving` badge can never light up for it (UX-7) — the tree's `layering-now` line and the
   `resolutionPills()` layer pills are the pattern.

**How this breaks:** H15 is the sharp edge — a layer whose playlist is already in the base tree, or
in another layer's tree, must be **refused**, not started. Two engines on one `PlaylistSound` steal
each other's `AudioEndWatcher` and orphan a node forever, with no error.

## Recipe: add an overlay axis

Read: [architecture.md](architecture.md) § *Overlay axes*, `config.mjs`, `mood-config.mjs`.

There are currently exactly two axes (`mood` on `area`, `phase` on `combat`), hardcoded — this is
deliberate (rejected: a data-driven/user-extensible axis list, over-engineering for two axes bound
to two sections). A third axis means a third section existing first; this recipe assumes that.

1. `config.mjs` — a new entry in `sectionAxis` (section → axis name) and `overlayAxes` (axis →
   `{ activeSetting, listSetting }`), plus a `defaultX` array of definitions.
2. `settings.mjs` — register the two settings, **mirroring the existing `activeMood`/
   `configuredMoods` (or `activePhase`/`configuredPhases`) registration exactly**, including the
   `onChange` app-refresh sweep over `ui.windows` + `foundry.applications.instances` that must
   also refresh `MoodWidget`.
3. `helpers.mjs` — nothing, if you did (1) right: `_extractSectionConfig`/`fromDocument` are
   already axis-agnostic and read `CONST.sectionAxis`/`CONST.overlayAxes` to find the right
   setting.
4. `playlist-ref.mjs` — nothing structural either, if the new axis's section is already one of
   `ref.section`'s valid values; `resolvePlaylistRefId`'s `state.activeOverlayIds` bag already
   carries every axis by name.
5. `mood-widget.mjs` — decide whether the widget shows more than one non-active axis at once, or
   only ever "the active section's axis vs. everything else". The current two-axis strip assumes
   exactly one is active at a time (idle → mood, combat → phase); a third axis active
   *simultaneously* with an existing one is a real design decision, not a mechanical extension.
6. `mood-config.mjs` — a new `OverlayConfigApp` subclass (see `MoodConfigApp`/`PhaseConfigApp`) and
   a settings-menu registration in `settings.mjs`.
7. `graph-validation.mjs` / `custom-playback-schema.mjs` — a new `GraphCondition.kind`, if the
   axis should be usable in a Condition node or a Track's `loop.mode: 'until'` escape condition
   (both share the same condition vocabulary).
8. Both lang files, throughout.

**How this breaks:** `PlaylistContext.isOverlay`/`overlayAxis` and the tree/config UI's "currently
winning" highlight are the two load-bearing renames from the mood→mood+phase split — miss one and
the highlight silently paints the wrong row instead of erroring.

## Recipe: touch the graph editor UI

Read: [editor.md](editor.md), and HR-A…HR-D in [invariants.md](invariants.md).

**How this breaks — the two classics:**

- You call `this.render()` (or something that does) to refresh after a change. Nodes select but
  stop dragging. **No error.** Use `_renderInspector()`/`_renderTracks()` instead.
- You guard `_setupDragDrop()` behind a `_bound` flag "for symmetry" with the `change` listener.
  Drag-and-drop works until the first re-render, then silently stops.

Also: keep `[data-drawflow-mount]` class-free; use `outline`, never `border`, for drop feedback;
don't reorder the node-shape selectors.

## Recipe: add a validation rule

Read: `graph-validation.mjs`, [editor.md](editor.md) § *Validation*.

1. Push `{ nodeId, nodeLabel, messageKey, messageData? }` — **never a localized string.** This
   module has no Foundry dependency and must keep none.
2. Set `nodeLabel` via `nodeDisplayLabel(node)`. Without it the message can't say which node, and
   the issue won't be click-to-focus.
3. Gate on the lookup being supplied if the rule needs one (`options.playlists`, `options.moodIds`,
   `options.phaseIds`) — the module must stay usable without a live world.
4. Add the key to both lang files.
5. Test it in `graph-validation.test.mjs`.

## Recipe: change engine timing or looping

Read: [graph-engine.md](graph-engine.md) § *Safety nets*, H3/H4/H6/H9.

- **Never use a bare `setTimeout` for engine waits.** Use `EngineClock` (H4) — a backgrounded head
  GM throttles main-thread timers to ~once per minute.
- Don't watch `'end'` on a `repeat: true` track (H3). Use a scheduled stop.
- Don't add resume-from-offset to graphs (H9). Graphs restart from Start; several code paths
  depend on it.
- The five constants are calibrated against specific failures. If you change one, say which
  failure mode you re-evaluated.

## Recipe: fix a "music restarts unexpectedly" bug

Almost always one of these four:

1. `transitionToContext`'s **already-running-graph guard** was bypassed → an unrelated
   re-resolution restarted the graph from Start.
2. The **`alreadyPlaying` check** read the stale `PlaylistSound` *document* field instead of
   `sound.sound.playing`. The document field is never corrected when audio ends naturally.
3. A track that was already playing got **re-triggered** because it wasn't filtered out of
   `tracksToStart`.
4. `playCurrentTrack`'s **`contextUnchanged`** check didn't match — note the known quirk below.

## Recipe: fix a "playback stops silently" bug

The signature failure of this codebase: a token waiting forever for an event that never comes.

Work through:

- **A watcher attached to a sound that never started.** `playTrack()` swallows
  `AbortError`/"interrupted" silently. `_enterTrack` verifies playback actually began for exactly
  this reason — check that guard is intact.
- **The stop-before-start race** ([graph-engine.md](graph-engine.md)). A `stop()` that wasn't
  awaited, followed by a new engine adopting a sound that's about to be stopped. The sound then
  fires `'stop'`, which is deliberately never treated as "advance".
- **A leaked registry entry** — `_activeNodes` released without `_registry`, making a playlist
  permanently unreferenceable.
- **Idle observed in the gap** between release and advance, because they weren't in one `_walk()`.
- **A duration probe** that exhausted its 20 attempts (missing file, decode failure).

Turn on the `enableDebug` setting: the engine logs every node hop at level 3 from a single
chokepoint, so the token's full path is traceable.

## Recipe: add a setting

`config.mjs` (key) → `settings.mjs` (register; `onChange` if it affects playback) → both lang
files → `settings.test.mjs` if structural.

If it affects playback resolution, its `onChange` should call `playCurrentTrack()` — that's the
established pattern for `activeMood`, `activePhase`, `suppressArea`, `suppressCombat`.

## Recipe: add a Foundry hook handler

`hooks.mjs` (export a named handler) → `game-orchestra.mjs` (register it) → `hooks.test.mjs`.

Handlers that inject UI must: check `game.user.isGM`, find a **stable** anchor, build with vanilla
DOM, `insertAdjacentElement('afterend')`, and wrap everything in try/catch logging at level 1. A
core rename should degrade to a logged warning, never a thrown error.

Narrow the trigger. `handleUpdatePlaylist` fires only on the `customPlayback` flag; flag handlers
check `'music' in flags` before doing work. Broad triggers cause redundant re-resolutions, and a
re-resolution is what restarts things.

---

## Known quirks — do not "fix" incidentally

- **`contextUnchanged` always fails for custom playlists.** `playCurrentTrack()` compares
  `this.currentTracks` (forced to `[]` for a custom playlist, per H9) against
  `winnerContext.tracks` (non-empty), so a custom-playlist context re-transitions on every
  re-resolution. The already-running-graph guard in `transitionToContext()` absorbs the
  consequence. Documented as out of scope in `docs/playlist-node-plan.md`. Leave it unless it's
  the actual assignment.
- **Indirect refs aren't followed by `_collectCustomGraphTracks`.** They depend on live scene/mood
  state a static walk can't evaluate. The bounded consequence: an indirectly-referenced
  sub-playlist's sound can get briefly faded on a re-resolution it didn't need — a crossfade blip,
  never wrong playback. The running engine remains the source of truth; that list only feeds the
  outer controller's fade bookkeeping.
- **`renderPlaylistConfig` and `select[name="mode"]` are unverified against live Foundry v14.**
  Flagged in `hooks.mjs` as requiring manual verification.

---

## Things this project deliberately does not have

Don't add them as a side effect of another task:

- A build step, bundler, TypeScript, or a linter.
- Runtime npm dependencies. Drawflow is **vendored** (see `scripts/vendor/README.md`).
- Sockets or custom hooks beyond `gameOrchestraGraphActivity`.
- Cross-world / compendium playlist references.
- Persisted position memory for custom graphs (H9).
