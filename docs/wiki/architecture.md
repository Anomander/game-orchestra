# Architecture

How a change in game state becomes a change in audio.

---

## Execution model

The module loads as one native ESM graph from `scripts/game-orchestra.mjs` (declared in `module.json`
`esmodules`). No bundler, no build step.

`Hooks.once('init')` builds the single global namespace:

```js
game.gameOrchestra = {
  musicController,   // the singleton MusicController — all playback decisions
  GameOrchestraConfig,     // per-scene / per-token music config window
  MoodWidget,        // dockable mood/phase switcher
  MoodConfigApp,     // world mood definitions
  PhaseConfigApp,    // world phase definitions (same axis mechanism, see below)
  CustomPlaylistEditor,
  moodWidget: null,  // live instance, when open
  playlistTree: …    // live PlaylistTreeApp instance, when open
};
```

Everything else is Foundry hooks wired in `game-orchestra.mjs` to handlers in `hooks.mjs`.

### One client decides

`isHeadGM()` — *the first active GM sorted by user id* — is the only client that resolves
contexts, starts/stops sounds, or runs a playback graph. Every other client, including other
GMs, simply observes the resulting `PlaylistSound` document state through Foundry's normal
multi-client sync.

Headship can change on **either a connect or a disconnect**, so `handleUserConnected` re-runs
`playCurrentTrack()` on every client. That is safe: the method internally no-ops for anyone who
isn't currently head GM.

A consequence worth knowing: the graph editor's live playback highlight only ever lights up on
the head GM's own client, because the engine broadcasts `gameOrchestraGraphActivity` locally via
`Hooks.callAll` and nothing crosses a socket. The editor says so in its own UI when it can't
show a highlight.

---

## The playback pipeline

Every music decision funnels through one method: **`MusicController.playCurrentTrack()`**.

```
game state change (combat, scene, mood, flags, settings)
        │
        ▼
  hooks.mjs handler
        │
        ▼
MusicController.playCurrentTrack()
        │
        ├─ 1. head-GM gate
        ├─ 2. audio-lock gate
        ├─ 3. one-shot reconcileRestoredPlayback()
        ├─ 4. debounce gate
        │
        ▼
  getAllCurrentPlaylists()          → candidate PlaylistContexts
        ▼
  filterPlaylists()                 → drop unstarted/suppressed
        ▼
  excludeAreaWhenCombatApplies()    → combat categorically beats area
        ▼
  sortPlaylists()                   → current combatant first, then priority
        ▼
  winner = validContexts[0]
        ▼
  contextUnchanged && audioPlaying? → return, change nothing
        ▼
  transitionToContext(winner)
        ├─ custom playlist? → CustomPlaybackEngine   (see graph-engine.md)
        └─ native playlist? → crossfade + playTrack
```

### 1–2. The gates

**Head GM.** Non-head clients return immediately.

**Audio lock.** Browsers require a user gesture before audio can play. When
`game.audio.locked`, the controller registers one-shot `pointerdown`/`keydown` listeners and
retries 100 ms after the first gesture.

### 3. Reconciling a previous session — `reconcileRestoredPlayback()`

Runs exactly once per session, and **deliberately here rather than on `ready`.**

A `PlaylistSound`'s `playing` field lives in the **world database**, and Foundry restores playback
for every sound still marked playing when a client loads. A hard refresh gives this module no
teardown path at all — the page is gone before `CustomPlaybackEngine.stop()` can run — so
whatever a graph had in flight (with a Fork, legitimately several tracks) stays marked playing
and comes back on the next load. The engine then starts a fresh run from Start *on top of it*,
and the resurrected sounds play forever: they belong to no node, so no watcher, scheduled stop,
or later transition ever touches them.

`transitionToContext()`'s fade-out loop can't clean them up either — they're skipped twice over,
once as members of the target playlist and once for not being in the (empty after a reload)
`_managedSoundIds` set.

The placement matters: this is the first point in the session where audio is known to be
**unlocked**, so Foundry has already flushed the playback it had queued behind the first-gesture
requirement. Reconciling earlier would mean stopping sounds that were still only queued, then
watching them start anyway a moment later.

Only **custom** playlists are reconciled — graphs always restart from Start (H9), so nothing of a
previous run should survive. Native playlists keep resuming across a refresh as they always have.
The scan follows Playlist-node references transitively (including *indirect* ones, since this
runs on the head GM with a ready game and live scene/mood state), because a Playlist node
commonly targets a plain native playlist that the top-level loop would never otherwise examine.

