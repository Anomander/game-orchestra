# Gapless hand-off + predictive queueing — diagnosis and plan

Status: **Stage 1 and Stage 2 shipped 2026-08-01** (see
[gapless-handoff-implementation.md](gapless-handoff-implementation.md) for the executed steps).
Stage 2's deferred items and Part 5's socket pre-cue (A') remain unimplemented.

Why the graph engine has an audible, variable gap between two tracks while the *same* tracks in a
native `SEQUENTIAL` playlist butt-join cleanly — and what to change.

All Foundry line references are against the installed v14 client
(`/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app/`).

---

## Part 1 — Diagnosis

### D1. The gap is a *document round-trip* count, not an audio problem

Every `Document#update` in Foundry is **server-confirmed, never applied optimistically**:
`ClientDatabaseBackend#_updateDocuments` (`client/data/client-backend.mjs:191-203`) awaits
`SocketInterface.dispatch("modifyDocument", …)` (`:724`) and only then runs `#handleResponse` →
`_onUpdate`. `Playlist#_onUpdate` (`client/documents/playlist.mjs:319-321`) is what calls
`sounds.forEach(s => s.sync())`, and `PlaylistSound#sync()` (`client/documents/playlist-sound.mjs:166`)
is what actually calls `sound.load({autoplay: true, …})`.

**So: audio starts exactly one server round-trip after whoever asked for it.** That is true for
native sequential playback and for this engine equally. The difference is *how many* round-trips sit
between the outgoing track's last sample and the incoming track's first one.

An update whose diff is empty costs nothing — `#preUpdateDocumentArray` drops it before dispatch
(`client-backend.mjs:262`, `:271`). Every update counted below is a real diff.

### D2. Native `SEQUENTIAL` spends exactly one round-trip

`PlaylistSound#_onEnd` → `Playlist#_onSoundEnd` → `playNext(sound.id)`
(`playlist.mjs:367-371`, `:136-151`). `playNext` issues **one** update that carries both halves of
the hand-off:

```js
const sounds = this.sounds.map(s => ({_id: s.id, playing: s.id === next?.id, pausedTime: null}));
return this.update({sounds}, updateOptions);
```

One update → one `_onUpdate` → one `sync()` pass in which the outgoing sound stops and the incoming
one starts, in the same synchronous loop. **1 round-trip.**

It also pre-warms the next file: `Playlist#_onSoundStart` (`playlist.mjs:392-408`) schedules
`_getNextSound(sound.id).load()` at `duration - CONFIG.Playlist.autoPreloadSeconds`
(default **20 s**, `client/config.mjs:559`).

### D3. The graph engine spends **three**

On a natural end of a `loop: {mode:'count', count:1}` Track node, three separate playlist updates are
issued in the same tick, and they serialize on the socket in this order:

| # | Who | Where | What |
|---|---|---|---|
| **A** | **Foundry itself** | `playlist.mjs:372-380` | `_onSoundEnd`'s `DISABLED` branch: `{playing:…, sounds:[{_id: ended, playing:false, pausedTime:null}]}` |
| **B** | the engine | `custom-playback-engine.mjs:1048` → `_stopTrackTracked` (`:705`) → `Playlist#stopSound` | `{playing:…, sounds:[{_id: ended, playing:false, pausedTime:null}]}` — **byte-for-byte redundant with A** |
| **C** | the engine, when needed | `custom-playback-engine.mjs:952` | `sound.update({pausedTime:0, repeat})` — usually skipped by the existing guard |
| **D** | the engine | `:960` → `MusicController.playTrack` → `Playlist#playSound` | `{playing:true, sounds:[{_id: next, playing:true}]}` — **this is the one that makes sound** |

A is the discovery that matters. A custom-graph playlist is stored `UNSEQUENCED` (H1), which is
Foundry's `PLAYLIST_MODES.DISABLED = -1` (`common/constants.mjs:788`) — and `_onSoundEnd`'s switch
has a `DISABLED` case. `PlaylistSound#_onEnd` runs it for anyone who owns the playlist
(`playlist-sound.mjs:265`), which the head GM does. **Foundry writes `playing:false` for a naturally-
finished graph track already, on every hand-off, unprompted.**

Ordering is guaranteed, not incidental: `PlaylistSound#_createSound` registers its `end` listener at
Sound-construction time (`playlist-sound.mjs:60`), the engine's `AudioEndWatcher` registers its at
play time, and `EventEmitterMixin#dispatchEvent` iterates a `Map` in insertion order
(`common/utils/event-emitter.mjs`). **Foundry's listener always fires first, so A is always queued
ahead of D.**

D lands after A and B have each been written and broadcast. The requests pipeline over one socket,
so the cost is not literally 3 × RTT — it is `RTT + 2 × (server write + broadcast)`. That second term
is exactly the part that varies with server load, storage backend and hosting, which is why the gap
is *variable* rather than a fixed offset.

### D4. Two invariants in the wiki are wrong as written

- `graph-engine.md` § *Track* — *"the engine explicitly calls `stopTrack(sound)` before advancing.
  This clears the `PlaylistSound` document's `playing` flag, **which nothing else does when audio ends
  on its own**"*. Foundry's `Playlist#_onSoundEnd` does exactly that, for this playlist mode, before
  the engine's watcher even runs. **B is pure cost.** (The resurrect-on-reload hazard the comment
  guards is real — it is just already handled upstream on the natural-end path. It is *not* handled on
  the timed paths, where no `'end'` event fires at all, so `_stopTrackTracked` must stay there.)
