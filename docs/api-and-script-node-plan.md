# Plan — a public API, and a Script node

> ## Status
>
> **Part A (the public API) is shipped** — steps 1–3 of the phasing below. The durable
> documentation is [docs/wiki/api.md](wiki/api.md); this document keeps the *reasoning and the
> alternatives*, which the wiki page deliberately does not repeat.
>
> **Part B (the Script node) is shipped** — steps 5, 6a–6c. Decisions D-B1, D-B4, D-B5, D-B6, D-B7
> (D-B2 and D-B3 were each taken and then reversed; **step 7, the `script` condition kind, was
> built and then removed** — a different approach will be designed later). Durable documentation:
> [graph-engine.md](wiki/graph-engine.md) § *Script*, [node-anatomy.md](wiki/node-anatomy.md),
> [invariants.md](wiki/invariants.md) **H17**, and [api.md](wiki/api.md) § *Scripts calling the API*.
>
> **Coverage pass (after the condition removal).** An audit of what the Script node actually
> guaranteed versus what was tested found one behavioural gap and two false comments:
>
> - **`graph.set()` skipped every Script rule.** Each one is environment-dependent and self-skips
>   when its context is absent, so the API held script nodes to a *lower* bar than the editor while
>   documenting the opposite. Fixed by `api.mjs#scriptValidationContext()`; `macroValidationList()`
>   moved to helpers.mjs so both write paths read one definition. `set()` now takes `options`.
> - **`fail()` dropped its third argument**, so every user-code throw was logged without its stack —
>   the one failure mode where the stack is the whole point.
> - **`canAuthorInlineScripts`'s doc claimed it gated `api.graph.set()`.** It never did, and it
>   should not: the comment was corrected rather than the code. See api.md for the reasoning.
>
> 29 tests added across five files, each mutation-verified. The one that needed rewriting to bite:
> the timed-out-script test originally asserted on `playTrack`, where a second hop is absorbed by
> the singleton rule at the *destination* — it now asserts on the hop itself.
>
> **Step 4 is run and green.** `itest/specs/005-platform-assumptions.spec.mjs`, all four tests
> passing against a live v14 build. Every assumption this plan deferred is now discharged:
>
> - **`Macro#execute` forwards an arbitrary scope, and returns the script's value.** The fallback —
>   compiling `macro.command` ourselves, keeping the permission check and losing core's execution
>   semantics — **is not needed and should not be built.** `_runMacroScript` stands as written.
> - **Both access shapes work.** Core passes `scope` *and* spreads its keys as named parameters, so
>   a macro can read either `scope.gameOrchestra` or a bare `gameOrchestra`. The inspector hint
>   documents `scope.gameOrchestra` — the explicit one, and the one that cannot collide with a
>   local. See B5.
> - **`this` inside the macro is the Macro document**, not the node or the engine. Nothing in the
>   design reads it; recorded so nobody later assumes it is the context.
> - **CSP permits `Function` and `AsyncFunction`** on stock Foundry, with no CSP meta tag present.
>   This does **not** retire D-B6: it proves the pinned container, not The Forge or any self-host
>   behind a hardening proxy. The runtime probe remains the thing that answers it per deployment.
> - **A chat macro is a distinct `type` with a non-JS `command`**, so `graph-drop.mjs`'s rejection
>   is correct rather than merely cautious.
> - **`renderPlaylistConfig` fires, `select[name="mode"]` exists inside a `.form-group`, and the
>   module's button lands in the sheet** — end to end, not just the handler in isolation.
>
> Two deviations from the originally reviewed text, each recorded where it happened:
> `api.bind` ships **one polymorphic `set(target, …)`** rather than `setDefault`/`setScene`/`setToken`
> (§ A2); and B5's claim that inline source was "gated twice" **was wrong** — the second gate is a
> no-op and has been removed rather than kept as reassurance (§ B5).

Two changes that look separate and are not. A Script node is only useful if there is a supported
surface for it to call, and a public API is only interesting if something inside the graph can
reach it. Designing them together keeps one vocabulary instead of two.

Both are also the first parts of this module that a **third party** depends on, which changes the
cost of getting them wrong: everything else here can be refactored freely, and these two cannot.

Read alongside [invariants.md](wiki/invariants.md) and [node-anatomy.md](wiki/node-anatomy.md).

---

## Decisions taken

Settled at review. The rest of this document is written as if these hold.

| | Decision | Consequence |
|---|---|---|
| **D-A1** | **Reads and writes ship together.** One increment covering both API phases. | Makes step 1 (extracting H1/H2 enforcement out of `handleSave()`) a **hard prerequisite**, not a tidy-up — `api.graph.set()` cannot exist without it. |
| **D-A2** | **A call that cannot do what its name says throws** a typed `GameOrchestraApiError` with a code. | `api.isHeadGM()` / `api.canControl()` must ship in the same increment, or a caller has no way to branch before calling. |
| **D-A3** | **`api.version` starts at `0.1.0`.** | The shape is explicitly not frozen yet. Signatures may be corrected after real macro use without a major bump or a compatibility shim. Revisit `1.0.0` once Part B has exercised the surface. |
| **D-A4** | **`game.gameOrchestra` stays a silent alias; the legacy class keys warn.** | The seven legacy references get getters logging a one-time level-2 deprecation. Nothing breaks; the path to deleting the vestigial scene layout in `music-config.hbs` opens. |

One smaller call taken by default, flagged rather than asked: **`api.graph.set()` refuses on
error-level issues only, and returns any warnings**, matching what the editor already does. A stricter
API than the UI would be its own surprise.

### Part B

Settled at review after Part A shipped. Two of them interact, and the order matters.

| | Decision | Consequence |
|---|---|---|
| **D-B1** | **A script gets the full `api`, plus a re-entrancy guard.** Calls that would restart or stop the engine currently executing the script are refused with a new `SELF_REENTRANT` code. | The engine must pass its own identity into the execution context, and `api.mjs` gains a notion of "currently executing". |
| ~~**D-B2**~~ | ~~**The `script` condition kind is in scope.**~~ | **Reversed by D-B7.** Built, then removed — a different approach will be taken later. |
| ~~**D-B3**~~ | ~~**Inline only. One storage shape everywhere**~~ | **Superseded by D-B5.** Kept here because the reasoning still explains why *conditions* are inline. |
| **D-B4** | **`SCRIPT_TIMEOUT_MS` is a world setting, default 5000 ms.** | One setting, one lang key pair in **both** locales (HR-E). |
| **D-B5** | **A Script node stores a `macroUuid` *or* inline `source`, with `macro` the default** — the union D-B3 had removed. Conditions stay inline regardless (D-B2). | Restores core's authorship gate for nodes, two execution paths, and the `fromUuid` lookup at playback. Enables a **live link** when a macro is dragged onto the graph — see B9. |
| **D-B6** | **CSP is probed at runtime and degrades**, not verified once. | Inline node source goes inert with a visible reason on a locked-down host; step 4 stops gating the design. See B5. |
| **D-B7** | **The `script` condition kind is removed**, reversing D-B2. A different approach will be designed later. | Step 7 is unshipped: the kind, its inspector input, its chip, its validation rules and the synchronous compile path are all gone. Nothing else in Part B depended on it — see below. |

