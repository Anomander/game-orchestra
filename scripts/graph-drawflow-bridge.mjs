/**
 * Pure data transforms between this module's CustomGraph schema
 * (custom-playback-schema.mjs) and Drawflow's export()/import() JSON shape.
 *
 * Drawflow connections carry no data of their own (custom-playlist-plan.md H5)
 * - only whole-node `data` round-trips. Random/Condition exit metadata
 * (weight/cooldown or condition) is therefore stashed on the node itself, in a
 * `data.exits[]` array parallel to that node's output ports: `exits[0]`
 * describes `output_1`, `exits[1]` describes `output_2`, and so on. Drawflow
 * renumbers a node's remaining output ports contiguously whenever one is
 * removed from the middle (confirmed against the vendored library's source);
 * the editor must splice `data.exits[]` in lockstep whenever it removes a
 * port so the two stay aligned.
 *
 * These functions take/produce plain JSON only - no live Drawflow instance or
 * DOM is required, so they are fully unit-testable in isolation. The shape
 * below (id/name/data/class/html/typenode/inputs/outputs/pos_x/pos_y, with
 * outputs.output_N.connections[].{node,output} and the mirrored inputs side)
 * was confirmed by actually running the vendored drawflow.min.js against a
 * headless DOM and inspecting a real export() result, not from documentation
 * alone - see docs/custom-playlist-plan.md Phase 0b.
 */

import { normalizePlaylistRef } from './playlist-ref.mjs';
import { resolveLoop } from './custom-playback-schema.mjs';

const FIXED_OUTPUT_COUNT = { start: 1, delay: 1, end: 0 };

/**
 * Start is the graph's sole entry point and never has an incoming edge (by
 * design - nothing produces one), so it's the one type with no input port at
 * all; every other type gets exactly one.
 */
function inputCountFor(node) {
  return node.type === 'start' ? 0 : 1;
}

function outputCountFor(node, exitCount) {
  // A forever-looping Track or Playlist node never advances, so it has no
  // exit port at all - unlike every other node type, its output count isn't
  // fixed, it depends on this per-node loop mode.
  if (node.type === 'track' || node.type === 'playlist') return node.loop?.mode === 'forever' ? 0 : 1;
  if (node.type in FIXED_OUTPUT_COUNT) return FIXED_OUTPUT_COUNT[node.type];
  if (node.type === 'fork') return Math.max(exitCount, 2);
  return Math.max(exitCount, 1); // random / condition
}

// Playlist nodes only ever support 'forever'/'count' (LoopSpec's 'until' mode
// is Track-only - see custom-playback-schema.mjs's own doc comment on
// LoopSpec.condition), so this stays a plain binary rather than routing
// through resolveLoop.
function loopDataFor(node) {
  return node.loop?.mode === 'forever' ? { mode: 'forever' } : { mode: 'count', count: node.loop?.count ?? 1 };
}

function nodeDataFor(node) {
  // The node's user-facing name lives in `data.label`, NOT in Drawflow's own
  // top-level `name` field - that one holds the node TYPE (it's what
  // drawflowExportToGraph reads back as `type`), so reusing it would overwrite
  // the type with a display string and unmake the node.
  const base = node.label ? { label: node.label } : {};
  switch (node.type) {
    case 'track':
      // resolveLoop(), not loopDataFor(): a Track's loop can also be 'until',
      // which needs its condition/boundary/minLoops/maxLoops preserved through
      // the round-trip - collapsing it to loopDataFor's forever/count binary
      // would silently revert every until-loop to a 1-count loop the moment
      // any other inspector field on the node changed.
      return { ...base, soundId: node.soundId ?? null, loop: resolveLoop(node) };
    case 'delay':
      return { ...base, delay: { min: node.delay?.min ?? 0, max: node.delay?.max ?? node.delay?.min ?? 0 } };
    case 'playlist':
      return { ...base, playlistRef: normalizePlaylistRef(node.playlistRef), loop: loopDataFor(node) };
    default:
      return base;
  }
}

/**
 * 'output_3' -> 3, for sorting port names numerically rather than lexically.
 * Shared with custom-playlist-editor.mjs, which imports it from here rather
 * than duplicating it.
 * @param {string} portName
 * @returns {number}
 */
export function portIndex(portName) {
  return parseInt(String(portName).split('_')[1], 10) || 0;
}

/**
 * Build a Drawflow-shaped export object (suitable for editor.import()) from a CustomGraph.
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @returns {object} A plain object matching Drawflow's export() shape.
 */