- `graph-engine.md` § *Hand-off latency* attributes the residual to *"'end' fires only after the
  outgoing source has fully stopped"*. That part is ~free: `Sound#onEnd`'s `await this.stop()`
  (`sound.mjs:878-882`) resolves in microtasks, because `#queueStop` resets `fade` to 0 unless one is
  explicitly passed (`sound.mjs:1044`). The residual is A and B.

### D5. There is a real latency budget, and native sequential fits inside it

`AudioBufferSourceNode.onended` is dispatched when the *render* thread finishes the buffer, which
leads what the listener hears by `AudioContext.outputLatency` — tens of milliseconds on a typical
desktop. So a hand-off completed within roughly one output-latency of the `'end'` event is *inaudible*,
because the old buffer is still draining from the output queue when the new one is scheduled.

One round-trip on a local server fits in that budget. Three do not. That is the whole phenomenon:
sequential is not doing anything clever, it is just *under the line*, and the engine is over it.

### D6. Why crossfade didn't fix it

`_beginCrossfadeHandoff` (`custom-playback-engine.mjs:1222`) starts the next track early and fades the
old one out, deliberately **without** fading the new one in (`graph-engine.md` § *Crossfade*). For two
tracks cut to butt-join that is correct; for anything else the user hears two independent pieces
playing at full volume over each other — the "garbled" result. And when the crossfade is set too
short to cover `RTT + 2 × server-write`, the gap simply reappears inside the overlap. It is hiding a
symptom whose size it cannot predict.

---

## Part 2 — Proposed changes

Staged so each stage is independently shippable and independently revertible.

### Stage 1 — Delete the redundant round-trip (small, safe, immediate)

**G1.** On the natural-end path only, **stop calling `_stopTrackTracked(sound)`**
(`custom-playback-engine.mjs:1048`). Foundry's `_onSoundEnd` has already written
`playing:false, pausedTime:null` for that sound. Removes update **B** outright.

Constraints to encode in the replacement comment, because this is subtle:
- Only the `'end'`-driven path may drop it. `_scheduleLoopStop` (`:1294`, `:1307`),
  `_scheduleConditionalExit` (`:1407`), `_beginCrossfadeHandoff` (`:1249`) and `stop()` all stop a
  sound that never fires `'end'` (native `repeat` is on, or the stop is manual) — Foundry writes
  nothing for those and `_stopTrackTracked` stays mandatory.
- `_pendingStops` loses its entry for this sound, which is *correct*: there is no engine-issued stop
  in flight to race. The same-sound wait in `_enterTrack` (`:888`) still covers the timed paths.
- Guard it on the parent actually being a Playlist that will do this for us
  (`typeof sound.parent?._onSoundEnd === 'function'` and the head GM owning it), falling back to the
  current stop otherwise, so a non-Foundry/mocked parent still behaves.

