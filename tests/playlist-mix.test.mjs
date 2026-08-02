import { describe, it, expect } from 'vitest';
import { applyGroupGain, clampVolume, coerceVolume, DEFAULT_MIX, effectiveVolume, mixIsTransparent, normalizeMix, resolveCrossfadeMs, resolveCrossfadeOverride, setGroupVolume } from '../scripts/playlist-mix.mjs';

describe('normalizeMix', () => {
  it('fills in a completely absent mix with a transparent one', () => {
    expect(normalizeMix(undefined)).toEqual({ gain: 1, floor: 0, ceiling: 1, crossfadeMs: null, muted: [] });
    expect(normalizeMix(null)).toEqual(normalizeMix(undefined));
  });

  it('clamps out-of-range values rather than propagating them into the audio layer', () => {
    const mix = normalizeMix({ gain: 4, ceiling: 9, floor: -3 });
    expect(mix.gain).toBe(1);
    expect(mix.ceiling).toBe(1);
    expect(mix.floor).toBe(0);
  });

  it('replaces a NaN-producing value with the default instead of poisoning the math', () => {
    // sound.fade(NaN) silences the track with no error, which is the failure this guards.
    expect(normalizeMix({ gain: 'loud' }).gain).toBe(1);
    expect(Number.isNaN(effectiveVolume(0.5, { gain: 'loud' }))).toBe(false);
  });

  it('collapses a floor above the ceiling onto the ceiling, never above it', () => {
    // Only reachable by hand-editing the flag, but swapping them instead would play something
    // LOUDER than the stated maximum - the one guarantee a ceiling makes.
    const mix = normalizeMix({ floor: 0.9, ceiling: 0.3 });
    expect(mix.floor).toBe(0.3);
    expect(mix.ceiling).toBe(0.3);
    expect(effectiveVolume(1, mix)).toBe(0.3);
  });

  it('normalizes muted to an array of ids, whatever shape it arrives in', () => {
    expect(normalizeMix({ muted: ['s1'] }).muted).toEqual(['s1']);
    expect(normalizeMix({ muted: 'yes' }).muted).toEqual([]);
    expect(normalizeMix({ muted: undefined }).muted).toEqual([]);
  });

  it('reads the legacy {id: true} map form, so a playlist saved by an in-between build is not stuck muted', () => {
    // That shape is the bug itself: a flag write recursively MERGES, so removing a key from a
    // map never persisted and unmute silently did nothing.
    expect(normalizeMix({ muted: { s1: true, s2: false } }).muted).toEqual(['s1']);
    // `-=` deletion operators that leaked into the stored value are not sound ids.
    expect(normalizeMix({ muted: { 's1': true, '-=s2': true } }).muted).toEqual(['s1']);
  });

  it('exposes DEFAULT_MIX as frozen, so a caller cannot mutate every playlist at once', () => {
    expect(Object.isFrozen(DEFAULT_MIX)).toBe(true);
  });
});

describe('coerceVolume', () => {
  it('falls back only for missing or non-finite input', () => {
    expect(coerceVolume(0.4, 1)).toBe(0.4);
    expect(coerceVolume(0, 1)).toBe(0); // a real 0 is not "missing"
    expect(coerceVolume(undefined, 1)).toBe(1);
    expect(coerceVolume(Infinity, 1)).toBe(1);
    expect(coerceVolume('0.25', 1)).toBe(0.25);
  });
});

describe('clampVolume', () => {
  it('applies both bounds of a normalized mix', () => {
    const mix = normalizeMix({ floor: 0.2, ceiling: 0.8 });
    expect(clampVolume(0.1, mix)).toBe(0.2);
    expect(clampVolume(0.5, mix)).toBe(0.5);
    expect(clampVolume(0.95, mix)).toBe(0.8);
  });
});

