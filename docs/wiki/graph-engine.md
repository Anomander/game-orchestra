# The custom playback engine

`CustomPlaybackEngine` executes a playback graph as a **token-flow state machine**: a token
enters at the Start node and walks the graph, playing Track nodes and following their exits.

Runs on the head GM only. Every other client observes the resulting `PlaylistSound` state.

Read alongside `scripts/custom-playback-engine.mjs` — its comments are the primary source and
record live-confirmed failures.

---

## The schema

`custom-playback-schema.mjs`, version `1`, stored on the playlist flag `game-orchestra.customPlayback`.

```js
{ version: 1, nodes: [GraphNode], edges: [GraphEdge] }
```

### Node types

| Type | Kind | Inputs | Outputs | Holds a token for |
|---|---|---|---|---|
| `start` | instantaneous | 0 | 1 | — |
| `end` | instantaneous | 1 | 0 | — (token terminates) |
| `track` | **durational** | 1 | 1, or **0 if `loop.mode === 'forever'`** | depends on `loop.mode` — see below |
| `playlist` | **durational** | 1 | 1, or **0 if `loop.mode === 'forever'`** | `loop.count` passes of another playlist (`forever`/`count` only — `until` is Track-only) |
| `delay` | **durational** | 1 | 1 | a fixed or random interval |
| `fork` | instantaneous | 1 | ≥2 | — (spawns a token on *every* exit) |
| `random` | instantaneous | 1 | ≥1 | — (weighted draw, one exit) |
| `condition` | instantaneous | 1 | ≥1 | — (first matching exit) |

`start` is the only type with **no input port** — it is the sole entry point and nothing ever
produces an edge into it.

### `loop` — how a Track or Playlist node decides when to advance

`track`/`playlist` nodes carry one discriminated `loop` field (`custom-playback-schema.mjs`)
rather than the separate `infinite`/`loopCount` fields an earlier version of this schema used:

```js
loop: { mode: 'count', count: 3 }                                          // count >= 1
loop: { mode: 'forever' }
loop: { mode: 'until', condition, boundary, minLoops, maxLoops }           // Track only
```

Always read it through `resolveLoop(node)`, never `node.loop` directly — it normalizes a
missing/malformed value to a single count-mode pass the same way everywhere, so readers don't
each invent their own default. `graph-drawflow-bridge.mjs` also routes a Track's loop through
`resolveLoop()` on both the export and import side, specifically so an `until` loop's
condition/boundary/minLoops/maxLoops survive an editor round-trip intact — collapsing it back to
the old forever/count binary there silently reverted every `until` loop to a 1-count loop the
moment any other field on the node changed (a real bug this schema's own tests now guard
against).

For a `playlist` node, `count` means **passes**, exactly as the old `loopCount` did. `until` is
declared Track-only in the schema's own doc comment — nothing currently stops a malformed
Playlist node's `loop.mode` from technically being `'until'`, but no UI path produces one, and
`graph-drawflow-bridge.mjs` deliberately keeps the Playlist branch on the old forever/count-only
serialization rather than routing it through `resolveLoop()` too.

### Durational vs instantaneous

This distinction drives nearly everything:

- **Durational** (`track`, `delay`, `playlist`) hold a token for real time and are subject to the
  **singleton rule**.
- **Instantaneous** (the rest) pass a token through synchronously and are subject to the
  `MAX_SYNCHRONOUS_DEPTH` guard.

### Edges

```js
{ id, from, to, weight?, cooldown?, condition? }
```

`weight`/`cooldown` apply to a Random source; `condition` to a Condition source. Per H5 this
metadata is stored on the **source node's** `data.exits[]` when round-tripping through Drawflow,
because Drawflow connections carry no data of their own.

Condition kinds: `combatActive`, `combatIdle`, `mood` ("Mood Is" in the UI, with `value`), `phase`
("Phase Is", with `value`), `moodChanged` ("Mood Changes", no `value`), `phaseChanged` ("Phase
Changes", no `value`), `enemiesDefeated`, and `default` (always matches — the fixed fallback exit,
of which every Condition node has exactly one, rendered read-only and unremovable). `mood`/`phase`
are the two overlay axes (see [architecture.md](architecture.md) § *Overlay axes*) — each checks
its own `active*` setting against `condition.value`, independent of which section is currently
winning. `moodChanged`/`phaseChanged` check the same setting against a **baseline** instead of a
fixed value: the overlay's value when the current graph run began (`_moodAtStart`/`_phaseAtStart`,
captured once in `start()`) for a Condition node's own exits, or the value when the current
until-loop began (captured fresh in `_scheduleConditionalExit`, since a long-lived loop can outlive
several unrelated overlay changes that happened before it was even entered) for a Track's
`loop.mode: 'until'` escape condition. A Track node's `loop.mode: 'until'` escape condition (below)
otherwise reuses this exact same vocabulary.

---

## Core mechanisms

### The singleton rule

**A durational node may hold at most one token.** A token arriving at a node already in
`_activeNodes` is silently dropped.

This is the graph's **implicit merge**: two Fork branches converging on the same Track produce one
playback, not two. No Join node is needed or exists.

The registration must be **atomic**. Two tokens can race into the same node in the same microtask
(two Fork branches converging), and both would pass a check that straddled an `await` — so
`_enterTrack`/`_enterPlaylist` write to `_activeNodes` *before* their first `await`, not after.

