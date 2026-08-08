# Module map

File-by-file index. **Pure** = no `game`/`ui`/DOM/Drawflow dependency, unit-testable directly —
[keep it that way](../../CLAUDE.md#conventions).

Line counts are approximate and will drift; they're here to signal weight, not as a contract.

---

## Entry & wiring

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/game-orchestra.mjs` | 120 | Entry point. Publishes **one** object at both `game.modules.get(id).api` and `game.gameOrchestra` (legacy class keys warn once each via `logCompatibilityWarning`), registers settings/keybindings, preloads templates, wires every hook. |
| `scripts/api.mjs` | 640 | **The public API** — the only surface a third party depends on. A facade with no logic of its own: five namespaces by job (`transport`/`bind`/`graph`/`mix`/`playback`), `GameOrchestraApiError`, the head-GM and GM gates, and the headless PrototypeToken binding store. See [api.md](api.md). |
| `scripts/hooks.mjs` | 375 | All hook handlers. Button injection into Scene/Token/Playlist config (Scene opens the **scoped hub**); scene-control suppression toggles built from `transport.mjs`; combat/scene/flag change → `playCurrentTrack()`; phase reset on `deleteCombat` (O9). |
| `scripts/config.mjs` | 90 | `CONST`: module id, setting keys, default moods/phases, baseline section priorities, `sectionAxis`/`overlayAxes` (O1/O3), and `hooks` — every hook the module fires, published as `api.hooks`. **Pure.** |
| `scripts/settings.mjs` | 290 | Setting + keybinding registration, `onChange` handlers, suppression toggles. **Exactly one `registerMenu` entry** (docs/wiki/ux.md UX-4). `activePhase`/`configuredPhases` mirror `activeMood`/`configuredMoods` exactly. |

## Playback core

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/music-controller.mjs` | 1574 | **The singleton decision-maker.** Context resolution, priority, transitions, crossfade, position memory, restored-playback reconciliation, the additive layers (`_layers`, one independent root engine per layer beside `_customEngine`), and suspended-run snapshots (`_suspendedRuns`, `_retainablePlaylistIds` — H9). |
| `scripts/helpers.mjs` | 640 | `PlaylistContext` (`isOverlay`, `overlayAxis`), `FadingTrack`, `isHeadGM`, `isCustomPlaylist`, `getCustomGraph`, `resolveInitialTrack`, `resolvePlaylistRef`, `readMusicSection`, `getActiveOverlayId(axis)`, `sectionBaselinePriority()` (the scope hierarchy, applied at resolution time — never written to a flag), `writeCustomGraph`/`removeCustomGraph` (the **shared** graph writer — H1/H2 enforcement both the editor and the API route through), `describePlaylistContext`, `emitHook` (the non-fatal hook wrapper — the only place `Hooks.callAll` may be called), `log`. The Foundry-touching side of several pure modules. |

## Graph engine

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/custom-playback-engine.mjs` | 2949 | **The token-walk engine.** Per-node behavior (`loop.mode` switch: `count`/`forever`/`until`), singleton rule, sound ownership, hand-off latency (pending stops, preload lookahead, per-playlist/world crossfade), drain timings, idle detection, child engines, `suspend()`/`resume()` snapshots, every safety net. |
| `scripts/custom-playback-schema.mjs` | 236 | Graph/node/edge typedefs, `LoopSpec` union + `resolveLoop()`, durational vs instantaneous sets, `findUpcomingTrackNodes()` (preload lookahead), `resolveGraphCrossfadeMs()` (per-playlist crossfade override), `createEmptyGraph()`. **Pure.** |
| `scripts/engine-clock.mjs` | 174 | Worker-backed scheduler with absolute due-times (H4), 100ms tick + `precise` mode for audible boundaries. |
| `scripts/audio-end-watcher.mjs` | 79 | `'end'`-only listener management on `Sound` instances (H3). |
| `scripts/native-mode-graph.mjs` | 115 | Synthesizes a one-pass graph from a native playlist's Foundry mode. **Pure.** |
| `scripts/playlist-ref.mjs` | 133 | Playlist-node reference normalization, axis-aware resolution, description. **Pure.** |
| `scripts/graph-builder.mjs` | 94 | Shared programmatic graph construction; enforces numeric ids + port-order edges; `track()`'s `loop` option overrides `infinite` with any full `LoopSpec`. **Pure.** |
| `scripts/graph-presets.mjs` | 221 | Eight starter graphs, including `loop-until-combat-ends`. **Pure.** |
| `scripts/script-runtime.mjs` | 250 | **Everything about user-supplied code**: the runtime CSP probe (`canCompileScripts`), the one execution gate (`inlineScriptsAllowed`), compile-and-cache for both shapes, the re-entrancy registry behind `SELF_REENTRANT`, and `reportScriptError`. Not a sandbox — see its header. |

## Editor

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/custom-playlist-editor.mjs` | 2300 | The ApplicationV2 + Drawflow window. Mount, inspector dispatch, node/exit CRUD, drop handling, save, and the Mixer pane (`_renderMixer()`, a compact MixerController). The Settings pane and its crossfade field are gone — levels are set in the mix now. Single-open accordion (`handleTogglePane`); `_renderTracks()` rebinds DragDrop; `_deleteMultiSelection()` covers what Drawflow's Delete cannot. |
| `scripts/editor-selection-mixin.mjs` | 335 | Marquee rect-select and group drag. |
| `scripts/editor-highlight-mixin.mjs` | 200 | Live playback highlight painting; `_setNodeDrain()` (Delay + Track drain overlays); `_nodeElement()`/`_connectionElements()`. |
| `scripts/graph-drawflow-bridge.mjs` | 215 | CustomGraph ⇄ Drawflow JSON; the `data.exits[]` contract (H5); routes a Track's `loop` through `resolveLoop()` on both directions so `until` survives the round-trip. **Pure.** |
| `scripts/graph-validation.mjs` | 327 | 39 validation rules (Track's are a `loop.mode` switch); emits i18n keys. **Pure.** |
| `scripts/custom-playlist-inspector.mjs` | 516 | Inspector + validation panel as HTML strings, including the `loop.mode` fields, `buildUntilLoopFieldsHtml()` and `buildIssueBalloonHtml()`. A Track's sound is read-only here. **Pure.** |
| `scripts/custom-playlist-node-render.mjs` | 217 | Node content, labels, sizing, `zoomTier()`, `DRAIN_NODE_TYPES`, `escapeHtml`. **Pure.** |
| `scripts/custom-playlist-connection-render.mjs` | 313 | Wire routing (`buildRoutedPath`), self-loop SVG path override, `uncertainEdges()`, `connectionPortSelectors()`. **Pure.** |
| `scripts/graph-activity-highlight.mjs` | 126 | Activity payload → node/edge highlight sets + selectors. **Pure.** |
| `scripts/graph-drop.mjs` | 42 | Drag-in rule matrix. **Pure.** |
| `scripts/graph-splice.mjs` | 96 | Rewiring plans for the two gestures that change a graph's shape with no wire drawn by hand: `planEdgeInsertion()` (drop onto an edge) and `planNodeBypass()` (delete heals the chain). **Pure.** Documents Drawflow's asymmetric connection-record naming, where both `input` and `output` name the *far* end. |
| `scripts/graph-decorations.mjs` | 92 | The editor's marker attributes for Drawflow **ports and wires**, plus `setMarker()`/`clearMarkers()`. A class here breaks the vendor's positional `classList` reads — HR-K, and the file opens with the delete-an-exit bug that proved it. |
| `scripts/graph-history.mjs` | 175 | Undo/redo past/present/future stack over editor snapshots; `snapshotKey()` decides what counts as the same state — including the pane's **levels**. **Pure.** |

## Mixer

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/playlist-mixer-controller.mjs` | 560 | **`MixerController` — everything the mixer *does***, with no opinion about its host. Shared by the standalone window and the graph editor's Mixer pane; hosts supply an `onRefresh` callback, because one re-renders freely and the other must never call `render()` (HR-A). |
| `scripts/playlist-mixer.mjs` | 100 | `PlaylistMixerApp` — the standalone window, a thin ApplicationV2 shell over the controller. One per playlist, **every playlist type**. |
| `scripts/playlist-mixer-render.mjs` | 290 | The mixer body as an HTML string: full, `compact` (the editor's 300px pane), and `graphTools` (rows as canvas drag sources with add-node buttons). Supersedes the deleted `custom-playlist-tracks.mjs`. **Pure.** |
| `scripts/playlist-mix.mjs` | 254 | The mix model: `effectiveVolume()`, `clampVolume()`, `normalizeMix()`, `resolveCrossfadeMs()` (the three-link chain), `applyGroupGain()`, `coerceDuckFactor()`. **Pure.** |
| `scripts/playlist-mix-apply.mjs` | 290 | Applies a mix to live audio, holds session solo state, owns the only writers for the `mix` flag (`patchPlaylistMix`, `setPlaylistMuted` — shared by `MixerController` and the API), and reads the `activeDuck` world setting (`duckFactorFor`, `reassertDuck`). **Runs on every client** — the one part of the module that is not head-GM-only. |

## Shared UI cores

Host-agnostic modules owning *behaviour* that more than one surface needs, so no surface carries a
second copy of it (docs/wiki/ux.md UX-2). `playlist-mixer-controller.mjs` above is the third.

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/binding-store.mjs` | 340 | **The write half of J1 (Bind).** `BindingStore` = `{get, apply(plan)}` over one backend — `documentFlagStore` (Scene/Actor/Token flags), `updateObjectStore` (the PrototypeToken `updateObject` path), `globalSettingStore` (`defaultMusic`). `storeForTarget()` picks between them and is the **only** copy of the prototype-token dot-path write (HR-J) — three callers share it. Operations on top: `applyBindingPlaylist` / `applyBindingTrack` / `applyBindingLayer` / `applyBindingDuck` / `applyBindingExclusive` / `applyBindingPriority` / `clearBindingOverlay`. **Writes are whole plans, never per-path** — see the typedef. Ops are pure given a store. |
| `scripts/binding-cards.mjs` | 105 | **The read half of J1.** `buildCombatPhaseGrid()` — one document's phase card grid, section default and `exclusive`/`duck`, for the hub's Actors group and `GameOrchestraConfig` alike. **Pure**: the caller reads live state and passes it in, including the collapse predicate and its own action names. |
| `scripts/transport.mjs` | 155 | **J5 (Perform).** `SUPPRESSION_CONTROLS` + `suppressionState()` + `setSuppression()` (shared by the Mood Widget, the scene-control bar and the keybindings), `describeResolution()` and `isBindingEligible()` — both **pure**, emitting i18n keys — plus `resolutionPills()` for the two status pills the hub and the widget both show. |

## Other UI

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/app.mjs` | 430 | `GameOrchestraConfig` — **legacy** per-document binding window. Nothing in the module opens it any more (token sheets route to the scoped hub, scenes did in step 6a); it survives for macros holding the deprecated `game.gameOrchestra.GameOrchestraConfig`. Renders the *shared* view model and partial, so it cannot drift from the hub. Non-modal, no Save — every control writes immediately. |
| `scripts/playlist-tree.mjs` | 1100 | `PlaylistTreeApp` — the hub. Three collapsible groups (**Actors / Scenes / World**), each opening on what is *audible* rather than on what is merely configured. `_ENTRY_SPECS` × `_handleEntryAction` generate every update/clear handler from three axes (scope, field, overlay-scoped); `_targetFor()` resolves scene and world from instance state but an **actor from the element**, since many rows render at once. Actors are added by dropping one on `.actor-add-zone`. |
| `scripts/mood-widget.mjs` | 351 | `MoodWidget` — dockable switcher: moods when idle, phases during combat, showing only the active axis. |
| `scripts/mood-config.mjs` | 330 | `OverlayConfigApp` — the world's overlay dictionary as **one window with a Moods tab and a Phases tab**. `MoodConfigApp`/`PhaseConfigApp` remain as doors sharing its `id`, choosing only the opening tab. Holds both lists in `itemsByAxis`; one Save commits both. Refuses to delete the axis's currently active entry. |
| `scripts/app-mixins.mjs` | 113 | Shared ApplicationV2 plumbing + `dispatchChangeAction()`. |

## Assets

| Path | Notes |
|---|---|
| `templates/*.hbs` | 5 templates (`mood-config.hbs` was replaced by `overlay-config.hbs`). `playlist-tree.hbs` (~790) is the large one; `music-config.hbs` is now ~25 lines, since it renders the shared partial. |
| `templates/parts/*.hbs` | **Partials**, included by full path and registered in `game-orchestra.mjs`'s `loadTemplates`. `combat-grid.hbs` — one document's phase grid + default + `exclusive`/`duck`, shared by the hub's Actors group and `GameOrchestraConfig`. `binding-tools.hbs` — the graph and mixer buttons plus the UX-7 "layering now" / "beaten by" lines, on every bound row in both. `tools/build.mjs` must walk this directory **recursively** or the release ships without them. |
| `styles/game-orchestra.css` | ~2390 lines. **Specificity-critical** — see HR-C. |
| `lang/en.json`, `lang/pt-BR.json` | 354 keys each. **Must stay key-identical** (HR-E). |
| `scripts/vendor/drawflow.min.*` | Vendored UMD build + CSS. Read `scripts/vendor/README.md` before touching. |
| `module.json` | Manifest. Script/style **order is load-bearing** and test-guarded. |

## Integration tier (`itest/`)

Separate package, separate `node_modules` — Playwright plus a browser is ~400 MB and must not
weigh on `npm test`. Full design in [integration-testing.md](integration-testing.md).

| Path | Purity | Notes |
|---|---|---|
| `itest/harness/tones.mjs` | **pure** | The fixture tone table, audibility floor, harmonic guard. Solved, not chosen — see the file header. |
| `itest/harness/goertzel.mjs` | **pure** | Amplitude detector. **Shared with the worklet by source concatenation**, so no imports and no `export class`. |
| `itest/harness/analysis.mjs` | **pure** | Segments, entry order, crossfade, level ratios, ASCII timeline. |
| `itest/fixtures/generate.mjs` | node | Renders the tone bank to WAV. Fixtures are generated, never committed. |
| `itest/harness/worklet-source.mjs` | node | Assembles the worklet source and validates the `export` strip. |
| `itest/harness/probe-init.js` | browser | Patches `AudioNode.prototype.connect` before any page script. Classic script, no imports. |
| `itest/harness/probe-worklet.js` | worklet | The processor. **Not standalone** — `goertzel.mjs` is prepended. |
| `itest/harness/session.mjs` | Playwright | `gm`/`player` fixtures, probe health, `record*`. |
| `itest/harness/foundry-api.mjs` | Playwright | World provisioning via Foundry's document API — never via the module's UI. |
| `itest/harness/expect-audio.mjs` | Playwright | The assertions specs call. |
| `itest/specs/NNN-*.spec.mjs` | Playwright | Scenarios: combat transitions, graph playback, ducking, two-client mixer, Fork/Random/Delay nodes. Numbered — the prefix decides what still reports when CI aborts on `maxFailures`; see [integration-testing.md](integration-testing.md#spec-ordering). |

The first four are exercised by the **main** vitest suite (`tests/itest-{analysis,goertzel}.test.mjs`).
Keep them pure — that is the only reason the harness's own correctness is knowable.

## Docs

| Path | Status |
|---|---|
| `CLAUDE.md` | Always-loaded agent instructions. |
| `docs/wiki/*.md` | **This wiki.** Maintained. |
| `docs/api-and-script-node-plan.md` | **Active plan.** Part A (the public API) is shipped; Part B (the Script node) is not started. |
| `docs/overlays-and-loop-modes-plan.md` | **Archived plan.** Overlay axes (`O1`–`O10`) + loop modes (`L1`–`L7`) — both fully implemented; durable content folded into this wiki. |
| `docs/playlist-node-plan.md` | **Archived plan.** Cited by code as `D1`–`D8`, `Phase 4.4`, etc. Do not move or rename. |
| `docs/graph-editor-panel-plan.md` | **Archived plan.** Cited as `D2`, `D8`, `HR-A`–`HR-D`. Do not move or rename. |
| `docs/custom-playlist-plan.md` | **Missing.** Cited by ~16 comments. Reconstructed in [invariants.md](invariants.md). |
| `docs/playlist-mixer-plan.md` | **Archived plan.** The mixer's design; implemented. |
| `itest/README.md` | Quickstart for the audio tier; the reasoning lives in the wiki page. |

---

## Dependency shape

```
game-orchestra.mjs
  ├── settings.mjs ──┬── mood-config.mjs
  │                  ├── mood-widget.mjs ── playlist-tree.mjs
  │                  └── helpers.mjs
  ├── hooks.mjs ─────┬── app.mjs ── app-mixins.mjs
  │                  └── custom-playlist-editor.mjs
  │                        ├── editor-selection-mixin.mjs
  │                        ├── editor-highlight-mixin.mjs ── graph-activity-highlight.mjs
  │                        ├── graph-drawflow-bridge.mjs
  │                        ├── graph-validation.mjs
  │                        ├── custom-playlist-{inspector,node-render,tracks,connection-render}.mjs
  │                        ├── graph-{presets,drop,history}.mjs
  │                        └── playlist-ref.mjs
  └── music-controller.mjs
        ├── helpers.mjs ── playlist-ref.mjs
        └── custom-playback-engine.mjs
              ├── engine-clock.mjs
              ├── audio-end-watcher.mjs
              ├── native-mode-graph.mjs ── graph-builder.mjs
              └── (recursively: child CustomPlaybackEngine)
```

`config.mjs` and `custom-playback-schema.mjs` are leaves imported nearly everywhere.

There is one deliberate cycle-ish edge: `helpers.mjs#FadingTrack.delete()` reaches back into
`game.gameOrchestra.musicController` through the global rather than importing it.
