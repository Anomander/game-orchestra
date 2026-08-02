import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EngineClock } from '../scripts/engine-clock.mjs';

// The Web Worker global is unavailable under Vitest's node environment, so these
// tests always exercise EngineClock's setInterval fallback path - which is also
// the path real browsers fall back to when a strict CSP blocks blob: workers.
describe('EngineClock', () => {
  let clock;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = new EngineClock();
  });

  afterEach(() => {
    clock.destroy();
    vi.useRealTimers();
  });

  it('falls back to a main-thread interval when Worker is unavailable', () => {
    expect(clock._worker).toBeNull();
    expect(clock._interval).not.toBeNull();
  });

  it('fires a scheduled callback once its due time has passed', () => {
    const cb = vi.fn();
    clock.schedule('a', 1000, cb);

    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(600);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('never fires a callback more than once', () => {
    const cb = vi.fn();
    clock.schedule('a', 100, cb);

    vi.advanceTimersByTime(2000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('cancel() removes a pending item before it fires', () => {
    const cb = vi.fn();
    clock.schedule('a', 100, cb);
    clock.cancel('a');

    vi.advanceTimersByTime(2000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('cancelAll() removes every pending item', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    clock.schedule('a', 100, cb1);
    clock.schedule('b', 200, cb2);
    clock.cancelAll();

    vi.advanceTimersByTime(2000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('re-scheduling the same id replaces the previous entry rather than firing both', () => {
    const cb = vi.fn();
    clock.schedule('a', 100, cb);
    clock.schedule('a', 5000, cb);

    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(4500);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires multiple due items on the same tick without cumulative drift, ordered or not', () => {
    const order = [];
    clock.schedule('late', 900, () => order.push('late'));
    clock.schedule('early', 100, () => order.push('early'));

    vi.advanceTimersByTime(1000);
    expect(order).toEqual(['early', 'late']);
  });

  it('destroy() stops the ticker so no further callbacks fire', () => {
    const cb = vi.fn();
    clock.schedule('a', 1000, cb);
    clock.destroy();

    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing callback does not stop other due callbacks on the same tick from firing (regression: one bad callback used to silently swallow the rest)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const okBefore = vi.fn();
    const okAfter = vi.fn();
    clock.schedule('before', 100, okBefore);
    clock.schedule('throws', 100, () => {
      throw new Error('boom');
    });
    clock.schedule('after', 100, okAfter);

    // All three are due at the same time, so one ticker pass checks them all.
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();

    expect(okBefore).toHaveBeenCalledTimes(1);
    expect(okAfter).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('precise scheduling', () => {
    it('fires a precise entry on its own due time rather than waiting for the next tick', () => {
      const coarse = vi.fn();
      const precise = vi.fn();
      clock.schedule('coarse', 250, coarse);
      clock.schedule('precise', 250, precise, { precise: true });

      // 250ms is not a tick boundary: the coarse entry waits for the tick at
      // 300ms, the precise one lands on its own timer.
      vi.advanceTimersByTime(250);
      expect(precise).toHaveBeenCalledTimes(1);
      expect(coarse).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60);
      expect(coarse).toHaveBeenCalledTimes(1);
    });

    it('fires a precise entry exactly once, not again on the following tick', () => {
      const cb = vi.fn();
      clock.schedule('a', 250, cb, { precise: true });

      vi.advanceTimersByTime(2000);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('never fires a precise entry before its due time', () => {
      const cb = vi.fn();
      clock.schedule('a', 250, cb, { precise: true });

      vi.advanceTimersByTime(240);
      expect(cb).not.toHaveBeenCalled();
    });

    it('cancel() drops the companion timer too', () => {
      const cb = vi.fn();
      clock.schedule('a', 250, cb, { precise: true });
      clock.cancel('a');

      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();
      expect(clock._preciseTimers.size).toBe(0);
    });

    it('cancelAll() and destroy() drop companion timers too', () => {
      const cb = vi.fn();
      clock.schedule('a', 250, cb, { precise: true });
      clock.cancelAll();
      vi.advanceTimersByTime(2000);
      expect(cb).not.toHaveBeenCalled();

      const cb2 = vi.fn();
      clock.schedule('b', 250, cb2, { precise: true });
      clock.destroy();
      vi.advanceTimersByTime(2000);
      expect(cb2).not.toHaveBeenCalled();
      expect(clock._preciseTimers.size).toBe(0);
    });

    it('re-scheduling the same id replaces the companion timer rather than leaking it', () => {
      const first = vi.fn();
      const second = vi.fn();
      clock.schedule('a', 250, first, { precise: true });
      clock.schedule('a', 800, second, { precise: true });

      expect(clock._preciseTimers.size).toBe(1);
      vi.advanceTimersByTime(300);
      expect(first).not.toHaveBeenCalled();
      expect(second).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    });

    it('re-scheduling a precise id as coarse does not leave the old precise timer armed', () => {
      const first = vi.fn();
      const second = vi.fn();
      clock.schedule('a', 250, first, { precise: true });
      clock.schedule('a', 800, second);

      vi.advanceTimersByTime(2000);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('logs and swallows a throwing precise callback, exactly like a ticker-fired one', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      clock.schedule('a', 250, () => {
        throw new Error('boom');
      }, { precise: true });

      expect(() => vi.advanceTimersByTime(250)).not.toThrow();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });
});

describe('EngineClock (Worker path)', () => {
  let originalWorker;
  let originalBlob;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    originalBlob = globalThis.Blob;
    originalCreateObjectURL = globalThis.URL.createObjectURL;
    originalRevokeObjectURL = globalThis.URL.revokeObjectURL;

    globalThis.Blob = class {};
    globalThis.Worker = class {
      constructor(url) {
        this.url = url;
        this.onmessage = null;
      }
      terminate() {}
    };
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
    globalThis.Blob = originalBlob;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('revokes the blob URL immediately after creating the Worker (regression: every engine instance leaked one object URL for the page lifetime)', () => {
    const clock = new EngineClock();

    expect(clock._worker).not.toBeNull();
    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');

    clock.destroy();
  });
});
