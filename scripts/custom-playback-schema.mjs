/**
 * @typedef {object} CustomGraph
 * @property {1} version
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {number|null} [crossfadeMs]  This playlist's override of the world's `graphCrossfade`
 *   setting (custom-playback-engine.mjs's hand-off crossfade) - null/absent defers to the world
 *   setting, 0 explicitly disables the crossfade for this playlist even if the world setting is
 *   non-zero, and any other non-negative number overrides it outright. Always read through
 *   resolveGraphCrossfadeMs(), never this field directly, so a malformed/legacy value (a graph
 *   saved before this field existed) normalizes the same way everywhere. Graph-level, not
 *   node-level, because the crossfade is a property of the hand-off itself, not of any one node -
 *   every Track node in the graph shares it.
 */

/**
 * @typedef {object} GraphNode
 * @property {string} id                       Unique within the graph.
 * @property {'start'|'end'|'track'|'fork'|'delay'|'random'|'condition'|'playlist'|'script'} type
 * @property {string} [label]                   User-facing name shown under the node and in
 *   validation messages. Absent on graphs saved before names existed, so readers must fall
 *   back to the type (custom-playlist-node-render.mjs#nodeDisplayLabel).
 * @property {number} x                         Canvas position (editor only; engine ignores).
 * @property {number} y
 * @property {string} [soundId]                 track: id of a PlaylistSound in this playlist.
 * @property {LoopSpec} [loop]                  track/playlist: how many times to play (track) or
 *   how many passes (playlist) before advancing, or loop forever. See LoopSpec below - use
 *   resolveLoop(node) rather than reading this field directly, so a missing/malformed value
 *   degrades the same way everywhere instead of each reader guessing its own default.
 * @property {{min: number, max: number}} [delay]  delay: seconds range ({n,n} = fixed).
 * @property {boolean} [avoidRepeat]            random: if true, never pick an exit leading to the
 *   same target node as the immediately-previous pick (falls back to allowing a repeat only if
 *   every remaining candidate also targets that node).
 * @property {PlaylistRef} [playlistRef]        playlist: what other playlist to play - see
 *   playlist-ref.mjs. Resolved when a token enters the node (docs/playlist-node-plan.md D4), never
 *   re-evaluated live mid-pass.
 * @property {ScriptSpec} [script]             script: what code to run - see ScriptSpec below.
 *   Read through resolveScript(node), never this field directly.
 */

/**
 * @typedef {object} ScriptSpec
 * @property {'macro'|'inline'} mode  'macro' (the default) stores a UUID and resolves it at run
 *   time, so editing the referenced Macro changes what the graph runs - which is what a GM assumes
 *   after dragging a macro onto the canvas. It also inherits core's Macro#canExecute permission
 *   check AND core's gating of script-macro *authorship*, which inline has no equivalent for.
 *   'inline' stores source on the node; it is governed entirely by the world's
 *   `allowInlineScripts` setting. See docs/api-and-script-node-plan.md B5.
 * @property {string|null} [macroUuid]  mode==='macro': the Macro document's uuid. A LIVE link -
 *   deliberately not a copy of the macro's source (D-B5). An unresolvable uuid degrades to a
 *   validation warning and a no-op that follows its exit, never to silence.
 * @property {string} [source]  mode==='inline': the script body. Runs as an AsyncFunction, so it
 *   may await. Its return value is ignored - a Script node has exactly one, unguarded exit, and
 *   routing by return value is rejected (node-anatomy.md R1).
 */

/**
 * @typedef {object} PlaylistRef
 * @property {'direct'|'scene'|'default'} source
 * @property {string|null} [playlistId]                 source==='direct': the target playlist's id.
 * @property {'area'|'combat'} [section]                source!=='direct': which music section to
 *   read. Also decides the overlay axis this ref reacts to (area -> mood, combat -> phase - see
 *   config.mjs#sectionAxis).
 * @property {'active'|'none'|'specific'} [overlayMode]  source!=='direct': how to pick a mood/phase
 *   override, per the section's own axis.
 * @property {string|null} [overlayId]                  overlayMode==='specific': the mood or phase
 *   id to use.
 */

