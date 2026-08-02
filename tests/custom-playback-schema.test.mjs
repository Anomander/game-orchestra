import { describe, it, expect } from 'vitest';
import {
  createDefaultLoop,
  createDefaultUntilLoop,
  resolveLoop,
  createEmptyGraph,
  findUpcomingTrackNodes,
  resolveGraphCrossfadeMs,
  CONDITION_KINDS_WITH_VALUE,
  conditionMissingValue,
  conditionSignature,
  pickRandomExit,
  planNextHandoff
} from '../scripts/custom-playback-schema.mjs';

describe('createDefaultLoop', () => {
  it('is a single count-mode pass', () => {
    expect(createDefaultLoop()).toEqual({ mode: 'count', count: 1 });
  });
});

describe('createDefaultUntilLoop', () => {
  it('starts as an immediate-boundary combatIdle condition with a floor of 1 loop and no cap', () => {
    expect(createDefaultUntilLoop()).toEqual({
      mode: 'until',
      condition: { kind: 'combatIdle' },
      boundary: 'immediate',
      minLoops: 1,
      maxLoops: null
    });
  });
});

describe('resolveLoop', () => {
  it('defaults a missing loop field to a single count-mode pass', () => {
    expect(resolveLoop({})).toEqual({ mode: 'count', count: 1 });
    expect(resolveLoop({ loop: undefined })).toEqual({ mode: 'count', count: 1 });
    expect(resolveLoop(null)).toEqual({ mode: 'count', count: 1 });
  });

  it('coerces a missing, zero, or negative count to 1', () => {
    expect(resolveLoop({ loop: { mode: 'count' } })).toEqual({ mode: 'count', count: 1 });
    expect(resolveLoop({ loop: { mode: 'count', count: 0 } })).toEqual({ mode: 'count', count: 1 });
    expect(resolveLoop({ loop: { mode: 'count', count: -5 } })).toEqual({ mode: 'count', count: 1 });
  });

  it('preserves a valid count', () => {
    expect(resolveLoop({ loop: { mode: 'count', count: 4 } })).toEqual({ mode: 'count', count: 4 });
  });

  it('collapses forever mode to just its mode, discarding any stray sibling fields', () => {
    expect(resolveLoop({ loop: { mode: 'forever', count: 4, minLoops: 3 } })).toEqual({ mode: 'forever' });
  });

  it('normalizes an until loop with all fields present', () => {
    const node = {
      loop: {
        mode: 'until',
        condition: { kind: 'phase', value: 'boss' },
        boundary: 'loopEnd',
        minLoops: 3,
        maxLoops: 10
      }
    };
    expect(resolveLoop(node)).toEqual({
      mode: 'until',
      condition: { kind: 'phase', value: 'boss' },
      boundary: 'loopEnd',
      minLoops: 3,
      maxLoops: 10
    });
  });

  it('defaults a missing/malformed until condition to kind "default"', () => {
    expect(resolveLoop({ loop: { mode: 'until' } })).toMatchObject({ condition: { kind: 'default' } });
    expect(resolveLoop({ loop: { mode: 'until', condition: {} } })).toMatchObject({ condition: { kind: 'default' } });
  });

  it('defaults an invalid boundary to immediate', () => {
    expect(resolveLoop({ loop: { mode: 'until', boundary: 'sometime' } })).toMatchObject({ boundary: 'immediate' });
    expect(resolveLoop({ loop: { mode: 'until' } })).toMatchObject({ boundary: 'immediate' });
  });

  it('coerces a missing or invalid minLoops to 1', () => {
    expect(resolveLoop({ loop: { mode: 'until' } })).toMatchObject({ minLoops: 1 });
    expect(resolveLoop({ loop: { mode: 'until', minLoops: 0 } })).toMatchObject({ minLoops: 1 });
    expect(resolveLoop({ loop: { mode: 'until', minLoops: -3 } })).toMatchObject({ minLoops: 1 });
  });

  it('treats a missing maxLoops as unbounded (null)', () => {
    expect(resolveLoop({ loop: { mode: 'until' } })).toMatchObject({ maxLoops: null });
  });

  it('floors maxLoops at minLoops rather than allowing a cap below the floor', () => {
    expect(resolveLoop({ loop: { mode: 'until', minLoops: 5, maxLoops: 2 } })).toMatchObject({ minLoops: 5, maxLoops: 5 });
  });

  it('coerces an invalid maxLoops to the resolved minLoops', () => {
    expect(resolveLoop({ loop: { mode: 'until', minLoops: 3, maxLoops: 'nope' } })).toMatchObject({ minLoops: 3, maxLoops: 3 });
  });
});

