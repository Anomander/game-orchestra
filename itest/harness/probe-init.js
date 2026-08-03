/**
 * The in-page half of the audio probe. Installed with Playwright's `addInitScript`, so it runs
 * **before any page script** - which is the entire reason it works.
 *
 * ## How the tap is installed
 *
 * There is no browser API for "give me the audio reaching the speakers". What there is:
 * everything audible must eventually `connect()` to an `AudioContext`'s `destination`. So this
 * patches `AudioNode.prototype.connect` before Foundry exists, and reroutes any connection whose
 * target is a context destination into a per-context pass-through gain node, which fans out to
 * *both* the real destination and a probe worklet.
 *
 * Patching `connect` rather than reaching for `game.audio.music` is deliberate: the module's
 * mixer, ducking and crossfades all operate on gain nodes whose arrangement is an implementation
 * detail of Foundry's audio layer, and one that has already changed across versions. Tapping the
 * destination measures the same thing the player hears no matter how the graph above it is wired -
 * including any path that bypasses `game.audio` entirely.
 *
 * ## Foundry uses more than one AudioContext, and that changes everything
 *
 * *Confirmed live on 14.364: `status().attached` is **3**.* Foundry builds separate contexts (the
 * music/environment/interface split), so the `connect` patch quite correctly installs three taps
 * and three worklets - and each posts frames on **its own clock**, since `currentTime` starts at
 * zero whenever a context is created.
 *
 * Left alone that produces one interleaved timeline at three times the real frame rate, in which
 * two out of every three frames are silence from the contexts that are not playing anything. Every
 * run-based analysis then collapses: a continuously playing track shows a longest-run of one frame,
 * so `sustainedTones()` reports nothing audible, `segments()` sees an alternating strobe, and
 * `entryOrder()` returns an empty list. The symptom is "the module plays nothing", on a page where
 * the audio is plainly correct.
 *
 * Two things fix it, and both are needed:
 *
 * 1. **A common clock.** Each context's audio time is rebased onto page time using the wall-clock
 *    arrival of its first message. Intra-context spacing keeps the audio clock's exactness - which
 *    is why a worklet was used in the first place - while the contexts become comparable.
 * 2. **Merging by sample-and-hold.** `frames()` holds each context's latest reading and reports
 *    the per-tone maximum across all of them, so an idle context contributes nothing instead of
 *    erasing its neighbours. Bucketing by time instead is the obvious approach and is wrong - see
 *    `merge()`. `framesRaw()` still exposes the unmerged capture for debugging.
 *
 * ## Why the worklet install is asynchronous but `connect` is not
 *
 * `AudioWorklet.addModule()` returns a promise, and `connect()` is synchronous and may be called
 * during that window. The pass-through node is therefore created eagerly and wired to the real
 * destination immediately, so audio is never delayed or dropped; the worklet is attached whenever
 * it finishes loading.
 *
 * Plain ES2020, no imports: `addInitScript` evaluates this as a classic script in a page that has
 * no module graph yet. The tone table arrives as `__GO_PROBE_FREQUENCIES__` and the worklet source
 * as `__GO_PROBE_WORKLET_SOURCE__`, injected by `session.mjs`.
 */

