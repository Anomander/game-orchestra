import { CUSTOM_GRAPH_VERSION, createDefaultLoop } from './custom-playback-schema.mjs';
import { nextNodeLabel } from './custom-playlist-node-render.mjs';

/**
 * Shared graph-construction helper for anything that needs to build a
 * CustomGraph (custom-playback-schema.mjs) programmatically rather than via
 * the Drawflow editor: graph-presets.mjs's starter graphs, and
 * native-mode-graph.mjs's one-pass synthesis of a native playlist's own
 * playback rules (docs/playlist-node-plan.md Phase 2.1).
 *
 * Two construction rules matter and are enforced by createBuilder() below
 * rather than left to each caller:
 *
 * - **Node ids are numeric strings.** Drawflow's load() recomputes its own
 *   `nodeId` counter as (max numeric node id + 1) after an import; a graph whose
 *   ids are non-numeric (e.g. createEmptyGraph()'s 'start') leaves that counter
 *   at 1, so a node added right after an import can be handed an id that
 *   already exists. Numeric ids keep the counter honest.
 * - **A node's edges are emitted in output-port order.** graphToDrawflowExport()
 *   maps the i-th edge of a node to `output_${i+1}` and folds Random/Condition
 *   exit metadata into a parallel `data.exits[]` by that same index, so the order
 *   edges are declared in *is* the port assignment.
 *
 * Pure data transforms only - no Drawflow, no DOM, no live Foundry - so
 * anything built with this is unit-testable by running its output straight
 * through validateGraph() and the Drawflow bridge.
 */

/** Canvas grid graphs built with this helper are laid out on, in px. */
export const COLUMN_WIDTH_PX = 220;
export const ROW_HEIGHT_PX = 110;
export const ORIGIN_PX = 40;

/** Columns a long chain of Track nodes wraps after, to keep it from running off-canvas. */
const SEQUENCE_WRAP_COLUMNS = 4;

/**
 * Accumulates nodes and edges while assigning ids/positions according to the two
 * rules in this module's header.
 * @returns {{node: Function, track: Function, edge: Function, build: Function}}
 */
export function createBuilder() {
  let nextId = 1;
  const nodes = [];
  // Names are assigned here rather than per-caller so every graph gets the
  // same "Track 1, Track 2, ..." numbering for free.
  const labels = [];
  // Grouped by source node so each node's edges stay contiguous and in port
  // order once flattened - validateGraph()'s "a 'default' Condition exit must be
  // last" rule reads them in array order too.
  const edgesByFrom = new Map();

  const api = {
    node(type, column, row, extra = {}) {
      const node = {
        id: String(nextId++),
        type,
        label: nextNodeLabel(type, labels),
        x: ORIGIN_PX + column * COLUMN_WIDTH_PX,
        y: ORIGIN_PX + row * ROW_HEIGHT_PX,
        ...extra
      };
      labels.push(node.label);
      nodes.push(node);
      return node;
    },
    /**
     * A Track node. A forever-looping track plays via native repeat and has
     * no exit (custom-playback-schema.mjs). `loop`, when given, overrides
     * `infinite` outright with any full LoopSpec (e.g. mode 'until') - callers
     * that only need forever/finite keep using `infinite`.
     */
    track(soundId, column, row, { infinite = false, loop } = {}) {
      const data = { soundId, loop: loop ?? (infinite ? { mode: 'forever' } : createDefaultLoop()) };
      return api.node('track', column, row, data);
    },
    edge(from, to, extra = {}) {
      const siblings = edgesByFrom.get(from.id) || [];
      const edge = { id: `${from.id}:output_${siblings.length + 1}->${to.id}`, from: from.id, to: to.id, ...extra };
      siblings.push(edge);
      edgesByFrom.set(from.id, siblings);
      return edge;
    },
    build() {
      return { version: CUSTOM_GRAPH_VERSION, nodes, edges: [...edgesByFrom.values()].flat() };
    }
  };
  return api;
}

/** Position of the i-th Track in a wrapped left-to-right chain. */
export function sequencePosition(index) {
  return { column: 1 + (index % SEQUENCE_WRAP_COLUMNS), row: Math.floor(index / SEQUENCE_WRAP_COLUMNS) };
}