### Sound ownership — `_activeSoundOwners`

Two Track nodes referencing the same `soundId` are **not two independent resources**. They are one
physical `Sound` fought over by two bookkeeping entries.

Without a separate `soundId → nodeId` map, the second node finds the sound already playing,
silently "adopts" it (no throttle, no real restart), and in doing so **overwrites the first node's
`AudioEndWatcher` listener** — orphaning the first node in `_activeNodes` forever while hand-offs
between the two cascade far faster than any throttle could bound.

*Confirmed live: this is what tripped the circuit breaker.*

A node entering a Track whose sound is owned by a different node drops its token, exactly like the
singleton check. Ownership frees only when the owning node's own playback genuinely ends — always
release via `_releaseTrackNode()`, never `_activeNodes.delete()` directly, so the two maps can't
drift apart.

### Adoption

A Track whose sound is **already audibly playing** is adopted rather than restarted from zero — it
carries over from the previous context instead of stuttering.

Two subtleties:

- **Ground truth is `sound.sound.playing`, not `sound.playing`.** The `PlaylistSound` *document*
  field only changes on an explicit document update; it is never corrected back to `false` when
  audio ends naturally. It goes stale permanently the moment a Track advances via a natural
  `'end'`. Trusting it (confirmed live) meant the adoption branch was taken forever, which is
  what let restarts cascade unthrottled. Fall back to the document field **only** before a live
  `Sound` instance exists.
- **Adoption yields (`setTimeout(…, 0)`) before touching the watcher.** If this `_enterTrack` was
  reached synchronously from inside another node's `'end'` dispatch on the same shared sound,
  calling `addEventListener('end', …)` while that dispatch is still on the stack can re-invoke it
  in the very same pass. *Confirmed live: 16 restarts landed within ~12 ms.*

### Idle detection — `_walk()` / `_checkIdle()`

An engine is **idle** when no walk is in flight (`_pendingWalks === 0`) and no durational node
holds a token (`_activeNodes.size === 0`). This is the *only* consumer of the `onIdle` callback,
and it is how a Playlist node's child engine reports a completed pass.

The critical rule: **idle must never be observed in the instant between a durational node
releasing its token and the next node receiving it.** So every caller that releases and then
advances does both inside **one** `_walk()` call, never as two separate steps:

```js
await this._walk(async () => {
  this._releaseTrackNode(node);
  await this._followSingleExit(node.id, 0);
});
```

`start()` also calls `_checkIdle()` when a graph has no Start node at all — otherwise a parent
Playlist node targeting an empty graph would wait forever for a pass that can never complete.

### Run-id invalidation

`stop()` sets `_runId = -1`. Every pending callback captured the real run id and re-checks it
before acting, so a torn-down engine's stale timers and listeners all bail. `isRunning` reuses
that same sentinel rather than duplicating state.

---

## Safety nets

Four independent guards, each protecting against a different runaway. All are calibrated — do not
change the constants without understanding which failure each one absorbs.

| Constant | Value | Guards against |
|---|---|---|
| `MAX_SYNCHRONOUS_DEPTH` | 100 | A cycle of only instantaneous nodes (no Track/Delay to hold time) |
| `MIN_CLEAN_START_INTERVAL_MS` | 300 | A durational cycle repeating faster than the browser can keep up |
| `MAX_ENTER_TRACK_CALLS_PER_WINDOW` | 15 / 2 s | A genuine runaway (leaked/duplicate `'end'` listener) |
| `MAX_DURATION_PROBE_ATTEMPTS` | 20 (~2 s) | A sound that never reports a loaded duration |
| `MAX_PLAYLIST_NESTING_DEPTH` | 4 | An unbounded legitimate chain of Playlist nodes |

**Why a durational cycle needs a floor at all.** A Track whose exit points back to itself is a
*legitimate* way to say "keep playing this track" and is deliberately not blocked. But nothing
otherwise caps how fast it can repeat: for a short clip, each iteration's real Foundry document
update can fire far faster than the browser can keep up with, flooding the tab's event queue
badly enough to make it unresponsive. *This happened in practice, not just in theory.* Delay
nodes get an equivalent floor for free from `EngineClock`'s tick cadence; Track and Playlist
nodes need it enforced explicitly via `_throttleNodeEntry()`.

**Why the circuit breaker sits above the throttle.** 15 calls per 2 s is well above the ~7 clean
starts the 300 ms floor permits, so it only trips on something the throttle was never designed to
bound. When it trips, the engine stops itself outright and notifies the user.

The instantaneous-cycle case is caught **twice**: `graph-validation.mjs#hasInstantaneousCycle`
rejects it at edit time, and `MAX_SYNCHRONOUS_DEPTH` catches it at runtime. The editor refuses
rather than relying on the runtime net.

---

## Per-node behavior

### Track

1. Circuit breaker, singleton check, sound-owner check.
2. Register in `_activeNodes` + `_activeSoundOwners` **synchronously**.
3. Adopt if already playing, else throttle → `update({ pausedTime: 0, repeat: … })` → `playTrack`.
4. **Verify it actually started.** `MusicController.playTrack()` deliberately swallows
   `AbortError`/"interrupted" rejections silently (harmless for a native transition). Here it is
   *not* harmless: attaching the `'end'` watcher to a sound that never started means waiting
   forever for an event that isn't coming — a silent stop with no sign of failure anywhere.
   The engine releases and retries instead, bounded by the throttle and breaker.
