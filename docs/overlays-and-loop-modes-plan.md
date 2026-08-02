# Overlay axes & loop modes — implementation plan

**Status: implemented (P1–P5 all landed).** This document is now an **archived plan**, kept for its
section ids (`O1`–`O10`, `L1`–`L7`), which source comments cite. Its durable content has been
folded into the wiki — see [`docs/wiki/architecture.md`](wiki/architecture.md) § *Overlay axes*,
[`docs/wiki/graph-engine.md`](wiki/graph-engine.md) § *`loop`* and § *Per-node behavior*,
[`docs/wiki/invariants.md`](wiki/invariants.md) H12, and [`docs/wiki/playbook.md`](wiki/playbook.md)
§ *add an overlay axis* / § *add a `loop` mode*. Read those pages for the current state of the
system; treat this file as history, not as a spec to implement against. **Target:** pre-1.0, no
released worlds — *data migration was explicitly out of scope* (see
[§ Migration](#migration-is-out-of-scope)), and no migration shims were added.

Two independent features, planned together because they solve two halves of the same request:

| Part | Feature | Section ids |
|---|---|---|
| **A** | Moods apply to **area** only; **phases** replace them during combat | `O1`–`O10` |
| **B** | An infinite track can **loop seamlessly until a condition is met**, then exit | `L1`–`L7` |

Section ids are stable and intended for citation from source comments, exactly like
`docs/playlist-node-plan.md`'s `D1`–`D8`. Cite them as `overlays-and-loop-modes-plan.md O4`.

**Read before starting:** [`docs/wiki/invariants.md`](wiki/invariants.md) in full,
[`architecture.md`](wiki/architecture.md) § *Context resolution* (Part A) and
[`graph-engine.md`](wiki/graph-engine.md) § *Per-node behavior* (Part B).

---

## Why

Two findings from the current code shaped this design.

**The separation is already half-built.** `MusicController.excludeAreaWhenCombatApplies()` drops
*every* area context outright whenever any combat context survives filtering. Area and combat never
compete on priority — combat categorically wins. So a mood already has no effect on combat-section
resolution in practice; the axes are disjoint in the pipeline but conflated in the data model and
the UI. Part A finishes a separation the pipeline already assumes.

**Phases need no engine work.** Because a phase change re-resolves through the normal pipeline, it
lands as an ordinary context change: `activePhase` → `onChange` → `playCurrentTrack()` → a different
combat playlist wins → `transitionToContext()` retires the running engine with
`stop({ stopAudio: false })` and crossfades it (H11). Every step already exists. Part B then covers
only the residual case — reacting *inside* one graph, when the phase resolves to the same playlist.

An earlier draft proposed an engine-level interrupt primitive (`_reenterAt`, reactive Condition
nodes) to drive phases from inside a graph. **That is rejected** — see
[§ Rejected alternatives](#rejected-alternatives).

---

## Migration is out of scope

No released worlds exist. **Do not write migration shims, fallback readers, or compat branches.**
Specifically, none of these:

- reading `section.moods` when `section.overlays` is absent,
- reading `moodMode`/`moodId` when `overlayMode`/`overlayId` is absent,
- seeding `configuredPhases` from `configuredMoods`,
- accepting `infinite`/`loopCount` alongside the new `loop` object.

Break stored data freely. Existing test fixtures are updated in place. A compat branch added "just
in case" here becomes permanent debt — this codebase already carries one storage/semantics
inversion it documents as a standing hazard (H1/H2); do not add a second.

---

# Part A — Overlay axes

## O1 — The model

Mood and phase are **one mechanism on two axes**: an overlay keyed by an id, selected by a
world setting, bound to a section.

| Section | Axis | Active-id setting | Definitions setting |
|---|---|---|---|
| `area` | `mood` | `activeMood` | `configuredMoods` |
| `combat` | `phase` | `activePhase` | `configuredPhases` |

Do **not** build a second parallel system. Do **not** make the axis list data-driven or
user-extensible — two axes bound to two sections, tabulated in `config.mjs`, hardcoded.

## O2 — Storage

One key, both sections:

```js
section.overlays[overlayId] = { playlist, initialTrack, priority }
```

Flag paths become `music.area.overlays.<moodId>` and `music.combat.overlays.<phaseId>`.

Rationale: the asymmetric alternative (area keeps `moods`, combat gets `phases`) encodes the same
mechanism under two names and forces a two-branch read in the hot resolution path. Symmetry costs
nothing here because migration costs nothing.

## O3 — Settings & constants

`config.mjs` gains:

```js
settings: { …, activePhase: 'activePhase', configuredPhases: 'configuredPhases' },

defaultPhases: [
  { id: 'p1',      label: 'GameOrchestra.Phase.PhaseOne', icon: 'fas fa-shield-halved', color: '#4caf50' },
  { id: 'p2',      label: 'GameOrchestra.Phase.PhaseTwo', icon: 'fas fa-droplet',       color: '#ff9800' },
  { id: 'enrage',  label: 'GameOrchestra.Phase.Enrage',   icon: 'fas fa-fire',          color: '#f44336' },
  { id: 'victory', label: 'GameOrchestra.Phase.Victory',  icon: 'fas fa-trophy',        color: '#ffeb3b' }
],

/** Which overlay axis each music section resolves against (O1). */
sectionAxis: { area: 'mood', combat: 'phase' },

/** Axis descriptor: which settings supply the active id and the definition list. */
overlayAxes: {
  mood:  { activeSetting: 'activeMood',  listSetting: 'configuredMoods'  },
  phase: { activeSetting: 'activePhase', listSetting: 'configuredPhases' }
}
```

`settings.mjs` registers `activePhase` (String, world, `config: false`, default `'p1'`) and
`configuredPhases` (Array, world, `config: false`, default `CONST.defaultPhases`). Both `onChange`
handlers **mirror the existing `activeMood`/`configuredMoods` handlers exactly** — including the
`ui.windows` + `foundry.applications.instances` app-refresh sweep, which must also refresh
`MoodWidget`.

> Considered and rejected: one combined `activeOverlays: { mood, phase }` object setting. Two flat
> settings are independently observable, each gets its own `onChange`, and they mirror the pattern
> already in the file.

## O4 — Resolution

`helpers.mjs#PlaylistContext._extractSectionConfig(section, overlayId)` changes in exactly one
place — `section.moods?.[…]` becomes `section.overlays?.[…]`. It stays axis-agnostic: the **caller**
decides which id to pass. Everything else (the `+10` overlay offset, the
`config.priority ?? basePriority` precedence) is unchanged.

`PlaylistContext.fromDocument(document, type, scopeEntity, overlayId)`: the fourth parameter is
renamed from `activeMood`, and when omitted defaults to reading the setting named by
`CONST.overlayAxes[CONST.sectionAxis[type]].activeSetting`.

### Renames

`isMood` → `isOverlay`, and `PlaylistContext` gains `overlayAxis` (derived from `context`). Update
every consumer — there are exactly four in `scripts/`, plus four test files:

| File | What it does with it |
|---|---|
| `helpers.mjs` | constructor param, JSDoc, `_extractSectionConfig` return, `fromDocument` |
| `app.mjs` | `winningIsMood` — drives the "this is currently resolving" highlight |
| `playlist-tree.mjs` | same, for the tree |
| `music-controller.mjs` | a log line only |
| `tests/{helpers,app,playlist-tree}.test.mjs` | fixtures + assertions |

The two UI consumers are **load-bearing**: they paint which entry is currently winning. A missed
rename there silently highlights the wrong row.

## O5 — The widget

`MoodWidget` renders the strip for the **active axis**: moods when `!game.combat?.started`, phases
when combat is started.

Requirements:

- `_prepareContext()` selects the axis, then reads that axis's two settings. The template loops one
  generic `overlays` array; `setMood` becomes `setOverlay` and writes to the axis's active setting.
- **Do not hide the inactive axis.** Render it collapsed/dimmed below the active one. A strip that
  swaps under the GM's cursor as combat starts means they reach for "calm" and hit "Phase 2".
  Consider a short input lockout on the swap.
- Re-render on combat start/end. `hooks.mjs#handleUpdateCombat` and `#handleDeleteCombat` already
  fire; add a widget refresh alongside the existing `playCurrentTrack()` call.
- Rename the class only if it is otherwise cheap — `MoodWidget` is referenced by name in the
  settings `onChange` app-refresh sweeps (string comparison on `constructor.name`), in
  `game.gameOrchestra`, and in `playlist-tree.mjs`. If renamed to `OverlayWidget`, update all of them;
  the `constructor.name` string comparisons fail **silently**.

## O6 — Config UIs

- **`app.mjs` + `music-config.hbs`.** The Token layout is a mood-card grid over
  `music.combat.moods.<moodId>` (`_applyMoodGridEntry`, `handleUpdateMoodEntry`,
  `handleUpdateMoodTrack`, `handleClearMoodEntry`, `_prepareMoodGridContext`). Tokens have **only** a
  combat section (`CONST.playlistSections.Token`), so this entire grid becomes **phases** over
  `music.combat.overlays.<phaseId>`. The Scene layout keeps mood tabs for area and gains phase tabs
  for combat.
- **`playlist-tree.mjs` + `playlist-tree.hbs`.** Scene area rows iterate moods; scene combat rows and
  the global-default combat rows iterate phases. `_pathFor(contextType, moodId)` (~line 389) becomes
  axis-aware.
- **`mood-config.mjs`.** Generalise to an axis parameter rather than cloning into a `PhaseConfigApp`
  — it is a small app and the two are structurally identical. Register a second settings menu
  entry for phases.

## O7 — `playlist-ref.mjs`

Pure module; rename with no compat branch:

- `PLAYLIST_REF_MOOD_MODES` → `PLAYLIST_REF_OVERLAY_MODES` (values `active`/`none`/`specific`
  unchanged).
- `ref.moodMode` → `ref.overlayMode`, `ref.moodId` → `ref.overlayId`.
- `selectSectionPlaylistId(section, ref, activeOverlayId)` reads `section.overlays`.
- `resolvePlaylistRefId(ref, { sceneSections, defaultSections, activeOverlayIds })` — the state bag
  now carries **both** active ids, `{ mood, phase }`, and picks by `ref.section` via
  `CONST.sectionAxis`. `helpers.mjs#resolvePlaylistRef` reads both settings and passes them in.
- `describePlaylistRef` label keys follow the axis.

The inspector's overlay dropdown must populate from moods or phases **depending on the ref's
selected section** — switching the section switches the list, and should clear a now-invalid
`overlayId`.

## O8 — Graph conditions

`GraphCondition.kind` gains `'phase'` alongside the existing `'mood'`. Two flat kinds, not
`{ kind: 'overlay', axis, value }` — a flat dropdown is better inspector UX than a kind plus an axis
sub-select.

`_evaluateCondition`:

```js
case 'mood':  return (game.settings.get(CONST.moduleId, CONST.settings.activeMood)  || '') === condition.value;
case 'phase': return (game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '') === condition.value;
```

`graph-validation.mjs` validates a `phase` condition's value against `configuredPhases` the same way
it validates `mood` against `moodIds`; the option list threaded into `validateGraph` becomes
`{ moodIds, phaseIds }`.

## O9 — Phase reset on combat end

`activePhase` resets to `configuredPhases[0].id` when combat ends, behind a world setting
`resetPhaseOnCombatEnd` (Boolean, default `true`). Wire in `hooks.mjs#handleDeleteCombat`.

Without this every fight after the first starts in `Enrage`. Easy to miss, immediately obvious in
play.

## O10 — `activeMood` during combat: decided

**`activeMood` keeps its value during combat and is neither cleared nor frozen.** It stops feeding
*combat-section resolution only*. It continues to drive:

- area music the moment combat ends (so the scene resumes at the right mood),
- `kind: 'mood'` graph conditions,
- Playlist nodes whose ref targets the **area** section.

"Moods don't apply during combat" is true of section resolution, not of the graph layer. Implement
it that way and say so in the code comment — the opposite reading is the natural one and will
otherwise be "fixed" later.

---

# Part B — Loop modes

## L1 — Collapse `infinite` + `loopCount` into a `loop` union

Today a Track carries `infinite: boolean` **and** `loopCount: number`, with the schema documenting
that *"loopCount is ignored when this is true"*. Adding a third field for the new behaviour would
produce **two** conditional-validity rules (`loopCount` ignored when infinite; the new field valid
only when infinite) and nested `if (node.infinite)` branches in both the engine and validation.

Replace both fields with one discriminated union, on **`track` and `playlist` nodes alike** — they
carry the identical pair today, so one shape covers both:

```js
loop: { mode: 'count',   count: 3 }                                    // count >= 1
loop: { mode: 'forever' }
loop: { mode: 'until',   condition, boundary, minLoops, maxLoops }     // track only, for now
```

For a `playlist` node, `count` means **passes**, exactly as `loopCount` does today.

**Land this as a pure refactor first (P3), with no new mode and the suite green.** The three
existing playback strategies must stay byte-identical; only their *selection* changes:

| `loop.mode` | Strategy — unchanged |
|---|---|
| `count`, `count === 1` | `AudioEndWatcher` on `'end'` |
| `count`, `count > 1` | `repeat: true` + `_scheduleLoopStop()` (H3/H6) |
| `forever` | `repeat: true`, no watcher, no scheduled stop, no exit |

This is the highest-risk edit in the plan: it lands in `_enterTrack`, the densest concentration of
*"confirmed live"* comments in the repo, where every failure mode is silent. Do not restructure the
surrounding logic while you are there.

## L2 — `mode: 'until'`

```js
loop: {
  mode: 'until',
  condition: GraphCondition,        // the existing condition vocabulary, verbatim
  boundary: 'loopEnd' | 'immediate',
  minLoops: 1,                      // always complete at least this many
  maxLoops: null                    // optional hard bound; null = unbounded
}
```

Plays seamlessly via native `repeat: true` — the same mechanism as `forever` — and takes its single
exit once the condition matches at a permitted boundary. Semantically: **`forever` with an escape
hatch.**

There is deliberately no `'while'` mode. `while C` is `until !C`, and a negation checkbox on the
condition is cheaper than a second mode with its own validation rules. Add `negate: boolean` to the
condition editor if the inverse is wanted.

**`minLoops` defaults to 1 and is enforced, not advisory.** A node entered when its condition
already matches would otherwise start and stop immediately — an audible glitch and a re-entry
runaway risk. Encode the floor in the schema so it does not get "simplified" away later.

## L3 — Evaluating the condition: poll

Poll on `EngineClock`'s existing cadence (schedule a `${node.id}:until` check; the clock ticks at
500 ms).

Rejected: event-driven subscription per condition kind. It needs a subscription table keyed by kind,
and `enemiesDefeated` has no single hook — it is `updateCombatant` *and* `deleteCombatant`. Polling
is ~10 lines, one clock entry per active node, cannot miss an edge, and degrades exactly like every
other wait in the engine (H4: absolute due-times, Worker-polled, late but never never). At
`boundary: 'loopEnd'` the dominant latency is a whole loop length anyway.

## L4 — Boundaries

**`immediate`** — on match, `stopTrack(sound)`, then release + follow the exit inside **one**
`_walk()`. This is exactly the existing `_scheduleLoopStop` fire path; reuse its shape.

**`loopEnd`** — the musical one, with four traps:

1. **Never read `currentTime` to locate the boundary.** Whether `sound.sound.currentTime` wraps to
   zero per iteration under native `repeat: true` is the same species of undocumented behaviour as
   H3, and the engine's standing policy is to not depend on the answer. Compute from the wall clock:
   boundary *N* is at `startedAt + N × duration × 1000`. `_scheduleLoopStop` already works this way
   and touches `currentTime` only once, for the adoption offset.
2. **Reuse the duration probe verbatim.** `_scheduleLoopStop` polls at 100 ms up to
   `MAX_DURATION_PROBE_ATTEMPTS` (20, ~2 s) and then **gives up and advances** rather than hanging
   the token. A missing file or decode failure must not strand an `until` node forever.
3. **Wall-clock vs audio-clock drift** diverges by tens of ms over a 20-minute loop. Fine for a
   crossfade, not sample-accurate. Comment it; do not redesign for it.
4. **Exit thrash is already covered** — exiting means entering some node, and entry carries both the
   300 ms `MIN_CLEAN_START_INTERVAL_MS` floor and the circuit breaker. Do not add a second throttle.

## L5 — Validation

`graph-validation.mjs`'s `track` case becomes a switch on `loop.mode`:

| Mode | Exits | Other |
|---|---|---|
| `count` | exactly 1 | `count >= 1`; self-loop → existing warning |
| `forever` | exactly 0 | — |
| `until` | exactly **1** | `condition.kind` present and valid; `minLoops >= 1`; `maxLoops` null or `>= minLoops` |

The `until` exit rule **inverts** the current `InfiniteTrackMustHaveNoExit` rule, which is why the
mode must be part of the check rather than a modifier on a boolean.

New message keys (both locale files, HR-E): `UntilTrackMustHaveOneExit`,
`UntilMissingCondition`, `LoopMinLoopsMin`, `LoopMaxLoopsBelowMin`.

## L6 — The idle-detection ripple

**An `until` track that can exit stops being a permanent token holder.** This is the one genuine
semantic change in Part B and it needs targeted tests, not just a green suite:

- A graph whose only durational node is an `until` track **can now go idle**.
- Idle is how a **Playlist node's child engine reports a completed pass**. So an `until` track
  inside a child engine now ends a pass — correct and desirable, and currently impossible.
- [`graph-engine.md`](wiki/graph-engine.md) explicitly states that such graphs "never complete — an
  infinite Track, a shuffle loop — and that is expected." That sentence becomes conditional.
- `hasInstantaneousCycle` is unaffected: `track` is durational under every mode.

## L7 — Editor & inspector

Inspector: a mode `<select>` (Count / Forever / Until), with the mode-specific fields below it.
Reuse the existing Condition-exit editor markup for the `until` condition — it is the same
`GraphCondition` shape.

All of it via `_renderInspector()`. **Never `this.render()`** — HR-A. New `_CHANGE_ACTIONS` entries:
`updateLoopMode`, `updateLoopCount`, `updateLoopUntilKind`, `updateLoopUntilValue`,
`updateLoopBoundary`, `updateLoopMinLoops`, `updateLoopMaxLoops`.

Node canvas label: show the mode (`∞`, `×3`, `until combat ends`) via
`custom-playlist-node-render.mjs`, escaping through `escapeHtml()`.

`graph-presets.mjs`: add **"Loop until combat ends"** — `Start → Track(until combatIdle, loopEnd) →
End`. A preset is how this feature becomes discoverable.

---

## Rejected alternatives

Recorded so they are not relitigated.

| Rejected | Why |
|---|---|
| **`_reenterAt()` + reactive Condition nodes** — an engine-level interrupt that tears down tokens and re-enters at a node | Phases resolve at the **context** layer instead (O1), where the crossfade already exists via H11. The primitive tore down the *whole* engine's tokens (restarting unrelated Fork branches) because the token model tracks no subtree, and it landed new teardown logic beside `stop()`'s stop-before-start race. Unnecessary once phases swap playlists. |
| **Asymmetric storage** — area keeps `moods`, combat gets `phases` | Same mechanism under two names, plus a two-branch read in the hot path. Only justified by migration cost, which does not apply. |
| **Keeping `moods` for both, changing only which setting is read** | A field named `moods` permanently holding phases. This codebase already documents one storage/semantics inversion as a standing hazard (H1/H2). |
| **Neutral `overlays` key with a `moods` fallback reader** | Permanent debt; no released worlds to serve. |
| **One combined `activeOverlays` object setting** | Two flat settings are independently observable, each with its own `onChange`, mirroring the existing pattern. |
| **Data-driven / user-extensible axis list** | Over-engineering for two axes bound to two sections. |
| **`{ kind: 'overlay', axis, value }` condition** | A flat dropdown beats a kind plus an axis sub-select. |
| **`loop.mode: 'while'`** | `while C` is `until !C`; a negation checkbox is cheaper than a second mode. |
| **Event-driven `until` evaluation** | Needs a per-kind subscription table; `enemiesDefeated` has no single hook. Revisit only if 500 ms latency proves visible. |
| **Adding `loopUntil` beside `infinite`/`loopCount`** | Produces two conditional-validity rules and nested branches. The union (L1) removes both. |

---

## Invariant impact

- **H1, H2, H4, H5, H8, H9, H10, H11 — unaffected.**
- **H3, H6 — unaffected in substance**, but both are cited from `_enterTrack` code that L1 restructures.
  Re-anchor the citations; do not weaken the comments.
- **H7 — unaffected.** Conditions still evaluate on token arrival. An `until` node's polling is a
  *new, explicitly scoped* re-evaluation of one node's own escape condition, not a re-evaluation of
  a Condition node's routing. Say so in the comment, or someone will read it as H7 being broken.
- **New H12 (proposed):** *A durational node's "holds its token forever" property is a function of
  its loop mode, not of its node type.* Records the L6 ripple — the tie between `forever`, idle
  detection, and a Playlist node's pass completion. Add to `invariants.md` when P4 lands, with
  confidence **quoted** (it is being written alongside the code, not reconstructed).
- **HR-A** — every editor mutation through `_renderInspector()` (L7).
- **HR-E** — both locale files, same key set. Part A adds a large number of keys.
- **Purity** — `playlist-ref.mjs`, `graph-validation.mjs`, `custom-playback-schema.mjs`,
  `custom-playlist-inspector.mjs`, `graph-presets.mjs`, `config.mjs` all stay Foundry-free. Axis
  descriptors live in `config.mjs` as data; the settings reads stay in `helpers.mjs`/`settings.mjs`.

---

## Work plan

Each phase ends with `npm test` green and no reduction in test count (baseline **852**).

### P1 — Overlay resolution core

`config.mjs`, `settings.mjs`, `helpers.mjs`, `music-controller.mjs`, `playlist-ref.mjs`.

`overlays` storage key; `activePhase`/`configuredPhases`; axis descriptors; `_extractSectionConfig`
+ `fromDocument`; `isMood` → `isOverlay` + `overlayAxis`; `playlist-ref.mjs` renames.

*Accept:* a combat section with `overlays.p2.playlist` wins when `activePhase === 'p2'`, at
base + 10 priority. Area resolution is byte-identical to before. No UI yet.

### P2 — Overlay UI

`mood-widget.mjs` + `.hbs`, `mood-config.mjs`, `app.mjs` + `music-config.hbs`, `playlist-tree.mjs` +
`.hbs`, `hooks.mjs`, both locale files.

Dual-strip widget (O5); phase definitions app (O6); token grid → phases; tree rows axis-aware; phase
reset on combat end (O9).

*Accept:* switching phase mid-combat crossfades to the phase's playlist. Widget shows phases during
combat, moods otherwise, and does not swap under the cursor. `tests/lang.test.mjs` green.

### P3 — `loop` union, pure refactor

`custom-playback-schema.mjs`, `custom-playback-engine.mjs`, `graph-validation.mjs`,
`graph-drawflow-bridge.mjs`, `native-mode-graph.mjs`, `graph-builder.mjs`, `graph-presets.mjs`,
`custom-playlist-inspector.mjs`, `custom-playlist-editor.mjs`, `custom-playlist-node-render.mjs`.

`infinite`/`loopCount` → `loop: { mode: 'count'|'forever' }` on `track` **and** `playlist`. **No new
behaviour.**

*Accept:* every existing test passes with fixtures rewritten to the union; no strategy in
`_enterTrack`/`_enterPlaylist` changed, only its selection.

### P4 — `mode: 'until'`, `boundary: 'immediate'`

Engine, validation, inspector, locale files.

*Accept:* an `until` track loops seamlessly and takes its exit on match. Idle detection and Playlist
pass-completion behave per L6, with tests naming that case explicitly.

### P5 — `boundary: 'loopEnd'`, preset, docs

Wall-clock boundary scheduling, duration-probe reuse, the "Loop until combat ends" preset, and the
full wiki pass below.

*Accept:* exit lands within one loop length of the match, never mid-loop; probe failure advances
rather than hanging.

---

## Wiki changes required

The wiki is the maintained detail behind `CLAUDE.md`; it must not describe unbuilt behaviour. Each
page currently carries a **Planned** pointer to this document — **replace that pointer with the real
content as each phase lands, and delete the pointer.**

| Page | Change | Phase |
|---|---|---|
| [`architecture.md`](wiki/architecture.md) | § *Mood overlay* → *Overlay axes*: the axis table (O1), `overlays` storage, `+10` unchanged, and the O10 decision. § *Storage* table: flag paths. § *Hook wiring*: `activePhase` in the settings-`onChange` trigger row, phase reset on `deleteCombat`. | P1–P2 |
| [`invariants.md`](wiki/invariants.md) | Add **H12** (L6). Re-anchor H3/H6 citations to the `loop.mode` switch. Add a sentence to H7 distinguishing an `until` node's polling from Condition re-evaluation. | P4 |
| [`graph-engine.md`](wiki/graph-engine.md) | § *The schema*: node-type table — the "Holds a token for" column becomes mode-dependent; add `loop` to the typedef summary. § *Per-node behavior* → Track: the three strategies as a `loop.mode` switch, plus `until`. § *Playlist nodes* → *What a "pass" is*: qualify "many graphs never complete". § *Condition*: add `phase`. | P3–P5 |
| [`editor.md`](wiki/editor.md) | Inspector fields for `loop.mode`; the section-driven overlay dropdown (O7). | P2, P5 |
| [`module-map.md`](wiki/module-map.md) | LoC drift; `mood-config.mjs` / `mood-widget.mjs` purpose lines if renamed; add this doc to the Docs table (**already done**). | P5 |
| [`playbook.md`](wiki/playbook.md) | New recipe: *add an overlay axis* (the O3→O7 touch list). Extend *add a node type* to cover loop modes. | P5 |
| [`testing.md`](wiki/testing.md) | Note the `until`/idle interaction as a case the mock must cover. | P4 |
| [`README.md`](wiki/README.md) | Move this doc from *Active plans* to *Archived plan documents* once P5 lands. | P5 |
| `CLAUDE.md` | Rule 1 mentions moods only in passing — no change needed. Update the test baseline count if it moves. | P5 |

---

## Test plan

**Pure, test directly** — `playlist-ref.mjs` (overlay modes, both axes, section switch clearing a
stale `overlayId`), `graph-validation.mjs` (the L5 mode matrix; `phase` condition values),
`custom-playback-schema.mjs`, `graph-presets.mjs` (new preset through `validateGraph` **and** the
Drawflow bridge), `config.mjs` (axis descriptors).

**Foundry mock** — `helpers.mjs` (`_extractSectionConfig` per axis, `+10` offset, `isOverlay`),
`music-controller.mjs` (a phase change re-resolves and crossfades; an area context is still excluded
during combat), `custom-playback-engine.mjs` (`phase` condition; `until` exit at both boundaries;
`minLoops` floor; probe failure advances; **idle fires for an `until` node and completes a parent
Playlist node's pass**), `app.mjs`/`playlist-tree.mjs` (grids read `overlays`).

**Structural** — `tests/lang.test.mjs` covers HR-E automatically.

**Not covered by the suite, state plainly at handoff:** real audio timing, whether `repeat: true`
actually loops gaplessly in a live browser, Drawflow interop, and live Foundry hook names.

---

## Verify live before building on it

One assumption underpins all of Part A: **a phase swap mid-combat crossfades through H11 rather than
restarting.** It follows from `transitionToContext()`'s existing retire path, but it has not been
observed. Check it first — define a combat-section overlay on a scene, switch phases during a fight,
confirm a crossfade and not a restart. Five minutes, and it de-risks the premise.

If it does **not** crossfade, stop and re-plan Part A rather than working around it: the workaround
would be the rejected `_reenterAt` design, and that is a decision to take deliberately.
