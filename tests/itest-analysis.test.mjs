/**
 * Unit tests for the integration harness's own analysis layer.
 *
 * These run in the ordinary vitest suite, with no browser and no Foundry, against hand-built
 * timelines. That is the point: the audio tier's assertions are only trustworthy if the code
 * computing them is itself tested, and it cannot be tested by the integration suite it powers
 * without circularity. A bug in `crossfade()` would otherwise surface as a module bug.
 *
 * The synthetic frames here also document what a captured timeline looks like, which is
 * genuinely hard to picture from the probe code alone.
 */

import { describe, expect, it } from 'vitest';

import {
  audibleTones,
  sustainedTones,
  crossfade,
  entryOrder,
  isSilent,
  levelRatio,
  mean,
  peak,
  rampDuration,
  renderTimeline,
  segments
} from '../itest/harness/analysis.mjs';
import { HARMONIC_GUARD_HZ, TONES, toneIndex } from '../itest/harness/tones.mjs';

const A = 0;
const B = 1;

/**
 * Build a synthetic timeline.
 * @param {Array<Array<number>>} rows - One row per frame, each an amplitude per tone.
 * @param {number} [stepMs=40] - Spacing between frames, matching the probe's ~43 ms window.
 * @returns {import('../itest/harness/analysis.mjs').ProbeFrame[]}
 */
function timeline(rows, stepMs = 40) {
  return rows.map((mags, index) => ({ t: index * stepMs, rms: Math.max(...mags), mags }));
}

describe('tone table', () => {
  it('keeps every tone clear of every other tone\'s harmonics by the full guard', () => {
    // The property the whole identity scheme rests on. Measured in Hz rather than as a ratio
    // because the analysis window is what decides distinguishability: an earlier draft of this
    // table put 683 Hz within 9 Hz of 337 Hz's second harmonic - the same ~23 Hz bin - which
    // would have made harmonic distortion from one track read as another track playing.
    for (const a of TONES) {
      for (const b of TONES) {
        if (a === b) continue;
        expect(Math.abs(a.freq - b.freq), `${a.freq} and ${b.freq} are too close`).toBeGreaterThanOrEqual(HARMONIC_GUARD_HZ);
        for (let k = 2; k <= 4; k++) {
          expect(
            Math.abs(b.freq - k * a.freq),
            `${b.freq} Hz is within ${HARMONIC_GUARD_HZ} Hz of harmonic ${k} of ${a.freq} Hz`
          ).toBeGreaterThanOrEqual(HARMONIC_GUARD_HZ);
        }
      }
    }
  });

  it('rejects an unknown tone id rather than returning -1', () => {
    expect(() => toneIndex('nope')).toThrow(/Unknown tone/);
  });
});

describe('level measurement', () => {
  const frames = timeline([
    [0.5, 0],
    [0.5, 0],
    [0.25, 0],
    [0.25, 0]
  ]);

  it('measures peak and mean over a window', () => {
    expect(peak(frames, A)).toBe(0.5);
    expect(mean(frames, A)).toBeCloseTo(0.375, 5);
    expect(mean(frames, A, { from: 80 })).toBeCloseTo(0.25, 5);
  });

  it('expresses a level change as a ratio between two windows', () => {
    expect(levelRatio(frames, A, { to: 40 }, { from: 80 })).toBeCloseTo(0.5, 5);
  });

  it('reports Infinity rather than NaN when the reference window is silent', () => {
    // A duck assertion against a window where nothing played must fail loudly, not compare NaN.
    expect(levelRatio(frames, B, { to: 40 }, { from: 80 })).toBe(0);
    expect(levelRatio(timeline([[0, 0], [0, 0.5]]), B, { to: 0 }, { from: 40 })).toBe(Infinity);
  });
});

describe('audibility', () => {
  it('treats sub-floor amplitude as silence', () => {
    const frames = timeline([[0.001, 0], [0.001, 0]]);
    expect(isSilent(frames)).toBe(true);
    expect(audibleTones(frames)).toEqual([]);
  });

  it('treats an empty window as silence', () => {
    expect(isSilent(timeline([[0.5, 0]]), { from: 5000 })).toBe(true);
  });
});

describe('sustainedTones', () => {
  it('ignores a one-frame transient but keeps a real track', () => {
    // The exact shape real playback produces: starting a track is a step, and a step is
    // broadband, so a neighbouring bin reads full-scale for a single frame. Without this filter
    // `expectExactlyAudible` reports a second track that never played.
    const frames = timeline([
      [0.5, 0], [0.5, 0.5], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0]
    ]);
    expect(audibleTones(frames)).toEqual([A, B]);
    expect(sustainedTones(frames)).toEqual([A]);
  });

  it('counts a tone that stays up for longer than the minimum', () => {
    const frames = timeline([[0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5]]);
    expect(sustainedTones(frames, undefined, { minDurationMs: 150 })).toEqual([B]);
  });

  it('measures the run inside the window, not across a gap', () => {
    // Two short bursts must not add up to one long one - that would let a stuttering start pass
    // as a playing track.
    const frames = timeline([
      [0.5, 0], [0.5, 0], [0, 0], [0, 0], [0.5, 0], [0.5, 0]
    ]);
    expect(sustainedTones(frames, undefined, { minDurationMs: 150 })).toEqual([]);
  });
});

