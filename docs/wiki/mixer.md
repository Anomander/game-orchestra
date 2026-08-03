# The Playlist Mixer

Every *level-shaping* setting for a playlist: per-track volume and fade, mute/solo, a master gain,
a volume ceiling, the hand-off crossfade, and the playlist fade. Plus one level that belongs to
no playlist at all — the additive layer's **duck**, applied here because this is where volume
reaches live audio.

It has **two hosts**, sharing one implementation:

| Host | What it is |
|---|---|
| `PlaylistMixerApp` (`playlist-mixer.mjs`) | The standalone window, one per playlist. A thin ApplicationV2 shell. |
| The graph editor's **Tracks pane** | The same mixer, compact, merged with the track list — rows double as canvas drag sources (see [editor.md](editor.md)). Its level edits join the editor's undo history. |

`MixerController` (`playlist-mixer-controller.mjs`) holds everything they share: the data the pure
renderer needs, every document and flag write, the delegated listeners, and the selection. It owns
no markup and never calls a host's `render()` — hosts pass an **`onRefresh` callback** instead,
because the window re-renders freely while the editor must never re-render at all (HR-A). That one
indirection is what lets the two coexist without a second copy of the volume-writing logic.

Design doc: [../playlist-mixer-plan.md](../playlist-mixer-plan.md) (archived; implemented).

---

## Why it exists

Each of these settings already existed. Reaching them cost one dialog per track, or lived on a
surface that only opens for one kind of playlist:

- Core's sidebar volume slider renders **only for a playing sound** — `sound-partial.hbs` gates it
  behind `{{#if playback}}`. Otherwise: open the sound's sheet, one track at a time.
- Per-track fade is sheet-only.
- The crossfade override lived in the graph editor's Settings pane, which **never opens for a
  sequential or shuffle playlist**.
- A volume clamp did not exist at all.

The unifying observation: these are set per *playlist* in practice ("this pack is too loud"), and
only occasionally per track. The old UI inverted that.

---

## Two storage layers

**Per-track volume and fade are the document's own fields.** The mixer writes `PlaylistSound#volume`
directly, debounced, exactly as `PlaylistDirectory#_onSoundVolume` does — one source of truth. A
module-side shadow value would disagree with core's own slider the moment either was touched, and
"track volume" would mean two different numbers depending on which window you were looking at. The
mixer's volume column *is* the sidebar's slider, for every track, always.

**Everything playlist-wide is the `game-orchestra.mix` flag** (`playlist-mix.mjs`):

```js
{ gain: 0.7, floor: 0, ceiling: 0.85, crossfadeMs: 200, muted: ["<soundId>"] }
```

**`muted` is an array, and it has to be.** A flag's value is an `ObjectField`, whose
`_updateDiff` runs `mergeObject(source, diff)` — a **recursive merge**. Stored as
`{soundId: true}`, a later write that simply omits an id merges the old `true` straight back in,
so **unmute silently never persists**: the button flips, the audio comes back, and the track is
muted again after a reload. Removing a key needs the `-=` deletion operator; an array sidesteps
the whole class of bug, because `mergeObject` replaces arrays wholesale.

This was reported live, and `tests/mocks/foundry.mjs` now models the merge (`mergeLikeFoundry`)
so the same mistake fails a test instead of shipping. `normalizeMutedIds()` still reads the old
map shape, so a playlist saved by an in-between build is not stuck muted.

```
effective(sound) = muted ? 0 : clamp(sound.volume * mix.gain, mix.floor, mix.ceiling)
heard(sound)     = effective(sound) * soloFactor * duckFactor(playlist)
```

**The duck is not part of the mix, and deliberately sits outside it.** It is the attenuation an
additive layer applies to everything that isn't itself (`architecture.md` § Layers), published as
the `activeDuck` world setting and read back by `duckFactorFor()`. Folding it into
`effectiveVolume()` would make the mixer's `stored → effective` readout jump around every time a
boss took its turn, for a value belonging to no playlist. Being outside the clamp also means a
duck can legitimately take a track **below the mix's own floor**: the floor states how quiet a
playlist may shape *itself*, while the duck is somebody else temporarily standing in front of it.
Mute still short-circuits ahead of both.

Never written back to a document. Always read through `normalizeMix()` — `mix.gain` read raw is
`undefined` on every playlist nobody has opened the mixer for, and `undefined * 0.5` is `NaN`,
which `sound.fade()` accepts and turns into silence with no error.

Mute lives here rather than in the document's volume so unmuting **restores** the level instead of
having lost it. A floor above 0 must not make a muted track audible, so mute short-circuits ahead
of the clamp.

### Solo is neither

Session state, per client, in `playlist-mix-apply.mjs`'s module-level `sessionSolo` map. Never
persisted (a solo surviving a reload reads as "my playlist only plays one track now"), and
deliberately local: it is an audition tool for whoever opened the window, so the table goes on
hearing the real mix. `_onClose` drops it and re-levels.

---

## Why it is a separate flag from `customPlayback`

`hooks.mjs#handleUpdatePlaylist` rebuilds a running engine on a **`customPlayback`** change (H8),
and a rebuilt graph restarts from Start (H9). Folding the mix into that flag would mean **nudging a
volume slider audibly restarted the music.**

A `mix` change instead takes the soft path: `applyMixToPlaylist()` re-asserts volumes on the
already-playing sounds via `Sound#fade`. No stop, no restart, no token movement.

---

## The multi-client rule is inverted here

**Rule 5 (head GM only) does not apply to applying a mix.**

