/**
 * The fixture tone table - the identity layer of the whole audio-validation scheme.
 *
 * Integration tests cannot ask Foundry "what is audible right now?" in any way that would
 * survive a refactor: reading `sound.playing` only proves the module *thinks* it started a
 * track, which is exactly the class of bug worth catching (an armed start that never fires, a
 * mix applied on the wrong client, a fade that lands on the wrong node). So instead every test
 * fixture is a **pure sine tone at a known frequency**, and the probe worklet reports the
 * measured amplitude of each frequency independently. "Track B is audible at 0.31" becomes an
 * observation about the speaker output, not about module state.
 *
 * ## Why these frequencies
 *
 * No tone sits near any other tone's 2nd, 3rd or 4th harmonic. That is not aesthetic: a Goertzel
 * detector tuned to 440 Hz responds to the second harmonic of 220 Hz, and any real gain stage
 * produces some harmonic distortion. A harmonically related table would make a crossfade between
 * two tracks look like a level change on one.
 *
 * "Near" is measured in Hz, not in ratio, because the analysis window is what decides whether two
 * frequencies are distinguishable at all: 2048 samples at 48 kHz is ~23 Hz per bin, so a tone
 * 9 Hz from another's second harmonic is *the same bin* and completely indistinguishable from it.
 * This table was solved for maximum worst-case distance and clears every harmonic by **88 Hz** -
 * nearly four bins - while staying at least 88 Hz apart pairwise. `tests/itest-analysis.test.mjs`
 * asserts that guard, so a casually added tone cannot quietly erode it.
 *
 * Frequencies sit in the 380-1050 Hz band, where a browser's output path is flattest and where
 * the analysis window gives many full cycles per frame.
 *
 * This module is **pure** - it is imported by the generator, the in-page probe, the analysis
 * layer, and the specs, and must stay free of Node, Playwright and Foundry.
 */

/**
 * @typedef {object} ToneSpec
 * @property {string} id     - Stable slug; also the fixture filename stem.
 * @property {number} freq   - Frequency in Hz.
 * @property {string} label  - Human name used in assertion failure messages.
 */

/**
 * The tone table. Index into this array is the `tone index` used everywhere downstream.
 * Adding a tone is safe; reordering or renumbering breaks recorded baselines, so append only.
 * @type {ToneSpec[]}
 */
export const TONES = [
  { id: 'alpha', freq: 383, label: 'alpha (383 Hz)' },
  { id: 'bravo', freq: 576, label: 'bravo (576 Hz)' },
  { id: 'charlie', freq: 666, label: 'charlie (666 Hz)' },
  { id: 'delta', freq: 854, label: 'delta (854 Hz)' },
  { id: 'echo', freq: 946, label: 'echo (946 Hz)' },
  { id: 'foxtrot', freq: 1034, label: 'foxtrot (1034 Hz)' }
];

/**
 * Minimum distance in Hz between any tone and any other tone's harmonics, enforced by test.
 * Roughly four analysis bins - see the note above on why this is a Hz budget and not a ratio.
 */
export const HARMONIC_GUARD_HZ = 88;

/**
 * Peak amplitude every generated fixture is rendered at.
 *
 * Deliberately well below 1.0: several tests stack layers (an additive overlay over a base bed,
 * a crossfade with both sides briefly at full) and a sum that clips would make the measured
 * amplitude of *each* tone wrong, not just the total.
 */
export const FIXTURE_AMPLITUDE = 0.5;

/** Sample rate every fixture is rendered at, matching the browser's usual context rate. */
export const FIXTURE_SAMPLE_RATE = 48000;

/**
 * Amplitude below which a tone counts as inaudible.
 *
 * Sized from the **measured** noise floor of the detector, not from perception or from a round
 * number. `tests/itest-goertzel.test.mjs` synthesises a single 0.5-amplitude tone and reads the
 * other bins: worst-case Hann-windowed leakage is ~0.0015. An earlier draft set this floor at
 * 0.002 - only 1.3x that - which would have let a *single* playing track intermittently register
 * as two, breaking `expectExactlyAudible` at random.
 *
 * At 0.005 there is >3x margin over leakage, while still sitting ~1% of a full-level track: every
 * level any spec asserts on (a 0.4 duck, a 0.5 mix ceiling) clears it by two orders of magnitude.
 * The relationship is enforced by test, so neither constant can be moved alone.
 */
export const AUDIBLE_FLOOR = 0.005;

/**
 * The tone table's frequencies, in table order - the array the probe worklet is configured with.
 * @returns {number[]}
 */
export function toneFrequencies() {
  return TONES.map((t) => t.freq);
}

/**
 * Look up a tone index by its slug.
 * @param {string} id - Tone slug, e.g. `'alpha'`.
 * @returns {number} Index into {@link TONES}.
 * @throws {Error} If the slug is not in the table - a typo'd tone id in a spec would otherwise
 *   silently assert against index `-1` and pass for the wrong reason.
 */
export function toneIndex(id) {
  const index = TONES.findIndex((t) => t.id === id);
  if (index === -1) throw new Error(`Unknown tone id '${id}'. Known: ${TONES.map((t) => t.id).join(', ')}`);
  return index;
}

/**
 * The fixture filename for a tone, relative to the fixture directory.
 * @param {string} id - Tone slug.
 * @returns {string}
 */
export function toneFilename(id) {
  return `tone-${id}.wav`;
}

/**
 * Human label for a tone index, for assertion messages.
 * @param {number} index - Index into {@link TONES}.
 * @returns {string}
 */
export function toneLabel(index) {
  return TONES[index]?.label ?? `tone#${index}`;
}