describe('segments', () => {
  it('collapses frames into contiguous audible-set runs', () => {
    const frames = timeline([
      [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0],
      [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5],
      [0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5]
    ]);
    const result = segments(frames, { minDurationMs: 80 });
    expect(result.map((s) => s.tones)).toEqual([[A], [A, B], [B]]);
    expect(result[0].durationMs).toBe(160);
  });

  it('absorbs a one-frame boundary blip into the preceding segment', () => {
    // A real crossfade produces exactly this: a single frame where the incoming tone has just
    // crossed the floor. Without absorption every sequence assertion grows phantom entries.
    const frames = timeline([
      [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0],
      [0.5, 0.02],
      [0, 0.5], [0, 0.5], [0, 0.5], [0, 0.5]
    ]);
    expect(segments(frames, { minDurationMs: 120 }).map((s) => s.tones)).toEqual([[A], [B]]);
  });
});

describe('entryOrder', () => {
  it('reports first sustained appearance, ignoring order of overlap', () => {
    const frames = timeline([
      [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0],
      [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]
    ]);
    expect(entryOrder(frames, { minDurationMs: 100 })).toEqual([A, B]);
  });

  it('does not count a brief re-crossing of the floor as a second entry', () => {
    const frames = timeline([
      [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0],
      [0, 0], [0.02, 0], [0, 0], [0, 0], [0, 0], [0, 0]
    ]);
    expect(entryOrder(frames, { minDurationMs: 100 })).toEqual([A]);
  });
});

describe('crossfade', () => {
  const fading = timeline([
    [0.5, 0],
    [0.4, 0.1],
    [0.3, 0.2],
    [0.2, 0.3],
    [0.1, 0.4],
    [0, 0.5]
  ]);

  it('measures the overlap and confirms it was monotonic', () => {
    const result = crossfade(fading, A, B);
    expect(result.found).toBe(true);
    expect(result.monotonic).toBe(true);
    // Frames 1..4 are the ones with both tones above the floor: 40 ms to 160 ms. The overlap is
    // bounded by floor crossings, not by the fade's nominal endpoints - which is exactly why
    // `expectCrossfade` defaults to a wide tolerance.
    expect(result.durationMs).toBe(120);
  });

  it('rejects a double-start: both audible, neither trending', () => {
    // The bug this distinguishes is a new track starting without the old one stopping. It
    // produces overlap of exactly the right length, and only the trend tells them apart.
    const doubled = timeline([[0.5, 0], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
    expect(crossfade(doubled, A, B).monotonic).toBe(false);
  });

  it('measures the longest contiguous overlap, ignoring a later stray transient', () => {
    // A stop/start click can push the outgoing tone back over the floor long after its fade has
    // finished. Spanning first-to-last would stretch the overlap across that gap and compare two
    // moments that were never part of the same fade - reporting a real crossfade as a double-start.
    const frames = timeline([
      [0.5, 0],
      [0.4, 0.1], [0.3, 0.2], [0.2, 0.3], [0.1, 0.4],
      [0, 0.5], [0, 0.5], [0, 0.5],
      [0.05, 0.4],          // <- stray transient of the outgoing tone, long after the fade
      [0, 0.3], [0, 0.2]
    ]);
    const result = crossfade(frames, A, B);
    expect(result.startMs).toBe(40);
    expect(result.endMs).toBe(160);
    expect(result.monotonic).toBe(true);
  });

  it('reports not-found rather than throwing when the tones never overlap', () => {
    const cut = timeline([[0.5, 0], [0.5, 0], [0, 0.5], [0, 0.5]]);
    expect(crossfade(cut, A, B)).toMatchObject({ found: false, durationMs: 0 });
  });
});

describe('rampDuration', () => {
  it('measures a fade-in between 10% and 90% of the tone\'s own peak', () => {
    const frames = timeline([[0, 0], [0.05, 0], [0.1, 0], [0.25, 0], [0.45, 0], [0.5, 0]]);
    // 10% of 0.5 is 0.05 (frame 1); 90% is 0.45 (frame 4). Three 40 ms steps apart.
    expect(rampDuration(frames, A, { direction: 'in' })).toBe(120);
  });

  it('returns null when the tone never played, rather than 0', () => {
    // 0 would read as an instant fade and pass a "faded fast enough" assertion.
    expect(rampDuration(timeline([[0, 0], [0, 0]]), A)).toBeNull();
  });
});

describe('renderTimeline', () => {
  it('renders a row per tone and says so when nothing was captured', () => {
    expect(renderTimeline([])).toBe('(no frames captured)');
    // One row per tone actually present in the frames (plus the time axis), not per table entry -
    // a timeline captured with a shorter mags array renders only what it measured.
    const chart = renderTimeline(timeline([[0.5, 0], [0, 0.5]]));
    expect(chart.split('\n').length).toBe(3);
    expect(chart).toContain('alpha');
  });
});