The engine is head-GM-only because it decides *what* plays. Volume is not that kind of decision:
every client builds its own `Sound` from the PlaylistSound document and applies `this.volume`
itself in `PlaylistSound#sync()`. A mix applied only on the head GM would mean **the GM hears the
ceiling and the players hear the raw track** — a bug the person who configured it is the least
likely to notice.

So:

| Concern | Where it runs |
|---|---|
| The mix values | World flags — every client reads the same ones |
| Applying them | `updatePlaylistSound` / `updatePlaylist` hooks, **on every client** |
| The mixer window | GM-gated (it writes flags) |
| The layer duck | `activeDuck` **world setting**, written by the head GM; its `onChange` runs `reassertDuck()` **on every client** |

The duck row is the same inversion for the same reason, and it is why the duck is a *setting* at
all rather than a field on `MusicController`: `_syncLayer()` runs only on the head GM, so a duck
held in memory there would duck the GM and leave the table at full volume.

This also rules out the tempting shortcut of `sound.updateSource({volume})` before playback: that
is a **local-only** source mutation (it is what core uses for its own immediate slider feedback),
so on the head GM it would change nothing for anyone else. The mixer does use it, but only for the
GM's own instant feedback, alongside the real document write.

`applyMixToSound()` waits for the audio to exist before setting a volume: `sync()` starts playback
with an async `Sound#load({autoplay})`, so on the update that *begins* a track there is a window
where the document says playing and there is nothing to set a volume on yet. Same retry shape as
`MusicController#_fadeInWhenReady`, for the same reason.

### Where the mix is applied at start

Three sites start audio with an explicit volume and would otherwise begin at the unmixed level and
be pulled down a moment later, audibly:

| Site | What it starts |
|---|---|
| `music-controller.mjs` — `startVolumes` map | Native playlist tracks (fade-in target) |
| `music-controller.mjs#_fadeInWhenReady` | The fade-in itself |
| `custom-playback-engine.mjs#_armHandoff` | The one place the engine plays a `Sound` itself rather than letting `sync()` do it |

Everything else goes through Foundry's own `playSound` → `sync()` path and is covered by the
per-client re-assert.

---

## Crossfade: one value, three links, no migration

```
mix.crossfadeMs  ??  graph.crossfadeMs (legacy)  ??  world `graphCrossfade` setting
```

`resolveCrossfadeMs()` (`playlist-mix.mjs`) owns the chain; `CustomPlaybackEngine#_crossfadeMs()`
and the mixer both go through it.

The middle link is where the graph editor used to store the override. Those graphs are in live
worlds, so the field is **still read** — it is simply never written any more. That makes this a
read-side migration: no data rewrite, nothing to run on upgrade.

**Every link preserves an explicit 0**, including the legacy one: a graph saved with 0 chose to
disable the crossfade and must keep it disabled. `0` and `null` are different answers at every
link, which is why `resolveCrossfadeOverride()` exists rather than a `||`.

For a **native** playlist the override also governs the context-transition fade in
`transitionToContext()`, replacing the world `fadeDuration` for that transition. One value for both
directions of the hand-off — taking the outgoing playlist's number for the fade-out and the
incoming one's for the fade-in would leave an audible dip or bulge wherever they disagreed.

---

## The window

A header strip of playlist-wide controls, a **column header**, then one row per track. The column
header is not decoration: two percentages side by side (`63% → 52%`) and a bare `250` read as
arbitrary numbers until they are named. It carries the row's own column classes so both are laid
out from one set of widths, and the *Heard* heading appears only when some row actually has that
column — otherwise it would label an empty gap.

Type-specific content is an extra **column**, never a different window: a graph playlist shows its Track-node usage count (clicking
it focuses the node in an already-open editor), a native one shows its playback position.

### Selection is the bulk-edit mechanism

There is no separate bulk mode to discover. Rows are selectable (click, shift-click, ctrl-click,
`Ctrl+A`, `Esc`), and with a selection live the **header retitles and its controls retarget those
rows**. Same controls, different scope, marked by `data-scope` on the header.

The Gain slider becomes a **group fader**: `applyGroupGain()` scales every selected track by one
ratio derived from the loudest of them, so the balance already dialled in survives and nothing
clips against 1 before the others get there. Alt forces `setGroupVolume()` — a flattening absolute
set. Pulling a group to 0 collapses the ratios irreversibly; that is inherent to a fader, and the
undo is the document history, not the function.

### Rendering

`buildMixerHtml()` (`playlist-mixer-render.mjs`) is a pure string builder, same pattern as the
inspector and Tracks pane. **This one is not dodging a re-render hazard** — HR-A is a Drawflow
constraint and there is no canvas here; `PlaylistMixerApp` is a plain ApplicationV2 that re-renders
freely.

One narrow exception, arrived at from a different direction: **a slider drag must not re-render.**
Replacing the `<input type="range">` under the pointer kills the drag. So `_onInput` updates the
readouts by hand (`_refreshRowReadout`), and `refreshOpenMixer()` skips a render while
`input[type="range"]:active` matches.

Percentages go through `AudioHelper.inputToVolume`/`volumeToInput` rather than a local
reimplementation of the 1.5-order curve, so the mixer's "50%" is by construction the same sound as
the sidebar's — including if core ever changes the exponent. Note that core labels its slider with
the **slider position**, not the volume, which is why `displayPercent()` converts before rounding.

### The fade warning, moved

`custom-playback-engine.mjs#_warnIfFadeBreaksTheSeam` logs, after the fact, that a fade on a graph
playlist breaks a gapless hand-off. The header's Fade field renders the same condition as a live
inline warning instead — the same rule, moved from after the mistake to before it. It is not a
block: a GM who wants a fade on a graph playlist can still set one.