> **What D-B7 changed, and what it deliberately did not.** The condition kind was the *only* consumer
> of a synchronous compile path, so `compileConditionExpression` and the two-shape table in
> `script-runtime.mjs` went with it; that module now has one shape. `CONDITION_KINDS_WITH_SOURCE`
> is gone and `conditionMissingValue`/`conditionSignature` are back to consulting overlay kinds only.
>
> **The Script node is untouched.** It never used the condition path — it compiles as an
> `AsyncFunction` and may `await`. D-B5's union survives on its own merit (the live macro link a
> drag implies), which is worth noting because D-B3's reversal was *argued* partly from D-B2: that
> argument is now void, and the conclusion still holds for the reason recorded under D-B5.
>
> One thing genuinely got smaller: with conditions gone, **inline node source is the only thing this
> module compiles itself**, so a blocked CSP now costs one mode rather than a mode and a whole
> condition vocabulary. D-B6 handles it either way.

> **Why D-B3 was reversed, recorded because the reversal is the interesting part.** D-B3 was taken
> on the reasoning that D-B2 had already paid inline's costs, so a second mechanism earned nothing.
> That held right up until the **drag-a-macro-onto-the-graph** gesture was raised. Under inline-only
> that drop can only ever *copy* a macro's source, so a GM who later edits the original macro is
> silently running a stale snapshot — no error, no console warning, nothing on the node to see. A
> live link is the difference between the gesture meaning "link this macro" and meaning "paste this
> macro once", and the first is what a GM will assume from a drag.
>
> Neither the interaction with D-B2 nor the correction in B5 is invalidated: **conditions are still
> inline-only** (they must be synchronous), and inline source is still gated by one world setting
> whose companion gate was a no-op. What changes is that the node gets a second, safer mode back,
> and it is the default.

> **D-B2 is why the *condition* has no macro form.** A `script` condition must be synchronous —
> `_evaluateCondition` is polled at 2 Hz and is injected into `planNextHandoff`, a *pure* module —
> and macro execution is async. So a script condition can only ever be an inline expression stored
> in the graph. Choosing to build them committed the project to inline source, self-compilation, the
> CSP dependency, and an execution gate before the node's own storage was even discussed. Macro mode
> would then have been a *second* mechanism covering a subset of the same ground.

> **What *inline* gives up, stated once so it is not rediscovered as a surprise.** Core gates
> *authorship* of script macros behind the `MACRO_SCRIPT` user permission, so a player without it
> cannot write one at all. Inline source has no equivalent we can fully enforce: the graph is a flag
> on a Playlist, and any **owner** of that playlist can write it through `api.graph.set()` or a raw
> `setFlag()`. The module gates the two write paths it owns (B5) and cannot gate the third.
> **Execution** is therefore the real boundary for inline, and it is one world-scoped, GM-only,
> default-off switch.
>
> Under D-B5 this applies to **inline node source and every script condition** — not to a
> macro-mode node, which is back inside core's own permission model. That is the strongest argument
> for keeping `macro` the default mode, and for the setting's hint saying which of the two it
> governs.

---

## Goals, and non-goals

**Goals**

- A macro or another module can *read* what is playing and why, *drive* the transport
  (mood/phase/suppression), *bind* playlists at any scope, and *author* graphs — without reaching
  into module internals.
- A graph can run arbitrary logic at a point in its own flow, with the same safety nets every other
  node type gets.
- Both surfaces carry a **stability contract**, so the rest of the module stays refactorable.

**Non-goals**

- Not a socket/networking API. The head-GM rule (CLAUDE.md rule 5) stands: nothing new is
  broadcast, and a script node does not run on every client.
- Not a replacement for the editor. The graph API is for generation and inspection, not for a
  second authoring UI.
- Not a plugin system. No third-party node types, no registration hooks for new condition kinds.
  Those are a much larger commitment and the Script node covers most of what they would buy.

---

# Part A — The public API

## A1. Where it lives

```js
game.modules.get('game-orchestra').api        // canonical
game.gameOrchestra                            // legacy alias, same object
```

**Per D-A4**, the alias itself is silent — someone with a working macro did nothing wrong and gets no
noise. The **legacy class keys** (`GameOrchestraConfig`, `MoodWidget`, `MoodConfigApp`,
`PhaseConfigApp`, `CustomPlaylistEditor`, `PlaylistMixerApp`, `musicController`) become getters that
log a **one-time** level-2 deprecation naming the replacement. One-time matters: a macro in a loop
would otherwise flood the console, and a warning nobody can read is not a warning.

`moodWidget` is assigned at runtime and stays a plain read/write property — it is state, not a
deprecated door.

`game.modules.get(id).api` is the Foundry convention and the only one another module author will
guess. `game.gameOrchestra` already exists and already has at least one documented consumer —
[ux.md](wiki/ux.md) notes that `game.gameOrchestra.GameOrchestraConfig` "is public API a user macro
can still call with a Scene", which is precisely the reason the vestigial scene layout in
`music-config.hbs` has not been deleted.

So it cannot simply be replaced. The proposal:

- Build **one** object in `init` and assign it to both names.
- It carries the new namespaces (below) **plus** every existing key, still working exactly as it
  does today.
- The old keys are **legacy, frozen, no compatibility promise beyond the next major**. The new
  namespaces are the supported surface.

New file `scripts/api.mjs`, assembling the namespaces from existing modules. It is a **facade with
no logic of its own** — every method delegates to `music-controller.mjs`, `binding-store.mjs`,
`transport.mjs`, `playlist-mix.mjs`, or `graph-*.mjs`. If a method needs behaviour that does not
exist yet, that behaviour goes in the owning module and the facade calls it. This is the same rule
`MixerController` follows (UX-2) and it is what keeps the API from becoming a third implementation
of anything.

## A2. Shape

Namespaced by **the five jobs** (ux.md), because that vocabulary already exists, is already the
organising principle of the UI, and gives a macro author the same mental model the windows teach.

