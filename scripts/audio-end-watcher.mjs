import { log } from './helpers.mjs';

/**
 * Watches PlaylistSound tracks for natural playback completion.
 *
 * Foundry's `foundry.audio.Sound` class extends EventEmitterMixin and fires a
 * distinct 'end' event on natural completion versus 'stop' on a manual stop
 * (confirmed against the v14 API docs - emittedEvents defaults to
 * ["load", "play", "pause", "end", "stop"]). Only 'end' means "this track
 * finished on its own and the graph should advance" - a 'stop' (e.g. from the
 * engine's own teardown calling controller.stopTrack()) must never be mistaken
 * for that, so this class deliberately listens for 'end' only.
 *
 * The legacy Sound#on()/off()/emit() aliases are deprecated since v12 and
 * REMOVED entirely as of v14 (this module's target version, per module.json) -
 * only the standard addEventListener/removeEventListener form is used here.
 *
 * repeat:true tracks (loopCount > 1) are deliberately never watched here: it is
 * undocumented whether 'end' fires per-loop-iteration while native looping is
 * active (custom-playlist-plan.md H3). The engine advances looping tracks via
 * EngineClock's timed stop instead of this watcher, so that uncertainty never
 * matters in practice.
 */
export class AudioEndWatcher {
  constructor() {
    this._listeners = new Map(); // track.id -> { sound, handler }
  }

  /**
   * Watch a track for natural completion. Only call this for a track playing
   * with repeat === false; see the class doc for why looping tracks are excluded.
   * @param {object} track - PlaylistSound document (track.sound is the Sound instance).
   * @param {Function} onEnded - Called with no arguments when the track ends naturally.
   * @returns {Function} unwatch - Call to stop watching this track.
   */
  watch(track, onEnded) {
    const sound = track?.sound;
    if (!sound?.addEventListener) {
      log(2, `AudioEndWatcher: track '${track?.name}' has no watchable Sound instance; it will never auto-advance.`);
      return () => {};
    }
    // A stale watcher on the same track id would otherwise leak or double-fire.
    // Seeing this fire is a real signal, not routine bookkeeping: it means a
    // previous watch() on this exact track id never got the chance to clean
    // itself up via a natural 'end' event before a new one was requested -
    // e.g. two graph nodes sharing the same underlying sound handing off
    // faster than the first watcher could resolve.
    if (this._listeners.has(track.id)) {
      log(2, `AudioEndWatcher: replacing a still-attached 'end' listener on track '${track.id}' - the previous watch() never fired naturally.`);
    }
    this.unwatch(track.id);
    const handler = () => {
      sound.removeEventListener('end', handler);
      this._listeners.delete(track.id);
      onEnded();
    };
    sound.addEventListener('end', handler);
    this._listeners.set(track.id, { sound, handler });
    return () => this.unwatch(track.id);
  }

  /**
   * Stop watching a single track by its document id.
   * @param {string} trackId - PlaylistSound document id.
   */
  unwatch(trackId) {
    const entry = this._listeners.get(trackId);
    if (!entry) return;
    entry.sound.removeEventListener?.('end', entry.handler);
    this._listeners.delete(trackId);
  }

  /**
   * Stop watching every currently-watched track.
   */
  unwatchAll() {
    for (const trackId of [...this._listeners.keys()]) this.unwatch(trackId);
  }
}
