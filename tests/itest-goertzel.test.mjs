/**
 * Numeric verification of the integration probe's amplitude detector.
 *
 * Every level assertion in the audio tier - ducking factors, mix ceilings, cross-client parity -
 * is only as trustworthy as this arithmetic, and it is arithmetic that cannot be checked by
 * inspection. So it is checked here against synthesised signals whose true amplitude is known by
 * construction, with no browser involved.
 *
 * These tests are also the executable statement of the two claims the harness makes about its own
 * measurements: that a reading is comparable to the source amplitude, and that tones in the table
 * do not bleed into each other's readings.
 */

import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { renderSilence, renderTone } from '../itest/fixtures/generate.mjs';
import { goertzelAmplitudes, goertzelCoefficients, hannWindow, rms } from '../itest/harness/goertzel.mjs';
import { buildWorkletSource } from '../itest/harness/worklet-source.mjs';
import { AUDIBLE_FLOOR, FIXTURE_AMPLITUDE, FIXTURE_SAMPLE_RATE, HARMONIC_GUARD_HZ, TONES, toneFrequencies } from '../itest/harness/tones.mjs';

const WINDOW_SIZE = 2048;
const window = hannWindow(WINDOW_SIZE);
const frequencies = toneFrequencies();
const coefficients = goertzelCoefficients(frequencies, FIXTURE_SAMPLE_RATE);

/**
 * Synthesise one analysis window containing a mix of tones.
 * @param {Array<{freq: number, amp: number, phase?: number}>} components - Tones to sum.
 * @returns {Float32Array} `WINDOW_SIZE` mono samples.
 */
function synth(components) {
  const buffer = new Float32Array(WINDOW_SIZE);
  for (let i = 0; i < WINDOW_SIZE; i++) {
    let sample = 0;
    for (const { freq, amp, phase = 0 } of components) {
      sample += amp * Math.sin((2 * Math.PI * freq * i) / FIXTURE_SAMPLE_RATE + phase);
    }
    buffer[i] = sample;
  }
  return buffer;
}

describe('amplitude recovery', () => {
  it('reads back a single tone at its true amplitude', () => {
    for (const tone of TONES) {
      const mags = goertzelAmplitudes(synth([{ freq: tone.freq, amp: FIXTURE_AMPLITUDE }]), coefficients, window);
      const index = frequencies.indexOf(tone.freq);
      // Within 10%: Hann leaves up to ~15% scalloping loss at the worst bin offset, and these
      // frequencies do not land on bin centres. This is the tolerance every level assertion in
      // expect-audio.mjs is ultimately built on.
      expect(mags[index], `${tone.label} amplitude`).toBeGreaterThan(FIXTURE_AMPLITUDE * 0.9);
      expect(mags[index], `${tone.label} amplitude`).toBeLessThan(FIXTURE_AMPLITUDE * 1.1);
    }
  });

  it('is insensitive to phase', () => {
    // Playback starts at an arbitrary point in the waveform, so a phase-sensitive detector would
    // report a different level every run and no tolerance would hold.
    const levels = [0, 0.7, 1.6, 3.0].map(
      (phase) => goertzelAmplitudes(synth([{ freq: TONES[0].freq, amp: 0.5, phase }]), coefficients, window)[0]
    );
    for (const level of levels) expect(level).toBeCloseTo(levels[0], 2);
  });

  it('tracks a gain change linearly, which is what every ratio assertion assumes', () => {
    const full = goertzelAmplitudes(synth([{ freq: TONES[0].freq, amp: 0.5 }]), coefficients, window)[0];
    const ducked = goertzelAmplitudes(synth([{ freq: TONES[0].freq, amp: 0.2 }]), coefficients, window)[0];
    expect(ducked / full).toBeCloseTo(0.4, 2);
  });
});

