import { describe, it, expect } from 'vitest';
import { buildNativeModeGraph } from '../scripts/native-mode-graph.mjs';
import { validateGraph } from '../scripts/graph-validation.mjs';
import { createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

const MODES = { UNSEQUENCED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 };

function trackSoundIds(graph) {
  return graph.nodes.filter((n) => n.type === 'track').map((n) => n.soundId);
}

describe('buildNativeModeGraph', () => {
  it('SEQUENTIAL: plays sounds in playbackOrder, then ends', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B'), createMockSound('s3', 'C')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.SEQUENTIAL);
    const graph = buildNativeModeGraph(playlist);

    expect(validateGraph(graph).valid).toBe(true);
    expect(trackSoundIds(graph)).toEqual(['s1', 's2', 's3']);
    expect(graph.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.type === 'end')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.type === 'fork')).toHaveLength(0);
    // one exit each: start->first, tracks chained, last->end
    for (const node of graph.nodes.filter((n) => n.type === 'track')) {
      expect(graph.edges.filter((e) => e.from === node.id)).toHaveLength(1);
    }
  });

  it('SHUFFLE: uses the injected rng and reshuffles across calls', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B'), createMockSound('s3', 'C'), createMockSound('s4', 'D')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.SHUFFLE);

    // A constant rng of 0 always swaps with index 0, producing a deterministic
    // (non-identity) permutation - proves the rng is actually consulted.
    const graphA = buildNativeModeGraph(playlist, { rng: () => 0 });
    expect(validateGraph(graphA).valid).toBe(true);
    expect(trackSoundIds(graphA).sort()).toEqual(['s1', 's2', 's3', 's4']);

    let calls = 0;
    const sequenceRng = () => {
      const values = [0.9, 0.1, 0.5, 0.0];
      return values[calls++ % values.length];
    };
    const graphB = buildNativeModeGraph(playlist, { rng: sequenceRng });
    expect(trackSoundIds(graphB).sort()).toEqual(['s1', 's2', 's3', 's4']);

    // Different rng sequences should (with high likelihood, and deterministically
    // for these two fixed sequences) produce a different order.
    expect(trackSoundIds(graphA)).not.toEqual(trackSoundIds(graphB));
  });

  it('SIMULTANEOUS with multiple sounds: Fork -> one finite Track per sound -> shared End', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B'), createMockSound('s3', 'C')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.SIMULTANEOUS);
    const graph = buildNativeModeGraph(playlist);

    expect(validateGraph(graph).valid).toBe(true);
    const forks = graph.nodes.filter((n) => n.type === 'fork');
    expect(forks).toHaveLength(1);
    expect(graph.edges.filter((e) => e.from === forks[0].id)).toHaveLength(3);
    const ends = graph.nodes.filter((n) => n.type === 'end');
    expect(ends).toHaveLength(1);
    // Every track is finite (loopCount 1) and feeds the single End.
    const tracks = graph.nodes.filter((n) => n.type === 'track');
    expect(tracks).toHaveLength(3);
    for (const track of tracks) {
      expect(track.loop).toEqual({ mode: 'count', count: 1 });
      const exits = graph.edges.filter((e) => e.from === track.id);
      expect(exits).toHaveLength(1);
      expect(exits[0].to).toBe(ends[0].id);
    }
  });

  it('SIMULTANEOUS with exactly one sound: no Fork (degenerate shape avoided)', () => {
    const sounds = [createMockSound('s1', 'A')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.SIMULTANEOUS);
    const graph = buildNativeModeGraph(playlist);

    expect(validateGraph(graph).valid).toBe(true);
    expect(graph.nodes.filter((n) => n.type === 'fork')).toHaveLength(0);
    expect(trackSoundIds(graph)).toEqual(['s1']);
  });

  it('UNSEQUENCED with no stored graph: played in list order (SEQUENTIAL-like fallback)', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.UNSEQUENCED);
    const graph = buildNativeModeGraph(playlist);

    expect(validateGraph(graph).valid).toBe(true);
    expect(trackSoundIds(graph)).toEqual(['s1', 's2']);
  });

  it('empty playlist (any mode): Start -> End, valid and instant', () => {
    const playlist = createMockPlaylist('pl1', 'Playlist', [], MODES.SEQUENTIAL);
    const graph = buildNativeModeGraph(playlist);

    expect(validateGraph(graph).valid).toBe(true);
    expect(graph.nodes.map((n) => n.type).sort()).toEqual(['end', 'start']);
    expect(graph.edges).toHaveLength(1);
  });

  it('every synthesized Track is finite with loopCount 1 - repetition is the caller\'s job', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B')];
    for (const mode of [MODES.SEQUENTIAL, MODES.SHUFFLE, MODES.SIMULTANEOUS]) {
      const playlist = createMockPlaylist('pl1', 'Playlist', sounds, mode);
      const graph = buildNativeModeGraph(playlist);
      for (const track of graph.nodes.filter((n) => n.type === 'track')) {
        expect(track.loop).toEqual({ mode: 'count', count: 1 });
      }
    }
  });

  it('falls back to document order when playbackOrder is empty', () => {
    const sounds = [createMockSound('s1', 'A'), createMockSound('s2', 'B')];
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds, MODES.SEQUENTIAL);
    playlist.playbackOrder = [];
    const graph = buildNativeModeGraph(playlist);
    expect(trackSoundIds(graph)).toEqual(['s1', 's2']);
  });
});

describe('buildNativeModeGraph with an explicitly bound track', () => {
  // A binding that names one track of a Soundboard playlist means "play this one" - that is
  // exactly what PlaylistContext._resolveTracks() does for the non-engine path, checking trackId
  // before mode. Without it here, driving the same binding through an engine (an additive layer,
  // or a Playlist node) marched through the entire playlist instead. Confirmed live.
  const sounds = () => [createMockSound('s1', 'A'), createMockSound('s2', 'B'), createMockSound('s3', 'C')];

  it('plays only that track, whatever the playlist mode says', () => {
    for (const mode of [MODES.UNSEQUENCED, MODES.SEQUENTIAL, MODES.SHUFFLE, MODES.SIMULTANEOUS]) {
      const playlist = createMockPlaylist('pl1', 'Playlist', sounds(), mode);
      const graph = buildNativeModeGraph(playlist, { trackId: 's2' });

      expect(validateGraph(graph).valid, `mode ${mode}`).toBe(true);
      expect(trackSoundIds(graph), `mode ${mode}`).toEqual(['s2']);
    }
  });

  it('still ends cleanly, so a layer or a Playlist-node pass completes', () => {
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds(), MODES.UNSEQUENCED);
    const graph = buildNativeModeGraph(playlist, { trackId: 's2' });

    expect(graph.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.type === 'end')).toHaveLength(1);
  });

  it('falls back to the whole playlist when the bound track is no longer in it', () => {
    // A stale id from a previous binding would otherwise synthesize a graph whose only Track
    // node names a sound that does not exist - which starts and goes idle in silence.
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds(), MODES.SEQUENTIAL);
    const graph = buildNativeModeGraph(playlist, { trackId: 'gone' });

    expect(trackSoundIds(graph)).toEqual(['s1', 's2', 's3']);
  });

  it('ignores a null/absent trackId, which is the ordinary case', () => {
    const playlist = createMockPlaylist('pl1', 'Playlist', sounds(), MODES.SEQUENTIAL);
    expect(trackSoundIds(buildNativeModeGraph(playlist, { trackId: null }))).toEqual(['s1', 's2', 's3']);
    expect(trackSoundIds(buildNativeModeGraph(playlist))).toEqual(['s1', 's2', 's3']);
  });
});