### 4. Debounce

A 150 ms trailing debounce. Calls arriving while debouncing set `_pendingDebouncedPlay` and are
replayed once afterward, so a rapid burst of mood changes resolves cleanly to one final answer.

---

## Context resolution

A **`PlaylistContext`** (`helpers.mjs`) binds together: a context type (`'area'` | `'combat'`),
the entity that supplied it, the resolved playlist, an optional track override, a priority, and a
scope entity used for position memory.

### Where candidates come from

| Source | Contexts contributed |
|---|---|
| Active scene | `area` and `combat` |
| The combatant **whose turn it is**, if not defeated | `combat`, from token / actor / prototype token |
| World default music setting | `combat` (only during combat) and `area` |

**A token/actor override is a *turn* theme, not a fight theme.** Only `combat.combatant` — the
combatant currently taking its turn — is consulted; the rest of the tracker contributes nothing.
When the turn passes to someone with no override of their own, resolution falls through to scene
combat and then the world default, rather than leaving the previous combatant's theme in the pool.
Collecting from every non-defeated combatant (which this used to do) kept the first configured
combatant's context alive for the whole fight, and since token combat outranks scene combat
(`+20` vs `-15`) it won every turn — the current-combatant-first rule below could never demote
it, because unconfigured combatants contribute nothing for it to be promoted over.

`_getCombatantMusicSources()` returns every document that may speak for that combatant, most
specific first. The caller takes the **first one that actually carries an override** — they are
fallbacks, not competitors, so a combatant contributes at most one context:

- **Linked token** → *actor* → *prototype token*. The token's own flags are skipped entirely
  unless it sets `useTokenMusic` (a linked token inherits the prototype's flags at creation, so
  honouring them would make every linked token silently override its actor).
- **Unlinked token**, or linked with `useTokenMusic` → *token* → *prototype token* → *actor*.

The prototype token stays in the chain **even when a placed token exists**. It is where the
token sheet's config window writes whenever it was opened from an Actor's prototype token, and a
placed token only ever holds a *copy* of the prototype's flags taken at creation time — so
without it, a prototype-level assignment saves, re-reads in its own window, and is then never
consulted (H14).

### Overlay axes

Mood and phase are one mechanism on two axes: an overlay keyed by an id, selected by a world
setting, bound to a section (`overlays-and-loop-modes-plan.md` O1).

| Section | Axis | Active-id setting | Definitions setting |
|---|---|---|---|
| `area` | `mood` | `activeMood` | `configuredMoods` |
| `combat` | `phase` | `activePhase` | `configuredPhases` |

`config.mjs#sectionAxis` maps section → axis; `config.mjs#overlayAxes` maps axis → its two setting
names. Both tables are hardcoded, not user-extensible — two axes bound to two sections.

Each music section is `{ playlist, initialTrack, priority, overlays: { [overlayId]: {…} } }` — one
storage key for both axes (not `moods`/`phases` split by section; there is no released-world data
to migrate around, so the asymmetric shape was never built). When the section's active-axis
overlay has a config with a playlist, that config replaces the section's base config **and gets a
+10 priority offset** — this is how a mood- or phase-specific playlist outranks the same section's
default without any explicit priority juggling.

Baseline priorities live in `config.mjs`: scene area `-20`, scene combat `-15`, token combat
`+20`.

`PlaylistContext.fromDocument(document, type, scopeEntity, overlayId)`'s fourth parameter defaults
to reading the setting named by `CONST.overlayAxes[CONST.sectionAxis[type]].activeSetting` when
omitted, so most call sites never need to know which axis they're on. `_extractSectionConfig`
itself is axis-agnostic — it only ever reads `section.overlays[overlayId]`.

**Moods keep applying during combat at the graph layer even though they stop feeding
combat-section *resolution*.** `excludeAreaWhenCombatApplies()` already drops every area context
outright whenever a combat context survives filtering, so `activeMood` has no effect on which
*section* wins during a fight — but it is never cleared or frozen, and continues to drive area
music the instant combat ends, `kind: 'mood'` graph conditions, and Playlist nodes whose reference
targets the `area` section. This split (resolution vs. graph layer) is easy to get backwards —
see `overlays-and-loop-modes-plan.md` O10.

`activePhase` resets to `configuredPhases[0].id` on `deleteCombat`, gated behind the
`resetPhaseOnCombatEnd` world setting (default `true`, O9) — without it, every fight after the
first would start already in whatever phase the previous fight ended on (e.g. `Enrage`).