```js
api.version        // '0.1.0' — the API contract's own version, not the module's (D-A3)
api.isHeadGM()     // boolean — is this client the one running the engine
api.canControl()   // boolean — may this user perform transport/bind writes

api.transport      // J5 — perform
api.bind           // J1 — bind
api.graph          // J3 — behaviour
api.mix            // J4 — levels
api.playback       // engine state + control (no J number; it is the thing the jobs act on)
api.hooks          // frozen map of hook-name constants
```

### `api.transport` — J5

```js
await api.transport.setMood(moodId)          // '' / null clears
await api.transport.setPhase(phaseId)
api.transport.getMood()                      // string
api.transport.getPhase()
api.transport.listMoods()                    // [{id, label, icon, color}] — labels localized
api.transport.listPhases()
await api.transport.setSuppression('area'|'combat', boolean)   // omit value to toggle
api.transport.getSuppression()               // {area: bool, combat: bool}
await api.transport.refresh()                // = playCurrentTrack()
api.transport.describeCurrent()              // localized "what is winning and why"
```

`describeCurrent()` is `transport.mjs#describeResolution` + `localizeResolution`, which already
exist and are already pure. This is the single most-requested read for a macro ("show me in chat
what music is playing") and it must go through the same describer the pills use, or a fourth
description of resolution appears (UX-2).

### `api.bind` — J1

Thin wrappers over `binding-store.mjs`'s four operations, one method per *scope × section ×
overlay* combination the store already supports:

```js
await api.bind.setDefault({ section, overlayId?, playlistId, trackId? })
await api.bind.setScene(scene, { section, overlayId?, playlistId, trackId? })
await api.bind.setToken(tokenOrActor, { section, overlayId?, playlistId, trackId? })
await api.bind.clear(target, { section, overlayId? })
api.bind.read(target)                        // resolved view of one document's bindings
api.bind.resolve()                           // the winning PlaylistContext right now
```

> **Shipped as one polymorphic `set(target, …)`**, not three named methods. The three would have
> been the same body behind three names, and a fourth scope would have wanted a fourth — which is
> UX-3's "scope is a filter, not a window" applied to a function signature. `setDefault(x)` is
> `set('default', x)`.

`target` is a `Scene`, `TokenDocument`, `Actor`, or the string `'default'`. The facade picks a
backend from the target's type via `helpers.mjs#getDocumentCategory`, which already tests
`instanceof foundry.data.PrototypeToken` rather than trusting `constructor.name` (HR-J).

**Three of the four targets need no new code**, which was worth checking before committing to this
namespace:

| Target | Backend | New code? |
|---|---|---|
| `Scene`, `TokenDocument` | `documentFlagStore(document)` | none |
| `'default'` | `globalSettingStore()` | none |
| `Actor` → prototype token | `updateObjectStore(host)` | **yes — a headless host** |

`updateObjectStore` takes a host exposing `{updateObject, readData}`, which today is only ever
`GameOrchestraConfig` — an application instance the API has no business constructing. So the
prototype-token path needs a small headless host that writes
`actor.update({'prototypeToken.flags.game-orchestra.<path>': …})` directly.

Two hazards land squarely on that one new object, and both have already shipped as live bugs:

- **HR-J** — the key is a **dot path**. `flags['game-orchestra']` produces a literal key the Actor
  schema silently drops, and `actor.update()` resolves successfully having written nothing.
- **HR-I** — never write against a sheet's preview clone. The headless host is immune by
  construction (there is no sheet), which is an argument for it rather than for reusing
  `GameOrchestraConfig`.

And **H14** is why the target is worth supporting at all: a placed token holds a *copy* of the
prototype's flags, so writing the prototype changes nothing about tokens already on the canvas. The
API must not imply otherwise — `api.bind.setToken(actor)` and `api.bind.setToken(tokenDocument)` are
genuinely different operations, and the docs say so.

**Writes go through `apply()` as whole plans**, exactly as the typedef requires — the facade must
not offer a per-path setter, or it reintroduces the two-round-trip bug
`tests/binding-store.test.mjs` pins.

`priority` gets **no setter**. D8 removed it from every surface deliberately; re-exposing it as an
API method would be the same mistake one layer down. `applyBindingPriority` stays internal and
reachable, per D8's own note, but it is not part of the contract.

### `api.graph` — J3

```js
api.graph.get(playlist)                      // deep clone of the stored CustomGraph, or null
await api.graph.set(playlist, graph)         // validates first; throws on error-level issues
await api.graph.remove(playlist)
api.graph.validate(graph, {playlist} = {})   // {issues: [{severity, key, ...}]} — i18n keys
api.graph.localizeIssue(issue)               // the render boundary, offered so callers need not
api.graph.builder()                          // graph-builder.mjs#createBuilder
api.graph.presets                            // graph-presets.mjs, frozen
api.graph.schema                             // {DURATIONAL_NODE_TYPES, ALL_NODE_TYPES, resolveLoop, …}
```

Three things here are load-bearing:

- **`get()` returns a deep clone.** Handing back the live flag object invites a caller to mutate it
  in place, which writes nothing, and then to be surprised. Clone at the boundary.
- **`set()` validates and refuses.** The editor blocks saving on error-level issues; an API that
  did not would be the easiest possible way to write an unplayable graph.
- **`set()` force-writes `mode: UNSEQUENCED` (H1) and never assigns an `initialTrack` (H2).** These
  are enforced in `handleSave()` today, which is a UI path. The moment a second writer exists, that
  enforcement has to move somewhere both can call. Extracting it is a prerequisite, not a nicety.

`set()` also triggers `handleUpdatePlaylist` → `onCustomGraphChanged` for free (H8) — the write is
a document update like any other. Worth documenting loudly: **`api.graph.set()` on a playing
playlist restarts it from Start** (H9). There is no in-place graph patch and there should not be.

### `api.mix` — J4

```js
api.mix.get(playlist)                        // normalized mix
await api.mix.setVolume(playlist, soundId, v)
await api.mix.setMuted(playlist, soundId, boolean)
api.mix.setSolo(playlist, soundId, boolean)  // session state, not persisted — sync
await api.mix.setGroupGain(playlist, value)
await api.mix.setDuck(factor)                // the activeDuck world setting
api.mix.effectiveVolume(playlist, soundId)   // playlist-mix.mjs, pure
```

Everything here already exists in `MixerController` / `playlist-mix.mjs`. The facade must call the
controller, not re-derive — HR-G's mix is applied on every client, and a second writer that forgot
that would produce exactly the "GM hears the ceiling, players hear the raw track" split.

### `api.playback` — engine state

```js
api.playback.isPlaying()                     // boolean
api.playback.currentContext()                // PlaylistContext (frozen view) or null
api.playback.currentPlaylists()              // base + every layer
api.playback.activity(playlist)              // = MusicController#getGraphActivity
await api.playback.stop()                    // retire engines; crossfades (H11)
await api.playback.play()                    // = playCurrentTrack()
```

Deliberately narrow. It does **not** expose `_customEngine`, `_layers`, `_activeNodes`,
`_activeSoundOwners`, or any way to move a token by hand. Those are the mechanisms every hazard in
[graph-engine.md](wiki/graph-engine.md) protects; a caller that could poke them could break audio
in ways no amount of internal discipline prevents.

### `api.hooks`

A frozen map of the hook names, so callers do not hard-code strings:

```js
api.hooks.GRAPH_ACTIVITY   // 'gameOrchestraGraphActivity'  — exists today
api.hooks.CONTEXT_CHANGED  // 'gameOrchestraContextChanged'
api.hooks.TRACK_STARTED    // 'gameOrchestraTrackStarted'
api.hooks.TRACK_STOPPED    // 'gameOrchestraTrackStopped'
api.hooks.OVERLAY_CHANGED  // 'gameOrchestraOverlayChanged'  — one hook, axis in the payload
api.hooks.SCRIPT_ERROR     // 'gameOrchestraScriptError'
```

Four are new. Each must follow `_emitActivity`'s existing discipline exactly, and this is the part
most likely to be got wrong by someone adding a fifth later:

> **Every hook this module fires is fire-and-forget and non-fatal.** `Hooks.callAll()` runs
> listeners *synchronously*. An exception from a third-party listener on a hook emitted inside the
> token walk propagates straight into the walk and **silently stops playback**. Wrap the emit,
> catch, log at level 1, continue. `custom-playback-engine.mjs#_emitActivity` is the reference.

`OVERLAY_CHANGED` is one hook carrying `{axis: 'mood'|'phase', from, to}` rather than two, because
`CONST.overlayAxes` already models the two axes as one mechanism and D4 is the record of what
splitting them costs.

## A3. The head-GM problem

This is the largest footgun in the whole surface and it deserves to be designed, not documented
away.

Three different permission shapes are tangled together:

| Operation | Runs where | Fails how, today |
|---|---|---|
| `transport.setMood` | writes a **world setting** | a non-GM gets a Foundry permission rejection |
| `bind.setScene` | writes a **document flag** | depends on the user's ownership of that Scene |
| `playback.play/stop` | only meaningful on the **head GM** | silently returns on every other client |
| `mix.setVolume` | writes a world flag, applies **everywhere** | GM-only write, universal effect (HR-G) |

The third row is the dangerous one: `playCurrentTrack()` returns early on every non-head client, so
a player's macro calling `api.playback.play()` does nothing at all and reports success. That is
exactly the silent-failure class this codebase's comments exist to warn about.

**Decided (D-A2).** Every API method that cannot do what its name says on this client **throws**, with
a typed error, rather than returning:

```js
class GameOrchestraApiError extends Error {
  constructor(code, message) { super(message); this.name = 'GameOrchestraApiError'; this.code = code; }
}
// codes: 'NOT_HEAD_GM' | 'NOT_PERMITTED' | 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'VALIDATION_FAILED'
```

`api.isHeadGM()` and `api.canControl()` therefore ship **in the same increment** — throwing without a
way to branch beforehand is not a contract, it is a trap. A thrown error a macro author sees in the
console on their first run is worth more than a `return false` they never notice.

Reads never throw on permission — a player may legitimately ask what is playing.

Two shapes to get right in the implementation, both easy to miss:

- **Check before doing, not after.** `NOT_HEAD_GM` must be raised at the top of the method. Calling
  through to `playCurrentTrack()` and inspecting the result cannot distinguish "returned early
  because not head GM" from "ran and had nothing to play".
- **`NOT_PERMITTED` is Foundry's answer, not ours.** Do not re-derive whether a user may write a
  Scene flag; attempt it and translate the rejection. A second permission model would drift from
  core's the first time ownership rules change.

## A4. The stability contract

`api.version` is semver, **independent of the module version**, and documented in a new wiki page.

**It starts at `0.1.0` (D-A3)**, and the leading zero is the whole point: the shape has not been used
by anyone yet, and pretending otherwise buys a compatibility shim for a decision nobody has tested.
Under 0.x, a signature may be corrected in a minor bump — with a release note, never silently. The
move to `1.0.0` is a deliberate later act, and Part B is the thing that earns it: a Script node is
the first *in-repo* consumer of this surface, which makes it the first real test of whether the shape
is right.

The rules that hold from day one regardless:

- Anything reachable from `api.*` is contract. Anything else — the legacy `game.gameOrchestra` keys,
  every `_`-prefixed member of every class — is not.
- Objects handed *out* are clones or frozen. Objects handed *in* are treated as untrusted and
  normalized through the existing resolvers (`resolveLoop`, `resolvePlaylistRef`,
  `resolveGraphCrossfadeMs`, `normalizeMix`). A caller's malformed graph must degrade exactly the way
  a malformed stored one does, not take a second path.
- `tests/api.test.mjs` asserts the **shape** — every documented name exists and is the documented
  kind. That test is the contract's enforcement, the way `tests/lang.test.mjs` is HR-E's, and it is
  what makes a signature change show up as a failing test rather than as someone's broken macro.

---

# Part B — The Script node

## B1. What it is for

Three things a graph cannot express today and that keep coming back:

1. **Side effects at a musical moment** — post to chat when the boss theme starts, dim the lights
   at the phase change, set a flag another module reads.
2. **Conditions the fixed vocabulary does not cover** — "the party's average HP is below 30%",
   "this actor has this status effect". `enemiesDefeated` is the one such condition that got
   hard-coded, and it is a preview of an unbounded list.
3. **Reading module/system state** to drive routing without a new condition kind per system.

## B2. Durational, not instantaneous — and this is the whole design

`script` joins `DURATIONAL_NODE_TYPES`. That single decision hands it, for free, every safety net
the engine already has:

| Net | What it does for a script |
|---|---|
| Singleton rule | one execution at a time per node — no re-entrancy, no overlapping runs |
| `_throttleNodeEntry` (300 ms) | bounds a `Script → Script` cycle to ~3 Hz |
| Circuit breaker (15 / 2 s) | stops the engine outright on a genuine runaway |
| `hasInstantaneousCycle` | a script loop is **not** rejected at edit time — it is a legitimate shape |
| `_walk()` / idle | a running script keeps the engine non-idle, so a parent Playlist node waits |

Making it instantaneous would forfeit all five. Worse, `hasInstantaneousCycle` would reject
`Script → Condition → Script`, which is one of the shapes people will most want.

The implementation is **`_enterDelay`'s exact shape**: register in `_activeNodes` synchronously,
run, then release and advance inside **one** `_walk()`:

```js
await this._walk(async () => {
  this._activeNodes.delete(node.id);
  await this._followSingleExit(node.id, 0);
});
```

per the idle rule in [graph-engine.md](wiki/graph-engine.md) — releasing and advancing as two steps
lets a parent observe a false idle in between.

**A script must not be able to hold a token forever.** A hanging promise (an unresolved dialog, a
`fetch` to a dead host) would strand the token silently and permanently — the exact failure mode of
the stop-before-start race. So execution races an `EngineClock` timeout (`SCRIPT_TIMEOUT_MS`,
proposed **5000 ms**, world setting). On timeout: log at level 2, release, follow the exit. The
script's promise is abandoned, not cancelled — nothing can cancel it — which is worth stating in
the node's own comment, because a late-resolving script writing to `run.ctx` after its node has
moved on is a real and confusing possibility.

## B3. Schema

A discriminated union (D-B5), with `macro` the default:

```js
{
  id, type: 'script', label?, x, y,
  script: {
    mode: 'macro' | 'inline',
    macroUuid?: string | null,   // mode === 'macro' — a LIVE link, resolved at run time
    source?: string              // mode === 'inline'
  }
}
```

and the condition form, which has **no macro variant** (D-B2 — it must be synchronous):

```js
{ kind: 'script', value: 'game.combat?.round > 3' }
```

Read through **`resolveScript(node)`** in `custom-playback-schema.mjs`, never `node.script`
directly — same discipline as `resolveLoop()`, and for the same reason: a graph saved before this
field existed, or one written by an API caller, must degrade identically everywhere rather than
having each of the four readers (engine, inspector, node renderer, validator) invent its own
default. Default: `{mode: 'macro', macroUuid: null}` — an unconfigured script node is a no-op that
follows its exit, never an error at runtime.

> **`resolveScript()` matters more here than it would have under D-B3.** This is a *union*, and
> `graph-drawflow-bridge.mjs` already carries the scar from the last one: routing a Track's `loop`
> through anything that collapsed the union on the way out silently reverted every `until` loop to a
> 1-count loop the moment any other field on the node changed. Route `script` through `resolveScript()`
> on **both** the export and the import side of the bridge, and add a round-trip test that a
> `mode: 'inline'` node survives an unrelated edit — that is the exact bug this schema shape invites.

Other schema-adjacent edits:

- `ALL_NODE_TYPES` and `DURATIONAL_NODE_TYPES` gain `'script'`.
- **`findUpcomingTrackNodes()` crosses a Script node**, like Delay — the track after a script is
  still the next audio to warm.
- **`planNextHandoff()` returns `null` on a Script node**, like Delay and Playlist. A script's
  duration is unknowable and its side effects may change what the next condition resolves to;
  arming across it would predict from state the script is about to invalidate. This is the correct
  conservative answer and it costs only the hand-off optimisation, never correctness.
- `graph-drawflow-bridge.mjs` round-trips `script` as whole-node `data` — no `exits[]` involvement,
  since a Script node has one unguarded exit (H5 does not apply).

## B4. The execution context

One argument, an object, so the signature can grow without breaking callers:

```js
{
  playlist,          // the Playlist document this graph belongs to
  node,              // the Script GraphNode (frozen clone)
  graph,             // the CustomGraph (frozen clone)
  run: {
    id,              // the engine's _runId
    ctx              // plain object, shared by reference across one run — scratch space
  },
  api,               // the Part A object, with the re-entrancy guard armed (D-B1)
  log                // the module's log(), pre-tagged with the node id
}
```

`run.ctx` is **shared by reference down the whole engine tree**, the same way `_registry` is, so a
script in a nested Playlist node's child engine sees what a script in the root wrote. A run is one
musical event; splitting the scratch space per engine would surprise.

It is **not** persisted and is discarded when the run ends. `run.id` is there so a script that
schedules its own follow-up can check whether the run is still current, exactly as every internal
callback does.

**Return value is ignored.** See B7.

### The re-entrancy guard (D-B1)

A script runs on the head GM, so **every** API call in its context succeeds — there is no
`NOT_HEAD_GM` to save it. That includes the two shapes that eat the engine executing them:

| Call | What actually happens |
|---|---|
| `api.graph.set(ownPlaylist, …)` | fires `updatePlaylist` → `onCustomGraphChanged` → engine torn down and rebuilt from Start (H8/H9), **while this script's node is holding a token** |
| `api.playback.stop()` / `.play()` | retires the running engine tree from inside one of its own nodes |

Neither is caught by anything today. The 300 ms throttle and the 15/2 s circuit breaker would
eventually intervene, but a breaker trip is a diagnosis, not a guardrail — and the user hears the
music restart in a loop until it fires.

So the API gains a sixth error code, **`SELF_REENTRANT`**, and a small piece of ambient state: the
playlist id whose engine is currently executing a script. `api.graph.set`/`remove` refuse when the
target is that playlist; `api.playback.play`/`stop` refuse outright while a script is executing.

Three properties this must have:

- **It is scoped to the executing engine, not global.** A script may legitimately rewrite a
  *different* playlist's graph — that is one of the better reasons to have the node at all.
- **It covers the whole engine tree.** A script inside a Playlist node's child engine must not be
  able to restart the root, so the guard is keyed on the run's registry (which children already
  share by reference), not on one engine instance.
