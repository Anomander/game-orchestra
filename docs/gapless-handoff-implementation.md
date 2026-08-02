# Gapless hand-off — implementation plan

**Companion to [gapless-handoff-plan.md](gapless-handoff-plan.md), which is the diagnosis and the
rationale. Read Part 1 of that document before starting; this one is the executable steps.**

Written 2026-08-01. Status: **ready to execute.**

---

## 0. How to work

### 0.1 Hard rules

1. **Run `npm test` after every task.** Baseline is **1170 tests, 28 files, all passing**. A task is
   not done until the suite is green and the count has only gone *up*.
2. **`node --check <file>`** after editing any `scripts/*.mjs`. There is no build step; a syntax error
   ships straight to the browser.
3. **Never delete or reword an existing comment** to make room for a change. This codebase's comments
   record live-confirmed bugs. If you change code a comment guards, *update* the comment to match and
   keep the failure it describes. If a comment turns out to be wrong, say so in the comment rather
   than deleting the history (Task 1.3 does exactly this).
4. **JSDoc every new export and every new method**, matching the density of the surrounding code.
5. **Do not call `this.render()` anywhere in editor code.** Not relevant to these tasks, but it is the
   rule most easily broken by accident.
6. **Add no user-facing strings.** If you think you need one, you have gone outside this plan — stop
   and report. (New strings would require updating both `lang/en.json` *and* `lang/pt-BR.json`, which
   `tests/lang.test.mjs` enforces in both directions.)
7. **Log levels:** `log(1, …)` error, `log(2, …)` warn, `log(3, …)` debug. On anything that runs per
   hand-off, pass a **thunk**: ``log(3, () => `…`)``.
8. **Stop and report if a step's precondition doesn't hold** — if an anchor snippet isn't found
   verbatim, or a test fails in a way this plan doesn't predict. Do not improvise a different design.

### 0.2 Order

Stage 1 and Stage 2 are independent deliverables. **Complete, test, and stop after Stage 1.** Stage 1
alone is expected to remove roughly two thirds of the hand-off gap and is low-risk. Stage 2 is larger
and should be reviewed separately.

### 0.3 Anchors

Line numbers in this plan are **hints only** — they shift as you edit. Locate code by the quoted
*anchor snippet*, which is verbatim from the current file.

---

## Stage 1 — Remove the redundant stop round-trip

**What and why (short version):** on a natural track end, the engine calls `stopTrack()` to clear the
`PlaylistSound` document's `playing` flag. Foundry's own `Playlist#_onSoundEnd` already wrote that
exact change moments earlier, and its listener always runs first. The engine's call is a second,
byte-for-byte redundant server round-trip sitting directly in the audible seam. See D3/D4 in the
diagnosis document.

### Task 1.1 — Add `_clearPlayingFlagAfterNaturalEnd()`

**File:** `scripts/custom-playback-engine.mjs`

Add this method **immediately after `_stopTrackTracked()`** (anchor: the line
`    return promise;` followed by `  }` that closes `_stopTrackTracked`).

```js
  /**
   * Clear a naturally-finished track's persisted `playing` flag - but only when
   * Foundry isn't already doing it for us.
   *
   * When a PlaylistSound's audio ends on its own, Foundry dispatches 'end' on
   * the Sound, and PlaylistSound#_onEnd forwards it to Playlist#_onSoundEnd,
   * which writes `{playing: false, pausedTime: null}` for that sound in EVERY
   * playlist mode - including UNSEQUENCED/DISABLED (-1), which is the mode a
   * custom-graph playlist is stored in (H1). Its listener is registered in
   * PlaylistSound#_createSound, i.e. at Sound-construction time, while
   * AudioEndWatcher registers at play time - and Foundry's EventEmitterMixin
   * dispatches listeners in registration order. So Foundry's write is ALWAYS
   * already in flight by the time this engine's watcher callback runs.
   *
   * Issuing our own stopSound() on top of it was therefore a second, identical
   * document update - a full server round-trip sitting directly between the
   * outgoing track's last sample and the incoming track's first one, on every
   * single hand-off. Measured as roughly two thirds of the audible gap.
   *
   * This is ONLY safe on the natural-end path. Every other stop site in this
   * engine (_scheduleLoopStop, _scheduleConditionalExit, _beginCrossfadeHandoff,
   * stop()) stops a sound that never fires 'end' at all - either native `repeat`
   * is on, or the stop is manual, and 'stop' is deliberately never treated as
   * "finished" (see AudioEndWatcher's class doc). Foundry writes nothing for
   * those, so _stopTrackTracked() stays mandatory there. Do not "simplify" this
   * by routing the other call sites through it.
   *
   * The fallback still runs when the parent can't be relied on: a
   * non-Playlist/mocked parent, or a client that doesn't own the playlist (which
   * is exactly the check PlaylistSound#_onEnd makes before doing anything).
   * @param {object} sound - PlaylistSound document that just ended naturally.
   * @private
   */
  _clearPlayingFlagAfterNaturalEnd(sound) {
    const parent = sound?.parent;
    const foundryWillClearIt = typeof parent?._onSoundEnd === 'function' && parent.isOwner !== false;
    if (foundryWillClearIt) {
      log(3, () => `CustomPlaybackEngine: leaving sound '${sound?.id}' playing-flag cleanup to Playlist#_onSoundEnd.`);
      return;
    }
    this._stopTrackTracked(sound);
  }
