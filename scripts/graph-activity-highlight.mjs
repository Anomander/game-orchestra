import { INSTANTANEOUS_NODE_TYPES } from './custom-playback-schema.mjs';

/**
 * Turns a CustomPlaybackEngine activity payload ('gameOrchestraGraphActivity') into
 * the set of nodes and connections the editor should light up, plus the CSS
 * selectors to find those connections in Drawflow's rendered DOM.
 *
 * Pure data/string transforms only - no DOM, no Drawflow, no live Foundry - so
 * the highlight logic is unit-testable in isolation, in the same spirit as
 * graph-drawflow-bridge.mjs and graph-validation.mjs.
 *
 * Two categories, because durational and instantaneous nodes behave very
 * differently in time (custom-playback-schema.mjs):
 *
 * - **Active**: Track/Delay nodes actually holding a token right now, and (when
 *   unambiguous) the single exit edge they will leave by. Held until the engine
 *   says otherwise.
 * - **Pulse**: Start/Fork/Random/Condition/End nodes, and the edges just
 *   followed. A token crosses these instantly, so without a short-lived
 *   highlight the traversal would be invisible and the highlight would appear to
 *   teleport between tracks.
 */

/** Matches the edge ids drawflowExportToGraph() mints: `<from>:output_<n>-><to>`. */
const EDGE_ID_PATTERN = /:(output_\d+)->/;

/**
 * Recover the Drawflow output port an edge leaves by from its id. Only edges
 * that came through drawflowExportToGraph() carry one; anything else (a
 * hand-written or legacy graph) returns null and callers fall back to a
 * port-less selector.
 * @param {string} edgeId
 * @returns {string|null} e.g. 'output_2'
 */
export function portFromEdgeId(edgeId) {
  return EDGE_ID_PATTERN.exec(String(edgeId ?? ''))?.[1] ?? null;
}

/**
 * @typedef {object} EdgeRef
 * @property {string} from
 * @property {string} to
 * @property {string|null} port - Drawflow output port name, when known.
 */

/**
 * CSS selector for a rendered connection, matching the class list Drawflow puts
 * on each `<svg class="connection">`: `node_in_node-<target>`,
 * `node_out_node-<source>`, plus the output and input port names.
 *
 * Every part is optional and simply widens what matches when left out:
 *
 * - no `port`: EVERY connection between that pair of nodes, so a node wired to
 *   the same target twice highlights both. That's the accepted degradation for
 *   an edge id we couldn't parse a port out of - it over-highlights rather than
 *   silently highlighting nothing.
 * - no `to`: whatever a given output port is wired to, without having to know
 *   the target first (what the inspector's exit-row hover needs).
 * @param {EdgeRef} edge
 * @returns {string}
 */
export function edgeSelector({ from, to, port } = {}) {
  let selector = '.connection';
  if (to != null) selector += `.node_in_node-${to}`;
  if (from != null) selector += `.node_out_node-${from}`;
  if (port) selector += `.${port}`;
  return selector;
}

/**
 * @param {import('./custom-playback-schema.mjs').GraphEdge} edge
 * @returns {EdgeRef}
 */
function toEdgeRef(edge) {
  return { from: edge.from, to: edge.to, port: portFromEdgeId(edge.id) };
}

/**
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph - The editor's
 *   working graph. May legitimately differ from the graph the engine is running
 *   (the user can be mid-edit), so every lookup here tolerates a miss.
 * @param {object|null} payload - A 'gameOrchestraGraphActivity' payload, or null to clear.
 * @returns {{activeNodeIds: string[], pulseNodeIds: string[], activeEdges: EdgeRef[], pulseEdges: EdgeRef[],
 *   activeTimings: Array<{nodeId: string, durationMs: number, startedAt: number, iterations: number|null, type: string}>}}
 */
export function computeHighlight(graph, payload) {
  const empty = { activeNodeIds: [], pulseNodeIds: [], activeEdges: [], pulseEdges: [], activeTimings: [] };
  if (!payload) return empty;

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const activeNodeIds = (payload.activeNodeIds || []).filter((id) => nodeById.has(id));

  // A durational node's exit is "known" only when it has exactly one - which is
  // the schema-validated shape for Track and Delay. Zero exits (an infinite
  // Track, or a graph mid-edit) or several (invalid) leave nothing to draw.
  const activeEdges = [];
  for (const id of activeNodeIds) {
    const exits = edges.filter((e) => e.from === id);
    if (exits.length === 1) activeEdges.push(toEdgeRef(exits[0]));
  }

  const entered = payload.enteredNodeId ? nodeById.get(payload.enteredNodeId) : null;
  // Durational nodes are already covered by activeNodeIds and stay lit on their
  // own; only instantaneous ones need the transient flash.
  const pulseNodeIds = entered && INSTANTANEOUS_NODE_TYPES.has(entered.type) ? [entered.id] : [];

  const pulseEdges = (payload.traversedEdgeIds || [])
    .map((edgeId) => edges.find((e) => e.id === edgeId))
    .filter(Boolean)
    .map(toEdgeRef);

  // Only for nodes the working graph still has - the user may have deleted the
  // node that is counting down. The node's TYPE is attached here rather than
  // looked up again at paint time: the timing decides how long the drain runs,
  // and the type decides which way it drains (a Delay empties downward, a Track
  // sweeps sideways), and this is the one place that already holds the graph
  // the ids are being resolved against.
  const activeTimings = (payload.activeTimings || [])
    .filter((timing) => nodeById.has(timing.nodeId))
    .map((timing) => ({ ...timing, type: nodeById.get(timing.nodeId).type }));

  return { activeNodeIds, pulseNodeIds, activeEdges, pulseEdges, activeTimings };
}
