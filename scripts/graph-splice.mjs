/**
 * Rewiring decisions for the two gestures that change a graph's shape without the user drawing a
 * single wire: dropping a node **onto an edge** (splice it in) and deleting a node that sat in the
 * middle of a chain (heal the gap).
 *
 * Pure - no Drawflow, no DOM, no live Foundry - so the rules are testable without a mounted
 * editor, like graph-drop.mjs. Both functions return a *plan*: which connections to remove and
 * which to add, in order. The caller performs them against Drawflow, which is where the ordering
 * matters (removing first keeps a port from momentarily holding two wires).
 *
 * ## Drawflow's connection record naming, which is not symmetrical
 *
 * On an entry under `outputs[port].connections`, the field named `output` holds the **target's
 * input** port. On an entry under `inputs[port].connections`, the field named `input` holds the
 * **source's output** port. Both are the *far* end. Reading either as "my own port" silently
 * produces wires between the wrong ports, and is the reason both functions here take the whole
 * node record rather than pre-extracted ids.
 */

/**
 * @typedef {object} GraphEdgeEnds
 * @property {string} from - Source node id.
 * @property {string} to - Target node id.
 * @property {string} outputPort - The source's output port, e.g. 'output_2'.
 * @property {string} inputPort - The target's input port, e.g. 'input_1'.
 */

/**
 * @typedef {object} RewirePlan
 * @property {Array<GraphEdgeEnds>} remove - Connections to drop, before any are added.
 * @property {Array<GraphEdgeEnds>} connect - Connections to create, in order.
 */

/**
 * Splice a freshly-created node into an existing edge: `A -> B` becomes `A -> N -> B`.
 *
 * The incoming half is unconditional - the edge is always re-pointed at the new node's entry.
 * The outgoing half depends on the node having **exactly one exit**, because that is the only
 * case where "and then continue to B" has one meaning. A Fork (two exits from creation) would
 * need us to pick a branch, and an End node has no exit at all; in both cases the plan stops
 * after `A -> N` and B is simply left without that incoming wire, which is visible on the canvas
 * and immediately undoable.
 *
 * The new node's own ports are always `output_1`/`input_1`: it was created moments ago and has
 * whatever NODE_DEFAULTS gave it, never a renumbered port.
 * @param {GraphEdgeEnds} edge - The edge being dropped onto.
 * @param {string} nodeId - The node to splice in.
 * @param {object} [options]
 * @param {number} [options.outputCount] - The new node's output port count.
 * @returns {RewirePlan}
 */
export function planEdgeInsertion(edge, nodeId, { outputCount = 1 } = {}) {
  if (!edge || !nodeId) return { remove: [], connect: [] };
  const plan = {
    remove: [{ ...edge }],
    connect: [{ from: edge.from, to: nodeId, outputPort: edge.outputPort, inputPort: 'input_1' }]
  };
  if (outputCount === 1) {
    plan.connect.push({ from: nodeId, to: edge.to, outputPort: 'output_1', inputPort: edge.inputPort });
  }
  return plan;
}

/**
 * The wire that should replace a node being removed from the middle of a chain, so deleting a
 * Delay out of `A -> Delay -> B` leaves `A -> B` rather than two loose ends.
 *
 * Requires **exactly one incoming and exactly one outgoing connection**. Anything else is a
 * genuine branch point (a node several others feed into, or one feeding several) where healing
 * would have to invent a topology the user never drew - those are left as loose ends, which is
 * honest about what was lost.
 *
 * A node wired only to itself heals to nothing: the "chain" it sat in was a loop through it
 * alone, and there is no pair of neighbours to join. A node BETWEEN two points of a cycle
 * (`A -> N -> A`) does heal, to `A -> A` - dropping that instead would silently break a loop the
 * user built, and a self-loop is a shape this schema supports.
 * @param {object} node - The live Drawflow node record, read before its removal.
 * @returns {GraphEdgeEnds|null} The connection to create, or null to heal nothing.
 */
export function planNodeBypass(node) {
  const inputPorts = Object.keys(node?.inputs || {});
  const outputPorts = Object.keys(node?.outputs || {});
  if (inputPorts.length !== 1 || outputPorts.length !== 1) return null;

  const incoming = node.inputs[inputPorts[0]]?.connections || [];
  const outgoing = node.outputs[outputPorts[0]]?.connections || [];
  if (incoming.length !== 1 || outgoing.length !== 1) return null;

  const predecessor = incoming[0];
  const successor = outgoing[0];
  // See this module's header: on an INCOMING entry `input` is the source's OUTPUT port, and on an
  // OUTGOING entry `output` is the target's INPUT port. Both name the far end.
  const from = String(predecessor.node);
  const to = String(successor.node);
  if (!from || !to) return null;
  // Its only neighbour was itself - there is no pair to join.
  if (from === String(node.id) || to === String(node.id)) return null;

  return { from, to, outputPort: predecessor.input, inputPort: successor.output };
}
