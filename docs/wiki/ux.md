# UX strategy

What each surface is *for*, why the current set doesn't cohere, and the principles (**UX-1**–**UX-9**)
that keep the next change from making it worse.

Diagnoses are numbered **D1**–**D8** and carry their current status. D8 records a change that was
shipped and then corrected; the reasoning there generalizes and is worth reading before adding any
control that exposes a resolution *input*.

This page is about **surface shape and placement**, not styling. For how a given window is built,
see [editor.md](editor.md) and [mixer.md](mixer.md); for the constraints any UI work must respect,
see [invariants.md](invariants.md).

---

## The surfaces today

Seven window classes, reached through roughly two dozen entry points.

| Surface | File | Opened from | Modal |
|---|---|---|---|
| `GameOrchestraConfig` | `app.mjs` | Token Config (Identity), Prototype Token Config | no |
| `PlaylistTreeApp` | `playlist-tree.mjs` | Settings menu, keybinding, Mood Widget header, **Scene Config button (scoped)** | no |
| `OverlayConfigApp` | `mood-config.mjs` | Tree footer (two doors: Moods tab, Phases tab) | no |
| `MoodWidget` | `mood-widget.mjs` | Scene control (sounds), keybinding, restored on `ready` | no |
| `CustomPlaylistEditor` | `custom-playlist-editor.mjs` | Playlist Config button, tree card button | no |
| `PlaylistMixerApp` | `playlist-mixer.mjs` | Playlist Config button, directory context menu, editor Tracks pane | no |

Plus non-window surfaces: two scene-control toggles (`hooks.mjs#getSceneControlButtons`), four
keybindings (`settings.mjs#registerKeybindings`), three injected sheet form-groups, and four
`config: true` settings in Foundry's module tab, behind **one** menu door.

> This table reflects everything shipped in the sequencing below. Before it: `MoodConfigApp` and
> `PhaseConfigApp` were two separate modal windows with two settings-menu entries of their own, and
> `GameOrchestraConfig` was a modal that also served scenes.

---

## The five jobs

Abstracting away from windows, a GM using this module is doing one of five things.

| | Job | The user's question |
|---|---|---|
| **J1** | **Bind** | "What plays here?" — attach a playlist to a *scope × section × overlay* |
| **J2** | **Vocabulary** | "Which moods and phases exist in this world?" |
| **J3** | **Behavior** | "How does this playlist play itself?" — the graph |
| **J4** | **Levels** | "Why is this too loud?" — the mixer |
| **J5** | **Perform** | "Switch the mood. Kill the combat music. What's playing right now?" |

J1 has three axes of its own, and they are the source of most of the sprawl:

- **Scope** — world default → scene → token/actor (the priority hierarchy)
- **Section** — `area` | `combat`
- **Overlay** — a mood (area) or a phase (combat), or none (`config.mjs#sectionAxis`)

---

## Where the jobs actually live

| Surface | J1 Bind | J2 Vocab | J3 Behavior | J4 Levels | J5 Perform |
|---|---|---|---|---|---|
| `GameOrchestraConfig` | **token only** (+ `exclusive`/`duck`) | | | | |
| `PlaylistTreeApp` | **scene + world**, full or scoped | links out | links out | | status pills |
| `OverlayConfigApp` | | **yes** | | | |
| `MoodWidget` | | | | | **mood/phase + refresh** |
| Scene controls | | | | | **suppression only** |
| `CustomPlaylistEditor` | | | **yes** | embedded pane | activity highlight |
| `PlaylistMixerApp` | | | | **yes** | |

Read down the J1 column. That was originally **one job, two windows, and neither one complete**;
the two now split cleanly by scope and share their write path, with the token markup merge still
outstanding (step 6b).

---

## Diagnosis

### D1 — The two binding windows have diverged, then partly re-converged *(mostly fixed)*