**G2.** Fold update **C** into **D**. When `pausedTime`/`repeat` genuinely need changing, issue one
`playlist.update({sounds:[{_id, playing:true, pausedTime:0, repeat}]})` instead of
`sound.update(...)` then `playlist.playSound(...)`. `graph-engine.md` § *What was considered and
deliberately not done* rejected this because `Playlist#playSound` branches on mode — that objection
stands only if we hand-roll it blindly. Replicate the branch faithfully (`playlist.mjs:161-175`):
`DISABLED`/`SIMULTANEOUS` → touch only the target sound; `SEQUENTIAL`/`SHUFFLE` → also write
`playing:false, pausedTime:null` for every other sound. Keep `playTrack()` as the fallback for
anything that isn't a Playlist parent.

Expected result after Stage 1: the common hand-off costs **one** round-trip, i.e. parity with native
sequential. On a local server that should already be inaudible.

### Stage 2 — Take the round-trip off the audible path entirely

Parity with sequential is not the goal; sequential is only *usually* under the budget, and a hosted
server is not. The fix is to stop waiting for the document at the seam at all.

**G3. Arm the next track's start on the audio clock, before the seam.**

`Sound#play({delay})` is a supported, cancellable, audio-clock-scheduled start
(`sound.mjs:534-561`): `#queuePlay` builds the nodes immediately, then `await this.wait(delay*1000)`
— an `AudioTimeout` backed by a scheduled `AudioBufferSourceNode` (`client/audio/timeout.mjs`), not a
`setTimeout` — and only then calls `_play()` → `bufferNode.start(0, offset, duration)`.

At `T − lead` (where `T` is the seam, known from the duration probe the engine already runs):

```js
// 1. arm the audio locally — state becomes STARTING immediately
nextSound.sound.play({ delay: leadSeconds, volume: nextSound.volume, loop: wantRepeat,
                       offset: 0, fade: 0 });
// 2. issue the ONE document update, fire-and-forget
playlist.update({ sounds: [{ _id: nextSound.id, playing: true, pausedTime: 0, repeat: wantRepeat }] });
```

Five properties make this safe, each verified against the v14 source:

1. **The two starts are mutually idempotent.** `Sound#playing` is true while `STARTING`
   (`sound.mjs:190`), so when the document update lands, `sync()` takes its already-playing branch
   (`playlist-sound.mjs:155-163`) and only re-asserts volume — it does not restart. Conversely
   `Sound#play` returns immediately unless the state is `LOADED`/`PAUSED`/`STOPPED` (`sound.mjs:417`).
   Whichever mechanism gets there first wins; the other is a no-op.
2. **Arming is cancellable.** `Sound#stop` cancels the pending `#delay` (`sound.mjs:639`) and
   `#queuePlay` re-checks `_state !== STARTING` after the wait (`sound.mjs:547`), so a stopped engine
   or a discarded plan leaves nothing behind.
3. **Nothing is audible before `T`.** `_createNodes`/`_connectPipeline` run at arm time but no source
   node has been started.
4. ⚠ **`PlaylistSound#_onStart` kills a start the document doesn't know about**:
   `if (!this.playing) return this.sound.stop();` (`playlist-sound.mjs:246-247`), where `playing` is
   the *document* field. **The update in step 2 must land before `T`.** This is the single hard
   constraint on `lead`. If it doesn't, the armed start is stopped and `sync()` restarts the sound
   when the update finally lands — i.e. it degrades to exactly today's behaviour, no worse.
5. **`fade: 0` explicitly.** `#configurePlayback` resets `fade` unless passed (`sound.mjs:1044`), but
   passing it makes the intent legible next to `_warnIfFadeBreaksTheSeam`.

**G4. `lead` is measured, not guessed.** Keep an EWMA of observed `playlist.update()` resolution time
per engine (the engine already times `marks.play` at `:961`) and use
`lead = clamp(1.5 × ewmaRttMs + 20, 60, 500)`. Seed from the first hand-off's measured value; until
there is a sample, use 250 ms.

**G5. Accept a small overlap on remote clients, and say so.** Remote clients receive the `playing:true`
broadcast at ≈ `T − lead + oneWay` and start then — `lead − oneWay` **early**, overlapping the outgoing
track. With G4's adaptive lead that is roughly one one-way latency (~10–40 ms typical), i.e. about the
size of the crossfade this module already ships as a deliberate feature. It replaces a gap of the same
order, on clients that today have one. This is a genuine cross-client behaviour change and belongs in
the release notes.

