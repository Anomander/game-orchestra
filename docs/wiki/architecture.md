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
| The combatant **whose turn it is**, if not defeated, *and only if it opted into `exclusive`* | `combat`, from token / actor / prototype token |
| World default music setting | `combat` (only during combat) and `area` |

### Layers

A **layer** plays *alongside* the winner instead of against it. It is not in the candidate pool at
all — it has no priority, it never competes, and it cannot be beaten. Each one runs on its **own
independent `CustomPlaybackEngine`** beside the base one, so the base is never stopped, never
restarts, and has nothing to resume (which matters: position memory can't help a graph — H9).

There are **two sources of layers, and both can be live at once.** `_collectLayerContexts()`
returns them keyed by which one asked, and `_syncLayers()` reconciles that map against
`_layers` — so a combatant's theme swapping as the turn passes never disturbs a phase overlay
layering over the same fight.

| Key | Source | Opt-in | Section |
|---|---|---|---|
| `combatant` | The current combatant's theme (`getCombatantLayerContext()`) | **opt-*out*** — `music.combat.exclusive` makes it replace instead | `combat` |
| `overlay:area` | A **mood** entry marked `layer` (`getOverlayLayerContexts()`) | opt-in — `music.area.overlays.<moodId>.layer` | `area` |
| `overlay:combat` | A **phase** entry marked `layer` | opt-in — `music.combat.overlays.<phaseId>.layer` | `combat` |

| | Replacing | Layering |
|---|---|---|
| In the candidate pool | yes | **no** |
| Base music while it plays | stopped and crossfaded out | **untouched, still playing** |
| Filtered by `combat.started` / `suppressCombat` / `suppressArea` | yes | yes |
| Sorted by priority | yes | n/a |
| Engine | `_customEngine` | its own entry in `_layers` |

The two opt-in directions are opposite on purpose and it is the one confusing part of this: a
combatant's theme has layered by default since before overlays could, and flipping that would
silently change every configured token. A mood or phase overlay has always *replaced* its section
default, and flipping **that** would silently change every configured scene.

#### Overlay layers

**`PlaylistContext.fromDocument` skips a layering overlay entirely**, so the section's own base
config resolves as if the overlay weren't there — that base is precisely what the layer then plays
over. `PlaylistContext.layerFromDocument` is the separate factory that builds the layer context.
Get this backwards and the overlay both replaces the base *and* layers over its own replacement.

Scope is a **fallback chain, not a contest**: the active scene first, then the world default, and
the first one whose live overlay is marked `layer` supplies that section's layer. Two scopes
layering one section at once would be two streams over one base for a single mood. Only those two
scopes are consulted — a token's combat section already has its own layering mechanism, and no
surface writes `layer` on a token overlay.

An **area** layer is additionally dropped once combat music has won the base resolution: moods are
the area axis, and leaving an ambience layer running over a boss fight is not what "an overlay over
the base area music" means.

#### Shared mechanics

`exclusive` is stored once per **section** (`music.combat.exclusive`), never per phase overlay —
one flag governs whichever playlist the section resolves to for any phase. Absent means false, so
an override configured before layering existed layers. `layer` is the opposite: it is stored per
**overlay entry**, because each mood or phase independently decides whether it replaces or joins.

A layer target may be a plain native playlist, so `_syncLayers()` passes an explicit
`buildNativeModeGraph()` result to the engine — its own fallback for a playlist with no stored
graph is an *empty* graph, which starts and goes idle in silence. Same pairing `_runPlaylistPass()`
uses for a Playlist node's target.

**The binding's `initialTrack` is threaded into that synthesized graph.** `buildNativeModeGraph()`
takes a `trackId`, and when set it wins over the playlist's mode entirely — a one-Track graph —
mirroring `PlaylistContext._resolveTracks()`, which checks `trackId` before `mode` on the
non-engine path. Without it, a layer bound to *one* track of a Soundboard playlist marched through
the whole playlist instead. A stale id that no longer belongs to the playlist falls back to the
full mode-derived graph rather than synthesizing a Track node for a sound that does not exist.

A layer is refused outright if its playlist is the base's, is anywhere in the base engine tree, or
is already running as *another* layer (H15).

#### Handing one sound between the base and a layer

Toggling *Play as overlay* moves the **same `PlaylistSound`** between the base and a layer, in
both directions, and each direction had its own way of killing the sound mid-hand-over. Both are
now closed, and they are the reason `playCurrentTrack()` resolves the layer set **before** the
transition and threads the identical `Map` into both calls.

**Layer → base** (unticking). `transitionToContext()` adopts the already-playing sound
("leaving it uninterrupted"), then `_syncLayers()` retires the layer that had been playing it.
Fading that layer's whole `activeSounds` list took the base's own track to silence a beat after it
was handed over. **Retiring a layer therefore only fades sounds nothing else is playing** —
`_soundIdsOwnedOutside()` covers the base's tracks, the base engine's, and every other layer's.

**Base → layer** (ticking). The binding stops winning the resolution, so the transition sees its
track as an outgoing *managed* sound and faded it. `_syncLayers()` then started the layer, which
found the document still marked `playing` and **adopted** it (`path=adopted` — no `play()` call,
because adoption assumes the audio is already live). Four seconds later the fade landed, the sound
stopped, and the layer was left holding a token on dead audio waiting for an `'end'` that a
`'stop'` never sends: the layer read as running and was simply inaudible. `transitionToContext()`
therefore excludes the **incoming** layers' tracks from its fade-out, not just the running ones —
so the sound is never touched and the hand-over is seamless.

#### Reclaiming a sound mid-fade

The two hand-overs above stop the fade being *scheduled*. A third case needs a fade already in
flight to be *called off*: leaving a mood and returning inside the crossfade window. The layer
retires and its track starts fading; the layer restarts and adopts the still-`playing` document;
the original fade lands and stops it. Same silent ending as base → layer, from a different
direction.

The root cause is that **`playing === true` for the whole of a fade-out**, so no adoption path
anywhere in the module could tell a live track from one four seconds into its own funeral. So
fade-outs are cancellable: `_fadeOutSounds()` records a token per sound in
`MusicController#_pendingFadeOuts` and the completion callback stops the sound **only while its own
token is still the current one**. `cancelPendingFadeOut(sound)` drops the token — the landing fade
becomes a no-op — and fades the level back up to `mixedVolume(sound)`, since adoption never sets a
volume and the sound would otherwise play on at whatever fraction the outgoing fade had reached.

Two callers, one per adoption path:

- `transitionToContext()`, for every target track, **before its first `await`** — the cancel has to
  beat the fade's completion callback.
- `CustomPlaybackEngine#_enterTrack()`, in the `alreadyPlaying` branch — this covers the base
  engine, every layer, and every nested Playlist node in one place.

**Never clear `_pendingFadeOuts` wholesale.** Dropping a token is how a stop gets cancelled, so
emptying the map cancels every pending stop at once and leaves those sounds playing forever.
`fadingTracks.length = 0` in `transitionToContext()` is pure UI bookkeeping and is *not* the same
thing.

**Ducking.** `duck` is the multiplier *everything else* is taken to while a layer plays —
1/absent means no ducking, and it is stored and rendered exactly like the mixer's `gain`. It is read
at the level the flag lives at: **section** level for a combatant (`music.combat.duck`, same as
`exclusive`), **entry** level for an overlay layer (`music.<section>.overlays.<id>.duck`).

It is published as the `activeDuck` **world setting** rather than held on the controller, because
the engine is head-GM-only but volume is applied per client (rule 5) — a duck in memory would duck
the GM and nobody else. Every client's `mixedVolume()` multiplies by `duckFactorFor(playlist)`; the
setting's `onChange` calls `reassertDuck()`, which re-levels every playing sound gliding over the
layer's crossfade value.

With several layers running, **the deepest duck wins and every layer's whole engine registry is
exempt** — not just each root playlist, so a layer graph reaching another playlist through a
Playlist node doesn't duck its own nested audio, and no layer ever ducks another. Taking the
shallowest instead would let one layer quietly undo the dip another asked for. See
[mixer.md](mixer.md) for where the duck sits in the volume chain.

### Turn scoping

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

An overlay entry is `{ playlist, initialTrack, priority, layer?, duck? }`. **`layer: true` opts out
of the replacement above**: the section resolves to its own base config as if the overlay weren't
there, and the overlay plays over it instead — see § *Layers*.

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
4. **Layer** — after the winner has transitioned, `_syncLayer()` brings the additive layer into
   line. This runs on **every** `playCurrentTrack()`, including the ones that decided the base
   needed no change at all: a turn passing changes the layer and nothing else.

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
| `PlaylistTreeApp` | Settings menu (the module's **one** menu door), keybinding (`Alt+O`), scene control, Mood Widget | Every scene's assignments in one tree, mood and phase rows both, plus each overlay row's `layer`/`duck` behind `Advanced` |
| `OverlayConfigApp` | Playlist tree footer | World mood **and** phase definitions — one window, two tabs. `MoodConfigApp`/`PhaseConfigApp` (`mood-config.mjs`) are doors that share its `id` and only pick the opening tab |
| `MoodWidget` | Scene control, keybinding | Dockable switcher: moods when idle, phases once `game.combat?.started`. Shows **only** the active axis — the inactive one is not rendered at all, not even dimmed |
| `CustomPlaylistEditor` | Playlist Config button, playlist directory context menu, tree, mood widget | The graph editor — see [editor.md](editor.md). Never mode-gated: saving forces `UNSEQUENCED` itself |
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
