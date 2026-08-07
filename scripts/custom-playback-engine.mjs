import { CONST } from './config.mjs';
import { log, isHeadGM, getCustomGraph, resolvePlaylistRef, PlaylistContext, emitHook } from './helpers.mjs';
import { EngineClock } from './engine-clock.mjs';
import { AudioEndWatcher } from './audio-end-watcher.mjs';
import { buildNativeModeGraph } from './native-mode-graph.mjs';
import { normalizePlaylistRef } from './playlist-ref.mjs';
import { resolveLoop, findUpcomingTrackNodes, resolveGraphCrossfadeMs, pickRandomExit, planNextHandoff } from './custom-playback-schema.mjs';
import { resolveCrossfadeMs } from './playlist-mix.mjs';
import { applyMixToSound, getPlaylistMix, mixedVolume } from './playlist-mix-apply.mjs';

/**
 * Maximum number of instantaneous (non-durational) nodes a single token may
 * cross synchronously before the walk is aborted. Guards against a graph built
 * entirely from Fork/Random/Condition/Start nodes with no Track/Delay, which
 * would otherwise recurse the main thread forever (custom-playlist-plan.md,
 * "instantaneous-cycle guard").
 */
const MAX_SYNCHRONOUS_DEPTH = 100;

/** How many recent picks a Random node remembers per-node for cooldown checks. */
const MAX_COOLDOWN_HISTORY = 32;

/**
 * Minimum time (ms) between two "clean start" plays of the SAME Track node.
 * Unlike an all-instantaneous cycle (guarded by MAX_SYNCHRONOUS_DEPTH), a
 * cycle that passes through a Track or Delay node is durational by design and
 * deliberately not blocked - a Track whose own exit points back to itself is
 * a legitimate way to say "keep playing this track". But nothing otherwise
 * caps how FAST that cycle can repeat: for a short clip, each iteration's
 * real Foundry document update (playlist sound update -> playTrack) can fire
 * far faster than the browser can keep up with, flooding the tab's event
 * queue badly enough to make it unresponsive - this happened in practice,
 * not just in theory. Delay nodes get an equivalent floor for free from
 * EngineClock's own tick cadence; Track nodes need it enforced explicitly.
 */
const MIN_CLEAN_START_INTERVAL_MS = 300;

/**
 * Circuit-breaker window for _enterTrack(): if a single node is *entered*
 * (not just clean-started - this also counts calls the singleton check drops)
 * more than MAX_ENTER_TRACK_CALLS_PER_WINDOW times within this window, the
 * engine assumes something is generating far more calls than the throttle
 * above was ever designed to bound (e.g. a leaked/duplicate 'end' listener
 * repeatedly re-firing) and stops itself outright rather than let the loop
 * keep flooding the tab. 15 calls / 2s is well above the ~7 clean starts the
 * 300ms floor permits on its own, so this should only trip on a genuine runaway.
 */
const ENTER_TRACK_WINDOW_MS = 2000;
const MAX_ENTER_TRACK_CALLS_PER_WINDOW = 15;

/**
 * Cap on how many times _scheduleLoopStop()'s duration probe retries (at its
 * 100ms cadence, ~2s total) before giving up on a sound that never reports a
 * loaded duration - e.g. a missing file, a network error, or a decode
 * failure. Without this the probe polls forever with the token stuck on this
 * node and no further log line after the first, mirroring the cap
 * _fadeInWhenReady (music-controller.mjs) already applies to the same kind of
 * readiness retry.
 */
const MAX_DURATION_PROBE_ATTEMPTS = 20;

/**
 * How long after adopting an armed hand-off (_enterTrack's `path=armed`) the
 * engine re-checks that the audio it armed genuinely began.
 *
 * `Sound#play({delay})` waits out the delay on an `AudioTimeout`, which is
 * driven by an `AudioBufferSourceNode.onended` on the shared AudioContext. A
 * context that is not running never fires it, so the awaited `wait()` inside
 * Foundry's `Sound##queuePlay` never resolves: the Sound is stuck in STARTING
 * for good. STARTING reports `Sound#playing === true` while `startTime` stays
 * undefined - so the seam adopts a track that will never make a sound, the
 * document stays `playing: true`, no 'end' event can ever arrive, and the graph
 * sits on that node forever. Confirmed live, twice over: the same sound came
 * back marked playing from the *previous* session's wedge.
 *
 * It also poisons core's own UI - the sidebar's pause button reads
 * `sound.sound.currentTime`, which is `context.currentTime - undefined` = NaN
 * for a STARTING sound, and the resulting `pausedTime: NaN` fails validation.
 *
 * Comfortably longer than any hand-off lead (_handoffLeadMs is 60-100ms) plus
 * timer jitter, so a start that is merely a few ms late is never mistaken for a
 * wedged one, and short enough that the recovery restart is a blip rather than
 * a hole.
 */
const ARMED_START_VERIFY_MS = 350;

/**
 * How long after adopting an armed hand-off to re-assert the mixed volume (_assertMixedVolume).
 *
 * Has to clear the seam itself: `Sound##queuePlay` assigns `this.volume` from the value captured
 * at arm time only after its delay elapses, cancelling any scheduled ramp as it goes, so a volume
 * set even a millisecond early is thrown away. Small enough that a duck arriving mid-arm-window
 * is corrected inside one frame of the seam rather than audibly late.
 */
const MIX_ASSERT_DELAY_MS = 40;

/**
 * Poll cadence for a loop.mode 'until' Track's escape condition, boundary
 * 'immediate' (overlays-and-loop-modes-plan.md L3). This used to be chosen to
 * match EngineClock's tick (then also 500ms) on the grounds that polling faster
 * would only add checks that never see a different clock reading. The tick is
 * now finer, so this is an independent choice: it is how quickly an 'immediate'
 * until-loop reacts to a mood/phase/combat change, and 500ms is responsive
 * enough for a human-triggered state change without evaluating conditions
 * (which read game settings) ten times a second for the whole life of the loop.
 */
const UNTIL_POLL_INTERVAL_MS = 500;

/**
 * How many Playlist nodes may nest (a Playlist node whose target itself has a
 * Playlist node, and so on) before the engine refuses to go any deeper. Not a
 * cycle - the shared in-flight registry (see the constructor's `_registry`
 * doc comment) already catches those - but an unbounded legitimate chain
 * would still let a graph reference dozens of playlists deep, spawning a
 * child CustomPlaybackEngine per level (docs/playlist-node-plan.md D6).
 */
const MAX_PLAYLIST_NESTING_DEPTH = 4;

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

/**
 * Executes a custom playback graph (custom-playback-schema.mjs) as a token-flow
 * state machine: a token enters at the Start node and walks the graph, playing
 * Track nodes and following their exits. Runs only on the head GM (see
 * isHeadGM()); every other client just observes the resulting PlaylistSound
 * playback state via Foundry's normal multi-client sync.
 *
 * Fork spawns a token on every exit at once (parallel playback); Random and
 * Condition each follow exactly one of several exits (by weight, or by the
 * first matching game-state condition). Track and Delay are the only
 * durational node types and the only ones subject to the singleton rule.
 */
export class CustomPlaybackEngine {
  static _runCounter = 0;

  /**
   * @param {import('./helpers.mjs').PlaylistContext} playlistContext - The resolved context this engine plays for.
   * @param {import('./music-controller.mjs').MusicController} controller - Owning controller; used for playTrack/stopTrack/_managedSoundIds.
   * @param {object} [options]
   * @param {import('./custom-playback-schema.mjs').CustomGraph} [options.graph] - Overrides the
   *   playlist's stored graph. Used for a native target referenced by a Playlist node, whose rules
   *   are synthesized rather than stored (native-mode-graph.mjs, docs/playlist-node-plan.md D5).
   * @param {number} [options.depth] - Playlist-node nesting depth; 0 for a root engine, incremented
   *   by one for each child a Playlist node spawns (see MAX_PLAYLIST_NESTING_DEPTH).
   * @param {Set<string>} [options.registry] - Playlist ids currently in flight anywhere in this
   *   engine tree, shared BY REFERENCE with every child engine a Playlist node spawns. The single
   *   mechanism preventing a Playlist node from referencing itself, an indirect cycle (A's Playlist
   *   node targets B, whose Playlist node targets A), or two branches driving the same playlist at
   *   once (docs/playlist-node-plan.md D6). A root engine (no options.registry given) seeds its own
   *   Set with its own playlist id, since it is itself "in flight" for the same reasons.
   * @param {() => void} [options.onIdle] - Called once, when this engine has no token left anywhere
   *   in its own graph (see _checkIdle) - how a parent Playlist node's child engine reports a
   *   completed pass (docs/playlist-node-plan.md D3).
   */
  constructor(playlistContext, controller, options = {}) {
    this.playlistContext = playlistContext;
    this.playlist = playlistContext?.playlist ?? null;
    this.graph = options.graph || getCustomGraph(this.playlist) || { version: 1, nodes: [], edges: [] };
    this.controller = controller;
    this.clock = new EngineClock();
    this.watcher = new AudioEndWatcher();
    this._runId = 0;
    // Durational nodes (track, delay, playlist) currently holding a token:
    // nodeId -> { sound } (track/delay) or { sound: null, targetPlaylistId } (playlist).
    // A node present here is "active" for the purposes of the singleton rule.
    this._activeNodes = new Map();
    // Random-node pick history: nodeId -> [edgeId, ...] most-recent-first, for cooldowns.
    this._recentPicks = new Map();
    // Injectable for deterministic tests; real playback uses Math.random.
    this._rng = Math.random;
    // nodeId -> Date.now() of its last clean (non-adopted) start, for the
    // rapid-restart-loop throttle in _throttleNodeEntry().
    this._lastCleanStartAt = new Map();
    // nodeId -> recent _enterTrack() call timestamps, for the circuit breaker.
    this._enterTrackCallTimes = new Map();
    // soundId -> the single nodeId currently allowed to drive that sound. Two
    // Track nodes referencing the same soundId are not two independent
    // resources - they're one physical Sound fought over by two bookkeeping
    // entries. Without this, a second node can find the sound already playing,
    // silently "adopt" it (no throttle, no real restart), and in doing so
    // overwrite the first node's AudioEndWatcher listener - orphaning the
    // first node in _activeNodes forever and letting hand-offs between the two
    // cascade far faster than MIN_CLEAN_START_INTERVAL_MS was ever able to
    // bound (confirmed live: this is what tripped the circuit breaker).
    this._activeSoundOwners = new Map();
    // soundId -> the in-flight controller.stopTrack() promise for that sound,
    // if one hasn't settled yet. A stop is a real Foundry document update and
    // therefore a server round-trip; the ONLY thing that must wait for it is a
    // start of that SAME sound (a clean start racing an in-flight stop would
    // have the stop land last and silence a track the engine thinks is
    // playing). Recording it here instead of awaiting every stop inline lets
    // the far more common case - advancing to a DIFFERENT sound - overlap the
    // outgoing stop with the incoming start, which is a round-trip's worth of
    // dead air removed from every hand-off. See _stopTrackTracked.
    this._pendingStops = new Map();
    // Exponentially-weighted mean of observed playlist-update round-trips, used
    // to size the hand-off lead (see DEFAULT_UPDATE_RTT_MS). null until the
    // first clean start has been timed.
    this._updateRttMs = null;
    // Why the most recent hand-off wasn't armed, as `{nodeId, reason}`. Carried
    // onto the NEXT track's start-latency line (see _enterTrack) rather than
    // only being logged where it happens: a gap is noticed on the incoming
    // track, so that is where the explanation has to be readable. Without this,
    // diagnosing "path=clean" means correlating two log lines by hand at a
    // different severity - which in practice means it doesn't get done.
    this._lastArmBail = null;
    // The hand-off currently armed ahead of the seam, if any - see _armHandoff.
    // At most one per engine: a graph is only ever between two tracks once.
    this._armedHandoff = null;
    // soundIds this run has already asked the browser to fetch+decode ahead of
    // time (see _preloadUpcoming). Purely an idempotence guard - Foundry's own
    // Sound#load() is safe to call repeatedly, this just avoids the churn.
    this._preloadedSoundIds = new Set();
    // soundIds already reported by _warnIfFadeBreaksTheSeam this run.
    this._warnedFadeSoundIds = new Set();
    // PlaylistSound documents currently fading out across a crossfade hand-off.
    // Their node has already been released, so they are NOT in _activeNodes -
    // stop() has to consult this too or a teardown mid-fade leaves them marked
    // playing in the world (and Foundry resurrects them on the next load).
    this._fadingOutSounds = new Set();
    // Token walks currently in flight, for idle detection - see _walk/_checkIdle.
    this._pendingWalks = 0;
    // Idle fires at most once per run; reset in start().
    this._idleFired = false;
    this._depth = options.depth ?? 0;
    this._registry = options.registry ?? new Set(this.playlist?.id ? [this.playlist.id] : []);
    this._onIdle = options.onIdle ?? null;
    // Child engines a Playlist node in this graph has spawned - torn down
    // whenever this engine is (see stop()).
    this._children = new Set();
  }

