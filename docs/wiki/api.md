# The public API

The supported surface for macros and other modules. **Read this before adding anything to
`scripts/api.mjs`** — it is the only part of this module that a third party depends on, and
therefore the only part that cannot be refactored freely.

Implemented in [`scripts/api.mjs`](../../scripts/api.mjs). Designed in
[api-and-script-node-plan.md](../api-and-script-node-plan.md), which records the decisions and the
alternatives.

---

## Reaching it

```js
const api = game.modules.get('game-orchestra').api;   // canonical
const api = game.gameOrchestra;                       // legacy alias, the same object
```

**One object, published under two names.** `game.modules.get(id).api` is the Foundry convention and
the only name another module author will guess. `game.gameOrchestra` predates it and already has
consumers in the wild — [ux.md](ux.md) records that `game.gameOrchestra.GameOrchestraConfig` is why
the vestigial scene layout in `music-config.hbs` still ships. Two objects would be free to drift, so
there is one.

The alias itself is **silent**. The legacy *class* keys warn once each on first access, through
`foundry.utils.logCompatibilityWarning`, and keep working.

| Legacy key | Use instead |
|---|---|
| `CustomPlaylistEditor` | `api.graph.*` |
| `PlaylistMixerApp` | `api.mix.*` |
| `GameOrchestraConfig`, `MoodWidget`, `MoodConfigApp`, `PhaseConfigApp` | no replacement yet |
| `musicController` | **not deprecated** — see below |

> `musicController` deliberately does **not** warn. `settings.mjs`'s own `onChange` handlers reach
> through `game.gameOrchestra?.musicController` on every mood and phase change, so warning on it
> would fire the module's deprecation at the module. It is still not contract; `api.playback.*` is.

---

## The two rules that shape every method

### 1. A call that cannot do what its name says **throws**

`playCurrentTrack()` returns early on every client that is not the head GM (CLAUDE.md rule 5). A
player's macro calling it would otherwise do nothing at all *and report success* — the silent-failure
class this codebase's comments exist to warn about, and an API is the worst possible place to add a
new instance of it.

```js
class GameOrchestraApiError extends Error { code; }
```

| Code | Means |
|---|---|
| `NOT_HEAD_GM` | Only meaningful on the client running the engine |
| `NOT_PERMITTED` | Foundry refused the write, or this user is not a GM |
| `INVALID_ARGUMENT` | The caller passed something unusable |
| `NOT_FOUND` | A referenced playlist, sound, or document does not exist |
| `VALIDATION_FAILED` | A graph had error-level issues — carries `.validation` |
| `SELF_REENTRANT` | The call would tear down the engine currently executing the script that made it |

Branch on `code`, never on the message. `api.isHeadGM()` and `api.canControl()` let a caller check
*before* calling — which is why they ship in the same increment; throwing with no way to test first
is a trap, not a contract.

**Reads never throw on permission.** A player may legitimately ask what is playing.

**The check happens at the top of the method, before delegating.** Calling through and inspecting the
result cannot distinguish *"returned early because not head GM"* from *"ran and had nothing to do"*.
`tests/api.test.mjs` pins this directly.

### 2. Permission is Foundry's answer, not ours

A write attempts the operation and translates the rejection. It does **not** re-derive whether this
user may write a Scene flag — a second permission model drifts from core's the first time ownership
rules change.

---

## The namespaces

Organised by **the five jobs** ([ux.md](ux.md)), because that vocabulary already exists and gives a
macro author the same mental model the windows teach.

```js
api.version        // '0.1.0' — this contract's own semver, not the module's
api.isHeadGM()     api.canControl()     api.Error     api.hooks

api.transport      // J5 — perform
api.bind           // J1 — bind
api.graph          // J3 — behaviour
api.mix            // J4 — levels
api.playback       // engine state
```

### `api.transport` — J5

```js
api.transport.getMood()  getPhase()  listMoods()  listPhases()  getSuppression()
await api.transport.setMood(id)      // '' or null clears
await api.transport.setPhase(id)
await api.transport.setSuppression('area'|'combat', value?)   // omit value to toggle
await api.transport.refresh()                                 // head GM only
api.transport.describeCurrent()      // localized "what is winning", or null
```

`describeCurrent()` goes through the same pure `describeResolution()` the hub's and the widget's
status pills use, so a macro cannot produce a fourth description of resolution (UX-2).

`listMoods()`/`listPhases()` localize labels **at this boundary** — the stored definitions carry
i18n keys, per the render-boundary rule.

### `api.bind` — J1

