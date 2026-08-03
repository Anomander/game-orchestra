/**
 * The playlist mix model: a playlist's level-shaping settings (master gain, a volume clamp,
 * per-track mute, and a crossfade override) and the arithmetic that turns them plus a
 * PlaylistSound's own `volume` into the volume that is actually played.
 *
 * Pure - no `game`, no `ui`, no DOM (see CLAUDE.md § Purity boundary). The caller reads the
 * playlist's `game-orchestra.mix` flag and hands the object in.
 *
 * Two things this module deliberately does NOT own:
 *
 * - **Per-track volume.** That is `PlaylistSound#volume`, the document field, written directly
 *   by the mixer exactly as Foundry's own sidebar slider writes it
 *   (PlaylistDirectory#_onSoundVolume). A module-side shadow copy would diverge from that slider
 *   the first time either was touched, and "track volume" would mean two different numbers
 *   depending on which window you were looking at.
 * - **Solo.** Session state held by the open mixer window, never persisted - a solo surviving a
 *   reload reads as "my playlist only plays one track now".
 */

/**
 * @typedef {object} PlaylistMix
 * @property {number} [gain]        Master multiplier applied to every track's own volume.
 *   Default 1. Non-destructive: nothing is ever written back to a PlaylistSound.
 * @property {number} [floor]       Lower clamp bound applied after the gain. Default 0.
 * @property {number} [ceiling]     Upper clamp bound applied after the gain. Default 1.
 * @property {number|null} [crossfadeMs]  This playlist's hand-off crossfade override, in ms.
 *   null/absent defers down the chain in resolveCrossfadeMs().
 * @property {string[]} [muted]  Ids of muted sounds. Stored here rather than by zeroing the
 *   document's volume so that unmuting restores the level instead of losing it.
 *
 *   **An array, and it has to be.** A flag's value is an `ObjectField`, whose `_updateDiff`
 *   does `mergeObject(source, diff)` - a *recursive* merge. Written as `{soundId: true}`, a
 *   later write that simply omits an id merges the old `true` straight back in and **unmute
 *   silently does nothing**: the UI flips, the audio comes back, and the next reload has the
 *   track muted again. (Confirmed by reading `common/data/fields.mjs`, not deduced.) Removing a
 *   key needs the `-=` deletion operator; an array sidesteps the whole class of bug, because
 *   `mergeObject` replaces arrays wholesale instead of merging them.
 */

/** The mix every playlist has before anyone opens the mixer: fully transparent. */
export const DEFAULT_MIX = Object.freeze({ gain: 1, floor: 0, ceiling: 1, crossfadeMs: null, muted: Object.freeze([]) });

/**
 * Coerce whatever is in the `muted` field into an array of sound ids.
 *
 * Also accepts the `{id: true}` map shape, which is what this field looked like before the
 * merge hazard above was found - so a playlist saved by an in-between build still unmutes
 * correctly instead of being stuck.
 * @param {string[]|Object<string, boolean>|null|undefined} raw
 * @returns {string[]}
 */
export function normalizeMutedIds(raw) {
  if (Array.isArray(raw)) return raw.filter((id) => typeof id === 'string' && id.length > 0);
  if (raw && typeof raw === 'object') {
    // Legacy map form. `-=`-prefixed keys are deletion operators that reached the stored value,
    // never real sound ids.
    return Object.entries(raw)
      .filter(([id, value]) => value === true && !id.startsWith('-='))
      .map(([id]) => id);
  }
  return [];
}

/** Volume values are Foundry `AlphaField`s - [0, 1] inclusive. */
const MIN_VOLUME = 0;
const MAX_VOLUME = 1;

/**
 * Coerce a raw number-ish value into a volume in [0, 1], falling back when it is missing or
 * malformed. Every number entering the mix math goes through here, so a hand-edited flag or a
 * value from an older module version degrades the same way everywhere instead of propagating
 * NaN into `sound.fade()` (which silences the track with no error).
 * @param {*} raw
 * @param {number} fallback - Used when `raw` is absent or not a finite number.
 * @returns {number} A number in [0, 1].
 */