5. Then, by `resolveLoop(node).mode`:
   - **`forever`** → native repeat, no watcher, no scheduled stop, no exit. Holds its token
     permanently.
   - **`count`, `count === 1`** → `AudioEndWatcher` on `'end'`.
   - **`count`, `count > 1`** → `_scheduleLoopStop()` (H3/H6).
   - **`until`** → native repeat (same as `forever`), but `_scheduleConditionalExit()` schedules
     the node's one exit once `loop.condition` matches at the boundary `loop.boundary` names
     (H12) — a "`forever` with an escape hatch".

**On natural end**, Foundry itself clears the `PlaylistSound` document's `playing` flag before the
engine gets a look in. `PlaylistSound#_onEnd` → `Playlist#_onSoundEnd` writes
`{playing: false, pausedTime: null}` in **every** playlist mode, including the `UNSEQUENCED`/
`DISABLED` (−1) one a graph playlist is stored in — and its listener is registered in
`_createSound` (Sound construction) while `AudioEndWatcher`'s is registered at play time, so
Foundry's always runs first.

The engine therefore issues **no stop of its own** on this path;
`_clearPlayingFlagAfterNaturalEnd()` feature-detects `parent._onSoundEnd` (plus `parent.isOwner`,
which is exactly what `_onEnd` itself checks) and falls back to `_stopTrackTracked()` only when the
parent can't be relied on. Until 2026-08 it always stopped, which was a second, byte-for-byte
redundant document update — a full server round-trip sitting inside the audible seam, and the
largest single contributor to the gap between two graph tracks.

The same-sound ordering hazard `_pendingStops` exists for cannot arise here: the only stop is
Foundry's, and it was issued strictly *before* the watcher callback ran, so it can never land after
the restart. Every **other** stop site — `_scheduleLoopStop`, `_scheduleConditionalExit`,
`_beginCrossfadeHandoff`, `stop()` — stops a sound that never fires `'end'` at all (native `repeat`
is on, or the stop is manual), Foundry writes nothing for those, and `_stopTrackTracked` stays
mandatory.

Historical note, kept because it is easy to re-derive wrongly: this page used to state that the
engine's stop was necessary because *"nothing else does this when audio ends on its own"*. That was
never true for a `PlaylistSound` inside a `Playlist`. What follows describes the flag's importance,
which is unchanged — the flag is persisted in the world, so leaving it set means every
naturally-finished track is **resurrected on the next page refresh**, playing over whatever the
graph starts fresh.

Where the engine does still stop a track itself, that stop is **not awaited** — see *Hand-off
latency* below for the ordering guarantee that replaced the await.

### Hand-off latency

Everything between one track's last sample and the next one's first sample is audible dead air.
Three costs used to sit on that path unconditionally, and each is now avoided in the common case:

| Cost | Avoided by |
|---|---|
| Awaiting the outgoing `stopTrack()` — a full document round-trip | `_stopTrackTracked()` records the in-flight stop in `_pendingStops` (`soundId → Promise`) instead of awaiting it. Only `_enterTrack` waits, and only on a pending stop for **the sound it is about to start**. |
| `sound.update({ pausedTime: 0, repeat })` — a second round-trip, fired even when both fields already meant those values | Skipped when the document already matches. **Compare `pausedTime` as `?? 0`, never against `0`:** Foundry's `Playlist#stopSound` writes `pausedTime: null`, and `PlaylistSound#sync` reads a falsy `pausedTime` as "no offset" — so `null` already means "start from the beginning". Comparing against `0` made the guard true for every track that had ever been stopped, i.e. every hand-off in a chain, and the skip never fired at all (measured live: a steady ~30 ms update on every transition, half the total gap). |
| Fetching + decoding the next track's file, which Foundry only begins after `playSound()` resolves | `_preloadUpcoming()` warms it during the *current* track's playback, via the pure `findUpcomingTrackNodes()` lookahead. |
| A **second, redundant** `stopSound()` for the track that just ended — Foundry had already written the identical change | Dropped entirely; see *On natural end* above. This was the single largest contributor. |
| `playSound()`'s own round-trip, which the incoming audio waits on | **Predictive arming** — the next track is started locally on the audio clock at the seam, with its document update sent ahead of it. See below. |

`_stopTrackTracked()` preserves exactly the ordering the old blanket await provided: starting a
sound whose stop hasn't landed yet lets the stop land last and silence a track the engine believes
is playing (the cross-engine form of the same race is described under *The stop-before-start race*).
The difference is that only a same-sound hand-off pays for it. Every stop site inside a run now
routes through it — including `_scheduleLoopStop` and `_scheduleConditionalExit`, which previously
had no protection at all. `stop()`'s own stops stay awaited: that race is cross-engine, and
`_pendingStops` is per-engine.

`findUpcomingTrackNodes(graph, nodeId)` (`custom-playback-schema.mjs`, pure) returns every Track
node reachable without passing through another Track first. It crosses the instantaneous types and
Delay, stops at Track/Playlist/End, and follows **every** branch of a Fork/Random/Condition — the
exit actually taken isn't knowable at lookahead time, and an extra warmed buffer costs a decode
while a wrong guess costs nothing. Preloading is fire-and-forget and fully defensive: a failure
degrades to a slower hand-off, never a broken one.

