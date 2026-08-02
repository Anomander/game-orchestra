import { describe, it, expect } from 'vitest';
import { portFromEdgeId, edgeSelector, computeHighlight } from '../scripts/graph-activity-highlight.mjs';

/** Graph: start -> track(t1) -> delay(d1) -> random(r1) -> {t1, end}. */
function sampleGraph() {
  return {
    version: 1,
    nodes: [
      { id: '1', type: 'start' },
      { id: '2', type: 'track', soundId: 's1', loopCount: 1 },
      { id: '3', type: 'delay', delay: { min: 1, max: 1 } },
      { id: '4', type: 'random' },
      { id: '5', type: 'end' }
    ],
    edges: [
      { id: '1:output_1->2', from: '1', to: '2' },
      { id: '2:output_1->3', from: '2', to: '3' },
      { id: '3:output_1->4', from: '3', to: '4' },
      { id: '4:output_1->2', from: '4', to: '2', weight: 1 },
      { id: '4:output_2->5', from: '4', to: '5', weight: 1 }
    ]
  };
}

describe('portFromEdgeId', () => {
  it('extracts the output port from a bridge-minted edge id', () => {
    expect(portFromEdgeId('4:output_2->5')).toBe('output_2');
    expect(portFromEdgeId('start:output_1->t1')).toBe('output_1');
  });

  it('handles a self-loop id, where source and target are the same node', () => {
    expect(portFromEdgeId('7:output_1->7')).toBe('output_1');
  });

  it('returns null for ids that carry no port, rather than throwing', () => {
    expect(portFromEdgeId('e1')).toBeNull();
    expect(portFromEdgeId('a->b')).toBeNull();
    expect(portFromEdgeId('')).toBeNull();
    expect(portFromEdgeId(undefined)).toBeNull();
    expect(portFromEdgeId(null)).toBeNull();
  });
});

describe('edgeSelector', () => {
  it("matches Drawflow's connection class naming, including the port", () => {
    expect(edgeSelector({ from: '4', to: '5', port: 'output_2' })).toBe('.connection.node_in_node-5.node_out_node-4.output_2');
  });

  it('omits the port class when the port is unknown, matching every edge between the pair', () => {
    expect(edgeSelector({ from: '4', to: '5', port: null })).toBe('.connection.node_in_node-5.node_out_node-4');
  });
});

describe('computeHighlight', () => {
  it('returns everything empty for a null payload (nothing playing)', () => {
    expect(computeHighlight(sampleGraph(), null)).toEqual({
      activeNodeIds: [],
      pulseNodeIds: [],
      activeEdges: [],
      pulseEdges: [],
      activeTimings: []
    });
  });

  it('lights an active durational node and its single known exit edge', () => {
    const result = computeHighlight(sampleGraph(), { activeNodeIds: ['2'] });
    expect(result.activeNodeIds).toEqual(['2']);
    expect(result.activeEdges).toEqual([{ from: '2', to: '3', port: 'output_1' }]);
  });

  it('lights several active nodes at once (parallel Fork branches)', () => {
    const result = computeHighlight(sampleGraph(), { activeNodeIds: ['2', '3'] });
    expect(result.activeNodeIds).toEqual(['2', '3']);
    expect(result.activeEdges).toEqual([
      { from: '2', to: '3', port: 'output_1' },
      { from: '3', to: '4', port: 'output_1' }
    ]);
  });

  it('draws no exit edge for an active node with no exit (an infinite Track)', () => {
    const graph = {
      version: 1,
      nodes: [{ id: '1', type: 'track', soundId: 's1', infinite: true }],
      edges: []
    };
    const result = computeHighlight(graph, { activeNodeIds: ['1'] });
    expect(result.activeNodeIds).toEqual(['1']);
    expect(result.activeEdges).toEqual([]);
  });

  it('draws no exit edge when the exit is ambiguous (more than one)', () => {
    const graph = sampleGraph();
    const result = computeHighlight(graph, { activeNodeIds: ['4'] }); // Random has two exits
    expect(result.activeEdges).toEqual([]);
  });

  it('highlights a Track wired back to itself via its self-loop edge', () => {
    const graph = {
      version: 1,
      nodes: [{ id: '7', type: 'track', soundId: 's1', loopCount: 1 }],
      edges: [{ id: '7:output_1->7', from: '7', to: '7' }]
    };
    const result = computeHighlight(graph, { activeNodeIds: ['7'] });
    expect(result.activeEdges).toEqual([{ from: '7', to: '7', port: 'output_1' }]);
  });

  it('pulses an instantaneous node that was just entered', () => {
    const result = computeHighlight(sampleGraph(), { activeNodeIds: [], enteredNodeId: '4' });
    expect(result.pulseNodeIds).toEqual(['4']);
  });

  it('does not pulse a durational node - it is already held as active', () => {
    const result = computeHighlight(sampleGraph(), { activeNodeIds: ['2'], enteredNodeId: '2' });
    expect(result.pulseNodeIds).toEqual([]);
  });

  it('pulses each edge a token is currently following', () => {
    const result = computeHighlight(sampleGraph(), { activeNodeIds: [], traversedEdgeIds: ['4:output_2->5'] });
    expect(result.pulseEdges).toEqual([{ from: '4', to: '5', port: 'output_2' }]);
  });

  it('ignores node and edge ids the working graph no longer has (mid-edit divergence)', () => {
    const result = computeHighlight(sampleGraph(), {
      activeNodeIds: ['2', 'gone'],
      enteredNodeId: 'gone',
      traversedEdgeIds: ['nope']
    });
    expect(result.activeNodeIds).toEqual(['2']);
    expect(result.pulseNodeIds).toEqual([]);
    expect(result.pulseEdges).toEqual([]);
  });

  it('passes drain timings through, dropping any whose node is gone', () => {
    const result = computeHighlight(sampleGraph(), {
      activeNodeIds: ['3'],
      activeTimings: [
        { nodeId: '3', durationMs: 4000, startedAt: 1000 },
        { nodeId: 'deleted', durationMs: 1000, startedAt: 1000 }
      ]
    });
    expect(result.activeTimings).toEqual([{ nodeId: '3', durationMs: 4000, startedAt: 1000, type: 'delay' }]);
  });

  it("tags each timing with its node's type, which is what decides the drain direction", () => {
    const result = computeHighlight(sampleGraph(), {
      activeNodeIds: ['2', '3'],
      activeTimings: [
        { nodeId: '2', durationMs: 90_000, startedAt: 1000, iterations: null },
        { nodeId: '3', durationMs: 4000, startedAt: 1000, iterations: 1 }
      ]
    });
    expect(result.activeTimings.map((t) => t.type)).toEqual(['track', 'delay']);
    // Everything the engine sent is carried through untouched alongside it.
    expect(result.activeTimings[0].iterations).toBeNull();
    expect(result.activeTimings[1].durationMs).toBe(4000);
  });

  it('tolerates a missing/empty graph', () => {
    expect(computeHighlight(null, { activeNodeIds: ['2'] })).toEqual({
      activeNodeIds: [],
      pulseNodeIds: [],
      activeEdges: [],
      pulseEdges: [],
      activeTimings: []
    });
  });
});