describe('effectiveVolume', () => {
  it('is the sound\'s own volume when the mix is transparent', () => {
    expect(effectiveVolume(0.6, null)).toBe(0.6);
    expect(effectiveVolume(0.6, {})).toBe(0.6);
  });

  it('scales by the master gain', () => {
    expect(effectiveVolume(0.5, { gain: 0.5 })).toBe(0.25);
  });

  it('clamps after the gain, not before', () => {
    // 1.0 * 0.9 = 0.9, over a 0.6 ceiling. Clamping first would have let the gain pull it back
    // under and the ceiling would mean nothing.
    expect(effectiveVolume(1, { gain: 0.9, ceiling: 0.6 })).toBe(0.6);
  });

  it('returns 0 for a muted sound even when a floor would otherwise lift it', () => {
    // Mute must short-circuit ahead of the clamp - a floor making a muted track audible is not
    // a trade-off, it is a bug.
    expect(effectiveVolume(0.8, { floor: 0.3, muted: ['s1'] }, 's1')).toBe(0);
  });

  it('only mutes the named sound', () => {
    expect(effectiveVolume(0.8, { muted: ['s1'] }, 's2')).toBe(0.8);
    // No id supplied: mute cannot be honoured, and the volume must not be silently zeroed.
    expect(effectiveVolume(0.8, { muted: ['s1'] })).toBe(0.8);
  });

  it('never returns a value outside [0, 1] whatever it is handed', () => {
    for (const volume of [-5, 0, 0.5, 1, 42, NaN, undefined, 'x']) {
      const value = effectiveVolume(volume, { gain: 1 });
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('mixIsTransparent', () => {
  it('is true for an untouched playlist and false once anything is set', () => {
    expect(mixIsTransparent(null)).toBe(true);
    expect(mixIsTransparent({ crossfadeMs: 200 })).toBe(true); // crossfade is not a level
    expect(mixIsTransparent({ gain: 0.9 })).toBe(false);
    expect(mixIsTransparent({ ceiling: 0.9 })).toBe(false);
    expect(mixIsTransparent({ floor: 0.1 })).toBe(false);
    expect(mixIsTransparent({ muted: ['s1'] })).toBe(false);
  });
});

describe('resolveCrossfadeOverride', () => {
  it('treats an explicit 0 as a value, not as "unset"', () => {
    // 0 means "never crossfade this playlist" and must survive every link of the chain.
    expect(resolveCrossfadeOverride(0)).toBe(0);
    expect(resolveCrossfadeOverride('0')).toBe(0);
  });

  it('treats blank, null and undefined as unset', () => {
    expect(resolveCrossfadeOverride('')).toBeNull();
    expect(resolveCrossfadeOverride(null)).toBeNull();
    expect(resolveCrossfadeOverride(undefined)).toBeNull();
  });

  it('rejects negatives and garbage, and rounds', () => {
    expect(resolveCrossfadeOverride(-50)).toBeNull();
    expect(resolveCrossfadeOverride('soon')).toBeNull();
    expect(resolveCrossfadeOverride(150.7)).toBe(151);
  });
});

describe('resolveCrossfadeMs', () => {
  it('prefers the mix over both the legacy graph value and the world setting', () => {
    expect(resolveCrossfadeMs({ mix: { crossfadeMs: 250 }, legacyGraphMs: 100, worldMs: 50 })).toBe(250);
  });

  it('falls through to the legacy graph value when the mix has none', () => {
    // The read-side migration: graphs already saved in live worlds keep their override with no
    // data rewrite, because this link is still read even though it is never written any more.
    expect(resolveCrossfadeMs({ mix: {}, legacyGraphMs: 100, worldMs: 50 })).toBe(100);
    expect(resolveCrossfadeMs({ mix: null, legacyGraphMs: 100, worldMs: 50 })).toBe(100);
  });

  it('falls through to the world setting when neither override is set', () => {
    expect(resolveCrossfadeMs({ mix: null, legacyGraphMs: null, worldMs: 50 })).toBe(50);
    expect(resolveCrossfadeMs({})).toBe(0);
  });

  it('honours an explicit 0 at every link, rather than reading it as "no override"', () => {
    expect(resolveCrossfadeMs({ mix: { crossfadeMs: 0 }, legacyGraphMs: 100, worldMs: 50 })).toBe(0);
    expect(resolveCrossfadeMs({ mix: null, legacyGraphMs: 0, worldMs: 50 })).toBe(0);
  });

  it('coerces a malformed world setting to 0 rather than NaN', () => {
    expect(resolveCrossfadeMs({ worldMs: 'lots' })).toBe(0);
    expect(resolveCrossfadeMs({ worldMs: -20 })).toBe(0);
  });
});

describe('applyGroupGain', () => {
  const tracks = [
    { id: 'a', volume: 0.8 },
    { id: 'b', volume: 0.4 },
    { id: 'c', volume: 0.2 }
  ];

  it('moves the loudest selected track to the target', () => {
    expect(applyGroupGain(tracks, 0.4).a).toBeCloseTo(0.4);
  });

  it('preserves the balance between the selected tracks', () => {
    const result = applyGroupGain(tracks, 0.4);
    expect(result.b / result.a).toBeCloseTo(0.4 / 0.8);
    expect(result.c / result.a).toBeCloseTo(0.2 / 0.8);
  });

  it('does not push any track past 1 while pulling the group up', () => {
    // Deriving the ratio from the peak is what keeps the group from clipping unevenly: a
    // per-track scale would flatten the loudest against the ceiling and leave the rest behind.
    const result = applyGroupGain(tracks, 1);
    expect(result.a).toBeCloseTo(1);
    expect(Math.max(...Object.values(result))).toBeLessThanOrEqual(1);
  });

  it('sets every track to the target when they are all silent, instead of dividing by zero', () => {
    const silent = [{ id: 'a', volume: 0 }, { id: 'b', volume: 0 }];
    expect(applyGroupGain(silent, 0.5)).toEqual({ a: 0.5, b: 0.5 });
  });

  it('returns an empty map for an empty selection', () => {
    expect(applyGroupGain([], 0.5)).toEqual({});
    expect(applyGroupGain(undefined, 0.5)).toEqual({});
  });

  it('collapses to silence at 0 - the ratios are gone, by design', () => {
    expect(applyGroupGain(tracks, 0)).toEqual({ a: 0, b: 0, c: 0 });
  });
});

describe('setGroupVolume', () => {
  it('flattens every selected track to one level (the Alt-modified move)', () => {
    expect(setGroupVolume([{ id: 'a' }, { id: 'b' }], 0.3)).toEqual({ a: 0.3, b: 0.3 });
  });

  it('clamps the target into range', () => {
    expect(setGroupVolume([{ id: 'a' }], 5)).toEqual({ a: 1 });
  });
});
