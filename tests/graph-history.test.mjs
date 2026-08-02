import { describe, it, expect } from 'vitest';
import { GraphHistory, snapshotKey } from '../scripts/graph-history.mjs';

/**
 * A stand-in for a captured editor snapshot: the Drawflow half, the
 * graph-level crossfade carried alongside it, and the selection that rides
 * along without being part of the state's identity.
 */
function snapshot(nodeIds, { crossfadeMs = null, selectedNodeId = null, multi = [] } = {}) {
  const data = {};
  for (const id of nodeIds) data[id] = { id, name: 'track', data: {} };
  return {
    drawflow: { drawflow: { Home: { data } } },
    crossfadeMs,
    selectedNodeId,
    multiSelectedNodeIds: multi
  };
}

describe('snapshotKey with levels', () => {
  const base = { drawflow: { a: 1 }, crossfadeMs: null, levels: { mix: null, fade: null, tracks: { s1: { volume: 0.5, fade: null } } } };

  it('treats a changed track volume as a different state - level edits happen in the same pane as graph edits, so Ctrl+Z has to cover them', () => {
    const louder = { ...base, levels: { ...base.levels, tracks: { s1: { volume: 0.9, fade: null } } } };
    expect(snapshotKey(louder)).not.toBe(snapshotKey(base));
  });

  it('treats a changed mix flag as a different state', () => {
    expect(snapshotKey({ ...base, levels: { ...base.levels, mix: { gain: 0.5 } } })).not.toBe(snapshotKey(base));
  });

  it('treats identical levels as the same state, so a resync that changed nothing still costs no step', () => {
    expect(snapshotKey({ ...base, levels: foundryDeepClone(base.levels) })).toBe(snapshotKey(base));
  });

  it('ignores the selection, as before - selecting a row is not an edit', () => {
    expect(snapshotKey({ ...base, selectedNodeId: 'n1' })).toBe(snapshotKey({ ...base, selectedNodeId: 'n2' }));
  });
});

