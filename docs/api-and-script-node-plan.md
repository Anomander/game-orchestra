# Plan — a public API, and a Script node

> ## Status
>
> **Part A (the public API) is shipped** — steps 1–3 of the phasing below. The durable
> documentation is [docs/wiki/api.md](wiki/api.md); this document keeps the *reasoning and the
> alternatives*, which the wiki page deliberately does not repeat.
>
> **Part B (the Script node) is not started** — steps 4–7. Its four open questions are still open,
> and step 4 (verifying the two live Foundry assumptions) still blocks step 6.
>
> One deviation from the reviewed plan, recorded where it happened: `api.bind` ships **one
> polymorphic `set(target, …)`** rather than `setDefault`/`setScene`/`setToken`. See § A2.

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

```js
{
  id, type: 'script', label?, x, y,
  script: {
    mode: 'macro' | 'inline',
    macroUuid?: string | null,   // mode === 'macro'
    source?: string              // mode === 'inline'
  }
}
```

Read through **`resolveScript(node)`** in `custom-playback-schema.mjs`, never `node.script`
directly — same discipline as `resolveLoop()`, and for the same reason: a graph saved before this
field existed, or one written by an API caller, must degrade identically everywhere rather than
having each of the four readers (engine, inspector, node renderer, validator) invent its own
default. Default: `{mode: 'macro', macroUuid: null}` — an unconfigured script node is a no-op that
follows its exit, never an error at runtime.

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
  api,               // the Part A object
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

## B5. Security

A script node's source lives in a **world flag on a Playlist document**, and executes on the **head
GM's client with GM privileges**. Anyone with OWNER on that playlist can therefore write code that
runs as the GM. Default Foundry permissions do not give players playlist ownership, but they can be
granted, and "can be granted" is enough.

Foundry's own answer to this is the `MACRO_SCRIPT` user permission. The design leans on it rather
than inventing a parallel model.

**Two modes, and `macro` is the default:**

- **`mode: 'macro'`** — stores a **UUID**, not source. Execution is `macro.execute({ gameOrchestra: ctx })`,
  which routes through core's own `Macro#canExecute` permission check and gives the author core's
  macro editor, core's ownership model, and a document that can be exported and shared. The script
  reads its context as `scope.gameOrchestra`.

  > **Verify against v14 before building on it:** that `Macro#execute` forwards an arbitrary `scope`
  > into a script macro's compiled function, and what it returns. This is asserted from memory of
  > earlier versions and is exactly the kind of assumption this codebase's comments exist to record
  > as *unverified*. If the scope does not forward, fall back to compiling `macro.command` ourselves
  > with our own signature — which keeps the permission check but loses core's execution semantics.

- **`mode: 'inline'`** — raw source on the node. Gated **twice**:
  1. a new world setting **`allowInlineScripts`, default `false`**, GM-only;
  2. `game.user.can('MACRO_SCRIPT')` on the **executing** client at execution time — not at save
     time, because the stored flag outlives whoever wrote it.

  Failing either gate is a **level-2 log plus a `SCRIPT_ERROR` hook, then follow the exit** — never
  a throw, never a silent skip. The editor shows it as a validation warning so it is visible before
  playback rather than only in the console.

  Compilation uses the same `AsyncFunction` construction core uses for script macros, compiled
  **once per node per run** and cached. **Foundry's CSP must be checked live** — if `new Function`
  is blocked in a deployment, inline mode is dead and macro mode is the only path. That check is a
  prerequisite task, not a follow-up.

The editor's inline `<textarea>` renders **read-only** for a user without `MACRO_SCRIPT`, with the
reason shown (UX-9: disabled with a reason, never hidden — and here it genuinely would not work,
which is the bar UX-9 sets).

Errors from a script are caught, logged at level 1, and emitted as `SCRIPT_ERROR`. **The token
always follows the exit.** A broken script must degrade to a no-op, not to silence — the same
reasoning as a Playlist node's refusal being a zero-length pass rather than a dead end.

## B6. Validation

New rules in `graph-validation.mjs`, emitting i18n keys as always:

