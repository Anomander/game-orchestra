import { describe, it, expect } from 'vitest';
import { planEdgeInsertion, planNodeBypass } from '../scripts/graph-splice.mjs';

/**
 * A Drawflow node record, in the shape planNodeBypass reads it. Note the asymmetric field names
 * the vendor uses and this module's header documents: on an INCOMING connection `input` names the
 * SOURCE's output port; on an OUTGOING one `output` names the TARGET's input port.
 */
function node(id, { incoming = [], outgoing = [], inputPorts = 1, outputPorts = 1 } = {}) {
  const inputs = {};
  for (let i = 1; i <= inputPorts; i++) inputs[`input_${i}`] = { connections: i === 1 ? incoming : [] };
  const outputs = {};
  for (let i = 1; i <= outputPorts; i++) outputs[`output_${i}`] = { connections: i === 1 ? outgoing : [] };
  return { id, inputs, outputs };
}

describe('planEdgeInsertion', () => {
  const edge = { from: 'a', to: 'b', outputPort: 'output_2', inputPort: 'input_1' };

  it('re-points the edge at the new node and continues to the old target', () => {
    const plan = planEdgeInsertion(edge, 'n');

    expect(plan.remove).toEqual([edge]);
    expect(plan.connect).toEqual([
      // Keeps the SOURCE's original output port - splicing into a Random's second exit must not
      // silently move the wire onto its first.
      { from: 'a', to: 'n', outputPort: 'output_2', inputPort: 'input_1' },
      // ...and the TARGET's original input port, for the same reason.
      { from: 'n', to: 'b', outputPort: 'output_1', inputPort: 'input_1' }
    ]);
  });

  it('stops after the incoming half when the node has more than one exit', () => {
    // A Fork would need us to pick a branch; guessing one is worse than leaving it visible.
    const plan = planEdgeInsertion(edge, 'n', { outputCount: 2 });

    expect(plan.connect).toEqual([{ from: 'a', to: 'n', outputPort: 'output_2', inputPort: 'input_1' }]);
  });

  it('stops after the incoming half for a node with no exit at all', () => {
    const plan = planEdgeInsertion(edge, 'n', { outputCount: 0 });

    expect(plan.connect).toHaveLength(1);
  });

  it('splices into a self-loop, giving A -> N -> A', () => {
    const loop = { from: 'a', to: 'a', outputPort: 'output_1', inputPort: 'input_1' };
    const plan = planEdgeInsertion(loop, 'n');

    expect(plan.connect).toEqual([
      { from: 'a', to: 'n', outputPort: 'output_1', inputPort: 'input_1' },
      { from: 'n', to: 'a', outputPort: 'output_1', inputPort: 'input_1' }
    ]);
  });

  it('plans nothing without an edge or a node', () => {
    expect(planEdgeInsertion(null, 'n')).toEqual({ remove: [], connect: [] });
    expect(planEdgeInsertion(edge, null)).toEqual({ remove: [], connect: [] });
  });
});

describe('planNodeBypass', () => {
  it('joins the two neighbours of a node in the middle of a chain', () => {
    const middle = node('n', {
      incoming: [{ node: 'a', input: 'output_3' }],
      outgoing: [{ node: 'b', output: 'input_1' }]
    });

    // Reads the FAR end from each record: 'a' is reached via its own output_3, and 'b' is
    // entered at its own input_1.
    expect(planNodeBypass(middle)).toEqual({ from: 'a', to: 'b', outputPort: 'output_3', inputPort: 'input_1' });
  });

  it('heals nothing for a node with no incoming connection', () => {
    expect(planNodeBypass(node('n', { outgoing: [{ node: 'b', output: 'input_1' }] }))).toBeNull();
  });

  it('heals nothing for a node with no outgoing connection', () => {
    expect(planNodeBypass(node('n', { incoming: [{ node: 'a', input: 'output_1' }] }))).toBeNull();
  });

  it('heals nothing when several nodes feed in - there is no single chain to rejoin', () => {
    const junction = node('n', {
      incoming: [{ node: 'a', input: 'output_1' }, { node: 'c', input: 'output_1' }],
      outgoing: [{ node: 'b', output: 'input_1' }]
    });

    expect(planNodeBypass(junction)).toBeNull();
  });

  it('heals nothing for a branch point (more than one output port)', () => {
    const fork = node('n', {
      incoming: [{ node: 'a', input: 'output_1' }],
      outgoing: [{ node: 'b', output: 'input_1' }],
      outputPorts: 2
    });

    expect(planNodeBypass(fork)).toBeNull();
  });

  it('heals nothing for a node wired only to itself', () => {
    const selfLooped = node('n', {
      incoming: [{ node: 'n', input: 'output_1' }],
      outgoing: [{ node: 'n', output: 'input_1' }]
    });

    expect(planNodeBypass(selfLooped)).toBeNull();
  });

  it('preserves a two-node cycle as a self-loop rather than breaking it', () => {
    // A -> N -> A. Dropping the wire instead would silently stop a loop the user built.
    const inCycle = node('n', {
      incoming: [{ node: 'a', input: 'output_1' }],
      outgoing: [{ node: 'a', output: 'input_1' }]
    });

    expect(planNodeBypass(inCycle)).toEqual({ from: 'a', to: 'a', outputPort: 'output_1', inputPort: 'input_1' });
  });

  it('survives a missing or malformed node record', () => {
    expect(planNodeBypass(null)).toBeNull();
    expect(planNodeBypass({})).toBeNull();
  });
});