`GameOrchestraConfig` and `PlaylistTreeApp` edit the same flags, and present them through two
different interaction models:

| | `GameOrchestraConfig` | `PlaylistTreeApp` |
|---|---|---|
| Layout | `fieldset` per section, overlay **tab strip** per section | **card grid** per overlay, six numbered sections |
| Commit | form handler, explicit save | delegated `data-change-action`, writes immediately |
| Element | `tag: 'form'`, **modal** | `tag: 'div'`, non-modal |
| Drag-in from sidebar | no | **yes** |
| Shows what is currently winning | per-tab `★` | `is-resolving` badges + resolution pills |

The convergence is already visible in the source: a Token document renders a **card grid** inside
`GameOrchestraConfig` (`isTokenPhaseGrid`, `app.mjs:306`), and the template comment says it is
*"matching PlaylistTreeApp"*. One window has grown a second window's layout for one document type.

### D2 — Neither binding window can express the whole model

Verified against the templates:

| Field | `GameOrchestraConfig` | `PlaylistTreeApp` |
|---|---|---|
| Playlist per scope/section/overlay | scene, token | scene, world default |
| `initialTrack` | yes | yes |
| **`priority`** | yes (`allowPriority`, `app.mjs:348`) | **was missing — now present, behind `Advanced`** |
| **World default music** | **no** | yes, only here |
| `exclusive` / `duck` | token grid only | n/a — correctly so |

So the window named *"manage playlist hierarchy across scenes and world defaults"* could not set a
priority — the single most confusing part of the model — and the window that can set priority
cannot reach the world default at all. A GM tuning a priority conflict had to open both.

> **`exclusive` and `duck` are not part of this gap.** They are read only through
> `_getCombatantMusicSources()` — token → actor → prototype token — and mean nothing on a scene or
> on the world default. The tree has no token scope at all, so putting them there would have
> created two inert controls. They are correctly where they are; what the hub is missing is the
> **token scope** itself — UX-3's job, and the remaining half of step 6.

**Status: priority ships in the tree, folded behind an `Advanced` disclosure** — and that
demotion is a correction of the first attempt. See *Priority is not the interface* below.

### D3 — Modality contradicts the workflow *(fixed)*

`GameOrchestraConfig` and both overlay-config windows declared `modal: true`. Binding a playlist is
precisely the task where a GM wants to look at, or drag from, the Playlists sidebar — which the
hub supports and a modal cannot. Same job, opposite affordance. **All three are now non-modal.**

### D4 — Two windows for one concept *(fixed)*

`MoodConfigApp` and `PhaseConfigApp` were subclasses of `OverlayConfigApp` differing **only by
axis** — same template, same actions, same list editor — consuming two `registerMenu` slots, two
tree footer buttons, and two sets of lang keys, to express one idea (`config.mjs#overlayAxes`) that
the architecture already models as a single mechanism on two axes.

They are now **one window with a Moods tab and a Phases tab**. The two classes survive as *doors*:
they share `OverlayConfigApp`'s `id`, so they open or re-focus the same window and only choose
which tab is showing. Both lists are held in memory (`itemsByAxis`), switching tabs harvests the
outgoing tab's typed edits first, and one Save commits both axes — writing the inactive one only
when it actually differs from what is stored.

### D5 — Performing is split three ways *(fixed)*

At the table, mid-combat, a GM needs: switch phase (Mood Widget), suppress combat music (scene
control bar or keybinding), and see what is actually winning (a pill inside the 820px hub). Only
the first was on a surface designed to be open during play. **All three are now on the widget**,
sharing one definition with the scene-control bar — see the target shape below.

### D6 — Foundry's settings tab is used as an app launcher *(fixed)*

Three of the module's `registerMenu` entries are windows, not settings. The primary authoring
surface is therefore found at *Settings → Module Settings → scroll to Game Orchestra → Open
Playlist Tree*, while the more advanced graph and mixer sit one click from the playlist they act
on. The discoverability gradient runs backwards.