export function coerceVolume(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, value));
}

/**
 * Normalize a stored mix flag into a complete, safe object. Callers should treat this as the
 * only way to read a mix - `mix.gain` read raw is `undefined` on every playlist nobody has
 * opened the mixer for yet, which multiplies to NaN.
 * @param {PlaylistMix|null|undefined} mix - Raw `game-orchestra.mix` flag contents.
 * @returns {Required<PlaylistMix>} A mix with every field present and in range.
 */
export function normalizeMix(mix) {
  const floor = coerceVolume(mix?.floor, DEFAULT_MIX.floor);
  const ceiling = coerceVolume(mix?.ceiling, DEFAULT_MIX.ceiling);
  return {
    gain: coerceVolume(mix?.gain, DEFAULT_MIX.gain),
    // A floor above the ceiling is degenerate but reachable by hand-editing the flag (the UI
    // can't produce it). Collapsing the range onto the ceiling keeps clampVolume monotonic and
    // its output inside [0, 1]; the alternative - swapping them - silently plays something
    // LOUDER than the stated maximum, which is the one guarantee a ceiling makes.
    floor: Math.min(floor, ceiling),
    ceiling,
    crossfadeMs: resolveCrossfadeOverride(mix?.crossfadeMs),
    muted: normalizeMutedIds(mix?.muted)
  };
}

/**
 * Apply a normalized mix's clamp to an already-gained volume.
 * @param {number} volume
 * @param {Required<PlaylistMix>} mix - Must be normalized (see normalizeMix).
 * @returns {number}
 */
export function clampVolume(volume, mix) {
  return Math.min(mix.ceiling, Math.max(mix.floor, volume));
}

/**
 * The volume a track should actually play at: its own document volume, scaled by the playlist's
 * master gain, then clamped - or 0 when muted.
 *
 * Mute short-circuits ahead of the clamp on purpose: a floor above 0 would otherwise make a
 * muted track audible, which is not a trade-off, it is a bug.
 *
 * @param {number} soundVolume - The PlaylistSound's own `volume` field.
 * @param {PlaylistMix|null|undefined} mix - Raw or normalized; normalized internally.
 * @param {string} [soundId] - Needed only to honour mute.
 * @returns {number} A volume in [0, 1], safe to hand to `Sound#fade` or `play({volume})`.
 */
export function effectiveVolume(soundVolume, mix, soundId) {
  const normalized = normalizeMix(mix);
  if (soundId && normalized.muted.includes(soundId)) return 0;
  return clampVolume(coerceVolume(soundVolume, MAX_VOLUME) * normalized.gain, normalized);
}

/**
 * Coerce a duck factor - the multiplier applied to everything that is NOT the layer while an
 * additive layer plays (MusicController#_syncLayer). 1 is "no ducking", 0 is silence.
 *
 * Deliberately NOT part of `PlaylistMix` and not applied inside effectiveVolume(): a duck is
 * transient, external, and belongs to no playlist, so folding it into the mix would make the
 * mixer's `stored -> effective` readout jump around while a boss took its turn. It is applied
 * once, at the playback boundary (playlist-mix-apply.mjs#mixedVolume), on top of the finished
 * mix - which also means it can legitimately take a track BELOW the mix's own floor. The floor
 * is a statement about how quiet a playlist may shape itself; the duck is somebody else
 * temporarily standing in front of it.
 * @param {*} raw
 * @returns {number} A number in [0, 1]; 1 for anything missing or malformed.
 */