**Measuring it.** With `enableDebug` on, every clean Track start logs a latency breakdown —
`start latency Nms (stopWait=… throttle=… update=… play=…, preloaded=…)`. Each mark maps to one
of the costs above, so an audible gap can be attributed rather than guessed at.

Boundaries the engine **times itself** rather than reacting to an `'end'` event — a `count > 1`
track's stop, an `until`/`loopEnd` exit, the entry throttle — are scheduled `precise` (see
*Timing* below), so they land on their own due time instead of being rounded up to the next
ticker tick.

### Predictive arming — taking the round-trip off the seam

Even at one round-trip, the incoming track's audio can only start once the server has answered.
`_queueNextHandoff()` removes that from the audible path: it decides what plays next *before* the
seam and starts it on the browser's audio clock exactly at the seam.

```
_queueNextHandoff  →  _armHandoff  →  _commitArmedHandoff
                            ↘  _cancelArmedHandoff
```

- **`_queueNextHandoff(node, sound, elapsedMs, runId)`** — once the duration is probed, computes the
  seam and schedules the arm at `seam − _handoffLeadMs()`. Bails when a crossfade is configured (that
  mechanism owns the seam; two would double-hop the token) or when `planNextHandoff()` returns null.
  **Probes under its own clock key `'handoff'`** — `EngineClock` ids *replace* rather than stack, so
  sharing `_recordTrackTiming`'s `'timing'` key would make the two retry chains cancel each other.
- **`planNextHandoff(graph, fromNodeId, …)`** (`custom-playback-schema.mjs`, pure) walks forward,
  committing Random draws and evaluating Conditions ahead of time. It returns `null` — meaning "no
  plan, walk normally" — on a Fork, a Delay, a Playlist node, an End, a dangling edge, a target
  reusing the outgoing sound, or a target the caller reports busy.
- **`_armHandoff()`** calls `Sound#play({delay})` **first**, then issues the document update. That
  order is load-bearing: `play({delay})` sets the Sound to `STARTING` synchronously and
  `Sound#playing` is true for `STARTING`, so the `sync()` that runs when the update lands takes its
  already-playing branch instead of starting the track a second time (and `lead` ms early).
  Conversely `Sound#play` no-ops unless the state is `LOADED`/`PAUSED`/`STOPPED`, so a `sync()` that
  wins the race makes the arm a no-op. **The two are mutually idempotent in this order and only in
  this order.**
- **`_commitArmedHandoff()`** re-validates every Condition decision at the seam and discards the plan
  if any now resolves differently — this is what keeps H7 intact (see *invariants.md*). Then it
  replays the recorded route; `_enterTrack` takes an explicit **armed-adoption** branch that skips
  the start entirely because the audio and the update both already happened.
- **`_cancelArmedHandoff()`** stops the armed Sound (which cancels its pending `AudioTimeout`) and
  clears the persisted `playing` flag — an armed sound whose update landed but which never started
  would otherwise be resurrected on the next page load. Called from `stop()`,
  `refreshOverlayReactiveTargets()`, and on plan invalidation.

**Engine-timed seams are armed too** (`_tryArmTimedExit`). A `loop.mode: 'until'` track's escape is a
moment the *engine* picks, so there is no future boundary to work backwards from — the seam is placed
one lead into the future instead. The transition therefore lands 60–100 ms after the condition was
noticed, which is far below the 500 ms `UNTIL_POLL_INTERVAL_MS` jitter the detection already carries,
and in exchange the next track's round-trip leaves the seam entirely.

These were the last un-armed hand-offs — `_queueNextHandoff` runs only in the `loopCount === 1`
branch, which an `until` track returns before reaching — and they are the phase-change transitions,
i.e. the ones a listener most notices. *Measured live: 58 ms of silence at a phase change before this.*

Two things differ from a natural-end arm, and both are load-bearing:

- **`stopOutgoing`** — the outgoing track is being *cut* mid-loop. It plays on native `repeat`, so no
  `'end'` event is coming and `Playlist#_onSoundEnd` never runs. The engine stops it itself at the
  seam, **locally first** (`sound.sound.stop()`, immediate) and then by document; without the local
  stop both tracks stay audible together for a full round-trip.
- **`onDiscard`** — if the plan is invalidated at the seam, a natural-end arm can fall back on its
  `'end'` watcher. A timed exit has no watcher, so the caller's plain exit must run instead, or the
  token is stranded forever on a node whose escape condition has already matched. Silent and
  permanent.

`loop.count > 1` boundaries are still un-armed; their boundary *is* known in advance, so they can be
armed with no added delay at all, but that is not done yet.

**The lead is measured, not guessed** (`_handoffLeadMs()`, an EWMA over observed `playTrack`
round-trips, clamped to 60–500 ms). The hard constraint is Foundry's `PlaylistSound#_onStart`:
`if (!this.playing) return this.sound.stop()` — against the **document** field. If the update lands
after the seam, the armed start is killed and `sync()` starts the track normally when it does land,
which is exactly today's behaviour. Undershooting degrades; it does not break.

The `'end'` watcher stays armed throughout, as ground truth, exactly as it does for the crossfade.

**Cross-client:** remote clients start on the broadcast, so they begin roughly one one-way latency
*early* — a small overlap replacing a gap of the same order. That trade-off, and the alternative,
are recorded in `docs/gapless-handoff-plan.md` (O1).