  /**
   * Broadcast which nodes this engine currently holds a token on, plus (when
   * known) the node just entered and the edge(s) just followed, for the graph
   * editor's live highlight (graph-activity-highlight.mjs).
   *
   * Deliberately fire-and-forget and non-fatal: Hooks.callAll() runs its
   * listeners synchronously, so an exception thrown by one of them would
   * otherwise propagate straight into the token walk and silently stop
   * playback. Highlighting is cosmetic; it must never be able to break audio.
   *
   * That reasoning started here and now governs every hook the module fires, so
   * the try/catch lives in helpers.mjs#emitHook rather than being repeated -
   * `Hooks.callAll` appears nowhere else in the module (docs/wiki/api.md).
   *
   * Note this only ever reaches the head GM's own client - the engine doesn't
   * run anywhere else (see isHeadGM()), and nothing here is broadcast over a
   * socket. The editor tells the user as much when it can't show a highlight.
   * @param {object} [payload]
   * @param {string|null} [payload.enteredNodeId] - Node a token just moved into.
   * @param {string[]} [payload.traversedEdgeIds] - Edge ids a token is following right now.
   * @private
   */
  _emitActivity({ enteredNodeId = null, traversedEdgeIds = [] } = {}) {
    emitHook(CONST.hooks.GRAPH_ACTIVITY, {
      playlistId: this.playlist?.id ?? null,
      runId: this._runId,
      activeNodeIds: [...this._activeNodes.keys()],
      activeTimings: this._activeTimings(),
      enteredNodeId,
      traversedEdgeIds
    });
  }

  /**
   * A snapshot of the same state _emitActivity() broadcasts, for priming an
   * editor window that opened after playback had already started.
   * @returns {{playlistId: string|null, runId: number, activeNodeIds: string[], enteredNodeId: null, traversedEdgeIds: string[]}}
   */
  get activityState() {
    return {
      playlistId: this.playlist?.id ?? null,
      runId: this._runId,
      activeNodeIds: [...this._activeNodes.keys()],
      activeTimings: this._activeTimings(),
      enteredNodeId: null,
      traversedEdgeIds: []
    };
  }

  /**
   * How long each currently-timed node has to run and when it started, for the
   * editor's drain overlays - a Delay's wait (_enterDelay) and a Track's one
   * pass through its sound (_recordTrackTiming). Carrying the start time
   * (rather than just a remaining duration) is what lets an editor window
   * opened mid-wait pick the drain up where it actually is instead of
   * restarting it from full.
   *
   * `iterations` is how many times that duration repeats before the node
   * advances: 1 for a Delay, the loop count for a fixed-count Track, and null
   * for a Track that repeats until something stops it ('forever'/'until').
   * @returns {Array<{nodeId: string, durationMs: number, startedAt: number, iterations: number|null}>}
   * @private
   */
  _activeTimings() {
    return [...this._activeNodes.entries()]
      .filter(([, entry]) => entry?.durationMs != null)
      .map(([nodeId, entry]) => ({
        nodeId,
        durationMs: entry.durationMs,
        startedAt: entry.startedAt,
        iterations: entry.iterations === undefined ? 1 : entry.iterations
      }));
  }

  /**
   * Record an _enterTrack() call for the runaway-loop circuit breaker and stop
   * the engine if the node has been entered abnormally often recently. See
   * MAX_ENTER_TRACK_CALLS_PER_WINDOW for why this threshold is safely above any
   * legitimate call rate.
   * @param {string} nodeId
   * @returns {boolean} true if the breaker tripped and the engine was stopped.
   * @private
   */
  _tripCircuitBreakerIfRunaway(nodeId) {
    const now = Date.now();
    const recent = (this._enterTrackCallTimes.get(nodeId) || []).filter((t) => now - t < ENTER_TRACK_WINDOW_MS);
    recent.push(now);
    this._enterTrackCallTimes.set(nodeId, recent);
    if (recent.length <= MAX_ENTER_TRACK_CALLS_PER_WINDOW) return false;

    const message = `CustomPlaybackEngine: node '${nodeId}' was entered ${recent.length} times in ${ENTER_TRACK_WINDOW_MS}ms - this is a runaway restart loop, not normal playback. Stopping the engine to protect the browser. activeNodes=${JSON.stringify([...this._activeNodes.keys()])}`;
    log(1, message);
    if (typeof ui !== 'undefined') ui.notifications?.error(game.i18n.localize('GameOrchestra.CustomEditor.RunawayLoopStopped'));
    this.stop({ stopAudio: true });
    return true;
  }

  /**
   * Begin playback from the graph's Start node. No-ops on any client that
   * isn't the current head GM - the engine only ever runs there.
   */
  async start() {
    if (!isHeadGM()) return;
    this._runId = ++CustomPlaybackEngine._runCounter;
    this._activeNodes = new Map();
    this._enterTrackCallTimes = new Map();
    this._activeSoundOwners = new Map();
    this._pendingStops = new Map();
    this._updateRttMs = null;
    this._armedHandoff = null;
    this._lastArmBail = null;
    this._preloadedSoundIds = new Set();
    this._warnedFadeSoundIds = new Set();
    this._fadingOutSounds = new Set();
    this._pendingWalks = 0;
    this._idleFired = false;
    // Baseline for 'moodChanged'/'phaseChanged' Condition-node exits (see
    // _evaluateCondition) - "changed" means "differs from what it was when
    // THIS run began", not "changed since the last poll". A fresh engine is
    // created and started per run (root re-resolve, or a Playlist node's
    // per-pass child - see _runPlaylistPass), so this naturally resets on
    // every new run rather than needing its own invalidation logic.
    this._moodAtStart = game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    this._phaseAtStart = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    const startNode = this.graph.nodes.find((n) => n.type === 'start');
    if (!startNode) {
      log(2, `CustomPlaybackEngine: graph for playlist '${this.playlist?.name}' has no Start node; nothing to play.`);
      // Nothing will ever call _walk()/register an active node for this run -
      // without this, a parent Playlist node targeting a graph-less/empty
      // graph would wait forever for a pass that can never complete.
      this._checkIdle();
      return;
    }
    log(3, `CustomPlaybackEngine: run ${this._runId} starting for playlist '${this.playlist?.name}'`);
    await this._enterNode(startNode.id, 0);
  }

  /**
   * Tear down this engine: cancel all pending timers/watchers so no stale
   * callback can fire, and optionally stop the audio it owns. Async, and must
   * be awaited by any caller that starts a replacement engine right after -
   * see the big comment below for why (confirmed live: a real, reproducing bug,
   * not a hypothetical).
   * @param {object} [options]
   * @param {boolean} [options.stopAudio] - false leaves currently-playing sounds
   *   audible so the caller's own fade-out logic can crossfade them instead of a
   *   hard cut (custom-playlist-plan.md H11). Defaults to true (hard stop).
   * @returns {Promise<void>}
   */
  async stop({ stopAudio = true } = {}) {
    if (this._runId !== -1) log(3, `CustomPlaybackEngine: run ${this._runId} stopping (stopAudio=${stopAudio})`);
    this._runId = -1; // every pending callback captured a real runId and will now bail
    this.clock.destroy();
    this.watcher.unwatchAll();
    // An armed hand-off holds a Sound scheduled to start and, usually, a
    // document already marked playing. Cancel it in this same synchronous pass
    // as every other stop below (see the comment on childStops), or a teardown
    // mid-arm leaves a sound marked playing in the world for Foundry to
    // resurrect on the next page load.
    this._cancelArmedHandoff();

    // Children (spawned by Playlist nodes - see _runPlaylistPass) get torn
    // down alongside this engine's own sounds below, not before - queuing
    // both here, synchronously, means every controller.stopTrack() call (this
    // engine's own AND every descendant's) happens in this same synchronous
    // pass rather than one microtask apart, which matters to a caller that
    // calls stop() without awaiting it (several call sites do, e.g. the
    // circuit breaker) and expects the resulting stopTrack() calls to have
    // already landed by the time stop() returns control. stopAudio is passed
    // straight through so a crossfading root stop (H11) crossfades every
    // nested playlist's sounds too, not just this engine's own.
    const children = [...this._children];
    this._children.clear();
    const childStops = children.map((child) => child.stop({ stopAudio }));

    // This engine's own bookkeeping can and should clear immediately/synchronously
    // - it's irrelevant to the race described below (a brand new engine gets its
    // own, entirely separate _activeNodes/_activeSoundOwners maps). Only the
    // actual Foundry stopTrack() calls below need to be awaited.
    const sounds = [...this._activeNodes.values()].map((entry) => entry.sound).filter(Boolean);
    // Sounds mid-crossfade belong to no node any more (see _fadingOutSounds) but
    // are still audible and still marked playing - tear them down alongside.
    for (const fading of this._fadingOutSounds) if (!sounds.includes(fading)) sounds.push(fading);
    this._fadingOutSounds.clear();
    // Any Playlist node still holding a token claimed a slot in the shared
    // in-flight registry (see the constructor's `_registry` doc comment) -
    // release it now, or a forced stop (a live-graph-edit rebuild, a context
    // change mid-pass) would strand that playlist as permanently
    // unreferenceable by any Playlist node for the rest of the session.
    for (const entry of this._activeNodes.values()) {
      if (entry.targetPlaylistId) this._registry.delete(entry.targetPlaylistId);
    }
    this._activeNodes.clear();
    this._activeSoundOwners.clear();
    this._emitActivity(); // clears any highlight an open editor is showing
    if (stopAudio) {
      // Must be awaited, not fire-and-forget: controller.stopTrack()'s real
      // Foundry stopSound() call is genuinely async, and a caller that
      // immediately starts a replacement engine afterward (onCustomGraphChanged,
      // on Save) does so with no yield in between. If a node in the NEW engine
      // references the SAME soundId a node here is being told to stop (two
      // Track nodes sharing a sound - not unusual), its alreadyPlaying check
      // can read the stale pre-stop "still playing" state and "adopt" a sound
      // that's about to be forcibly stopped moments later. Adopting attaches a
      // watcher for a natural 'end' event; the pending stop then actually lands
      // and fires 'stop' instead, which AudioEndWatcher deliberately never
      // treats as "advance" (a 'stop' means the engine did this on purpose, not
      // that the track finished) - so the token sits forever waiting for an
      // 'end' that's never coming. Silent, no further logs, confirmed live.
      await Promise.all([...sounds.map((sound) => Promise.resolve(this.controller.stopTrack(sound))), ...childStops]);
    } else {
      await Promise.all(childStops);
    }
  }

  /**
   * Playlist ids this engine tree is currently driving - this engine's own
   * playlist plus every playlist a Playlist node anywhere in this tree is
   * currently in a pass of. A snapshot copy, not a live view.
   * @returns {Set<string>}
   */
  get activePlaylistIds() {
    return new Set(this._registry);
  }

  /**
   * Whether this engine tree (this engine or any descendant spawned by a
   * Playlist node) is currently driving the given playlist.
   * @param {string} playlistId
   * @returns {boolean}
   */
  isPlayingPlaylist(playlistId) {
    return !!playlistId && this._registry.has(playlistId);
  }

  /**
   * Whether this engine is still live, i.e. stop() hasn't run on it. stop()
   * sets `_runId` to -1 specifically as a sentinel every pending callback
   * checks before acting - this getter reuses that same signal so a caller
   * (MusicController#transitionToContext) can tell "already running" apart
   * from "was replaced/torn down" without duplicating engine-internal state.
   * @returns {boolean}
   */
  get isRunning() {
    return this._runId !== -1;
  }

  /**
   * Re-resolve every currently-active Playlist node in this engine tree whose
   * reference tracks the world's active overlay (an indirect - 'scene'/'default'
   * - source with overlayMode 'active'), and swap just that node's running pass
   * to the newly-resolved target if it changed. The axis (mood for an 'area'
   * ref, phase for a 'combat' ref - config.mjs#sectionAxis) is whatever the
   * ref's own `section` says; this method doesn't care which.
   *
   * Called by MusicController#transitionToContext() whenever a re-resolution
   * (a mood or phase change, or otherwise) leaves the ROOT playlist unchanged,
   * so it skips the top-level restart - see that method's guard. Without this,
   * a Playlist node reading "this scene's combat playlist for whatever phase is
   * active right now" would only ever re-resolve the next time its OWN token
   * happens to re-enter it (or not at all, for a non-looping graph), even
   * though the whole point of overlayMode 'active' is to track live overlay
   * state. Deliberately scoped to ACTIVE nodes only: a node not currently
   * holding a token already resolves fresh, live state the next time it's
   * entered (_enterPlaylist calls resolvePlaylistRef() synchronously then) -
   * nothing to "catch up" there.
   *
   * Recurses into every child first (depth-first) so a reactive node nested
   * several Playlist-node levels deep is still reached, and does so
   * regardless of whether ITS OWN node happens to be reactive - the reactive
   * node could be anywhere in the subtree, not just at this level.
   * @returns {Promise<void>}
   */
  async refreshOverlayReactiveTargets() {
    // Any armed hand-off was planned against the world state this is reacting to
    // a change in; re-plan from scratch rather than commit a stale decision.
    this._cancelArmedHandoff();
    for (const child of [...this._children]) {
      await child.refreshOverlayReactiveTargets();
    }
    for (const [nodeId, entry] of [...this._activeNodes.entries()]) {
      if (!entry?.targetPlaylistId) continue; // not a Playlist node's entry (a track/delay)
      const node = this.graph.nodes.find((n) => n.id === nodeId);
      if (!node || node.type !== 'playlist') continue;
      const normalized = normalizePlaylistRef(node.playlistRef);
      if (normalized.source === 'direct' || normalized.overlayMode !== 'active') continue;

      const newTarget = resolvePlaylistRef(node.playlistRef);
      if (!newTarget || newTarget.id === entry.targetPlaylistId) continue;
      await this._swapPlaylistNodeTarget(node, newTarget);
    }
  }

