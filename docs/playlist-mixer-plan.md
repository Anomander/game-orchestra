# Playlist Mixer — design plan

A single window that owns every *level-shaping* setting for a playlist — per-track volume, mute,
playlist gain, a volume clamp, crossfade, and fade — for **every** playlist type, without opening
one `PlaylistSound` sheet per track.

Status: **implemented.** This document is the design as agreed; the durable content lives in
[docs/wiki/mixer.md](wiki/mixer.md), which is the maintained page. Kept for the reasoning behind
the decisions.

---

## Why

Three separate gaps, all with the same shape: the setting exists, but reaching it costs one dialog
per track, or the surface that exposes it only opens for one kind of playlist.

| Setting | Where it lives today | What's wrong with that |
|---|---|---|
| Per-track volume | `PlaylistSound#volume` | Editable in the sidebar **only while that sound is playing** — `templates/sidebar/tabs/playlist/sound-partial.hbs` gates the slider behind `{{#if playback}}`. Otherwise: open the sound's sheet. Twelve tracks, twelve dialogs. |
| Per-track fade | `PlaylistSound#fade` | Sheet only. Same cost. And the graph engine already warns about it after the fact (`_warnIfFadeBreaksTheSeam`) rather than letting you see and fix it in one place. |
| Playlist fade | `Playlist#fade` | On the playlist sheet, one field, no relationship shown to the per-track values it silently overrides (`sound.fade ?? playlist.fade ?? 0`). |
| Graph crossfade | `customPlayback.crossfadeMs`, graph editor Settings pane | **Only reachable for a custom-graph playlist.** A sequential or shuffle playlist has no per-playlist crossfade at all — just the world `fadeDuration`. |
| Volume clamp | — | Does not exist. A pack of loud tracks can only be tamed by editing every sound. |

The unifying observation: **none of these are per-track decisions in practice.** A GM sets them
per *playlist* ("this ambience pack is too loud"), and only occasionally reaches for one track.
The current UI inverts that — everything is per-track, and the playlist-wide case is done by
repetition.

---

## The window

`PlaylistMixerApp` — one ApplicationV2 window per playlist. Opens for **any** playlist type;
nothing about it assumes `UNSEQUENCED` or a graph.

```
┌─ Mixer · Dungeon Ambience ──────────────────────────────── □ ✕ ┐
│                                                                │
│  Gain    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  70%     Ceiling  ▓▓▓▓▓▓▓▓▓ 85%  │
│  Crossfade  [    ] ms  (world: 0)      Fade     [  0 ] ms  ⚠   │
│  ─────────────────────────────────────────────────────────────  │
│   ●  Track                     Volume              Fade   ×N   │
│  ─────────────────────────────────────────────────────────────  │
│  M S  Cave Drips           ▓▓▓▓▓▓▓▓░░░░  50% → 42%   —     ×1  │
│  M S  Distant Chanting     ▓▓▓▓▓▓▓▓▓▓▓░  80% → 68%   —     ×2  │
│  M S  Water Rush           ▓▓▓▓▓░░░░░░░  30% → 26%  250ms  —   │
│  M S  Stone Grind          ▓▓▓▓▓▓▓▓▓▓▓▓ 100% → 85%⚠  —     ×1  │
│  ─────────────────────────────────────────────────────────────  │
│  4 tracks · 1 unplaced                    [ Reset ]  [ Close ]  │
└────────────────────────────────────────────────────────────────┘
```

Header = playlist-wide. Table = per-track. The two are the same controls at two scopes, which is
what makes the bulk case free (below).

### Row anatomy

| Element | Behaviour |
|---|---|
| **M** | Mute. Stored in the module flag, **not** by zeroing `sound.volume` — so unmute restores the level instead of losing it. |
| **S** | Solo. **Session-only, never persisted.** It is an audition tool; a solo surviving a reload is a support ticket ("my playlist only plays one track now"). |
| Name | Ellipsised. `title` carries the full name. |
| Volume | A core `range-picker`, using `AudioHelper.inputToVolume` / `volumeToInput` — the *same* 1.5-order curve as the sidebar, so 50% here and 50% there are the same sound. |
| `50% → 42%` | Stored value → **effective** value once gain and ceiling apply. Shown only when they differ. A `⚠` marks a row the ceiling is actually cutting. |
| Fade | Per-track `fade` override. `—` means inherit. Column is collapsed by default. |
| `×N` | For a custom-graph playlist only: how many Track nodes reference this sound, reusing the count the editor's Tracks pane already computes. Clicking it focuses that node if the editor is open. |