### Fade is a separate artifact, and not one this engine can time away

A `PlaylistSound`'s effective fade is `sound.fade ?? playlist.fade ?? 0` — so setting **Fade once
on the playlist** applies it to every track in the graph. When it is non-zero, Foundry itself
(`PlaylistSound#_onStart` → `_scheduleFadeOut`) fades the track in from silence *and*, for any
non-repeating sound — i.e. every `count: 1` Track node — schedules a fade to zero starting
`fadeDuration` before the file ends.

A listener hears a dip before the seam and a ramp after it, which is indistinguishable from (and
stacks on top of) a gap, but originates entirely in the playlist's configuration. The engine
**reports** this once per sound per run at log level 2 rather than overriding it: `fade` is the
user's setting on their own document, and a graph is not necessarily the only way that playlist
gets played. For gapless graphs, set Fade to 0 on the playlist and on the sounds.

### Crossfade — hiding the residual instead of chasing it

Even with every avoidable cost removed, one is structural: `'end'` fires only after the outgoing
source has fully stopped, and the next track's audio starts only once Foundry's own `playSound()`
document update resolves. Measured live on a local server that residual is **~20–30 ms**, which is
still audible as a click between two tracks cut to run together.

The world `graphCrossfade` setting (ms, 0–1000, step 25, **default 0 = off**) hands off *early* by
that amount and fades the outgoing track out across the overlap, so the next track is already at
full volume when the previous one would have ended — there is no instant of silence left to hear.

**Per-playlist override.** A graph can override the world setting for itself via `crossfadeMs` on
the `CustomGraph` (`custom-playback-schema.mjs`), set from the editor's Palette pane ("Crossfade
(ms)", next to the preset picker — a graph-level control, not a per-node one, since the crossfade
is a property of the hand-off itself and every Track node in the graph shares it). Always read
through `resolveGraphCrossfadeMs(graph)`, never the field directly:

- **absent/`null`** — no override, defer to the world setting;
- **`0`** — explicitly disable crossfade for this playlist, even if the world setting is non-zero;
- **any other non-negative number** — override outright, in either direction (can be larger *or*
  smaller than the world default).

`_crossfadeMs()` on `CustomPlaybackEngine` checks the override first and only falls through to the
world setting when it's `null`. Because it reads `this.graph` — the graph *this engine instance* is
running — a Playlist node's child engine naturally picks up the target playlist's own override, not
the root's; nesting requires no special handling.

Drawflow's export/import shape has no representation for a graph-level field (only whole-node
`data` round-trips — see `graph-drawflow-bridge.mjs`'s own doc comment). `_syncFromDrawflow()` in
`custom-playlist-editor.mjs`, which rebuilds `this.graph` from a live Drawflow export after nearly
every node mutation and again right before Save, carries `crossfadeMs` across by hand rather than
losing it to the rebuild — the exact class of bug the schema-union round-trip lesson warns about.

Implemented by `_scheduleCrossfadeHandoff()` (natural-end path) and inside `_scheduleLoopStop()`
(timed `count > 1` boundary), both landing in the shared `_beginCrossfadeHandoff()`.

Four things about it are deliberate:

- **Only the outgoing track fades; the incoming one starts at full volume.** Graph tracks are
  typically cut to continue from one another, so fading the new one *in* would introduce exactly
  the dip this removes. It is an overlap, not an equal-power crossfade between unrelated pieces.
- **The `'end'` watcher stays armed.** The schedule is a wall-clock estimate from a probed
  duration; the watcher is ground truth. If the estimate is late, the probe fails, or the track
  ends early, the watcher advances as it does today. Whichever fires first retires the node;
  `_beginCrossfadeHandoff` disarms the watcher so the token can't double-hop.
- **Skipped when the next track reuses the same sound**, or when the track is shorter than the
  crossfade. One `Sound` cannot play two positions at once, and a track with no room to overlap
  would be cut off almost as soon as it began. Both fall back to the plain path.
- **A sound left mid-fade is tracked in `_fadingOutSounds`.** Its node is released the instant the
  overlap begins, so it is no longer reachable through `_activeNodes` — and `stop()` must still
  clear its persisted `playing` flag, or a teardown mid-fade resurrects it on the next page load.
  `activeSounds` includes it for the same reason.

### What was considered and deliberately not done

- **Merging `sound.update(...)` and `playSound()` into one round-trip.** Verified against the v14
  client: `Playlist#playSound` branches on the playlist's `mode`, and for `SEQUENTIAL`/`SHUFFLE`
  it rewrites *every* sound's `playing`/`pausedTime`, not just the target's. A custom graph's own
  playlist is always `UNSEQUENCED` (H1), where the branch is trivial — but a Playlist node's child
  engine runs over **native-mode** playlists too, which are exactly the modes with the non-trivial
  branch. Hand-rolling the update would duplicate mode-dependent Foundry logic for one round-trip
  that Stage 1's skip already avoids in the common case. Not worth it.
- **Pre-arming the next node's document work before the boundary.** Only pays off when the next
  track needs a `repeat`/`pausedTime` change, which the skip above already makes rare, and it has
  to carefully avoid touching a sound that is currently playing (`sync()` applies a live `loop`
  change to a playing sound). Superseded by the crossfade, which hides the residual wholesale
  rather than shaving one contributor off it.