```js
await api.bind.set(target, { section, overlayId?, playlistId, trackId? })
await api.bind.setTrack(target, { section, overlayId?, trackId })
await api.bind.setLayer(target, { section, overlayId, layer })
await api.bind.clear(target, { section, overlayId? })
api.bind.read(target, { section, overlayId? })
api.bind.resolve()                   // the winning context descriptor
```

`target` is `'default'`, or a `Scene` / `TokenDocument` / `Actor` / `PrototypeToken`.

> **The plan proposed `setDefault`/`setScene`/`setToken`; this ships one polymorphic `set`.** The
> three would have been the same body behind three names, and a fourth scope would have wanted a
> fourth — which is UX-3's point ("scope is a filter, not a window") applied to a function
> signature. `setDefault(x)` is `set('default', x)`.

Three of the four targets need no code of their own. The **prototype token** is the exception:

| Target | Backend |
|---|---|
| `Scene`, `TokenDocument`, `Actor` | `documentFlagStore(document)` |
| `'default'` | `globalSettingStore()` |
| `PrototypeToken` | `updateObjectStore` over a **headless host** |

That headless host writes `actor.update({'prototypeToken.flags.game-orchestra.<path>': …})`. Two
hazards land on it and both have shipped as live bugs:

- **[HR-J](invariants.md#hr-j--flag-update-keys-are-dot-paths-there-is-no-bracket-syntax)** — the key
  is a **dot path**. `flags['game-orchestra']` produces a literal key the Actor schema silently
  drops; `actor.update()` resolves successfully having written nothing. Pinned by a test that
  asserts no `[` appears in any written key.
- **[HR-I](invariants.md#hr-i--never-configure-against-a-sheets-preview-clone-apptoken)** — the host
  is immune by construction: there is no sheet, so there is no preview clone to be caught by. That
  immunity is an argument for it over reusing `GameOrchestraConfig`'s.

> **`set(actor, …)` and `set(actor.prototypeToken, …)` are different operations**, and the API does
> not paper over it. A placed token holds a *copy* of the prototype's flags taken at creation time
> ([H14](invariants.md#h14--a-placed-token-holds-a-copy-of-the-prototypes-flags-so-the-prototype-must-stay-in-the-read-chain)),
> so editing the prototype changes nothing about tokens already on the canvas.

**`priority` has no setter.** [D8](ux.md#d8--priority-is-not-the-interface) removed it from every
surface deliberately; re-exposing it here would be the same mistake one layer down. It is still
stored, still read at resolution time, and `api.bind.read()` reports it.

### `api.graph` — J3

```js
api.graph.get(playlist)                  // deep clone, or null
await api.graph.set(playlist, graph, options?)  // validates; returns the validation result
await api.graph.remove(playlist)
api.graph.validate(graph, options?)      // emits i18n KEYS
api.graph.localizeIssue(issue)
api.graph.builder()                      // graph-builder.mjs#createBuilder
api.graph.presets                        // frozen array
api.graph.schema                         // resolveLoop, DURATIONAL_NODE_TYPES, …
```

- **`get()` returns a deep clone.** Handing back the live flag object invites a caller to mutate it
  in place, which writes nothing and then surprises them.
- **`set()` refuses on error-level issues only**, matching the editor's Save button. An API stricter
  than the UI would be its own surprise. Warnings come back in the return value.
- **`set()` and the editor share one writer** — `helpers.mjs#writeCustomGraph`. It force-writes
  `mode: UNSEQUENCED` ([H1](invariants.md#h1--a-custom-graph-playlist-is-always-stored-in-unsequenced-mode))
  and never invents an `initialTrack`
  ([H2](invariants.md#h2--but-it-must-never-be-treated-as-a-soundboard)). Enforcement on one of two
  write paths is not enforcement.
- **`set()` on a playing playlist restarts it from Start** (H8 + H9), and discards any suspended-run
  snapshot for that playlist. There is no in-place patch, deliberately.
- **`set()` supplies the environment context Script-node validation needs**, so "matching the
  editor" holds there too. Every Script rule in `graph-validation.mjs` is environment-dependent and
  **self-skips when its context is absent** — so an API that passed none silently held script nodes
  to a *lower* bar than the UI, and inline source that could never compile went straight to the flag
  with no error. Pass `options` to override any of it (validating against a world you are not in).
- **`set()` deliberately does not check `MACRO_SCRIPT`.** That permission gates an editor *field*;
  asking it of an API caller answers the wrong question, since the module writing a graph is not the
  person who will later run it — and a raw `setFlag()` bypasses any gate here anyway. The check that
  decides whether inline source *executes* is `inlineScriptsAllowed()`, at execution time, where it
  covers every write path including the ones this module does not own.

### `api.mix` — J4

```js
api.mix.get(playlist)                                 // normalized
await api.mix.patch(playlist, patch)                  // gain/floor/ceiling/crossfadeMs/muted
await api.mix.setVolume(playlist, soundId, v)         // the track's own document volume
await api.mix.setMuted(playlist, soundId, boolean)
await api.mix.setDuck(factor)
api.mix.setSolo(playlist, soundId)  getSolo(playlist)  clearSolo(playlist)
api.mix.effectiveVolume(playlist, soundId)   getDuck()
```

- Writes go through `playlist-mix-apply.mjs#patchPlaylistMix` / `#setPlaylistMuted`, shared with
  `MixerController`. `muted` is an **array rebuilt whole** — a flag write is a recursive merge
  server-side, so a map-shaped `muted` would merge the old `true` straight back in and unmuting
  would silently never persist. That bug shipped once; `tests/api.test.mjs` re-pins it here.
- **Solo is session state on this client only**, never persisted, and needs no GM check — it is an
  audition tool, so it is synchronous and the table goes on hearing the real mix.
- The mix lives in its own `game-orchestra.mix` flag, never in `customPlayback`
  ([HR-H](invariants.md#hr-h--keep-the-mix-out-of-the-customplayback-flag)).

### `api.playback`

```js
api.playback.isPlaying()  currentContext()  currentPlaylists()  activity(playlist)
await api.playback.play()   // head GM only
await api.playback.stop()   // head GM only; crossfades out (H11), never hard-cuts
```

`currentContext()` returns a **frozen plain descriptor**, not the live `PlaylistContext` — that
class carries methods and document references, and handing it out would make its internals contract.
The descriptor is built by `helpers.mjs#describePlaylistContext`, shared with the
`gameOrchestraContextChanged` hook so the two can never describe the same context differently.

Deliberately absent: `_customEngine`, `_layers`, `_activeNodes`, `_activeSoundOwners`, and any way to
move a token by hand. Those are what every hazard in [graph-engine.md](graph-engine.md) protects.

---

## Hooks

Names are published as `api.hooks` (`CONST.hooks` in `config.mjs`) so a listener need not hard-code
strings.

| Constant | Name | Payload |
|---|---|---|
| `GRAPH_ACTIVITY` | `gameOrchestraGraphActivity` | `{playlistId, runId, activeNodeIds, activeTimings, enteredNodeId, traversedEdgeIds}` |
| `CONTEXT_CHANGED` | `gameOrchestraContextChanged` | `{from, to}` — context descriptors |
| `TRACK_STARTED` | `gameOrchestraTrackStarted` | `{playlistId, soundId, soundName}` |
| `TRACK_STOPPED` | `gameOrchestraTrackStopped` | `{playlistId, soundId, soundName}` |
| `OVERLAY_CHANGED` | `gameOrchestraOverlayChanged` | `{axis: 'mood'\|'phase', from, to}` |
| `SCRIPT_ERROR` | `gameOrchestraScriptError` | `{phase, playlistId, nodeId, message}` — `phase` is `blocked` \| `compile` \| `execute` \| `timeout` \| `missing` |

> ### Every hook is fire-and-forget and non-fatal — this is a hard rule
>
> `Hooks.callAll()` runs its listeners **synchronously**. Several of these are emitted from inside
> the graph engine's token walk, so an exception from a third-party listener propagates straight
> back into the walk and **silently stops playback**. A listener is an observer; it must never be
> able to break audio.
>
> Emit through **`helpers.mjs#emitHook`**, which wraps the call in a `try`/`catch` and logs at level
> 1. `Hooks.callAll` must not appear anywhere else in the module. This generalizes
> `custom-playback-engine.mjs#_emitActivity`, which carried the same reasoning while it was the only
> hook the module fired.

Three details that are easy to get wrong when adding an emit site:

- **`CONTEXT_CHANGED` diffs by descriptor, not by identity.** Every re-resolution builds a brand-new
  `PlaylistContext`, so an identity check would fire on every unrelated mood change that resolved to
  the same music. It is emitted from `MusicController#_setContext`, the single assignment point for
  the three sites inside `transitionToContext`. `onCustomGraphChanged`'s `currentContext = null`
  deliberately bypasses it — that is an internal reset to force a real transition (H8), and emitting
  there would report a spurious stop immediately followed by a start of the same context.
- **`TRACK_STARTED` fires after the await, only on the paths that did not bail.** Telling a listener
  a track started that never did would be worse than no hook.
- **`OVERLAY_CHANGED` is one hook carrying its axis, not two.** `CONST.overlayAxes` models the two as
  one mechanism, and [D4](ux.md#d4--two-windows-for-one-concept-fixed) is the record of what
  splitting them into two of everything cost. Its `from` needs a cached baseline — Foundry's
  `onChange` receives only the new value — primed at `ready` by `settings.mjs#primeOverlayBaseline`,
  because seeding lazily would swallow the first change of the session, which is the one a listener
  is most likely watching for.

All of these fire on the **head GM** only, except `OVERLAY_CHANGED` (a world setting, so every
client sees it). They report what the module *decided*, not what any given client is hearing.

---

## Scripts calling the API

A Script node runs on the head GM, so **every** API call in its execution context passes the
head-GM and permission gates. There is no `NOT_HEAD_GM` to catch a script doing something
self-destructive, which is why `SELF_REENTRANT` exists.

Refused while a script is executing:

| Call | Why |
|---|---|
| `graph.set` / `graph.remove` on the **running** playlist | fires `updatePlaylist` → `onCustomGraphChanged` → teardown and restart from Start (H8/H9), while this script's node holds a token |
| `playback.play` / `playback.stop` / `transport.refresh` | retires the engine tree from inside one of its own nodes |

The guard is **scoped to the executing tree, never global** — rewriting a *different* playlist's
graph from a script is one of the better reasons to have the node at all — and it is keyed on the
run's shared registry, so it covers nested child engines too. See
[H17](invariants.md#h17--a-script-node-runs-foreign-code-while-holding-a-token-so-it-must-always-give-the-token-back).

The context a script receives:

```js
{ playlist, node, graph, run: { id, ctx }, api, log }
```

`run.ctx` is scratch space shared by reference down the whole engine tree — a run is one musical
event — and is never persisted.

**The two modes do not read the same way**, and the inspector hint for each says which:

```js
// macro mode - the whole context arrives under one scope key
const { playlist, api } = scope.gameOrchestra;

// inline mode - compiled with the keys as named parameters
playlist.name; api.mix.get(playlist);   // and `ctx` for the whole object
```

Macro mode additionally exposes a bare `gameOrchestra` identifier, because core spreads a scope's
keys as named parameters as well as passing `scope` itself. Documented as `scope.gameOrchestra`
anyway: it is explicit, and it cannot be shadowed by a local of the same name.

Both halves are **verified against a live build**, not inferred from core's source — `Macro#execute`
forwarding an arbitrary scope is the assumption macro mode is built on, and the unit suite can only
report what `tests/mocks/foundry.mjs` was told to say. See
`itest/specs/005-platform-assumptions.spec.mjs`. (`this` inside a macro is the Macro document;
nothing here reads it.)

## Stability

`api.version` is this contract's own semver, **independent of the module version**.

**It starts at `0.1.0`, and the leading zero is the point.** The shape has not been used by anyone
yet; pretending otherwise buys a compatibility shim for decisions nobody has tested. Under 0.x a
signature may be corrected in a minor bump — with a release note, never silently. Moving to `1.0.0`
is a deliberate later act, and the Script node is what earns it: as the first *in-repo* consumer of
this surface, it is the first real test of whether the shape is right.

The rules that hold from day one:

- Anything reachable from `api.*` is contract. The legacy `game.gameOrchestra` keys and every
  `_`-prefixed member of every class are not.
- Objects handed **out** are clones or frozen. Objects handed **in** are untrusted and normalized
  through the existing resolvers (`resolveLoop`, `resolvePlaylistRef`, `resolveGraphCrossfadeMs`,
  `normalizeMix`) — a caller's malformed graph must degrade exactly the way a malformed stored one
  does, not take a second path.
- **`tests/api.test.mjs` asserts the shape**: every documented name exists and is the documented
  kind, the object and its namespaces are frozen, no leaf is `undefined`, and every throwing method
  has a refusal test. That file is the contract's enforcement, the way `tests/lang.test.mjs` is
  HR-E's — it makes a signature change a failing test rather than somebody's broken macro.

## Adding to it: the checklist

1. **Does the behaviour already exist?** If not, it goes in the module that owns it and the facade
   calls it. `api.mjs` computing anything is a second implementation (UX-2).
2. **Which of the five jobs is it?** If two, it is two methods or the split is wrong (UX-1).
3. **Can it fail on this client?** Add the guard at the **top**, and a refusal test.
4. **Does it hand out a live object?** Clone or freeze it.
5. **New hook?** Through `emitHook`, name in `CONST.hooks`, row in the table above.
6. **Update `tests/api.test.mjs`'s shape list** — it is deliberately an explicit enumeration, so a
   new method without a test entry fails rather than passing unnoticed.