Type-specific content is an extra **column**, never a different window. A soundboard shows no
`×N`; a sequential playlist shows its order index instead. Same window, same rows, same controls.

### Bulk editing is selection, not a second dialog

This is the part that answers "without opening each track's properties."

- Rows are selectable: click, shift-click for a range, ctrl-click to toggle, `Ctrl+A` for all.
- With a selection live, the **header strip retitles to `3 selected` and its controls retarget the
  selection.** The Gain slider becomes a group fader; the Fade field writes to those three tracks.
  No separate "bulk edit" mode to discover — the same control does both jobs, and its scope is
  whatever is selected.
- A group fader is **relative**: it offsets every selected track, preserving the balance between
  them, and clamps at the ends so the ratios survive a round trip to 0 and back. Hold `Alt` to
  force an absolute set instead ("make these all 40%").
- Right-click a volume → *Apply to all tracks* / *Copy* / *Reset to default*.

### Keyboard

`↑`/`↓` move the row cursor, `←`/`→` adjust by 5% (`Shift` 1%), `M` mute, `S` solo, `Ctrl+A`
select all, `Esc` clear selection. Sliders carry `aria-valuetext` from
`volumeToPercentage(v, {label: true})`, matching core.

---

## Storage and the volume model

### Per-track volume writes the document

The per-track slider writes `PlaylistSound#volume` directly, debounced, exactly as
`PlaylistDirectory#_onSoundVolume` does. **One source of truth.** A module-side shadow value would
diverge from the sidebar slider the first time anyone touched either, and "track volume" would
mean two different numbers depending on which window you were looking at.

So the mixer's per-track column is precisely *the sidebar's slider, for every track, always* —
not a parallel system.

### Everything playlist-wide is a module flag

A new flag `game-orchestra.mix`, deliberately **separate from `game-orchestra.customPlayback`**:

```js
{
  gain: 0.7,            // master multiplier, default 1
  floor: 0,             // clamp lower bound, default 0
  ceiling: 0.85,        // clamp upper bound, default 1
  crossfadeMs: 200,     // null = inherit world setting
  muted: { "<soundId>": true }
}
```

Effective volume, applied at playback time and never written back to any document:

```
effective(sound) = muted ? 0
                 : clamp(sound.volume * mix.gain, mix.floor, mix.ceiling)
```

An explicit **Bake into tracks** action exists for GMs who want the document values rewritten and
the gain reset to 1. Destructive, confirmed, and the only route that touches `sound.volume` in
bulk.

### Why a separate flag matters — H8

`hooks.mjs#handleUpdatePlaylist` rebuilds a running engine **only** on a `customPlayback` change.
Putting mix settings in that same flag would mean **nudging a volume slider restarts the graph
from Start** (H9: graphs never resume). A separate flag is what keeps a level tweak inaudible
apart from the level change itself.

The running engine still has to *notice*. Add a soft-apply path: on a `game-orchestra.mix` change,
re-assert volumes on currently-playing managed sounds via `sound.sound.fade(effective, {duration:
VOLUME_DEBOUNCE_MS})` — no stop, no restart, no token movement.

### Crossfade: one value, two editors, no migration

`resolveGraphCrossfadeMs` gains a fallback chain:

```
mix.crossfadeMs  ??  graph.crossfadeMs (legacy)  ??  world graphCrossfade setting
```

The mixer writes only `mix.crossfadeMs`. Existing graphs keep working untouched — no migration
script, no data rewrite. The graph editor's Settings pane **loses its crossfade input** and gains
an *Open Mixer…* button in its place, which also retires two pieces of special-case machinery:
`handleUpdateGraphCrossfade`'s manual `_recordHistory()` call and `_syncCrossfadeInput()` in
`_restoreSnapshot` (both exist solely because that one field never touches Drawflow).

Crossfade then applies to **native playlists too**, where today only the world `fadeDuration`
does.

### Fade keeps its warning, in the right place

