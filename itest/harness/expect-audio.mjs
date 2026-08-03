/**
 * Audio assertions, phrased the way the wiki phrases behaviour.
 *
 * Each one wraps a function from `analysis.mjs` and, on failure, prints the ASCII timeline. That
 * is not decoration: `expected 0.31 to be within 0.05 of 0.5` tells you nothing about whether a
 * fade was too slow, the wrong track played, or the mix ceiling was applied twice, and rerunning
 * a real-time integration test to add logging is expensive. The chart answers all three at a
 * glance, so it is attached to every failure by construction.
 *
 * Assertions are deliberately **relative wherever possible** (ratios, orderings, overlaps) rather
 * than absolute levels. Absolute output amplitude depends on Foundry's 1.5-order volume curve,
 * the browser's output gain, and the fixture's own level - none of which this module owns, and
 * all of which can shift under it without anything being broken.
 */

import { expect } from '@playwright/test';

import { AUDIBLE_FLOOR, toneLabel } from './tones.mjs';
import { crossfade, entryOrder, levelRatio, mean, rampDuration, renderTimeline, sustainedTones } from './analysis.mjs';

/**
 * Build the failure context appended to every assertion message.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @returns {string}
 */
function context(frames) {
  return `\n\n${renderTimeline(frames)}\n`;
}

/**
 * Assert exactly this set of tones was *sustained* during the window - no more, no fewer.
 *
 * Uses {@link sustainedTones}, so a one-frame start transient does not count as a track.
 *
 * The "no more" half is the valuable one. A test that only asserts the expected track is present
 * cannot catch a track that failed to stop, which is the module's most common historical failure
 * shape (an orphaned sound surviving a transition).
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {number[]} tones - Expected tone indices.
 * @param {import('./analysis.mjs').Window} [window] - Window to measure over.
 * @returns {void}
 */
export function expectExactlyAudible(frames, tones, window) {
  const actual = sustainedTones(frames, window);
  expect(
    actual,
    `expected exactly [${tones.map(toneLabel)}] audible, got [${actual.map(toneLabel)}]${context(frames)}`
  ).toEqual([...tones].sort((a, b) => a - b));
}

/**
 * Assert a tone was audible at some point in the window.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {import('./analysis.mjs').Window} [window] - Window to measure over.
 * @returns {void}
 */
export function expectAudible(frames, tone, window) {
  expect(sustainedTones(frames, window), `expected ${toneLabel(tone)} to be audible${context(frames)}`).toContain(tone);
}

/**
 * Assert a tone was never audible in the window.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {import('./analysis.mjs').Window} [window] - Window to measure over.
 * @returns {void}
 */
export function expectNotAudible(frames, tone, window) {
  expect(sustainedTones(frames, window), `expected ${toneLabel(tone)} to be silent${context(frames)}`).not.toContain(tone);
}

/**
 * Assert nothing at all was audible in the window.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {import('./analysis.mjs').Window} [window] - Window to measure over.
 * @returns {void}
 */
export function expectSilence(frames, window) {
  // Sustained, not raw: a stop is a step too, and its transient must not read as "still playing".
  expect(sustainedTones(frames, window), `expected silence${context(frames)}`).toEqual([]);
}

/**
 * Assert one track handed over to another with a genuine crossfade of roughly the given length.
 *
 * `monotonic` is checked, so a transition that starts the new track without stopping the old one
 * fails here rather than passing as "an overlap of the right length".
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {object} spec - Expectation.
 * @param {number} spec.from - Outgoing tone index.
 * @param {number} spec.to - Incoming tone index.
 * @param {number} spec.durationMs - Configured crossfade length.
 * @param {boolean} [spec.monotonic=true] - Require the outgoing tone to fall while the incoming
 *   rises. Set false for a hand-off where the outgoing track simply plays out to its natural end
 *   while the next fades in over it: that is a legitimate overlap, but only one side ramps, so the
 *   symmetry check does not apply.
 * @param {number} [spec.tolerance=0.5] - Fractional tolerance on the measured overlap. Wide by
 *   default: the overlap is bounded by where each tone crosses the audibility floor, not by the
 *   fade's nominal endpoints, so a 1000 ms equal-power crossfade measures shorter than 1000 ms
 *   by an amount that depends on the curve. Tighten it only against a recorded baseline.
 * @returns {void}
 */
export function expectCrossfade(frames, { from, to, durationMs, monotonic = true, tolerance = 0.5 }) {
  const result = crossfade(frames, from, to);
  expect(result.found, `expected a crossfade ${toneLabel(from)} -> ${toneLabel(to)}, but they were never audible together${context(frames)}`).toBe(true);
  if (monotonic) expect(result.monotonic, `${toneLabel(from)} and ${toneLabel(to)} overlapped but did not cross-fade (one did not fall while the other rose) - a double-start?${context(frames)}`).toBe(true);
  expect(result.durationMs, `crossfade length${context(frames)}`).toBeGreaterThan(durationMs * (1 - tolerance));
  expect(result.durationMs, `crossfade length${context(frames)}`).toBeLessThan(durationMs * (1 + tolerance));
}