### Selection

1. **Filter** — combat contexts require `combat.started`; either kind can be suppressed by its
   setting.
2. **Combat categorically overrides area.** Not a priority contest: if *any* combat context
   survives filtering, every area context is dropped outright.
3. **Sort** — the current combatant's own context wins first; otherwise by descending priority.
   Since only the current combatant contributes a combat context at all, the first rule is a
   safety net rather than the mechanism: it keeps a turn theme on top even if a scene section has
   been given a hand-edited priority above the `+20` token baseline.

### Track resolution

`PlaylistContext.tracks` is lazily computed and cached, and dispatches in this order:

1. **Custom playlist** → the graph's reachable sounds (checked first — H2).
2. **Explicit `trackId`** → that one sound.
3. **Playlist mode** → `SIMULTANEOUS` all sounds; `SHUFFLE` the already-playing sound if there is
   one, else a random pick; `UNSEQUENCED` nothing; otherwise the first sound in `playbackOrder`.

> The `SHUFFLE` branch deliberately reuses the currently-playing sound rather than re-rolling on
> every evaluation — otherwise any unrelated re-resolution would jump to a different track.

---

## Transitions — `transitionToContext()`

```
┌─ already running this exact graph? ──────────────┐
│  leave it alone, refreshOverlayReactiveTargets() │  ← the guard, below
└──────────────────────────────────────────────────┘
        │ no
        ▼
  retire engine with stop({ stopAudio: false })     ← H11
  save positions of outgoing tracks
  fade out managed sounds not in the target
        │
        ├─ target is custom → new CustomPlaybackEngine, currentTracks = []   ← H9
        └─ target is native → pausedTime batch-update, playTrack, fade in
```

### The already-running guard

If the resolved winner is a custom playlist whose engine is **already running**, the transition
is skipped entirely.

Without this, every re-evaluation that resolves to the same running graph would fall through to
the unconditional engine-retire/rebuild and **restart the graph from Start** — including for
completely unrelated reasons, since `playCurrentTrack()` re-resolves on every `activeMood`
change whether or not the winning context depends on mood at all.

`onCustomGraphChanged()` bypasses this guard deliberately (by nulling `currentContext` and
`_customEngine` first) for the one case where a real restart *is* wanted: a live edit to the
running graph (H8).

The guard still calls `refreshOverlayReactiveTargets()`, because a nested Playlist node whose own
reference tracks the active mood or phase must react even though the root graph's position must
not be disturbed. See [graph-engine.md](graph-engine.md).

### Not restarting what's already playing

Two separate checks prevent audible restarts:

- `playCurrentTrack()` returns early when the context is unchanged **and** audio is genuinely
  playing (`t.playing || t.sound?.playing`). If the context is unchanged but audio has stopped,
  it restarts.
- `transitionToContext()` filters out target tracks that are already audibly playing.
  Re-triggering them is exactly what makes tracks restart from the beginning on every unrelated
  config change.

### Batched starts

Resume offsets are written via a single `updateEmbeddedDocuments('PlaylistSound', …)` call rather
than one round-trip per track, so a `SIMULTANEOUS` playlist's layers start **together** instead
of staggered by one document round-trip each. A per-track `update()` fallback covers APIs without
that method.

> `pausedTime` is the schema field `PlaylistSound`/`Playlist#playSound` reads to resume at an
> offset. A plain `offset` field is neither persisted nor honored.

### Superseded transitions

Each call takes a monotonic `_transitionSequenceId`. Async continuations — notably
`_fadeInWhenReady`'s retry loop — re-check it and bail, so a superseded transition's fade-in can
never land on a track a newer transition already faded out.

---

## Position memory

An in-memory LRU (`_savedPlaylistPositions`, cap 50 entities), keyed
`"<documentName>_<id>" → { soundId: offsetSeconds }`. Not persisted — it is session state.

Both reads and writes count as a "use" and move the entry to the end of the Map. Reads must
count too, or an entity whose music is merely being *checked* could be evicted while it is the
one actively playing.

Custom playlists never participate (H9).

---

## UI surface

