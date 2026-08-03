/**
 * The audio probe's AudioWorkletProcessor - runs on the audio render thread inside the page.
 *
 * Loaded as a blob URL by `probe-init.js`. It is **not** standalone: `session.mjs` prepends the
 * contents of `goertzel.mjs` (with its `export` keywords stripped) before evaluating it, so
 * `hannWindow`, `goertzelCoefficients`, `goertzelAmplitudes` and `rms` are in scope here. See
 * that file's header for why the maths lives there and arrives by concatenation - an
 * AudioWorkletGlobalScope has no module loader, and a second copy of the detector would drift
 * undetectably.
 *
 * ## Why a worklet and not an AnalyserNode
 *
 * `AnalyserNode.getFloatFrequencyData()` is sampled from the main thread, so its readings are
 * spaced by whenever a `requestAnimationFrame` happened to run. Under a headless browser with a
 * throttled or absent rAF that is neither regular nor fine-grained enough to measure a 500 ms
 * crossfade. A worklet is driven by the audio clock: it sees every render quantum, and its
 * timestamps come from `currentFrame`, so a captured timeline is exact in audio time regardless
 * of what the main thread was doing.
 */

/** Analysis window in samples. ~42.7 ms at 48 kHz: fine enough to resolve a 300 ms fade. */
const WINDOW_SIZE = 2048;

/**
 * Captures per-tone amplitude on the audio thread and posts frames to the page.
 *
 * Declared with `numberOfOutputs: 0` by the caller: the probe is a pure sink spliced *alongside*
 * the real destination, never in series with it. Passing audio through would put a worklet in the
 * signal path of the thing under test, and a glitch in the probe would then look like a glitch in
 * the module.
 */
class ToneProbeProcessor extends AudioWorkletProcessor {
  /**
   * @param {AudioWorkletNodeOptions} options - `processorOptions.frequencies` is the tone table's
   *   frequency list, in tone-index order.
   */
  constructor(options) {
    super();
    const frequencies = options?.processorOptions?.frequencies ?? [];

    /** @type {Float32Array} Accumulating analysis window (mono sum of all channels). */
    this.buffer = new Float32Array(WINDOW_SIZE);
    /** @type {number} Write cursor into {@link buffer}. */
    this.cursor = 0;
    this.coefficients = goertzelCoefficients(frequencies, sampleRate);
    this.window = hannWindow(WINDOW_SIZE);
  }

  /**
   * Accumulate one render quantum, emitting a frame each time the window fills.
   * @param {Float32Array[][]} inputs - Connected inputs; only input 0 is analysed.
   * @returns {boolean} Always `true` - the probe must outlive any silence between tracks, since
   *   "it went quiet here" is itself an assertion specs make.
   */
  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) {
      // No connected source yet. Still advance time by feeding silence, so a gap before the first
      // track shows up in the timeline as measured silence rather than as missing frames.
      for (let i = 0; i < 128; i++) this.push(0);
      return true;
    }

    const length = channels[0].length;
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i];
      this.push(sum / channels.length);
    }
    return true;
  }

  /**
   * Append one mono sample, emitting a frame when the window is full.
   * @param {number} sample - Mono sample value.
   * @returns {void}
   */
  push(sample) {
    this.buffer[this.cursor++] = sample;
    if (this.cursor < WINDOW_SIZE) return;
    this.port.postMessage({
      t: (currentFrame / sampleRate) * 1000,
      rms: rms(this.buffer),
      mags: goertzelAmplitudes(this.buffer, this.coefficients, this.window)
    });
    this.cursor = 0;
  }
}

registerProcessor('go-tone-probe', ToneProbeProcessor);