export function graphToDrawflowExport(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const data = {};

  for (const node of nodes) {
    const exitEdges = edges.filter((e) => e.from === node.id);
    const outputCount = outputCountFor(node, exitEdges.length);

    const outputs = {};
    for (let i = 1; i <= outputCount; i++) outputs[`output_${i}`] = { connections: [] };
    const inputs = {};
    for (let i = 1; i <= inputCountFor(node); i++) inputs[`input_${i}`] = { connections: [] };

    const nodeData = nodeDataFor(node);
    if (node.type === 'random') {
      nodeData.exits = exitEdges.map((edge) => ({ weight: edge.weight ?? 1, cooldown: edge.cooldown ?? 0 }));
      nodeData.avoidRepeat = !!node.avoidRepeat;
    } else if (node.type === 'condition') {
      nodeData.exits = exitEdges.map((edge) => ({ condition: edge.condition ?? { kind: 'default' } }));
    }

    data[node.id] = {
      id: node.id,
      name: node.type,
      data: nodeData,
      class: `game-orchestra-node-${node.type}`,
      html: node.type,
      typenode: false,
      inputs,
      outputs,
      pos_x: node.x ?? 0,
      pos_y: node.y ?? 0
    };
  }

  // Wire connections on both sides, matching Drawflow's mirrored data model -
  // each connection is recorded once under the source's outputs and once
  // under the target's inputs.
  for (const node of nodes) {
    const exitEdges = edges.filter((e) => e.from === node.id);
    exitEdges.forEach((edge, i) => {
      const sourceEntry = data[node.id];
      const targetEntry = data[edge.to];
      if (!sourceEntry || !targetEntry) return; // dangling edge endpoint - skip rather than corrupt the export
      const outputPort = `output_${i + 1}`;
      const inputPort = 'input_1';
      // A target with no input port (only Start, which never legitimately
      // receives an edge) would otherwise throw here on a stray/legacy edge
      // that ended up pointing at it - drop it from the export instead of
      // crashing the whole editor over one bad edge.
      if (!targetEntry.inputs[inputPort]) return;
      sourceEntry.outputs[outputPort].connections.push({ node: String(edge.to), output: inputPort });
      targetEntry.inputs[inputPort].connections.push({ node: String(node.id), input: outputPort });
    });
  }

  return { drawflow: { Home: { data } } };
}

/**
 * Reverse of graphToDrawflowExport: rebuild a CustomGraph from a Drawflow
 * export object (as returned by editor.export()).
 *
 * Each output port with a connection becomes one GraphEdge; an exit port the
 * user added but never wired to a target produces no edge (validateGraph
 * will flag the owning Random/Condition/Fork node as under-connected). An
 * output port with more than one outgoing connection is not a shape this
 * module's editor is expected to produce (each Random/Condition exit is one
 * port = one edge by construction); if encountered, every resulting edge
 * shares that port's single weight/condition entry.
 * @param {object} exported - A Drawflow export() result.
 * @returns {import('./custom-playback-schema.mjs').CustomGraph}
 */
export function drawflowExportToGraph(exported) {
  const rawNodes = exported?.drawflow?.Home?.data || {};
  const nodes = [];
  const edges = [];

  for (const [id, raw] of Object.entries(rawNodes)) {
    const type = raw.name;
    const node = { id: String(id), type, x: raw.pos_x ?? 0, y: raw.pos_y ?? 0 };
    if (raw.data?.label) node.label = raw.data.label;
    if (type === 'track') {
      node.soundId = raw.data?.soundId ?? null;
      // See nodeDataFor's track case: this must round-trip 'until' loops too.
      node.loop = resolveLoop({ loop: raw.data?.loop });
    } else if (type === 'delay') {
      node.delay = { min: raw.data?.delay?.min ?? 0, max: raw.data?.delay?.max ?? 0 };
    } else if (type === 'random') {
      node.avoidRepeat = !!raw.data?.avoidRepeat;
    } else if (type === 'playlist') {
      node.playlistRef = normalizePlaylistRef(raw.data?.playlistRef);
      node.loop = raw.data?.loop?.mode === 'forever' ? { mode: 'forever' } : { mode: 'count', count: raw.data?.loop?.count ?? 1 };
    }
    nodes.push(node);
  }

  for (const [id, raw] of Object.entries(rawNodes)) {
    const type = raw.name;
    const outputs = raw.outputs || {};
    const sortedPorts = Object.keys(outputs).sort((a, b) => portIndex(a) - portIndex(b));
    sortedPorts.forEach((portName, i) => {
      const port = outputs[portName];
      for (const conn of port.connections || []) {
        const edge = { id: `${id}:${portName}->${conn.node}`, from: String(id), to: String(conn.node) };
        if (type === 'random') {
          const exit = raw.data?.exits?.[i];
          edge.weight = exit?.weight ?? 1;
          edge.cooldown = exit?.cooldown ?? 0;
        } else if (type === 'condition') {
          const exit = raw.data?.exits?.[i];
          edge.condition = exit?.condition ?? { kind: 'default' };
        }
        edges.push(edge);
      }
    });
  }

  return { version: 1, nodes, edges };
}