| Window | Entry point | Notes |
|---|---|---|
| `GameOrchestraConfig` | Scene Config button, Token Config (Identity tab) | Per-document area (mood) + combat (phase) overrides. Token documents only ever show a combat/phase grid — see `isTokenPhaseGrid` |
| `PlaylistTreeApp` | Settings menu, keybinding, Mood Widget | Every scene's assignments in one tree, mood and phase rows both |
| `MoodConfigApp` / `PhaseConfigApp` | Settings menu | World mood / phase definitions — both are `OverlayConfigApp` subclasses (`mood-config.mjs`) sharing one template, differing only by axis |
| `MoodWidget` | Scene control, keybinding | Dockable switcher: moods when idle, phases once `game.combat?.started`. Shows **only** the active axis — the inactive one is not rendered at all, not even dimmed |
| `CustomPlaylistEditor` | Playlist Config button, tree, mood widget | The graph editor — see [editor.md](editor.md) |
| `PlaylistMixerApp` | Playlist Config button, playlist directory context menu, graph editor Settings pane | Levels for **any** playlist type — see [mixer.md](mixer.md) |

The first two share `GameOrchestraAppMixin` (`app-mixins.mjs`) for collapsed-section bookkeeping, the
delegated `change`/`dragleave` listeners, and the DragDrop rebind lifecycle (HR-D).
`CustomPlaylistEditor` has a wholly different lifecycle and reuses only `dispatchChangeAction()`.

Injected buttons (scene config, token config, playlist config) all follow the same shape: find a
stable anchor element, build a `.form-group` with vanilla DOM, `insertAdjacentElement('afterend')`,
and wrap the whole thing in try/catch that logs at level 1. A core rename should degrade to a
logged warning, never a thrown error.

---

## Hook wiring

| Hook | Handler | Triggers |
|---|---|---|
| `ready` | `handleReady` | Delayed first play (1 s); restores Mood Widget |
| `canvasReady` | `handleCanvasReady` | Re-resolve |
| `updateCombat` | `handleUpdateCombat` | On `started`, or turn/round while started — also refreshes the Mood Widget so it swaps strips the instant combat starts |
| `deleteCombat` | `handleDeleteCombat` (async) | Re-resolve; resets `activePhase` to `configuredPhases[0].id` when `resetPhaseOnCombatEnd` is enabled (O9) |
| `createCombatant` / `deleteCombatant` | … | Only while combat is started |
| `updateCombatant` | `handleUpdateCombatant` | On `defeated` change |
| `updateScene` | `handleUpdateScene` | On music flags or `active` change |
| `updateActor` / `updateToken` | … | On `music` / `useTokenMusic` flags |
| `updatePlaylist` | `handleUpdatePlaylist` | H8 engine rebuild **on `customPlayback` only**; a `mix` change instead re-levels in place, and refreshes an open mixer |
| `updatePlaylistSound` | `handleUpdatePlaylistSound` | Re-asserts the mix on start/volume change — **on every client** (see [mixer.md](mixer.md)) |
| `getPlaylistContextOptions` | `handlePlaylistContextMenu` | Adds the sidebar's *Mixer* entry |
| `userConnected` | `handleUserConnected` | GM handoff |
| `renderSceneConfig` / `renderTokenApplication` / `renderPlaylistConfig` | … | Button injection |
| `getSceneControlButtons` | … | Suppression toggles + widget button |

Settings `onChange` handlers are a parallel trigger path: `activeMood`, `activePhase`,
`suppressArea`, and `suppressCombat` all call `playCurrentTrack()` directly (`settings.mjs`).
`activeMood`/`activePhase` and `configuredMoods`/`configuredPhases` each also sweep
`ui.windows` + `foundry.applications.instances` to refresh any open `MoodWidget`.

---

## Storage

| What | Where |
|---|---|
| Per-document music config | Document flag `game-orchestra.music.{area,combat}` |
| Token music opt-in | Document flag `game-orchestra.useTokenMusic` |
| Custom playback graph | Playlist flag `game-orchestra.customPlayback` |
| Playlist mix (gain, clamp, mute, crossfade) | Playlist flag `game-orchestra.mix` — **deliberately a separate flag**, see [mixer.md](mixer.md) |
| Per-track volume and fade | The `PlaylistSound` document's own `volume` / `fade` fields — not a module flag |
| World default music | Setting `defaultMusic` (a synthetic `DefaultMusic` pseudo-document) |
| Moods, phases, active mood, active phase, fade, suppression, widget position | Settings (`config.mjs` § `settings`) |
| Track positions | In-memory only |

`getDocumentCategory()` normalizes the three shapes a music section can live on: a real
`Document` (flags via `getFlag`), a `PrototypeToken` (plain `flags` object), and the synthetic
`DefaultMusic` settings object (`data.game-orchestra.music`).