### The one remaining lever

`playSound()`'s round-trip is still on the audible path: the audio starts only once the document
update resolves. It could be removed by starting the raw `sound.sound` directly and letting the
document update follow for bookkeeping — verified safe against double-starting, because `sync()`
returns early for an already-playing sound (it only re-applies volume) rather than restarting it.

That is **not implemented**: it would put the head GM's audio one round-trip ahead of every other
client, which is a cross-client behaviour change rather than a timing fix, and deserves an explicit
decision (and probably a setting) rather than being smuggled in as an optimisation. With the
crossfade available it is also largely moot — the overlap absorbs a round-trip's worth of jitter
by design.

### `_scheduleLoopStop()`

Polls at 100 ms until the sound reports a loaded duration, then schedules a stop at
`loopCount × duration × 1000 − elapsedMs`. After `MAX_DURATION_PROBE_ATTEMPTS` it gives up and
advances rather than polling forever with the token stuck and no further log line — a missing
file, network error, or decode failure would otherwise hang the graph silently.

Shares its duration-probe loop with `_scheduleConditionalExit()` below, factored out as
`_probeDuration(node, sound, runId, onReady, onGiveUp)` — same 100 ms cadence, same
`MAX_DURATION_PROBE_ATTEMPTS` cap, but each caller handles a probe failure differently (see
below for why).

### `_scheduleConditionalExit()` — `loop.mode: 'until'`

Both boundaries poll `loop.condition` via `_evaluateCondition()` — the same evaluator a
Condition node's exits use — on `EngineClock`'s cadence (`UNTIL_POLL_INTERVAL_MS`, 500 ms), and
both enforce `minLoops`/`maxLoops` as a **wall-clock floor/cap**: `minLoops × duration` and
`maxLoops × duration` from the node's own entry time, exactly one loop-length granular whether or
not the boundary itself is `loopEnd`.

- **`boundary: 'immediate'`** — checks the condition on every poll tick once past the `minLoops`
  floor, exiting the instant it matches. **Always probes the duration first**, even though
  `minLoops` defaults to 1 — a floor of "at least 1 loop" is meaningless without knowing how long
  one loop actually is. An earlier version special-cased `minLoops <= 1` to skip the probe and
  use an earliest-exit time of the node's own entry (0 loops); since 1 is `minLoops`' own default,
  that silently reproduced the exact zero-length, condition-already-true-on-entry glitch
  `minLoops` exists to prevent, on every `until` track using default settings. Fixed before
  shipping — flagged here because it is exactly the kind of silent, no-console-error failure this
  whole page exists to warn about.
- **`boundary: 'loopEnd'`** — computes each upcoming loop-boundary timestamp as
  `startedAt + N × duration × 1000` from the probed duration (never `sound.sound.currentTime` —
  same H3 rationale as `_scheduleLoopStop`) and checks the condition **only** there, so the exit
  always lands on a clean loop edge instead of cutting the track off mid-loop.
- **Probe failure degrades, never hangs, but the two boundaries degrade differently.**
  `boundary: 'immediate'` drops `minLoops`/`maxLoops` and polls the (already-known-true-or-false)
  condition unrestricted from now — the floor/cap is a refinement it can live without.
  `boundary: 'loopEnd'` has no wall-clock boundary to compute at all without a duration, so it
  falls back to `immediate`-style unrestricted polling instead — a coarser wait, not a hang.

`_evaluateCondition()`'s polling here is **not** a violation of H7 — see that entry's own note.

### Delay

Singleton-checked. Waits `min + rng() × (max − min)` seconds via `EngineClock`, records
`durationMs`/`startedAt` (so the editor can draw a countdown that resumes correctly if the window
opens mid-wait), then releases and advances in one `_walk()`.

### Fork

Spawns a token on **every** outgoing edge concurrently via `Promise.all`. Convergence is resolved
by the singleton rule.

### Random

Weighted draw among edges not in cooldown.

- An edge's `cooldown` means "at least N other picks before reuse", checked against a per-node
  history capped at `MAX_COOLDOWN_HISTORY` (32).
- If *every* edge is cooling down, cooldowns are ignored for that draw rather than deadlocking.
- `avoidRepeat` dedups by **target node, not by edge** — two different exits routed to the same
  node should both be excluded, not just the exact edge last used. It falls back to allowing a
  repeat only if every remaining candidate also targets that node.
- **All weights zero → uniform pick.** A weighted draw against zero total weight would always
  fall through to the last candidate (`roll` is always 0, and `0 < 0` never matches), silently
  picking one fixed exit instead of the "off" behavior a user zeroing every weight expects.

### Condition

Follows the **first** edge whose condition matches, evaluated when the token arrives (H7). No
match and no `default` edge → the token terminates.

---

## Playlist nodes

A Playlist node plays **another playlist by that playlist's own rules.** Folded from
`docs/playlist-node-plan.md` (D1–D8), which remains the archived source of record.

### What a "pass" is

One pass = one complete run of a **child `CustomPlaybackEngine`** over a graph derived from the
target:

- target **has** a stored graph → run that graph verbatim;
- target has **no** graph → synthesize a one-pass graph from its native Foundry mode
  (`native-mode-graph.mjs`).

A pass **completes when the child engine goes idle.** Many graphs never complete — a `forever`
Track, a shuffle loop — and the Playlist node then holds its token forever, exactly like a
`forever` Track (H12).