describe('findUpcomingTrackNodes', () => {
  /** Shorthand: build a graph from a list of [from, to] pairs plus node specs. */
  function graph(nodes, pairs) {
    return {
      version: 1,
      nodes,
      edges: pairs.map(([from, to], i) => ({ id: `e${i}`, from, to }))
    };
  }

  it('finds the single next Track down a linear chain', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 't2', type: 'track', soundId: 's2' }
      ],
      [['t1', 't2']]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id)).toEqual(['t2']);
  });

  it('crosses instantaneous nodes to reach the Track behind them', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'c1', type: 'condition' },
        { id: 'f1', type: 'fork' },
        { id: 't2', type: 'track', soundId: 's2' }
      ],
      [
        ['t1', 'c1'],
        ['c1', 'f1'],
        ['f1', 't2']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id)).toEqual(['t2']);
  });

  it('returns every branch of a Random/Condition, since the exit taken is unknown ahead of time', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'r1', type: 'random' },
        { id: 'ta', type: 'track', soundId: 'sa' },
        { id: 'tb', type: 'track', soundId: 'sb' }
      ],
      [
        ['t1', 'r1'],
        ['r1', 'ta'],
        ['r1', 'tb']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id).sort()).toEqual(['ta', 'tb']);
  });

  it('crosses a Delay - the track after a wait is still the next audio to play', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'd1', type: 'delay' },
        { id: 't2', type: 'track', soundId: 's2' }
      ],
      [
        ['t1', 'd1'],
        ['d1', 't2']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id)).toEqual(['t2']);
  });

  it('stops at the first Track on a branch rather than walking the whole graph', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 't2', type: 'track', soundId: 's2' },
        { id: 't3', type: 'track', soundId: 's3' }
      ],
      [
        ['t1', 't2'],
        ['t2', 't3']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id)).toEqual(['t2']);
  });

  it('stops at End and Playlist nodes', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'f1', type: 'fork' },
        { id: 'end', type: 'end' },
        { id: 'p1', type: 'playlist' },
        { id: 't2', type: 'track', soundId: 's2' }
      ],
      [
        ['t1', 'f1'],
        ['f1', 'end'],
        ['f1', 'p1'],
        ['p1', 't2']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1')).toEqual([]);
  });

  it('terminates on a cycle back through the starting node', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'c1', type: 'condition' }
      ],
      [
        ['t1', 'c1'],
        ['c1', 't1']
      ]
    );
    // t1 is the node being looked ahead FROM, so it is never itself a result.
    expect(findUpcomingTrackNodes(g, 't1')).toEqual([]);
  });

  it('terminates on a cycle of only instantaneous nodes', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'a', type: 'fork' },
        { id: 'b', type: 'fork' }
      ],
      [
        ['t1', 'a'],
        ['a', 'b'],
        ['b', 'a']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1')).toEqual([]);
  });

  it('deduplicates a Track reachable by more than one branch', () => {
    const g = graph(
      [
        { id: 't1', type: 'track', soundId: 's1' },
        { id: 'f1', type: 'fork' },
        { id: 'c1', type: 'condition' },
        { id: 'c2', type: 'condition' },
        { id: 't2', type: 'track', soundId: 's2' }
      ],
      [
        ['t1', 'f1'],
        ['f1', 'c1'],
        ['f1', 'c2'],
        ['c1', 't2'],
        ['c2', 't2']
      ]
    );
    expect(findUpcomingTrackNodes(g, 't1').map((n) => n.id)).toEqual(['t2']);
  });

  it('returns an empty list for a malformed graph or an unknown node', () => {
    expect(findUpcomingTrackNodes(null, 't1')).toEqual([]);
    expect(findUpcomingTrackNodes({ nodes: [], edges: [] }, '')).toEqual([]);
    expect(findUpcomingTrackNodes({ nodes: [], edges: [] }, 'nope')).toEqual([]);
    expect(findUpcomingTrackNodes({ nodes: [{ id: 't1', type: 'track' }] }, 't1')).toEqual([]);
  });
});

describe('createEmptyGraph', () => {
  it('is a single Start node with no edges', () => {
    const graph = createEmptyGraph();
    expect(graph.nodes).toEqual([{ id: 'start', type: 'start', x: 40, y: 40 }]);
    expect(graph.edges).toEqual([]);
  });

  it('has no crossfade override by default', () => {
    expect(createEmptyGraph().crossfadeMs).toBeNull();
  });
});