export function coerceDuckFactor(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Whether a mix changes anything at all about how this playlist sounds. Used by the render
 * layer to decide whether a row needs to show its `stored -> effective` readout, and by the
 * playback layer to skip work entirely on the overwhelmingly common untouched playlist.
 * @param {PlaylistMix|null|undefined} mix
 * @returns {boolean}
 */
export function mixIsTransparent(mix) {
  const normalized = normalizeMix(mix);
  return normalized.gain === 1 && normalized.floor === 0 && normalized.ceiling === 1 && normalized.muted.length === 0;
}

/**
 * Coerce one crossfade override value: a non-negative finite ms number, or null for "not set".
 * 0 is a real value and must survive - it means "never crossfade this playlist", even when the
 * world setting is non-zero.
 * @param {*} raw
 * @returns {number|null}
 */
export function resolveCrossfadeOverride(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

/**
 * The effective hand-off crossfade for a playlist, resolved down a three-link chain:
 *
 *   mix.crossfadeMs  ??  graph.crossfadeMs (legacy)  ??  world `graphCrossfade` setting
 *
 * The legacy link is the whole reason this function exists rather than just reading the mix.
 * Before the mixer, a custom-graph playlist's override lived inside the graph itself
 * (`CustomGraph.crossfadeMs`, edited in the graph editor's Settings pane). Those graphs are out
 * in worlds already, so the field is still read - it is simply no longer written. That keeps
 * this a read-side migration with no data rewrite and nothing to run on upgrade.
 *
 * Every link preserves an explicit 0, including the legacy one: a graph saved with "0" chose
 * to disable the crossfade and must keep it disabled.
 *
 * @param {object} params
 * @param {PlaylistMix|null} [params.mix] - The playlist's `game-orchestra.mix` flag.
 * @param {number|null} [params.legacyGraphMs] - `resolveGraphCrossfadeMs(graph)`, or null for a
 *   playlist that has no graph at all (every native playlist).
 * @param {number} [params.worldMs] - The world `graphCrossfade` setting.
 * @returns {number} Non-negative ms; 0 means no crossfade.
 */
export function resolveCrossfadeMs({ mix, legacyGraphMs = null, worldMs = 0 } = {}) {
  const own = resolveCrossfadeOverride(mix?.crossfadeMs);
  if (own !== null) return own;
  const legacy = resolveCrossfadeOverride(legacyGraphMs);
  if (legacy !== null) return legacy;
  const world = Number(worldMs);
  return Number.isFinite(world) && world >= 0 ? Math.round(world) : 0;
}

/**
 * Apply a group fader move to several tracks at once - the mixer's header slider while rows are
 * selected.
 *
 * Relative, not absolute: it scales every selected track by one ratio so the balance the GM
 * already dialled in between them survives. That is the whole point of a group fader; an
 * absolute set is available too (the mixer's Alt-modifier) but is a different, flattening
 * operation and goes through setGroupVolume() below.
 *
 * The ratio is derived from the loudest selected track, so the move is what the GM sees happen
 * at the top of the group, and nothing in the group clips against the [0, 1] ceiling before the
 * others get there. Consequence worth knowing: pulling the group to 0 collapses every ratio, so
 * the values cannot be recovered by pushing back up - the mixer's undo is the document history,
 * not this function.
 *
 * @param {Array<{id: string, volume: number}>} tracks - The selected tracks.
 * @param {number} targetPeak - The volume the loudest selected track should end at, in [0, 1].
 * @returns {Object<string, number>} Sound id -> new volume, ready for one
 *   `updateEmbeddedDocuments` batch.
 */
export function applyGroupGain(tracks, targetPeak) {
  const result = {};
  if (!tracks?.length) return result;
  const target = coerceVolume(targetPeak, 0);
  const peak = tracks.reduce((max, track) => Math.max(max, coerceVolume(track.volume, 0)), 0);
  // Every selected track is silent: there is no ratio to preserve, so the only sensible reading
  // of the gesture is "put them all here". Without this branch the division below is 0/0.
  if (peak === 0) return setGroupVolume(tracks, target);
  const ratio = target / peak;
  for (const track of tracks) result[track.id] = coerceVolume(coerceVolume(track.volume, 0) * ratio, 0);
  return result;
}

/**
 * Set several tracks to one absolute volume, flattening whatever balance existed between them.
 * The Alt-modified group move, and what "Apply to all tracks" uses.
 * @param {Array<{id: string}>} tracks
 * @param {number} volume
 * @returns {Object<string, number>} Sound id -> new volume.
 */
export function setGroupVolume(tracks, volume) {
  const result = {};
  const target = coerceVolume(volume, 0);
  for (const track of tracks || []) result[track.id] = target;
  return result;
}
