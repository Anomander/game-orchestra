import { describe, it, expect } from 'vitest';
import { validateGraph, hasInstantaneousCycle, findInstantaneousCycle, findUnreachableNodes, reachesPlaylist } from '../scripts/graph-validation.mjs';

function graph(nodes, edges) {
  return { version: 1, nodes, edges };
}

describe('validateGraph', () => {
  it('accepts a minimal valid graph: Start -> Track -> End', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.infos).toEqual([{ nodeId: null, nodeLabel: null, messageKey: 'GameOrchestra.CustomEditor.Validation.GraphEndsInfo' }]);
  });

  it('accepts a valid graph with a genuine loop (no End) and reports no "graph ends" info', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
        { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
      ],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't2' }, { id: 'e3', from: 't2', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
    expect(result.infos).toEqual([]);
  });

  it('rejects a graph with no Start node', () => {
    const g = graph([{ id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }], []);
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ messageKey: 'GameOrchestra.CustomEditor.Validation.NoStartNode' }));
  });

  it('rejects a graph with more than one Start node', () => {
    const g = graph(
      [{ id: 's1', type: 'start' }, { id: 's2', type: 'start' }, { id: 't1', type: 'track', soundId: 'x', loop: { mode: 'count', count: 1 } }],
      [{ id: 'e1', from: 's1', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 's2' }));
  });

  it('rejects a Start node without exactly one exit', () => {
    const zeroExit = validateGraph(graph([{ id: 'start', type: 'start' }], []));
    expect(zeroExit.errors).toContainEqual(expect.objectContaining({ nodeId: 'start', messageKey: 'GameOrchestra.CustomEditor.Validation.StartMustHaveOneExit' }));

    const twoExits = validateGraph(
      graph(
        [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }, { id: 't2', type: 'track', soundId: 'b', loop: { mode: 'count', count: 1 } }],
        [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 'start', to: 't2' }]
      )
    );
    expect(twoExits.errors).toContainEqual(expect.objectContaining({ nodeId: 'start' }));
  });

  it('rejects an End node with an outgoing exit', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }],
      [{ id: 'e1', from: 'start', to: 'end' }, { id: 'e2', from: 'end', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'end', messageKey: 'GameOrchestra.CustomEditor.Validation.EndMustHaveNoExits' }));
  });

  it('rejects a Track node without exactly one exit', () => {
    const g = graph([{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }], [{ id: 'e1', from: 'start', to: 't1' }]);
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackMustHaveOneExit' }));
  });

  it('rejects a Track node with no soundId', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackNoSound' }));
  });

  it('rejects a Track node whose soundId no longer exists in the playlist, when a playlist is provided', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ghost', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const playlist = { sounds: { get: (id) => (id === 'ghost' ? null : { id }) } };
    const result = validateGraph(g, { playlist });
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackMissingSound' }));
  });

  it('does not check sound existence when no playlist is provided', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ghost', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.TrackMissingSound')).toBe(false);
  });

  it('rejects a Track node with loopCount less than 1', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 0 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackLoopCountMin' }));
  });

  it('accepts an infinite Track node with no exit and no loopCount', () => {
    const g = graph([{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'forever' } }], [{ id: 'e1', from: 'start', to: 't1' }]);
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 't1')).toBe(false);
  });

  it('rejects an infinite Track node that still has an exit', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'forever' } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.InfiniteTrackMustHaveNoExit' }));
  });

  it('does not require loopCount on an infinite Track node', () => {
    const g = graph([{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'forever' } }], [{ id: 'e1', from: 'start', to: 't1' }]);
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.TrackLoopCountMin')).toBe(false);
  });

  it('accepts an until-mode Track node with exactly one exit and a valid condition', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 't1')).toBe(false);
  });

  it('rejects an until-mode Track node without exactly one exit', () => {
    const zeroExit = validateGraph(
      graph([{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 1 } }], [{ id: 'e1', from: 'start', to: 't1' }])
    );
    expect(zeroExit.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.UntilTrackMustHaveOneExit' }));

    const twoExits = validateGraph(
      graph(
        [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 1 } },
          { id: 'e1n', type: 'end' },
          { id: 'e2n', type: 'end' }
        ],
        [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'e1n' }, { id: 'e3', from: 't1', to: 'e2n' }]
      )
    );
    expect(twoExits.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.UntilTrackMustHaveOneExit' }));
  });

  it('rejects an until-mode Track node with no condition kind set', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', minLoops: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.UntilMissingCondition' }));
  });

  it('rejects an until-mode Track node with minLoops less than 1', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 0 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.LoopMinLoopsMin' }));
  });

  it('rejects an until-mode Track node whose maxLoops is below its minLoops', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 5, maxLoops: 2 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.LoopMaxLoopsBelowMin' }));
  });

  it('accepts an until-mode Track node with no maxLoops (unbounded)', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 5, maxLoops: null } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 't1' && e.messageKey === 'GameOrchestra.CustomEditor.Validation.LoopMaxLoopsBelowMin')).toBe(false);
  });

  it('warns when an until-mode Track node self-loops', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 1 } }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackSelfLoopWarning' }));
  });

  it('rejects a Delay node with an invalid min/max range', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'd1', type: 'delay', delay: { min: 5, max: 2 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'd1' }, { id: 'e2', from: 'd1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'd1', messageKey: 'GameOrchestra.CustomEditor.Validation.DelayInvalidRange' }));
  });

  it('rejects a Fork node with fewer than 2 exits', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'f1', type: 'fork' }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'f1' }, { id: 'e2', from: 'f1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'f1', messageKey: 'GameOrchestra.CustomEditor.Validation.ForkMinExits' }));
  });

  it('accepts a Fork node with 2 exits', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'f1', type: 'fork' }, { id: 'e1n', type: 'end' }, { id: 'e2n', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'f1' }, { id: 'e2', from: 'f1', to: 'e1n' }, { id: 'e3', from: 'f1', to: 'e2n' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 'f1')).toBe(false);
  });

  it('rejects a Random node with no exits', () => {
    const g = graph([{ id: 'start', type: 'start' }, { id: 'r1', type: 'random' }], [{ id: 'e1', from: 'start', to: 'r1' }]);
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'r1', messageKey: 'GameOrchestra.CustomEditor.Validation.RandomMinExits' }));
  });

  it('rejects a Random exit missing a weight', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'r1', type: 'random' }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'r1' }, { id: 'e2', from: 'r1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'r1', messageKey: 'GameOrchestra.CustomEditor.Validation.RandomExitMissingWeight' }));
  });

  it('warns when every Random exit is weighted 0', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'r1', type: 'random' }, { id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'r1' }, { id: 'e2', from: 'r1', to: 'a', weight: 0 }, { id: 'e3', from: 'r1', to: 'b', weight: 0 }]
    );
    const result = validateGraph(g);
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'r1', messageKey: 'GameOrchestra.CustomEditor.Validation.RandomAllZeroWeight' }));
    expect(result.errors.some((e) => e.nodeId === 'r1')).toBe(false);
  });

  it('does not warn about all-zero weights when at least one Random exit has a nonzero weight', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'r1', type: 'random' }, { id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'r1' }, { id: 'e2', from: 'r1', to: 'a', weight: 0 }, { id: 'e3', from: 'r1', to: 'b', weight: 1 }]
    );
    const result = validateGraph(g);
    expect(result.warnings.some((w) => w.nodeId === 'r1' && w.messageKey === 'GameOrchestra.CustomEditor.Validation.RandomAllZeroWeight')).toBe(false);
  });

  it('rejects a Condition exit missing a condition', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'c1', type: 'condition' }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'c1' }, { id: 'e2', from: 'c1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'c1', messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionExitMissingCondition' }));
  });

  // REPORTED LIVE from a canvas full of "(not set)" chips on a graph that saved
  // cleanly: having a KIND is not enough. A mood/phase condition with no id can
  // never match, so the exit it guards is unreachable and the branch is dead.
  describe('a mood/phase condition with no value selected', () => {
    const conditionGraph = (condition) =>
      graph(
        [{ id: 'start', type: 'start' }, { id: 'c1', type: 'condition' }, { id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
        [
          { id: 'e1', from: 'start', to: 'c1' },
          { id: 'e2', from: 'c1', to: 'a', condition },
          { id: 'e3', from: 'c1', to: 'b', condition: { kind: 'default' } }
        ]
      );
    const untilGraph = (condition) =>
      graph(
        [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'until', condition, minLoops: 1 } }, { id: 'end', type: 'end' }],
        [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      );
    const errorKeys = (g) => validateGraph(g).errors.map((e) => e.messageKey);

    it.each([['mood'], ['phase']])('is an ERROR on a Condition exit (%s), so it blocks saving', (kind) => {
      expect(errorKeys(conditionGraph({ kind }))).toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
    });

    it('treats an empty or whitespace-only value as unset', () => {
      expect(errorKeys(conditionGraph({ kind: 'mood', value: '' }))).toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
      expect(errorKeys(conditionGraph({ kind: 'mood', value: '   ' }))).toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
    });

    it('accepts a condition once a value is selected', () => {
      expect(errorKeys(conditionGraph({ kind: 'mood', value: 'tense' }))).not.toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
    });

    it('leaves kinds that take no value alone', () => {
      for (const kind of ['combatActive', 'combatIdle', 'moodChanged', 'phaseChanged', 'enemiesDefeated', 'default']) {
        expect(errorKeys(conditionGraph({ kind }))).not.toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
      }
    });

    // The same defect on the same kind of guard - an until-loop's escape
    // condition is a guard on that node's one exit, so it must block too.
    it("is an ERROR on a Track's until-loop condition as well", () => {
      expect(errorKeys(untilGraph({ kind: 'mood' }))).toContain('GameOrchestra.CustomEditor.Validation.UntilMissingValue');
      expect(errorKeys(untilGraph({ kind: 'mood', value: 'tense' }))).not.toContain('GameOrchestra.CustomEditor.Validation.UntilMissingValue');
    });

    // The missing-KIND rule already covers that case; reporting both for one
    // exit would put two errors on the same node saying the same thing.
    it('does not double-report an exit that has no kind at all', () => {
      const keys = errorKeys(conditionGraph({}));
      expect(keys).toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingCondition');
      expect(keys).not.toContain('GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue');
    });
  });

  // _enterCondition returns on the FIRST matching edge, so a repeat of an
  // earlier condition is unreachable however the game state falls - the same
  // shape of dead branch as a 'default' that isn't last.
  describe('duplicate Condition exits', () => {
    const withExits = (...conditions) =>
      graph(
        [{ id: 'start', type: 'start' }, { id: 'c1', type: 'condition' }, { id: 'x', type: 'end' }],
        [{ id: 'e1', from: 'start', to: 'c1' }, ...conditions.map((condition, i) => ({ id: `x${i}`, from: 'c1', to: 'x', condition }))]
      );
    const dupes = (g) => validateGraph(g).errors.filter((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.ConditionExitDuplicate');

    it('rejects two exits testing the same thing', () => {
      expect(dupes(withExits({ kind: 'combatActive' }, { kind: 'combatActive' }, { kind: 'default' }))).toHaveLength(1);
    });

    it('names the shadowed exit and the one shadowing it, so the message is actionable', () => {
      const [issue] = dupes(withExits({ kind: 'combatActive' }, { kind: 'combatIdle' }, { kind: 'combatActive' }, { kind: 'default' }));
      expect(issue.messageData).toEqual({ index: 2, first: 0 });
    });

    it('reports every repeat, not just the first', () => {
      expect(dupes(withExits({ kind: 'combatActive' }, { kind: 'combatActive' }, { kind: 'combatActive' }))).toHaveLength(2);
    });

    it('compares the VALUE too, so different moods are different conditions', () => {
      expect(dupes(withExits({ kind: 'mood', value: 'calm' }, { kind: 'mood', value: 'tense' }))).toHaveLength(0);
      expect(dupes(withExits({ kind: 'mood', value: 'calm' }, { kind: 'mood', value: 'calm' }))).toHaveLength(1);
    });

    it('ignores whitespace around a value, matching how the chip reads it', () => {
      expect(dupes(withExits({ kind: 'mood', value: 'calm' }, { kind: 'mood', value: ' calm ' }))).toHaveLength(1);
    });

    it('does not confuse a kind that takes a value with one that does not', () => {
      expect(dupes(withExits({ kind: 'mood', value: 'calm' }, { kind: 'moodChanged' }))).toHaveLength(0);
    });

    it('allows two different conditions routed to the same target', () => {
      expect(dupes(withExits({ kind: 'combatActive' }, { kind: 'combatIdle' }))).toHaveLength(0);
    });

    // Each of these is already an error on its own; a duplicate report on top
    // would be two errors on one node for a single mistake.
    it('leaves already-reported exits alone rather than double-reporting them', () => {
      expect(dupes(withExits({}, {}))).toHaveLength(0);
      expect(dupes(withExits({ kind: 'mood' }, { kind: 'mood' }))).toHaveLength(0);
    });

    it("does not flag two 'default' exits - ConditionDefaultMustBeLast already covers that", () => {
      const result = validateGraph(withExits({ kind: 'default' }, { kind: 'default' }));
      expect(result.errors.map((e) => e.messageKey)).toContain('GameOrchestra.CustomEditor.Validation.ConditionDefaultMustBeLast');
      expect(dupes(withExits({ kind: 'default' }, { kind: 'default' }))).toHaveLength(0);
    });

    it('blocks saving', () => {
      expect(validateGraph(withExits({ kind: 'combatActive' }, { kind: 'combatActive' })).valid).toBe(false);
    });
  });

  it("rejects a 'default' Condition exit that is not last", () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'c1', type: 'condition' }, { id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
      [
        { id: 'e1', from: 'start', to: 'c1' },
        { id: 'e2', from: 'c1', to: 'a', condition: { kind: 'default' } },
        { id: 'e3', from: 'c1', to: 'b', condition: { kind: 'combatActive' } }
      ]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'c1', messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionDefaultMustBeLast' }));
  });

  it('accepts a default Condition exit that IS last', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'c1', type: 'condition' }, { id: 'a', type: 'end' }, { id: 'b', type: 'end' }],
      [
        { id: 'e1', from: 'start', to: 'c1' },
        { id: 'e2', from: 'c1', to: 'a', condition: { kind: 'combatActive' } },
        { id: 'e3', from: 'c1', to: 'b', condition: { kind: 'default' } }
      ]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 'c1')).toBe(false);
  });

  it('rejects an unknown node type', () => {
    const g = graph([{ id: 'start', type: 'start' }, { id: 'x1', type: 'mystery' }], [{ id: 'e1', from: 'start', to: 'x1' }]);
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ nodeId: 'x1', messageKey: 'GameOrchestra.CustomEditor.Validation.UnknownNodeType', messageData: { type: 'mystery' } })
    );
  });

  it('reports an unreachable node as a warning, not an error', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }, { id: 'orphan', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'orphan' }));
  });

  it('warns (but does not error) when a Track exit points back to itself', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 't1', messageKey: 'GameOrchestra.CustomEditor.Validation.TrackSelfLoopWarning' }));
  });

  it('does not warn about a Track that loops to a DIFFERENT track, only a genuine self-loop', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }, { id: 't2', type: 'track', soundId: 'b', loop: { mode: 'count', count: 1 } }],
      [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't2' }, { id: 'e3', from: 't2', to: 't1' }]
    );
    const result = validateGraph(g);
    expect(result.warnings.some((w) => w.messageKey === 'GameOrchestra.CustomEditor.Validation.TrackSelfLoopWarning')).toBe(false);
  });

  it('warns when a Delay self-loops with a 0-0s range (ticks with no pause)', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'd1', type: 'delay', delay: { min: 0, max: 0 } }],
      [{ id: 'e1', from: 'start', to: 'd1' }, { id: 'e2', from: 'd1', to: 'd1' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'd1', messageKey: 'GameOrchestra.CustomEditor.Validation.DelaySelfLoopZeroWarning' }));
  });

  it('does not warn about a Delay self-loop that has a real, non-zero range', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'd1', type: 'delay', delay: { min: 2, max: 5 } }],
      [{ id: 'e1', from: 'start', to: 'd1' }, { id: 'e2', from: 'd1', to: 'd1' }]
    );
    const result = validateGraph(g);
    expect(result.warnings.some((w) => w.nodeId === 'd1')).toBe(false);
  });

  it('rejects an all-instantaneous cycle (Fork/Random/Condition/Start with no Track or Delay)', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'f1', type: 'fork' }, { id: 'r1', type: 'random' }],
      [{ id: 'e1', from: 'start', to: 'f1' }, { id: 'e2', from: 'f1', to: 'r1' }, { id: 'e3', from: 'r1', to: 'f1', weight: 1 }, { id: 'e4', from: 'f1', to: 'r1' }]
    );
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ messageKey: 'GameOrchestra.CustomEditor.Validation.InstantaneousCycle' }));
  });

  it('names the offending nodes and edges on the instantaneous-cycle error', () => {
    // Without these the error is true but unactionable: on a canvas larger than
    // the viewport, "the graph contains a cycle" gives the reader nothing to
    // click and no wire to follow.
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'f1', type: 'fork' }, { id: 'r1', type: 'random' }],
      [{ id: 'e1', from: 'start', to: 'f1' }, { id: 'e2', from: 'f1', to: 'r1' }, { id: 'e3', from: 'r1', to: 'f1', weight: 1 }, { id: 'e4', from: 'f1', to: 'r1' }]
    );
    const issue = validateGraph(g).errors.find((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.InstantaneousCycle');
    expect(issue.nodeIds).toEqual(['f1', 'r1']);
    expect(issue.edgeIds).toEqual(['e2', 'e3']);
    // Anchor for click-to-focus, and the loop spelled out for the message.
    expect(issue.nodeId).toBe('f1');
    expect(issue.messageData.path).toBe('Fork → Random → Fork');
    // Suppressed for a multi-node issue: the path already opens with this
    // label, so prefixing would print it twice.
    expect(issue.nodeLabel).toBe(null);
  });

  it('excludes the lead-in from the reported cycle', () => {
    // Start is instantaneous and feeds the loop, but is not ON it - reporting
    // it would send the reader to a node they cannot fix.
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'f1', type: 'fork' }, { id: 'f2', type: 'fork' }],
      [{ id: 'e1', from: 'start', to: 'f1' }, { id: 'e2', from: 'f1', to: 'f2' }, { id: 'e3', from: 'f1', to: 'f2' }, { id: 'e4', from: 'f2', to: 'f1' }, { id: 'e5', from: 'f2', to: 'f1' }]
    );
    const issue = validateGraph(g).errors.find((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.InstantaneousCycle');
    expect(issue.nodeIds).toEqual(['f1', 'f2']);
    expect(issue.nodeIds).not.toContain('start');
  });

  it('does not report the "graph ends" info when the graph is invalid', () => {
    const g = graph([{ id: 't1', type: 'track', soundId: 'a', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }], [{ id: 'e1', from: 't1', to: 'end' }]);
    const result = validateGraph(g);
    expect(result.valid).toBe(false);
    expect(result.infos).toEqual([]);
  });
});

