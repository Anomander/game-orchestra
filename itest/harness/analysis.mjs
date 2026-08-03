/**
 * Analysis over a captured amplitude timeline - **pure**, and deliberately so.
 *
 * The probe (see `probe-init.js`) hands back a flat array of frames, each one an amplitude
 * reading per fixture tone at a point in time. Everything a spec actually wants to assert -
 * "these two tracks overlapped for ~2 s", "this track was ducked to 40 %", "the graph visited
 * A then C then B" - is a computation over that array with no browser involved.
 *
 * Keeping it out of the Playwright process is what lets `tests/itest-analysis.test.mjs` run it
 * in the ordinary vitest suite against synthetic timelines. That matters more than it looks:
 * an integration harness that can only be exercised by the thing it tests is a harness whose
 * own bugs get blamed on the module. Every function here is verified against hand-built frames
 * before it is ever pointed at real audio.
 *
 * No Foundry, no Node, no Playwright imports.
 */

import { AUDIBLE_FLOOR, toneLabel } from './tones.mjs';

/**
 * @typedef {object} ProbeFrame
 * @property {number} t     - Milliseconds since the probe was reset.
 * @property {number} rms   - Broadband RMS of the window, all frequencies.
 * @property {number[]} mags - Estimated linear amplitude per tone, indexed by tone index.
 */

/**
 * @typedef {object} Window
 * @property {number} [from] - Start of the window in ms (inclusive). Defaults to the first frame.
 * @property {number} [to]   - End of the window in ms (inclusive). Defaults to the last frame.
 */

/**
 * Restrict a timeline to a time window.
 * @param {ProbeFrame[]} frames - Captured frames, ascending in `t`.
 * @param {Window} [window] - Window to clip to.
 * @returns {ProbeFrame[]}
 */
export function clip(frames, window = {}) {
  const from = window.from ?? -Infinity;
  const to = window.to ?? Infinity;
  return frames.filter((f) => f.t >= from && f.t <= to);
}

/**
 * Peak amplitude a tone reached within a window.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {Window} [window] - Window to measure over.
 * @returns {number} Peak linear amplitude, `0` if the window is empty.
 */
export function peak(frames, tone, window) {
  return clip(frames, window).reduce((max, f) => Math.max(max, f.mags[tone] ?? 0), 0);
}

/**
 * Mean amplitude of a tone within a window.
 *
 * Prefer this over {@link peak} for level assertions (ceiling, duck, mute-adjacent): a single
 * frame can catch a transient, and a mix ceiling is a claim about the sustained level.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {Window} [window] - Window to measure over.
 * @returns {number} Mean linear amplitude, `0` if the window is empty.
 */
export function mean(frames, tone, window) {
  const slice = clip(frames, window);
  if (slice.length === 0) return 0;
  return slice.reduce((sum, f) => sum + (f.mags[tone] ?? 0), 0) / slice.length;
}

/**
 * The tones audible in a single frame.
 * @param {ProbeFrame} frame - One captured frame.
 * @param {number} [floor] - Amplitude floor; defaults to {@link AUDIBLE_FLOOR}.
 * @returns {number[]} Tone indices, ascending.
 */
export function audibleIn(frame, floor = AUDIBLE_FLOOR) {
  const out = [];
  frame.mags.forEach((mag, index) => {
    if (mag >= floor) out.push(index);
  });
  return out;
}

/**
 * Every tone that was audible at any point in a window.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {Window} [window] - Window to measure over.
 * @param {number} [floor] - Amplitude floor.
 * @returns {number[]} Tone indices, ascending.
 */
export function audibleTones(frames, window, floor = AUDIBLE_FLOOR) {
  const seen = new Set();
  for (const frame of clip(frames, window)) for (const tone of audibleIn(frame, floor)) seen.add(tone);
  return [...seen].sort((a, b) => a - b);
}