The header's Fade field renders the `_warnIfFadeBreaksTheSeam` condition **as a live inline
warning** for a custom-graph playlist ("a non-zero fade audibly breaks a gapless graph seam"),
instead of the console warning the engine emits after the fact. Same rule, moved from after the
mistake to before it. The field is not hidden — a GM who wants a fade on a graph playlist can
still have one.

---

## The multi-client hazard

**Rule 5 does not apply to this feature, and getting that backwards would ship a bug only the GM
can't hear.**

The playback *engine* runs on the head GM alone. But volume is applied per client, from the
document, by each client's own `AudioHelper`. So:

- Mix settings are **world flags** — every client reads the same values.
- Applying them (gain, clamp, mute) is a **per-client concern that must run on every client**, not
  only the head GM. Otherwise the GM hears the ceiling and every player hears the raw track.
- Only the **mixer window** is GM-gated (it writes flags).

This rules out the tempting shortcut of `sound.updateSource({volume})` before `playSound` — that
is a local-only source mutation (it is what core uses for its own immediate slider feedback), and
on the head GM it would change nothing for anyone else.

### Application points

| Site | Change |
|---|---|
| `music-controller.mjs:258` — `startVolumes` map | Wrap `track.volume` in `effectiveVolume()` |
| `music-controller.mjs:685` — `_fadeInWhenReady` | Target volume comes from the same helper |
| `custom-playback-engine.mjs:1613` — `rawSound.play({volume})` | Same |
| Foundry's own `Playlist#playSound` path | Reads the document directly — cover it with a client-side hook on sound start that re-asserts the effective volume, registered on **all** clients |

---

## Entry points

| From | How |
|---|---|
| Playlist Config sheet | A second injected `.form-group`, immediately after the existing Custom Playback button, following the same shape `architecture.md` documents (stable anchor → vanilla DOM → `insertAdjacentElement` → try/catch logging at level 1). Unlike that button, **never disabled by mode.** |
| Playlist directory | Context-menu entry on the playlist entry — the fastest route, and it needs no sheet |
| Graph editor | Settings pane, *Open Mixer…* (replacing the crossfade input) |
| Playlist tree | A small mixer icon on each assignment row (optional; second pass) |

---

## Module layout

Following the purity boundary in `CLAUDE.md`:

| File | Purity | Contents |
|---|---|---|
| `scripts/playlist-mix.mjs` | **Pure** | `effectiveVolume()`, `clampVolume()`, `resolveCrossfadeMs()` with its legacy fallback, `applyGroupGain()` (the relative group fader, ratio-preserving) |
| `scripts/playlist-mixer-render.mjs` | **Pure** | `buildMixerHtml({ tracks, mix, selection, localize })` → HTML string, escaping every name through `escapeHtml()` |
| `scripts/playlist-mixer.mjs` | Foundry | `PlaylistMixerApp` — the window, document writes, `updatePlaylistSound` refresh, debouncing |

The render/state split mirrors `custom-playlist-inspector.mjs` and `custom-playlist-tracks.mjs`,
for the same reason: it is testable without a DOM.

The mixer window is an ordinary ApplicationV2 and re-renders freely — **HR-A is a Drawflow
constraint and does not reach here.**

---

## Tests

- `playlist-mix.test.mjs` — effective volume across gain/clamp/mute combinations; clamp bounds
  including `floor > ceiling` (degenerate, must not produce NaN); the crossfade fallback chain,
  including an explicit legacy `0` beating the world setting (today's documented "never crossfade
  this playlist" behaviour must survive); `applyGroupGain` preserving ratios through a round trip
  to 0.
- `playlist-mixer-render.test.mjs` — escaping, the `→ effective` readout appearing only when it
  differs, the `⚠` on clamped rows, selection state.
- `lang.test.mjs` — already enforces parity; **both `en.json` and `pt-BR.json` get every new key**
  (rule 4).

---

## Deliberately out of scope

- **Live level meters.** Needs an analyser node per sound and a render loop; the value here is
  setting levels, not monitoring them.
- **Loudness normalisation.** Requires decoding every file to measure it. A *Match levels* action
  is the natural follow-up once metering exists.
- **Per-mood / per-phase level overrides.** Overlay axes already have a home; folding a third
  scope into the mixer would make the effective-volume expression four terms deep.