describe('validateGraph: Playlist nodes (docs/playlist-node-plan.md Phase 5)', () => {
  function directRef(playlistId) {
    return { source: 'direct', playlistId };
  }

  it('accepts a valid Playlist node with a direct reference', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [{ id: 'pl-target', name: 'Target', mode: -1, isCustom: true, soundCount: 1, graph: { version: 1, nodes: [], edges: [] } }];
    const result = validateGraph(g, { playlist: { id: 'pl-self' }, playlists });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('V1: rejects a finite Playlist node without exactly one exit', () => {
    const zeroExit = validateGraph(
      graph([{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('t'), loop: { mode: 'count', count: 1 } }], [{ id: 'e1', from: 'start', to: 'p1' }])
    );
    expect(zeroExit.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistMustHaveOneExit' }));

    const twoExits = validateGraph(
      graph(
        [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('t'), loop: { mode: 'count', count: 1 } },
          { id: 'a', type: 'end' },
          { id: 'b', type: 'end' }
        ],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'a' }, { id: 'e3', from: 'p1', to: 'b' }]
      )
    );
    expect(twoExits.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistMustHaveOneExit' }));
  });

  it('V2: rejects an infinite Playlist node that still has an exit', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('t'), loop: { mode: 'forever' } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.InfinitePlaylistMustHaveNoExit' }));
  });

  it('accepts an infinite Playlist node with no exit', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('t'), loop: { mode: 'forever' } }],
      [{ id: 'e1', from: 'start', to: 'p1' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 'p1')).toBe(false);
  });

  it('V3: rejects a finite Playlist node with loopCount less than 1', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('t'), loop: { mode: 'count', count: 0 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistLoopCountMin' }));
  });

  it('V4: rejects a Playlist node with a missing or invalid reference', () => {
    const missing = validateGraph(
      graph(
        [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      )
    );
    expect(missing.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistNoReference' }));

    const invalidSource = validateGraph(
      graph(
        [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'bogus' }, loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      )
    );
    expect(invalidSource.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistNoReference' }));
  });

  it('V5: rejects a direct reference with no playlistId', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef(null), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistNoTarget' }));
  });

  it('V6: rejects a direct reference to a playlist not found in the provided playlists list', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('ghost'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g, { playlists: [] });
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistMissingTarget' }));
  });

  it('V6: skips the missing-target check entirely when no playlists list is provided', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('ghost'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.messageKey === 'GameOrchestra.CustomEditor.Validation.PlaylistMissingTarget')).toBe(false);
  });

  it('V7: rejects a direct self-reference', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-self'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g, { playlist: { id: 'pl-self' } });
    expect(result.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistSelfReference' }));
  });

  it('V8: rejects an indirect reference with an invalid section, mood mode, or a missing specific mood id', () => {
    const badSection = validateGraph(
      graph(
        [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'bogus', overlayMode: 'none' }, loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      )
    );
    expect(badSection.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistInvalidSection' }));

    const badMoodMode = validateGraph(
      graph(
        [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'bogus' }, loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      )
    );
    expect(badMoodMode.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistInvalidSection' }));

    const missingMoodId = validateGraph(
      graph(
        [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'specific', overlayId: null }, loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      )
    );
    expect(missingMoodId.errors).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistInvalidSection' }));
  });

  it('accepts a valid indirect reference', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'combat', overlayMode: 'active' }, loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.errors.some((e) => e.nodeId === 'p1')).toBe(false);
  });

  it('V9: warns when a direct target is a Soundboard (UNSEQUENCED, no graph)', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-sb'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [{ id: 'pl-sb', name: 'Soundboard', mode: -1, isCustom: false, soundCount: 3, graph: null }];
    const result = validateGraph(g, { playlists });
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistSoundboardTarget' }));
    expect(result.errors.some((e) => e.nodeId === 'p1')).toBe(false);
  });

  it('does not warn PlaylistSoundboardTarget for a direct target that has its own graph', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-custom'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [{ id: 'pl-custom', name: 'Custom', mode: -1, isCustom: true, soundCount: 3, graph: { version: 1, nodes: [], edges: [] } }];
    const result = validateGraph(g, { playlists });
    expect(result.warnings.some((w) => w.messageKey === 'GameOrchestra.CustomEditor.Validation.PlaylistSoundboardTarget')).toBe(false);
  });

  it('V10: warns when a direct target has no graph and no sounds', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-empty'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [{ id: 'pl-empty', name: 'Empty', mode: 0, isCustom: false, soundCount: 0, graph: null }];
    const result = validateGraph(g, { playlists });
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistEmptyTarget' }));
  });

  it('V11: warns when a specific mood reference names a mood not in the configured list', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'specific', overlayId: 'ghost-mood' }, loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g, { moodIds: ['calm', 'tense'] });
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistUnknownOverlay' }));
  });

  it('V11: skips the unknown-mood check when no moodIds list is provided', () => {
    const g = graph(
      [
        { id: 'start', type: 'start' },
        { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'specific', overlayId: 'ghost-mood' }, loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const result = validateGraph(g);
    expect(result.warnings.some((w) => w.messageKey === 'GameOrchestra.CustomEditor.Validation.PlaylistUnknownOverlay')).toBe(false);
  });

  it('V12: warns when a direct reference chain leads back to the playlist being edited', () => {
    // Edited playlist ('pl-self') -> p1 -> 'pl-b', whose own graph references
    // 'pl-self' back directly - a cycle the engine's runtime registry refuses
    // safely, but the node will never actually run a pass.
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-b'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [
      {
        id: 'pl-b',
        name: 'B',
        mode: -1,
        isCustom: true,
        soundCount: 0,
        graph: {
          version: 1,
          nodes: [{ id: 's', type: 'start' }, { id: 'p', type: 'playlist', playlistRef: directRef('pl-self'), loop: { mode: 'count', count: 1 } }],
          edges: [{ id: 'e1', from: 's', to: 'p' }]
        }
      }
    ];
    const result = validateGraph(g, { playlist: { id: 'pl-self' }, playlists });
    expect(result.warnings).toContainEqual(expect.objectContaining({ nodeId: 'p1', messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistReferenceCycle' }));
  });

  it('does not warn PlaylistReferenceCycle for a reference that does not lead back to the edited playlist', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-b'), loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
    );
    const playlists = [{ id: 'pl-b', name: 'B', mode: -1, isCustom: false, soundCount: 1, graph: null }];
    const result = validateGraph(g, { playlist: { id: 'pl-self' }, playlists });
    expect(result.warnings.some((w) => w.messageKey === 'GameOrchestra.CustomEditor.Validation.PlaylistReferenceCycle')).toBe(false);
  });
});

