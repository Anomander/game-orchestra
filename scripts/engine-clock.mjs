import { log } from './helpers.mjs';

/**
 * Throttle-resistant scheduler for the custom playback engine (see
 * custom-playlist-plan.md H4). Browsers throttle main-thread setTimeout/setInterval
 * in backgrounded tabs to roughly once per minute, and the engine runs on the head
 * GM's client - a client that gets backgrounded constantly. Every wait the engine
 * schedules is therefore stored as an absolute due-timestamp and checked by a
 * dedicated Worker's ticker when available, since a dedicated Worker's timers are
 * not subject to the same background-tab throttling as the main thread.
 *
 * Because due-times are absolute (Date.now()-based) rather than relative delays,
 * even the setInterval fallback degrades gracefully: a throttled tick still fires
 * every due item whose time has passed, all at once and with no cumulative drift -
 * it just lands late rather than never.
 */

/**
 * Ticker cadence. Every scheduled item can therefore land up to this much late,
 * which is the floor on how tightly any wait the engine schedules can be timed.
 *
 * This was 500ms, which put 0-500ms of silence at every boundary the engine
 * times itself rather than reacting to an 'end' event: a loopCount > 1 track's
 * stop (_scheduleLoopStop) and an until-loop's loopEnd exit. It also made
 * _probeDuration's nominal "100ms cadence, ~2s cap" actually run at 500ms and
 * ~10s, since each retry waited for the next tick.
 *
 * A worker interval at this rate is negligible CPU (it posts one empty message
 * and the handler walks a Map that is nearly always empty or tiny), and for
 * anything needing tighter than one tick there is `precise` below.
 */
const TICK_MS = 100;

export class EngineClock {
  constructor() {
    this._due = new Map();
    // Companion setTimeout handles for `precise` entries, keyed the same way.
    this._preciseTimers = new Map();
    this._worker = null;
    this._interval = null;
    this._startTicker();
  }

  /**
   * Start the ticker that periodically checks for due entries, preferring a
   * dedicated Worker over a main-thread interval when the environment allows it.
   * @private
   */
  _startTicker() {
    const canUseWorker = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
    if (canUseWorker) {
      try {
        const blob = new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        this._worker = new Worker(url);
        // Safe to revoke immediately: the Worker has already opened its own
        // reference to the blob by this point, and nothing else needs the URL.
        // Without this, every engine instance (a fresh one per custom-playlist
        // transition) leaked one object URL and its backing blob for the
        // page's lifetime.
        URL.revokeObjectURL(url);
        this._worker.onmessage = () => this._check();
        return;
      } catch (error) {
        // Worker construction can fail even when the API exists (e.g. a strict CSP
        // blocking blob: workers). Fall through to the main-thread interval below.
        this._worker = null;
      }
    }
    this._interval = setInterval(() => this._check(), TICK_MS);
  }

  /**
   * Schedule a one-shot callback at an absolute due time.
   * @param {string} id - Unique identifier for this scheduled item; re-scheduling the same id replaces it.
   * @param {number} delayMs - Milliseconds from now until the callback should fire.
   * @param {Function} cb - Callback invoked with no arguments when due.
   * @param {object} [options]
   * @param {boolean} [options.precise] - Also arm a main-thread setTimeout for this exact
   *   delay, so the callback lands within normal timer jitter instead of waiting for the
   *   next TICK_MS tick. First of the two to fire wins; the other finds the entry already
   *   gone. Use for a boundary a listener can HEAR being missed - the stop that ends a
   *   looping track, an until-loop's loopEnd exit - not for routine polling.
   *
   *   This does not reintroduce the background-tab problem H4 describes: a throttled
   *   setTimeout simply fires late and loses the race to the worker tick, which is
   *   unaffected. The precise timer can only ever make an entry land sooner (and never
   *   sooner than its due time), never later.
   */
  schedule(id, delayMs, cb, { precise = false } = {}) {
    const wait = Math.max(0, delayMs);
    this._clearPreciseTimer(id);
    this._due.set(id, { at: Date.now() + wait, cb });
    if (!precise) return;
    const handle = setTimeout(() => {
      this._preciseTimers.delete(id);
      this._fire(id);
    }, wait);
    this._preciseTimers.set(id, handle);
  }

  /**
   * Cancel a single scheduled item by id, if pending.
   * @param {string} id - Identifier previously passed to schedule().
   */
  cancel(id) {
    this._clearPreciseTimer(id);
    this._due.delete(id);
  }

  /**
   * Cancel every pending scheduled item.
   */
  cancelAll() {
    for (const id of [...this._preciseTimers.keys()]) this._clearPreciseTimer(id);
    this._due.clear();
  }

  /**
   * Drop the companion setTimeout for an id, if it has one.
   * @param {string} id
   * @private
   */
  _clearPreciseTimer(id) {
    const handle = this._preciseTimers.get(id);
    if (handle === undefined) return;
    clearTimeout(handle);
    this._preciseTimers.delete(id);
  }

  /**
   * Fire one due entry and retire it. Whichever of the ticker or a `precise`
   * timer gets here first removes the entry, so the loser is a no-op rather
   * than a second invocation.
   * @param {string} id
   * @private
   */
  _fire(id) {
    const entry = this._due.get(id);
    if (!entry) return;
    this._due.delete(id);
    this._clearPreciseTimer(id);
    try {
      entry.cb();
    } catch (error) {
      // A throwing callback must not stop the rest of this tick's due entries
      // from firing - this is the one component the whole playback engine
      // depends on for timing, so one bad callback shouldn't stall every other
      // scheduled node.
      log(1, `EngineClock: scheduled callback '${id}' threw`, error);
    }
  }

  /**
   * Check all pending entries against the current time and fire any that are due.
   * @private
   */
  _check() {
    const now = Date.now();
    for (const [id, entry] of [...this._due]) {
      if (now >= entry.at) this._fire(id);
    }
  }

  /**
   * Stop the ticker and discard all pending entries. Call when the engine is torn down.
   */
  destroy() {
    this._worker?.terminate();
    if (this._interval) clearInterval(this._interval);
    for (const id of [...this._preciseTimers.keys()]) this._clearPreciseTimer(id);
    this._due.clear();
  }
}