/**
 * The tones that were audible **continuously for long enough to be a track**, within a window.
 *
 * This, not {@link audibleTones}, is what assertions about "what was playing" should use.
 *
 * Starting a track produces a broadband transient - the gain going from nothing to something is a
 * step, and a step has energy at every frequency. Measured against real Foundry playback it lights
 * up a neighbouring bin for exactly one analysis frame, at full scale. A raw presence test
 * therefore reports a second track that never existed, and `expectExactlyAudible` fails on a
 * perfectly correct transition. *Confirmed live* - the fixtures themselves are spectrally clean
 * (`tests/itest-goertzel.test.mjs` proves the tone table separates to <0.00005), so this is the
 * click, not the content.
 *
 * A real track outlives several frames; a transient does not. Requiring a sustained run tells them
 * apart without weakening what the assertion means.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {Window} [window] - Window to measure over.
 * @param {object} [options] - Options.
 * @param {number} [options.floor] - Amplitude floor.
 * @param {number} [options.minDurationMs=150] - Minimum continuous time above the floor. Roughly
 *   three analysis frames - comfortably longer than any transient, far shorter than any track.
 * @returns {number[]} Tone indices, ascending.
 */
export function sustainedTones(frames, window, { floor = AUDIBLE_FLOOR, minDurationMs = 150 } = {}) {
  const slice = clip(frames, window);
  const toneCount = slice.reduce((max, f) => Math.max(max, f.mags.length), 0);
  const out = [];

  for (let tone = 0; tone < toneCount; tone++) {
    let runStart = null;
    let longest = 0;
    for (const frame of slice) {
      if ((frame.mags[tone] ?? 0) >= floor) {
        runStart ??= frame.t;
        longest = Math.max(longest, frame.t - runStart);
      } else {
        runStart = null;
      }
    }
    if (longest >= minDurationMs) out.push(tone);
  }
  return out;
}

/**
 * @typedef {object} Segment
 * @property {number} startMs - First frame time in the segment.
 * @property {number} endMs   - Last frame time in the segment.
 * @property {number} durationMs - `endMs - startMs`.
 * @property {number[]} tones - The audible tone set held for the whole segment.
 */

/**
 * Collapse a timeline into contiguous segments that share the same audible tone set.
 *
 * This is the backbone of every sequencing assertion. `minDurationMs` exists because a real
 * crossfade produces a genuinely-both-audible stretch bracketed by two one-frame boundary
 * states as each tone crosses the floor; without a floor on duration those boundary blips read
 * as real segments and every sequence assertion grows phantom entries.
 *
 * Segments shorter than `minDurationMs` are **merged into the preceding segment** rather than
 * dropped, so total elapsed time is preserved and a spec can still assert on `durationMs`.
 * @param {ProbeFrame[]} frames - Captured frames, ascending in `t`.
 * @param {object} [options] - Options.
 * @param {number} [options.floor] - Amplitude floor.
 * @param {number} [options.minDurationMs=120] - Segments shorter than this are absorbed.
 * @returns {Segment[]}
 */
export function segments(frames, { floor = AUDIBLE_FLOOR, minDurationMs = 120 } = {}) {
  const raw = [];
  for (const frame of frames) {
    const tones = audibleIn(frame, floor);
    const last = raw[raw.length - 1];
    if (last && sameTones(last.tones, tones)) last.endMs = frame.t;
    else raw.push({ startMs: frame.t, endMs: frame.t, tones });
  }

  const merged = [];
  for (const segment of raw) {
    const duration = segment.endMs - segment.startMs;
    const previous = merged[merged.length - 1];
    if (previous && duration < minDurationMs) previous.endMs = segment.endMs;
    else merged.push({ ...segment });
  }
  return merged.map((s) => ({ ...s, durationMs: s.endMs - s.startMs }));
}