/** Structural clone without depending on Foundry's utils in a pure-module test. */
function foundryDeepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('graph-history', () => {
  describe('snapshotKey', () => {
    it('distinguishes states that differ in the graph', () => {
      expect(snapshotKey(snapshot(['1']))).not.toBe(snapshotKey(snapshot(['1', '2'])));
    });

    it('distinguishes states that differ only in the graph-level crossfade', () => {
      expect(snapshotKey(snapshot(['1']))).not.toBe(snapshotKey(snapshot(['1'], { crossfadeMs: 500 })));
    });

    it('IGNORES the selection - selecting a node is not an edit and must never cost a step', () => {
      const a = snapshot(['1', '2'], { selectedNodeId: '1' });
      const b = snapshot(['1', '2'], { selectedNodeId: '2', multi: ['1', '2'] });
      expect(snapshotKey(a)).toBe(snapshotKey(b));
    });

    it('handles a null snapshot without throwing', () => {
      expect(() => snapshotKey(null)).not.toThrow();
    });
  });

  describe('GraphHistory', () => {
    it('starts with nothing to undo or redo', () => {
      const history = new GraphHistory();
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);
      expect(history.undo()).toBeNull();
      expect(history.redo()).toBeNull();
    });

    it('treats the seed as a floor, not a step', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      expect(history.canUndo).toBe(false);
      expect(history.present.drawflow.drawflow.Home.data['1']).toBeDefined();
    });

    it('pushes an edit and steps back to the state before it', () => {
      const history = new GraphHistory();
      const seed = snapshot(['1']);
      history.reset(seed);
      history.push(snapshot(['1', '2']));

      expect(history.canUndo).toBe(true);
      expect(history.undo()).toEqual(seed);
      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(true);
    });

    it('redoes back to the state it was undone from', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      const edited = snapshot(['1', '2']);
      history.push(edited);
      history.undo();

      expect(history.redo()).toEqual(edited);
      expect(history.canRedo).toBe(false);
      expect(history.canUndo).toBe(true);
    });

    it('walks back through several edits one at a time, in order', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      history.push(snapshot(['1', '2']));
      history.push(snapshot(['1', '2', '3']));
      history.push(snapshot(['1', '2', '3', '4']));

      expect(Object.keys(history.undo().drawflow.drawflow.Home.data)).toEqual(['1', '2', '3']);
      expect(Object.keys(history.undo().drawflow.drawflow.Home.data)).toEqual(['1', '2']);
      expect(Object.keys(history.undo().drawflow.drawflow.Home.data)).toEqual(['1']);
      expect(history.undo()).toBeNull();
    });

    it('drops a push identical to the present state, so read-only resyncs cost nothing', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1', '2']));

      expect(history.push(snapshot(['1', '2']))).toBe(false);
      expect(history.canUndo).toBe(false);
      expect(history.depth).toEqual({ past: 0, future: 0 });
    });

    it('drops a push that changes only the selection', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1', '2'], { selectedNodeId: '1' }));

      expect(history.push(snapshot(['1', '2'], { selectedNodeId: '2' }))).toBe(false);
      expect(history.canUndo).toBe(false);
    });

    it('records a crossfade-only change, which no node in the graph reflects', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));

      expect(history.push(snapshot(['1'], { crossfadeMs: 250 }))).toBe(true);
      expect(history.undo().crossfadeMs).toBeNull();
    });

    it('discards the redo branch once a new edit is made after an undo', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      history.push(snapshot(['1', '2']));
      history.undo();
      expect(history.canRedo).toBe(true);

      history.push(snapshot(['1', '9']));
      expect(history.canRedo).toBe(false);
      expect(Object.keys(history.present.drawflow.drawflow.Home.data)).toEqual(['1', '9']);
    });

    it('is unbounded - a long session keeps every step', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['0']));
      for (let i = 1; i <= 500; i++) history.push(snapshot(['0', String(i)]));

      expect(history.depth.past).toBe(500);
      for (let i = 0; i < 500; i++) history.undo();
      expect(history.canUndo).toBe(false);
      expect(Object.keys(history.present.drawflow.drawflow.Home.data)).toEqual(['0']);
    });

    it('treats a first push with no seed as the seed - there is nothing to undo TO yet', () => {
      const history = new GraphHistory();
      expect(history.push(snapshot(['1']))).toBe(false);
      expect(history.canUndo).toBe(false);
      expect(history.present).not.toBeNull();
    });

    it('updatePresentSelection refreshes what an undo will step back into, without a step', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1'], { selectedNodeId: null }));
      // Clicking a node between two edits records nothing, so the state being
      // left has to be told what is selected now, or stepping back into it
      // would deselect for no visible reason.
      history.updatePresentSelection({ selectedNodeId: '1', multiSelectedNodeIds: [] });
      expect(history.canUndo).toBe(false);

      history.push(snapshot(['1', '2'], { selectedNodeId: '1' }));

      expect(history.undo().selectedNodeId).toBe('1');
    });

    it('updatePresentSelection does not change the state identity, so it cannot mask an edit', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      history.updatePresentSelection({ selectedNodeId: '1', multiSelectedNodeIds: ['1'] });

      expect(history.push(snapshot(['1', '2']))).toBe(true);
    });

    it('updatePresentSelection is a no-op before the history is seeded', () => {
      const history = new GraphHistory();
      expect(() => history.updatePresentSelection({ selectedNodeId: '1', multiSelectedNodeIds: [] })).not.toThrow();
      expect(history.present).toBeNull();
    });

    it('reset() after edits discards both stacks', () => {
      const history = new GraphHistory();
      history.reset(snapshot(['1']));
      history.push(snapshot(['1', '2']));
      history.undo();
      history.reset(snapshot(['7']));

      expect(history.canUndo).toBe(false);
      expect(history.canRedo).toBe(false);
      expect(history.depth).toEqual({ past: 0, future: 0 });
    });
  });
});