describe('reachesPlaylist', () => {
  it('returns false when there is no path', () => {
    const playlistsById = new Map([['a', { graph: { nodes: [], edges: [] } }]]);
    expect(reachesPlaylist('a', 'b', playlistsById)).toBe(false);
  });

  it('returns true for a direct reference', () => {
    const playlistsById = new Map([
      ['a', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'b' } }], edges: [] } }]
    ]);
    expect(reachesPlaylist('a', 'b', playlistsById)).toBe(true);
  });

  it('returns true for a transitive chain of direct references', () => {
    const playlistsById = new Map([
      ['a', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'b' } }], edges: [] } }],
      ['b', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'c' } }], edges: [] } }]
    ]);
    expect(reachesPlaylist('a', 'c', playlistsById)).toBe(true);
  });

  it('does not follow an indirect reference', () => {
    const playlistsById = new Map([
      ['a', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'none' } }], edges: [] } }]
    ]);
    expect(reachesPlaylist('a', 'b', playlistsById)).toBe(false);
  });

  it('terminates on a cycle instead of recursing forever', () => {
    const playlistsById = new Map([
      ['a', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'b' } }], edges: [] } }],
      ['b', { graph: { nodes: [{ id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'a' } }], edges: [] } }]
    ]);
    expect(reachesPlaylist('a', 'z', playlistsById)).toBe(false);
  });

  it('handles a playlist with no graph (a native target) as a dead end', () => {
    const playlistsById = new Map([['a', { graph: null }]]);
    expect(reachesPlaylist('a', 'b', playlistsById)).toBe(false);
  });
});