/**
 * @typedef {object} GraphEdge
 * @property {string} id
 * @property {string} from                      Source node id.
 * @property {string} to                        Target node id.
 * @property {number} [weight]                  random source: relative weight (>=0).
 * @property {number} [cooldown]                random source: min other-picks before reuse.
 * @property {GraphCondition} [condition]       condition source: what must be true to follow.
 */

/**
 * @typedef {object} GraphCondition
 * @property {'combatActive'|'combatIdle'|'mood'|'phase'|'moodChanged'|'phaseChanged'|'enemiesDefeated'|'default'} kind
 *   'mood'/'phase' ("Mood/Phase Is" in the UI) match a specific overlay id via `value`.
 *   'moodChanged'/'phaseChanged' ("Mood/Phase Changes") take no value - they match once the
 *   overlay differs from what it was when the current graph run (or until-loop) began. See
 *   custom-playback-engine.mjs#_evaluateCondition.
 * @property {string} [value]                   e.g. mood/phase id for kind==='mood'|'phase'.
 *   'default' = else.
 */

/**
 * @typedef {object} LoopSpec
 * @property {'count'|'forever'|'until'} mode
 * @property {number} [count]  mode==='count': repetitions before advancing (>=1, coerced by
 *   resolveLoop). Absent/ignored otherwise.
 * @property {GraphCondition} [condition]  mode==='until' (Track nodes only - not Playlist): the
 *   escape condition, using the same vocabulary as a Condition node's exits (custom-playlist-plan.md
 *   H7 does not apply here - see overlays-and-loop-modes-plan.md L2/H12).
 * @property {'immediate'|'loopEnd'} [boundary]  mode==='until': 'immediate' interrupts the instant
 *   the condition becomes true; 'loopEnd' waits for the current loop iteration to finish first, so
 *   the exit lands on a clean loop boundary rather than mid-loop.
 * @property {number} [minLoops]  mode==='until': always complete at least this many loops before the
 *   condition is even checked (>=1, coerced). Without this, a condition that is already true the
 *   instant the node is entered would produce a zero-length, audibly glitchy loop.
 * @property {number} [maxLoops]  mode==='until': optional hard cap - exits after this many loops
 *   even if the condition never matches. null/absent = unbounded.
 */

/**
 * Condition kinds that are only meaningful alongside a `value` - the overlay id
 * they match against. Every other kind reads game state ('combatActive') or a
 * captured baseline ('moodChanged') and carries nothing to select.
 *
 * Lives here, next to the GraphCondition typedef, because three separate
 * modules need this exact answer and each had grown its own copy: the inspector
 * (whether to render a value `<select>`), the node renderer (whether an exit
 * chip names a value), and graph-validation (whether a missing value is an
 * error). A fourth kind added to two of three lists would silently disagree.
 */
export const CONDITION_KINDS_WITH_VALUE = new Set(['mood', 'phase']);

/**
 * Whether a condition names a kind that needs a value but has none - e.g. "Mood
 * Is …" with no mood picked. The engine can never match such a condition
 * (`_evaluateCondition` compares the active overlay id against `undefined`), so
 * the exit it guards is dead: graph-validation treats this as an error that
 * blocks saving, and the exit chip renders it as "(not set)".
 *
 * The emptiness test lives here rather than at each call site so "unset" means
 * the same thing to the validator and to the renderer - a whitespace-only value
 * is no more selectable than an absent one.
 * @param {GraphCondition} [condition]
 * @returns {boolean}
 */
export function conditionMissingValue(condition) {
  if (!CONDITION_KINDS_WITH_VALUE.has(condition?.kind)) return false;
  return String(condition.value ?? '').trim() === '';
}

/**
 * A stable string identifying what a condition MATCHES ON, for deciding whether
 * two exits are the same test. Two conditions share a signature exactly when no
 * game state could satisfy one but not the other.
 *
 * Only the kind and, for the kinds that carry one, the value participate - and
 * the value is trimmed for the same reason conditionMissingValue() trims it, so
 * ' tense' and 'tense' are one condition rather than two.
 *
 * Here rather than in graph-validation because it is the same knowledge
 * CONDITION_KINDS_WITH_VALUE encodes: which part of a condition is meaningful.
 * @param {GraphCondition} [condition]
 * @returns {string}
 */