- **It must be released on every exit path**, timeout and throw included — the same discipline as
  `_releaseTrackNode`/`_releasePlaylistNode`, and for the same reason: a leaked entry makes that
  playlist permanently unwritable through the API for the rest of the session.

## B5. Security

A script node's source lives in a **world flag on a Playlist document**, and executes on the **head
GM's client with GM privileges**. Anyone with OWNER on that playlist can therefore write code that
runs as the GM. Default Foundry permissions do not give players playlist ownership, but they can be
granted, and "can be granted" is enough.

### Correcting the plan's original design

An earlier draft of this section claimed inline source was "gated **twice**": the
`allowInlineScripts` world setting, **and** `game.user.can('MACRO_SCRIPT')` on the executing client.

**The second gate does nothing.** The engine runs on the head GM and nowhere else, so the executing
client is always a GM, who always has `MACRO_SCRIPT`. Against the threat that actually matters — a
player with playlist ownership storing JS that the GM's client then runs with GM privileges — it is
a no-op. It is removed rather than kept as reassurance; a gate that cannot fail is worse than no
gate, because it makes the design look twice as defended as it is.

### Two mechanisms, two postures (D-B5)

**`mode: 'macro'` — inside core's model.** Stores a UUID and resolves it at run time, so execution
goes through `macro.execute({ gameOrchestra: ctx })` and inherits core's `Macro#canExecute` check,
core's ownership model, and — the part inline can never replicate — core's gating of *authorship*:
a user without `MACRO_SCRIPT` cannot create a script macro at all. The script reads its context as
`scope.gameOrchestra`.

