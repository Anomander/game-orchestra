# Invariants

The rules that, when broken, produce a bug with no console error.

> ## ⚠️ On the provenance of H1–H11
>
> These hazard IDs originate in `docs/custom-playlist-plan.md`, **a file that no longer exists
> in this repository.** Roughly 16 comments across 8 source files still cite it as authoritative.
>
> The list below is **reconstructed from those surviving citations plus the code they guard.**
> Each entry is marked with a confidence level:
>
> - **Quoted** — the wording is recovered near-verbatim from one or more code comments.
> - **Inferred** — the ID is cited but its full statement is reconstructed from what the code
>   actually does. Treat the *behavior* as authoritative and the *phrasing* as approximate.
>
> The stale `custom-playlist-plan.md` paths in the source were deliberately **not** rewritten.
> If you rediscover the original document, reconcile it against this page rather than assuming
> either one is correct.

---

## H1 — A custom-graph playlist is always stored in `UNSEQUENCED` mode

**Confidence: quoted.** Cited by `helpers.mjs`, `hooks.mjs`, `custom-playlist-editor.mjs`.

`UNSEQUENCED` (Foundry's "Soundboard", numeric `-1`) is the only mode that **neither
auto-advances a finished sound nor stops one sound to start another.** The graph engine requires
both of those absences: it schedules every start and stop itself, and Fork's parallel playback
depends on Foundry not stopping the previous sound.

Enforcement points:

- `CustomPlaylistEditor.handleSave()` force-writes `mode: UNSEQUENCED` on every save.
- `hooks.mjs#handlePlaylistConfigRender` disables the "Custom Playback" button in other modes —
  **rendered disabled with a hint, never hidden**, because a silently absent button reads as a
  broken module.
- A playlist that *already has* a graph stays editable whatever its mode says, so a graph can
  never be stranded and left unremovable by someone switching the mode out from under it.

## H2 — …but it must never be treated as a Soundboard

**Confidence: quoted.** Cited three times in `helpers.mjs`, plus `app.mjs`.

H1 and H2 are in tension by design: the storage mode says Soundboard, the semantics say
otherwise. Every `isSoundboard` computation in the module must exclude custom playlists.

Two concrete consequences:

- **No implicit initial track.** `resolveInitialTrack()` auto-assigns the first sound for real
  Soundboard playlists, and explicitly skips custom ones. A stray `initialTrack` on a custom
  playlist bypasses the entire graph.
- **`PlaylistContext._resolveTracks()` checks `isCustomPlaylist` *before* `trackId`.** Order
  matters: a stale `initialTrack` flag — from before these guards existed, or from any future
  code path — would otherwise short-circuit straight to a single track and silently skip the
  graph.

## H3 — `'end'` may not fire per loop iteration on a `repeat: true` track

**Confidence: quoted.** Cited by `audio-end-watcher.mjs` and `custom-playback-engine.mjs`.

It is **undocumented** whether Foundry's `Sound` fires `'end'` on each iteration while native
looping is active. Rather than depend on the answer, the engine never watches a looping track:
`AudioEndWatcher` is used only for `loop.mode === 'count'` with `count === 1`; every other mode
that plays via native `repeat: true` (`count > 1`, `forever`, `until`) advances via
`EngineClock`'s timed stop instead — a fixed `loopCount × duration − elapsed` for `count`, or the
condition-driven schedule described under H12 for `until`.

Related: `'end'` (natural completion) and `'stop'` (deliberate stop) are distinct events.
`AudioEndWatcher` listens for `'end'` **only** — a `'stop'` means the engine did this on purpose
and must never be mistaken for "the track finished, advance."

## H4 — Background tabs throttle main-thread timers

**Confidence: quoted.** Cited by `engine-clock.mjs`.

Browsers throttle `setTimeout`/`setInterval` on the main thread to roughly **once per minute** in
a backgrounded tab. The engine runs on the head GM's client — a client that gets backgrounded
constantly.

`EngineClock` stores every wait as an **absolute due-timestamp** and polls it from a dedicated
`Worker` (whose timers are not throttled the same way), falling back to a main-thread interval
when a Worker can't be constructed (e.g. a strict CSP blocking `blob:` workers). Because
due-times are absolute rather than relative delays, **even the fallback degrades gracefully**: a
throttled tick still fires every overdue item at once, with no cumulative drift. It lands late
rather than never.

**One sanctioned exception:** a start measured against a *specific sound's own playback position*
uses Foundry's audio clock instead — `Sound#play({delay})`, backed by an `AudioTimeout` scheduled on
the `AudioContext` (see [graph-engine.md](graph-engine.md) § *Predictive arming*). That is not
subject to background-tab throttling either, and it is the only way to hit a seam tightly enough to
be inaudible. Everything else — every poll, every wall-clock boundary, every retry — still goes
through `EngineClock`.

## H5 — Drawflow connections carry no data of their own

**Confidence: quoted.** Cited by `graph-drawflow-bridge.mjs` and `custom-playlist-editor.mjs`.

Only whole-node `data` round-trips through Drawflow's export/import. Per-edge metadata
(Random's `weight`/`cooldown`, Condition's `condition`) is therefore stashed **on the source node**
in a `data.exits[]` array parallel to that node's output ports:

```
data.exits[0] ─→ output_1
data.exits[1] ─→ output_2
```

Drawflow **renumbers a node's remaining output ports contiguously** when one is removed from the
middle. The editor must splice `data.exits[]` in lockstep with every port removal, or every
exit's metadata silently shifts onto the wrong edge.

## H6 — Loops use native repeat plus a timed stop, never replay-on-end

**Confidence: inferred.** Cited once, paired with H3, in `custom-playback-engine.mjs#_enterTrack`.

Restarting a track from its `'end'` event produces an **audible gap** at every loop boundary.
Setting `repeat: true` on the sound and letting the audio layer loop it natively is gapless. The
engine therefore sets `repeat: isForever || loop.mode === 'until' || loopCount > 1` — every mode
except a single (`count === 1`) pass — and advances by scheduled stop (see H3), not by replaying.

## H7 — Game-state conditions are evaluated when a token arrives, never re-evaluated live

**Confidence: quoted.** Cited by `custom-playback-engine.mjs#_enterCondition` and
`docs/playlist-node-plan.md` D4.

A Condition node reads combat/mood state at the instant a token enters it and picks its exit
then. If combat starts halfway through the track that exit led to, **nothing re-evaluates.** The
graph reacts on the next pass.

This is a deliberate simplification, and it shapes graph design: `graph-presets.mjs` notes that
looping *back through* a Condition node is what makes a graph react to combat at all.

The same rule governs a Playlist node's reference resolution (`docs/playlist-node-plan.md` D4) —
with one narrow, deliberate exception, `refreshOverlayReactiveTargets()`, described in
[graph-engine.md](graph-engine.md).

**A Track node's own `loop.mode: 'until'` polling is not a violation of H7.** It is a new,
narrowly-scoped re-evaluation of that one node's own escape condition — not a re-evaluation of a
Condition node's routing decision, which still only happens on token arrival. Read it as its own
thing, or it looks like H7 being quietly broken.

**Predictive hand-off arming evaluates conditions *early*, and then re-validates them.** The
lookahead (`planNextHandoff`, see [graph-engine.md](graph-engine.md) § *Predictive arming*) resolves
a Condition node's exit up to `_handoffLeadMs()` — capped at 500 ms — before the token actually
arrives, so the next track's audio can be armed in advance. `_commitArmedHandoff()` then re-runs
every one of those decisions **at the seam**, and throws the whole plan away if any resolves
differently, falling back to the ordinary walk.

So H7 still holds where it matters: the exit a token takes is always the one its condition selected
at arrival. The early evaluation is a prediction, never the decision. If you add a new decision kind
to the planner, it **must** be re-validated at commit time or this stops being true.

## H8 — A live graph edit rebuilds the running engine

**Confidence: quoted.** Cited by `music-controller.mjs` (twice), `hooks.mjs`,
`custom-playlist-editor.mjs`.

Saving a graph that is **actively playing** would otherwise leave the running engine on its stale
in-memory copy. Worse, because the playlist document itself didn't change,
`playCurrentTrack()`'s normal context-unchanged check would skip re-transitioning entirely.

`hooks.mjs#handleUpdatePlaylist` is the **single designed trigger**. It fires
`MusicController.onCustomGraphChanged()`, which deliberately nulls `currentContext` and
`_customEngine` *first* to force a real transition, then awaits the old engine's `stop()` before
starting the replacement.

That `await` is not optional — see [graph-engine.md](graph-engine.md) § *The stop-before-start
race*.

## H9 — Graphs restart from Start; they never resume

**Confidence: quoted.** Cited by `music-controller.mjs`. Described elsewhere as "the locked
GM-handoff decision."

Native playlists remember their offset across interruptions (that is a headline module feature).
**Custom graphs do not.** Consequences that must be kept consistent:

- `_enterTrack()` always forces `pausedTime: 0`.
- `transitionToContext()` sets `currentTracks = []` for a custom playlist, which stops the
  save-position loop from persisting resume offsets for graph sounds on the *next* transition.
- `reconcileRestoredPlayback()` stops custom-playlist sounds that Foundry resurrected from
  persisted `playing: true` document state — since nothing of a previous run should survive,
  whereas native playlists keep resuming across a refresh as they always have.

## H10 — "Play once and stop" requires an explicit End node

**Confidence: inferred.** Cited once, in `graph-presets.mjs`.

A token that runs out of edges terminates with a level-2 warning
(*"node has no outgoing edge; its token terminates here"*), because Start/Track/Delay are
schema-validated to always have exactly one exit — a missing edge means the graph is malformed,
not that it deliberately ended. A graph that is *supposed* to stop routes into an explicit `end`
node, which terminates the token cleanly and silently.

## H11 — Retiring an engine crossfades; it never hard-cuts

**Confidence: quoted.** Cited by `music-controller.mjs`, `custom-playback-engine.mjs` (twice),
`docs/playlist-node-plan.md`.

`transitionToContext()` retires a running engine with `stop({ stopAudio: false })`. The sounds
stay audible and stay in `_managedSoundIds`, so the controller's normal fade-out loop crossfades
them exactly like a native transition instead of cutting them dead.

`stopAudio` passes straight through to child engines, so a crossfading root stop crossfades every
nested playlist's sounds too — not just the root engine's own.

**Corollary: a fade-out is a pending stop, and it must stay cancellable.** `playing === true` for
the whole of a fade, so every adoption path in the module ("already playing, leave it
uninterrupted"; the engine's `path=adopted`) will happily adopt a sound that is seconds from being
stopped by a fade nobody can see any more — and be left holding a token on dead audio, waiting for
an `'end'` that a `'stop'` never sends. Confirmed live twice, from two directions: ticking *Play as
overlay*, and leaving a mood and returning inside the crossfade window.

So `_fadeOutSounds()` claims each sound with a token in `MusicController#_pendingFadeOuts`, and the
completion callback stops it **only while that token is still the current one**. Anything that
reclaims a playing sound must call `cancelPendingFadeOut(sound)` first — it drops the token and
fades the level back up, since adoption never sets a volume of its own.

The same registry answers the other question `sound.playing` can't: **anything that levels live
audio must skip a sound that is fading out.** `applyMixToSound()` does, at entry and on every
retry. Re-levelling mid-fade glides the ramp back *up*, so the track plays on at full volume for
the rest of the fade and then stops dead — reported as *"suppress does not respect the fadeout, it
delays then cuts out"*, because suppression drops the base and the layer together and the duck's
`onChange` re-levels the world mid-fade.

**Never clear `_pendingFadeOuts` in bulk.** Dropping a token is exactly how a stop gets cancelled,
so emptying the map cancels every pending stop and strands those sounds playing forever.

---

## H12 — A durational node's "holds its token forever" property is a function of its loop mode, not its node type

**Confidence: quoted** — written alongside the code that implements it
(`overlays-and-loop-modes-plan.md` L6), not reconstructed after the fact.

Before `loop.mode: 'until'` existed, "durational and never advances" meant exactly `loop.mode ===
'forever'`, and a graph whose only durational node was such a track was correctly assumed to never
go idle. `until` breaks that assumption on purpose: it plays seamlessly via native `repeat: true`
— identical to `forever` — but **does** eventually take its one exit once `loop.condition` matches
at the boundary `loop.boundary` names (`custom-playback-engine.mjs#_scheduleConditionalExit`).

Consequence: a graph whose only durational node is an `until` track **can now go idle**, where
before that shape never could. Idle is how a Playlist node's child engine reports a completed pass
to its parent (see [graph-engine.md](graph-engine.md) § *Playlist nodes*), so an `until` track
inside a child engine now genuinely ends a pass — correct, desirable, and previously impossible
for any graph without an explicit `end` node.

`hasInstantaneousCycle` is unaffected by any of this: `track` is durational under every loop mode,
`until` included, so it was never counted as part of an instantaneous-only cycle in the first
place.

---

## H13 — `Sound#play({delay})` is timed by the AudioContext, and wedges permanently if it stalls

**Confirmed live.** Hand-off arming (`_armHandoff`) is the only place this module starts audio
with a `delay`. Foundry implements that delay as `await this.wait(delay * 1000)` inside
`Sound##queuePlay`, and `wait()` builds an `AudioTimeout` — an empty `AudioBufferSourceNode`
played on the shared AudioContext, whose `onended` resolves the promise.

**A context that is not running never fires it.** The awaited `wait()` never resolves, so
`#queuePlay` never reaches `_play()` and the Sound stays in `STATES.STARTING` **forever**. That
state is uniquely poisonous because it looks completely healthy from the outside:

| Observation | Value while wedged |
|---|---|
| `Sound#playing` | `true` (STARTING counts as playing) |
| `Sound#startTime` | `undefined` — *the only discriminator* |
| Audio output | none, ever |
| `'end'` event | never fires |
| PlaylistSound document | `playing: true`, indefinitely |

So the seam adopts it (`path=armed`), the end watcher waits on an event that cannot arrive, the
token never leaves the node, and the world keeps a sound marked playing across sessions. It also
breaks **core's own UI**: the sidebar's pause button writes
`pausedTime: sound.sound.currentTime`, which for a STARTING sound is
`context.currentTime - undefined` → `NaN` → `DataModelValidationError: pausedTime: must be a number`.

Two defences, both required:

1. **Don't arm into a stalled context** — `_armHandoff` bails (`[audio-suspended]`) when
   `rawSound.context.state !== 'running'`. The ordinary clean start has no delay and no `wait()`,
   so it is unaffected.
2. **Verify afterwards** — `_verifyArmedAudioStarted` re-checks `ARMED_START_VERIFY_MS` after an
   armed adoption, since the context can stall *between* the arm and the seam. `playing === true`
   with `startTime === undefined` means wedged; recovery is `stop()` (which cancels the pending
   delay) followed by an undelayed `play()`, in place, keeping the token and the watcher.

`startTime` is the discriminator and nothing else is: at the seam, "still counting out its delay"
and "playing" are otherwise identical. Check `'startTime' in sound` before trusting it — a Sound
implementation without the field would otherwise read as permanently un-started.

---

## H14 — A placed token holds a *copy* of the prototype's flags, so the prototype must stay in the read chain

`TokenDocument` data is materialised from `Actor#prototypeToken` **once, at creation time**.
Editing the prototype afterwards changes nothing about tokens already on the canvas — Foundry
does not propagate, and there is no error to notice.

That matters here because the token sheet's music button writes to whichever document its sheet
represents: `app.document` for a placed `TokenConfig`, `app.actor.prototypeToken` for a
`PrototypeTokenConfig` (see [HR-I](#hr-i--never-configure-against-a-sheets-preview-clone-apptoken)).
So a prototype-level assignment is real, persists, and re-reads correctly in its own window —
and if the resolver only ever consults the *placed* token, it is never once used.

Confirmed live: assigning playlist `B` to prototype token `B` logged a successful write
(`category=PrototypeToken`), showed `B (Soundboard)` on reopen, and combat still fell through to
the world-default playlist, with
`PlaylistContext.fromDocument: No playlist override found on document 'B'` as the only trace.

**`_getCombatantMusicSources()` therefore returns an ordered chain and the caller takes the first
document carrying an override** — the prototype token is in that chain *even when a placed token
exists*. See [architecture.md](architecture.md#where-candidates-come-from) for the exact order.

Two consequences worth keeping in mind when changing that function:

- The chain is **fallbacks, not competitors.** Push every hit and one combatant contributes two
  contexts that then compete on priority.
- A **linked** token's own flags stay out of the chain unless `useTokenMusic` is set. A linked
  token inherits the prototype's flags at creation, so honouring them would make every linked
  token silently shadow its actor — which is precisely what that flag exists to opt into.

---

## H15 — Two engines must never drive the same playlist

`CustomPlaybackEngine` makes two Track nodes that share a `soundId` safe with `_activeSoundOwners`
— one node at a time owns a physical `PlaylistSound`, so a second can't silently "adopt" it,
overwrite its `AudioEndWatcher` listener and orphan the first node forever (the failure that
tripped the circuit breaker, see that field's comment).

**That map is per-engine.** It is created in the constructor and never shared, so it offers no
protection at all *across* engine trees. Every additive layer runs on its own root engine (an entry
in `_layers`) beside the base one (`_customEngine`), so two independent engines driving one playlist
is physically expressible — and both would adopt, restart and steal each other's listeners on the
same sounds.

`_layerWouldCollide()` therefore refuses a layer whose playlist is:

- the base context's own playlist (`currentContext.playlist.id`),
- anywhere in the base engine tree (`_customEngine.isPlayingPlaylist(id)` — the `_registry` Set,
  which a Playlist node's child engines share **by reference**, so it covers nested targets), or
- anywhere in **another layer's** tree. This third case only became reachable when mood/phase
  overlays gained `layer`: before that there was exactly one layer and nothing for it to collide
  with but the base.

Refusing is the only safe outcome, and costs nothing musically: a playlist layered over itself
was never going to sound like anything but a stuttering doubling. The log line names the playlist
and points at the control that makes it replace instead — `Play exclusively` for a combatant,
unticking `Play as overlay` for a mood or phase.

**`_syncLayers()` retires every outgoing layer before starting any incoming one**, for this rule
rather than for tidiness: a playlist moving from one layer key to another (a phase overlay naming
what the outgoing combatant was already playing) would otherwise be refused against a layer that
was on its way out anyway, and simply not start.

The head-GM rule (rule 5 in CLAUDE.md) covers the layer unchanged — it starts inside
`playCurrentTrack()`, which has already returned on every non-head client.

---

## H16 — The engine must level its own tracks; the `updatePlaylistSound` hook is not enough

`handleUpdatePlaylistSoundMix` exists to push the mix onto live audio on every client, and for
audio started by anything *other* than the graph engine it is sufficient. For engine-started
tracks it has two holes, both of which showed up live as **"track transitions play at full
volume, ignoring the layer duck"**:

**1. The hook often never fires.** A `PlaylistSound`'s `playing` field is not corrected back to
`false` when audio ends naturally — only an explicit update clears it (the same staleness
`_enterTrack`'s `alreadyPlaying` check documents). So on a graph's second pass over a track,
`Playlist#playSound()` writes `playing: true` over `playing: true`, **the diff is empty, and no
`updatePlaylistSound` is emitted at all.** The mix and the duck are silently skipped for that
track, that pass. Nothing errors; the volume is just wrong.

**2. On an armed hand-off it fires, and is then thrown away.** From `Sound##queuePlay`:

```js
this.#configurePlayback(options);          // volume captured HERE, at play() time
if ( delay ) await this.wait(delay * 1000);
this._play();
this.volume = fade ? 0 : volume;           // ...applied HERE, after the delay
```

and `set volume` opens with `gain.cancelScheduledValues()`. So every volume change made during
the arm window — including `reassertDuck()` when a layer starts — is cancelled at the seam and
replaced by the arm-time snapshot.

`_assertMixedVolume()` closes both: every track the engine starts is levelled explicitly, and for
an armed start the assert is **deferred past the seam** (`MIX_ASSERT_DELAY_MS`) so it lands after
`_play()` rather than being wiped by it.

**If you add another place where the engine starts audio, level it there too.** Passing
`mixedVolume()` into `play({volume})` is necessary but not sufficient — it is a snapshot, and
anything that changes the correct volume between that call and the sound actually starting will
be lost.

---

# House rules

Not hazard-numbered, but equally load-bearing. Sourced from the archived plan docs, where they
were labelled HR-A…HR-D, and from the code.

## HR-A — The graph editor never calls `this.render()` after its initial mount

Drawflow's `nodeSelected` event fires **synchronously inside its own mousedown handler, before it
sets up the drag.** A full ApplicationV2 re-render at that moment tears down and rebuilds the
canvas mid-mousedown, orphaning the drag on a detached DOM tree.

The symptom is precise and easy to misdiagnose: **nodes select, but silently never move, with no
console error.**

Every mutation instead goes through a plain string-to-`innerHTML` assignment on a *sibling*
container — `_renderInspector()`, `_renderTracks()`, `_renderValidation()` — which never touches
the canvas. This is why `custom-playlist-inspector.mjs`, `playlist-mixer-render.mjs`, and
`custom-playlist-node-render.mjs` build HTML strings instead of using Handlebars.

## HR-B — `[data-drawflow-mount]` must stay class-free

Drawflow reads `classList[0]` off its mount element. Adding any class to it breaks the library.
Drop listeners bind to the **wrapper** (`.game-orchestra-drawflow-canvas`), never the mount.

Related: the canvas's drop-hover feedback must use `outline`/`box-shadow`, **not `border`** — a
border changes the container's client box and with it Drawflow's drag math.

## HR-C — Node shape CSS is specificity-critical

The per-type shape rules in `styles/game-orchestra.css` are three classes deep on purpose, and several
have the **same specificity as Drawflow's own base rules**. At equal specificity the last-loaded
rule wins, which is why `module.json` must list `drawflow.min.css` before `game-orchestra.css` —
guarded by `tests/module-manifest.test.mjs`. This has already regressed once: every node rendered
as a flat cyan fill regardless of type.

Do not reorder, add to, or restructure those selectors.

## HR-D — `DragDrop#bind()` runs on every render, unguarded

Foundry's `DragDrop#bind()` is **not delegated.** It runs `html.querySelectorAll(dropSelector)` at
bind time and attaches listeners directly to whatever matches right then.
`HandlebarsApplicationMixin` replaces a part's DOM **wholesale** (not a diff/morph), so every
render after the first produces brand-new elements that were never bound.

Guarding `_setupDragDrop()` the way the `change`/`dragleave` listeners are guarded therefore
**silently orphans drag-and-drop after the window's first re-render** — which happens on nearly
any interaction.

`_setupDragDrop()` builds a fresh config object per call rather than mutating
`DEFAULT_OPTIONS.dragDrop` in place (that array is shared across every instance of the class), so
repeated calls never leak callbacks between windows.

> By contrast, the delegated `change` and `dragleave` listeners bind **once**, on the persistent
> root element. The asymmetry is intentional; `app-mixins.mjs` documents it inline.

**Corollary: no UI state may live only in the DOM.** Wholesale replacement destroys anything the
markup was holding for itself, and it happens on *every* render — which in these windows means on
every write, since each `data-change-action` handler re-renders.

This bit a native `<details class="advanced-disclosure">`, whose open state a comment claimed
"survives the window's frequent re-renders on its own." It did not, and nobody noticed while the
only thing inside it was a number field. The moment a checkbox went in, ticking it slammed its own
disclosure shut — the write re-rendered, the fresh `<details>` came back without `open`. Confirmed
live.

The fix is the same shape as `expandedSections`/`collapsedSections`: mirror the state on the
instance (`openDisclosures`), render it back as an attribute, and record changes from a delegated
listener. Note that **`toggle` does not bubble**, so that listener binds in the **capture** phase —
and `removeEventListener` must repeat the `true`, or it silently leaves the listener attached.

## HR-E — Both locale files, always

`lang/en.json` is the reference. Every other locale file must carry the **exact same key set** —
no missing keys (which render the raw key to the user), no orphans left behind after a rename,
no empty values. `tests/lang.test.mjs` enforces all three directions.

This shipped broken once: `pt-BR.json` fell 73 keys behind, losing the entire custom-playback
editor's strings, with no test catching it.

## HR-F — Only ever stop sounds this module started

`MusicController._managedSoundIds` exists so a transition's fade-out loop never touches a GM's
manually-started ambience or jukebox playlist.

`stopTrack()` **releases** the sound from that set. Without the release, a sound stays "managed"
forever after its first play — so if the GM later starts that same sound by hand from the
sidebar, the next transition would silently fade it out again, mistaking it for one of its own.

---

## HR-G — A mix is applied on every client; only the mixer window is GM-gated

The playback engine is head-GM-only (`isHeadGM()`) because it decides *what* plays. **Volume is not
that kind of decision.** Every client builds its own `Sound` from the `PlaylistSound` document and
applies `this.volume` itself in `PlaylistSound#sync()`, so a mix applied only where the engine runs
means **the GM hears the ceiling and the players hear the raw track** — inaudible to the one person
who could notice.

So `playlist-mix-apply.mjs`'s hooks (`updatePlaylistSound`, `updatePlaylist`) are registered
unconditionally, with no `isHeadGM()` gate. The mix values are world flags, so every client reads
the same ones. Only `PlaylistMixerApp` — which *writes* those flags — is GM-gated.

Corollary: `sound.updateSource({volume})` is **not** a way to apply a mix. It is a local-only
source mutation (core uses it for its own instant slider feedback), so on the head GM it changes
nothing for anybody else. The mixer uses it only for the GM's own immediate feedback, alongside the
real document write.

See [mixer.md](mixer.md).

---

## HR-H — Keep the mix out of the `customPlayback` flag

`hooks.mjs#handleUpdatePlaylist` rebuilds a running engine on a `customPlayback` change (H8), and a
rebuilt graph restarts from Start (H9). Storing level settings in that same flag would mean
**nudging a volume slider audibly restarted the music.**

`game-orchestra.mix` is therefore a separate flag, handled on the soft path: `applyMixToPlaylist()`
re-asserts volumes on already-playing sounds via `Sound#fade` — no stop, no restart, no token
movement. Any future per-playlist setting that does not change *what* plays belongs in `mix` (or
its own flag), never in `customPlayback`.

---

## HR-I — Never configure against a sheet's preview clone (`app.token`)

Foundry's token sheets both expose `token` as `this._preview ?? <the real thing>`:

- `TokenConfig extends PlaceableConfig`, which builds `_preview` on its **first** render;
- `PrototypeTokenConfig` clones the `PrototypeToken` in `_prepareContext`.

So `app.token` hands back a **detached preview clone** — meant for live canvas preview — from the
very first render onwards. `hooks.mjs#handleTokenConfigRender` used it, and every per-token
playlist assignment (dropdown *and* drag-and-drop) looked dead: `GameOrchestraConfig` wrote to the
clone and then re-rendered from that same stale clone, so the select snapped back.

It is not only cosmetic. `PlaceableConfig#_createPreview()` keeps the id (`object.clone()`) **only
when the token is actually drawn on the canvas**; otherwise it does `this.document.clone(data)`,
which drops `_id`. `Document#update()` on that clone posts an update for an `_id` that exists
nowhere, so the flag is **silently never written** — no error, no console warning.

Use the real, collection-backed documents: `app.document` for `TokenConfig`, and
`app.actor.prototypeToken` for `PrototypeTokenConfig` (which is a plain `ApplicationV2`, not a
`DocumentSheet` — it has no `document`). Branch on the sheet's own `isPrototype` property.

`GameOrchestraConfig#updateObject` now logs instead of falling through silently when handed a
document it can neither `update()` nor resolve to an Actor — that fallthrough is what made this
class of bug invisible.

---

## HR-J — Flag update keys are dot paths; there is no bracket syntax

`GameOrchestraConfig#updateObject` wrote the prototype-token branch as
`prototypeToken.flags['game-orchestra'].music.combat.playlist`. Foundry expands update keys with
`foundry.utils.expandObject` → `setProperty`, which **splits on `"."` and nothing else** — so that
produced a literal key named `flags['game-orchestra']` on `prototypeToken`, which the Actor schema
silently dropped while cleaning. `actor.update()` resolved successfully and wrote nothing.

Confirmed live: every prototype-token playlist assignment (dropdown and drag-and-drop alike) was
accepted, logged its own success, and came back empty on the next render.

Write `prototypeToken.flags.game-orchestra.<path>`. A hyphen needs no escaping in a dot path.
Deletion keys (`music.combat.-=playlist`) compose with it normally.

Related: `getDocumentCategory()` now tests `instanceof foundry.data.PrototypeToken` before falling
back to `constructor.name`. The name check alone reclassifies a subclassed prototype token as
`null`, which routes every write into `updateObject`'s no-op branch — the same invisible failure
as [HR-I](#hr-i--never-configure-against-a-sheets-preview-clone-apptoken).

---

## HR-K — Never put a class on a Drawflow port or connection

Every marker this editor applies to a **port** (`.output.output_N`) or a **wire**
(`<svg class="connection">`) is an **attribute** — `[data-go-edge-uncertain]`, `[data-go-edge-hover]`,
`[data-go-edge-issue]`, `[data-go-edge-active]`, `[data-go-edge-pulse]`, `[data-go-port-hover]`,
`[data-go-port-revealed]`. They go on through `setMarker()` / `clearMarkers()` in
`scripts/graph-decorations.mjs`, which is where the reasoning lives in full.

Drawflow reads both elements' class lists **by position** and rewrites them in place:

- `updateConnectionNodes()` — which runs on every drag frame and at the end of every
  `removeNodeOutput()` — resolves a wire's two endpoint ports as `classList[3]`/`classList[4]` and
  immediately reads `.offsetWidth` off what they select.
- `removeNodeOutput()` renumbers a wire's port classes by **removing and re-adding** them, which
  moves them to the *end* of the list. Any class of ours slides down into index 3.

Confirmed against the vendored `drawflow.min.js` in a real DOM: with `game-orchestra-edge-uncertain`
applied as a class, **deleting a Random node's middle exit threw** `Cannot read properties of
undefined (reading 'offsetWidth')` from inside `removeNodeOutput()`. `handleRemoveExit()` aborted
half-done — Drawflow had dropped the port, but the matching `data.exits[]` entry was never spliced
and no refresh ran. The visible symptom was two exits still showing **33%** weight chips each; the
invisible one was that every later `updateConnectionNodes()` on that node threw too, so dragging it
stopped working until the window was reopened. `tests/custom-playlist-editor.test.mjs` reproduces
it: the fake Drawflow renumbers wire classes by remove/re-add and enforces the positional read.

Attribute selectors carry the same specificity as a class, so the CSS ordering rules in
[HR-C](#hr-c--node-shape-css-is-specificity-critical) and `editor.md` are unchanged.

**Node** elements keep their classes (`game-orchestra-node-active`, the issue-state classes, …):
Drawflow only reads `classList[0]` there, and never rewrites it — that one is
[HR-B](#hr-b--data-drawflow-mount-must-stay-class-free)'s territory.

## HR-L — Never write Handlebars block syntax inside an HTML comment

Handlebars parses the **whole** `.hbs` file. It does not skip `<!-- ... -->`. A prose note
mentioning `{{#if}}` or `{{#each}}` is therefore a real opening block with no matching close, and
the template fails to compile — at render time, in Foundry, with a parse error pointing at EOF
rather than at the comment that caused it.

This shipped broken: a comment in `custom-playlist-editor.hbs` explaining *why* the Remove button
is not wrapped in a conditional block cited that block by name. Every attempt to open the graph
editor threw `Expecting 'OPEN_ENDBLOCK', got 'EOF'` and rendered nothing. The full suite was green
throughout — 1616 tests, none of which compiled a template.

Write the prose without the syntax ("a conditional block here would…"), or use a Handlebars
comment `{{!-- --}}`, which *is* skipped by the parser.

`tests/template-compile.test.mjs` now precompiles every shipped template and separately flags
Handlebars blocks found inside HTML comments, so the failure names its cause instead of pointing
at the last line of the file.