### D8 — Priority is not the interface *(corrected)*

The first pass at D2 gave every context box an inline priority field — eight per scene, at the same
visual weight as the playlist selector. That closed the parity gap and was the wrong call. Recorded
here because the reasoning generalizes.

**The contest priority arbitrates is almost always already decided.** By the time priority is
consulted, three rules have run: combat categorically drops area, the current combatant is pinned
first, and an overlay carries `+10` over its own section default. What is left is essentially one
recurring contest — *specific scope vs. world default within one section* — and its answer is
always "the specific one wins". A world default is by definition the fallback.

So the number was very nearly a second, absolute, hand-editable encoding of the hierarchy the
window already displays in its own section ordering. **The hierarchy is the priority.** Two
encodings of one ordering can disagree, at which point the window is lying about its model.

Three costs followed:

- **Absolute numbers for a relative problem.** Setting one correctly means knowing every other
  number in the world, and nothing anywhere showed the resulting order.
- **Blank-vs-`0` is invisible state.** Necessary given the storage, but exactly the distinction
  that generates support questions.
- **It made an inconsistency reachable.** Only the drag-and-drop path seeded the baseline into a
  flag, so a dragged binding resolved at `-20` and a visually identical dropdown-picked one at `0`.

The correction, in three parts:

1. **Show the resolution, not the input.** A losing row now says *"Currently overridden by …"*,
   built from the same `describeResolution()` the status pills use. Only rows that were genuinely
   in the contest are labelled — `transport.mjs#isBindingEligible` mirrors the two rules that run
   before priority, because calling a row "beaten" when it was never eligible teaches the wrong
   model.
2. **Demote the knob.** Priority sits in a collapsed native `<details>` per box. The escape hatch
   survives (a "silence" scene that must beat everything is real, if rare); every other GM stops
   paying for it.
3. **Fix the seeding.** `helpers.mjs#sectionBaselinePriority` applies the scope baseline at
   *resolution* time. Nothing writes it into a flag any more, so a stored `priority` now means
   exactly one thing: someone deliberately overrode the hierarchy.

> **The principle this violated was UX-7.** It was cited in support of the original change — but a
> raw input number is not the resolution, it is an input to it. UX-7 asks *"is this the one
> currently winning"*, which the `is-resolving` badge already answered and the beaten-by line now
> completes. Parity between two windows is not the same thing as serving the job.

### D7 — Three names per feature

| Concept | Field label | Button | Window title |
|---|---|---|---|
| Graph | `Custom Playback` | `Edit Playback Graph` | `Custom Playback Graph Editor` |
| Mixer | `Levels` | `Open Mixer` | `Playlist Mixer` |
| Overlays | `Configure Moods` | `Configure World Moods` | `Mood Configuration` |
| Binding | — | `Music Configuration` | `Music Configuration` |

Nothing is wrong individually; collectively a user learns three vocabularies and the docs cannot
settle on one either.

---

## Target shape

**One hub, two workbenches, one transport, one dictionary.** Every surface answers to exactly one
of the five jobs.

```
                       ┌──────────────────────────────┐
   Settings ──one door─│  HUB — the Orchestra panel   │  J1: bind, all scopes,
                       │  (PlaylistTreeApp, renamed)  │      both sections, both axes,
                       │                              │      priority · exclusive · duck
                       └──────┬────────────────┬──────┘
       scoped popout ─────────┘                └───────── links out
   (Scene / Token sheet button:                     ┌─────────────┴─────────────┐
    same component, filtered)                  ┌────┴─────┐              ┌──────┴─────┐
                                               │  GRAPH   │              │   MIXER    │
                       ┌──────────────────┐    │ editor   │              │ (2 hosts,  │
                       │   DICTIONARY     │    │ J3       │              │  already)  │
                       │ Overlays (1 win, │    └──────────┘              │  J4        │
                       │  2 tabs)  J2     │                              └────────────┘
                       └──────────────────┘
   ┌───────────────────────────────────────────────────────────┐
   │ TRANSPORT — Mood Widget + scene controls        J5        │
   │ active axis · suppression · "what's winning and why"      │
   └───────────────────────────────────────────────────────────┘
```

