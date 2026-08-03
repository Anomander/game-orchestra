# Testing

Vitest, node environment, no jsdom. **1591 tests across 38 files, ~3s.** CI runs `npm test` on
push and PR to `main` (Node 20).

This page covers the unit tier. Audio is verified separately, against a real pinned Foundry - see
[integration-testing.md](integration-testing.md).

```bash
npm test              # full run
npm run test:watch
npm run test:coverage
```

`vitest.config.mjs`: `include: ['tests/**/*.test.mjs']`, `globals: false` (import `describe`/`it`/
`expect` explicitly), `environment: 'node'`.

---

## The Foundry mock

`tests/mocks/foundry.mjs` hand-rolls just enough of Foundry to exercise this module. There is no
`jsdom` and no real Foundry — the mock is the entire environment.

### Order matters

```js
import { setupFoundryMocks, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();                                        // ← before the import below

import { CustomPlaybackEngine } from '../scripts/custom-playback-engine.mjs';
```

Module-under-test imports read globals at module scope, so the globals must exist first. The mock
also calls `setupFoundryMocks()` once at import time so top-level destructured globals work, but
call it explicitly in each file anyway — that is the established pattern, and it re-seeds state.

### What it provides

| Global | Coverage |
|---|---|
| `game` | `settings` (Map-backed, `vi.fn` spies), `user`/`users` (one active GM, `gm1`), `scenes`, `combats`, `playlists`, `audio`, `i18n`, `keybindings`, `gameOrchestra` |
| `ui` | `notifications.{error,warn,info}` |
| `foundry` | `abstract.Document`, `utils.*`, `applications.api.{ApplicationV2,HandlebarsApplicationMixin,DialogV2}`, `applications.ux.DragDrop`, `applications.instances` (a Map — the mixer finds its own window through it), `audio.AudioHelper` (the real 1.5-order volume curve) |
| `CONST` | `PLAYLIST_MODES` |
| `Hooks` | `on`/`off`/`once`/`call`/`callAll` |
| `document` | `createElement` returning a minimal element (classList, appendChild, remove) — enough for the hand-built rect-select rectangle and validation badges |

Pass `overrides` to `setupFoundryMocks({ … })` to replace any `game` key.

### Factories

**`createMockSound(id, name, overrides)`** — models a `PlaylistSound` document wrapping a
`sound` instance backed by a **real `EventTarget`**, so tests can `dispatchEvent(new Event('end'))`
realistically. Mirrors Foundry v14, where the legacy `on()`/`off()`/`emit()` aliases are removed
and only `addEventListener`/`removeEventListener` exist.

`sound.update()` **merges the patch in place**, so assertions can inspect resulting field values
rather than just call arguments.

**`createMockPlaylist(id, name, sounds, mode)`** — `setFlag` **merges recursively**, as Foundry's
own does (a flag value is an `ObjectField`, whose `_updateDiff` runs `mergeObject`): omitting a key
does not remove it, `-=key` does, and arrays are replaced wholesale. A mock that simply assigned
made a whole class of bug untestable — writing a `{id: true}` map without an id merges the old
`true` back in, which is how mute-off silently failed to persist and shipped. Sounds exposed as a Map that also carries
`.contents` and `.find()`, matching the two shapes production code tolerates. Its `Symbol.iterator`
is overridden to yield the **documents**, as a real `EmbeddedCollection` does: a plain Map yields
`[key, value]` pairs, so `for (const sound of playlist.sounds)` would hand every caller a
two-element array whose `.volume` and `.name` are `undefined` — and fail silently rather than
throwing. Flags are backed by
a real object via `getFlag`/`setFlag`/`unsetFlag`. Each sound gets a realistic
`Playlist.<id>.PlaylistSound.<id>` uuid and a `parent` carrying the playlist's id/name — the
editor's drag-in path reads both.

**`setMockSetting(moduleId, key, value)`** — seed a setting directly.

### The i18n mock is not a no-op

`localize` returns the key. `format` returns `` `${key} ${values.join(' ')}` `` — it appends
interpolation data after the untranslated key, since there is no translation table to interpolate
into. Assertions can therefore check that data reached the format call.

---

## Conventions