  /**
   * Swap an already-running Playlist node's child pass to a newly-resolved
   * target, in place: stop and discard the old child, then start a fresh
   * pass (from pass 1 - loopCount restarts for the new target, exactly like
   * a fresh entry into the node) over the new one. Only ever called by
   * refreshOverlayReactiveTargets() above, for a node already confirmed active.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} newTarget - The freshly-resolved target Playlist document.
   * @returns {Promise<void>}
   * @private
   */
  async _swapPlaylistNodeTarget(node, newTarget) {
    const runId = this._runId;
    const entry = this._activeNodes.get(node.id);
    const oldChild = [...this._children].find((c) => c.playlist?.id === entry.targetPlaylistId);
    this._children.delete(oldChild);
    // Same ordering requirement as _onPassComplete's await below: a stale
    // child's sound must actually be stopped before anything - including the
    // new child about to start over the same underlying sound ids - can rely
    // on it being gone.
    await oldChild?.stop({ stopAudio: true });
    if (this._runId !== runId) return; // this engine stopped/restarted while awaiting

    this._registry.delete(entry.targetPlaylistId);
    if (this._registry.has(newTarget.id)) {
      // The newly-resolved target is already in flight elsewhere (self-reference
      // or cycle) - treat exactly like _skipPlaylistNode's D7 refusal: keep the
      // graph moving rather than stranding the token on an unplayable target.
      log(2, `CustomPlaybackEngine: playlist node '${node.id}' could not switch to its newly-resolved overlay target '${newTarget.id}' - already in flight (self-reference or cycle). Following its exit instead.`);
      await this._walk(() => {
        this._releasePlaylistNode(node);
        return this._followSingleExit(node.id, 0);
      });
      return;
    }

    entry.targetPlaylistId = newTarget.id;
    this._registry.add(newTarget.id);
    this._emitActivity();
    log(3, `CustomPlaybackEngine: playlist node '${node.id}' switched to '${newTarget.name}' after an active-overlay change.`);
    return this._runPlaylistPass(node, newTarget, runId, 1);
  }

  /**
   * This engine, or the descendant engine currently driving `playlistId`, else
   * null. Used by MusicController#getGraphActivity() to find which engine's
   * activityState to show when the graph editor is open on a playlist
   * currently running as a Playlist node's target rather than the root context.
   * @param {string} playlistId
   * @returns {CustomPlaybackEngine|null}
   */
  findEngineFor(playlistId) {
    if (!playlistId) return null;
    if (this.playlist?.id === playlistId) return this;
    for (const child of this._children) {
      const found = child.findEngineFor(playlistId);
      if (found) return found;
    }
    return null;
  }

  /**
   * The PlaylistSound documents currently owned by this engine's durational
   * (Track/Delay) nodes, plus every sound owned by a descendant engine a
   * Playlist node has spawned. Delay/Playlist nodes have no sound of their
   * own and are omitted at this level (their descendants' sounds still
   * surface via the recursive call).
   * @returns {Array<object>}
   */
  get activeSounds() {
    const own = [...this._activeNodes.values()].map((entry) => entry.sound).filter(Boolean);
    const fading = [...this._fadingOutSounds].filter((sound) => !own.includes(sound));
    const nested = [...this._children].flatMap((child) => child.activeSounds);
    return [...own, ...fading, ...nested];
  }

  /**
   * Run a token-advancing continuation as a tracked "walk", for idle
   * detection (_checkIdle). Idle must never be observed in the instant
   * between a durational node releasing its token and the next node
   * receiving it - so callers that release a node and then advance (a
   * Track's natural end, a Delay elapsing, a Playlist node's final pass
   * completing) do both inside ONE call to this, not as two separate,
   * untracked steps.
   * @param {() => Promise<void>|void} fn
   * @returns {Promise<*>}
   * @private
   */
  async _walk(fn) {
    this._pendingWalks++;
    try {
      return await fn();
    } finally {
      this._pendingWalks--;
      this._checkIdle();
    }
  }

  /**
   * Fire this run's onIdle callback (at most once) once there is no token
   * left anywhere in this engine's own graph: no walk currently in flight,
   * and no durational (track/delay/playlist) node holding one. This is how a
   * Playlist node's child engine (docs/playlist-node-plan.md D3) reports a
   * completed pass to its parent via _runPlaylistPass's `onIdle` option -
   * nothing else consumes this event.
   * @private
   */
  _checkIdle() {
    if (this._runId === -1 || this._idleFired) return;
    if (this._pendingWalks > 0 || this._activeNodes.size > 0) return;
    this._idleFired = true;
    this._onIdle?.();
  }

  /**
   * Move a token into a node and dispatch on its type. Tracked via _walk() so
   * idle detection sees every hop currently in flight. depth counts
   * instantaneous-node hops since the last durational node (or engine start)
   * and guards against an all-instantaneous cycle. Chained via awaited
   * promises rather than deep synchronous recursion, so a cycle can't runs
   * away or overflow the stack - the depth cap simply bounds how many hops a
   * single token walk performs before giving up.
   *
   * Callers that don't care when the walk settles (event/timer callbacks) may
   * invoke this without awaiting; start() awaits it so the caller can rely on
   * the initial walk (e.g. the first Track's playTrack call) having happened
   * by the time start() resolves.
   * @param {string} nodeId
   * @param {number} depth
   * @returns {Promise<void>}
   * @private
   */
  async _enterNode(nodeId, depth) {
    return this._walk(() => this._enterNodeInner(nodeId, depth));
  }