> **Verify against v14 before building on it** (step 4): that `Macro#execute` forwards an arbitrary
> `scope` into a script macro's compiled function, and what it returns. Asserted from memory of
> earlier versions. If the scope does not forward, fall back to compiling `macro.command` ourselves
> with our own signature — which keeps the permission check but loses core's execution semantics.

**Inline source, and every script condition — one gate, and no authorship check that holds.**
Gated by **`allowInlineScripts`**: a world setting, GM-only, **default `false`**. Why the obvious
companions are absent:

- **There is no authorship gate we can fully enforce.** The graph is a flag on a Playlist document,
  so any **owner** can write it.
- **The module still gates the two write paths it owns**, as defence in depth rather than as a
  boundary: the editor's inline source field renders **read-only** without `MACRO_SCRIPT` (UX-9 —
  disabled with a reason, never hidden), and `api.graph.set()` refuses a graph whose script source
  *differs from what is already stored* when the caller lacks `MACRO_SCRIPT`. The diff matters:
  gating on "contains any script" would stop a legitimate caller from moving a node it did not author.
- **The third path — a raw `playlist.setFlag()` — cannot be gated at all**, and pretending otherwise
  would be the same mistake as the no-op second gate above.

So: **anyone who can edit a playlist can store inline code; only a GM can let any of it run.** Write
that in the setting's own hint rather than leaving a GM to infer it — and say which of the two modes
it governs, since a macro-mode node is unaffected by it.