**Test the pure modules directly.** Anything in the [purity list](../../CLAUDE.md#conventions)
needs no mock beyond an import. That's the point of the boundary — `graph-validation.test.mjs`
(69 tests) and `custom-playlist-editor.test.mjs` (156 tests) both benefit enormously from it.

**Fake controllers over real ones.** Engine tests use a hand-rolled controller:

```js
function createFakeController() {
  return {
    _managedSoundIds: new Set(),
    playTrack: vi.fn(async (s) => { s.playing = true; s.sound.playing = true; }),
    stopTrack: vi.fn((s) => { s.playing = false; s.sound.playing = false; })
  };
}
```

**Inject the RNG.** `engine._rng = () => 0.5` — `CustomPlaybackEngine` and `graph-presets`/
`native-mode-graph` all accept an injected rng so weighted/shuffled behavior is deterministic.

**Draining microtasks, not timers.** Advancing is no longer synchronous with the `'end'` event —
the engine awaits a `stopTrack()` before following the exit. Helpers drain microtasks so they stay
usable under fake timers:

```js
async function fireEnd(sound) {
  sound.playing = false;
  sound.sound.playing = false;
  sound.sound.dispatchEvent(new Event('end'));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
```

**Mind the 300 ms floor.** `MIN_CLEAN_START_INTERVAL_MS` is real in tests too. A test exercising
repeated entry into the same node either advances fake timers or genuinely waits — one test in the
suite takes ~500 ms for exactly this reason.

**Comment the *why*.** Test files here carry the same explanatory density as the source. A test
guarding a specific past regression says so.

**The `until`/idle interaction (H12) needs an explicit test, not just a green suite.** A child
engine built around `loop.mode: 'forever'` never goes idle, so a Playlist node targeting one never
completes a pass — that's an easy case to cover incidentally. A child built around `loop.mode:
'until'` plays identically (seamless `repeat: true`) right up until its condition matches, and
**then** does complete, going idle and reporting the parent's pass done — a behavior no
`forever`-only test can accidentally exercise. See
`custom-playback-engine.test.mjs`'s `"H12: ..."`-titled test for the pattern: toggle
`game.combat.started` mid-test to flip the child's `combatIdle` condition, and assert the root's
own track only starts **after** the flip, not before.

---

## Structural guard tests

Three files test things that aren't code paths. Do not delete them — each guards a regression that
already shipped:

| File | Guards |
|---|---|
| `lang.test.mjs` | Locale key parity in **both** directions, plus no empty values. `pt-BR.json` once fell 73 keys behind. |
| `module-manifest.test.mjs` | `drawflow.min.css` loads before `game-orchestra.css` (equal specificity — every node once rendered flat cyan). Drawflow loads as a classic script, not an esmodule. |
| `custom-playlist-editor-template.test.mjs` | Template structure the editor's DOM queries depend on. |

---

## Test-to-subject map

| Test file | Tests | Subject |
|---|---:|---|
| `custom-playlist-editor.test.mjs` | 156 | The editor window, including the `until` toggle/kind/value/boundary/minLoops/maxLoops handlers |
| `graph-presets.test.mjs` | 103 | Every preset (all 8, `loop-until-combat-ends` included) through `validateGraph()`, the Drawflow bridge, id/edge-order rules, parametrized per sound count |
| `music-controller.test.mjs` | 97 | Context resolution, priority, transitions |
| `custom-playback-engine.test.mjs` | 82 | Token walk, safety nets, playlist nodes, `loop.mode: 'until'` (both boundaries, minLoops/maxLoops, probe failure, H12 idle/pass-completion) |
| `graph-validation.test.mjs` | 69 | All 39 rules, including the `loop.mode` switch's `until` branch |
| `helpers.test.mjs` | 60 | `PlaylistContext`, flags, resolution |
| `hooks.test.mjs` | 45 | Hook handlers, button injection, phase reset on `deleteCombat` |
| `playlist-tree.test.mjs` | 44 | Tree app, mood and phase rows |
| `custom-playlist-inspector.test.mjs` | 40 | Inspector HTML, including `buildUntilLoopFieldsHtml()` |
| `app.test.mjs` | 30 | Config window, incl. the Token phase-only grid |
| `custom-playlist-node-render.test.mjs` | 28 | Node content |
| `playlist-ref.test.mjs` | 24 | Axis-aware reference normalization + resolution |
| `graph-drawflow-bridge.test.mjs` | 23 | Round-trip, `data.exits[]` alignment, `until`-loop round-trip (regression coverage) |
| `mood-config.test.mjs` | 20 | `OverlayConfigApp` (mood + phase) CRUD |
| `graph-activity-highlight.test.mjs` | 17 | Highlight sets |
| `custom-playback-schema.test.mjs` | 14 | `resolveLoop()` normalization for all three modes |
| `engine-clock.test.mjs` / `graph-drop.test.mjs` | 10 each | Scheduler / drop matrix |
| `audio-end-watcher.test.mjs`, `custom-playlist-connection-render.test.mjs`, `custom-playlist-editor-template.test.mjs` | 9 each | — |
| `native-mode-graph.test.mjs` | 8 | — |
| `itest-analysis.test.mjs` | 17 | The audio harness's timeline analysis, against synthetic frames |
| `itest-goertzel.test.mjs` | 13 | The audio harness's amplitude detector and fixture generator, numerically |
| `lang.test.mjs`, `config.test.mjs`, `game-orchestra.test.mjs`, `settings.test.mjs`, `module-manifest.test.mjs` | 2–4 | Structural guards |

---

## What is not covered

Deliberate gaps — don't assume a green suite proves these:

- **Real Drawflow behavior.** The library is never instantiated in tests. Its export shape was
  verified once by hand against a headless DOM (`docs/graph-editor-panel-plan.md`, and the bridge's
  own header comment). Changes to Drawflow interop need manual verification in Foundry.
- **Real audio.** No `AudioContext`. Timing, fades, and `'end'` semantics are modeled, not
  exercised **here** - that is what the [audio integration tier](integration-testing.md) is for.
- **Foundry version compatibility.** `hooks.mjs` flags one specific unknown: the
  `renderPlaylistConfig` hook name and the `select[name="mode"]` anchor have **not** been verified
  against a live Foundry v14 build. The [integration tier](integration-testing.md) runs against
  the version in `module.json`'s `compatibility.verified`.
- **Multi-client sync / GM handoff.** Only `isHeadGM()` gating is unit-tested. The two-client
  specs in `itest/specs/mixer-multiclient.spec.mjs` cover the mixer's everywhere-rule.
- **CSS.** Only load order is tested.
