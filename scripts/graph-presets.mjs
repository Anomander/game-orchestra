import { createBuilder, sequencePosition } from './graph-builder.mjs';

/**
 * Ready-made starter graphs (custom-playback-schema.mjs) the editor can drop onto
 * a blank canvas so a playlist doesn't have to be wired node by node from scratch.
 *
 * Pure data transforms only - no Drawflow, no DOM, no live Foundry - so every
 * preset is unit-testable by running its output straight through validateGraph()
 * and the Drawflow bridge, exactly like graph-drawflow-bridge.mjs.
 *
 * Built on createBuilder() (graph-builder.mjs), which enforces this module's two
 * construction rules (numeric node ids; edges emitted in output-port order) -
 * see that module's header for why they matter.
 */

/** Default gap range (seconds) for the shuffle-with-gaps preset's Delay nodes. */
const GAP_DELAY_SECONDS = { min: 2, max: 6 };

/**
 * Play every track in order, then start over from the first. A one-track
 * playlist becomes a single seamlessly-looping track rather than a track wired
 * back to itself - the latter is legal but restarts audibly on every pass
 * (validateGraph warns about exactly that shape).
 */
function buildSequentialLoop(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  if (sounds.length === 1) {
    b.edge(start, b.track(sounds[0].id, 1, 0, { infinite: true }));
    return b.build();
  }
  const tracks = sounds.map((sound, i) => {
    const { column, row } = sequencePosition(i);
    return b.track(sound.id, column, row);
  });
  b.edge(start, tracks[0]);
  tracks.forEach((track, i) => b.edge(track, tracks[(i + 1) % tracks.length]));
  return b.build();
}

/** Play every track in order once, then stop (an explicit End - see H10). */
function buildSequentialOnce(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  const tracks = sounds.map((sound, i) => {
    const { column, row } = sequencePosition(i);
    return b.track(sound.id, column, row);
  });
  const last = sequencePosition(tracks.length - 1);
  const end = b.node('end', last.column + 1, last.row);
  b.edge(start, tracks[0]);
  tracks.forEach((track, i) => b.edge(track, i === tracks.length - 1 ? end : tracks[i + 1]));
  return b.build();
}

/**
 * Weighted-random track selection that never picks the same track twice in a
 * row, looping forever. With `withGaps`, a Delay sits between each track and the
 * return trip to the Random node.
 */
function buildShuffle(sounds, { withGaps = false } = {}) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  const random = b.node('random', 1, 0, { avoidRepeat: true });
  b.edge(start, random);

  const tracks = sounds.map((sound, i) => b.track(sound.id, 2, i));
  // Exits are declared before the return edges so the Random node's ports stay
  // in track order (see this module's header on port assignment).
  for (const track of tracks) b.edge(random, track, { weight: 1, cooldown: 0 });
  tracks.forEach((track, i) => {
    if (!withGaps) return void b.edge(track, random);
    const delay = b.node('delay', 3, i, { delay: { ...GAP_DELAY_SECONDS } });
    b.edge(track, delay);
    b.edge(delay, random);
  });
  return b.build();
}

/** One track, looping seamlessly forever. */
function buildSingleLoop(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  b.edge(start, b.track(sounds[0].id, 1, 0, { infinite: true }));
  return b.build();
}

/** Every track playing at once as a parallel layer, each looping forever. */
function buildLayeredAmbience(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  const fork = b.node('fork', 1, 0);
  b.edge(start, fork);
  for (const [i, sound] of sounds.entries()) b.edge(fork, b.track(sound.id, 2, i, { infinite: true }));
  return b.build();
}

/**
 * Alternate between a combat track and an out-of-combat track, re-checking
 * whose turn it is every time a track finishes. Both tracks route back to the
 * Condition node deliberately: a Condition only evaluates when a token arrives
 * (H7), so looping through it is what makes the graph react to combat at all.
 */
function buildCombatAware(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length < 2) return b.build();
  const condition = b.node('condition', 1, 0);
  b.edge(start, condition);
  const combatTrack = b.track(sounds[1].id, 2, 0);
  const areaTrack = b.track(sounds[0].id, 2, 1);
  // The 'default' exit must be the last one (validateGraph enforces it).
  b.edge(condition, combatTrack, { condition: { kind: 'combatActive' } });
  b.edge(condition, areaTrack, { condition: { kind: 'default' } });
  b.edge(combatTrack, condition);
  b.edge(areaTrack, condition);
  return b.build();
}

/**
 * One track, looping seamlessly until combat ends, then stopping at an
 * explicit End (H10) - boundary 'loopEnd' so the exit always lands on a clean
 * loop edge rather than cutting the track off mid-loop the instant combat
 * status flips.
 */
function buildLoopUntilCombatEnds(sounds) {
  const b = createBuilder();
  const start = b.node('start', 0, 0);
  if (sounds.length === 0) return b.build();
  const track = b.track(sounds[0].id, 1, 0, {
    loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'loopEnd', minLoops: 1, maxLoops: null }
  });
  const end = b.node('end', 2, 0);
  b.edge(start, track);
  b.edge(track, end);
  return b.build();
}

/**
 * @typedef {object} GraphPreset
 * @property {string} id
 * @property {string} labelKey          i18n key for the dropdown entry.
 * @property {string} descriptionKey    i18n key shown as the entry's tooltip.
 * @property {number} minSounds         Sounds the playlist needs for build() to
 *   produce a graph that passes validateGraph(). Below this the editor offers the
 *   preset as disabled rather than scaffolding a graph that can't be saved.
 * @property {(sounds: Array<{id: string}>) => import('./custom-playback-schema.mjs').CustomGraph} build
 */

/** @type {GraphPreset[]} */
export const GRAPH_PRESETS = [
  {
    id: 'sequential-loop',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.SequentialLoop',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.SequentialLoop',
    minSounds: 1,
    build: buildSequentialLoop
  },
  {
    id: 'sequential-once',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.SequentialOnce',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.SequentialOnce',
    minSounds: 1,
    build: buildSequentialOnce
  },
  {
    id: 'shuffle',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.Shuffle',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.Shuffle',
    minSounds: 2,
    build: (sounds) => buildShuffle(sounds)
  },
  {
    id: 'shuffle-with-gaps',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.ShuffleWithGaps',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.ShuffleWithGaps',
    minSounds: 2,
    build: (sounds) => buildShuffle(sounds, { withGaps: true })
  },
  {
    id: 'single-loop',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.SingleLoop',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.SingleLoop',
    minSounds: 1,
    build: buildSingleLoop
  },
  {
    id: 'layered-ambience',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.LayeredAmbience',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.LayeredAmbience',
    minSounds: 2,
    build: buildLayeredAmbience
  },
  {
    id: 'combat-aware',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.CombatAware',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.CombatAware',
    minSounds: 2,
    build: buildCombatAware
  },
  {
    id: 'loop-until-combat-ends',
    labelKey: 'GameOrchestra.CustomEditor.Preset.Label.LoopUntilCombatEnds',
    descriptionKey: 'GameOrchestra.CustomEditor.Preset.Desc.LoopUntilCombatEnds',
    minSounds: 1,
    build: buildLoopUntilCombatEnds
  }
];

/**
 * @param {string} id
 * @returns {GraphPreset|null}
 */
export function getPreset(id) {
  return GRAPH_PRESETS.find((preset) => preset.id === id) || null;
}