**A graph built around a `loop.mode: 'until'` Track does complete a pass**, once that track's
condition matches — H12 again: an `until` track's "holds its token forever" property is
conditional, not absolute, so a child engine built around one can now genuinely go idle where an
equivalent graph using `forever` never would.

`loop` mirrors Track exactly (`count`/`forever`; `until` is Track-only), counting **passes**
instead of native loops.

### Native mode → one-pass graph

| Target mode | Synthesized graph |
|---|---|
| `SEQUENTIAL` (0) | Start → Track(each, in `playbackOrder`) → … → End |
| `SHUFFLE` (1) | as above, over a **shuffled copy** |
| `SIMULTANEOUS` (2) | Start → Fork → one finite Track per sound → one shared End |
| `UNSEQUENCED` (−1), no graph | same as `SEQUENTIAL`, plus an editor warning (V9) |
| no sounds | Start → End — completes instantly (the entry throttle bounds it) |

`SIMULTANEOUS` with exactly one sound emits Start → Track → End with **no Fork** (a one-exit Fork
is degenerate). Every synthesized Track defaults to `loop: { mode: 'count', count: 1 }` —
repetition is the *parent* node's job.

Because the graph is re-synthesized **per pass**, a `SHUFFLE` target genuinely reshuffles each
time.

> **Foundry keeps driving a native target underneath the child engine.** For a `SEQUENTIAL`/`SHUFFLE`
> playlist, `Playlist#_onSoundEnd` runs `playNext()` on every natural end — so Foundry starts the
> next native track *while the child engine advances its own synthesized graph*. The synthesized
> graph mirrors `playbackOrder`, so the two normally agree, and the singleton and sound-owner checks
> absorb the rest. It is still an unmanaged write racing the engine, and worth knowing about before
> debugging anything odd in a nested native playlist. (For the `UNSEQUENCED` mode a graph playlist
> itself uses, the same handler only clears flags — which is what *On natural end* above relies on.)

### References

```js
{ source: 'direct',  playlistId }
{ source: 'scene'|'default', section: 'area'|'combat',
  overlayMode: 'active'|'none'|'specific', overlayId? }
```

The referenced **section** (`area`/`combat`) decides which overlay axis applies —
`CONST.sectionAxis` maps `area → mood`, `combat → phase` (see [architecture.md](architecture.md)
§ *Overlay axes*) — so the inspector's overlay dropdown repopulates from moods or phases
depending on the ref's own selected section, clearing a now-invalid `overlayId` if the section
changes.

| `overlayMode` | Resolves to |
|---|---|
| `'none'` | `section.playlist` — the base playlist, ignoring the axis entirely |
| `'active'` | `section.overlays[activeOverlayId].playlist ?? section.playlist` |
| `'specific'` | `section.overlays[overlayId].playlist` — **no fallback**, null if unset |

`'active'` deliberately mirrors `PlaylistContext._extractSectionConfig()`'s own lookup, so an
indirect reference resolves to the same playlist the module itself would pick right now.
`'specific'` has no fallback on purpose — an unset override resolves to nothing rather than
silently picking something else (validation warns about that shape at edit time).

The pure resolution logic lives in `playlist-ref.mjs` (Foundry-free) —
`resolvePlaylistRefId(ref, { sceneSections, defaultSections, activeOverlayIds })` takes **both**
axes' active ids at once (`{ mood, phase }`) and picks by the ref's own section.
`helpers.mjs#resolvePlaylistRef` reads both live settings and delegates.

### Cycles, recursion, collisions — the shared registry

**One mechanism covers all three.** A `Set` of playlist ids, created by the root engine (seeded
with its own id, since it is itself in flight) and passed **by reference** into every child.

Entering a Playlist node is refused when:

1. the resolved target is already in the registry — self-reference, an A→B→A cycle, or two Fork
   branches both targeting the same playlist;
2. nesting would exceed `MAX_PLAYLIST_NESTING_DEPTH` (4);
3. the reference resolves to nothing (unset scene flag, missing mood override, deleted playlist).

An entry is added when the node starts its first pass and removed when it releases its token.
Always release via `_releasePlaylistNode()` — a leaked registry entry makes that playlist
**permanently unreferenceable by any Playlist node for the rest of the session.**

### Refusal is a zero-length pass, not a dead end

A refused or unresolvable node logs at level 2, does **not** hold the token, and follows its exit
immediately. Terminating instead would leave a graph permanently silent because a GM forgot to
set one scene's mood override — too harsh.

To keep "follow immediately" from becoming a runaway when the exit cycles back, entering a
Playlist node is rate-limited by the **same 300 ms floor Track uses** and counted by the **same
circuit breaker**. The floor applies between passes too.

A `loop.mode: 'forever'` node has no exit to follow and simply terminates on refusal — it holds
its token forever once it *does* start, so a refusal that can never be retried is the only other
option.

### Overlay-reactive refresh — the one exception to H7

`refreshOverlayReactiveTargets()` is called by `transitionToContext()` when a re-resolution leaves
the **root** playlist unchanged (so the top-level restart is skipped).

Without it, a Playlist node reading *"this scene's area playlist for whatever mood is active right
now"* (or the combat/phase equivalent) would only re-resolve the next time its own token happened
to re-enter it — or never, for a non-looping graph — even though that is the entire point of
`overlayMode: 'active'`.

