/**
 * The amplitude detector, extracted so it can be tested without a browser.
 *
 * This is the single most important piece of arithmetic in the integration tier: every assertion
 * about levels, fades, ducking and crossfades is downstream of it. If it is off by a constant,
 * every ratio assertion still passes (ratios cancel it) while every absolute claim is quietly
 * wrong - so it is verified numerically in `tests/itest-analysis.test.mjs` against synthesised
 * signals of known amplitude.
 *
 * ## It is shared with the worklet by source concatenation, not by import
 *
 * An `AudioWorkletGlobalScope` has no module loader - a worklet cannot `import`. Rather than keep
 * two copies of the maths (the classic way this drifts, and the drift is undetectable because
 * both halves are individually plausible), `session.mjs` reads this file, strips the `export`
 * keywords, and prepends it to the processor source. That is why every export here is a plain
 * `function` declaration and why this file must not import anything.
 */

/**
 * Build a Hann window.
 *
 * Hann costs ~1.5x resolution bandwidth but cuts scalloping loss from ~36% to ~15%: without it a
 * tone whose frequency does not divide evenly into the window reads as much as a third quiet, and
 * every level assertion would need an implausibly wide tolerance to survive it.
 * @param {number} size - Window length in samples.
 * @returns {Float32Array}
 */
export function hannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  return window;
}

/**
 * Goertzel coefficients for a set of target frequencies.
 * @param {number[]} frequencies - Target frequencies in Hz.
 * @param {number} sampleRate - Sample rate in Hz.
 * @returns {number[]} One coefficient per frequency.
 */
export function goertzelCoefficients(frequencies, sampleRate) {
  return frequencies.map((freq) => 2 * Math.cos((2 * Math.PI * freq) / sampleRate));
}

/**
 * Estimate the peak amplitude of each target frequency present in a windowed buffer.
 *
 * The `4/N` scale factor undoes Hann's 0.5 coherent gain on top of the usual `2/N`, so the
 * returned number is directly comparable to the amplitude of the sine that produced it - a pure
 * 0.5-amplitude tone reads ~0.5. That is what makes the captured timelines readable by eye and
 * the tolerances in `expect-audio.mjs` meaningful rather than arbitrary.
 * @param {Float32Array|number[]} buffer - Exactly `window.length` mono samples.
 * @param {number[]} coefficients - From {@link goertzelCoefficients}.
 * @param {Float32Array} window - From {@link hannWindow}.
 * @returns {number[]} Estimated linear amplitude per frequency.
 */
export function goertzelAmplitudes(buffer, coefficients, window) {
  const size = window.length;
  const out = new Array(coefficients.length);

  for (let f = 0; f < coefficients.length; f++) {
    const coefficient = coefficients[f];
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < size; i++) {
      const s0 = buffer[i] * window[i] + coefficient * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
    out[f] = (4 * Math.sqrt(Math.max(0, power))) / size;
  }
  return out;
}

/**
 * Root-mean-square of a buffer.
 * @param {Float32Array|number[]} buffer - Samples.
 * @returns {number}
 */
export function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}
