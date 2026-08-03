# Module map

File-by-file index. **Pure** = no `game`/`ui`/DOM/Drawflow dependency, unit-testable directly —
[keep it that way](../../CLAUDE.md#conventions).

Line counts are approximate and will drift; they're here to signal weight, not as a contract.

---

## Entry & wiring

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/game-orchestra.mjs` | 63 | Entry point. Builds `game.gameOrchestra`, registers settings/keybindings, preloads templates, wires every hook. |
| `scripts/hooks.mjs` | 384 | All hook handlers. Button injection into Scene/Token/Playlist config; combat/scene/flag change → `playCurrentTrack()`; phase reset on `deleteCombat` (O9). |
| `scripts/config.mjs` | 49 | `CONST`: module id, setting keys, default moods/phases, baseline section priorities, `sectionAxis`/`overlayAxes` (O1/O3). **Pure.** |
| `scripts/settings.mjs` | 277 | Setting + keybinding registration, `onChange` handlers, suppression toggles. `activePhase`/`configuredPhases` mirror `activeMood`/`configuredMoods` exactly. |

## Playback core

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/music-controller.mjs` | 1021 | **The singleton decision-maker.** Context resolution, priority, transitions, crossfade, position memory, restored-playback reconciliation, and the additive layer (`_layerEngine`, a second root engine beside `_customEngine`). |
| `scripts/helpers.mjs` | 525 | `PlaylistContext` (`isOverlay`, `overlayAxis`), `FadingTrack`, `isHeadGM`, `isCustomPlaylist`, `getCustomGraph`, `resolveInitialTrack`, `resolvePlaylistRef`, `readMusicSection`, `getActiveOverlayId(axis)`, `log`. The Foundry-touching side of several pure modules. |

## Graph engine

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/custom-playback-engine.mjs` | 2424 | **The token-walk engine.** Per-node behavior (`loop.mode` switch: `count`/`forever`/`until`), singleton rule, sound ownership, hand-off latency (pending stops, preload lookahead, per-playlist/world crossfade), drain timings, idle detection, child engines, every safety net. |
| `scripts/custom-playback-schema.mjs` | 236 | Graph/node/edge typedefs, `LoopSpec` union + `resolveLoop()`, durational vs instantaneous sets, `findUpcomingTrackNodes()` (preload lookahead), `resolveGraphCrossfadeMs()` (per-playlist crossfade override), `createEmptyGraph()`. **Pure.** |
| `scripts/engine-clock.mjs` | 174 | Worker-backed scheduler with absolute due-times (H4), 100ms tick + `precise` mode for audible boundaries. |
| `scripts/audio-end-watcher.mjs` | 79 | `'end'`-only listener management on `Sound` instances (H3). |
| `scripts/native-mode-graph.mjs` | 115 | Synthesizes a one-pass graph from a native playlist's Foundry mode. **Pure.** |
| `scripts/playlist-ref.mjs` | 133 | Playlist-node reference normalization, axis-aware resolution, description. **Pure.** |
| `scripts/graph-builder.mjs` | 94 | Shared programmatic graph construction; enforces numeric ids + port-order edges; `track()`'s `loop` option overrides `infinite` with any full `LoopSpec`. **Pure.** |
| `scripts/graph-presets.mjs` | 221 | Eight starter graphs, including `loop-until-combat-ends`. **Pure.** |

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
| `scripts/graph-history.mjs` | 175 | Undo/redo past/present/future stack over editor snapshots; `snapshotKey()` decides what counts as the same state — including the pane's **levels**. **Pure.** |

## Mixer

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/playlist-mixer-controller.mjs` | 560 | **`MixerController` — everything the mixer *does***, with no opinion about its host. Shared by the standalone window and the graph editor's Mixer pane; hosts supply an `onRefresh` callback, because one re-renders freely and the other must never call `render()` (HR-A). |
| `scripts/playlist-mixer.mjs` | 100 | `PlaylistMixerApp` — the standalone window, a thin ApplicationV2 shell over the controller. One per playlist, **every playlist type**. |
| `scripts/playlist-mixer-render.mjs` | 290 | The mixer body as an HTML string: full, `compact` (the editor's 300px pane), and `graphTools` (rows as canvas drag sources with add-node buttons). Supersedes the deleted `custom-playlist-tracks.mjs`. **Pure.** |
| `scripts/playlist-mix.mjs` | 254 | The mix model: `effectiveVolume()`, `clampVolume()`, `normalizeMix()`, `resolveCrossfadeMs()` (the three-link chain), `applyGroupGain()`, `coerceDuckFactor()`. **Pure.** |
| `scripts/playlist-mix-apply.mjs` | 245 | Applies a mix to live audio, holds session solo state, and reads the `activeDuck` world setting (`duckFactorFor`, `reassertDuck`). **Runs on every client** — the one part of the module that is not head-GM-only. |

## Other UI

| File | ~LoC | Purpose |
|---|---|---|
| `scripts/app.mjs` | 664 | `GameOrchestraConfig` — per-scene/token music config. Token documents render a phase-only grid (`isTokenPhaseGrid`); Scene renders mood tabs for area and phase tabs for combat. |
| `scripts/playlist-tree.mjs` | 748 | `PlaylistTreeApp` — every scene's assignments in one tree, mood and phase rows both. |
| `scripts/mood-widget.mjs` | 351 | `MoodWidget` — dockable switcher: moods when idle, phases during combat, showing only the active axis. |
| `scripts/mood-config.mjs` | 252 | `OverlayConfigApp` base class + `MoodConfigApp`/`PhaseConfigApp` subclasses — one small app, two axes, structurally identical. Refuses to delete the axis's currently active entry. |
| `scripts/app-mixins.mjs` | 113 | Shared ApplicationV2 plumbing + `dispatchChangeAction()`. |

## Assets

| Path | Notes |
|---|---|
| `templates/*.hbs` | 5 templates (`mood-config.hbs` was replaced by `overlay-config.hbs`). `playlist-tree.hbs` (516) and `music-config.hbs` (214) are the large ones. |
| `styles/game-orchestra.css` | ~2390 lines. **Specificity-critical** — see HR-C. |
| `lang/en.json`, `lang/pt-BR.json` | 354 keys each. **Must stay key-identical** (HR-E). |
| `scripts/vendor/drawflow.min.*` | Vendored UMD build + CSS. Read `scripts/vendor/README.md` before touching. |
| `module.json` | Manifest. Script/style **order is load-bearing** and test-guarded. |

## Docs

| Path | Status |
|---|---|
| `CLAUDE.md` | Always-loaded agent instructions. |
| `docs/wiki/*.md` | **This wiki.** Maintained. |
| `docs/overlays-and-loop-modes-plan.md` | **Archived plan.** Overlay axes (`O1`–`O10`) + loop modes (`L1`–`L7`) — both fully implemented; durable content folded into this wiki. |
| `docs/playlist-node-plan.md` | **Archived plan.** Cited by code as `D1`–`D8`, `Phase 4.4`, etc. Do not move or rename. |
| `docs/graph-editor-panel-plan.md` | **Archived plan.** Cited as `D2`, `D8`, `HR-A`–`HR-D`. Do not move or rename. |
| `docs/custom-playlist-plan.md` | **Missing.** Cited by ~16 comments. Reconstructed in [invariants.md](invariants.md). |
| `docs/playlist-mixer-plan.md` | **Archived plan.** The mixer's design; implemented. |

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