> **Alternative if that overlap is unacceptable:** set `nextSound.playing = true` *locally* just
> before the armed start fires and issue the real update at `T`. Foundry itself assigns this field
> directly (`playlist-sound.mjs:235`), so it is a sanctioned pattern. Remote clients then behave
> exactly as native sequential does today and the head GM is gapless — at the cost of the head GM's
> audio leading everyone else's by one round-trip. **This is the one open decision in this plan
> (see O1).**

**G6. Take the outgoing side too, where the engine already owns it.** For `loop.count > 1`,
`until`/`loopEnd` and any crossfade boundary, the engine picks the moment itself
(`_scheduleLoopStop:1290`, `_scheduleConditionalExit`). Those stops should move from
`EngineClock`-`precise` (a `setTimeout` racing a 100 ms worker tick — `engine-clock.mjs:32`, `:90`) to
`Sound#schedule(fn, playbackTime)` (`sound.mjs:771-788`), which is audio-clock accurate, expressed in
*playback position* rather than wall-clock, and self-cancels via `unscheduleAll()` inside
`_disconnectPipeline` (`sound.mjs:1000-1001`).

This is a deliberate, narrow exception to H4 ("every wait goes through `EngineClock`"). It is safe for
the same reason H4's `precise` note is: the `AudioContext` clock is not subject to background-tab
throttling. Document it in `invariants.md` as *"seams measured against a specific sound's own playback
position use `Sound#schedule`; everything else uses `EngineClock`"*, so the rule stays a rule.

**G7. Keep the `'end'` watcher armed as ground truth**, exactly as the crossfade does today
(`graph-engine.md` § *Crossfade*, second bullet). The armed start is an estimate built from a probed
duration. If the track ends early, the probe fails, or the plan is invalidated, the watcher advances
the token the way it does now. Whichever fires first retires the node.

**G8. Leave update A alone.** Once the incoming track is already playing and already marked
`playing:true`, Foundry's `_onSoundEnd` write lands *after* the seam and costs nothing audible. It
also then correctly leaves the playlist-level `playing` flag `true`, because its scan
(`playlist.mjs:375-378`) sees the incoming sound already playing. Suppressing it would mean stopping
the outgoing sound before its natural end, which risks clipping the tail for zero gain.

---

## Part 3 — Predictive queueing

Stage 2 needs to know **which** sound to arm, `lead` ms before the seam. Today the engine only learns
that *after* the seam, by walking the graph. `findUpcomingTrackNodes`
(`custom-playback-schema.mjs:226`) returns the *set* of candidates for preloading but commits to
nothing.

### Q1. A plan, produced once per Track entry

New pure function in `custom-playback-schema.mjs` (keep the purity boundary — it takes decisions as
inputs and returns them as outputs, it does not read game state):

```js
planNextHandoff(graph, fromNodeId, { rng, evaluateCondition, recentPicks }) -> HandoffPlan | null
```

```js
HandoffPlan = {
  nodeId,                  // the Track node that will play next
  soundId,
  path: [edgeId, …],       // edges the token will traverse to get there
  extraDelayMs,            // summed Delay nodes crossed on the way — the seam is T + this
  decisions: [             // replayed verbatim at commit time
    { nodeId, kind: 'random',    edgeId },
    { nodeId, kind: 'condition', edgeId },
    { nodeId, kind: 'delay',     ms }
  ]
}
```

### Q2. Planning rules

Walk forward from the current Track node exactly as `_followSingleExit`/`_enterRandom`/
`_enterCondition`/`_enterDelay` would, with these differences:

- **Random** — draw *now*, using the same weight/cooldown/`avoidRepeat` logic, and record the edge.
  Do **not** mutate `_recentPicks` during planning; the history is written once, at commit.
- **Condition** — evaluate *now* and record the chosen edge. See Q4.
- **Delay** — sample `min + rng()*(max-min)` *now*, record the ms, and add it to `extraDelayMs`. This
  is a strict improvement: the delay currently lands on an `EngineClock` tick (±100 ms), and arming it
  on the audio clock makes it exact.
- **Track / Playlist / End** — terminate the walk.

### Q3. Bail conditions — return `null`, fall back to today's path

Every one of these is a case where a single armed seam is either wrong or unknowable:

| Condition | Why |
|---|---|
| A **Fork** on the path | Spawns N tokens; one armed seam cannot represent it. |
| A **Playlist** node reached | The child engine's first track isn't knowable without running it. |
| The current node's loop is `forever` or `until` | No known seam. |
| The next Track reuses **this** node's `soundId` | One `Sound` cannot play two positions at once — the same reason the crossfade bails (`:1181`). |
| The next Track's sound is owned by another node (`_activeSoundOwners`) or its node is already in `_activeNodes` | Singleton rule would drop the token anyway. |
| Duration probe failed | No `T` to arm against. |
| `extraDelayMs` exceeds a cap (say 30 s) | An armed `AudioTimeout` holding a source node for minutes is not worth it; the existing Delay path is fine. |

Bailing is free — the engine keeps exactly today's behaviour, which after Stage 1 is already
one-round-trip.

### Q4. Commit-time validation — the H7 escape hatch

H7 says a Condition node's exits are evaluated **when the token arrives**. Planning `lead` ms early
violates that for a window of ≤ 500 ms. The fix is not to weaken H7, it is to **verify the plan at the
seam**:

1. At `T` (or `T + extraDelayMs`), before the token hops, re-run `evaluateCondition` for every
   `kind: 'condition'` decision in the plan.
2. If every decision still resolves to the same edge → commit: hop the token along `path`, write the
   Random history, and let `_enterTrack` adopt the already-started sound.
3. If any differs → **discard**: `armedSound.sound.stop()` (cancels the pending delayed play, per
   `sound.mjs:639`), issue a `stopSound` for it if the pre-issued update already landed, and walk the
   graph normally from the current node.

Net effect: **seamless when the prediction holds — which is nearly always — and today's behaviour when
it doesn't.** A mood change inside a 250 ms window costs one ordinary hand-off, not a wrong track.
Keep `lead` capped at 500 ms specifically to bound this window, and log every discard at level 2 so
it's visible if it ever becomes common.

### Q5. Where it hooks into the engine

- `_enterTrack` (`:1006`) already probes duration for `_recordTrackTiming`. Reuse that value: once
  known, call `_queueNextHandoff(node, sound, duration, runId)`.
- `_queueNextHandoff` builds the plan (Q1), bails or arms (G3), and stores
  `this._armedHandoff = { plan, soundId, nodeId, armAt, seamAt, runId }`.
- The seam callback commits (Q4) and then hops the token via the existing
  `_walk(() => { release; followSingleExit })` shape, so idle detection and the activity broadcast are
  untouched.
- `_enterTrack` gains an explicit **armed-adoption** branch, consulted *before* the generic
  `alreadyPlaying` check (`:908`): if this node is the armed one and its sound is `STARTING`/`PLAYING`
  because *we* armed it, adopt deliberately — skip `playTrack` (the update already went out), skip the
  `pausedTime`/`repeat` update, but **still** write `_lastCleanStartAt` so
  `MIN_CLEAN_START_INTERVAL_MS` and the circuit breaker keep bounding the node. Do not let this land in
  the existing accidental-adoption branch; that branch's `setTimeout(…, 0)` yield and `elapsedMs`
  computation exist for a different situation.
- `stop()` must cancel `_armedHandoff` synchronously alongside the child stops (`:334-349`), and
  `_fadingOutSounds`-style bookkeeping applies: an armed sound whose `playing:true` update has landed
  but which never started must have that flag cleared, or it is resurrected on the next page load.
- `refreshOverlayReactiveTargets()` and `_swapPlaylistNodeTarget()` must discard any armed plan — the
  world state they react to is exactly what the plan assumed.

### Q6. Preloading stays, narrowed

Keep `_preloadUpcoming` (`:772`) as the fan-out warm-up — it is cheap, defensive, and covers the cases
where planning bails. Once a plan exists, additionally ensure the planned sound specifically is loaded
before arming (`PlaylistSound#load()`), since `Sound#play` on an unloaded sound does nothing
(`sound.mjs:417` — state is `NONE`). Foundry's own equivalent runs 20 s out
(`playlist.mjs:392-408`); arming at 250 ms out without a loaded buffer would silently no-op.

### Q7. Crossfade after this

With a true butt-join available, `graphCrossfade` stops being the gap workaround and becomes what its
name says: an artistic overlap for tracks that aren't cut to join. Recommend keeping the default at 0,
and — separately, if the user wants it — adding a fade-**in** on the incoming side, which is the actual
cause of the "garbled" result described in D6. Out of scope for this plan.

---

## Part 4 — Risks, tests, decisions

### Hazards this touches