describe('separation between tones', () => {
  it('reads only the tone that is present', () => {
    const mags = goertzelAmplitudes(synth([{ freq: TONES[2].freq, amp: 0.5 }]), coefficients, window);
    mags.forEach((mag, index) => {
      if (index === 2) expect(mag).toBeGreaterThan(0.4);
      // Leakage into every other bin must stay well under the audibility floor, or a single
      // playing track would intermittently register as two and `expectExactlyAudible` would be
      // useless. Asserted against half the floor rather than a literal, so the two constants
      // cannot drift apart: this is what sets AUDIBLE_FLOOR's value.
      else expect(mag, `leakage into ${TONES[index].label}`).toBeLessThan(AUDIBLE_FLOOR / 2);
    });
  });

  it('resolves two simultaneous tones independently, at different levels', () => {
    // The layered/ducking case: a bed and an overlay playing at once, each measured on its own.
    const mags = goertzelAmplitudes(
      synth([{ freq: TONES[0].freq, amp: 0.5 }, { freq: TONES[4].freq, amp: 0.2 }]),
      coefficients,
      window
    );
    expect(mags[0]).toBeGreaterThan(0.45);
    expect(mags[4]).toBeGreaterThan(0.17);
    expect(mags[4]).toBeLessThan(0.23);
    expect(mags[2]).toBeLessThan(AUDIBLE_FLOOR);
  });

  it('does not mistake harmonic distortion for another track', () => {
    // A gain stage clipping or a lossy codec adds harmonics of whatever is playing. The tone
    // table is spaced so those land clear of every other bin; this proves the spacing is enough
    // by feeding a deliberately distorted tone - harmonics at 2x, 3x and 4x, at 10% each.
    const base = TONES[0].freq;
    const mags = goertzelAmplitudes(
      synth([
        { freq: base, amp: 0.5 },
        { freq: base * 2, amp: 0.05 },
        { freq: base * 3, amp: 0.05 },
        { freq: base * 4, amp: 0.05 }
      ]),
      coefficients,
      window
    );
    mags.forEach((mag, index) => {
      if (index === 0) return;
      expect(mag, `${TONES[index].label} picked up harmonic distortion from ${base} Hz`).toBeLessThan(AUDIBLE_FLOOR);
    });
  });

  it('the guard constant is what actually keeps harmonics out of the bins', () => {
    // Ties the numeric result above back to the constant, so if someone widens the table without
    // re-solving it, the failure names the reason.
    const spacing = Math.min(
      ...TONES.flatMap((a) =>
        TONES.filter((b) => b !== a).flatMap((b) => [2, 3, 4].map((k) => Math.abs(b.freq - k * a.freq)))
      )
    );
    expect(spacing).toBeGreaterThanOrEqual(HARMONIC_GUARD_HZ);
  });
});

describe('generated fixtures', () => {
  /**
   * Decode a 16-bit mono WAV buffer to float samples.
   * @param {Buffer} wav - A file produced by the fixture generator.
   * @returns {Float32Array}
   */
  function decode(wav) {
    const samples = new Float32Array((wav.length - 44) / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = wav.readInt16LE(44 + i * 2) / 32767;
    return samples;
  }

  it('renders each tone at the frequency and level the detector expects', () => {
    // Closes the loop: the generator and the detector are configured from the same table, and
    // this proves they actually agree. A fixture that rendered at the wrong frequency would make
    // the probe report the wrong *track*, and every sequencing assertion would be confidently
    // wrong rather than failing.
    for (const tone of TONES) {
      const samples = decode(renderTone(tone.freq, 1));
      const mags = goertzelAmplitudes(samples.subarray(0, WINDOW_SIZE), coefficients, window);
      const index = frequencies.indexOf(tone.freq);
      expect(mags[index], `${tone.label} fixture level`).toBeGreaterThan(FIXTURE_AMPLITUDE * 0.9);
      mags.forEach((mag, other) => {
        if (other !== index) expect(mag, `${tone.label} fixture bled into ${TONES[other].label}`).toBeLessThan(AUDIBLE_FLOOR / 2);
      });
    }
  });

  it('trims every fixture to a whole number of cycles so the loop seam is silent', () => {
    // A tone cut mid-cycle steps at the loop point, and a step is broadband - it lands energy in
    // every bin at once, so every other track would flicker into audibility once per loop.
    for (const tone of TONES) {
      const samples = decode(renderTone(tone.freq, 1));

      // The seam is the step from the last sample back to the first, and "clean" does not mean
      // that step is near zero - it means it is no larger than the steps the waveform already
      // takes between adjacent samples. Comparing to zero instead would demand the fixture end
      // exactly at a zero crossing, which is a stricter and irrelevant property: a sine looping
      // at its peak is perfectly continuous.
      let maxStep = 0;
      for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i] - samples[i - 1]));
      const seam = Math.abs(samples[0] - samples[samples.length - 1]);

      expect(seam, `${tone.label} loop seam is a discontinuity, not a normal step`).toBeLessThanOrEqual(maxStep * 1.5);
    }
  });

  it('renders silence that measures as silence', () => {
    const samples = decode(renderSilence(0.1));
    expect(rms(samples)).toBe(0);
  });
});

describe('worklet source assembly', () => {
  it('produces source that parses, and defines the processor the probe instantiates', () => {
    // The worklet is loaded from a blob URL inside the page, so a parse error there surfaces as
    // a rejected addModule() and then as an empty timeline - i.e. as every audio assertion
    // passing vacuously. Compiling it here turns that into a unit-test failure instead.
    const source = buildWorkletSource();
    expect(() => new Script(source)).not.toThrow();
    expect(source).toContain("registerProcessor('go-tone-probe'");
    // The maths must have arrived, and arrived without its module syntax.
    expect(source).toContain('function goertzelAmplitudes');
    expect(source).not.toMatch(/^export /m);
    expect(source).not.toMatch(/^import /m);
  });
});

describe('rms', () => {
  it('matches the analytic value for a sine', () => {
    expect(rms(synth([{ freq: TONES[0].freq, amp: 0.5 }]))).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('is zero for silence', () => {
    expect(rms(new Float32Array(WINDOW_SIZE))).toBe(0);
  });
});
