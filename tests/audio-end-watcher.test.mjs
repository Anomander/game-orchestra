import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { AudioEndWatcher } from '../scripts/audio-end-watcher.mjs';

describe('AudioEndWatcher', () => {
  let watcher;

  beforeEach(() => {
    setupFoundryMocks();
    watcher = new AudioEndWatcher();
  });

  it('calls onEnded when the track dispatches a native "end" event', () => {
    const track = createMockSound('t1', 'Track 1');
    const onEnded = vi.fn();

    watcher.watch(track, onEnded);
    track.sound.dispatchEvent(new Event('end'));

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onEnded on a "stop" event (manual stop is not natural completion)', () => {
    const track = createMockSound('t1', 'Track 1');
    const onEnded = vi.fn();

    watcher.watch(track, onEnded);
    track.sound.dispatchEvent(new Event('stop'));

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('only fires once per watch, even if "end" dispatches multiple times', () => {
    const track = createMockSound('t1', 'Track 1');
    const onEnded = vi.fn();

    watcher.watch(track, onEnded);
    track.sound.dispatchEvent(new Event('end'));
    track.sound.dispatchEvent(new Event('end'));

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('unwatch() prevents a later "end" event from calling onEnded', () => {
    const track = createMockSound('t1', 'Track 1');
    const onEnded = vi.fn();

    watcher.watch(track, onEnded);
    watcher.unwatch('t1');
    track.sound.dispatchEvent(new Event('end'));

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('the unwatch function returned by watch() also stops listening', () => {
    const track = createMockSound('t1', 'Track 1');
    const onEnded = vi.fn();

    const unwatch = watcher.watch(track, onEnded);
    unwatch();
    track.sound.dispatchEvent(new Event('end'));

    expect(onEnded).not.toHaveBeenCalled();
  });

  it('unwatchAll() stops every currently-watched track', () => {
    const trackA = createMockSound('a', 'Track A');
    const trackB = createMockSound('b', 'Track B');
    const onEndedA = vi.fn();
    const onEndedB = vi.fn();

    watcher.watch(trackA, onEndedA);
    watcher.watch(trackB, onEndedB);
    watcher.unwatchAll();

    trackA.sound.dispatchEvent(new Event('end'));
    trackB.sound.dispatchEvent(new Event('end'));

    expect(onEndedA).not.toHaveBeenCalled();
    expect(onEndedB).not.toHaveBeenCalled();
  });

  it('re-watching the same track id replaces the previous listener rather than double-firing', () => {
    const track = createMockSound('t1', 'Track 1');
    const first = vi.fn();
    const second = vi.fn();

    watcher.watch(track, first);
    watcher.watch(track, second);
    track.sound.dispatchEvent(new Event('end'));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('watching a track with no Sound instance logs and returns a no-op unwatch instead of throwing', () => {
    const track = { id: 'ghost', name: 'Ghost Track', sound: null };
    const onEnded = vi.fn();

    expect(() => {
      const unwatch = watcher.watch(track, onEnded);
      unwatch();
    }).not.toThrow();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it('independent tracks do not interfere with each other', () => {
    const trackA = createMockSound('a', 'Track A');
    const trackB = createMockSound('b', 'Track B');
    const onEndedA = vi.fn();
    const onEndedB = vi.fn();

    watcher.watch(trackA, onEndedA);
    watcher.watch(trackB, onEndedB);
    trackA.sound.dispatchEvent(new Event('end'));

    expect(onEndedA).toHaveBeenCalledTimes(1);
    expect(onEndedB).not.toHaveBeenCalled();
  });
});
