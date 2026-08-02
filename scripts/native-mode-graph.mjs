import { createBuilder, sequencePosition } from './graph-builder.mjs';

/**
 * Express a native (non-custom) playlist's own playback rules as a one-pass
 * CustomGraph, so CustomPlaybackEngine can play ANY playlist a Playlist graph
 * node references through exactly one code path - a target with its own
 * customPlayback graph runs that graph verbatim; a target without one gets a
 * graph synthesized here from its Foundry `mode` (docs/playlist-node-plan.md
 * D3/D5). One pass only - repetition (the parent Playlist node's own `loop`) is the calling
 * Playlist node's job, not this synthesized graph's.
 *
 * Pure data transform - no Foundry globals beyond a defensive read of
 * `globalThis.CONST.PLAYLIST_MODES` (mirroring the same fallback helpers.mjs
 * already uses elsewhere), no DOM - so this is fully unit-testable in
 * isolation, in the same spirit as graph-presets.mjs.
 */

function playlistModes() {
  return globalThis.CONST?.PLAYLIST_MODES ?? { UNSEQUENCED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 };
}

/**
 * This playlist's sounds as a plain array, tolerating both the Collection
 * (`.contents`) and Map-like (`.values()`) shapes a document exposes.
 * @param {object|null} playlist
 * @returns {Array<object>}
 */
function playlistSounds(playlist) {
  return playlist?.sounds?.contents || Array.from(playlist?.sounds?.values() || []);
}

/**
 * Sound ids in the order native playback would use them: playbackOrder when
 * set, otherwise document insertion order.
 * @param {object|null} playlist
 * @returns {string[]}
 */
function orderedSoundIds(playlist) {
  if (playlist?.playbackOrder?.length) return playlist.playbackOrder;
  return playlistSounds(playlist).map((s) => s.id);
}

/** Fisher-Yates shuffle of a copy of `ids`, using the injected rng. */
function shuffled(ids, rng) {
  const copy = [...ids];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Start -> Track -> Track -> ... -> End, in the given sound-id order. */
function buildSequenceGraph(soundIds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (soundIds.length === 0) {
    b.edge(start, b.node('end', 1, 0));
    return b.build();
  }
  const tracks = soundIds.map((soundId, i) => {
    const { column, row } = sequencePosition(i);
    return b.track(soundId, column, row);
  });
  const last = sequencePosition(tracks.length - 1);
  const end = b.node('end', last.column + 1, last.row);
  b.edge(start, tracks[0]);
  tracks.forEach((track, i) => b.edge(track, i === tracks.length - 1 ? end : tracks[i + 1]));
  return b.build();
}

/** Start -> Fork -> one finite Track per sound -> a single shared End. */
function buildSimultaneousGraph(soundIds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (soundIds.length === 0) {
    b.edge(start, b.node('end', 1, 0));
    return b.build();
  }
  if (soundIds.length === 1) {
    const track = b.track(soundIds[0], 1, 0);
    const end = b.node('end', 2, 0);
    b.edge(start, track);
    b.edge(track, end);
    return b.build();
  }
  const fork = b.node('fork', 1, 0);
  b.edge(start, fork);
  const end = b.node('end', 3, Math.floor(soundIds.length / 2));
  soundIds.forEach((soundId, i) => {
    const track = b.track(soundId, 2, i);
    b.edge(fork, track);
    b.edge(track, end);
  });
  return b.build();
}

/**
 * @param {{mode: number, playbackOrder?: string[], sounds?: object}} playlist
 * @param {{rng?: () => number}} [options] - Injectable RNG (SHUFFLE only), for deterministic tests.
 * @returns {import('./custom-playback-schema.mjs').CustomGraph}
 */
export function buildNativeModeGraph(playlist, { rng = Math.random } = {}) {
  const modes = playlistModes();
  const soundIds = orderedSoundIds(playlist);

  if (playlist?.mode === modes.SIMULTANEOUS) return buildSimultaneousGraph(soundIds);
  if (playlist?.mode === modes.SHUFFLE) return buildSequenceGraph(shuffled(soundIds, rng));
  // SEQUENTIAL and UNSEQUENCED (a Soundboard with no stored graph, or a stray
  // legacy value) both fall back to played-in-list-order: SEQUENTIAL because
  // that IS its rule, UNSEQUENCED because it has no ordering rule of its own
  // for this synthesized single pass to honor (graph-validation.mjs's
  // PlaylistSoundboardTarget warns the editor about this shape).
  return buildSequenceGraph(soundIds);
}