- **H3/H6** (never trust `'end'` for a repeating track) — unchanged; G6 only swaps the *timer*, not the
  mechanism.
- **H4** (everything through `EngineClock`) — narrowed by G6, see the wording there.
- **H7** (conditions evaluated on arrival) — preserved via Q4's commit-time re-validation. Say so
  explicitly in `invariants.md`; the plan is an optimisation, never a second source of truth.
- **H12** (`forever`/`until` hold their token) — planning bails on both (Q3).
- **The stop-before-start race** (`graph-engine.md`) — an armed start is a start. `_armedHandoff` must
  be cancelled by `stop()` before any replacement engine starts, on the same synchronous pass as the
  existing child stops.

### Known interaction worth documenting separately

A Playlist node's child engine over a **native `SEQUENTIAL`/`SHUFFLE`** target hits
`_onSoundEnd` → `playNext` (`playlist.mjs:369-371`) on every natural end — Foundry starts the next
native track *while the child engine starts its own*. The synthesized graph mirrors `playbackOrder`
so they normally agree, and the singleton/owner checks absorb the rest, but it is an unmanaged write
racing the engine and it is not mentioned anywhere in the wiki today. Worth a line in
`graph-engine.md` § *Playlist nodes* regardless of whether this plan proceeds.

### Tests

`tests/custom-playback-engine.test.mjs` and `tests/mocks` need a `Sound` mock that models: `_state`
transitions including `STARTING`, `playing` true during `STARTING`, `play({delay})` resolving on a
controllable clock, `stop()` cancelling a pending delayed play, and `PlaylistSound#_onStart`'s
`if (!this.playing) stop()` behaviour. Then:

1. **Round-trip count** — a two-track chain issues exactly one `playlist.update` per hand-off
   (regression test for G1/G2; count calls on the mock).
2. **G1 boundary** — the timed paths (`loop.count > 1`, `until`, crossfade, `stop()`) still call
   `stopTrack`; only the `'end'` path doesn't.
3. **Arming** — armed sound is `STARTING` before the seam and `PLAYING` after; `sync()` arriving
   mid-arm does not restart it.
4. **Cancellation** — `stop()` mid-arm leaves no started sound and no sound marked `playing` in the
   document.
5. **Plan invalidation** — a Condition whose result changes between arm and seam discards the armed
   sound and takes the freshly-evaluated exit.
6. **Every bail condition in Q3** returns `null` and produces today's behaviour.
7. **Planner purity** — `planNextHandoff` is tested directly with injected `rng`/`evaluateCondition`,
   no Foundry.
8. **Round-trip** — a Random plan's recorded pick is the pick the engine actually makes, and
   `_recentPicks` is written exactly once (the schema-union round-trip lesson applies: a new decision
   kind must survive plan → commit intact).

### Measurement

Extend the existing latency line (`:996-1002`) with `armed=<bool> lead=<ms> rtt=<ewma>
docLanded=<bool> planDiscarded=<reason>`. An audible gap should be attributable to exactly one of:
plan bailed, plan discarded, update landed after `T`, or buffer not loaded.

### O1 — the seam decision (see also Part 5, which reframes it)

**How should remote clients behave at the seam?**