describe('resolveGraphCrossfadeMs', () => {
  it('is null (defer to the world setting) for a graph with no override', () => {
    expect(resolveGraphCrossfadeMs(createEmptyGraph())).toBeNull();
  });

  it('is null when crossfadeMs is undefined or explicitly null', () => {
    expect(resolveGraphCrossfadeMs({})).toBeNull();
    expect(resolveGraphCrossfadeMs({ crossfadeMs: null })).toBeNull();
  });

  it('returns a positive override', () => {
    expect(resolveGraphCrossfadeMs({ crossfadeMs: 150 })).toBe(150);
  });

  it('returns an explicit 0 rather than treating it as "no override"', () => {
    // 0 means "never crossfade this playlist", distinct from null ("defer to
    // the world setting") - collapsing the two would make it impossible to
    // opt a playlist OUT of a non-zero world default.
    expect(resolveGraphCrossfadeMs({ crossfadeMs: 0 })).toBe(0);
  });

  it('coerces a numeric string', () => {
    expect(resolveGraphCrossfadeMs({ crossfadeMs: '200' })).toBe(200);
  });

  it('treats a negative value as malformed and falls back to null', () => {
    expect(resolveGraphCrossfadeMs({ crossfadeMs: -50 })).toBeNull();
  });

  it('treats a non-numeric value as malformed and falls back to null', () => {
    expect(resolveGraphCrossfadeMs({ crossfadeMs: 'not a number' })).toBeNull();
    expect(resolveGraphCrossfadeMs({ crossfadeMs: NaN })).toBeNull();
  });

  it('tolerates a missing graph entirely', () => {
    expect(resolveGraphCrossfadeMs(null)).toBeNull();
    expect(resolveGraphCrossfadeMs(undefined)).toBeNull();
  });
});

// The three modules that need "does this kind take a value?" each used to keep
// their own copy: the inspector (render a value select?), the node renderer
// (does the chip name a value?), and graph-validation (is a missing value an
// error?). A kind added to two of three would have disagreed silently.
describe('condition value requirements', () => {
  it('lists exactly the kinds that match against an overlay id', () => {
    expect([...CONDITION_KINDS_WITH_VALUE].sort()).toEqual(['mood', 'phase']);
  });

  it('reports a value-taking kind with nothing selected', () => {
    expect(conditionMissingValue({ kind: 'mood' })).toBe(true);
    expect(conditionMissingValue({ kind: 'phase', value: null })).toBe(true);
  });

  it('treats empty and whitespace-only the same as absent - unselectable either way', () => {
    expect(conditionMissingValue({ kind: 'mood', value: '' })).toBe(true);
    expect(conditionMissingValue({ kind: 'mood', value: '  ' })).toBe(true);
  });

  it('is satisfied by any non-blank value', () => {
    expect(conditionMissingValue({ kind: 'mood', value: 'tense' })).toBe(false);
  });

  it('says nothing about kinds that take no value, or about a missing condition', () => {
    for (const kind of ['combatActive', 'combatIdle', 'moodChanged', 'phaseChanged', 'enemiesDefeated', 'default']) {
      expect(conditionMissingValue({ kind })).toBe(false);
    }
    expect(conditionMissingValue(undefined)).toBe(false);
    expect(conditionMissingValue({})).toBe(false);
  });
});

describe('conditionSignature', () => {
  it('collapses two conditions that no game state could tell apart', () => {
    expect(conditionSignature({ kind: 'combatActive' })).toBe(conditionSignature({ kind: 'combatActive' }));
    expect(conditionSignature({ kind: 'mood', value: 'calm' })).toBe(conditionSignature({ kind: 'mood', value: ' calm ' }));
  });

  it('separates different kinds, and different values of the same kind', () => {
    expect(conditionSignature({ kind: 'combatActive' })).not.toBe(conditionSignature({ kind: 'combatIdle' }));
    expect(conditionSignature({ kind: 'mood', value: 'calm' })).not.toBe(conditionSignature({ kind: 'mood', value: 'tense' }));
  });

  it('ignores a value on a kind that does not carry one - it changes nothing at runtime', () => {
    expect(conditionSignature({ kind: 'moodChanged', value: 'calm' })).toBe(conditionSignature({ kind: 'moodChanged' }));
  });

  it('never confuses a valued kind with an unvalued one of a similar name', () => {
    expect(conditionSignature({ kind: 'mood', value: 'changed' })).not.toBe(conditionSignature({ kind: 'moodChanged' }));
  });
});