(() => {
  const frequencies = window.__GO_PROBE_FREQUENCIES__ ?? [];
  const workletSource = window.__GO_PROBE_WORKLET_SOURCE__ ?? '';

  /** @type {Array<{t: number, rms: number, mags: number[], ctx: number}>} */
  let frames = [];
  /** Timeline origin, moved forward by `reset()` so a scenario's timeline starts at zero. */
  let originMs = 0;
  /** The most recent frame's raw timeline position, across all contexts. This *is* the clock. */
  let lastRawMs = 0;
  /** Page time when capture began, used only to report how fast the audio clock is running. */
  const wallStartMs = performance.now();
  /** @type {Map<number, number>} Context index -> offset that maps its audio clock to page time. */
  const clockOffsets = new Map();
  /** @type {WeakMap<BaseAudioContext, GainNode>} One tap per context. */
  const taps = new WeakMap();
  /** @type {Array<{state: string, error?: string}>} */
  const diagnostics = [];

  let nextContextIndex = 0;
  const originalConnect = AudioNode.prototype.connect;

  /**
   * Get (or lazily build) the tap node for a context.
   * @param {BaseAudioContext} context - The context whose destination is being connected to.
   * @returns {GainNode} A unity-gain pass-through already wired to the real destination.
   */
  function tapFor(context) {
    let tap = taps.get(context);
    if (tap) return tap;

    tap = context.createGain();
    tap.gain.value = 1;
    originalConnect.call(tap, context.destination);
    taps.set(context, tap);
    attachWorklet(context, tap, nextContextIndex++);
    return tap;
  }

  /**
   * Load the probe worklet into a context and attach it to that context's tap.
   * @param {BaseAudioContext} context - Context to instrument.
   * @param {GainNode} tap - The tap node to observe.
   * @param {number} index - This context's index, carried on every frame it produces.
   * @returns {void}
   */
  function attachWorklet(context, tap, index) {
    if (!context.audioWorklet) {
      diagnostics.push({ state: 'unsupported', error: 'AudioWorklet unavailable' });
      return;
    }
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    context.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(context, 'go-tone-probe', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          processorOptions: { frequencies }
        });
        node.port.onmessage = (event) => {
          // Rebase this context's audio clock onto page time, using the first message's arrival.
          // Only the *offset* comes from page time; the rate is the audio clock's own, which is
          // the point - see the note on non-realtime clocks in this file's header.
          if (!clockOffsets.has(index)) clockOffsets.set(index, performance.now() - event.data.t);
          const raw = event.data.t + clockOffsets.get(index);
          if (raw > lastRawMs) lastRawMs = raw;
          frames.push({ t: raw - originMs, rms: event.data.rms, mags: event.data.mags, ctx: index });
        };
        originalConnect.call(tap, node);
        diagnostics.push({ state: 'attached' });
      })
      .catch((error) => {
        diagnostics.push({ state: 'failed', error: String(error?.message ?? error) });
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  AudioNode.prototype.connect = function connect(destination, ...rest) {
    // Only destination connections are rerouted. Intermediate wiring is left exactly as the page
    // built it - the probe must not change the graph it is measuring.
    if (destination instanceof AudioDestinationNode) {
      return originalConnect.call(this, tapFor(destination.context), ...rest);
    }
    return originalConnect.call(this, destination, ...rest);
  };

  /**
   * Collapse the multi-context capture into one timeline.
   * @returns {Array<{t: number, rms: number, mags: number[]}>}
   */
  function merge() {
    // Sample-and-hold, not time-bucketing. Bucketing looks simpler and is wrong: the contexts run
    // on independent clocks, so a bucket often contains a frame from only *one* of them. When that
    // one happens to be an idle context, the bucket's max is zero - a hole punched in the middle of
    // a tone that never stopped. Downstream that reads as the track dropping out and coming back,
    // so `entryOrder()` reports the same track entering four times and every run-based analysis
    // fragments. Confirmed live.
    //
    // Holding each context's most recent reading and taking the max across all of them gives a
    // value that is correct at every instant, at the cost of carrying a reading up to one frame
    // (~43 ms) stale - which is below the resolution any assertion here relies on.
    const latest = new Map();
    const ordered = [...frames].sort((a, b) => a.t - b.t);
    const out = [];

    for (const frame of ordered) {
      latest.set(frame.ctx, frame);

      const mags = new Array(frequencies.length).fill(0);
      let rms = 0;
      for (const held of latest.values()) {
        rms = Math.max(rms, held.rms);
        for (let i = 0; i < mags.length; i++) mags[i] = Math.max(mags[i], held.mags[i] ?? 0);
      }
      out.push({ t: frame.t, rms, mags });
    }
    return out;
  }

  /**
   * The probe's page-side API, read by the Playwright harness through `page.evaluate`.
   */
  window.__goProbe = {
    /**
     * Drop captured frames and rebase the clock, so a spec's timeline starts at 0 at the moment
     * the scenario begins rather than at page load.
     * @returns {void}
     */
    reset() {
      // Move the origin to the current position **on the audio timeline**, not to
      // `performance.now()`. Those are not the same number when the audio clock is not running at
      // realtime, and mixing them is what put every measurement window on the wrong audio.
      originMs = lastRawMs || performance.now();
      frames = [];
    },

    /**
     * Wait until the capture timeline has advanced by `ms`.
     *
     * This replaces sleeping for `ms` of wall time, because the two are not interchangeable: on a
     * CI runner with a null audio sink the `AudioContext` renders **several times faster than
     * realtime** (measured between 2.3x and 5.6x, varying with load), so three seconds of waiting
     * captured twelve seconds of audio. Every window a spec computed then covered a quarter of the
     * material it meant to.
     *
     * Waiting on the timeline itself makes the suite indifferent to how fast the clock runs. The
     * wall-clock cap exists for the opposite failure - a starved or suspended context whose clock
     * barely advances - so that stalls surface as a clear error rather than a hang.
     * @param {number} ms - Timeline milliseconds to wait for.
     * @param {number} [maxWallMs] - Wall-clock budget before giving up.
     * @returns {Promise<void>}
     */
    async advance(ms, maxWallMs = ms * 4 + 20000) {
      const start = this.now();
      const wallStart = performance.now();
      // Both clocks, deliberately. The timeline governs how much audio is captured, but the module
      // is not purely audio-driven - debounces, the engine's scheduler and Foundry's own document
      // round-trips all run on wall time. Returning as soon as the (fast) audio clock has advanced
      // would hand back a long recording of a change the module had not finished making yet.
      // Waiting for both costs nothing on a normal machine, where the two are the same number.
      while (this.now() - start < ms || performance.now() - wallStart < ms) {
        if (performance.now() - wallStart > maxWallMs) {
          throw new Error(
            `audio clock advanced only ${Math.round(this.now() - start)}ms of the ${ms}ms requested ` +
              `in ${Math.round(performance.now() - wallStart)}ms of wall time - the AudioContext is stalled or suspended`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },

    /**
     * The current position on the capture timeline.
     * @returns {number} Milliseconds since the last `reset()`, on the audio clock.
     */
    now() {
      return lastRawMs - originMs;
    },

    /**
     * @returns {Array<{t: number, rms: number, mags: number[]}>} The merged, single-clock timeline.
     */
    frames() {
      return merge();
    },

    /**
     * @returns {Array<{t: number, rms: number, mags: number[], ctx: number}>} The unmerged capture,
     *   with each frame's originating context - for diagnosing the probe itself.
     */
    framesRaw() {
      return frames.map((f) => ({ t: f.t, rms: f.rms, mags: f.mags.slice(), ctx: f.ctx }));
    },

    /**
     * Whether the probe is actually measuring anything.
     *
     * Checked explicitly by the harness before the first assertion in a run: a probe that never
     * attached produces an empty timeline, and an empty timeline makes every "was silent" and "was
     * not audible" assertion pass. Failing loudly on no-frames is the difference between a suite
     * that validates audio and one that validates nothing while reporting green.
     * @returns {{attached: number, failed: number, frames: number, contexts: number, errors: string[]}}
     */
    status() {
      return {
        attached: diagnostics.filter((d) => d.state === 'attached').length,
        failed: diagnostics.filter((d) => d.state !== 'attached').length,
        frames: frames.length,
        contexts: nextContextIndex,
        // How fast the audio clock is running relative to wall time. 1.0 on a normal desktop;
        // ~4 on a CI runner whose null sink does not pace playback. Reported because it changes
        // what a timeline means, and because a suite that silently assumed 1.0 once failed
        // everywhere at once.
        clockRatio: Number((lastRawMs / Math.max(1, performance.now() - wallStartMs)).toFixed(2)),
        errors: diagnostics.filter((d) => d.error).map((d) => d.error)
      };
    }
  };
})();