### The hub absorbs J1 entirely

`PlaylistTreeApp` becomes the canonical binding surface and gains what only
`GameOrchestraConfig` has today: **priority**, **exclusive**, and **duck**. Its interaction model
wins the merge — immediate writes through `data-change-action`, non-modal, drag-in from the
sidebar, live `is-resolving` feedback. That model is also what Foundry v13+ sheets do.

`GameOrchestraConfig` does not disappear; it stops being a *different window* and becomes the same
component **narrowed to one document**. The Scene Config and Token Config buttons keep working and
open a small popout showing only that document's rows.

**This is the `MixerController` pattern, applied again.** `playlist-mixer-controller.mjs` proves the
shape: one module owning every read and write, with *no opinion about its host*.

The **write half is done** — `binding-store.mjs` (step 5). It splits into a **store** that knows how
to get/apply paths in one backend and nothing about bindings, and **operations** that know what a
binding is and nothing about storage. Three stores cover every scope: a Document's flags
(`documentFlagStore`), the `updateObject` path a Token/PrototypeToken needs
(`updateObjectStore`), and the `defaultMusic` world setting (`globalSettingStore`). Both windows
now assign, clear, re-track and re-prioritise through the same four operations.

Two things that had already drifted between the three former copies, now fixed by construction:
clearing a binding removes its **priority** as well (a stale priority on an emptied section is
invisible until reassignment, then silently decides a contest), and clearing a *section* leaves
`exclusive`/`duck` standing while clearing an *overlay* removes the entry outright.

> Writes go through `apply()` as a **whole plan**, never one path at a time. A binding change is
> often two or three paths at once, and for the `updateObject` backend each separate write is its
> own document round-trip *and* its own `render()` — a per-path API silently turned one assignment
> into two saves and two re-renders. Caught by an existing test within minutes of the extraction;
> `tests/binding-store.test.mjs` now pins it directly.

The **read half** — one context builder feeding both the hub and a scoped popout — is step 6, and
is blocked on the question below.

### The dictionary collapses to one window

`MoodConfigApp` + `PhaseConfigApp` → one **Overlays** window with two tabs, driven by
`CONST.overlayAxes` rather than by subclassing. One settings menu entry becomes zero: reach it from
the hub, where the moods and phases are visible in context.

### The transport grows into the only play-time surface *(shipped)*

The Mood Widget already gets one rule right — it renders **only the live axis** (phases during
combat, moods otherwise) and does not dim the other one. That discipline is extended rather than
diluted: the widget now also carries the suppression toggles and the *"currently winning"* pill, so
the three things a GM needs mid-session sit on the one surface that is actually open during play.

`transport.mjs` is the shared definition (UX-2). It owns what the suppression toggles *are*
(`SUPPRESSION_CONTROLS`), what toggling one *does* (`setSuppression` — which also re-initializes the
control bar, so a widget-side toggle updates the bar too), and how the winning context is
*described* (`describeResolution`, kept pure and emitting i18n keys per the render-boundary rule).
Three hosts consume it — the widget, the scene-control bar, and the keybindings — and none owns a
second copy of the behaviour.

> **The widget keeps its "open the hub" header button.** An earlier draft of this page had it
> removed. That was wrong on its own terms: UX-1 explicitly permits a surface to *link* to another
> job's home and only forbids re-implementing it. Deleting a working shortcut buys no cohesion.

Compact mode hides the prose pill but keeps the axis pills and the toggles — the parts a GM aims at
rather than reads.

### The settings tab holds settings