/**
 * The order in which tones first became audible.
 *
 * Answers "did the graph walk A -> C -> B?" without caring whether consecutive tracks
 * crossfaded, since a tone entering during an overlap still enters in the right order.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {object} [options] - Options.
 * @param {number} [options.floor] - Amplitude floor.
 * @param {number} [options.minDurationMs=200] - A tone must stay above the floor this long to
 *   count as an entry, so a fade tail dipping back over the floor does not register twice.
 * @returns {number[]} Tone indices in order of first sustained appearance.
 */
export function entryOrder(frames, { floor = AUDIBLE_FLOOR, minDurationMs = 200 } = {}) {
  const order = [];
  const active = new Set();
  const pending = new Map();

  for (const frame of frames) {
    const audible = new Set(audibleIn(frame, floor));
    for (const tone of audible) {
      if (active.has(tone)) continue;
      const since = pending.get(tone) ?? frame.t;
      pending.set(tone, since);
      if (frame.t - since >= minDurationMs) {
        active.add(tone);
        pending.delete(tone);
        order.push(tone);
      }
    }
    for (const tone of [...pending.keys()]) if (!audible.has(tone)) pending.delete(tone);
    for (const tone of [...active]) if (!audible.has(tone)) active.delete(tone);
  }
  return order;
}

/**
 * @typedef {object} Overlap
 * @property {boolean} found - Whether both tones were ever audible simultaneously.
 * @property {number} startMs - When the overlap began (`0` when not found).
 * @property {number} endMs - When the overlap ended (`0` when not found).
 * @property {number} durationMs - Length of the overlap.
 * @property {boolean} monotonic - Whether `from` trended down and `to` trended up across it -
 *   i.e. whether this was a genuine crossfade rather than an accidental double-start.
 */

/**
 * Measure the crossfade between two tones.
 *
 * A crossfade is not merely "both were audible": a bug that starts the next track without
 * stopping the previous one also produces overlap. `monotonic` is what separates the two, by
 * checking the outgoing tone ends quieter than it started and the incoming one ends louder.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {number} from - Tone index of the outgoing track.
 * @param {number} to - Tone index of the incoming track.
 * @param {object} [options] - Options.
 * @param {number} [options.floor] - Amplitude floor.
 * @returns {Overlap}
 */
export function crossfade(frames, from, to, { floor = AUDIBLE_FLOOR } = {}) {
  // The *longest contiguous* run in which both are audible - not simply the first and last frames
  // where that happens to be true. Start and stop transients are broadband (see
  // {@link sustainedTones}), so an unrelated click can put the outgoing tone briefly back over the
  // floor long after its fade ended. Spanning first-to-last then stretches the measured overlap
  // across the gap between, and compares levels at two moments that were never part of the same
  // fade - which reports a real crossfade as non-monotonic. Confirmed live on a graph walk.
  let best = [];
  let run = [];
  for (const frame of frames) {
    if ((frame.mags[from] ?? 0) >= floor && (frame.mags[to] ?? 0) >= floor) {
      run.push(frame);
      if (run.length > best.length) best = run;
    } else {
      run = [];
    }
  }

  if (best.length === 0) return { found: false, startMs: 0, endMs: 0, durationMs: 0, monotonic: false };

  const first = best[0];
  const last = best[best.length - 1];
  const fromFell = (last.mags[from] ?? 0) < (first.mags[from] ?? 0);
  const toRose = (last.mags[to] ?? 0) > (first.mags[to] ?? 0);

  return { found: true, startMs: first.t, endMs: last.t, durationMs: last.t - first.t, monotonic: fromFell && toRose };
}

/**
 * Measure how long a tone took to ramp between two fractions of its own peak.
 *
 * Reported against the tone's peak inside the window rather than an absolute level, so a fade
 * assertion does not have to know the mix ceiling, the duck factor, or Foundry's volume curve -
 * it only has to know the shape.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {object} [options] - Options.
 * @param {'in'|'out'} [options.direction='in'] - Ramp up or ramp down.
 * @param {number} [options.lower=0.1] - Lower fraction of peak.
 * @param {number} [options.upper=0.9] - Upper fraction of peak.
 * @param {Window} [options.window] - Window to measure over.
 * @returns {number|null} Milliseconds between the two thresholds, or `null` if the tone never
 *   crossed both (never played, or the window clipped the ramp).
 */