/**
 * Assert a track's handover was a hard cut - no measurable overlap.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {number} from - Outgoing tone index.
 * @param {number} to - Incoming tone index.
 * @param {number} [maxOverlapMs=150] - Overlap allowed before it counts as a fade. One analysis
 *   frame is ~43 ms, so this tolerates a couple of frames of decay tail.
 * @returns {void}
 */
export function expectHardCut(frames, from, to, maxOverlapMs = 150) {
  const result = crossfade(frames, from, to);
  expect(result.durationMs, `expected a hard cut ${toneLabel(from)} -> ${toneLabel(to)}${context(frames)}`).toBeLessThanOrEqual(maxOverlapMs);
}

/**
 * Assert the tracks entered in this order.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {number[]} tones - Expected entry order of tone indices.
 * @returns {void}
 */
export function expectEntryOrder(frames, tones) {
  const actual = entryOrder(frames);
  expect(actual, `expected entry order [${tones.map(toneLabel)}], got [${actual.map(toneLabel)}]${context(frames)}`).toEqual(tones);
}

/**
 * Assert a tone's level in one window is a given fraction of its level in another.
 *
 * The assertion behind ducking, mix ceilings, and cross-client parity.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {object} spec - Expectation.
 * @param {number} spec.tone - Tone index.
 * @param {import('./analysis.mjs').Window} spec.before - Reference window.
 * @param {import('./analysis.mjs').Window} spec.after - Comparison window.
 * @param {number} spec.ratio - Expected `after / before`.
 * @param {number} [spec.tolerance=0.15] - Absolute tolerance on the ratio.
 * @returns {void}
 */
export function expectLevelRatio(frames, { tone, before, after, ratio, tolerance = 0.15 }) {
  const actual = levelRatio(frames, tone, before, after);
  expect(
    actual,
    `expected ${toneLabel(tone)} to change by x${ratio} (+/-${tolerance}), measured x${actual.toFixed(3)}${context(frames)}`
  ).toBeCloseTo(ratio, Math.max(0, -Math.log10(tolerance)));
}

/**
 * Assert two clients heard the same thing.
 *
 * The direct test of CLAUDE.md rule 5's exception: the engine is head-GM-only, but the *mix* is
 * applied per client from the document, so a mix that is head-GM-gated makes these two timelines
 * diverge - the GM hears the ceiling, the player hears the raw track. Nothing short of measuring
 * both outputs catches that.
 * @param {import('./analysis.mjs').ProbeFrame[]} a - Frames from the first client.
 * @param {import('./analysis.mjs').ProbeFrame[]} b - Frames from the second client.
 * @param {number} tone - Tone index to compare.
 * @param {object} [options] - Options.
 * @param {number} [options.tolerance=0.1] - Allowed fractional difference in mean level.
 * @param {import('./analysis.mjs').Window} [options.window] - Window to compare over.
 * @returns {void}
 */
export function expectClientsAgree(a, b, tone, { tolerance = 0.1, window } = {}) {
  const levelA = mean(a, tone, window);
  const levelB = mean(b, tone, window);
  const reference = Math.max(levelA, levelB, AUDIBLE_FLOOR);
  const difference = Math.abs(levelA - levelB) / reference;
  expect(
    difference,
    `clients disagree on ${toneLabel(tone)}: ${levelA.toFixed(3)} vs ${levelB.toFixed(3)}` +
      `\n\nclient A:\n${renderTimeline(a)}\n\nclient B:\n${renderTimeline(b)}\n`
  ).toBeLessThanOrEqual(tolerance);
}

/**
 * Assert a tone faded in (or out) over roughly the configured duration.
 * @param {import('./analysis.mjs').ProbeFrame[]} frames - Captured frames.
 * @param {object} spec - Expectation.
 * @param {number} spec.tone - Tone index.
 * @param {'in'|'out'} spec.direction - Ramp direction.
 * @param {number} spec.durationMs - Configured fade length.
 * @param {number} [spec.tolerance=0.6] - Fractional tolerance. Generous because a 10 %-to-90 %
 *   measurement of an equal-power curve is inherently shorter than the nominal fade.
 * @returns {void}
 */
export function expectFade(frames, { tone, direction, durationMs, tolerance = 0.6 }) {
  const measured = rampDuration(frames, tone, { direction });
  expect(measured, `${toneLabel(tone)} never completed a fade-${direction}${context(frames)}`).not.toBeNull();
  expect(measured, `fade-${direction} length for ${toneLabel(tone)}${context(frames)}`).toBeLessThan(durationMs * (1 + tolerance));
}