`fadeDuration`, `graphCrossfade`, `resetPhaseOnCombatEnd`, `enableDebug` stay. The three
`registerMenu` entries become one: *Open Game Orchestra*.

---

## Principles

Numbered `UX-n` to sit alongside the `H`/`HR` namespaces in [invariants.md](invariants.md). These
are about *where a control lives*, not whether it works.

### UX-1 — One job, one home

Each of the five jobs has exactly one canonical surface. Other surfaces may **link** to it; they
may not re-implement a piece of it. Before adding a control, name which job it serves. If it serves
two, it is two controls or the split is wrong.

> This is the rule D1 and D2 broke: J1 acquired a second home, and the two homes then drifted into
> disjoint feature sets rather than duplicates — which is worse, because neither is sufficient.

### UX-2 — If it appears twice, it is one component rendered twice

The escape hatch for UX-1, and the only one. A control legitimately needed in two places gets a
**host-agnostic controller** — every read, write, and listener in one module, no `render()` call,
hosts supplying an `onRefresh` callback. `MixerController` is the reference implementation and
predates this rule.

A second copy of editing logic is never acceptable, however small. The `muted`-array bug
([mixer.md](mixer.md)) is what a divergent second writer costs.

### UX-3 — Scope is a filter, not a window

World default, scene, and token are the same data at three points on one hierarchy. A scope-specific
entry point opens the canonical component **narrowed**, never a differently-shaped form. Adding a
fourth scope must not add a fourth window.

### UX-4 — A surface opens from the thing it acts on

Playlist-scoped tools (graph, mixer) hang off the Playlist sheet and the Playlists directory.
Document-scoped views hang off that document's sheet. World-scoped surfaces get **one** door in the
settings tab. Foundry's settings tab is not an app launcher (D6).

### UX-5 — One name per concept, in every language file

The field label, the button, the window title, the keybinding, and the wiki use the same noun.
Enforceable by inspection against `lang/en.json`; changing it means changing `lang/pt-BR.json` in
the same commit (HR-E — `tests/lang.test.mjs` fails otherwise).

### UX-6 — Play-time controls never live in an authoring window

If a GM needs it mid-session with players watching, it belongs on the transport. If it is only
touched during prep, it belongs in the hub or a workbench. A control that seems to need both is the
signal to apply UX-2, not to duplicate.

> Corollary: an authoring window may be large, dense, and slow to read. The transport may not.

### UX-7 — Show the resolution, not just the assignment

Priority resolution is invisible by construction — five candidate contexts collapse to one winner
through rules in `music-controller.mjs` that no assignment field reveals. Every surface that
displays a binding also shows **whether that binding is currently winning**, and, when it is not,
**what beat it**. The tree's `is-resolving` badges, its beaten-by lines, the
`active-resolution-pill`, and the editor's live activity highlight are the pattern to copy.

This is the module's primary teaching device. A new binding surface without it ships a mystery.

> **An input is not a resolution.** Exposing the knob that *feeds* resolution — a priority number,
> a threshold, an offset — does not satisfy this rule and usually works against it: the user now
> has two things to reconcile instead of one answer. If you find yourself citing UX-7 for a form
> field, you are probably about to make D8's mistake. Show the outcome; put the knob behind
> `Advanced` if it needs to exist at all.

### UX-8 — Render only what the user can act on now

The Mood Widget's rule, generalized with a scope: **transport surfaces show only the live axis**
(phases during combat, moods otherwise) and render the inactive one not at all, not dimmed.
**Authoring surfaces show both**, because prep is exactly when you configure the axis that isn't
live. Do not "fix" the widget to show both.

### UX-9 — An injected surface degrades to a logged warning

Anything reaching into a core sheet (`hooks.mjs`) finds a stable anchor, builds a `.form-group`
with vanilla DOM, `insertAdjacentElement('afterend')`, and wraps the whole thing in `try`/`catch`
logging at `log(1, …)`. A core rename produces a missing button and a console warning — never a
thrown error, and never a half-built form group.