export function rampDuration(frames, tone, { direction = 'in', lower = 0.1, upper = 0.9, window } = {}) {
  const slice = clip(frames, window);
  const top = peak(slice, tone);
  if (top <= 0) return null;

  const lowLevel = top * lower;
  const highLevel = top * upper;
  const ordered = direction === 'in' ? slice : [...slice].reverse();

  const lowAt = ordered.find((f) => (f.mags[tone] ?? 0) >= lowLevel);
  const highAt = ordered.find((f) => (f.mags[tone] ?? 0) >= highLevel);
  if (!lowAt || !highAt) return null;
  return Math.abs(highAt.t - lowAt.t);
}

/**
 * Whether a window is silent - no tone above the floor in any frame.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {Window} [window] - Window to measure over.
 * @param {number} [floor] - Amplitude floor.
 * @returns {boolean} `true` for an empty window, since "no audio was captured" is silence.
 */
export function isSilent(frames, window, floor = AUDIBLE_FLOOR) {
  return clip(frames, window).every((f) => audibleIn(f, floor).length === 0);
}

/**
 * The ratio between a tone's level in two windows.
 *
 * The workhorse for every relative-level assertion - ducking, mix ceilings, a player client
 * matching the GM. Expressing them as ratios means a test never has to model Foundry's
 * 1.5-order volume curve, only the factor the module claims to be applying on top of it.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {number} tone - Tone index.
 * @param {Window} before - Reference window.
 * @param {Window} after - Comparison window.
 * @returns {number} `mean(after) / mean(before)`, or `Infinity` when the reference is silent.
 */
export function levelRatio(frames, tone, before, after) {
  const reference = mean(frames, tone, before);
  const comparison = mean(frames, tone, after);
  if (reference <= 0) return comparison > 0 ? Infinity : 0;
  return comparison / reference;
}

/**
 * Render a timeline as a compact text chart, for assertion failure messages and CI logs.
 *
 * A failed audio assertion is close to undebuggable from a bare number, and the captured frames
 * are far too many to dump. This collapses to one row per tone with a coarse amplitude ramp, so
 * the shape of what actually happened is visible in the failure output.
 * @param {ProbeFrame[]} frames - Captured frames.
 * @param {object} [options] - Options.
 * @param {number} [options.columns=72] - Chart width in characters.
 * @returns {string} Multi-line chart.
 */
export function renderTimeline(frames, { columns = 72 } = {}) {
  if (frames.length === 0) return '(no frames captured)';
  const ramp = ' .:-=+*#%@';
  const span = (frames[frames.length - 1].t - frames[0].t) || 1;
  const toneCount = frames.reduce((max, f) => Math.max(max, f.mags.length), 0);
  const lines = [];

  for (let tone = 0; tone < toneCount; tone++) {
    const buckets = new Array(columns).fill(0);
    for (const frame of frames) {
      const column = Math.min(columns - 1, Math.floor(((frame.t - frames[0].t) / span) * columns));
      buckets[column] = Math.max(buckets[column], frame.mags[tone] ?? 0);
    }
    const top = Math.max(...buckets, 1e-9);
    const row = buckets
      .map((value) => (value < AUDIBLE_FLOOR ? ramp[0] : ramp[Math.min(ramp.length - 1, 1 + Math.floor((value / top) * (ramp.length - 2)))]))
      .join('');
    lines.push(`${toneLabel(tone).padEnd(18)}|${row}|`);
  }
  lines.push(`${''.padEnd(18)} 0ms${' '.repeat(Math.max(1, columns - 8))}${Math.round(span)}ms`);
  return lines.join('\n');
}

/**
 * Compare two tone sets for equality.
 * @param {number[]} a - First set, ascending.
 * @param {number[]} b - Second set, ascending.
 * @returns {boolean}
 */
function sameTones(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