export function conditionSignature(condition) {
  const kind = condition?.kind ?? '';
  if (!CONDITION_KINDS_WITH_VALUE.has(kind)) return kind;
  return `${kind}:${String(condition.value ?? '').trim()}`;
}

/** Current schema version written by this module. */
export const CUSTOM_GRAPH_VERSION = 1;

/**
 * The loop spec a freshly-created track/playlist node starts with: play once,
 * then advance.
 * @returns {LoopSpec}
 */
export function createDefaultLoop() {
  return { mode: 'count', count: 1 };
}

/**
 * The loop spec a Track node switches to when its loop mode is set to "loop
 * until a condition is met".
 * @returns {LoopSpec}
 */
export function createDefaultUntilLoop() {
  return { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null };
}

/**
 * Resolve a track/playlist node's effective loop spec, coercing a missing or
 * malformed value the same way everywhere (mirrors this module's own
 * `Math.max(1, node.loopCount || 1)` pre-union default). Always use this
 * rather than reading `node.loop` directly.
 * @param {import('./custom-playback-schema.mjs').GraphNode} node
 * @returns {LoopSpec}
 */
export function resolveLoop(node) {
  const loop = node?.loop;
  if (loop?.mode === 'forever') return { mode: 'forever' };
  if (loop?.mode === 'until') {
    const minLoops = Math.max(1, parseInt(loop.minLoops, 10) || 1);
    const maxLoops = loop.maxLoops != null ? Math.max(minLoops, parseInt(loop.maxLoops, 10) || minLoops) : null;
    return {
      mode: 'until',
      condition: loop.condition?.kind ? loop.condition : { kind: 'default' },
      boundary: loop.boundary === 'loopEnd' ? 'loopEnd' : 'immediate',
      minLoops,
      maxLoops
    };
  }
  return { mode: 'count', count: Math.max(1, loop?.count || 1) };
}

/**
 * The script spec a freshly-created Script node starts with: macro mode, nothing
 * referenced yet. Unconfigured is a no-op that follows its exit, never a runtime
 * error - a placeholder mid-authoring is legitimate.
 * @returns {ScriptSpec}
 */
export function createDefaultScript() {
  return { mode: 'macro', macroUuid: null };
}

/**
 * Resolve a Script node's effective spec, coercing a missing or malformed value
 * the same way everywhere. Always use this rather than reading `node.script`.
 *
 * This matters more than resolveLoop's equivalent, because `script` is a
 * DISCRIMINATED UNION and this codebase has already paid for collapsing one:
 * routing a Track's `loop` through anything that flattened it on the way out of
 * the Drawflow bridge silently reverted every `until` loop to a 1-count loop the
 * moment any other field on the node changed. Both directions of
 * graph-drawflow-bridge.mjs route `script` through here for that reason.
 * @param {GraphNode} node
 * @returns {ScriptSpec}
 */
export function resolveScript(node) {
  const script = node?.script;
  if (script?.mode === 'inline') return { mode: 'inline', source: typeof script.source === 'string' ? script.source : '' };
  return { mode: 'macro', macroUuid: script?.macroUuid || null };
}

/**
 * Node types that hold a token for real time and therefore participate in the
 * singleton (one-active-instance) rule. Instantaneous types are excluded.
 *
 * `script` is durational, and that single choice is most of the Script node's
 * design: it inherits the singleton rule (one execution at a time, no
 * re-entrancy), the 300ms entry throttle (bounding a Script->Script cycle), the
 * circuit breaker, and non-idle bookkeeping so a parent Playlist node waits for
 * it. It also means hasInstantaneousCycle does NOT reject Script->Condition->
 * Script, which is one of the shapes people most want. Making it instantaneous
 * would forfeit all five.
 */
export const DURATIONAL_NODE_TYPES = new Set(['track', 'delay', 'playlist', 'script']);

/** Node types that pass a token through synchronously (no elapsed time). */
export const INSTANTANEOUS_NODE_TYPES = new Set(['start', 'fork', 'random', 'condition', 'end']);

export const ALL_NODE_TYPES = new Set(['start', 'end', 'track', 'fork', 'delay', 'random', 'condition', 'playlist', 'script']);

