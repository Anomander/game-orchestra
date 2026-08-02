import { describe, it, expect } from 'vitest';
import { GRAPH_PRESETS, getPreset } from '../scripts/graph-presets.mjs';
import { validateGraph } from '../scripts/graph-validation.mjs';
import { graphToDrawflowExport, drawflowExportToGraph } from '../scripts/graph-drawflow-bridge.mjs';

/** Sounds shaped like the {id, name} entries the editor passes to a preset's build(). */
function makeSounds(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `s${i + 1}`, name: `Sound ${i + 1}` }));
}

/** A playlist stub exposing only the sounds.get() lookup validateGraph uses. */
function makePlaylist(sounds) {
  return { sounds: { get: (id) => sounds.find((s) => s.id === id) || null } };
}

const SOUND_COUNTS = [0, 1, 2, 5];

describe('GRAPH_PRESETS', () => {
  it('exposes unique ids and i18n keys', () => {
    const ids = GRAPH_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of GRAPH_PRESETS) {
      expect(preset.labelKey).toMatch(/^GameOrchestra\./);
      expect(preset.descriptionKey).toMatch(/^GameOrchestra\./);
      expect(preset.minSounds).toBeGreaterThanOrEqual(1);
      expect(typeof preset.build).toBe('function');
    }
  });

  it('getPreset resolves by id and returns null for anything else', () => {
    expect(getPreset('shuffle')?.id).toBe('shuffle');
    expect(getPreset('nope')).toBeNull();
    expect(getPreset(undefined)).toBeNull();
  });

  for (const preset of GRAPH_PRESETS) {
    describe(preset.id, () => {
      for (const count of SOUND_COUNTS) {
        const meetsMinimum = count >= preset.minSounds;

        it(`builds a ${meetsMinimum ? 'valid' : 'non-crashing'} graph from ${count} sound(s)`, () => {
          const sounds = makeSounds(count);
          const graph = preset.build(sounds);

          expect(graph.version).toBe(1);
          expect(graph.nodes.some((n) => n.type === 'start')).toBe(true);
          if (!meetsMinimum) return; // below its minimum a preset only has to not throw

          const result = validateGraph(graph, { playlist: makePlaylist(sounds) });
          expect(result.errors).toEqual([]);
          expect(result.valid).toBe(true);
        });

        if (!meetsMinimum) continue;

        it(`uses numeric, unique node ids with ${count} sound(s)`, () => {
          const graph = preset.build(makeSounds(count));
          const ids = graph.nodes.map((n) => n.id);
          expect(new Set(ids).size).toBe(ids.length);
          // Drawflow's load() derives its next node id from the max NUMERIC id;
          // a non-numeric id here would let a later addNode() collide.
          for (const id of ids) expect(id).toMatch(/^\d+$/);
        });

        it(`declares each node's edges in output-port order with ${count} sound(s)`, () => {
          const graph = preset.build(makeSounds(count));
          for (const node of graph.nodes) {
            const exits = graph.edges.filter((e) => e.from === node.id);
            exits.forEach((edge, i) => {
              expect(edge.id).toBe(`${node.id}:output_${i + 1}->${edge.to}`);
            });
          }
        });

        it(`round-trips through the Drawflow bridge with ${count} sound(s)`, () => {
          const graph = preset.build(makeSounds(count));
          const restored = drawflowExportToGraph(graphToDrawflowExport(graph));

          expect(restored.nodes.length).toBe(graph.nodes.length);
          expect(restored.edges.length).toBe(graph.edges.length);
          // Exit metadata survives the trip through node.data.exits[] (H5).
          for (const edge of graph.edges) {
            const match = restored.edges.find((e) => e.from === edge.from && e.to === edge.to);
            expect(match).toBeTruthy();
            if (edge.weight !== undefined) expect(match.weight).toBe(edge.weight);
            if (edge.condition !== undefined) expect(match.condition).toEqual(edge.condition);
          }
        });
      }
    });
  }
});