That asymmetry is the argument for **`macro` being the default mode**: the safe path is the one a GM
falls into without choosing.

Failing the gate is a **level-2 log plus a `SCRIPT_ERROR` hook, then follow the exit** — never a
throw, never a silent skip. The editor surfaces it as a validation warning so it is visible before
playback rather than only in the console.

### Compilation

Compiled **once per node per run** and cached — a `script` condition is polled at 2 Hz, so
recompiling per evaluation is not an option.

| | Node, `mode: 'macro'` | Node, `mode: 'inline'` | Condition |
|---|---|---|---|
| Compiled by | **core**, via `macro.execute()` | us, `AsyncFunction` | us, **plain `Function`** |
| May await | yes | yes | **no** — see B8 |
| Result | ignored | ignored | coerced to boolean |

> **What D-B5 does to the CSP risk.** Under D-B3 a blocked `new Function` killed the whole feature.
> With macro mode back, it no longer does: a macro-mode node runs on core's own compilation, so it
> survives. **Script conditions and inline node mode do not.**

### CSP is detected at runtime, not verified once (D-B6)

An integration test can only ever prove that **stock Foundry at the pinned version** permits
function construction. It cannot prove a *hosted* Foundry does — The Forge, Molten, or any self-host
behind a hardening reverse proxy can add CSP headers the test container never sees. A verification
step that answers "yes" for one deployment and is then assumed for all of them is the wrong shape
for this question.

So the module **probes once, at `init`, and degrades**:

```js
canCompileScripts()   // try { new Function('return 1')() } catch { false }, cached
```

When it answers `false`, inline node source and every script condition are inert — logged once,
surfaced as a validation warning, and shown in the editor as **disabled with a reason** (UX-9).
Macro-mode nodes are unaffected, because core compiled those.

Three things this buys over a one-off verification:

- it is correct on **every** deployment, not just the pinned one;
- a GM on a locked-down host gets an explanation instead of silence;
- the integration spec becomes a **regression test for the probe** rather than a gate on the design,
  which means step 4 no longer blocks anything.

`itest/specs/005-platform-assumptions.spec.mjs` still runs the check — the point is that a red run
there is now information, not a stop-work.

Errors from a script are caught, logged at level 1, and emitted as `SCRIPT_ERROR`. **The token
always follows the exit.** A broken script must degrade to a no-op, not to silence — the same
reasoning as a Playlist node's refusal being a zero-length pass rather than a dead end.

## B6. Validation

New rules in `graph-validation.mjs`, emitting i18n keys as always:

| Key | Severity | When |
|---|---|---|
| `ScriptExitMissing` | error | no outgoing edge (Script has exactly one, like Track/Delay) |
| `ScriptSyntaxError` | **error** | inline source, or a condition expression, that does not compile |
| `ScriptMissingMacro` | warning | `mode: 'macro'` with no `macroUuid` — a no-op, not broken |
| `ScriptMacroNotFound` | warning | the uuid does not resolve — needs `macros` in `validateGraph`'s options, alongside `playlists` |
| `ScriptMacroNotScript` | warning | the uuid resolves to a **chat** macro, which has no JS to run |
| `ScriptMissingSource` | warning | `mode: 'inline'` with empty source |
| `ScriptInlineDisabled` | warning | inline source or a script condition present while `allowInlineScripts` is off |
| `ScriptNoPermission` | warning | as above, and the current user lacks `MACRO_SCRIPT` |

D-B5 brings back the three macro rules that D-B3 had deleted, and with them `validateGraph`'s
`macros` option — the same shape as `playlists`, so a live lookup stays outside the pure module.

`ScriptMacroNotFound` is the rule that makes the **live link** honest: a dropped macro that is later
deleted, or a graph imported into a world that has no such macro, degrades to a visible warning
rather than to silence. This is the same class of cross-world fragility a Playlist node's
`source: 'direct'` already has, handled the same way.

`ScriptSyntaxError` is an **error**, and it is the one that pays for itself. Source that does not
compile can never do anything, which is exactly [node-anatomy.md](wiki/node-anatomy.md)'s bar for
error severity — and unlike every other rule here, it is checkable for free by attempting the
compile at validation time. Without it the first sign of a typo is silence during play. It does
**not** apply to macro mode: that source belongs to a document this graph does not own, and failing
a graph's save over someone else's macro would be the wrong boundary.

> Compiling inside the validator means `graph-validation.mjs` — a **pure** module — would construct
> a function. Rather than break that, the compile is done by the caller and its result passed in
> through the options object, exactly like `playlists` and `moodIds`. The pure module stays pure and
> the rule stays testable with a plain boolean.