| | Head GM | Remote clients | Notes |
|---|---|---|---|
| **(a) Pre-issue the update `lead` early** (G3+G4+G5) | gapless | start ~one-way latency **early** → small overlap | No document field is written directly. Recommended. |
| **(b) Local `playing = true`, update at `T`** (G5's alternative) | gapless | unchanged from today (~1 RTT gap), now ~1 RTT behind the GM | Matches native sequential exactly for remote clients. |
| **(c) Setting** | either | either | More surface area; defer unless (a) proves wrong in play. |

Everything else in this plan is the same either way, so this can be decided at implementation time —
but it should be decided deliberately, not defaulted into.

---

## Part 5 — Evaluated alternative: self-managed play queues on every client

Instead of driving playback through `PlaylistSound` documents at all, the head GM broadcasts what to
play over a module socket and **every client runs its own local scheduler** against raw
`foundry.audio.Sound` instances.

This is a different axis from Parts 2–3. Parts 2–3 make the *head GM* gapless. This makes **every
client** gapless, because it removes the network from the seam entirely rather than merely scheduling
around it.

### P1. Why it works at all — the clock argument

Each client only needs to be gapless *with itself*. Given `{src, startAtServerTime, duration, next}`,
a client schedules its own seam against its own `AudioContext` and hits it with sample accuracy,
**with zero network traffic at the seam**. Cross-client clock error only changes how far into the
track each listener is — it does not reintroduce a gap on any of them.

`game.time.serverTime` (`client/helpers/time.mjs:80`) is Cristian's algorithm over a 4-sample averaged
one-way latency, resynced every 30 s (`:24`, `:175-195`). Realistically ±10–50 ms across clients:
useless for phase-locking two copies of the same track, entirely adequate for "everyone starts the
next track without a hole in it", which is the actual requirement.

Per-user volume survives for free: `Sound#destination` defaults to `context.gainNode`
(`client/audio/sound.mjs:957`), and `game.audio.music` is created with the user's own
`globalPlaylistVolume` on that gain node (`client/audio/helper.mjs:653-660`). A raw `Sound` on that
context already respects the listener's music slider.

The scheduler must create its **own** `Sound` instances — `game.audio.create({src, context:
game.audio.music, singleton: false})` (`helper.mjs:189-209`) — not reuse `PlaylistSound#sound`.
That is the whole point: a Sound the module owns has no `_onStart` guard that stops it when the
document disagrees (`playlist-sound.mjs:246-247`) and no `end` listener that triggers Foundry's
competing `_onSoundEnd` write (D3/A). The buffer cache is keyed by `src` (`client/audio/cache.mjs`,
1 GB LRU), so a second Sound over the same file costs no second decode.

### P2. Two variants, only one of which is viable

| | **A — broadcast the decision** | **B — replicate the graph** |
|---|---|---|
| GM walks the graph and broadcasts each hand-off `lead` ahead | ✅ | ❌ every client runs its own engine from a shared seed |
| Per-seam network traffic | one small message | none |
| Determinism required | none | total |

**B is a trap.** Condition nodes read `activeMood`/`activePhase`/combat state, and clients observe
those changes at *different times*. Two clients evaluating the same Condition node microseconds apart
across a mood change take different exits and play different tracks — permanently divergent, with no
mechanism to detect it. Random nodes could be seeded, but conditions cannot be made deterministic
without freezing world state, and `refreshOverlayReactiveTargets()` exists precisely because that state
is meant to move. **Rule out B.**

Everything below evaluates **A**.

### P3. Pros

1. **Every client becomes gapless, not just the head GM.** This is the only option in this document
   that does that. A player on 200 ms latency currently hears the same gap the GM does; under A they
   hear none.
2. **Zero document writes on the audible path** — not one deferred write, none. Parts 2–3 get the
   write off the critical path; this deletes it.
3. **Deletes a whole class of existing bugs rather than working around them.** Most of the hairiest
   machinery in `custom-playback-engine.mjs` exists to manage a document layer that would no longer be
   in the loop: `_pendingStops` and the stop-before-start race, the `sound.playing` staleness trap
   (`:899-908`), `pausedTime ?? 0` vs `0` (`:941-948`), `_fadingOutSounds`' persistence concern
   (`:163-167`), the resurrect-on-reload hazard, and Foundry's competing `_onSoundEnd` write (D3/A).
4. **Timing primitives get better.** Sample-accurate loop points, independent gain per track (a real
   equal-power crossfade instead of the one-sided overlap in D6), and layered/stem playback all become
   expressible.
5. **The engine's own timing simplifies.** `EngineClock`'s worker-tick machinery exists to survive
   background-tab throttling; an `AudioContext`-scheduled seam is immune by construction.

### P4. Cons

1. **You do not actually escape the document layer — you demote it.** The Playlist sidebar's playing
   indicator, stop button, and per-sound volume slider all read `sound.playing`/`playlist.playing`, and
   so does this module's own code: `music-controller.mjs:211` iterates `game.playlists.playing` for the
   transition fade-out, `:126`, `:252`, `:339`, `:696`, `helpers.mjs:342`, and the playlist-tree UI.
   Other modules and GM macros inspect it too. Keeping any of that honest means still writing
   documents — just lazily and off the seam. **Budget for the document layer staying, with a second
   source of truth beside it.** Two sources of truth for "what is playing" is the single largest
   ongoing cost here, and the one most likely to produce the sort of silent-failure bug this codebase
   already has a page of.
2. **Late joiners and page refreshes stop being free.** Today `Playlists#initialize`
   (`client/documents/collections/playlists.mjs:47-55`) syncs every sound marked playing, so a
   reloading client rejoins the music automatically. Socket cues are not replayed — a client that
   reloads mid-track hears nothing until the next hand-off, which can be minutes. Needs an explicit
   join handshake: client asks, head GM answers with `{src, offset, next}`.
3. **Head-GM handover loses its state.** Document state survives a GM disconnect; in-memory scheduler
   state does not. A new head GM must reconstruct and re-cue.
4. **New failure modes that are silent by nature.** A dropped or late socket message is a missed cue —
   silence, with no error. Every cue needs an independent local fallback, which means the document path
   has to keep working *anyway* as the safety net.
5. **Mixed-version clients during upgrade.** A player on the old version ignores the cue and plays from
   documents; a player on the new one plays from the cue. Both must sound acceptable, and the protocol
   needs a version field from day one.
6. **`module.json` needs `"socket": true`**, and CLAUDE.md rule 5 — *"Nothing is broadcast over a
   socket"* — stops being true. That rule is load-bearing for how the whole module is reasoned about.
7. **`game.audio.locked`.** Every client needs a first user gesture before any of this works
   (`helper.mjs:99`, `:259`). `PlaylistSound#sync` handles that today; the scheduler must
   (`await game.audio.unlock`), including for cues that arrive while still locked.

### P5. Complexity

| Piece | Rough size | Risk |
|---|---|---|
| Socket protocol + versioning + join handshake | ~150 LOC | low |
| `ClientPlaybackScheduler` (own Sounds, arm/cancel, unlock, catch-up, drift correction) | ~350–450 LOC | **high** — new, on every client, hard to test |
| Clock discipline (`serverTime` → local `AudioContext.currentTime`) | ~60 LOC | medium, subtle |
| Lazy document writes for UI + reconciliation with scheduler state | ~150 LOC touched | **high** — the two-sources-of-truth problem |
| Rework `transitionToContext` fade-out to not key off `game.playlists.playing` | ~100 LOC touched | medium |
| Head-GM handover + late-join | ~100 LOC | medium |
| Test harness: a client-scheduler mock, socket mock, multi-client fixtures | substantial | — the existing 1170 tests route through `playTrack`/`stopTrack` throughout |

**Comparable in size and risk to the graph engine itself**, and it lands on every client rather than
only the head GM's — which is exactly where this codebase has no diagnostic reach today (no socket, no
remote logging; `_emitActivity`'s own comment at `:190-192` notes the editor can't even highlight on a
non-GM client).