  /**
   * The actual per-node dispatch body of _enterNode(), split out so
   * _enterNode() itself can wrap every call (including this one recursing
   * into itself via _followSingleExit/_enterFork/etc.) in a tracked _walk().
   * @param {string} nodeId
   * @param {number} depth
   * @returns {Promise<void>}
   * @private
   */
  async _enterNodeInner(nodeId, depth) {
    if (this._runId === -1) return; // engine has been stopped
    if (depth > MAX_SYNCHRONOUS_DEPTH) {
      log(2, `CustomPlaybackEngine: aborted a walk that crossed ${depth} nodes without reaching a Track or Delay node (node '${nodeId}'). Check the graph for a cycle of only Fork/Random/Condition/Start nodes.`);
      return;
    }
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      log(1, `CustomPlaybackEngine: unknown node id '${nodeId}' referenced in graph for playlist '${this.playlist?.name}'.`);
      return;
    }
    // Canonical per-hop trace point: every transition, of every kind, ends
    // with a call here - logging once at this single chokepoint traces the
    // token's full path through the graph without needing a matching log at
    // every individual caller. Passed as a thunk (only invoked when debug
    // logging is actually on) since this fires on every single node hop.
    log(3, () => `CustomPlaybackEngine: token entered node '${node.id}' (${node.type})`);
    // Same rationale as the log above: emitting at this one chokepoint covers
    // every transition of every kind. Durational nodes emit again below once
    // they've actually registered themselves as active.
    this._emitActivity({ enteredNodeId: node.id });
    switch (node.type) {
      case 'start':
        return this._followSingleExit(node.id, depth);
      case 'end':
        return; // token terminates here
      case 'track':
        return this._enterTrack(node);
      case 'delay':
        return this._enterDelay(node);
      case 'fork':
        return this._enterFork(node, depth);
      case 'random':
        return this._enterRandom(node, depth);
      case 'condition':
        return this._enterCondition(node, depth);
      case 'playlist':
        return this._enterPlaylist(node);
      default:
        log(1, `CustomPlaybackEngine: unknown node type '${node.type}'.`);
    }
  }

  /**
   * Follow the single outgoing edge from a node (Start/Track/Delay all have
   * exactly one exit by schema validation).
   * @param {string} nodeId
   * @param {number} depth
   * @returns {Promise<void>}
   * @private
   */
  async _followSingleExit(nodeId, depth) {
    if (this._runId === -1) return;
    const edge = this.graph.edges.find((e) => e.from === nodeId);
    if (!edge) {
      // Start/Track/Delay are schema-validated to always have exactly one exit,
      // so this means the graph itself is missing an edge it should have -
      // worth a heads-up rather than the token just vanishing with no trace.
      log(2, `CustomPlaybackEngine: node '${nodeId}' has no outgoing edge; its token terminates here.`);
      return;
    }
    // Thunked for the same reason as _enterNode's per-hop log above: this
    // fires on every Start/Track/Delay hop.
    log(3, () => `CustomPlaybackEngine: '${nodeId}' -> '${edge.to}' (single exit)`);
    this._emitActivity({ traversedEdgeIds: [edge.id] });
    return this._enterNode(edge.to, depth + 1);
  }

  /**
   * Release a Track node's claim on _activeNodes and, if it's still the
   * recorded owner, its claim on _activeSoundOwners too. Always use this
   * (rather than _activeNodes.delete directly) for Track nodes so the two maps
   * can never drift apart and orphan an owner the way the pre-fix code did.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @private
   */
  _releaseTrackNode(node) {
    this._activeNodes.delete(node.id);
    if (this._activeSoundOwners.get(node.soundId) === node.id) {
      this._activeSoundOwners.delete(node.soundId);
    }
    this._emitActivity();
  }

  /**
   * Stop a sound and remember the in-flight stop, keyed by sound id, so a later
   * start of that same sound can wait for it (see _pendingStops' doc comment
   * and _enterTrack's use of it).
   *
   * Deliberately NOT awaited by most callers. controller.stopTrack() issues a
   * real Foundry document update, so awaiting it inline puts a full server
   * round-trip between the outgoing track's last sample and the incoming
   * track's first one - audible as a gap on every hand-off, even though the
   * two tracks almost never share a sound. Handing the ordering guarantee to
   * the one place that actually needs it keeps the guarantee and drops the gap.
   * @param {object} sound - PlaylistSound document.
   * @returns {Promise<void>} The underlying stop, for the rare caller that does want it.
   * @private
   */
  _stopTrackTracked(sound) {
    const promise = Promise.resolve(this.controller.stopTrack(sound)).catch(() => {});
    const soundId = sound?.id;
    if (!soundId) return promise;
    this._pendingStops.set(soundId, promise);
    promise.then(() => {
      // Only clear if it's still OURS - a newer stop for the same sound may
      // have replaced this entry while this one was settling, and dropping the
      // newer one would hand a start the stale "nothing pending" answer.
      if (this._pendingStops.get(soundId) === promise) this._pendingStops.delete(soundId);
    });
    return promise;
  }

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

  /**
   * Warn when a track is about to be faded by Foundry itself, which no amount
   * of engine-side timing can compensate for.
   *
   * A PlaylistSound's effective `fadeDuration` is `sound.fade ?? playlist.fade
   * ?? 0`, so setting Fade once on the PLAYLIST silently applies it to every
   * track in the graph. When it is non-zero, Foundry's PlaylistSound#_onStart
   * fades the track in from silence, and - for any non-repeating sound, i.e.
   * every `count: 1` Track node - also schedules a fade to zero starting
   * fadeDuration before the end of the file.
   *
   * The audible result is a dip to silence just before the seam and a ramp back
   * up just after it, on every hand-off. To a listener that is indistinguishable
   * from (and stacks on top of) a gap, but it originates in the playlist's own
   * configuration rather than anywhere in this engine. Reported rather than
   * overridden: `fade` is the user's setting on their own document, and a graph
   * is not necessarily the only way that playlist gets played.
   *
   * Fires at most once per sound per run - this is a configuration fact, not an
   * event, and repeating it on every loop would bury the log.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document.
   * @private
   */
  _warnIfFadeBreaksTheSeam(node, sound) {
    const fadeMs = sound?.fadeDuration;
    if (!fadeMs || fadeMs <= 0) return;
    if (this._warnedFadeSoundIds.has(sound.id)) return;
    this._warnedFadeSoundIds.add(sound.id);
    log(
      2,
      `CustomPlaybackEngine: track node '${node.id}' plays sound '${sound.name}' with a ${fadeMs}ms fade (PlaylistSound.fade, or inherited from the playlist's own Fade setting). ` +
        `Foundry fades it in from silence on start and, for a non-repeating sound, schedules a fade to zero ${fadeMs}ms before the file ends - ` +
        `which audibly breaks a seamless cut between two tracks regardless of how tightly this engine times the hand-off. Set Fade to 0 on the playlist (and on the sound) for gapless graphs.`
    );
  }

  /**
   * Ask the browser to fetch and decode the sound of every Track node a token
   * could reach next from `node`, while the current track is still playing.
   *
   * Without this, the next track's file is fetched and decoded only after
   * Foundry's playSound() document update resolves - i.e. entirely inside the
   * gap between the two tracks, where it is the single largest contributor for
   * anything but a tiny clip. Warming it here moves that cost into the current
   * track's playback, where it is inaudible.
   *
   * Fire-and-forget and fully defensive: a preload that fails (missing file,
   * network error, an environment with no Sound instance yet) must degrade to
   * exactly today's behaviour - a slower hand-off - never to a broken one.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node - Node currently playing.
   * @private
   */
  _preloadUpcoming(node) {
    let upcoming;
    try {
      upcoming = findUpcomingTrackNodes(this.graph, node.id);
    } catch (error) {
      log(2, 'CustomPlaybackEngine: lookahead for preloading threw; skipping it.', error);
      return;
    }
    for (const next of upcoming) {
      const soundId = next.soundId;
      if (!soundId || this._preloadedSoundIds.has(soundId)) continue;
      const upcomingSound = this.playlist?.sounds?.get(soundId);
      if (!upcomingSound) continue;
      if (upcomingSound.sound?.loaded === true) {
        // Already decoded (typically: this graph has looped and we warmed it on
        // an earlier lap). Record it anyway - the set doubles as the "was this
        // sound warm at hand-off time?" signal in the start-latency log, and
        // leaving it out made every second lap report `warm=false` for sounds
        // that were in fact fully decoded, which reads as a preload failure.
        this._preloadedSoundIds.add(soundId);
        continue;
      }
      // PlaylistSound#load() is the right entry point rather than
      // sound.sound.load(): Foundry creates the underlying Sound lazily, and
      // PlaylistSound#load() does `this.sound ||= this._createSound()` first -
      // so it also covers a track that has never played this session and has no
      // Sound instance yet, which is exactly the track a lookahead is for.
      const load = typeof upcomingSound.load === 'function' ? () => upcomingSound.load() : typeof upcomingSound.sound?.load === 'function' ? () => upcomingSound.sound.load() : null;
      if (!load) continue;
      this._preloadedSoundIds.add(soundId);
      log(3, () => `CustomPlaybackEngine: preloading upcoming track node '${next.id}' (sound '${soundId}')`);
      try {
        Promise.resolve(load()).catch((error) => {
          this._preloadedSoundIds.delete(soundId);
          log(2, `CustomPlaybackEngine: could not preload sound '${soundId}' for upcoming node '${next.id}'; it will load on demand instead.`, error);
        });
      } catch (error) {
        this._preloadedSoundIds.delete(soundId);
        log(2, `CustomPlaybackEngine: could not preload sound '${soundId}' for upcoming node '${next.id}'; it will load on demand instead.`, error);
      }
    }
  }

  /**
   * Enforce MIN_CLEAN_START_INTERVAL_MS between two "clean" (non-adopted)
   * starts of the same node id. Shared by Track (_enterTrack) and Playlist
   * (_enterPlaylist/_onPassComplete) nodes - both are durational and can
   * legitimately cycle back into themselves (a Track whose exit points at
   * itself; a Playlist node run for multiple passes, or one whose exit loops
   * back around to it) and both need the same rapid-restart-loop floor. See
   * MIN_CLEAN_START_INTERVAL_MS for why a durational cycle needs one at all.
   * @param {string} nodeId
   * @param {number} runId
   * @returns {Promise<boolean>} false if the engine was stopped/restarted while waiting.
   * @private
   */
  async _throttleNodeEntry(nodeId, runId) {
    const lastStart = this._lastCleanStartAt.get(nodeId) ?? 0;
    const waitMs = MIN_CLEAN_START_INTERVAL_MS - (Date.now() - lastStart);
    if (waitMs > 0) {
      // Precise: this floor sits directly between two tracks, so rounding it
      // up to the next tick is dead air the listener hears.
      await new Promise((resolve) => this.clock.schedule(`${nodeId}:throttle`, waitMs, resolve, { precise: true }));
      if (this._runId !== runId) return false;
    }
    this._lastCleanStartAt.set(nodeId, Date.now());
    return true;
  }

  /**
   * Play a Track node's sound loopCount times, then advance. See
   * custom-playlist-plan.md H3/H6 for why loops use native repeat + a timed
   * stop rather than replaying on each 'end' event (gapless looping), and why
   * pausedTime is always forced to 0 (graphs restart, never resume).
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @private
   */
  async _enterTrack(node) {
    const runId = this._runId;
    if (this._tripCircuitBreakerIfRunaway(node.id)) return;
    if (this._activeNodes.has(node.id)) return; // singleton: drop this token

    const sound = this.playlist?.sounds?.get(node.soundId);
    if (!sound) {
      log(1, `CustomPlaybackEngine: track node '${node.id}' references missing sound '${node.soundId}' in playlist '${this.playlist?.name}'.`);
      return;
    }

    // A different node already driving this exact sound is a resource
    // collision, not a fresh play - see _activeSoundOwners' doc comment.
    // Drop this token exactly like the singleton check above does; ownership
    // only frees up when the owning node's own playback genuinely ends.
    const currentOwner = this._activeSoundOwners.get(node.soundId);
    if (currentOwner && currentOwner !== node.id) {
      log(2, `CustomPlaybackEngine: dropped a token entering track node '${node.id}' - its sound is already being driven by node '${currentOwner}'. Two Track nodes should not both be reachable while referencing the same sound.`);
      return;
    }

    // Reserve this node synchronously, before any await below. Two tokens can
    // race into the same Track (e.g. two Fork branches converging on it); both
    // pass the check above in the same microtask since neither has awaited yet,
    // so the *registration* - not just the check - must happen before the first
    // await or the second racer would also start playback (singleton is the
    // graph's implicit merge mechanism and must stay atomic).
    this._activeNodes.set(node.id, { sound });
    this._activeSoundOwners.set(node.soundId, node.id);
    this._emitActivity();

    const loop = resolveLoop(node);
    const isForever = loop.mode === 'forever';
    const loopCount = loop.count;

    // Per-phase marks for the hand-off latency trace logged after the start
    // below. Cheap enough to collect unconditionally (four Date.now() calls);
    // only the formatting is gated behind debug logging.
    const enteredAt = Date.now();
    const marks = { stopWait: 0, throttle: 0, update: 0, play: 0 };

    // A stop for THIS sound may still be in flight - _stopTrackTracked no
    // longer awaits inline, precisely so a hand-off to a *different* sound
    // doesn't pay for it. This is the one case that must: starting a sound
    // whose stop hasn't landed yet lets the stop land last and silence a track
    // the engine believes is playing (the same race stop()'s own doc comment
    // describes across engines). Deliberately after the synchronous
    // registration above, which must not straddle an await.
    const pendingStop = this._pendingStops.get(node.soundId);
    if (pendingStop) {
      const stopWaitStart = Date.now();
      await pendingStop;
      marks.stopWait = Date.now() - stopWaitStart;
      if (this._runId !== runId) {
        this._releaseTrackNode(node); // engine stopped/restarted while awaiting
        return;
      }
    }

    // sound.playing (the PlaylistSound *document* field) only changes on an
    // explicit document update - it does NOT get corrected back to false when
    // the live audio naturally ends, so it goes stale forever the moment a
    // Track node advances via a natural 'end' rather than an explicit stop.
    // The live foundry.audio.Sound's own .playing is the ground truth once it
    // exists; only fall back to the document field before that instance exists
    // (a track truly carried over from a previous, non-custom-graph context).
    // Trusting the stale document field here (confirmed live) meant this branch
    // never stopped being taken, which is what let restarts cascade unthrottled.
    const alreadyPlaying = sound.sound ? sound.sound.playing === true : sound.playing === true;
    let elapsedMs = 0;
    // Native looping is wanted for every mode except a single-pass count - hoisted
    // out of the clean-start branch below because the armed path's verification
    // restart (_verifyArmedAudioStarted) has to reproduce the same loop setting.
    const wantRepeat = isForever || loop.mode === 'until' || loopCount > 1;

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
    // An arm for a DIFFERENT node has to be cancelled here, not merely ignored.
    //
    // Confirmed live (itest/specs/090-graph-nodes.spec.mjs, ~1 run in 3): two mechanisms can
    // advance a token at a seam - the 'end' watcher and the scheduled _commitArmedHandoff,
    // "whichever gets here first owns the hand-off". _commitArmedHandoff re-plans and cancels on a
    // mismatch. The 'end' watcher instead walks straight into _enterTrack, which used to do
    // nothing at all when the arm pointed elsewhere - and by then the armed sound's audio is
    // already scheduled on the audio clock and its document update already sent. It therefore
    // started underneath the track the walk actually chose and played to its natural end: the
    // probe measured a full 3s of two tones together.
    //
    // Worse, _armedHandoff stayed non-null forever, so every later seam bailed with
    // [already-armed] and degraded to path=clean - one mismatch silently disabled seamless
    // hand-offs for the rest of the session. That is the leak _armHandoff's own warning predicts
    // ("it should be cleared by _enterTrack or _cancelArmedHandoff"); this is _enterTrack's half.
    //
    // Only reachable when the walk can diverge from the prediction, i.e. a Random node upstream -
    // planNextHandoff draws afresh at arm time and again at commit time. A deterministic graph
    // always reaches the node it armed, which is why the sequential specs never saw this.
    else if (this._armedHandoff) {
      log(2, `CustomPlaybackEngine: cancelling the hand-off armed for '${this._armedHandoff.plan.nodeId}' - the walk entered '${node.id}' instead.`);
      this._cancelArmedHandoff();
    }
    const armedStarted = armedForThisNode && sound.sound?.playing === true;
    if (armedStarted) this._lastCleanStartAt.set(node.id, Date.now());

    if (armedStarted) {
      // Nothing to do *yet*: the audio and the document update both happened at
      // arm time. An armed start that did NOT actually take (the update landed
      // late and PlaylistSound#_onStart stopped it) falls through to the
      // ordinary paths below instead, which is the intended degradation.
      //
      // "Started" here can only mean Sound#playing, which is also true for a
      // sound still counting out its arm delay - the delay is the whole point,
      // and at the seam the two are genuinely indistinguishable. So the check
      // that it REALLY started is deferred, not skipped: see
      // _verifyArmedAudioStarted, scheduled once the node is fully set up.
    } else if (alreadyPlaying) {
      // Adopt a track that's already audibly playing (e.g. carried over from the
      // previous context) instead of restarting it from position 0.
      //
      // First take it off any fade-out already scheduled to stop it. `playing` stays true for the
      // whole of a fade-out, so "already playing" on its own cannot tell a live track from one
      // four seconds into its own funeral - adopting the latter yields a node holding a token on
      // audio that stops shortly afterwards, with no 'end' event ever fired. Confirmed live:
      // leaving a mood and returning inside the crossfade window silenced the layer for good.
      //
      // Yield here before touching the watcher below. If this _enterTrack call
      // was itself reached synchronously from inside another node's 'end'
      // dispatch on this same (shared) sound, calling addEventListener('end', ...)
      // while that dispatch is still on the call stack can get invoked again in
      // the very same pass, cascading synchronously - confirmed live: 16
      // restarts landed within ~12ms, far faster than any real audio duration.
      this.controller.cancelPendingFadeOut?.(sound);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this._runId !== runId) {
        this._releaseTrackNode(node); // engine stopped/restarted while awaiting
        return;
      }
      elapsedMs = (sound.sound?.currentTime || 0) * 1000;
    } else {
      // Rapid-restart-loop safety net - see MIN_CLEAN_START_INTERVAL_MS.
      const throttleStart = Date.now();
      if (!(await this._throttleNodeEntry(node.id, runId))) {
        this._releaseTrackNode(node); // engine stopped/restarted while awaiting
        return;
      }
      marks.throttle = Date.now() - throttleStart;

      // Skipped entirely when the document already means these values, which
      // is the common case for a plain "play once" track advancing in a chain.
      // The update is a real server round-trip, and one that changes nothing
      // still costs the full round-trip - straight in the middle of the hand-off.
      //
      // pausedTime must be compared as `?? 0`, NOT against 0 directly: Foundry's
      // own Playlist#stopSound writes `pausedTime: null`, and PlaylistSound#sync
      // reads it as `this.pausedTime && !sound.playing ? this.pausedTime :
      // undefined` - so null already means "start from the beginning" and there
      // is nothing to clear. Comparing against 0 made the guard true for every
      // track that had ever been stopped, i.e. every hand-off in a chain, so the
      // skip never actually fired (measured live: a steady ~30ms update on every
      // transition, half the total gap, until this was corrected).
      if ((sound.pausedTime ?? 0) !== 0 || sound.repeat !== wantRepeat) {
        const updateStart = Date.now();
        await sound.update({ pausedTime: 0, repeat: wantRepeat });
        marks.update = Date.now() - updateStart;
        if (this._runId !== runId) {
          this._releaseTrackNode(node); // engine stopped/restarted while awaiting
          return;
        }
      }
      const playStart = Date.now();
      await this.controller.playTrack(sound);
      marks.play = Date.now() - playStart;
      // This IS a playlist document update and its server response, which is
      // exactly what the hand-off lead has to cover - see _handoffLeadMs.
      this._recordUpdateRtt(marks.play);
      if (this._runId !== runId) {
        this._stopTrackTracked(sound);
        this._releaseTrackNode(node);
        return;
      }
      if (!(sound.sound?.playing === true || sound.playing === true)) {
        // MusicController.playTrack() deliberately swallows AbortError/"interrupted"
        // rejections with no logging (harmless for a native transition, where the
        // old track is being discarded anyway). Here it's not harmless: if the
        // sound never actually started, attaching the 'end' watcher below would
        // wait forever for an event that's never coming - a silent stop with no
        // sign of failure anywhere. Release and retry instead; the retry is
        // itself bounded by the per-node throttle above and the circuit breaker.
        log(2, `CustomPlaybackEngine: track node '${node.id}' did not actually start playing after playTrack() (likely a silently-aborted/interrupted play) - retrying.`);
        this._releaseTrackNode(node);
        return this._enterTrack(node);
      }
    }

    this.controller._managedSoundIds.add(sound.id);
    const path = armedStarted ? 'armed' : alreadyPlaying ? 'adopted' : 'clean';
    log(
      3,
      `CustomPlaybackEngine: track '${node.id}' ${armedStarted ? 'took over its armed' : alreadyPlaying ? 'adopted' : 'started'} sound '${node.soundId}' (${
        isForever ? 'forever' : loop.mode === 'until' ? 'until' : `loopCount=${loopCount}`
      })`
    );
    // Hand-off latency breakdown: how long this node took from "token arrived"
    // to "audio confirmed playing", and where that time went. This is the
    // measurement to read when a gap between two tracks is audible - each mark
    // maps to one removable cost (a stop round-trip for a shared sound, the
    // rapid-restart floor, a document update, Foundry's own playSound round-trip
    // plus any fetch/decode a preload didn't cover).
    //
    // `path=armed` is the good case and MUST be loggable: this used to be gated
    // behind `if (!alreadyPlaying)`, and an armed start necessarily has
    // sound.sound.playing === true, hence alreadyPlaying === true - so the one
    // outcome worth confirming was the one outcome that printed nothing at all.
    // A success signal you cannot observe is not a success signal.
    // Thunked: it runs on every hand-off.
    log(
      3,
      () =>
        `CustomPlaybackEngine: track '${node.id}' start latency ${Date.now() - enteredAt}ms path=${path} ` +
        `(stopWait=${marks.stopWait}ms throttle=${marks.throttle}ms update=${marks.update}ms play=${marks.play}ms, ` +
        `warm=${this._preloadedSoundIds.has(node.soundId)}, ` +
        `lead=${this._handoffLeadMs()}ms rtt=${Math.round(this._updateRttMs ?? 0)}ms` +
        (path === 'clean' && this._lastArmBail ? `, whyNotArmed=${this._lastArmBail.reason}@${this._lastArmBail.nodeId}` : '') +
        ')'
    );

    this._warnIfFadeBreaksTheSeam(node, sound);
    this._assertMixedVolume(node, sound, armedStarted, runId);
    if (armedStarted) this._verifyArmedAudioStarted(node, sound, wantRepeat, runId);
    this._recordTrackTiming(node, sound, loop, elapsedMs, runId);

    // Warm the NEXT track's buffer while this one plays - see _preloadUpcoming.
    this._preloadUpcoming(node);

    if (isForever) {
      // Loops forever via native repeat and has no exit (schema-validated) -
      // this node holds the token permanently. No watcher, no scheduled stop:
      // there is nothing to advance to, and nothing should ever restart it.
      return;
    }
    if (loop.mode === 'until') {
      // Also plays via native repeat (set above, same as forever) - the only
      // difference is WHEN this node takes its one exit. See
      // _scheduleConditionalExit's own doc comment.
      this._scheduleConditionalExit(node, sound, loop, elapsedMs, runId);
      return;
    }
    if (loopCount === 1) {
      // Optional: hand off early and overlap the two tracks, instead of waiting
      // for the 'end' event. Falls through to the watcher below either way -
      // see _scheduleCrossfadeHandoff for why the watcher stays armed.
      this._scheduleCrossfadeHandoff(node, sound, elapsedMs, runId);
      // Decide what plays next and start it on the audio clock at the seam. A
      // no-op when the crossfade is on (that mechanism owns the seam instead) or
      // when the graph shape can't be planned - see _queueNextHandoff.
      this._queueNextHandoff(node, sound, elapsedMs, runId);
      this.watcher.watch(sound, async () => {
        if (this._runId !== runId) return;
        // The track ended before the seam we computed (a short file, a bad
        // probe, a mid-track stop). The armed start is either already running -
        // in which case _enterTrack adopts it below - or is scheduled for a seam
        // that has now passed; either way this callback owns the advance from
        // here, so retire the scheduled commit.
        this.clock.cancel(`${node.id}:seam`);
        log(3, `CustomPlaybackEngine: track '${node.id}' finished naturally, advancing`);
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
        //
        // NOT awaited before advancing, in either case. It used to be, because
        // the very next node may reference this same sound and a clean start
        // racing an in-flight stop would have the stop land last and silence a
        // track the engine thinks is playing. That guarantee now lives in
        // _stopTrackTracked/_pendingStops, which makes only a start of the SAME
        // sound wait - so the ordering is still enforced, but a hand-off to a
        // different sound (nearly every hand-off) no longer spends a full
        // server round-trip in silence before the next track can begin.
        this._clearPlayingFlagAfterNaturalEnd(sound);
        // The release and the follow-up hop happen inside ONE tracked walk -
        // see _walk()'s doc comment for why splitting them in two would let
        // idle detection observe a false "nothing left to do" in between.
        await this._walk(async () => {
          this._releaseTrackNode(node);
          await this._followSingleExit(node.id, 0);
        });
      });
    } else {
      this._scheduleLoopStop(node, sound, loopCount, elapsedMs, runId);
    }
  }

  /**
   * Record how long ONE pass of this Track's sound runs, and when the current
   * pass began, on the node's _activeNodes entry - which is what _activeTimings()
   * broadcasts and the editor turns into the Track node's drain overlay.
   *
   * Its own probe rather than a value borrowed from the exit schedule: two of
   * the three loop modes never probe at all (a 'forever' track has no exit to
   * schedule, and a single-play track only probes when the crossfade is on), so
   * reusing those would leave the drain dark in exactly the cases where a
   * running track is most worth seeing. Hence the explicit clock key - see
   * _probeDuration.
   *
   * `iterations` is null for 'forever'/'until', which run an unknown number of
   * passes: the editor repeats the drain indefinitely for those and stops after
   * exactly `count` passes for a fixed loop. `startedAt` is the start of the
   * FIRST pass, not the current one - the editor derives the position within a
   * pass from the elapsed time, so an editor opened three loops in picks the
   * drain up mid-sweep instead of restarting it.
   *
   * Cosmetic, so a probe failure is a debug line and nothing else: this must
   * never affect whether or when the track advances.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document.
   * @param {import('./custom-playback-schema.mjs').LoopSpec} loop
   * @param {number} elapsedMs - Position at entry (non-zero only when adopting).
   * @param {number} runId
   * @private
   */
  _recordTrackTiming(node, sound, loop, elapsedMs, runId) {
    const startedAt = Date.now() - elapsedMs;
    const iterations = loop.mode === 'count' ? loop.count : null;
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const entry = this._activeNodes.get(node.id);
        // The node may have advanced, been released, or been taken over by a
        // newer entry while the probe was retrying.
        if (this._runId !== runId || entry?.sound !== sound) return;
        entry.durationMs = duration * 1000;
        entry.startedAt = startedAt;
        entry.iterations = iterations;
        this._emitActivity();
      },
      () => log(3, () => `CustomPlaybackEngine: track '${node.id}' reported no duration; its editor countdown stays idle.`),
      'timing'
    );
  }

  /**
   * The effective hand-off crossfade for THIS playlist, in ms, or 0 when the
   * feature is off. Resolved down the chain in playlist-mix.mjs:
   *
   *   mix.crossfadeMs  ??  graph.crossfadeMs (legacy)  ??  world setting
   *
   * The mixer window (playlist-mixer.mjs) is where this is set now, and it
   * writes the first link. The middle link is where the graph editor used to
   * store it, and is still read so graphs already saved in live worlds keep
   * their override with no migration - it is simply never written any more.
   *
   * Every link preserves an explicit 0, which means "never crossfade this
   * playlist" even if the world default is non-zero - distinct from "no
   * override" (null), which falls through to the next link. Read live rather
   * than cached: a GM changing any of them mid-session should affect the next
   * hand-off, not require a reload.
   * @returns {number}
   * @private
   */
  _crossfadeMs() {
    let worldMs = 0;
    try {
      worldMs = game.settings.get(CONST.moduleId, CONST.settings.graphCrossfade);
    } catch (error) {
      worldMs = 0; // settings not registered (tests, early boot) - feature simply off
    }
    return resolveCrossfadeMs({
      mix: getPlaylistMix(this.playlist),
      legacyGraphMs: resolveGraphCrossfadeMs(this.graph),
      worldMs
    });
  }

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

  /**
   * Overlap this Track with whatever comes next, instead of butt-splicing on
   * its 'end' event.
   *
   * Even with every avoidable cost removed (see _stopTrackTracked,
   * _preloadUpcoming, and the pausedTime/repeat skip in _enterTrack), one cost
   * remains structurally: the 'end' event only fires once the outgoing source
   * has fully stopped, and the next track's audio then starts only after
   * Foundry's own playSound() document update resolves. Measured live on a
   * local server that residual is ~20-30ms, and for two tracks cut to run
   * together it is audible as a click or a stutter at the seam.
   *
   * Handing off `crossfadeMs` EARLY and fading the outgoing track out across
   * the overlap hides it: the next track is already at full volume when the
   * previous one would have ended, so there is no instant of silence to hear.
   *
   * Deliberate design choices:
   * - **Only the outgoing track fades.** The incoming one starts at full
   *   volume. Graph tracks are typically cut to continue from one another, so
   *   fading the new one IN would introduce exactly the dip this exists to
   *   remove - this is an overlap, not an equal-power crossfade between two
   *   unrelated pieces.
   * - **The 'end' watcher stays armed.** This schedule is a wall-clock estimate
   *   built from a probed duration; the watcher is the ground truth. If the
   *   estimate is late, or the duration probe fails, or the track ends early,
   *   the watcher advances exactly as it does today. Whichever fires first
   *   retires the node, and the other finds it already released.
   * - **Skipped when the next track reuses this sound.** One Sound cannot play
   *   two positions at once, so there is nothing to overlap with - a
   *   same-sound hand-off keeps the plain path.
   *
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document.
   * @param {number} elapsedMs - Position at entry (non-zero only when adopting).
   * @param {number} runId
   * @private
   */
  _scheduleCrossfadeHandoff(node, sound, elapsedMs, runId) {
    const crossfadeMs = this._crossfadeMs();
    if (crossfadeMs <= 0) return;
    if (typeof sound.sound?.fade !== 'function') return; // nothing to fade with

    // One physical Sound can't overlap itself.
    const upcoming = findUpcomingTrackNodes(this.graph, node.id);
    if (upcoming.length === 0 || upcoming.some((n) => n.soundId === node.soundId)) return;

    const startedAt = Date.now() - elapsedMs;
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const handoffAt = startedAt + duration * 1000 - crossfadeMs;
        const delay = handoffAt - Date.now();
        // A track shorter than the crossfade itself (or one whose duration only
        // became known past the hand-off point) has no overlap to give. Leave
        // it to the watcher rather than starting the next track immediately,
        // which would cut this one off almost as soon as it began.
        if (delay <= 0) {
          log(3, () => `CustomPlaybackEngine: track '${node.id}' is too short for a ${crossfadeMs}ms crossfade; using its natural end instead.`);
          return;
        }
        // Precise: this IS the seam. Rounding it up to the next tick would
        // reintroduce exactly the gap the crossfade exists to hide.
        this.clock.schedule(`${node.id}:xfade`, delay, () => this._beginCrossfadeHandoff(node, sound, crossfadeMs, runId), { precise: true });
      },
      () => {
        // No usable duration means no computable seam. The watcher already
        // covers this case, so there is nothing to degrade to - just log.
        log(3, () => `CustomPlaybackEngine: track '${node.id}' reported no duration; crossfade skipped, advancing on its natural end instead.`);
      }
    );
  }

  /**
   * Start the overlap: fade the outgoing track out, advance the graph now, and
   * stop the outgoing track once the fade has finished. Shared by the natural-end
   * crossfade (_scheduleCrossfadeHandoff) and the timed loop boundary
   * (_scheduleLoopStop).
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document.
   * @param {number} crossfadeMs
   * @param {number} runId
   * @private
   */
  _beginCrossfadeHandoff(node, sound, crossfadeMs, runId) {
    if (this._runId !== runId) return;
    // The watcher (or a stop, or a re-resolve) may have retired this node
    // already - whichever mechanism gets here first owns the advance.
    if (this._activeNodes.get(node.id)?.sound !== sound) return;
    // Disarm the watcher: this node is advancing now, and letting the 'end'
    // event fire a second advance later would double-hop the token.
    this.watcher.unwatch(sound.id);

    log(3, () => `CustomPlaybackEngine: track '${node.id}' crossfading out over ${crossfadeMs}ms while the next track starts`);
    try {
      sound.sound.fade(0, { duration: crossfadeMs });
    } catch (error) {
      log(2, `CustomPlaybackEngine: could not fade out track node '${node.id}'; it will be cut instead.`, error);
    }

    // Tracked so stop() can still clear this sound's persisted `playing` flag:
    // the node is released below, so the sound is no longer reachable through
    // _activeNodes, and without this a teardown mid-fade would leave it marked
    // playing in the world and resurrect it on the next page load.
    this._fadingOutSounds.add(sound);
    this.clock.schedule(`xfade-stop:${sound.id}`, crossfadeMs, () => {
      this._fadingOutSounds.delete(sound);
      if (this._runId !== runId) return;
      // Another node may have taken this sound over during the overlap; stopping
      // it now would silence a track the engine believes is playing.
      if (this._activeSoundOwners.has(sound.id)) return;
      this._stopTrackTracked(sound);
    });

    // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
    this._walk(async () => {
      this._releaseTrackNode(node);
      await this._followSingleExit(node.id, 0);
    });
  }

  /**
   * Record and log why a hand-off could not be armed. Both, always: the log
   * line explains it where it happens, and the record carries it forward onto
   * the next track's start-latency line, which is where a listener who just
   * heard a gap will actually be looking.
   * @param {string} nodeId - The OUTGOING node whose seam went unarmed.
   * @param {string} reason - Short machine-greppable slug.
   * @param {string} detail - Human-readable explanation.
   * @private
   */
  _noteArmBail(nodeId, reason, detail) {
    this._lastArmBail = { nodeId, reason };
    log(2, `CustomPlaybackEngine: not arming a hand-off at '${nodeId}' [${reason}] - ${detail}`);
  }

  /**
   * Once this Track's duration is known, decide what plays next and arm it to
   * start on the audio clock at the exact seam (docs/gapless-handoff-plan.md
   * G3/Q1). Only for a plain single-play track: every other loop mode either has
   * no knowable seam ('forever'/'until') or already schedules its own boundary
   * (a fixed count, which this does not yet cover).
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
    // Every bail below logs a REASON. An arming failure is silent by nature -
    // playback still works, it just still has the gap - so without these the
    // only evidence is a `path=clean` line that says nothing about why. That
    // cost a debugging round-trip once; don't make a bail path quiet again.
    const crossfadeMs = this._crossfadeMs();
    if (crossfadeMs > 0) {
      // The crossfade is an alternative answer to the same problem and already
      // hands off early on its own schedule. Two mechanisms racing for one seam
      // would double-hop the token; the crossfade wins where it is enabled.
      this._noteArmBail(node.id, 'crossfade', `a ${crossfadeMs}ms crossfade is configured and owns the seam instead. Set Crossfade (ms) to 0 on this graph, and the world 'graphCrossfade' setting, to use gapless arming.`);
      return;
    }

    const plan = this._planNextHandoff(node, sound);
    if (!plan) {
      this._noteArmBail(node.id, 'unplannable', "what follows it can't be planned ahead - a Fork, Delay or Playlist node on the way, a next track reusing this sound, or an already-busy target. See planNextHandoff.");
      return;
    }

    const startedAt = Date.now() - elapsedMs;
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const seamAt = startedAt + duration * 1000;
        const armAt = seamAt - this._handoffLeadMs();
        if (armAt - Date.now() <= 0) {
          this._noteArmBail(node.id, 'too-short', `only ${Math.round(seamAt - Date.now())}ms of it left, less than the ${this._handoffLeadMs()}ms lead.`);
          return;
        }
        log(3, () => `CustomPlaybackEngine: will arm '${plan.nodeId}' in ${Math.round(armAt - Date.now())}ms (seam in ${Math.round(seamAt - Date.now())}ms, lead ${this._handoffLeadMs()}ms)`);
        this.clock.schedule(`${node.id}:arm`, armAt - Date.now(), () => this._armHandoff(node, sound, plan, seamAt, runId), { precise: true });
      },
      () => this._noteArmBail(node.id, 'no-duration', 'it never reported a usable duration, so there is no seam to compute.'),
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
   * Arm a hand-off for a seam the engine picks ITSELF rather than one dictated
   * by a track ending - currently an until-loop's escape (_scheduleConditionalExit).
   *
   * Unlike the natural-end case there is no future boundary to work backwards
   * from: the moment is "now". So the seam is placed one hand-off lead into the
   * future instead, which delays the transition by 60-100ms and in exchange
   * removes the next track's document round-trip from the seam entirely.
   *
   * Two things differ from a natural-end arm, and both are load-bearing:
   * - `stopOutgoing` - the outgoing track is being cut mid-loop, so no 'end'
   *   event is coming and nothing else will stop it or clear its flag.
   * - `onDiscard` - if the plan is invalidated at the seam there is no 'end'
   *   watcher to fall back on, so the caller's plain exit must run instead or
   *   the token is stranded forever on a node that has already decided to leave.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - The outgoing PlaylistSound document.
   * @param {number} runId
   * @param {() => void} onDiscard - The caller's plain, un-armed exit.
   * @returns {boolean} true if the hand-off was armed and the caller should stand down.
   * @private
   */
  _tryArmTimedExit(node, sound, runId, onDiscard) {
    if (this._crossfadeMs() > 0) return false; // the crossfade owns the seam
    const plan = this._planNextHandoff(node, sound);
    if (!plan) {
      this._noteArmBail(node.id, 'unplannable', "what follows this timed exit can't be planned ahead - see planNextHandoff.");
      return false;
    }
    return this._armHandoff(node, sound, plan, Date.now() + this._handoffLeadMs(), runId, { stopOutgoing: true, onDiscard });
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
  _armHandoff(node, sound, plan, seamAt, runId, { stopOutgoing = false, onDiscard = null } = {}) {
    if (this._runId !== runId) return false;
    if (this._activeNodes.get(node.id)?.sound !== sound) return false; // already advanced
    if (this._armedHandoff) {
      // A leaked entry here disables arming for the REST OF THE RUN, silently -
      // every later seam bails on this line. Loud on purpose.
      this._noteArmBail(node.id, 'already-armed', `a hand-off to '${this._armedHandoff.plan.nodeId}' is still armed. If this repeats, an armed hand-off is leaking - it should be cleared by _enterTrack or _cancelArmedHandoff.`);
      return false;
    }

    const nextSound = this.playlist?.sounds?.get(plan.soundId);
    const rawSound = nextSound?.sound;
    if (!nextSound || typeof rawSound?.play !== 'function' || rawSound.loaded !== true) {
      this._noteArmBail(
        node.id,
        'sound-not-ready',
        `sound '${plan.soundId}' for node '${plan.nodeId}' is ${!nextSound ? 'missing from the playlist' : !rawSound ? 'without a Sound instance (never preloaded)' : 'not decoded yet'}.`
      );
      return false;
    }

    // A delayed start is only as reliable as the clock it waits on, and that
    // clock is the AudioContext itself: Sound#play({delay}) awaits an
    // AudioTimeout built from an AudioBufferSourceNode on this context, and a
    // context that isn't running never fires its `onended`. The Sound then sits
    // in STARTING forever - see ARMED_START_VERIFY_MS for the full damage. The
    // ordinary clean start has no such dependency (no delay, no wait), so
    // bailing here costs one seam's gaplessness and nothing else.
    //
    // Only bail on a state we can positively read as wrong: a Sound with no
    // context at all is not evidence of a suspended one.
    const contextState = rawSound.context?.state;
    if (contextState && contextState !== 'running') {
      this._noteArmBail(node.id, 'audio-suspended', `the AudioContext is '${contextState}', so the armed start's delay would never elapse. Starting '${plan.nodeId}' the ordinary way instead.`);
      return false;
    }

    const nextNode = this.graph.nodes.find((n) => n.id === plan.nodeId);
    const nextLoop = resolveLoop(nextNode);
    const repeat = nextLoop.mode !== 'count' || nextLoop.count > 1;
    const delaySeconds = Math.max(0, seamAt - Date.now()) / 1000;

    try {
      // mixedVolume(), not the raw document volume: this is the one place the engine starts
      // audio itself instead of letting PlaylistSound#sync() do it, so it is also the one place
      // the playlist's mix would otherwise be skipped - the track would start at full level and
      // only be pulled down a moment later by the re-assert in playlist-mix-apply.mjs, audibly.
      rawSound.play({ delay: delaySeconds, volume: mixedVolume(nextSound), loop: repeat, offset: 0, fade: 0 });
    } catch (error) {
      log(2, `CustomPlaybackEngine: could not arm the audio for node '${plan.nodeId}'; it will start the ordinary way instead.`, error);
      return false;
    }

    this._armedHandoff = { fromNodeId: node.id, fromSound: sound, plan, nextSound, repeat, seamAt, runId, stopOutgoing, onDiscard };
    Promise.resolve(this.controller.playTrack(nextSound)).catch(() => {});
    log(3, () => `CustomPlaybackEngine: armed '${plan.nodeId}' (sound '${plan.soundId}') to start in ${Math.round(delaySeconds * 1000)}ms`);

    this.clock.schedule(`${node.id}:seam`, Math.max(0, seamAt - Date.now()), () => this._commitArmedHandoff(runId), { precise: true });
    return true;
  }

  /**
   * Level a track this engine just started to its mixed volume - the playlist's mix, and any
   * active layer duck.
   *
   * The engine cannot leave this to `handleUpdatePlaylistSoundMix`, even though that hook exists
   * to do exactly this job on every client. Two engine-specific holes, both confirmed by reading
   * Foundry's own source rather than deduced:
   *
   * 1. **The hook often never fires.** A PlaylistSound's `playing` document field is not corrected
   *    back to false when audio ends naturally (see the `alreadyPlaying` comment in _enterTrack),
   *    so on a graph's second pass over a track it is already `true`. `Playlist#playSound()` then
   *    writes `playing: true` over `playing: true`, the diff is empty, and no `updatePlaylistSound`
   *    fires at all. The mix and the duck are simply skipped for that track, for that pass.
   * 2. **On an armed hand-off the hook fires, and is then discarded.** `Sound##queuePlay` captures
   *    the volume at `play()` time, waits out the arm delay, and only *then* assigns
   *    `this.volume` - and `set volume` calls `gain.cancelScheduledValues()`, killing any ramp
   *    set in between. So everything the mix layer does during the arm window (including
   *    reassertDuck() when a layer starts) is wiped at the seam. Hence the deferral below:
   *    the assert has to land AFTER `_play()`, not before it.
   *
   * Idempotent and cheap - applyMixToSound() is a single `Sound#fade` to a value the sound is
   * usually already at, and playlistNeedsMix() is not consulted here on purpose: the caller
   * already knows this sound is one the engine drives.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document.
   * @param {boolean} armedStarted - Whether this start was adopted from an armed hand-off.
   * @param {number} runId
   * @private
   */
  _assertMixedVolume(node, sound, armedStarted, runId) {
    const apply = () => {
      if (this._runId !== runId) return;
      if (this._activeNodes.get(node.id)?.sound !== sound) return; // already advanced
      applyMixToSound(sound, { duration: 0 });
    };
    if (!armedStarted) return apply();
    this.clock.schedule(`${node.id}:mix`, MIX_ASSERT_DELAY_MS, apply, { precise: true });
  }

  /**
   * Confirm, a short while after adopting an armed hand-off, that the audio it
   * armed actually began - and restart it in place if it did not.
   *
   * The failure this exists for is total and silent (see ARMED_START_VERIFY_MS):
   * the Sound is stuck in Foundry's STARTING state, which reports
   * `playing === true` while never producing a sample, so every downstream
   * check - the seam's own adoption test, the document's `playing` flag, the
   * 'end' watcher - is satisfied by a track that will never play or end. The
   * graph then holds that node forever.
   *
   * `Sound#startTime` is the discriminator, and the only one: it is assigned
   * immediately after Foundry's internal `_play()` and cleared back to undefined
   * on stop, so `playing && (startTime === undefined)` means precisely "still
   * waiting out its delay". Any *other* shape - started normally, already ended,
   * stopped, replaced by a newer node - falls through untouched.
   *
   * Recovery restarts the Sound rather than re-entering the node: `stop()`
   * cancels the wedged delay deterministically (it calls `#delay.cancel()`,
   * which lets the abandoned `#queuePlay` unwind without ever starting), and a
   * plain undelayed `play()` cannot wedge the same way. The node keeps its
   * token, its 'end' watcher (registered on the Sound instance, which survives a
   * stop/play cycle) and its exit schedule - the cost is that those schedules
   * are now ~ARMED_START_VERIFY_MS ahead of the audio, which is a far better
   * outcome than permanent silence.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound - PlaylistSound document adopted from the armed hand-off.
   * @param {boolean} wantRepeat - Native loop setting this node's loop mode calls for.
   * @param {number} runId
   * @private
   */
  _verifyArmedAudioStarted(node, sound, wantRepeat, runId) {
    this.clock.schedule(`${node.id}:armcheck`, ARMED_START_VERIFY_MS, () => {
      if (this._runId !== runId) return;
      if (this._activeNodes.get(node.id)?.sound !== sound) return; // already advanced
      const rawSound = sound.sound;
      // `'startTime' in` before reading it: a Sound implementation that doesn't
      // carry the field at all (something other than foundry.audio.Sound) would
      // otherwise read as permanently un-started and be restarted on every
      // single armed hand-off. Absent evidence, do nothing.
      if (!rawSound || rawSound.playing !== true || !('startTime' in rawSound) || rawSound.startTime !== undefined) return;

      log(2, `CustomPlaybackEngine: the armed audio for track '${node.id}' (sound '${node.soundId}') never actually started - it is still waiting out a delay that will never elapse. Restarting it now.`);
      Promise.resolve(rawSound.stop())
        .catch(() => {})
        .then(() => {
          if (this._runId !== runId) return;
          if (this._activeNodes.get(node.id)?.sound !== sound) return;
          try {
            // No `delay` - that is the entire point. mixedVolume() for the same
            // reason _armHandoff uses it: this starts the audio directly, so
            // PlaylistSound#sync() is not there to apply the playlist's mix.
            rawSound.play({ volume: mixedVolume(sound), loop: wantRepeat, offset: 0, fade: 0 });
          } catch (error) {
            log(1, `CustomPlaybackEngine: could not restart the wedged audio for track '${node.id}'.`, error);
          }
        });
    });
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
      const onDiscard = armed.onDiscard;
      this._cancelArmedHandoff();
      // A natural-end arm can simply let the 'end' watcher advance the token.
      // An engine-timed arm (an until-loop's escape) has NO watcher - its sound
      // is playing on native repeat and will never fire 'end' - so without this
      // the token would be stranded on a node whose exit condition has already
      // matched. Silent, permanent, and exactly the failure mode this codebase
      // keeps getting bitten by.
      onDiscard?.();
      return;
    }

    for (const decision of armed.plan.decisions) {
      if (decision.historyAfter) this._recentPicks.set(decision.nodeId, decision.historyAfter);
    }
    this.watcher.unwatch(armed.fromSound.id);
    this._emitActivity({ traversedEdgeIds: armed.plan.edgeIds });
    if (armed.stopOutgoing) {
      // The outgoing track is being CUT, not finishing: it is playing on native
      // repeat, so no 'end' event is coming and Foundry will never clear its
      // flag by itself. Stop the audio locally first - that is immediate, where
      // the document round-trip is not, and without it both tracks stay audible
      // together for a round-trip, which is the overlap this whole mechanism
      // exists to avoid.
      try {
        armed.fromSound.sound?.stop?.();
      } catch (error) {
        log(2, `CustomPlaybackEngine: could not stop the outgoing sound at the seam for node '${armed.fromNodeId}'.`, error);
      }
      this._stopTrackTracked(armed.fromSound);
    } else {
      this._clearPlayingFlagAfterNaturalEnd(armed.fromSound);
    }

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

  /**
   * Wait for the sound's duration to be known, then schedule a stop at
   * loopCount * duration - elapsedMs so a seamlessly-looping (repeat: true)
   * track advances the graph after its Nth loop without ever relying on an
   * 'end' event (undocumented whether one fires per loop iteration - H3).
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound
   * @param {number} loopCount
   * @param {number} elapsedMs
   * @param {number} runId
   * @private
   */
  _scheduleLoopStop(node, sound, loopCount, elapsedMs, runId) {
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const totalMs = loopCount * duration * 1000 - elapsedMs;
        // Pull the boundary forward by the crossfade so the overlap straddles
        // the seam rather than running past it, exactly like the natural-end
        // path. Only when there is somewhere else to overlap WITH: a boundary
        // whose next track reuses this sound, or that has no next track at all,
        // keeps the hard cut. 0 when the feature is off.
        const upcoming = findUpcomingTrackNodes(this.graph, node.id);
        const canOverlap =
          typeof sound.sound?.fade === 'function' && upcoming.length > 0 && !upcoming.some((n) => n.soundId === node.soundId);
        const crossfadeMs = canOverlap ? Math.min(this._crossfadeMs(), Math.max(0, totalMs)) : 0;
        // Precise: this is the seam between two tracks in a graph that never
        // sees an 'end' event (H3) - the engine picks the moment itself, so
        // any slop here is audible silence at a boundary it fully controls.
        this.clock.schedule(node.id, Math.max(0, totalMs - crossfadeMs), () => {
          if (this._runId !== runId) return;
          log(3, `CustomPlaybackEngine: track '${node.id}' completed ${loopCount} loop(s), advancing`);
          if (crossfadeMs > 0) return this._beginCrossfadeHandoff(node, sound, crossfadeMs, runId);
          this._stopTrackTracked(sound);
          // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
          this._walk(async () => {
            this._releaseTrackNode(node);
            await this._followSingleExit(node.id, 0);
          });
        }, { precise: true });
      },
      () => {
        log(
          2,
          `CustomPlaybackEngine: track '${node.id}' (sound '${node.soundId}') never reported a usable duration after ${MAX_DURATION_PROBE_ATTEMPTS} probe attempts - giving up and advancing instead of waiting forever.`
        );
        this._stopTrackTracked(sound);
        // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
        this._walk(async () => {
          this._releaseTrackNode(node);
          await this._followSingleExit(node.id, 0);
        });
      }
    );
  }

  /**
   * Wait for a sound's duration to become known, retrying every 100ms up to
   * MAX_DURATION_PROBE_ATTEMPTS. Shared by _scheduleLoopStop (a fixed-count
   * loop) and _scheduleConditionalExit (loop.mode 'until'), which each handle
   * a probe failure differently - see their own doc comments for why giving
   * up means something different for each.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound
   * @param {number} runId
   * @param {(duration: number) => void} onReady
   * @param {() => void} onGiveUp
   * @param {string} [key] - Suffix for this probe's clock entry. EngineClock keys
   *   are unique - re-scheduling one REPLACES it - so two probes running against
   *   the same node at the same time (the exit schedule and the editor's drain,
   *   which both start from _enterTrack) would otherwise silently cancel each
   *   other's retry, and whichever lost would never fire again. The default is
   *   the exit-scheduling probe's own key; any concurrent probe must pass its own.
   * @private
   */
  _probeDuration(node, sound, runId, onReady, onGiveUp, key = 'probe') {
    let attempts = 0;
    const probe = () => {
      if (this._runId !== runId) return;
      const duration = sound.sound?.duration;
      if (!duration || !sound.sound?.loaded) {
        attempts++;
        if (attempts >= MAX_DURATION_PROBE_ATTEMPTS) {
          onGiveUp();
          return;
        }
        // Duration not known yet; retry shortly. Mirrors the readiness-retry
        // pattern already used by _fadeInWhenReady in music-controller.mjs.
        // This is a genuine 100ms cadence (so MAX_DURATION_PROBE_ATTEMPTS is
        // the ~2s its doc comment claims) only since EngineClock's tick came
        // down to match; at the old 500ms tick each retry waited a full tick,
        // making the real cap nearer 10s.
        this.clock.schedule(`${node.id}:${key}`, 100, probe);
        return;
      }
      onReady(duration);
    };
    probe();
  }

  /**
   * loop.mode 'until': the track plays seamlessly via native repeat (set by
   * the caller, same as 'forever') until `loop.condition` matches, then takes
   * the node's one exit - a "forever" loop with an escape hatch.
   *
   * `minLoops` is enforced by computing the earliest wall-clock time the node
   * is allowed to exit (minLoops * duration), via the same duration probe
   * _scheduleLoopStop uses. minLoops is always >= 1 (resolveLoop's floor), and
   * a floor of "at least 1 loop" is only meaningful if it's measured against a
   * real loop duration - so both boundaries always probe, with no minLoops <= 1
   * fast path. (An earlier version of this method skipped the probe and used
   * an earliest-exit time of `startedAt` - i.e. 0 loops - whenever minLoops was
   * merely <= 1, silently reproducing the exact zero-length, condition-already-
   * true-on-entry glitch minLoops exists to prevent, since 1 is minLoops'
   * default. Confirmed by inspection, not live - fixed before shipping.) If the
   * probe fails (missing file, decode failure), minLoops/maxLoops are dropped
   * rather than either hanging forever or forcing an immediate exit: a probe
   * failure here should degrade the minLoops REFINEMENT, not the whole
   * feature - unlike _scheduleLoopStop's give-up (a bounded loop with nowhere
   * else to go), an indefinite until-loop is still useful without it.
   *
   * boundary 'immediate' polls the condition on EngineClock's cadence and
   * exits the instant it matches, once past the minLoops floor. boundary
   * 'loopEnd' instead computes each upcoming loop-boundary timestamp
   * (startedAt + N * duration) from the same probed duration and checks only
   * there, so the exit always lands on a clean loop edge rather than mid-loop.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} sound
   * @param {import('./custom-playback-schema.mjs').LoopSpec} loop
   * @param {number} elapsedMs - Position within the current loop iteration at entry (adoption only).
   * @param {number} runId
   * @private
   */
  _scheduleConditionalExit(node, sound, loop, elapsedMs, runId) {
    const startedAt = Date.now() - elapsedMs;
    // Baseline for 'moodChanged'/'phaseChanged' (see _evaluateCondition) - this
    // loop's own start, not the run's. A long-running 'forever'-with-escape
    // track can outlive several unrelated mood/phase changes that happened
    // before it was even entered; only a change from HERE on should count.
    const baseline = {
      moodAtStart: game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '',
      phaseAtStart: game.settings.get(CONST.moduleId, CONST.settings.activePhase) || ''
    };

    /** Cut the track and hop immediately - the original, un-armed behaviour. */
    const exitImmediately = () => {
      this._stopTrackTracked(sound);
      // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
      this._walk(async () => {
        this._releaseTrackNode(node);
        await this._followSingleExit(node.id, 0);
      });
    };

    const exitNow = () => {
      log(3, `CustomPlaybackEngine: track '${node.id}' loop-until condition matched ('${loop.condition?.kind}'), advancing`);
      // Hand off through the arming machinery when we can: an until-loop's exit
      // is a seam the ENGINE picks, so it can simply be picked a hand-off lead
      // later than the condition was noticed, and the next track started on the
      // audio clock exactly there.
      //
      // The cost is that the phase/mood change is reacted to `lead` ms (60-100)
      // later than it was detected. That is far below the UNTIL_POLL_INTERVAL_MS
      // (500ms) jitter the detection itself already carries, and it buys a
      // gapless seam - whereas exiting the instant the condition matches puts
      // the next track's full playSound() round-trip in the seam, which is
      // audible (measured live: 58ms of silence at a phase change).
      //
      // These are the transitions that matter most in practice - they are the
      // dramatic ones - so it was a mistake to leave them un-armed on the
      // reasoning that "engine-timed boundaries already schedule themselves".
      // Being engine-timed is precisely what makes them armable.
      if (this._tryArmTimedExit(node, sound, runId, exitImmediately)) return;
      exitImmediately();
    };

    // boundary 'immediate': poll the condition every tick once past the
    // minLoops floor (or maxLoops cap), exiting the instant it matches.
    const pollImmediate = (earliestExitAt, maxExitAt) => {
      const tick = () => {
        if (this._runId !== runId) return;
        const now = Date.now();
        if (maxExitAt != null && now >= maxExitAt) return exitNow();
        if (now >= earliestExitAt && this._evaluateCondition(loop.condition, baseline)) return exitNow();
        this.clock.schedule(`${node.id}:until`, UNTIL_POLL_INTERVAL_MS, tick);
      };
      tick();
    };

    // boundary 'loopEnd': check only at each upcoming loop-boundary timestamp
    // (never mid-loop), starting from whichever boundary minLoops permits,
    // and force an exit at the maxLoops boundary if the condition never matches.
    const scheduleLoopEndCheck = (duration, minLoops, maxLoops) => {
      const checkAtBoundary = (loopIndex) => {
        const boundaryAt = startedAt + loopIndex * duration * 1000;
        // Precise for the same reason as _scheduleLoopStop's boundary: the
        // whole point of boundary 'loopEnd' is to land the exit exactly on a
        // clean loop edge rather than near one.
        this.clock.schedule(`${node.id}:until`, Math.max(0, boundaryAt - Date.now()), () => {
          if (this._runId !== runId) return;
          if (this._evaluateCondition(loop.condition, baseline) || (maxLoops != null && loopIndex >= maxLoops)) return exitNow();
          checkAtBoundary(loopIndex + 1);
        }, { precise: true });
      };
      checkAtBoundary(Math.max(1, minLoops));
    };

    if (loop.boundary === 'loopEnd') {
      this._probeDuration(
        node,
        sound,
        runId,
        (duration) => scheduleLoopEndCheck(duration, loop.minLoops, loop.maxLoops),
        () => {
          log(
            2,
            `CustomPlaybackEngine: track '${node.id}' (sound '${node.soundId}') never reported a usable duration - falling back to immediate boundary checking for its loop-until condition instead of waiting forever for a loop boundary that can't be computed.`
          );
          pollImmediate(startedAt, null);
        }
      );
      return;
    }

    // boundary 'immediate': needs the probed duration too, to place the
    // minLoops floor at least one full loop after entry rather than at 0.
    this._probeDuration(
      node,
      sound,
      runId,
      (duration) => {
        const earliestExitAt = startedAt + loop.minLoops * duration * 1000;
        const maxExitAt = loop.maxLoops != null ? startedAt + loop.maxLoops * duration * 1000 : null;
        pollImmediate(earliestExitAt, maxExitAt);
      },
      () => {
        log(
          2,
          `CustomPlaybackEngine: track '${node.id}' (sound '${node.soundId}') never reported a usable duration - ignoring minLoops/maxLoops and polling its loop-until condition from now.`
        );
        pollImmediate(startedAt, null);
      }
    );
  }

  /**
   * Wait a fixed or random interval, then follow the single exit. Durational
   * and subject to the singleton rule, exactly like Track.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @private
   */
  async _enterDelay(node) {
    const runId = this._runId;
    if (this._activeNodes.has(node.id)) return; // singleton: drop this token

    const min = node.delay?.min ?? 0;
    const max = Math.max(min, node.delay?.max ?? min);
    const ms = (min + this._rng() * (max - min)) * 1000;

    this._activeNodes.set(node.id, { sound: null, durationMs: ms, startedAt: Date.now() });
    this._emitActivity();
    log(3, `CustomPlaybackEngine: delay '${node.id}' waiting ${Math.round(ms)}ms`);
    this.clock.schedule(node.id, Math.max(0, ms), () => {
      if (this._runId !== runId) return;
      log(3, `CustomPlaybackEngine: delay '${node.id}' elapsed, advancing`);
      // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
      this._walk(async () => {
        this._activeNodes.delete(node.id);
        this._emitActivity();
        await this._followSingleExit(node.id, 0);
      });
    });
  }

  /**
   * Spawn a token on every outgoing edge at once, for concurrent playback.
   * Two branches later converging on the same durational node are resolved by
   * the singleton rule, which acts as an implicit merge (no Join node needed).
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {number} depth
   * @private
   */
  async _enterFork(node, depth) {
    const edges = this.graph.edges.filter((e) => e.from === node.id);
    log(3, `CustomPlaybackEngine: fork '${node.id}' spawning ${edges.length} branch(es): ${edges.map((e) => e.to).join(', ')}`);
    this._emitActivity({ traversedEdgeIds: edges.map((e) => e.id) });
    await Promise.all(edges.map((edge) => this._enterNode(edge.to, depth + 1)));
  }

  /**
   * Follow exactly one outgoing edge, chosen by weighted random draw among
   * edges not currently in cooldown. If every edge is cooling down, cooldowns
   * are ignored for this draw rather than deadlocking the graph.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {number} depth
   * @private
   */
  async _enterRandom(node, depth) {
    const edges = this.graph.edges.filter((e) => e.from === node.id);
    if (edges.length === 0) return;

    // The draw itself lives in custom-playback-schema.mjs so the predictive
    // lookahead (planNextHandoff) makes the identical choice from the identical
    // inputs - two copies of this logic would drift, and a lookahead that picked
    // a different exit than the live walk would arm the wrong track.
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

  /**
   * Follow the first outgoing edge whose condition matches current game state,
   * evaluated at the moment the token arrives (custom-playlist-plan.md H7 - not
   * re-evaluated live if state changes mid-track). No match and no 'default'
   * edge means the token simply terminates here.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {number} depth
   * @private
   */
  async _enterCondition(node, depth) {
    const edges = this.graph.edges.filter((e) => e.from === node.id);
    const baseline = { moodAtStart: this._moodAtStart, phaseAtStart: this._phaseAtStart };
    for (const edge of edges) {
      if (this._evaluateCondition(edge.condition, baseline)) {
        log(3, `CustomPlaybackEngine: condition '${node.id}' -> '${edge.to}' (matched '${edge.condition?.kind}')`);
        this._emitActivity({ traversedEdgeIds: [edge.id] });
        return this._enterNode(edge.to, depth + 1);
      }
    }
    log(3, `CustomPlaybackEngine: no Condition exit matched at node '${node.id}'; token terminates.`);
  }

  /**
   * @param {import('./custom-playback-schema.mjs').GraphCondition} condition
   * @param {{moodAtStart?: string, phaseAtStart?: string}} [baseline] - Required for
   *   'moodChanged'/'phaseChanged': the overlay value to compare the current one against. Every
   *   caller supplies its own - _enterCondition uses this run's _moodAtStart/_phaseAtStart (set in
   *   start()); _scheduleConditionalExit captures its own at loop start, since a loop can outlive
   *   (and re-poll long after) the run it began in.
   * @returns {boolean}
   * @private
   */
  _evaluateCondition(condition, baseline = {}) {
    if (!condition) return false;
    switch (condition.kind) {
      case 'default':
        return true;
      case 'combatActive':
        return !!game.combat?.started;
      case 'combatIdle':
        return !game.combat?.started;
      case 'mood':
        return (game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '') === condition.value;
      case 'phase':
        return (game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '') === condition.value;
      case 'moodChanged':
        return (game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '') !== (baseline.moodAtStart ?? '');
      case 'phaseChanged':
        return (game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '') !== (baseline.phaseAtStart ?? '');
      case 'enemiesDefeated': {
        const combatants = game.combat?.combatants?.contents || Array.from(game.combat?.combatants ?? []);
        const enemies = combatants.filter((c) => c.isNPC);
        return enemies.length > 0 && enemies.every((c) => c.isDefeated);
      }
      default:
        return false;
    }
  }

  /**
   * Release a Playlist node's claim on _activeNodes and on the shared
   * in-flight registry (see the constructor's `_registry` doc comment).
   * Always use this rather than _activeNodes.delete directly, for Playlist
   * nodes, so the two can never drift apart and strand a registry entry -
   * which would make that playlist permanently unreferenceable by any other
   * Playlist node for the rest of the session.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @private
   */
  _releasePlaylistNode(node) {
    const entry = this._activeNodes.get(node.id);
    this._activeNodes.delete(node.id);
    if (entry?.targetPlaylistId) this._registry.delete(entry.targetPlaylistId);
    this._emitActivity();
  }

  /**
   * A Playlist node that could not start a pass (unresolvable reference,
   * self/cycle collision with the shared registry, or too deeply nested) is
   * treated as a zero-length pass: it keeps the graph moving instead of
   * stranding the token on, say, a scene mood override nobody configured yet
   * (docs/playlist-node-plan.md D7). Bounded by the same entry throttle a real
   * pass gets, so a self-looping exit can't spin. An infinite node has no
   * exit to follow and simply terminates here - exactly like Track, it holds
   * its token forever once it *does* start, so a refusal that can never be
   * retried is the only other option.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {number} runId
   * @private
   */
  async _skipPlaylistNode(node, runId) {
    if (resolveLoop(node).mode === 'forever') return;
    if (!(await this._throttleNodeEntry(node.id, runId))) return;
    if (this._runId !== runId) return;
    return this._followSingleExit(node.id, 0);
  }

  /**
   * Play another playlist by its own rules (docs/playlist-node-plan.md). A
   * "pass" is one complete run of a child CustomPlaybackEngine over the
   * target's own stored graph, or - when it has none - a graph synthesized
   * from its native Foundry mode (native-mode-graph.mjs, plan D5). node.loop
   * counts passes, exactly like Track counts native-repeat loops.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @private
   */
  async _enterPlaylist(node) {
    const runId = this._runId;
    if (this._tripCircuitBreakerIfRunaway(node.id)) return;
    if (this._activeNodes.has(node.id)) return; // singleton: drop this token

    // Resolved synchronously, before any await below - two tokens can race
    // into the same Playlist node in the same microtask (e.g. two Fork
    // branches converging on it), exactly like _enterTrack's registration
    // race, so the registry check below must not straddle an await.
    const target = resolvePlaylistRef(node.playlistRef);
    let refusalReason = null;
    if (!target) refusalReason = 'its reference did not resolve to a playlist';
    else if (this._registry.has(target.id)) refusalReason = `playlist '${target.id}' is already in flight (self-reference or cycle)`;
    else if (this._depth + 1 > MAX_PLAYLIST_NESTING_DEPTH) refusalReason = `nesting would exceed the ${MAX_PLAYLIST_NESTING_DEPTH}-level limit`;

    if (refusalReason) {
      log(2, `CustomPlaybackEngine: playlist node '${node.id}' skipped a pass - ${refusalReason}.`);
      return this._skipPlaylistNode(node, runId);
    }

    this._activeNodes.set(node.id, { sound: null, targetPlaylistId: target.id });
    this._registry.add(target.id);
    this._emitActivity();

    if (!(await this._throttleNodeEntry(node.id, runId))) {
      this._releasePlaylistNode(node);
      return;
    }
    return this._runPlaylistPass(node, target, runId, 1);
  }

  /**
   * Run pass `passIndex` of a Playlist node: build a child engine over the
   * target's own graph (or one synthesized from its native mode), and chain
   * the next pass - or the node's exit - off that child going idle
   * (_onPassComplete). The child shares this engine's `_registry` BY
   * REFERENCE (plan D6) and is registered in `_children` before start() is
   * awaited, since onIdle can fire synchronously inside it (a trivial
   * Start -> End target).
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} target - The resolved target Playlist document.
   * @param {number} runId - This (parent) engine's run id when the node was entered.
   * @param {number} passIndex - 1-based.
   * @returns {Promise<void>}
   * @private
   */
  async _runPlaylistPass(node, target, runId, passIndex) {
    const graph = getCustomGraph(target) || buildNativeModeGraph(target, { rng: this._rng });
    const childContext = new PlaylistContext(
      this.playlistContext?.context ?? 'area',
      this.playlistContext?.contextEntity ?? null,
      target,
      null,
      0,
      null,
      false
    );
    const child = new CustomPlaybackEngine(childContext, this.controller, {
      graph,
      depth: this._depth + 1,
      registry: this._registry,
      onIdle: () => this._onPassComplete(node, target, runId, passIndex, child)
    });
    this._children.add(child);
    await child.start();
  }

  /**
   * A Playlist node's child engine has gone idle - one pass is complete. Retires
   * the child, then either starts the next pass or, once every pass is done,
   * releases the node and follows its exit. A `loop.mode === 'forever'` node
   * never reaches the release branch below: `total` is Infinity, so another
   * pass always starts instead - the node holds its token until the whole
   * engine stops, exactly like a forever-looping Track.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {object} target - The resolved target Playlist document.
   * @param {number} runId - This (parent) engine's run id when the pass was started.
   * @param {number} passIndex - The pass that just completed, 1-based.
   * @param {CustomPlaybackEngine} child
   * @private
   */
  async _onPassComplete(node, target, runId, passIndex, child) {
    if (this._runId !== runId) return; // this engine has since stopped/restarted
    this._children.delete(child);
    // Awaited before the next pass (or the exit) can proceed: the same race
    // stop()'s own doc comment describes for two Track nodes sharing a sound
    // applies here too - the next pass, or whatever this node's exit leads
    // to, may reference a sound this child was just told to stop.
    await child.stop({ stopAudio: true });
    if (this._runId !== runId) return;

    const loop = resolveLoop(node);
    const total = loop.mode === 'forever' ? Infinity : loop.count;
    if (passIndex < total) {
      if (!(await this._throttleNodeEntry(node.id, runId))) {
        this._releasePlaylistNode(node);
        return;
      }
      return this._runPlaylistPass(node, target, runId, passIndex + 1);
    }

    // See _walk()'s doc comment: release + follow-up hop as one tracked walk.
    await this._walk(async () => {
      this._releasePlaylistNode(node);
      await this._followSingleExit(node.id, 0);
    });
  }
}