The last two rows are **environment-dependent validation**, which nothing in this module has today:
whether a graph is "valid" now depends on a world setting and on who is asking. Their inputs must
arrive through `validateGraph`'s options like every other live value.

An unconfigured script node is a legitimate placeholder mid-authoring, so an empty source is a
warning — it follows its exit fine.

## B7. Node anatomy

Against the five channels:

| Channel | Script node |
|---|---|
| 1 — shape + icon | 160px box like Track; `fa-code`. Needs a per-type CSS rule naming **`.game-orchestra-node-swatch`** alongside the canvas selector, or the palette chip renders as a grey default. |
| 2 — caption | the user's label, unchanged |
| 3 — detail line | the macro's name, or `⟨inline⟩`. Most-identifying first (R2); ~26 char budget. |
| 4 — exit chips | **none.** One exit, unguarded → R3 says the absence is correct and meaningful. Not in `EXPANDABLE_EXIT_NODE_TYPES`. |
| 5 — state | standard validation + activity highlight; it is durational, so it gets a drain overlay if we give it a known duration — **we should not**, since a script's duration is unknown. |

**Routing by return value is rejected.** The obvious feature — `return 'combat'` selects the exit
labelled `combat` — is exactly what R1 forbids: a fact indexed by exit, guarded, needing chips, on a
node type whose whole point is that it is opaque. It would also be a second, weaker Condition node
that no validation rule can check. A script that wants to route writes to state and lets a
**Condition node** read it, or uses the `script` condition kind below.

## B8. The `script` condition kind — built, then removed (D-B7)

Shipped in an earlier pass and then taken out again; a different approach will be designed later.
Kept as a section because **the constraint that shaped it has not gone away**, and any future design
runs into it on the first day:

> **`_evaluateCondition()` is synchronous, and must stay so.** It is called from
> `_scheduleConditionalExit`'s poll, from `_enterCondition`, and from **`planNextHandoff`**, which is
> a *pure* module receiving `evaluateCondition` as an injected function. Making it async would mean
> an async pure lookahead, an async poll, and re-entrancy in three places at once.

Which is why the removed version was inline-expression-only: macro execution is async, so there was
never a macro form available to it.

Three further findings from having built it, all of which a replacement will meet again:

- **A returned Promise is truthy**, so an `async` expression silently matches *every time* — the
  opposite of "not met", and invisible without an explicit check.
- **It is polled**, so failures must be logged once per condition per run rather than per tick, and
  compilation must be cached including failures.
- **`planNextHandoff` evaluates conditions early and re-runs them at the seam** (H7's recorded
  relaxation), so **a condition with side effects runs twice.** Any replacement must either be
  side-effect-free by construction or opt out of the lookahead.

A fourth observation, which is the one that would most shape a different approach: a script
condition put compiled user code on the engine's own 2 Hz timer, inside its hot path. That was the
highest-risk property of the whole feature, and it is the property most worth designing away rather
than re-accepting.

## B9. Dragging a macro onto the graph

The gesture that caused D-B5. A GM drags a macro from the hotbar (or the Macro directory) onto the
canvas and gets a Script node wired into the graph.

**The pipeline already exists.** `graph-drop.mjs#resolveGraphDrop` is a pure rule matrix and
`custom-playlist-editor.mjs#_onDropExternal` already resolves a dropped document by uuid. A hotbar
macro drag carries `{type: 'Macro', uuid: 'Macro.xyz'}` — the same payload shape as the Playlist and
PlaylistSound drops already handled. Extending it is a third branch in `resolveGraphDrop` returning
`{action: 'script', macroUuid}`, plus the corresponding case in `_onDropExternal`'s type gate and its
`[type, overrides]` pair.

Four rules, and three of them fall straight out of the existing matrix:

| Case | Result |
|---|---|
| a **script** macro | `{action: 'script', macroUuid}` → a `mode: 'macro'` node |
| a **chat** macro | reject, `Drop.ChatMacro` — no JS in `command`; nothing to run |
| dropped **on an existing Script node** | repoint that node, exactly as a sound drop repoints a Track node (`_repointTrackNode`'s shape) |
| dropped **on a wire** | splice in, auto-chaining suppressed — already handled generically by `_insertNodeOnEdge` |

**The drop stores a uuid, not a copy** — that is the whole point of D-B5. Editing the macro
afterwards changes what the graph runs, which is what a GM will assume a drag means. Under D-B3 the
same gesture could only paste a snapshot, and a later edit to the original would have left the graph
running stale code with nothing on the node to show it.

Two things to get right, both of which the existing drop code already models:

- **Read the drop point synchronously**, before the `fromUuid()` await. `_onDropExternal` opens with
  a comment about exactly this; the event object is not reliable once the handler has yielded.
- **Two new lang keys in both locales** (HR-E) — the rejection reason and the node's detail-line
  label.

The node's detail line (channel 3) shows the **macro's live name**, resolved for display only. A
deleted macro therefore shows as unresolved on the canvas *and* raises `ScriptMacroNotFound` in
validation — the same fact in the two channels that own it, rather than only in the console.

---

## Phasing

Each row ships on its own and is useful without the next.

Revised for **D-A1** — reads and writes ship as one increment, which collapses the old steps 3 and 4
into step 2 below and promotes the H1/H2 extraction from "prerequisite for later" to "blocks the
increment".

| # | Change | Touches | Risk |
|---|---|---|---|
| 1 | **Extract graph-write enforcement** (H1/H2) out of `handleSave()` into a shared writer | `custom-playlist-editor.mjs`, `helpers.mjs` | Low — pure refactor. **Blocks 2**: `api.graph.set()` cannot exist without it |
| 2 | **`scripts/api.mjs` — the whole surface**, reads and writes: all five namespaces, `GameOrchestraApiError`, `isHeadGM`/`canControl`, the headless prototype-token host, the legacy-key deprecation getters + `tests/api.test.mjs` | new module, `game-orchestra.mjs`, `binding-store.mjs` | **Medium–High** — the largest single step in the plan; see the note below |
| 3 | **The four new hooks**, each emitted through the non-fatal wrapper | `music-controller.mjs`, `settings.mjs`, engine | Medium — an unwrapped emit stops playback |
Part B's steps are revised for D-B1–D-B5. The condition kind is in (D-B2) rather than deferred; the
node's two modes are back (D-B5) and split across 6a/6b; and the CSP check is **no longer a go/no-go
for all of Part B** — macro-mode nodes survive a blocked `new Function`, so it gates only 6b and 7.

| # | Change | Touches | Risk |
|---|---|---|---|
| 4 | ✅ **`itest/specs/005-platform-assumptions.spec.mjs`**: `Macro#execute` scope forwarding, CSP vs `new Function`, chat-vs-script macro types, plus the two `hooks.mjs` anchors that were flagged unverified | a running Foundry v14 | **Run, all four green.** Scope forwarding confirmed, so 6a's fallback was never needed. See the Status block |
| 5 | **The machinery**: `SCRIPT_TIMEOUT_MS` + `allowInlineScripts` settings (+ both locales), the compile-and-cache helper, `SCRIPT_ERROR` hook, `SELF_REENTRANT` + the re-entrancy guard in `api.mjs` | `settings.mjs`, `api.mjs`, new module, both lang files | Medium — no user-visible feature yet, which is the point |
| 6a | **Script node, macro mode**: schema union + `resolveScript`, durational `_enterScript`, timeout, validation, bridge round-trip, inspector, node render, CSS | schema, engine, validation, bridge, inspector, node render, CSS, both lang files | **High** — a new durational node type |
| 6b | **Inline mode** on the node: the source field, the `MACRO_SCRIPT` read-only gate, `ScriptSyntaxError` | inspector, validation, `api.mjs` | Medium — degrades via the runtime probe rather than being gated on 4 |
| 6c | **Macro drag-and-drop** (B9) | `graph-drop.mjs`, `custom-playlist-editor.mjs`, both lang files | Low — a third branch in an existing matrix |
| ~~7~~ | ~~**`script` condition kind**~~ | — | **Removed (D-B7).** Built and then reverted; see B8 for the constraints a replacement inherits |

> **Step 5 exists as its own step deliberately.** Everything security-relevant — the execution gate,
> the compile path, the re-entrancy guard — lands with no node and no condition to exercise it, so it
> can be reviewed and tested as security machinery rather than as a side-effect of a feature people
> want to try. It is also entirely unit-testable, which 6a onward is not.

> **6c is small but should not be first.** It is the gesture that motivated D-B5, so it is tempting
> to build early — but it produces `mode: 'macro'` nodes, which means 6a has to exist for the drop to
> land on anything. Building it right after 6a also means the drop is the *first* way most GMs create
> a Script node, which is a good reason for 6a's inspector to be finished rather than provisional.

> **Step 2 is now big enough to be worth building in a deliberate order**, even though it lands as
> one change: the namespaces first with every write throwing `NOT_PERMITTED` unconditionally, then
> `isHeadGM`/`canControl`, then the writers one namespace at a time behind
> `tests/api.test.mjs`. That keeps the shape test green from the first commit and means a
> half-finished writer is *loudly* unavailable rather than quietly wrong — which is the failure mode
> D-A2 exists to prevent, applied to the build itself.

Steps 1–3 and 4–7 are otherwise independent. **Step 5 does not depend on step 2**: a Script node in
macro mode needs only the *read* half of the API in its execution context, so if the Script node is
the more wanted half it can be pulled forward ahead of the writers.

## Testing

- `tests/api.test.mjs` — **shape assertions** (every documented name exists, is the right kind), plus
  a permission-denial test per throwing method. This is the contract's enforcement.
- `tests/script-node.test.mjs` — the engine behaviours: singleton, throttle, **timeout releases the
  token and follows the exit**, a throwing script follows its exit, `run.ctx` shared across a child
  engine, both permission gates refuse without stranding a token.
- Extensions to `graph-validation.test.mjs`, `custom-playback-schema.test.mjs`
  (`resolveScript`, `findUpcomingTrackNodes` crossing, `planNextHandoff` returning null),
  `graph-drawflow-bridge.test.mjs` (round-trip), `custom-playlist-node-render.test.mjs` (channel 3).
- `lang.test.mjs` covers the new keys automatically **in both locales** (HR-E) — pt-BR is not
  optional and has shipped broken once.
- **An integration spec** (`itest/specs/NNN-script-node.spec.mjs`). Everything above is a unit test
  against a fake, and [integration-testing.md](wiki/integration-testing.md) exists because a green
  unit suite is not evidence about playback. A script node that stalls the token is precisely the
  failure only the audio tier sees.

## Docs

- New `docs/wiki/api.md` — the contract, every namespace, the head-GM table, the stability rules.
- `node-anatomy.md` — Script in the per-type table; the routing-by-return-value rejection as a
  worked example of R1 (it is a better one than the until-loop).
- `graph-engine.md` — Script in the node-type table; the timeout in the safety-net table.
- `invariants.md` — **H17: a script node runs once, on the head GM only, and must never be able to
  hold its token forever.** Plus the "every hook is fire-and-forget and non-fatal" rule, which today
  lives only in `_emitActivity`'s comment and becomes load-bearing the moment third parties listen.
- `module-map.md`, `CLAUDE.md` wiki map, `README.md`.

---

## Open questions

All nine review questions are settled — Part A's four as D-A1–D-A4, Part B's as D-B1, D-B2, D-B4 and
D-B5 (with D-B3 taken and then reversed). What remains are **two facts nobody has checked**, and
they now block different things:

| Verification | Blocks | If it fails |
|---|---|---|
| `Macro#execute` forwards an arbitrary `scope` | **6a** | compile `macro.command` ourselves — keeps the permission check, loses core's execution semantics |
| CSP permits `new Function` | **6b, 7** | inline node mode and script conditions are both dead; macro-mode nodes are unaffected |

Very likely both are fine — core compiles script macros the same way, so a CSP blocking it would
already have broken core — but "very likely" is not the standard the rest of this codebase's
comments hold things to.

One thing deliberately **not** decided, because it costs nothing to defer: whether shipping Part B
bumps `api.version` to `1.0.0`. A4 says the Script node is what earns that, being the first in-repo
consumer of the API — but the guard in D-B1 adds a code and a behaviour to the contract, so the
shape is still moving. Revisit when step 7 lands.

One reading to confirm if it was not what was meant: **D-B5 is taken as restoring the original
two-mode union**, with `macro` the default and inline still available on the node. "Macro-only for
nodes" would be a slightly different decision — it would delete step 6b, remove `ScriptSyntaxError`
and the inline gate from the node (though not from conditions, which still need both), and make
`allowInlineScripts` govern conditions alone.

Also resolved along the way, without needing to be asked:

- **`run.ctx` is not persistable.** A script wanting state across runs can already use a flag; keep
  the scratch space in memory and let flags be flags.
- **A script's return value is ignored** (B7) — routing by return value stays rejected under R1.