Unavailability is **shown disabled with a reason**, not hidden: the graph button in a non-`UNSEQUENCED`
playlist is the reference (`hooks.mjs:239`). A button that silently isn't there reads as a broken
module.

---

## Sequencing

Ordered by ratio of coherence gained to risk taken. Each step ships on its own.

| # | Change | Touches | Risk | Status |
|---|---|---|---|---|
| 1 | **Merge Mood + Phase config into one two-tab Overlays window** | `mood-config.mjs`, `overlay-config.hbs`, `settings.mjs`, both lang files, CSS | Low — one class already, two thin subclasses | **shipped** |
| 2 | **Name normalization (UX-5)** | both lang files | Low — key-set parity is test-guarded (HR-E) | **shipped** |
| 3 | **Add priority to the tree** | `playlist-tree.mjs`, `playlist-tree.hbs`, both lang files, CSS | Low — closes D2's gap without moving anything | **shipped, then corrected — see D8** |
| 7 | **Settings tab: three menus → one door** | `settings.mjs` | Low, but only safe once 1 lands — it removes the old routes | **shipped** |
| 5 | **Extract the shared binding core** (`binding-store.mjs`) | new module, `playlist-tree.mjs`, `app.mjs` | Medium — pure refactor, no user-visible change | **shipped** |
| 4 | **Fold suppression + winning-context pill into the widget** (`transport.mjs`) | new module, `mood-widget.mjs`, `hooks.mjs`, `settings.mjs`, CSS | Medium — needs the shared-component extraction | **shipped** |
| 6a | **Scene scope: the Scene sheet opens the scoped hub; un-modal the config window** | `hooks.mjs`, `playlist-tree.mjs`, `playlist-tree.hbs`, `app.mjs` | Medium | **shipped** |
| 8 | **Demote priority; show "beaten by" instead; apply baselines at resolution time** | `helpers.mjs`, `app.mjs`, `transport.mjs`, `playlist-tree.*`, both lang files, CSS | Medium — changes resolved priorities in existing worlds, see below | **shipped** |
| 6b | **Token scope: share the hub's view models + markup with the token grid** | `app.mjs`, `music-config.hbs`, new view module | **High** — do it behind `tests/binding-template.test.mjs` | pending |

Step 7 ran early because it is the same file and the same edit as step 1's menu removal; splitting
them would have left two menu entries pointing at a window that no longer existed under those names.

### Names settled in step 2

| Concept | Everywhere |
|---|---|
| The hub | **Game Orchestra** (window title, settings label, keybinding) |
| The graph | **Playback Graph** (field label, window title; button reads *Edit Playback Graph*) |
| The levels | **Mixer** (field label, window title, context-menu entry) |
| The dictionary | **Moods & Phases**, tabs *Moods* / *Phases* |

`MoodWidget` is deliberately **not** renamed yet, even though it shows phases during combat and
"Mood Widget" undersells it. Its lang keys, CSS classes, setting key (`moodWidgetPosition`) and
class name all say `MoodWidget`; renaming the user-facing string alone would satisfy UX-5 while
making the code harder to search. It is folded into step 4, where the widget is being reworked
anyway.

### Step 6 — the decision, and what shipped

The choice was between the hub **listing** every token/actor that carries an override (a true
whole-world map) and the hub only showing a document when **scoped** to one from its own sheet.
**Scoped-only was chosen** — the smaller surface that still closes D1.

**Shipped: the Scene half.** A Scene sheet's music button now calls `PlaylistTreeApp.openScoped()`,
opening the hub pinned to that scene with the picker and the global sections hidden. Same cards,
same immediate writes, same sidebar drop targets. The tabbed, modal, save-button form scenes used
to get is gone — that was the largest single divergence in D1's table. `GameOrchestraConfig` is
also no longer `modal` (D3), so dragging from the Playlists sidebar works wherever it is opened.

