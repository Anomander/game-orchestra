import { describe, it, expect } from 'vitest';
import { graphToDrawflowExport, drawflowExportToGraph } from '../scripts/graph-drawflow-bridge.mjs';

describe('graphToDrawflowExport / drawflowExportToGraph round-trip', () => {
  it('round-trips a simple Start -> Track -> End graph', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 10, y: 20 },
        { id: 't1', type: 'track', x: 100, y: 20, soundId: 's1', loop: { mode: 'count', count: 3 } },
        { id: 'end', type: 'end', x: 200, y: 20 }
      ],
      edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    };

    const exported = graphToDrawflowExport(original);
    const roundTripped = drawflowExportToGraph(exported);

    expect(roundTripped.nodes).toHaveLength(3);
    const trackNode = roundTripped.nodes.find((n) => n.type === 'track');
    expect(trackNode).toMatchObject({ soundId: 's1', loop: { mode: 'count', count: 3 }, x: 100, y: 20 });
    expect(roundTripped.edges).toHaveLength(2);
    expect(roundTripped.edges.some((e) => e.from === 'start' && e.to === 't1')).toBe(true);
    expect(roundTripped.edges.some((e) => e.from === 't1' && e.to === 'end')).toBe(true);
  });

  it('gives Start zero input ports (it is the sole entry point and never has an incoming edge)', () => {
    const graph = { version: 1, nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], edges: [] };
    const exported = graphToDrawflowExport(graph);

    expect(exported.drawflow.Home.data.start.inputs).toEqual({});
  });

  it('drops a stray edge targeting Start instead of throwing (Start has no input port to wire it to)', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }, { id: 't1', type: 'track', x: 0, y: 0, soundId: 's', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 't1', to: 'start' }]
    };

    expect(() => graphToDrawflowExport(graph)).not.toThrow();
    const exported = graphToDrawflowExport(graph);
    expect(exported.drawflow.Home.data.t1.outputs.output_1.connections).toEqual([]);
  });

  it('round-trips an infinite Track node with zero output ports and no loopCount', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 't1', type: 'track', x: 0, y: 0, soundId: 's1', loop: { mode: 'forever' } }
      ],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    };

    const exported = graphToDrawflowExport(original);

    expect(exported.drawflow.Home.data.t1.outputs).toEqual({});
    const roundTripped = drawflowExportToGraph(exported);
    const trackNode = roundTripped.nodes.find((n) => n.type === 'track');
    expect(trackNode).toMatchObject({ soundId: 's1', loop: { mode: 'forever' } });
    expect(trackNode.loop.count).toBeUndefined();
  });

  it("round-trips a Track node looping until a condition is met, preserving condition/boundary/minLoops/maxLoops (regression: was silently collapsed to a 1-count loop on every round-trip)", () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        {
          id: 't1',
          type: 'track',
          x: 0,
          y: 0,
          soundId: 's1',
          loop: { mode: 'until', condition: { kind: 'phase', value: 'boss' }, boundary: 'loopEnd', minLoops: 2, maxLoops: 5 }
        },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    };

    const exported = graphToDrawflowExport(original);

    // Exactly one exit port - same as count mode, unlike forever.
    expect(Object.keys(exported.drawflow.Home.data.t1.outputs)).toEqual(['output_1']);
    expect(exported.drawflow.Home.data.t1.data.loop).toEqual({
      mode: 'until',
      condition: { kind: 'phase', value: 'boss' },
      boundary: 'loopEnd',
      minLoops: 2,
      maxLoops: 5
    });

    const roundTripped = drawflowExportToGraph(exported);
    const trackNode = roundTripped.nodes.find((n) => n.type === 'track');
    expect(trackNode.loop).toEqual({
      mode: 'until',
      condition: { kind: 'phase', value: 'boss' },
      boundary: 'loopEnd',
      minLoops: 2,
      maxLoops: 5
    });
  });

  it('survives a second round-trip unchanged (regression guard: re-exporting an already-imported until-loop must not drift)', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 't1', type: 'track', x: 0, y: 0, soundId: 's1', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } }
      ],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    };

    const once = drawflowExportToGraph(graphToDrawflowExport(original));
    const twice = drawflowExportToGraph(graphToDrawflowExport(once));

    expect(twice.nodes.find((n) => n.type === 'track').loop).toEqual(once.nodes.find((n) => n.type === 'track').loop);
  });

  it('produces the exact confirmed Drawflow shape (id/name/data/inputs/outputs/pos_x/pos_y)', () => {
    const graph = { version: 1, nodes: [{ id: 'd1', type: 'delay', x: 5, y: 6, delay: { min: 0, max: 0 } }], edges: [] };
    const exported = graphToDrawflowExport(graph);

    expect(exported.drawflow.Home.data.d1).toEqual({
      id: 'd1',
      name: 'delay',
      data: { delay: { min: 0, max: 0 } },
      class: 'game-orchestra-node-delay',
      html: 'delay',
      typenode: false,
      inputs: { input_1: { connections: [] } },
      outputs: { output_1: { connections: [] } },
      pos_x: 5,
      pos_y: 6
    });
  });

  it('mirrors a connection on both the source outputs and the target inputs, matching Drawflow', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'a', type: 'start', x: 0, y: 0 }, { id: 'b', type: 'track', x: 0, y: 0, soundId: 's', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'a', to: 'b' }]
    };
    const exported = graphToDrawflowExport(graph);

    expect(exported.drawflow.Home.data.a.outputs.output_1.connections).toEqual([{ node: 'b', output: 'input_1' }]);
    expect(exported.drawflow.Home.data.b.inputs.input_1.connections).toEqual([{ node: 'a', input: 'output_1' }]);
  });

  it('gives a Fork node one output port per exit, minimum 2', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'f1', type: 'fork', x: 0, y: 0 }, { id: 'a', type: 'end', x: 0, y: 0 }, { id: 'b', type: 'end', x: 0, y: 0 }, { id: 'c', type: 'end', x: 0, y: 0 }],
      edges: [{ id: 'e1', from: 'f1', to: 'a' }, { id: 'e2', from: 'f1', to: 'b' }, { id: 'e3', from: 'f1', to: 'c' }]
    };
    const exported = graphToDrawflowExport(graph);
    expect(Object.keys(exported.drawflow.Home.data.f1.outputs)).toEqual(['output_1', 'output_2', 'output_3']);
  });

  it('gives an End node zero output ports', () => {
    const graph = { version: 1, nodes: [{ id: 'end', type: 'end', x: 0, y: 0 }], edges: [] };
    const exported = graphToDrawflowExport(graph);
    expect(exported.drawflow.Home.data.end.outputs).toEqual({});
  });

  it('stores Random exit weight/cooldown per-port in node data and recovers them on import (H5)', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'r1', type: 'random', x: 0, y: 0 }, { id: 'a', type: 'end', x: 0, y: 0 }, { id: 'b', type: 'end', x: 0, y: 0 }],
      edges: [{ id: 'e1', from: 'r1', to: 'a', weight: 3, cooldown: 2 }, { id: 'e2', from: 'r1', to: 'b', weight: 1, cooldown: 0 }]
    };
    const exported = graphToDrawflowExport(graph);
    expect(exported.drawflow.Home.data.r1.data.exits).toEqual([{ weight: 3, cooldown: 2 }, { weight: 1, cooldown: 0 }]);

    const roundTripped = drawflowExportToGraph(exported);
    const edgeToA = roundTripped.edges.find((e) => e.to === 'a');
    const edgeToB = roundTripped.edges.find((e) => e.to === 'b');
    expect(edgeToA).toMatchObject({ weight: 3, cooldown: 2 });
    expect(edgeToB).toMatchObject({ weight: 1, cooldown: 0 });
  });

  it('stores Condition exit metadata per-port in node data and recovers it on import (H5)', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'c1', type: 'condition', x: 0, y: 0 }, { id: 'a', type: 'end', x: 0, y: 0 }, { id: 'b', type: 'end', x: 0, y: 0 }],
      edges: [
        { id: 'e1', from: 'c1', to: 'a', condition: { kind: 'combatActive' } },
        { id: 'e2', from: 'c1', to: 'b', condition: { kind: 'default' } }
      ]
    };
    const exported = graphToDrawflowExport(graph);
    const roundTripped = drawflowExportToGraph(exported);

    expect(roundTripped.edges.find((e) => e.to === 'a').condition).toEqual({ kind: 'combatActive' });
    expect(roundTripped.edges.find((e) => e.to === 'b').condition).toEqual({ kind: 'default' });
  });

  it('an exit port with no connection produces no edge on import', () => {
    // Simulates a Random node where the user added a 3rd exit via "add exit" but
    // hasn't wired it to a target yet.
    const graph = { version: 1, nodes: [{ id: 'r1', type: 'random', x: 0, y: 0 }, { id: 'a', type: 'end', x: 0, y: 0 }], edges: [{ id: 'e1', from: 'r1', to: 'a', weight: 1 }] };
    const exported = graphToDrawflowExport(graph);
    // Manually add a third, unconnected output port the way the editor's "add exit" would.
    exported.drawflow.Home.data.r1.outputs.output_2 = { connections: [] };
    exported.drawflow.Home.data.r1.data.exits.push({ weight: 5 });

    const roundTripped = drawflowExportToGraph(exported);
    expect(roundTripped.edges).toHaveLength(1);
  });

  it('skips a dangling edge whose target node does not exist, without throwing', () => {
    const graph = { version: 1, nodes: [{ id: 'a', type: 'start', x: 0, y: 0 }], edges: [{ id: 'e1', from: 'a', to: 'missing' }] };
    expect(() => graphToDrawflowExport(graph)).not.toThrow();
    const exported = graphToDrawflowExport(graph);
    expect(exported.drawflow.Home.data.a.outputs.output_1.connections).toEqual([]);
  });

  it('round-trips node canvas positions', () => {
    const graph = { version: 1, nodes: [{ id: 'start', type: 'start', x: 123, y: 456 }], edges: [] };
    const roundTripped = drawflowExportToGraph(graphToDrawflowExport(graph));
    expect(roundTripped.nodes[0]).toMatchObject({ x: 123, y: 456 });
  });

  it('round-trips a Delay node min/max range', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'd1', type: 'delay', x: 0, y: 0, delay: { min: 2, max: 5 } }],
      edges: []
    };
    const roundTripped = drawflowExportToGraph(graphToDrawflowExport(graph));
    expect(roundTripped.nodes[0].delay).toEqual({ min: 2, max: 5 });
  });

  it('round-trips a finite Playlist node (direct reference, loopCount, one output port)', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'p1', type: 'playlist', x: 0, y: 0, playlistRef: { source: 'direct', playlistId: 'pl-target' }, loop: { mode: 'count', count: 3 } },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    };

    const exported = graphToDrawflowExport(original);
    expect(Object.keys(exported.drawflow.Home.data.p1.outputs)).toEqual(['output_1']);
    expect(exported.drawflow.Home.data.p1.data.playlistRef).toEqual({ source: 'direct', playlistId: 'pl-target' });
    expect(exported.drawflow.Home.data.p1.data.loop).toEqual({ mode: 'count', count: 3 });

    const roundTripped = drawflowExportToGraph(exported);
    const playlistNode = roundTripped.nodes.find((n) => n.type === 'playlist');
    expect(playlistNode).toMatchObject({
      playlistRef: { source: 'direct', playlistId: 'pl-target' },
      loop: { mode: 'count', count: 3 }
    });
    expect(roundTripped.edges.some((e) => e.from === 'p1' && e.to === 'end')).toBe(true);
  });

  it('round-trips an infinite Playlist node with zero output ports and no loopCount', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'p1', type: 'playlist', x: 0, y: 0, playlistRef: { source: 'direct', playlistId: 'pl-target' }, loop: { mode: 'forever' } }
      ],
      edges: [{ id: 'e1', from: 'start', to: 'p1' }]
    };

    const exported = graphToDrawflowExport(original);
    expect(exported.drawflow.Home.data.p1.outputs).toEqual({});

    const roundTripped = drawflowExportToGraph(exported);
    const playlistNode = roundTripped.nodes.find((n) => n.type === 'playlist');
    expect(playlistNode).toMatchObject({ playlistRef: { source: 'direct', playlistId: 'pl-target' }, loop: { mode: 'forever' } });
    expect(playlistNode.loop.count).toBeUndefined();
  });

  it('round-trips an indirect Playlist reference (scene/default section + overlay mode)', () => {
    const original = {
      version: 1,
      nodes: [
        { id: 'start', type: 'start', x: 0, y: 0 },
        { id: 'p1', type: 'playlist', x: 0, y: 0, playlistRef: { source: 'scene', section: 'combat', overlayMode: 'specific', overlayId: 'boss' }, loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end', x: 0, y: 0 }
      ],
      edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    };

    const roundTripped = drawflowExportToGraph(graphToDrawflowExport(original));
    const playlistNode = roundTripped.nodes.find((n) => n.type === 'playlist');
    expect(playlistNode.playlistRef).toEqual({ source: 'scene', section: 'combat', overlayMode: 'specific', overlayId: 'boss' });
  });

  it('normalizes a missing/malformed playlistRef on import rather than importing raw garbage', () => {
    const graph = { version: 1, nodes: [{ id: 'p1', type: 'playlist', x: 0, y: 0 }], edges: [] };
    const exported = graphToDrawflowExport(graph);
    // Simulate a stale/corrupt data.playlistRef the way a hand-edited or legacy save might.
    exported.drawflow.Home.data.p1.data.playlistRef = { source: 'bogus' };

    const roundTripped = drawflowExportToGraph(exported);
    expect(roundTripped.nodes[0].playlistRef).toEqual({ source: 'direct', playlistId: null });
  });
});

describe('node names round-trip', () => {
  it("stores a node's name in data.label, never in Drawflow's own `name` (which is the type)", () => {
    const graph = { version: 1, nodes: [{ id: '1', type: 'track', label: 'Boss Theme', soundId: 's1', loop: { mode: 'count', count: 1 } }], edges: [] };
    const exported = graphToDrawflowExport(graph);

    expect(exported.drawflow.Home.data['1'].name).toBe('track'); // the type, untouched
    expect(exported.drawflow.Home.data['1'].data.label).toBe('Boss Theme');
    expect(drawflowExportToGraph(exported).nodes[0].label).toBe('Boss Theme');
  });

  it('carries names on types that have no other data of their own', () => {
    const graph = { version: 1, nodes: [{ id: '1', type: 'end', label: 'Fade Out' }], edges: [] };
    expect(drawflowExportToGraph(graphToDrawflowExport(graph)).nodes[0].label).toBe('Fade Out');
  });

  it('leaves label absent for a graph saved before names existed', () => {
    const graph = { version: 1, nodes: [{ id: '1', type: 'end' }], edges: [] };
    expect(drawflowExportToGraph(graphToDrawflowExport(graph)).nodes[0]).not.toHaveProperty('label');
  });
});