describe('pickRandomExit', () => {
  const edges = (...specs) => specs.map((s, i) => ({ id: `e${i + 1}`, from: 'r', to: s.to ?? `t${i + 1}`, ...s }));
  const seeded = (...values) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };

  it('picks by weight', () => {
    const es = edges({ weight: 1 }, { weight: 3 });
    // total 4; roll 0.5 * 4 = 2 -> past e1's weight of 1, lands on e2.
    expect(pickRandomExit({ id: 'r' }, es, [], seeded(0.5), 32).edge.id).toBe('e2');
    expect(pickRandomExit({ id: 'r' }, es, [], seeded(0.1), 32).edge.id).toBe('e1');
  });

  it('picks uniformly when every candidate weighs 0, and says so', () => {
    const es = edges({ weight: 0 }, { weight: 0 });
    const pick = pickRandomExit({ id: 'r' }, es, [], seeded(0.9), 32);
    expect(pick.allWeightsZero).toBe(true);
    expect(pick.edge.id).toBe('e2'); // floor(0.9 * 2) = 1
  });

  it('excludes an edge still inside its cooldown', () => {
    const es = edges({ weight: 1, cooldown: 3 }, { weight: 1 });
    const pick = pickRandomExit({ id: 'r' }, es, ['e1'], seeded(0), 32);
    expect(pick.edge.id).toBe('e2');
    expect(pick.eligible).toBe(1);
  });

  it('ignores cooldowns rather than deadlocking when every edge is cooling down', () => {
    const es = edges({ weight: 1, cooldown: 5 }, { weight: 1, cooldown: 5 });
    const pick = pickRandomExit({ id: 'r' }, es, ['e1', 'e2'], seeded(0), 32);
    expect(pick.eligible).toBe(2);
  });

  it('avoidRepeat dedups by target node, not by edge', () => {
    // e1 and e2 both lead to t1; the last pick was e1, so BOTH must be excluded.
    const es = edges({ to: 't1', weight: 1 }, { to: 't1', weight: 1 }, { to: 't2', weight: 1 });
    const pick = pickRandomExit({ id: 'r', avoidRepeat: true }, es, ['e1'], seeded(0), 32);
    expect(pick.edge.to).toBe('t2');
  });

  it('does not mutate the history it is given', () => {
    const history = ['e2'];
    const pick = pickRandomExit({ id: 'r' }, edges({ weight: 1 }), history, seeded(0), 32);
    expect(history).toEqual(['e2']);
    expect(pick.history).toEqual(['e1', 'e2']);
  });

  it('caps the returned history at maxHistory', () => {
    const pick = pickRandomExit({ id: 'r' }, edges({ weight: 1 }), ['a', 'b', 'c'], seeded(0), 2);
    expect(pick.history).toEqual(['e1', 'a']);
  });

  it('returns null when the node has no outgoing edges', () => {
    expect(pickRandomExit({ id: 'r' }, [], [], seeded(0), 32)).toBeNull();
  });
});