An already-open *unscoped* hub is deliberately not hijacked into scoped mode; it is re-pointed at
that scene and brought forward. The GM asked to see one scene, not to have their map replaced.

**Not shipped: the Token half.** The Token/Prototype-Token button still opens `GameOrchestraConfig`.
Its phase grid is already card-shaped and already writes immediately — the same *idiom* as the hub,
not yet the same *code* — and it remains the only surface for `exclusive` and `duck`. What is left
is view-model and markup sharing, **not behaviour**: the write path is already common
(`binding-store.mjs`), which is what let the copies drift in the first place.

Two prerequisites for that merge are now done, and they were the valuable part:

1. **The templates had no test coverage at all** — the app tests drive handlers directly and never
   render Handlebars, so a dropped `data-context-type` would render a perfect-looking control that
   writes to the wrong section. `tests/binding-template.test.mjs` pins the structural invariants of
   both (every box declares its section and drop scope; every overlay control carries its overlay
   id; every priority input dispatches to a registered change action; `exclusive`/`duck` stay
   outside the phase loop).
2. **`data-section` meant two different things in `music-config.hbs`** — the music section
   (`area`/`combat`) on context boxes, *and* the collapse key (`tokenPhases`, a card id) on headers.
   `handleToggleSection`'s `closest('[data-section]')` could therefore walk out of a card header
   into a binding box and return `'combat'` as a collapse key. Collapse keys are now
   `data-collapse-key`, with a test that the handler ignores `data-section` outright.

### Why the markup merge stopped there

`.playlist-section[data-section]` is `GameOrchestraConfig`'s `dropSelector`, and it matches **two
different elements**: the token grid's context boxes *and* the vestigial scene form's
`.standard-form.playlist-section` (which `openPlaylist`/`deletePlaylist` still read `data-section`
off). Sharing a partial with the hub therefore needs one of:

- a redundant `data-context-type` alongside `data-section` on every box — one attribute duplicated
  purely to satisfy two conventions, or
- **deleting the vestigial scene layout first** — the tabbed form, `selectOverlay`, the
  `allowPriority` fields and the whole `.playlist-section` scene contract. Scenes no longer route
  here, so it is dead weight; but `game.gameOrchestra.GameOrchestraConfig` is public API a user
  macro can still call with a Scene, so removing it is its own change with its own migration note.

The second is correct and should come first. It is a deletion, which is exactly the kind of change
that wants a live Foundry to confirm nothing else reaches the removed path — none of this work has
been run against one.

### Constraints on the remaining token merge

- **Commit semantics change.** `GameOrchestraConfig` is `tag: 'form'` with a form handler and an
  explicit save; the tree writes immediately. Unifying on the tree's model means scene/token
  binding stops being cancellable. That is the better UX and matches core sheets, but it is a
  behavior change worth calling out in release notes, not a silent one.
- **HR-D applies to every new host.** `DragDrop#bind()` runs on every render, unguarded. A popout
  host that guards it orphans drag-and-drop after the first re-render.
- **HR-I applies to the token popout.** Never configure against `app.token` — it is a detached
  preview clone whose `_id` may be dropped entirely. Use `app.document` /
  `app.actor.prototypeToken` (H14).
- **`modal: true` must go** (D3), or the sidebar drag-in the tree model depends on cannot work.
- Both windows already share `GameOrchestraAppMixin` (`app-mixins.mjs`) for collapsed-section
  bookkeeping, delegated `change`/`dragleave`, and the DragDrop lifecycle — that seam is where the
  controller extraction starts.

### Not in scope

The **graph editor** and the **mixer** are already correct under these principles: each serves one
job, opens from the thing it acts on, and the mixer already demonstrates UX-2. Neither needs
consolidating. HR-A in particular means the editor must keep its own render lifecycle — do not try
to normalize it toward the other windows.