Scope is deliberately narrow:

- **Active nodes only.** A node not currently holding a token already resolves fresh state the
  next time it is entered; there is nothing to catch up.
- **Indirect + `overlayMode: 'active'` only** — on either axis. A node referencing the `area`
  section reacts to mood changes; one referencing `combat` reacts to phase changes.
- **Depth-first into every child**, regardless of whether *that* engine's own node is
  overlay-reactive — the reactive node can be anywhere in the subtree.

A swap stops and discards the old child, then starts a fresh pass **from pass 1** over the new
target. If the newly-resolved target is already in flight, it degrades to the same zero-length-pass
refusal.

---

## The stop-before-start race

**`stop()` is async and must be awaited by any caller that starts a replacement engine.** This is
a real, reproducing bug, not a hypothetical.

`controller.stopTrack()`'s underlying Foundry `stopSound()` call is genuinely async, and a caller
that immediately starts a replacement (`onCustomGraphChanged`, on Save) does so with no yield in
between. If a node in the **new** engine references the **same `soundId`** a node in the old one
is being told to stop — two Track nodes sharing a sound is not unusual — its `alreadyPlaying`
check reads the stale pre-stop state and **adopts a sound that is about to be forcibly stopped.**

Adopting attaches a watcher for a natural `'end'`. The pending stop then lands and fires
`'stop'` instead, which `AudioEndWatcher` deliberately never treats as "advance". The token sits
forever waiting for an `'end'` that is never coming. Silent, no further logs.

The same ordering requirement applies in `_onPassComplete()` (before the next pass or the exit)
and in `_swapPlaylistNodeTarget()`.

`stop()` also **queues child stops synchronously** before awaiting, so every `stopTrack()` call in
the whole tree happens in one synchronous pass. Several call sites — the circuit breaker among
them — call `stop()` without awaiting and expect the stops to have already landed.

---

## Timing — `EngineClock`

Every wait the engine schedules goes through `EngineClock`, never a bare `setTimeout`. See H4.

- Absolute due-timestamps, polled by a dedicated `Worker` at `TICK_MS` (**100 ms**); main-thread
  interval fallback.
- `schedule(id, delayMs, cb)` — re-scheduling the same id **replaces** it.
- `schedule(id, delayMs, cb, { precise: true })` — additionally arms a main-thread `setTimeout`
  for the exact delay. First of the two to fire wins; the loser finds the entry already retired.
  Use it for a boundary a listener can *hear* being missed; not for routine polling.
- A throwing callback is caught and logged: this is the one component the whole engine depends on
  for timing, so one bad callback must not stall every other scheduled node.
- `destroy()` terminates the worker and clears everything, companion timers included.

The tick was 500 ms, which put 0–500 ms of silence at every boundary the engine times itself, and
made `_probeDuration`'s nominal *"100 ms cadence, ~2 s cap"* actually run at 500 ms and ~10 s —
each retry waited a whole tick. `UNTIL_POLL_INTERVAL_MS` (500 ms) used to be justified by matching
the tick; it is now an independent choice about how responsive an `immediate` until-loop should be.

`precise` does **not** reintroduce the background-tab problem H4 describes. A throttled
`setTimeout` simply fires late and loses the race to the worker tick, which is unaffected — the
companion timer can only make an entry land sooner, and never sooner than its due time.

> The blob URL backing the Worker is revoked immediately after construction — the Worker has
> already opened its own reference. Without this, every engine instance (a fresh one per
> transition) leaked one object URL and its backing blob for the page's lifetime.

---

## Activity broadcast

`_emitActivity()` fires the `gameOrchestraGraphActivity` hook on every node hop, carrying
`{ playlistId, runId, activeNodeIds, activeTimings, enteredNodeId, traversedEdgeIds }`.

- **Fire-and-forget and non-fatal.** `Hooks.callAll()` runs listeners synchronously, so an
  exception from one would otherwise propagate straight into the token walk and silently stop
  playback. Highlighting is cosmetic; it must never be able to break audio.
- Emitted at **chokepoints** — `_enterNodeInner` and `_followSingleExit` — so every transition of
  every kind is covered without a call at each individual site. Durational nodes emit again once
  registered as active.
- Child engines emit with their **own** `playlistId`, so an editor open on a nested playlist
  lights up for free. No sockets, no new hooks.
- `activityState` is the same snapshot on demand, for priming an editor window opened mid-playback.

`activeTimings` is how long each timed node runs and when it started — a Delay's wait, and a
Track's single pass through its sound (`_recordTrackTiming`). Each entry carries `iterations`:
1 for a Delay, the loop count for a fixed-count Track, and **null** for one that repeats until
something stops it (`forever`/`until`). The editor turns these into drain overlays — see
[editor.md](editor.md).

> **`_recordTrackTiming` probes for duration under its own clock key** (`<nodeId>:timing`, versus
> `<nodeId>:probe` for exit scheduling). It has to probe at all because two of the three loop modes
> never do otherwise — a `forever` Track has no exit to schedule, and a single-play one only probes
> when the crossfade is on. It has to use a *different key* because `EngineClock` ids replace
> rather than stack: under one key the two retry chains overwrite each other every tick, whichever
> loses never fires again, and a loop-counted track then silently never advances. That is the one
> thing to preserve if `_probeDuration` is ever refactored.