describe('hasInstantaneousCycle', () => {
  it('returns false for a graph with no cycle', () => {
    const g = graph([{ id: 'a', type: 'start' }, { id: 'b', type: 'fork' }], [{ id: 'e1', from: 'a', to: 'b' }]);
    expect(hasInstantaneousCycle(g)).toBe(false);
  });

  it('returns false when a Track breaks the cycle', () => {
    const g = graph(
      [{ id: 'a', type: 'fork' }, { id: 'b', type: 'track', soundId: 'x', loop: { mode: 'count', count: 1 } }, { id: 'c', type: 'fork' }],
      [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }, { id: 'e3', from: 'c', to: 'a' }]
    );
    expect(hasInstantaneousCycle(g)).toBe(false);
  });

  it('returns true for a cycle of only instantaneous nodes', () => {
    const g = graph([{ id: 'a', type: 'fork' }, { id: 'b', type: 'random' }], [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'a', weight: 1 }]);
    expect(hasInstantaneousCycle(g)).toBe(true);
  });
});

describe('findInstantaneousCycle', () => {
  it('returns null when there is no cycle', () => {
    const g = graph([{ id: 'a', type: 'start' }, { id: 'b', type: 'fork' }], [{ id: 'e1', from: 'a', to: 'b' }]);
    expect(findInstantaneousCycle(g)).toBe(null);
  });

  it('returns the cycle in traversal order with the closing edge last', () => {
    const g = graph(
      [{ id: 'a', type: 'fork' }, { id: 'b', type: 'random' }, { id: 'c', type: 'condition' }],
      [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c', weight: 1 }, { id: 'e3', from: 'c', to: 'a' }]
    );
    expect(findInstantaneousCycle(g)).toEqual({ nodeIds: ['a', 'b', 'c'], edgeIds: ['e1', 'e2', 'e3'] });
  });

  it('reports a self-loop as a one-node cycle', () => {
    const g = graph([{ id: 'a', type: 'fork' }, { id: 'b', type: 'end' }], [{ id: 'e1', from: 'a', to: 'a' }, { id: 'e2', from: 'a', to: 'b' }]);
    expect(findInstantaneousCycle(g)).toEqual({ nodeIds: ['a'], edgeIds: ['e1'] });
  });

  it('is stable across calls, so the reported path does not reshuffle between renders', () => {
    const g = graph(
      [{ id: 'z', type: 'fork' }, { id: 'a', type: 'fork' }, { id: 'm', type: 'fork' }],
      [{ id: 'e1', from: 'z', to: 'a' }, { id: 'e2', from: 'a', to: 'm' }, { id: 'e3', from: 'm', to: 'a' }, { id: 'e4', from: 'z', to: 'm' }]
    );
    expect(findInstantaneousCycle(g)).toEqual(findInstantaneousCycle(g));
    expect(findInstantaneousCycle(g).nodeIds).toEqual(['a', 'm']);
  });
});

describe('findUnreachableNodes', () => {
  it('returns every node when there is no Start', () => {
    const g = graph([{ id: 'a', type: 'track', soundId: 'x', loop: { mode: 'count', count: 1 } }], []);
    expect(findUnreachableNodes(g)).toEqual(['a']);
  });

  it('returns only nodes not reachable from Start', () => {
    const g = graph(
      [{ id: 'start', type: 'start' }, { id: 'a', type: 'track', soundId: 'x', loop: { mode: 'count', count: 1 } }, { id: 'orphan', type: 'end' }],
      [{ id: 'e1', from: 'start', to: 'a' }]
    );
    expect(findUnreachableNodes(g)).toEqual(['orphan']);
  });
});

describe('Script nodes', () => {
  const graphWith = (node) => ({
    version: 1,
    nodes: [{ id: 'start', type: 'start' }, { id: 'sc', type: 'script', ...node }, { id: 'end', type: 'end' }],
    edges: [{ id: 'e1', from: 'start', to: 'sc' }, { id: 'e2', from: 'sc', to: 'end' }]
  });
  const keys = (result) => [...result.errors, ...result.warnings].map((i) => i.messageKey.split('.').pop());

  it('requires exactly one exit', () => {
    const graph = graphWith({ script: { mode: 'macro', macroUuid: 'Macro.a' } });
    graph.edges = graph.edges.filter((e) => e.from !== 'sc');
    expect(keys(validateGraph(graph))).toContain('ScriptExitMissing');
  });

  it('warns - does not error - on an unconfigured node', () => {
    // A placeholder mid-authoring is legitimate, and at runtime it follows its exit fine. The bar
    // for `error` is a state that can never work.
    const result = validateGraph(graphWith({ script: { mode: 'macro', macroUuid: null } }));
    expect(result.valid).toBe(true);
    expect(keys(result)).toContain('ScriptMissingMacro');
  });

  it('warns when the referenced macro no longer exists', () => {
    // The rule that makes the live link honest: a deleted macro, or a graph imported into another
    // world, degrades to something VISIBLE rather than to silence.
    const result = validateGraph(graphWith({ script: { mode: 'macro', macroUuid: 'Macro.gone' } }), { macros: [] });
    expect(keys(result)).toContain('ScriptMacroNotFound');
  });

  it('warns when the referenced macro is a chat macro', () => {
    const result = validateGraph(graphWith({ script: { mode: 'macro', macroUuid: 'Macro.chat' } }), {
      macros: [{ uuid: 'Macro.chat', name: 'Roll', type: 'chat' }]
    });
    expect(keys(result)).toContain('ScriptMacroNotScript');
  });

  it('accepts a resolvable script macro with no complaint', () => {
    const result = validateGraph(graphWith({ script: { mode: 'macro', macroUuid: 'Macro.ok' } }), {
      macros: [{ uuid: 'Macro.ok', name: 'FX', type: 'script' }]
    });
    expect(keys(result)).toEqual([]);
  });

  it('ERRORS on inline source that does not compile', () => {
    // The one script rule that pays for itself: source that cannot compile can never do anything,
    // and without this the first sign of a typo is silence during play.
    const result = validateGraph(graphWith({ script: { mode: 'inline', source: 'return (;' } }), {
      scripting: { compiles: () => false, inlineAllowed: true, canAuthor: true }
    });
    expect(result.valid).toBe(false);
    expect(keys(result)).toContain('ScriptSyntaxError');
  });

  it('warns when inline scripts are disabled for the world', () => {
    const result = validateGraph(graphWith({ script: { mode: 'inline', source: 'foo()' } }), {
      scripting: { compiles: () => true, inlineAllowed: false, canAuthor: true }
    });
    expect(result.valid).toBe(true);
    expect(keys(result)).toContain('ScriptInlineDisabled');
  });

  it('skips the environment checks entirely when no scripting context is supplied', () => {
    // graph-validation stays PURE: with nothing passed in there is nothing to consult, and the
    // rules simply do not fire rather than guessing at live state.
    const result = validateGraph(graphWith({ script: { mode: 'inline', source: 'return (;' } }));
    expect(keys(result)).toEqual([]);
  });
});