| Key | Severity | When |
|---|---|---|
| `ScriptExitMissing` | error | no outgoing edge (Script has exactly one, like Track/Delay) |
| `ScriptMissingMacro` | **warning** | `mode: 'macro'` with no `macroUuid` — a no-op, not broken |
| `ScriptMacroNotFound` | warning | uuid does not resolve (needs `macros` in `validateGraph`'s options, alongside `playlists`) |
| `ScriptMissingSource` | warning | `mode: 'inline'` with empty source |
| `ScriptInlineDisabled` | warning | inline source present while `allowInlineScripts` is off |
| `ScriptNoPermission` | warning | inline source present, current user lacks `MACRO_SCRIPT` |

All warnings, except the missing exit. An unconfigured script node is a legitimate placeholder
mid-authoring, and per [node-anatomy.md](wiki/node-anatomy.md)'s rule the bar for *error* is "the
chip renders a state that can never work" — a missing macro follows its exit fine.

The last two are the interesting ones: they are **environment-dependent validation**, which nothing
in this module has today. Their inputs must arrive through `validateGraph`'s options object like
every other live value, so `graph-validation.mjs` stays Foundry-free.

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

## B8. The `script` condition kind — phase 3, and the riskiest part

Adding `kind: 'script'` to `GraphCondition` would let scripts guard **Condition exits** *and*
`loop.mode: 'until'` escapes, reusing the entire existing vocabulary, chips, and inspector.

It has one hard constraint that shapes everything:

> **`_evaluateCondition()` is synchronous, and must stay so.** It is called from
> `_scheduleConditionalExit`'s 500 ms poll, from `_enterCondition`, and from **`planNextHandoff`**,
> which is a *pure* module receiving `evaluateCondition` as an injected function. Making it async
> would mean an async pure lookahead, an async poll, and re-entrancy in three places at once.

So a script condition is:

- **inline expression only** — no macro mode, which is inherently async;
- **synchronous** — a returned promise is truthy and would silently always match; detect and refuse;
- **compiled once and cached**, since it is polled at 2 Hz;
- **throwing → `false`**, logged **once per node per run** (a per-poll log at 2 Hz is its own
  denial-of-service on the console);
- added to `CONDITION_KINDS_WITH_VALUE`, so `conditionMissingValue()` and
  `conditionSignature()` treat it correctly in all three consumers at once.

And a note that will be needed later: the H7 relaxation in `planNextHandoff` means a script
condition is evaluated **up to 500 ms early** and then **re-run at the seam**. A script condition
with side effects therefore runs twice. That must be documented at the field, not discovered.

This is proposed as its own phase precisely because it is the part most likely to be cut.

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
| 4 | **Verify the two live assumptions**: `Macro#execute` scope forwarding, and CSP vs `new Function` | a running Foundry v14 | Low cost, **blocks 6** |
| 5 | **Script node**, macro mode only | schema, engine, validation, bridge, inspector, node render, CSS, both lang files | **High** — a new durational node type |
| 6 | **Inline mode** + `allowInlineScripts` setting + permission gates | as above, `settings.mjs` | Medium, gated on 4 |
| 7 | **`script` condition kind** | schema, engine, validation, inspector, node render | **High** — see B8 |

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

## Open questions for review

Part A's four are settled above. These remain, and all four are **Part B** — none blocks starting
Part A.

1. **Inline scripts at all?** Macro mode is strictly safer, reuses core's permissions, and gives a
   better editor. Inline's only real advantage is that the graph is self-contained when exported.
   Recommendation: build macro mode (step 5), ship it, and let demand decide step 6.
2. **`SCRIPT_TIMEOUT_MS` — 5 s, and world-configurable?** 5 s is long enough for a chat message and
   a document update, short enough that a stranded token is noticed. Making it configurable invites
   someone to set it to 60 s and then wonder why the music stopped.
3. **Does `run.ctx` want to be persistable?** A script that wants state across runs can already use
   a flag. Recommendation: no — keep it in-memory, and let flags be flags.
4. **Is the `script` condition kind (step 7) in scope at all?** It is the highest-risk item here and
   the one most likely to be cut; B8 is written so that cutting it costs nothing already built.