describe('planNextHandoff', () => {
  const defaults = {
    fromSoundId: 's1',
    rng: () => 0,
    evaluateCondition: () => true,
    recentPicks: new Map(),
    maxHistory: 32,
    isBusy: () => false
  };
  const plan = (graph, options = {}) => planNextHandoff(graph, 't1', { ...defaults, ...options });
  const track = (id, soundId) => ({ id, type: 'track', soundId });

  it('plans straight through a direct edge', () => {
    const result = plan({
      nodes: [track('t1', 's1'), track('t2', 's2')],
      edges: [{ id: 'e1', from: 't1', to: 't2' }]
    });
    expect(result).toEqual({ nodeId: 't2', soundId: 's2', edgeIds: ['e1'], decisions: [] });
  });

  it('plans across a Random node and records the history it would write', () => {
    const result = plan({
      nodes: [track('t1', 's1'), { id: 'r', type: 'random' }, track('t2', 's2')],
      edges: [
        { id: 'e1', from: 't1', to: 'r' },
        { id: 'e2', from: 'r', to: 't2', weight: 1 }
      ]
    });
    expect(result.nodeId).toBe('t2');
    expect(result.edgeIds).toEqual(['e1', 'e2']);
    expect(result.decisions).toEqual([{ nodeId: 'r', edgeId: 'e2', historyAfter: ['e2'] }]);
  });

  it('plans across a Condition node and records the exit it chose', () => {
    const graph = {
      nodes: [track('t1', 's1'), { id: 'c', type: 'condition' }, track('t2', 's2'), track('t3', 's3')],
      edges: [
        { id: 'e1', from: 't1', to: 'c' },
        { id: 'e2', from: 'c', to: 't2', condition: { kind: 'combatActive' } },
        { id: 'e3', from: 'c', to: 't3', condition: { kind: 'default' } }
      ]
    };
    const inCombat = plan(graph, { evaluateCondition: (c) => c.kind === 'combatActive' });
    expect(inCombat.nodeId).toBe('t2');
    expect(inCombat.decisions).toEqual([{ nodeId: 'c', edgeId: 'e2' }]);

    const idle = plan(graph, { evaluateCondition: (c) => c.kind === 'default' });
    expect(idle.nodeId).toBe('t3');
  });

  describe('bails (returns null) rather than arming the wrong thing', () => {
    it('on a Fork - it spawns N tokens, which one armed seam cannot represent', () => {
      expect(
        plan({
          nodes: [track('t1', 's1'), { id: 'f', type: 'fork' }, track('t2', 's2')],
          edges: [
            { id: 'e1', from: 't1', to: 'f' },
            { id: 'e2', from: 'f', to: 't2' }
          ]
        })
      ).toBeNull();
    });

    it('on a Delay - the silence there is intentional, and the seam moves', () => {
      expect(
        plan({
          nodes: [track('t1', 's1'), { id: 'd', type: 'delay', delay: { min: 1, max: 1 } }, track('t2', 's2')],
          edges: [
            { id: 'e1', from: 't1', to: 'd' },
            { id: 'e2', from: 'd', to: 't2' }
          ]
        })
      ).toBeNull();
    });

    it('on a Playlist node - its child engine\'s first track is unknowable', () => {
      expect(
        plan({
          nodes: [track('t1', 's1'), { id: 'p', type: 'playlist' }],
          edges: [{ id: 'e1', from: 't1', to: 'p' }]
        })
      ).toBeNull();
    });

    it('on an End node', () => {
      expect(
        plan({ nodes: [track('t1', 's1'), { id: 'end', type: 'end' }], edges: [{ id: 'e1', from: 't1', to: 'end' }] })
      ).toBeNull();
    });

    it('on a dangling edge', () => {
      expect(plan({ nodes: [track('t1', 's1')], edges: [{ id: 'e1', from: 't1', to: 'nope' }] })).toBeNull();
    });

    it('when the node has no exit at all', () => {
      expect(plan({ nodes: [track('t1', 's1')], edges: [] })).toBeNull();
    });

    it('when the next Track reuses the sound being handed off FROM', () => {
      expect(
        plan({
          nodes: [track('t1', 's1'), track('t2', 's1')],
          edges: [{ id: 'e1', from: 't1', to: 't2' }]
        })
      ).toBeNull();
    });

    it('when the target is already busy (singleton / sound ownership)', () => {
      expect(
        plan(
          { nodes: [track('t1', 's1'), track('t2', 's2')], edges: [{ id: 'e1', from: 't1', to: 't2' }] },
          { isBusy: () => true }
        )
      ).toBeNull();
    });

    it('when no Condition exit matches - the token would terminate there', () => {
      expect(
        plan(
          {
            nodes: [track('t1', 's1'), { id: 'c', type: 'condition' }, track('t2', 's2')],
            edges: [
              { id: 'e1', from: 't1', to: 'c' },
              { id: 'e2', from: 'c', to: 't2', condition: { kind: 'combatActive' } }
            ]
          },
          { evaluateCondition: () => false }
        )
      ).toBeNull();
    });

    it('on a cycle back to an already-visited node', () => {
      expect(
        plan({
          nodes: [track('t1', 's1'), { id: 'c', type: 'condition' }],
          edges: [
            { id: 'e1', from: 't1', to: 'c' },
            { id: 'e2', from: 'c', to: 'c', condition: { kind: 'default' } }
          ]
        })
      ).toBeNull();
    });

    it('on a malformed graph', () => {
      expect(planNextHandoff(null, 't1', defaults)).toBeNull();
      expect(planNextHandoff({ nodes: [], edges: [] }, '', defaults)).toBeNull();
    });
  });
});