```

### Task 1.2 — Call it from the natural-end path

**File:** `scripts/custom-playback-engine.mjs`, inside `_enterTrack`'s `loopCount === 1` branch.

**Anchor** (inside `this.watcher.watch(sound, async () => {`):

```js
        this._stopTrackTracked(sound);
        // The release and the follow-up hop happen inside ONE tracked walk -
```

Replace **only** the `this._stopTrackTracked(sound);` line with:

```js
        this._clearPlayingFlagAfterNaturalEnd(sound);
```

Then **rewrite the block comment directly above it.** It currently begins `// Clear the PlaylistSound
*document's* \`playing\` flag, which nothing else does` and ends `...before the next track can begin.`
That claim is now known to be wrong (see D4). Replace the whole comment with:

```js
        // Clear the PlaylistSound *document's* `playing` flag. That flag is
        // persisted in the world, and Foundry restores playback for every sound
        // still marked playing when a client loads - so leaving it set means
        // each naturally-finished track is resurrected on the next page
        // refresh, playing over whatever the graph starts fresh.
        //
        // This comment used to claim "nothing else does this when audio ends on
        // its own". That was wrong: Foundry's own Playlist#_onSoundEnd writes
        // exactly this change first, on every mode including the UNSEQUENCED one
        // a graph playlist uses. Our duplicate was a whole extra server
        // round-trip inside the audible seam. See
        // _clearPlayingFlagAfterNaturalEnd, which now decides whether we need to
        // write anything at all.
```

**Do not touch** the `NOT awaited before advancing` paragraph that follows, or the `_walk` call. The
`_pendingStops` ordering guarantee it describes is still exactly right for the timed paths.

### Task 1.3 — Teach the mocks about `_onSoundEnd`

**File:** `tests/mocks/foundry.mjs`, inside `createMockPlaylist`.

**Anchor:**

```js
  for (const sound of sounds) {
    sound.parent = Object.assign(sound.parent || {}, { id, name });
```

Change the assigned object to model the two fields the engine now feature-detects, plus the behaviour
Foundry actually performs, so tests exercise the real branch rather than the fallback:

```js
  // Models the part of Playlist#_onSoundEnd the engine now relies on: when a
  // sound ends naturally, Foundry itself writes {playing: false, pausedTime:
  // null} for it, in every playlist mode. CustomPlaybackEngine feature-detects
  // _onSoundEnd (plus isOwner) to decide whether it still needs to issue its own
  // stopSound() - without these here, every test would silently take the
  // fallback path and the change under test would never actually run.
  for (const sound of sounds) {
    sound.parent = Object.assign(sound.parent || {}, {
      id,
      name,
      mode,
      isOwner: true,
      _onSoundEnd: vi.fn((ended) => {
        ended.playing = false;
        ended.pausedTime = null;
        return Promise.resolve(playlist);
      })
    });
```

Leave the rest of the loop body (`sound.uuid = …`) and its existing comment unchanged.

### Task 1.4 — Make `fireEnd` model Foundry's write, and add tests

**File:** `tests/custom-playback-engine.test.mjs`

**1.4a.** Update the `fireEnd` helper so it performs the write Foundry performs, before dispatching:

**Anchor:**

```js
async function fireEnd(sound) {
  sound.playing = false;
  sound.sound.playing = false;
  sound.sound.dispatchEvent(new Event('end'));
```

Replace the body with:

```js
async function fireEnd(sound) {
  sound.sound.playing = false;
  // Foundry's own listener (registered in PlaylistSound#_createSound, so always
  // BEFORE AudioEndWatcher's) runs Playlist#_onSoundEnd first and writes the
  // document flags. Modeling that ordering is the whole point of this helper -
  // the engine now relies on it instead of issuing a duplicate stopSound().
  sound.parent?._onSoundEnd?.(sound);
  sound.playing = false;
  sound.sound.dispatchEvent(new Event('end'));
```

Keep the existing microtask-drain loop and the existing doc comment above the function, but append a
sentence noting that the helper now also models Foundry's own `_onSoundEnd` write.

**1.4b.** Add a new `describe('natural-end hand-off cost', …)` block with these tests:

| Test | Assertion |
|---|---|
| does not issue its own stop when the playlist will clear the flag itself | Two-track chain `t1 → t2`; after `fireEnd(s1)`, `controller.stopTrack` has **not** been called with `s1`, and `s1.playing === false`. |
| still issues its own stop when the parent cannot clear the flag | Delete `_onSoundEnd` from `s1.parent` before firing; assert `controller.stopTrack` **was** called with `s1`. |
| still issues its own stop when the client does not own the playlist | Set `s1.parent.isOwner = false`; assert `controller.stopTrack` **was** called with `s1`. |
| still stops a looping track at its timed boundary | `loop: {mode:'count', count:2}`; advance the clock past the boundary; assert `controller.stopTrack` **was** called (this is the path that must not regress). |
| still stops on engine teardown | Start a graph, call `await engine.stop()`, assert `controller.stopTrack` was called for the active sound. |

**Gate:** `npm test` green, count increased by 5. **Stop here and report.** Do not begin Stage 2 in the
same change.

---

## Stage 2 — Predictive queueing and audio-clock arming

**What and why:** even at one round-trip, the incoming track's audio can only start after a server
response. Stage 2 decides the next track *before* the seam, starts it on the browser's audio clock at
exactly the seam, and issues the document update early so it has landed by then. See Parts 2–3 of the
diagnosis document. The mechanism is `Sound#play({delay})`, which is audio-clock scheduled
(`AudioTimeout`), cancellable, and idempotent with Foundry's own `sync()`.

### Task 2.1 — Extract the Random pick into a pure function

Both the live walk and the planner must make the *same* draw. Two copies of this logic would drift;
extract one.

**File:** `scripts/custom-playback-schema.mjs`

Add, after `findUpcomingTrackNodes`:

```js
/**
 * Choose one outgoing edge for a Random node: a weighted draw among the edges
 * not currently in cooldown, honouring `avoidRepeat`.
 *
 * Pure, and deliberately does NOT mutate the history it is given - it returns
 * the updated history for the caller to store. That is what lets the predictive
 * lookahead (CustomPlaybackEngine#_queueNextHandoff) make the draw ahead of time
 * and commit its effect on the cooldown history only if the plan is actually
 * used, while the live walk (_enterRandom) commits immediately. Both go through
 * here so the two can never disagree about which exit a given roll picks.
 * @param {GraphNode} node - The Random node.
 * @param {GraphEdge[]} edges - Its outgoing edges, in graph order.
 * @param {string[]} history - Most-recent-first edge ids previously picked at this node.
 * @param {() => number} rng - Random source in [0, 1).
 * @param {number} maxHistory - Cap on the returned history length.
 * @returns {{edge: GraphEdge, history: string[], eligible: number, allWeightsZero: boolean}|null}
 *   null only when the node has no outgoing edges at all.
 */
export function pickRandomExit(node, edges, history, rng, maxHistory) {
  if (!Array.isArray(edges) || edges.length === 0) return null;

  let candidates = edges.filter((edge) => {
    const cooldown = edge.cooldown || 0;
    if (cooldown <= 0) return true;
    const lastPickedAt = history.indexOf(edge.id);
    return lastPickedAt === -1 || lastPickedAt >= cooldown;
  });
  if (node.avoidRepeat && history.length > 0) {
    // Dedup by TARGET node, not by edge - two different exits routed to the
    // same node should both be excluded, not just the exact edge last used.
    const lastTarget = edges.find((e) => e.id === history[0])?.to;
    if (lastTarget != null) {
      const withoutLastTarget = candidates.filter((edge) => edge.to !== lastTarget);
      if (withoutLastTarget.length > 0) candidates = withoutLastTarget;
    }
  }
  if (candidates.length === 0) candidates = edges;

  const totalWeight = candidates.reduce((sum, edge) => sum + Math.max(0, edge.weight ?? 1), 0);
  const allWeightsZero = totalWeight <= 0;
  let chosen;
  if (allWeightsZero) {
    // A weighted draw against zero total weight would always fall through to the
    // last candidate (roll is always 0, and `0 < 0` never matches), silently
    // picking one fixed exit instead of the "off"/uniform behavior a user
    // zeroing every weight would expect. Pick uniformly instead.
    chosen = candidates[Math.floor(rng() * candidates.length)];
  } else {
    let roll = rng() * totalWeight;
    chosen = candidates[candidates.length - 1];
    for (const edge of candidates) {
      const weight = Math.max(0, edge.weight ?? 1);
      if (roll < weight) {
        chosen = edge;
        break;
      }
      roll -= weight;
    }
  }

  return { edge: chosen, history: [chosen.id, ...history].slice(0, maxHistory), eligible: candidates.length, allWeightsZero };
}
```

**File:** `scripts/custom-playback-engine.mjs` — rewrite `_enterRandom`'s body to delegate, keeping
its existing logging exactly:

```js
  async _enterRandom(node, depth) {
    const edges = this.graph.edges.filter((e) => e.from === node.id);
    const pick = pickRandomExit(node, edges, this._recentPicks.get(node.id) || [], this._rng, MAX_COOLDOWN_HISTORY);
    if (!pick) return;
    if (pick.allWeightsZero) {
      log(2, `CustomPlaybackEngine: random '${node.id}' has every candidate exit weighted 0 - picking uniformly instead of always following the same one.`);
    }
    this._recentPicks.set(node.id, pick.history);
    log(3, `CustomPlaybackEngine: random '${node.id}' -> '${pick.edge.to}' (weight ${pick.edge.weight ?? 1}, ${pick.eligible}/${edges.length} candidates eligible)`);
    this._emitActivity({ traversedEdgeIds: [pick.edge.id] });
    return this._enterNode(pick.edge.to, depth + 1);
  }
```

Add `pickRandomExit` to the existing import from `./custom-playback-schema.mjs` at the top of the file.

**Gate:** `npm test` green with no count change. This is a pure refactor — every existing Random test
must still pass untouched. If any fails, you have changed behaviour; revert and report.

### Task 2.2 — The planner

**File:** `scripts/custom-playback-schema.mjs`. Add after `pickRandomExit`.

```js
/**
 * Hop cap for planNextHandoff()'s forward walk, matching findUpcomingTrackNodes'.
 */
const MAX_PLAN_HOPS = 32;

/**
 * @typedef {object} HandoffPlan
 * @property {string} nodeId       The Track node that will play next.
 * @property {string} soundId      Its sound.
 * @property {string[]} edgeIds    Edges the token will traverse to reach it, in order.
 * @property {Array<{nodeId: string, edgeId: string, historyAfter?: string[]}>} decisions
 *   Every choice made ahead of time, for replay and for re-validation at the seam.
 */

/**
 * Decide, in advance, exactly which Track node a token will reach next from
 * `fromNodeId` - so the engine can start that track's audio on the audio clock
 * at the seam instead of walking the graph only once the seam has already
 * passed (CustomPlaybackEngine#_queueNextHandoff).
 *
 * This is a LOOKAHEAD, never a second source of truth. It commits Random draws
 * and evaluates Conditions early, which for Conditions is a deliberate, bounded
 * relaxation of H7 ("evaluated when the token arrives"): the engine re-runs
 * every condition decision at the seam and throws the whole plan away if any of
 * them now resolves differently. A plan is therefore only ever an optimisation
 * of a walk that would have happened anyway.
 *
 * Returns null - "no plan, use the normal walk" - for every shape where a single
 * pre-armed seam is either wrong or unknowable:
 *   - a Fork on the path (spawns N tokens; one armed seam can't represent it);
 *   - a Playlist node (its child engine's first track isn't knowable without
 *     running it);
 *   - a Delay node (the seam is no longer the track's end, and a Delay between
 *     two tracks means the silence is intentional - there is no gap to close);
 *   - an End node, a dangling edge, or an unknown node id;
 *   - the target Track reusing the sound we are handing off FROM (one Sound
 *     cannot play two positions at once - the same reason the crossfade bails);
 *   - a target the caller reports as busy (singleton rule / sound ownership).
 *
 * Pure: every piece of live state arrives through the options object.
 * @param {CustomGraph} graph
 * @param {string} fromNodeId - The Track node currently playing.
 * @param {object} options
 * @param {string} options.fromSoundId - The sound currently playing, to refuse handing off to itself.
 * @param {() => number} options.rng
 * @param {(condition: GraphCondition) => boolean} options.evaluateCondition
 * @param {Map<string, string[]>} options.recentPicks - Random history, read-only here.
 * @param {number} options.maxHistory
 * @param {(node: GraphNode) => boolean} options.isBusy - True if this node, or its sound, is
 *   already claimed (the engine's _activeNodes / _activeSoundOwners check).
 * @returns {HandoffPlan|null}
 */
export function planNextHandoff(graph, fromNodeId, options) {
  const nodes = graph?.nodes;
  const edges = graph?.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !fromNodeId) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { fromSoundId, rng, evaluateCondition, recentPicks, maxHistory, isBusy } = options;

  const edgeIds = [];
  const decisions = [];
  const visited = new Set([fromNodeId]);
  let currentId = fromNodeId;

  for (let hop = 0; hop < MAX_PLAN_HOPS; hop++) {
    const outgoing = edges.filter((e) => e.from === currentId);
    if (outgoing.length === 0) return null;

    const node = byId.get(currentId);
    let chosen;
    if (currentId === fromNodeId || node?.type === 'start') {
      chosen = outgoing[0];
    } else if (node?.type === 'random') {
      const pick = pickRandomExit(node, outgoing, recentPicks.get(node.id) || [], rng, maxHistory);
      if (!pick) return null;
      chosen = pick.edge;
      decisions.push({ nodeId: node.id, edgeId: pick.edge.id, historyAfter: pick.history });
    } else if (node?.type === 'condition') {
      chosen = outgoing.find((e) => evaluateCondition(e.condition));
      if (!chosen) return null; // token would terminate here; nothing to arm
      decisions.push({ nodeId: node.id, edgeId: chosen.id });
    } else {
      return null; // fork / delay / playlist / end / unknown - see the doc comment
    }

    edgeIds.push(chosen.id);
    const next = byId.get(chosen.to);
    if (!next || visited.has(next.id)) return null;
    visited.add(next.id);

    if (next.type === 'track') {
      if (!next.soundId || next.soundId === fromSoundId) return null;
      if (isBusy(next)) return null;
      return { nodeId: next.id, soundId: next.soundId, edgeIds, decisions };
    }
    if (next.type !== 'random' && next.type !== 'condition' && next.type !== 'start') return null;
    currentId = next.id;
  }
  return null;
}
```

**Note on the first hop:** the walk starts at the Track node currently playing, which by schema has
exactly one exit — hence the `currentId === fromNodeId` branch taking `outgoing[0]`, matching
`_followSingleExit`.

### Task 2.3 — Engine constants and RTT measurement

**File:** `scripts/custom-playback-engine.mjs`

Add near the other module constants (after `MAX_PLAYLIST_NESTING_DEPTH`):

```js
/**
 * Hand-off arming (docs/gapless-handoff-plan.md G3/G4). The engine starts the
 * next track's audio itself, on the browser's audio clock, at the exact seam -
 * but Foundry's PlaylistSound#_onStart stops any Sound whose DOCUMENT doesn't
 * yet say `playing: true`, so the document update must have landed by then.
 * `lead` is therefore sized from a measured update round-trip rather than
 * guessed: too short and the armed start is killed on arrival (degrading to the
 * ordinary path, which is safe but pointless); too long and remote clients,
 * which start on the broadcast, overlap the outgoing track by the difference.
 */
const DEFAULT_UPDATE_RTT_MS = 150;
const MIN_HANDOFF_LEAD_MS = 60;
const MAX_HANDOFF_LEAD_MS = 500;
```

In the constructor, next to `this._pendingStops = new Map();`, add:

```js
    // Exponentially-weighted mean of observed playlist-update round-trips, used
    // to size the hand-off lead (see DEFAULT_UPDATE_RTT_MS). null until the
    // first clean start has been timed.
    this._updateRttMs = null;
    // The hand-off currently armed ahead of the seam, if any - see _armHandoff.
    // At most one per engine: a graph can only be between two tracks once.
    this._armedHandoff = null;
```

Add both to the reset block that already clears `_enterTrackCallTimes` / `_pendingStops` in `start()`
(anchor: `    this._pendingStops = new Map();` inside `start()`), setting them to `null`.

Add these methods next to `_crossfadeMs()`:

```js
  /**
   * Fold one observed playlist-update round-trip into the running mean used to
   * size the hand-off lead. Fed from _enterTrack's own `marks.play`, which
   * already times exactly this - the controller.playTrack() call, i.e. a real
   * Playlist#playSound document update and its server response.
   * @param {number} ms
   * @private
   */
  _recordUpdateRtt(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this._updateRttMs = this._updateRttMs === null ? ms : this._updateRttMs * 0.7 + ms * 0.3;
  }

  /**
   * How far ahead of a seam to arm the next track. See DEFAULT_UPDATE_RTT_MS.
   * @returns {number} ms, clamped to [MIN_HANDOFF_LEAD_MS, MAX_HANDOFF_LEAD_MS].
   * @private
   */
  _handoffLeadMs() {
    const rtt = this._updateRttMs ?? DEFAULT_UPDATE_RTT_MS;
    return Math.min(MAX_HANDOFF_LEAD_MS, Math.max(MIN_HANDOFF_LEAD_MS, Math.round(rtt * 1.5 + 20)));
  }
```

Call `this._recordUpdateRtt(marks.play);` in `_enterTrack` immediately after the line
`      marks.play = Date.now() - playStart;`.

### Task 2.4 — Arm, commit, cancel

**File:** `scripts/custom-playback-engine.mjs`. Add these four methods after `_beginCrossfadeHandoff`.

```js
  /**
   * Once this Track's duration is known, decide what plays next and arm it to
   * start on the audio clock at the exact seam (docs/gapless-handoff-plan.md
   * G3/Q1). Only for a plain single-play track: every other loop mode either
   * has no knowable seam ('forever'/'until') or already schedules its own
   * boundary (a fixed count, which Stage 2 does not cover).
   *
   * Uses its own duration-probe key ('handoff'). EngineClock ids REPLACE rather
   * than stack, so sharing a key with _recordTrackTiming's 'timing' probe would
   * make the two retry chains overwrite each other every tick - whichever lost
   * would never fire again. This is the same hazard _probeDuration's own doc
   * comment warns about; do not consolidate the keys.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document currently playing.
   * @param {number} elapsedMs
   * @param {number} runId
   * @private
   */
  _queueNextHandoff(node, sound, elapsedMs, runId) {
    // The crossfade is an alternative answer to the same problem and already
    // hands off early on its own schedule. Two mechanisms racing for one seam
    // would double-hop the token; the crossfade wins where it is enabled.
    if (this._crossfadeMs() > 0) return;

    const plan = this._planNextHandoff(node, sound);
    if (!plan) return;

    const startedAt = Date.now() - elapsedMs;
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const seamAt = startedAt + duration * 1000;
        const armAt = seamAt - this._handoffLeadMs();
        if (armAt - Date.now() <= 0) {
          log(3, () => `CustomPlaybackEngine: track '${node.id}' is too short to arm a hand-off; using its natural end instead.`);
          return;
        }
        this.clock.schedule(`${node.id}:arm`, armAt - Date.now(), () => this._armHandoff(node, sound, plan, seamAt, runId), { precise: true });
      },
      () => log(3, () => `CustomPlaybackEngine: track '${node.id}' reported no duration; hand-off not armed, advancing on its natural end.`),
      'handoff'
    );
  }

  /**
   * Build a lookahead plan for what follows `node`, supplying planNextHandoff()
   * with this engine's live state. Split out from _queueNextHandoff so it can be
   * re-run cheaply at the seam to re-validate the plan's Condition decisions.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound
   * @returns {import('./custom-playback-schema.mjs').HandoffPlan|null}
   * @private
   */
  _planNextHandoff(node, sound) {
    const baseline = { moodAtStart: this._moodAtStart, phaseAtStart: this._phaseAtStart };
    try {
      return planNextHandoff(this.graph, node.id, {
        fromSoundId: sound?.id ?? node.soundId,
        rng: this._rng,
        evaluateCondition: (condition) => this._evaluateCondition(condition, baseline),
        recentPicks: this._recentPicks,
        maxHistory: MAX_COOLDOWN_HISTORY,
        isBusy: (candidate) =>
          this._activeNodes.has(candidate.id) ||
          (this._activeSoundOwners.has(candidate.soundId) && this._activeSoundOwners.get(candidate.soundId) !== candidate.id) ||
          !this.playlist?.sounds?.get(candidate.soundId)
      });
    } catch (error) {
      // A lookahead that throws must never be able to stop playback - the
      // ordinary walk still works without it.
      log(2, 'CustomPlaybackEngine: hand-off lookahead threw; falling back to the ordinary walk.', error);
      return null;
    }
  }

  /**
   * Start the next track's audio on the audio clock, timed to land exactly at
   * the seam, and put its document update on the wire now so it has landed
   * before that (docs/gapless-handoff-plan.md G3).
   *
   * The ordering of the two calls below is load-bearing and not interchangeable:
   *
   * - `Sound#play({delay})` sets the Sound's state to STARTING *synchronously*,
   *   and Sound#playing is true for STARTING. That makes PlaylistSound#sync() -
   *   which runs on every client when the update lands - take its
   *   already-playing branch and merely re-assert volume, instead of starting
   *   the sound a second time (and, worse, `lead` ms early). Issue the update
   *   first and sync() would win the race and start it early.
   * - Conversely Sound#play() itself returns immediately unless the state is
   *   LOADED/PAUSED/STOPPED, so a sync() that somehow gets there first makes
   *   this a no-op rather than a double start. The two are mutually idempotent
   *   in this order and only in this order.
   *
   * If the update lands LATE (past the seam), Foundry's PlaylistSound#_onStart
   * stops the sound outright - `if (!this.playing) return this.sound.stop()`,
   * against the DOCUMENT field. That is a graceful degradation, not a bug:
   * sync() then starts the track normally when the update does land, which is
   * exactly the behaviour this whole mechanism is optimising away. It is why the
   * lead is measured (see _handoffLeadMs) rather than fixed.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node - The OUTGOING node.
   * @param {object} sound - The outgoing PlaylistSound document.
   * @param {import('./custom-playback-schema.mjs').HandoffPlan} plan
   * @param {number} seamAt - Date.now()-based timestamp of the seam.
   * @param {number} runId
   * @private
   */
  _armHandoff(node, sound, plan, seamAt, runId) {
    if (this._runId !== runId) return;
    if (this._activeNodes.get(node.id)?.sound !== sound) return; // already advanced
    if (this._armedHandoff) return; // one seam at a time

    const nextSound = this.playlist?.sounds?.get(plan.soundId);
    const rawSound = nextSound?.sound;
    if (!nextSound || typeof rawSound?.play !== 'function' || rawSound.loaded !== true) {
      log(3, () => `CustomPlaybackEngine: cannot arm '${plan.nodeId}' (sound '${plan.soundId}' not loaded); advancing on the natural end instead.`);
      return;
    }

    const nextNode = this.graph.nodes.find((n) => n.id === plan.nodeId);
    const nextLoop = resolveLoop(nextNode);
    const repeat = nextLoop.mode !== 'count' || nextLoop.count > 1;
    const delaySeconds = Math.max(0, seamAt - Date.now()) / 1000;

    try {
      rawSound.play({ delay: delaySeconds, volume: nextSound.volume ?? 1, loop: repeat, offset: 0, fade: 0 });
    } catch (error) {
      log(2, `CustomPlaybackEngine: could not arm the audio for node '${plan.nodeId}'; it will start the ordinary way instead.`, error);
      return;
    }

    this._armedHandoff = { fromNodeId: node.id, fromSound: sound, plan, nextSound, repeat, seamAt, runId };
    Promise.resolve(this.controller.playTrack(nextSound)).catch(() => {});
    log(3, () => `CustomPlaybackEngine: armed '${plan.nodeId}' (sound '${plan.soundId}') to start in ${Math.round(delaySeconds * 1000)}ms`);

    this.clock.schedule(`${node.id}:seam`, Math.max(0, seamAt - Date.now()), () => this._commitArmedHandoff(runId), { precise: true });
  }

  /**
   * Hand the token over at the seam, replaying the plan's recorded route.
   *
   * Every Condition decision is re-evaluated here first. Planning them ahead of
   * time is a bounded relaxation of H7 (conditions are evaluated when the token
   * arrives), and this is what bounds it: if any decision now resolves to a
   * different exit - a mood or phase changed inside the lead window - the armed
   * audio is discarded and the ordinary walk runs instead. Seamless when the
   * prediction holds, exactly today's behaviour when it doesn't.
   * @param {number} runId
   * @private
   */
  _commitArmedHandoff(runId) {
    const armed = this._armedHandoff;
    if (!armed || this._runId !== runId) return;
    // The 'end' watcher may have advanced this node already - whichever
    // mechanism gets here first owns the hand-off, exactly as with the crossfade.
    const node = this.graph.nodes.find((n) => n.id === armed.fromNodeId);
    if (!node || this._activeNodes.get(node.id)?.sound !== armed.fromSound) return;

    const fresh = this._planNextHandoff(node, armed.fromSound);
    const stillValid = fresh && fresh.nodeId === armed.plan.nodeId;
    if (!stillValid) {
      log(2, `CustomPlaybackEngine: discarding the armed hand-off at node '${armed.fromNodeId}' - the graph now routes elsewhere (a condition changed inside the lead window).`);
      this._cancelArmedHandoff();
      return; // the 'end' watcher advances normally
    }

    for (const decision of armed.plan.decisions) {
      if (decision.historyAfter) this._recentPicks.set(decision.nodeId, decision.historyAfter);
    }
    this.watcher.unwatch(armed.fromSound.id);
    this._emitActivity({ traversedEdgeIds: armed.plan.edgeIds });
    this._clearPlayingFlagAfterNaturalEnd(armed.fromSound);

    // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
    this._walk(async () => {
      this._releaseTrackNode(node);
      await this._enterNode(armed.plan.nodeId, 0);
    });
  }

  /**
   * Tear down an armed hand-off that is not going to be used - the plan was
   * invalidated, the track ended early, or the engine is stopping.
   *
   * Sound#stop() cancels the pending delayed start (it cancels the Sound's own
   * AudioTimeout), so nothing is left scheduled. The document update issued at
   * arm time may already have landed, which would leave the sound marked playing
   * in the world with nothing audible - and Foundry resurrects every sound still
   * marked playing on the next page load. Clearing it is therefore not optional.
   * @private
   */
  _cancelArmedHandoff() {
    const armed = this._armedHandoff;
    if (!armed) return;
    this._armedHandoff = null;
    this.clock.cancel(`${armed.fromNodeId}:arm`);
    this.clock.cancel(`${armed.fromNodeId}:seam`);
    try {
      armed.nextSound?.sound?.stop?.();
    } catch (error) {
      log(2, `CustomPlaybackEngine: could not cancel the armed audio for '${armed.plan.nodeId}'.`, error);
    }
    this._stopTrackTracked(armed.nextSound);
  }
```

Add `planNextHandoff` to the existing schema import at the top of the file.

### Task 2.5 — Wire it in

**File:** `scripts/custom-playback-engine.mjs`, in `_enterTrack`.

**2.5a — armed adoption.** Immediately **before** the line
`    const alreadyPlaying = sound.sound ? sound.sound.playing === true : sound.playing === true;`
insert:

```js
    // This node was armed ahead of the seam (see _armHandoff): its audio is
    // already started or is about to start on the audio clock, and its document
    // update went out at arm time. Adopt that deliberately rather than letting
    // it fall into the generic alreadyPlaying branch below, whose setTimeout(0)
    // yield and elapsed-position arithmetic exist for a different situation (a
    // sound carried over from a previous context). _lastCleanStartAt is still
    // written so MIN_CLEAN_START_INTERVAL_MS and the circuit breaker keep
    // bounding this node exactly as they do for an ordinary start.
    const armedForThisNode = this._armedHandoff?.plan.nodeId === node.id && this._armedHandoff.nextSound === sound;
    if (armedForThisNode) this._armedHandoff = null;
    const armedStarted = armedForThisNode && sound.sound?.playing === true;
    if (armedStarted) this._lastCleanStartAt.set(node.id, Date.now());
```

Then change the branch head from:

```js
    if (alreadyPlaying) {
```

to:

```js
    if (armedStarted) {
      // Nothing to do: the audio and the document update both happened at arm
      // time. An armed start that did NOT actually take (the update landed late
      // and PlaylistSound#_onStart stopped it) falls through to the ordinary
      // paths below instead, which is the intended degradation.
    } else if (alreadyPlaying) {
```

**2.5b — queue the next hand-off.** In the `if (loopCount === 1) {` branch, immediately after the
existing `this._scheduleCrossfadeHandoff(node, sound, elapsedMs, runId);` line, add:

```js
      // Decide what plays next and start it on the audio clock at the seam. A
      // no-op when the crossfade is on (that mechanism owns the seam instead) or
      // when the graph shape can't be planned - see _queueNextHandoff.
      this._queueNextHandoff(node, sound, elapsedMs, runId);
```

**2.5c — the watcher cancels the arming.** Inside the same branch's
`this.watcher.watch(sound, async () => {` callback, immediately after the
`if (this._runId !== runId) return;` line, add:

```js
        // The track ended before the seam we computed (a short file, a bad
        // probe, a mid-track stop). The armed start is either already running -
        // in which case _enterTrack adopts it below - or is scheduled for a seam
        // that has now passed; either way this callback owns the advance from
        // here, so retire the scheduled commit.
        this.clock.cancel(`${node.id}:seam`);
```

**2.5d — teardown.** In `stop()`, immediately after `    this.watcher.unwatchAll();`, add:

```js
    // An armed hand-off holds a Sound scheduled to start and, usually, a
    // document already marked playing. Cancel before the run id is consumed
    // below so its own stop is issued in this same synchronous pass as every
    // other stop (see the comment on childStops).
    this._cancelArmedHandoff();
```

**2.5e — overlay re-resolution.** Add `this._cancelArmedHandoff();` as the first statement of
`refreshOverlayReactiveTargets()` and of `_swapPlaylistNodeTarget()`, with the comment:

```js
    // Any armed hand-off was planned against the world state this is reacting to
    // a change in; re-plan from scratch rather than commit a stale decision.
```

**2.5f — telemetry.** In the latency log thunk in `_enterTrack` (anchor:
`` `preloaded=${this._preloadedSoundIds.has(node.soundId)})` ``), extend the template to also report
`armed=${armedStarted} lead=${this._handoffLeadMs()}ms rtt=${Math.round(this._updateRttMs ?? 0)}ms`.

### Task 2.6 — Mock: a `Sound` that models delayed starts

**File:** `tests/mocks/foundry.mjs`, in `createMockSound`.

Add to `innerSound` a `play` that models `Sound#play({delay})` closely enough to test against:

```js
  // Models foundry.audio.Sound#play({delay}). The real implementation creates
  // its nodes immediately, marks itself STARTING (Sound#playing is true for
  // STARTING, which is what makes PlaylistSound#sync() a no-op mid-arm), waits
  // out the delay on the audio clock, and only then starts the source. stop()
  // cancels a pending delayed start. CustomPlaybackEngine's hand-off arming
  // depends on all four of those behaviours.
  let pendingStart = null;
  innerSound.play = vi.fn((options = {}) => {
    if (innerSound.playing) return Promise.resolve(innerSound);
    innerSound.starting = true;
    innerSound.playing = true; // STARTING counts as playing, as in Foundry
    const delayMs = (options.delay ?? 0) * 1000;
    pendingStart = setTimeout(() => {
      pendingStart = null;
      innerSound.starting = false;
      innerSound.started = true;
    }, delayMs);
    return Promise.resolve(innerSound);
  });
  const baseStop = innerSound.stop;
  innerSound.stop = vi.fn((...args) => {
    if (pendingStart) {
      clearTimeout(pendingStart);
      pendingStart = null;
    }
    innerSound.starting = false;
    innerSound.started = false;
    innerSound.playing = false;
    return baseStop(...args);
  });
```

Place this after the `innerSound` object literal and before `const sound = {`. Move `stop: vi.fn()`
out of the literal only if needed to make `baseStop` resolvable — keep the literal's `stop` as the
base.

### Task 2.7 — Tests

**File:** `tests/custom-playback-schema.test.mjs` — planner and pick, pure, no Foundry:

1. `pickRandomExit` returns the same edge as the old inline logic for: a plain weighted draw with a
   seeded rng, all-zero weights (uniform, `allWeightsZero: true`), a full cooldown lockout (falls back
   to all edges), and `avoidRepeat` dedup by target node.
2. `pickRandomExit` does **not** mutate the history array passed in.
3. `planNextHandoff` returns the next Track across a direct edge, across a Random node (recording a
   `historyAfter`), and across a Condition node (recording the chosen `edgeId`).
4. `planNextHandoff` returns `null` for **each** bail condition, one test each: Fork on the path,
   Delay on the path, Playlist node, End node, dangling edge, unknown node id, the target reusing
   `fromSoundId`, `isBusy` reporting true, no Condition exit matching, and a cycle back to a visited
   node.

**File:** `tests/custom-playback-engine.test.mjs` — behaviour:

5. **Arms and starts at the seam.** Two-track chain, `s1.sound.duration` set, fake timers. Advance to
   just past `duration - lead`: `s2.sound.play` was called with a `delay`, `s2.sound.starting === true`,
   and `controller.playTrack` was called with `s2`. Advance to the seam: `s2.sound.started === true`.
6. **Adopts rather than restarting.** After the seam commits, `controller.playTrack` has been called
   with `s2` exactly **once** in total, and `s2.update` was not called.
7. **Crossfade wins.** With `graphCrossfade` set non-zero, `s2.sound.play` is never called ahead of
   the seam.
8. **Unplannable graph is untouched.** A `t1 → fork → …` graph never arms, and still hands off exactly
   as it does today.
9. **Plan invalidation.** A `t1 → condition → {t2, t3}` graph where the condition's answer changes
   between arm and seam: `s2.sound.stop` was called, `_armedHandoff` is cleared, and firing `end`
   advances to `t3`.
10. **Track ends early.** Fire `end` before the seam: exactly one advance happens (assert the token
    reaches `t2` once — `controller.playTrack`/adoption is not doubled), and no stray timer advances it
    again after.
11. **Teardown mid-arm.** Arm, then `await engine.stop()`: `s2.sound.stop` was called and
    `controller.stopTrack` was called with `s2` (its `playing` flag is cleared).
12. **Late document update degrades safely.** Model `playTrack` resolving after the seam; assert the
    engine still ends up with `t2` active and does not throw.
13. **Lead adapts.** After two hand-offs with a slow mocked `playTrack`, `_handoffLeadMs()` has grown,
    and is clamped at `MAX_HANDOFF_LEAD_MS`.

**Gate:** `npm test` green; count up by roughly 25–30.

---

## Stage 3 — Documentation

Only after Stages 1 and 2 are green.

1. **`docs/wiki/graph-engine.md`**
   - § *Track*, "On natural end" paragraph: correct the claim that nothing else clears the `playing`
     flag. State that `Playlist#_onSoundEnd` does it first in every mode, that the engine's own stop is
     therefore only issued when the parent can't (`_clearPlayingFlagAfterNaturalEnd`), and that the
     timed paths still stop explicitly because they never fire `'end'`.
   - § *Hand-off latency*: add a row to the cost table for the redundant stop, and a new subsection
     **Predictive arming** describing `_queueNextHandoff` → `_armHandoff` → `_commitArmedHandoff` →
     `_cancelArmedHandoff`, the `play({delay})` / `sync()` idempotence, the `_onStart` document-flag
     constraint, and the measured lead.
   - § *Playlist nodes*: add the previously-undocumented interaction — a child engine over a native
     `SEQUENTIAL`/`SHUFFLE` target has Foundry's own `_onSoundEnd` → `playNext` starting the next
     native track alongside the engine's own advance.
2. **`docs/wiki/invariants.md`**
   - Amend **H7** to record that the lookahead evaluates conditions early *and* re-validates every
     decision at the seam, so the invariant holds at the point it matters.
   - Add a note under **H4** that a seam measured against one sound's own playback position is the one
     sanctioned exception, and everything else still goes through `EngineClock`.
3. **`CLAUDE.md`** — no change needed. `custom-playback-schema.mjs` is already listed as pure and the
   two new exports keep it that way.
4. **`docs/gapless-handoff-plan.md`** — change the Status line to record which stages shipped.

---

## Explicitly out of scope

Do **not** implement these. They were considered and deliberately deferred; adding them will make the
change unreviewable.

| Deferred | Why |
|---|---|
| **G2** — merging `sound.update({pausedTime, repeat})` into the play update | Only fires in the uncommon case, and requires replicating `Playlist#playSound`'s mode branch. Poor risk/benefit next to the rest. |
| Arming across **Delay** nodes | A Delay between two tracks means the silence is intentional; also requires replaying the delay rather than re-entering the node, which would cost the editor's drain overlay. |
| Arming for **`loop.count > 1`**, `until`, `forever` | Those boundaries are engine-timed already and need a different arming shape. |
| Moving timed stops from `EngineClock` to `Sound#schedule` (**G6**) | Independent optimisation; do it only after Stage 2 has proven stable. |
| The **A′ socket pre-cue** (Part 5 of the diagnosis) | A separate deliverable, and it depends on Stage 2's arming existing first. |
| Adding a fade-**in** to the crossfade | Genuine improvement, unrelated to the gap. Separate change. |
| Removing `_preloadUpcoming`'s fan-out in favour of the plan | The fan-out still covers every case where planning bails. Keep both. |

---

## Definition of done

- `npm test` green; test count up by ~5 after Stage 1 and ~30 more after Stage 2.
- `node --check` clean on every edited `scripts/*.mjs`.
- No new strings in `lang/`.
- Every new method carries JSDoc; every comment this plan specifies is present verbatim or better.
- With `enableDebug` on, a two-track graph logs `armed=true` on the second track's start line, and its
  `play=` mark is `0`.