describe('preset shapes', () => {
  it('sequential-loop wires the last track back to the first', () => {
    const graph = getPreset('sequential-loop').build(makeSounds(3));
    const tracks = graph.nodes.filter((n) => n.type === 'track');
    expect(tracks).toHaveLength(3);
    const lastExit = graph.edges.find((e) => e.from === tracks[2].id);
    expect(lastExit.to).toBe(tracks[0].id);
  });

  it('sequential-loop collapses a single-sound playlist to one infinite track (no self-restart warning)', () => {
    const sounds = makeSounds(1);
    const graph = getPreset('sequential-loop').build(sounds);
    const tracks = graph.nodes.filter((n) => n.type === 'track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].loop).toEqual({ mode: 'forever' });
    expect(graph.edges.filter((e) => e.from === tracks[0].id)).toEqual([]);
    expect(validateGraph(graph, { playlist: makePlaylist(sounds) }).warnings).toEqual([]);
  });

  it('sequential-once terminates at an End node', () => {
    const graph = getPreset('sequential-once').build(makeSounds(3));
    const end = graph.nodes.find((n) => n.type === 'end');
    expect(end).toBeTruthy();
    const tracks = graph.nodes.filter((n) => n.type === 'track');
    expect(graph.edges.find((e) => e.from === tracks[2].id).to).toBe(end.id);
  });

  it('shuffle gives the Random node one weighted exit per sound and avoids repeats', () => {
    const graph = getPreset('shuffle').build(makeSounds(4));
    const random = graph.nodes.find((n) => n.type === 'random');
    expect(random.avoidRepeat).toBe(true);
    const exits = graph.edges.filter((e) => e.from === random.id);
    expect(exits).toHaveLength(4);
    for (const exit of exits) expect(exit.weight).toBe(1);
    // Every track returns to the Random node, so the shuffle never terminates.
    for (const track of graph.nodes.filter((n) => n.type === 'track')) {
      expect(graph.edges.find((e) => e.from === track.id).to).toBe(random.id);
    }
  });

  it('shuffle-with-gaps inserts a Delay between each track and the Random node', () => {
    const graph = getPreset('shuffle-with-gaps').build(makeSounds(3));
    const random = graph.nodes.find((n) => n.type === 'random');
    const delays = graph.nodes.filter((n) => n.type === 'delay');
    expect(delays).toHaveLength(3);
    for (const delay of delays) {
      expect(delay.delay.max).toBeGreaterThan(delay.delay.min);
      expect(graph.edges.find((e) => e.from === delay.id).to).toBe(random.id);
    }
    for (const track of graph.nodes.filter((n) => n.type === 'track')) {
      const target = graph.edges.find((e) => e.from === track.id).to;
      expect(delays.some((d) => d.id === target)).toBe(true);
    }
  });

  it('single-loop produces one infinite track with no exit', () => {
    const graph = getPreset('single-loop').build(makeSounds(3));
    const tracks = graph.nodes.filter((n) => n.type === 'track');
    expect(tracks).toHaveLength(1);
    expect(tracks[0].loop).toEqual({ mode: 'forever' });
    expect(tracks[0].soundId).toBe('s1');
    expect(graph.edges.filter((e) => e.from === tracks[0].id)).toEqual([]);
  });

  it('layered-ambience forks into one infinite track per sound', () => {
    const graph = getPreset('layered-ambience').build(makeSounds(3));
    const fork = graph.nodes.find((n) => n.type === 'fork');
    expect(graph.edges.filter((e) => e.from === fork.id)).toHaveLength(3);
    for (const track of graph.nodes.filter((n) => n.type === 'track')) expect(track.loop).toEqual({ mode: 'forever' });
  });

  it('combat-aware puts the default condition exit last and loops back for re-evaluation', () => {
    const graph = getPreset('combat-aware').build(makeSounds(2));
    const condition = graph.nodes.find((n) => n.type === 'condition');
    const exits = graph.edges.filter((e) => e.from === condition.id);
    expect(exits.map((e) => e.condition.kind)).toEqual(['combatActive', 'default']);
    // Both tracks return to the Condition, which is what makes it react to combat
    // at all - conditions are only evaluated when a token arrives (H7).
    for (const track of graph.nodes.filter((n) => n.type === 'track')) {
      expect(graph.edges.find((e) => e.from === track.id).to).toBe(condition.id);
    }
  });

  it('loop-until-combat-ends wires Start -> Track(until combatIdle, loopEnd) -> End', () => {
    const graph = getPreset('loop-until-combat-ends').build(makeSounds(1));
    const track = graph.nodes.find((n) => n.type === 'track');
    const end = graph.nodes.find((n) => n.type === 'end');
    expect(track.loop).toEqual({ mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'loopEnd', minLoops: 1, maxLoops: null });
    expect(graph.edges.find((e) => e.from === graph.nodes.find((n) => n.type === 'start').id).to).toBe(track.id);
    expect(graph.edges.find((e) => e.from === track.id).to).toBe(end.id);
  });
});