/**
 * Hop cap for findUpcomingTrackNodes()'s forward walk. A graph can chain a long
 * run of Fork/Random/Condition nodes between two Tracks; this bounds the search
 * the same way MAX_SYNCHRONOUS_DEPTH bounds the engine's real walk, so a
 * malformed instantaneous cycle can't spin the lookahead either (the visited
 * set already prevents that - this is the belt to its braces).
 */
const MAX_LOOKAHEAD_HOPS = 32;

/**
 * Every Track node a token could reach next from `nodeId`, without passing
 * through another Track first - i.e. the set of sounds that might need to start
 * the moment this node advances.
 *
 * Crosses the instantaneous types (Fork/Random/Condition/Start) and Delay,
 * since the track after a delay is still the next audio to play, and stops at
 * Track/Playlist/End. Every branch of a Fork/Random/Condition is followed: at
 * lookahead time there is no way to know which exit the engine will actually
 * take, and the caller (CustomPlaybackEngine#_preloadUpcoming) only uses this to
 * warm an audio buffer, where an extra candidate costs a decode and a wrong
 * guess costs nothing.
 *
 * Pure: takes the graph, returns node objects, touches no Foundry state.
 * @param {CustomGraph} graph
 * @param {string} nodeId - Node to look ahead FROM (not included in the result).
 * @returns {GraphNode[]} Reachable Track nodes, in discovery order, deduplicated.
 */
export function findUpcomingTrackNodes(graph, nodeId) {
  const nodes = graph?.nodes;
  const edges = graph?.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !nodeId) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const found = [];
  const foundIds = new Set();
  const visited = new Set([nodeId]);
  let frontier = edges.filter((e) => e.from === nodeId).map((e) => e.to);

  for (let hop = 0; hop < MAX_LOOKAHEAD_HOPS && frontier.length > 0; hop++) {
    const next = [];
    for (const id of frontier) {
      if (visited.has(id)) continue;
      visited.add(id);
      const node = byId.get(id);
      if (!node) continue;
      if (node.type === 'track') {
        // A Track terminates this branch of the walk - whatever follows it is
        // two hand-offs away and not worth warming yet.
        if (!foundIds.has(node.id)) {
          foundIds.add(node.id);
          found.push(node);
        }
        continue;
      }
      // Script is CROSSED, like Delay: the track after a script is still the next audio to warm,
      // and warming a buffer costs a decode while a wrong guess costs nothing.
      if (node.type === 'end' || node.type === 'playlist') continue;
      for (const edge of edges) if (edge.from === id) next.push(edge.to);
    }
    frontier = next;
  }
  return found;
}

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
    // A weighted draw against zero total weight would otherwise always fall
    // through to the last candidate (roll is always 0, and `0 < 0` never
    // matches), silently picking one fixed exit instead of the "off"/uniform
    // behavior a user zeroing every weight would expect. Pick uniformly instead.
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
 *   - a Script node: its duration is unknowable AND its side effects may change what a later
 *     Condition resolves to, so arming across one would predict from state the script is about to
 *     invalidate. Conservative on purpose - it costs the hand-off optimisation, never correctness;
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
      // Track and Start both have exactly one exit by schema validation, so
      // this mirrors _followSingleExit rather than making a choice.
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
      return null; // fork / delay / playlist / script / end / unknown - see the doc comment
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

/**
 * Build a minimal valid skeleton graph: a single Start node with no exit yet.
 * @returns {CustomGraph}
 */
export function createEmptyGraph() {
  return {
    version: CUSTOM_GRAPH_VERSION,
    nodes: [{ id: 'start', type: 'start', x: 40, y: 40 }],
    edges: [],
    crossfadeMs: null
  };
}

/**
 * Resolve a graph's per-playlist crossfade override, coercing a missing or
 * malformed value to null the same way everywhere. Always use this rather
 * than reading `graph.crossfadeMs` directly.
 * @param {CustomGraph} graph
 * @returns {number|null} A non-negative ms override, or null to defer to the
 *   world's `graphCrossfade` setting.
 */
export function resolveGraphCrossfadeMs(graph) {
  const raw = graph?.crossfadeMs;
  if (raw === null || raw === undefined) return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