### P6. Recommendation

**Do Parts 2–3 first; do not start here.** They are strictly smaller, they fix the reported problem
(the GM's own monitoring is where a gap gets noticed), and Stage 1 alone removes two thirds of the
round-trips for free.

**Then, if remote-client seams still matter, add the thin additive version — A′:**

> Keep documents authoritative exactly as they are. Add a **pre-cue socket message** the head GM
> broadcasts `lead` ms before a seam: `{v, playlistId, soundId, startAtServerTime, offset, loop,
> volume}`. Any client that receives it arms `sound.play({delay})` locally on its own audio clock
> (G3's mechanism, which already has to exist for Part 2). Any client that doesn't — old version,
> dropped message, still audio-locked, joined late — falls through to today's document-driven start
> and hears exactly what it hears now.

A′ captures the main win of P3.1 (every client gapless) at a fraction of the cost, because:

- it reuses G3's arming mechanism rather than inventing a second playback path;
- it needs no join handshake, no head-GM handover, no reconciliation — the document layer is still the
  only source of truth, and the cue is a pure optimisation hint;
- every failure mode degrades to today's behaviour instead of to silence;
- it is deletable in one commit if it misbehaves.

Its one caveat is the `_onStart` guard (G3, point 4): a client arming from a cue must have the document
say `playing: true` before the armed start fires, or Foundry stops it. That is the same constraint
Part 2 already has to satisfy, and it resolves **O1 in favour of option (a)** — pre-issuing the update
early is what makes the cue safe on remote clients too, so the two decisions collapse into one.

Full self-management (P3.3's cleanup, sample-accurate loop points, real crossfades) is a plausible
*end state* for this module, but it should be reached by moving playback onto module-owned `Sound`
instances deliberately, once A′ has proven the scheduler in production — not as the fix for a hand-off
gap.
