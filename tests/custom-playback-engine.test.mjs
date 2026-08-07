import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { CustomPlaybackEngine } from '../scripts/custom-playback-engine.mjs';

/**
 * Simulate a track finishing naturally: flips playing flags off, then fires 'end'.
 *
 * Awaitable, because advancing is not synchronous with the event: the engine
 * hops the token through one or more awaited walks before the next track is
 * actually playing. Draining microtasks (rather than a setTimeout) keeps this
 * usable from the tests that run under fake timers, since it never needs a
 * clock to advance.
 *
 * It also models Foundry's OWN reaction to a natural end - Playlist#_onSoundEnd
 * writing the document flags - because the engine now relies on that instead of
 * issuing a duplicate stopSound() of its own.
 */
async function fireEnd(sound) {
  sound.sound.playing = false;
  // Foundry's own listener (registered in PlaylistSound#_createSound, so always
  // BEFORE AudioEndWatcher's) runs Playlist#_onSoundEnd first and writes the
  // document flags. Modeling that ordering is the whole point of this helper -
  // the engine now relies on it instead of issuing a duplicate stopSound().
  sound.parent?._onSoundEnd?.(sound);
  sound.playing = false;
  sound.sound.dispatchEvent(new Event('end'));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * The crossfade-out calls on a sound: `fade(0, {duration > 0})`. Deliberately narrower than
 * "fade was called at all" - the engine also levels every track it starts to its mixed volume
 * (_assertMixedVolume), which is a `fade(volume, {duration: 0})` on the SAME spy and would
 * otherwise read as a crossfade that never happened.
 */
const crossfadeOutCalls = (sound) =>
  sound.sound.fade.mock.calls.filter(([volume, options]) => volume === 0 && (options?.duration ?? 0) > 0);

function createFakeController() {
  return {
    _managedSoundIds: new Set(),
    playTrack: vi.fn(async (sound) => {
      sound.playing = true;
      sound.sound.playing = true;
    }),
    stopTrack: vi.fn((sound) => {
      sound.playing = false;
      sound.sound.playing = false;
    }),
    cancelPendingFadeOut: vi.fn(() => false)
  };
}

describe('CustomPlaybackEngine', () => {
  let controller;

  beforeEach(() => {
    setupFoundryMocks();
    controller = createFakeController();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('execution tracing (debug logs)', () => {
    it('logs every transition when debug logging is enabled', async () => {
      setMockSetting('game-orchestra', 'enableDebug', true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 'end' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      const lines = logSpy.mock.calls.map((args) => args.join(' '));
      expect(lines.some((l) => l.includes("run") && l.includes("starting for playlist 'Graph'"))).toBe(true);
      expect(lines.some((l) => l.includes("entered node 'start' (start)"))).toBe(true);
      expect(lines.some((l) => l.includes("'start' -> 't1' (single exit)"))).toBe(true);
      expect(lines.some((l) => l.includes("entered node 't1' (track)"))).toBe(true);
      expect(lines.some((l) => l.includes("track 't1' started sound 's1'"))).toBe(true);

      logSpy.mockRestore();
    });

    it('logs nothing when debug logging is disabled (the default)', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('logs a Random pick and a Fork spawn', async () => {
      setMockSetting('game-orchestra', 'enableDebug', true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'rand', type: 'random' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'rand' },
          { id: 'e3', from: 'fork', to: 'tb' },
          { id: 'e4', from: 'rand', to: 'ta', weight: 1 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      engine._rng = () => 0.1;
      await engine.start();

      const lines = logSpy.mock.calls.map((args) => args.join(' '));
      expect(lines.some((l) => l.includes("fork 'fork' spawning 2 branch(es): rand, tb"))).toBe(true);
      expect(lines.some((l) => l.includes("random 'rand' -> 'ta'"))).toBe(true);

      logSpy.mockRestore();
    });
  });

  it('does nothing if the current user is not the head GM', async () => {
    game.user = { id: 'player1', isGM: false, active: true };
    game.users = [{ id: 'gm1', isGM: true, active: false }, game.user];

    const s1 = createMockSound('s1', 'Track 1');
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(controller.playTrack).not.toHaveBeenCalled();
  });

  it('plays Start -> Track(loop 1) -> End once and then stays silent', async () => {
    const s1 = createMockSound('s1', 'Track 1');
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [
        { id: 'start', type: 'start' },
        { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
        { id: 'end', type: 'end' }
      ],
      edges: [
        { id: 'e1', from: 'start', to: 't1' },
        { id: 'e2', from: 't1', to: 'end' }
      ]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(controller.playTrack).toHaveBeenCalledTimes(1);
    expect(controller.playTrack).toHaveBeenCalledWith(s1);
    expect(engine.activeSounds).toEqual([s1]);

    await fireEnd(s1);

    expect(engine.activeSounds).toEqual([]);
    // No further plays after End - and firing 'end' again must not throw or replay.
    await fireEnd(s1); // firing 'end' again must not replay or throw
    expect(controller.playTrack).toHaveBeenCalledTimes(1);
  });

  it('forces pausedTime to 0 on a fresh (non-adopted) play (H6: graphs restart, never resume)', async () => {
    const s1 = createMockSound('s1', 'Track 1', { pausedTime: 45 });
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(s1.update).toHaveBeenCalledWith(expect.objectContaining({ pausedTime: 0 }));
  });

  it('loops a track back to itself the configured number of times before advancing', async () => {
    const sA = createMockSound('sa', 'Track A');
    const sB = createMockSound('sb', 'Track B');
    const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 3 } },
        { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'ta' },
        { id: 'e2', from: 'ta', to: 'tb' },
        { id: 'e3', from: 'tb', to: 'ta' }
      ]
    });

    // loopCount > 1 tracks advance via a timed stop (native repeat), not the
    // end-event watcher (H3) - give the mock sound a known duration up front.
    sA.sound.duration = 2;
    sA.sound.loaded = true;

    vi.useFakeTimers();
    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(controller.playTrack).toHaveBeenCalledTimes(1);
    expect(sA.update).toHaveBeenCalledWith(expect.objectContaining({ repeat: true }));

    // 3 loops * 2s duration = 6000ms before the engine stops A and advances to B.
    await vi.advanceTimersByTimeAsync(6000);

    expect(controller.stopTrack).toHaveBeenCalledWith(sA);
    expect(controller.playTrack).toHaveBeenCalledTimes(2);
    expect(controller.playTrack).toHaveBeenLastCalledWith(sB);

    await fireEnd(sB);
    // Loop-back to A: a fresh (non-adopted) play, since B stopped A cleanly earlier.
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.playTrack).toHaveBeenCalledTimes(3);
    expect(controller.playTrack).toHaveBeenLastCalledWith(sA);
  });

  it('retries probing for duration until the sound reports loaded (probe/retry path)', async () => {
    const sA = createMockSound('sa', 'Track A');
    const playlist = createMockPlaylist('pl1', 'Graph', [sA], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 2 } }],
      edges: [{ id: 'e1', from: 'start', to: 'ta' }]
    });

    sA.sound.loaded = false; // not ready yet
    sA.sound.duration = 0;

    vi.useFakeTimers();
    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    // Still not loaded - advance a bit (less than one EngineClock tick); must
    // not have stopped yet regardless.
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.stopTrack).not.toHaveBeenCalled();

    // Now it becomes ready. Give enough time for the next ~500ms tick to pick
    // it up via the probe, then for the 2 * 1s loop duration to elapse.
    sA.sound.loaded = true;
    sA.sound.duration = 1;
    await vi.advanceTimersByTimeAsync(3000);
    expect(controller.stopTrack).toHaveBeenCalledWith(sA);
  });

  it('gives up probing for duration after the retry cap instead of polling forever, and advances the graph', async () => {
    const sA = createMockSound('sa', 'Track A');
    const sB = createMockSound('sb', 'Track B');
    const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 2 } },
        { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'ta' },
        { id: 'e2', from: 'ta', to: 'tb' }
      ]
    });

    // Simulates a track that fails to load (missing file, network error,
    // decode failure): duration is never reported.
    sA.sound.loaded = false;
    sA.sound.duration = 0;

    setMockSetting('game-orchestra', 'enableDebug', true); // log(2, ...) is gated on this setting
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    // EngineClock falls back to a 500ms-interval ticker in this test environment
    // (no Worker global in Node), so each retry is only picked up once per tick
    // rather than at the probe's intended 100ms cadence - the 20-attempt cap is
    // reached after ~19 ticks (~9500ms), not ~2000ms.
    await vi.advanceTimersByTimeAsync(10000);

    expect(controller.stopTrack).toHaveBeenCalledWith(sA);
    expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    const warnLines = logSpy.mock.calls.map((args) => args.join(' '));
    expect(warnLines.some((l) => l.includes('never reported a usable duration'))).toBe(true);

    // No further probe timers should remain scheduled for the abandoned node.
    controller.stopTrack.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(controller.stopTrack).not.toHaveBeenCalledWith(sA);

    logSpy.mockRestore();
  });

  describe("loop.mode 'until'", () => {
    it('immediate boundary: does not exit before the minLoops floor even when the condition is already true on entry', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      // game.combat is unset by default, so combatIdle is already true at entry -
      // without a real minLoops floor this would exit with a zero-length loop.
      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(sA.update).toHaveBeenCalledWith(expect.objectContaining({ repeat: true }));

      // Floor is minLoops(1) * duration(1s) = 1000ms - not reached yet at 500ms.
      await vi.advanceTimersByTimeAsync(500);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      // Past the floor, with the condition already true: exits on the next poll tick.
      await vi.advanceTimersByTimeAsync(500);
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it('immediate boundary: waits for the condition to become true after the minLoops floor has passed', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      game.combat = { started: true }; // combatIdle is false until combat ends
      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Past the floor (1000ms) but the condition is still false.
      await vi.advanceTimersByTimeAsync(1500);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      game.combat.started = false; // combat ends - condition becomes true
      await vi.advanceTimersByTimeAsync(500); // next poll tick
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it("boundary 'loopEnd': a condition matched mid-loop only takes effect at the next clean loop boundary", async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'loopEnd', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      game.combat = { started: true }; // combatIdle false
      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // First boundary check is at 1000ms (minLoops=1); condition still false there.
      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      // Condition becomes true mid-way through loop 2 (well before its 2000ms boundary).
      await vi.advanceTimersByTimeAsync(300);
      game.combat.started = false;

      // Still mid-loop: must not cut off before the boundary even though the
      // condition is already true.
      await vi.advanceTimersByTimeAsync(500);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      // The loop-2 boundary (2000ms total) is where the exit actually lands.
      await vi.advanceTimersByTimeAsync(200);
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it('immediate boundary: maxLoops forces an exit even when the condition never matches', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatActive' }, boundary: 'immediate', minLoops: 1, maxLoops: 2 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      // combatActive stays false forever (game.combat is never set), so the
      // only way out is the maxLoops cap: 2 loops * 1s duration = 2000ms.
      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(1500);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it("immediate boundary: moodChanged waits for the mood to differ from this loop's own start baseline, not the run's", async () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'moodChanged' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Past the floor (1000ms) but the mood is still 'calm' - unchanged from loop start.
      await vi.advanceTimersByTimeAsync(1500);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      setMockSetting('game-orchestra', 'activeMood', 'boss'); // mood changes
      await vi.advanceTimersByTimeAsync(500); // next poll tick
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it("boundary 'loopEnd': maxLoops forces an exit at the maxLoops-th boundary when the condition never matches", async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatActive' }, boundary: 'loopEnd', minLoops: 1, maxLoops: 2 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      sA.sound.duration = 1;
      sA.sound.loaded = true;

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Boundary 1 (1000ms): condition false, loopIndex(1) < maxLoops(2) - continues.
      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.stopTrack).not.toHaveBeenCalled();

      // Boundary 2 (2000ms): condition still false, but loopIndex(2) >= maxLoops(2) - exits.
      await vi.advanceTimersByTimeAsync(1000);
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
    });

    it('immediate boundary: a duration probe that never resolves degrades to unrestricted polling instead of hanging forever', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 3, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      // Never reports a usable duration (missing file / decode failure).
      sA.sound.loaded = false;
      sA.sound.duration = 0;

      setMockSetting('game-orchestra', 'enableDebug', true);
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Same ~19-tick (~9500ms) cap as the fixed-count probe give-up path -
      // after that, minLoops/maxLoops are dropped and the (already-true)
      // condition is picked up on the very next poll.
      await vi.advanceTimersByTimeAsync(10000);

      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
      const warnLines = logSpy.mock.calls.map((args) => args.join(' '));
      expect(warnLines.some((l) => l.includes('ignoring minLoops/maxLoops and polling its loop-until condition from now'))).toBe(true);

      logSpy.mockRestore();
    });

    it("boundary 'loopEnd': a duration probe that never resolves falls back to immediate boundary checking", async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'loopEnd', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      sA.sound.loaded = false;
      sA.sound.duration = 0;

      setMockSetting('game-orchestra', 'enableDebug', true);
      vi.useFakeTimers();
      const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(10000);

      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
      const warnLines = logSpy.mock.calls.map((args) => args.join(' '));
      expect(warnLines.some((l) => l.includes('falling back to immediate boundary checking'))).toBe(true);

      logSpy.mockRestore();
    });
  });

  it('singleton: a second token entering an already-active track node is dropped, not double-played', async () => {
    const s1 = createMockSound('s1', 'Track 1');
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();
    expect(controller.playTrack).toHaveBeenCalledTimes(1);

    // A second token racing into the same still-active node (as would happen via
    // a Fork branch converging on this Track once Phase 3 adds Fork) must be
    // absorbed rather than restarting playback.
    engine._enterNode('t1', 0);
    await Promise.resolve();

    expect(controller.playTrack).toHaveBeenCalledTimes(1);
  });

  it('adopts an already-playing track instead of restarting it', async () => {
    const s1 = createMockSound('s1', 'Track 1', { playing: true });
    s1.sound.playing = true;
    s1.sound.currentTime = 12;
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(controller.playTrack).not.toHaveBeenCalled();
    expect(s1.update).not.toHaveBeenCalled();
    expect(engine.activeSounds).toEqual([s1]);
  });

  it('takes an adopted track off any fade-out scheduled to stop it', async () => {
    // `playing` stays true for the whole of a fade-out, so the adoption branch cannot tell a live
    // track from one on its way to silence. Restarting a layer inside the crossfade window is
    // exactly that, and without the cancel the fade lands and this node is left holding a token on
    // dead audio, waiting for an 'end' that a 'stop' never sends.
    const s1 = createMockSound('s1', 'Track 1', { playing: true });
    s1.sound.playing = true;
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    expect(controller.cancelPendingFadeOut).toHaveBeenCalledWith(s1);
  });

  it('stop({stopAudio:false}) leaves active sounds playing; stop() (default) stops them', async () => {
    const s1 = createMockSound('s1', 'Track 1');
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    engine.stop({ stopAudio: false });
    expect(controller.stopTrack).not.toHaveBeenCalled();

    const engine2 = new CustomPlaybackEngine({ playlist }, controller);
    s1.playing = false;
    s1.sound.playing = false;
    await engine2.start();
    engine2.stop();
    expect(controller.stopTrack).toHaveBeenCalledWith(s1);
  });

  it('a stale end-event firing after stop() does not re-trigger advancement', async () => {
    const sA = createMockSound('sa', 'Track A');
    const sB = createMockSound('sb', 'Track B');
    const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
        { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
      ],
      edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();
    engine.stop();

    await fireEnd(sA);

    expect(controller.playTrack).toHaveBeenCalledTimes(1); // only the initial play of A
  });

  it('aborts an all-instantaneous cycle instead of recursing forever (instantaneous-cycle guard)', async () => {
    const playlist = createMockPlaylist('pl1', 'Graph', [], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }],
      edges: [{ id: 'e1', from: 'start', to: 'start' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await expect(engine.start()).resolves.toBeUndefined();
  });

  it('a dangling exit (no outgoing edge) silently ends the token without error', async () => {
    const s1 = createMockSound('s1', 'Track 1');
    const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
    playlist.setFlag('game-orchestra', 'customPlayback', {
      version: 1,
      nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
      edges: [{ id: 'e1', from: 'start', to: 't1' }]
    });

    const engine = new CustomPlaybackEngine({ playlist }, controller);
    await engine.start();

    await fireEnd(s1); // firing 'end' again must not replay or throw
    expect(engine.activeSounds).toEqual([]);
  });

  describe('rapid-restart-loop safety net (a Track whose exit points back to itself, or a tight multi-node cycle of short tracks)', () => {
    it('throttles a self-looping Track so it cannot restart faster than the minimum interval', async () => {
      const s1 = createMockSound('s1', 'Very Short Clip');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(controller.playTrack).toHaveBeenCalledTimes(1);

      // Simulate a pathologically short clip: it "ends" almost immediately.
      // Without the throttle this would restart synchronously/near-instantly,
      // over and over, exactly the pattern that hung the browser tab.
      await fireEnd(s1);
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.playTrack).toHaveBeenCalledTimes(1); // NOT yet - held by the throttle

      // The throttle wait is scheduled `precise`, so it lands on its own 300ms
      // rather than being rounded up to the next ticker interval - that
      // rounding was silence a listener heard at every hand-off. Just under
      // the floor must still be throttled...
      await vi.advanceTimersByTimeAsync(290);
      expect(controller.playTrack).toHaveBeenCalledTimes(1);

      // ...and crossing the floor itself releases it, without waiting for a tick.
      await vi.advanceTimersByTimeAsync(15);
      expect(controller.playTrack).toHaveBeenCalledTimes(2);
    });

    it('does not throttle the very first play of a node (only repeat restarts)', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledTimes(1);
    });

    it('does not throttle a restart that already waited long enough', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // A normal-length track that plays for well over the throttle floor
      // before ending should restart immediately, not wait again.
      await vi.advanceTimersByTimeAsync(5000);
      await fireEnd(s1);
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.playTrack).toHaveBeenCalledTimes(2);
    });

    it('a stale (stopped) engine does not resume a throttled restart', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      await fireEnd(s1);
      await vi.advanceTimersByTimeAsync(0);

      engine.stop();
      await vi.advanceTimersByTimeAsync(1000);

      expect(controller.playTrack).toHaveBeenCalledTimes(1); // throttled restart never resumed after stop()
    });
  });

  describe('circuit breaker (protects the tab if something generates far more restarts than the per-node throttle can bound, e.g. a leaked duplicate end listener)', () => {
    it('stops the engine if a Track node is entered abnormally often within the breaker window', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      const node = engine.graph.nodes.find((n) => n.id === 't1');

      // Simulate a runaway: far more entries than any legitimate throttle-bound
      // restart rate could produce in this window (a self-loop can restart at
      // most a few times per second, capped by the 300ms throttle).
      for (let i = 0; i < 20; i++) engine._enterTrack(node);

      expect(engine._runId).toBe(-1); // stop() was called
      expect(engine._activeNodes.size).toBe(0);
    });

    it('does not trip for an ordinary handful of restarts', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(510); // clear the throttle + EngineClock's fallback tick
        await fireEnd(s1);
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(engine._runId).not.toBe(-1); // still running - this is normal playback, not a runaway
      expect(controller.playTrack).toHaveBeenCalledTimes(6);
    });
  });

  describe('isRunning (MusicController#transitionToContext uses this to avoid restarting an already-playing graph)', () => {
    it('is true once start() has run and false once stop() has run', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(engine.isRunning).toBe(true);

      await engine.stop();
      expect(engine.isRunning).toBe(false);
    });
  });

  describe('silently-aborted playTrack (Foundry can reject an overlapping play with no visible error)', () => {
    it('retries when playTrack() resolves without the sound actually starting', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      // MusicController.playTrack() deliberately swallows AbortError/"interrupted"
      // with no error surfaced - simulate that exact case: the call resolves, but
      // the sound never actually started.
      let callCount = 0;
      controller.playTrack = vi.fn(async (sound) => {
        callCount++;
        if (callCount === 1) return;
        sound.playing = true;
        sound.sound.playing = true;
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      const startPromise = engine.start();
      await vi.advanceTimersByTimeAsync(1000);
      await startPromise;

      expect(controller.playTrack).toHaveBeenCalledTimes(2);
      expect(engine.activeSounds).toEqual([s1]);
    });
  });

  describe('stale document-level playing flag (only the live Sound is trustworthy once it exists)', () => {
    it('does a real clean start rather than silently "adopting" when the document flag disagrees with the live Sound', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      // The document-level field never gets corrected back to false after a
      // natural end (confirmed live), while the live Sound correctly reports
      // it has stopped. Trusting the stale document field here meant this
      // node would "adopt" a track that isn't actually playing, forever.
      s1.playing = true;
      s1.sound.playing = false;
      // A real resume offset left over from a previous context. Graphs always
      // restart from the beginning (H9), so a clean start has to clear it -
      // and having one here is what makes the update observable at all, since
      // the engine now skips an update that would change nothing.
      s1.pausedTime = 12;

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(s1.update).toHaveBeenCalledWith(expect.objectContaining({ pausedTime: 0 }));
      expect(controller.playTrack).toHaveBeenCalledTimes(1);
    });

    it('leaves a null pausedTime alone - Foundry already reads it as "start from the beginning"', async () => {
      // Playlist#stopSound writes `pausedTime: null`, and PlaylistSound#sync
      // reads a falsy pausedTime as no offset. Writing 0 over it changes
      // nothing and costs a full document round-trip in the middle of a
      // hand-off (measured live at ~30ms, half the audible gap).
      const s1 = createMockSound('s1', 'Track 1');
      s1.pausedTime = null;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(s1.update).not.toHaveBeenCalled();
      expect(controller.playTrack).toHaveBeenCalledWith(s1);
    });
  });

  describe('stop() awaits its own teardown (closes a race with a replacement engine started right after)', () => {
    it('does not resolve until controller.stopTrack() has actually resolved', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      let resolveStopTrack;
      controller.stopTrack = vi.fn(
        (sound) =>
          new Promise((resolve) => {
            resolveStopTrack = () => {
              // Mirrors what a real Foundry stopSound() call eventually does -
              // this is the state a caller starting a new engine right after
              // stop() resolves is depending on having already happened.
              sound.playing = false;
              sound.sound.playing = false;
              resolve();
            };
          })
      );

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(engine.activeSounds).toEqual([s1]);

      let stopResolved = false;
      const stopPromise = engine.stop({ stopAudio: true }).then(() => {
        stopResolved = true;
      });

      await Promise.resolve(); // let pending microtasks settle
      expect(stopResolved).toBe(false); // stopTrack's own promise hasn't resolved yet

      // This engine's OWN bookkeeping clears immediately regardless (it's not
      // part of the race - a replacement engine gets entirely separate maps).
      expect(engine._activeNodes.size).toBe(0);

      resolveStopTrack();
      await stopPromise;
      expect(stopResolved).toBe(true);
      expect(s1.sound.playing).toBe(false);
    });
  });

  describe('shared-sound Track nodes (two different graph nodes referencing the same soundId - a resource collision, not two independent plays)', () => {
    it('only one of two concurrently-reachable Track nodes actually drives a shared sound', async () => {
      const s1 = createMockSound('s1', 'Shared Track');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'a', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'b', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'a' },
          { id: 'e3', from: 'fork', to: 'b' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Without the ownership guard, both branches would find the sound
      // "already playing" moments apart and both adopt it - this is exactly
      // the collision that orphaned a node and flooded restarts live.
      expect(controller.playTrack).toHaveBeenCalledTimes(1);
      expect(engine._activeNodes.size).toBe(1);
    });

    it('releases sound ownership when the owning node naturally ends, instead of orphaning it', async () => {
      const s1 = createMockSound('s1', 'Shared Track');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'a', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'b', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'a' },
          { id: 'e3', from: 'fork', to: 'b' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(engine._activeSoundOwners.get('s1')).toBeDefined();

      await fireEnd(s1);

      expect(engine._activeSoundOwners.has('s1')).toBe(false);
      expect(engine._activeNodes.size).toBe(0);
    });
  });

  describe('infinite Track (loops forever via native repeat, no exit)', () => {
    it('plays with repeat:true and never advances, even after a natural end event', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(s1.update).toHaveBeenCalledWith(expect.objectContaining({ repeat: true }));
      expect(controller.playTrack).toHaveBeenCalledTimes(1);
      expect(engine.activeSounds).toEqual([s1]);

      // An infinite Track is never watched for 'end' (native repeat, and there
      // is no exit to advance to) - firing it anyway must be a harmless no-op.
      await fireEnd(s1);
      expect(controller.playTrack).toHaveBeenCalledTimes(1);
      expect(engine.activeSounds).toEqual([s1]);
    });

    it('stops the sound on engine teardown like any other active node', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      engine.stop();

      expect(controller.stopTrack).toHaveBeenCalledWith(s1);
    });
  });

  describe('Fork', () => {
    it('spawns a token on every exit at once, so two branches play simultaneously', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'ta' },
          { id: 'e3', from: 'fork', to: 'tb' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenCalledWith(sB);
      expect(engine.activeSounds).toEqual(expect.arrayContaining([sA, sB]));
    });

    it('two Fork branches converging on the same Track are merged by the singleton rule, not double-played', async () => {
      const sShared = createMockSound('shared', 'Shared Track');
      const playlist = createMockPlaylist('pl1', 'Graph', [sShared], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'shared', type: 'track', soundId: 'shared', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'shared' },
          { id: 'e3', from: 'fork', to: 'shared' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledTimes(1);
      expect(engine.activeSounds).toEqual([sShared]);
    });

    it('stopping the engine stops every branch spawned by a Fork', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'ta' },
          { id: 'e3', from: 'fork', to: 'tb' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      engine.stop();

      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.stopTrack).toHaveBeenCalledWith(sB);
    });
  });

  describe('Delay', () => {
    it('waits within the configured min-max range before following its exit', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'delay', type: 'delay', delay: { min: 2, max: 4 } },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'delay' }, { id: 'e2', from: 'delay', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      engine._rng = () => 0.5; // deterministic: picks the midpoint, 3s
      await engine.start();

      expect(controller.playTrack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(2900);
      expect(controller.playTrack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(500);
      expect(controller.playTrack).toHaveBeenCalledWith(s1);
    });

    it('is subject to the singleton rule like Track', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'delay', type: 'delay', delay: { min: 1, max: 1 } }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 'delay' }, { id: 'e2', from: 'delay', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      engine._enterNode('delay', 0); // a second token racing into the same active delay

      await vi.advanceTimersByTimeAsync(1000);
      expect(controller.playTrack).toHaveBeenCalledTimes(1);
    });

    it('a pending delay is cancelled by stop() and never fires its exit', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'delay', type: 'delay', delay: { min: 5, max: 5 } }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 'delay' }, { id: 'e2', from: 'delay', to: 't1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      engine.stop();

      await vi.advanceTimersByTimeAsync(6000);
      expect(controller.playTrack).not.toHaveBeenCalled();
    });
  });

  describe('Random', () => {
    function buildRandomGraph(edgesExtra) {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rand', type: 'random' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'rand' }, ...edgesExtra]
      });
      return { playlist, sA, sB };
    }

    it('follows exactly one exit, chosen by weight', async () => {
      const { playlist, sA, sB } = buildRandomGraph([
        { id: 'ea', from: 'rand', to: 'ta', weight: 1 },
        { id: 'eb', from: 'rand', to: 'tb', weight: 1 }
      ]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      engine._rng = () => 0.9; // rolls into the second candidate's weight share
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledTimes(1);
      expect(controller.playTrack).toHaveBeenCalledWith(sB);
      expect(controller.playTrack).not.toHaveBeenCalledWith(sA);
    });

    it('a lower rng roll picks the earlier-weighted edge', async () => {
      const { playlist, sA } = buildRandomGraph([
        { id: 'ea', from: 'rand', to: 'ta', weight: 1 },
        { id: 'eb', from: 'rand', to: 'tb', weight: 1 }
      ]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      engine._rng = () => 0.1;
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('picks uniformly at random (not always the last candidate) when every exit is weighted 0 (regression: all-zero weights always fell through to the last candidate)', async () => {
      const { playlist, sA, sB } = buildRandomGraph([
        { id: 'ea', from: 'rand', to: 'ta', weight: 0 },
        { id: 'eb', from: 'rand', to: 'tb', weight: 0 }
      ]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      // A low roll should land on the FIRST candidate under uniform selection -
      // the pre-fix weighted-draw fallthrough would have picked the last
      // candidate (Track B) regardless of the roll.
      engine._rng = () => 0.1;
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).not.toHaveBeenCalledWith(sB);
    });

    it('respects cooldown by excluding a recently-picked edge from the next draw', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rand', type: 'random' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'rand' },
          { id: 'ea', from: 'rand', to: 'ta', weight: 1, cooldown: 1 },
          { id: 'eb', from: 'rand', to: 'tb', weight: 1, cooldown: 1 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      // First draw: force edge 'ea' (Track A) to be chosen.
      engine._rng = () => 0.1;
      await engine._enterRandom(playlist.getFlag('game-orchestra', 'customPlayback').nodes[1], 0);
      expect(controller.playTrack).toHaveBeenCalledWith(sA);

      // Second draw: even with an rng roll that would normally pick 'ea' again,
      // cooldown:1 excludes it (it was *the* most recent pick), forcing 'eb'.
      controller.playTrack.mockClear();
      engine._rng = () => 0.1;
      await engine._enterRandom(playlist.getFlag('game-orchestra', 'customPlayback').nodes[1], 0);
      expect(controller.playTrack).toHaveBeenCalledWith(sB);
      expect(controller.playTrack).not.toHaveBeenCalledWith(sA);
    });

    it('ignores cooldowns rather than deadlocking when every edge is currently cooling down', async () => {
      const sA = createMockSound('sa', 'Track A');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'rand', type: 'random' }, { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } }],
        edges: [
          { id: 'e1', from: 'start', to: 'rand' },
          { id: 'ea', from: 'rand', to: 'ta', weight: 1, cooldown: 5 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // The only edge available; cooldown must not prevent the very first pick.
      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('avoidRepeat excludes the immediately-previous pick even without an explicit cooldown', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rand', type: 'random', avoidRepeat: true },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'rand' },
          { id: 'ea', from: 'rand', to: 'ta', weight: 1 },
          { id: 'eb', from: 'rand', to: 'tb', weight: 1 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      const randomNode = playlist.getFlag('game-orchestra', 'customPlayback').nodes[1];
      engine._rng = () => 0.1; // would pick 'ea' (Track A) every time if unconstrained
      await engine._enterRandom(randomNode, 0);
      expect(controller.playTrack).toHaveBeenCalledWith(sA);

      controller.playTrack.mockClear();
      await engine._enterRandom(randomNode, 0);
      expect(controller.playTrack).toHaveBeenCalledWith(sB);
      expect(controller.playTrack).not.toHaveBeenCalledWith(sA);
    });

    it('avoidRepeat excludes every edge targeting the previous node, not just the exact edge used', async () => {
      const sA = createMockSound('sa', 'Track A');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rand', type: 'random', avoidRepeat: true },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } }
        ],
        // Two different edges both routing to the same target node 'ta'.
        edges: [
          { id: 'e1', from: 'start', to: 'rand' },
          { id: 'ea1', from: 'rand', to: 'ta', weight: 1 },
          { id: 'ea2', from: 'rand', to: 'ta', weight: 1 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      const randomNode = playlist.getFlag('game-orchestra', 'customPlayback').nodes[1];
      engine._rng = () => 0.1;
      await engine._enterRandom(randomNode, 0);
      expect(controller.playTrack).toHaveBeenCalledTimes(1);

      // Release 'ta' (its own singleton rule, unrelated to avoidRepeat, would
      // otherwise silently drop the second entry) before picking again. Both
      // edges target 'ta'; with nothing else to pick, avoidRepeat must fall
      // back to allowing the repeat rather than deadlocking.
      await fireEnd(sA);
      controller.playTrack.mockClear();
      await engine._enterRandom(randomNode, 0);
      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });
  });

  describe('Condition', () => {
    function buildConditionGraph(conditions) {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      const edges = [{ id: 'e1', from: 'start', to: 'cond' }];
      conditions.forEach((condition, i) => {
        edges.push({ id: `ec${i}`, from: 'cond', to: i === 0 ? 'ta' : 'tb', condition });
      });
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'cond', type: 'condition' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges
      });
      return { playlist, sA, sB };
    }

    it('follows the combatActive edge when combat is started', async () => {
      game.combat = { started: true };
      const { playlist, sA } = buildConditionGraph([{ kind: 'combatActive' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('falls through to default when combat is not started', async () => {
      game.combat = { started: false };
      const { playlist, sB } = buildConditionGraph([{ kind: 'combatActive' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sB);
    });

    it('follows the combatIdle edge when combat is not started', async () => {
      game.combat = { started: false };
      const { playlist, sA } = buildConditionGraph([{ kind: 'combatIdle' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('matches the mood edge whose value equals the active mood setting', async () => {
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      const { playlist, sA } = buildConditionGraph([{ kind: 'mood', value: 'boss' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('falls through moodChanged to default when the mood has not changed since this run started', async () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const { playlist, sB } = buildConditionGraph([{ kind: 'moodChanged' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sB);
    });

    it("matches moodChanged once the mood differs from this run's start baseline (_moodAtStart)", async () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const { playlist, sA } = buildConditionGraph([{ kind: 'moodChanged' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start(); // captures _moodAtStart = 'calm'
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      // Re-arriving at the Condition node (e.g. looping back through it) re-evaluates
      // against the run's original baseline, not the mood at the moment of arrival.
      const condNode = playlist.getFlag('game-orchestra', 'customPlayback').nodes.find((n) => n.id === 'cond');
      controller.playTrack.mockClear();
      await engine._enterCondition(condNode, 0);

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it("matches phaseChanged once the phase differs from this run's start baseline (_phaseAtStart)", async () => {
      setMockSetting('game-orchestra', 'activePhase', 'explore');
      const { playlist, sA } = buildConditionGraph([{ kind: 'phaseChanged' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      setMockSetting('game-orchestra', 'activePhase', 'boss');
      const condNode = playlist.getFlag('game-orchestra', 'customPlayback').nodes.find((n) => n.id === 'cond');
      controller.playTrack.mockClear();
      await engine._enterCondition(condNode, 0);

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('matches enemiesDefeated only when every NPC combatant is defeated', async () => {
      game.combat = { combatants: { contents: [{ isNPC: true, isDefeated: true }, { isNPC: true, isDefeated: true }, { isNPC: false, isDefeated: false }] } };
      const { playlist, sA } = buildConditionGraph([{ kind: 'enemiesDefeated' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
    });

    it('does not match enemiesDefeated while any NPC combatant survives', async () => {
      game.combat = { combatants: { contents: [{ isNPC: true, isDefeated: true }, { isNPC: true, isDefeated: false }] } };
      const { playlist, sB } = buildConditionGraph([{ kind: 'enemiesDefeated' }, { kind: 'default' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sB);
    });

    it('the token dies silently when no edge matches and there is no default', async () => {
      game.combat = { started: false };
      const { playlist } = buildConditionGraph([{ kind: 'combatActive' }]);

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await expect(engine.start()).resolves.toBeUndefined();
      expect(controller.playTrack).not.toHaveBeenCalled();
    });
  });

  describe("natural end clears the sound document's persisted 'playing' flag", () => {
    /** start -> t1 -> t2, two distinct sounds. */
    function buildChain() {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Track 2');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't2' }
        ]
      });
      return { playlist, s1, s2 };
    }

    /** start -> t1 -> t2, both nodes referencing the SAME sound. */
    function buildSameSoundChain() {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't2' }
        ]
      });
      return { playlist, s1 };
    }

    /** start -> t1 (2 loops of s1) -> t2 (s1 again): the timed-stop same-sound path. */
    function buildSameSoundLoopChain() {
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 2 } },
          { id: 't2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't2' }
        ]
      });
      s1.sound.duration = 1;
      s1.sound.loaded = true;
      return { playlist, s1 };
    }

    it('leaves the flag cleanup to Foundry, which already wrote it, and just advances', async () => {
      // Playlist#_onSoundEnd writes {playing: false, pausedTime: null} for a
      // naturally-finished sound in every playlist mode, and its listener runs
      // before AudioEndWatcher's. A second stopSound() on top of that was a
      // redundant server round-trip sitting inside the audible seam.
      const { playlist, s1, s2 } = buildChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.stopTrack.mockClear();

      await fireEnd(s1);

      expect(controller.stopTrack).not.toHaveBeenCalledWith(s1);
      expect(s1.playing).toBe(false); // ...but the flag is cleared regardless
      expect(controller.playTrack).toHaveBeenLastCalledWith(s2);
    });

    it('still stops the track itself when the parent cannot clear the flag', async () => {
      const { playlist, s1, s2 } = buildChain();
      delete s1.parent._onSoundEnd; // e.g. a non-Playlist parent
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.stopTrack.mockClear();

      await fireEnd(s1);

      expect(controller.stopTrack).toHaveBeenCalledWith(s1);
      expect(controller.playTrack).toHaveBeenLastCalledWith(s2);
    });

    it('still stops the track itself when this client does not own the playlist', async () => {
      // PlaylistSound#_onEnd bails for a non-owner, so Foundry writes nothing.
      const { playlist, s1, s2 } = buildChain();
      s1.parent.isOwner = false;
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.stopTrack.mockClear();

      await fireEnd(s1);

      expect(controller.stopTrack).toHaveBeenCalledWith(s1);
      expect(controller.playTrack).toHaveBeenLastCalledWith(s2);
    });

    it('hands a sound straight back to a node reusing it, with no stop in between', async () => {
      // The same-sound ordering hazard _pendingStops exists for cannot arise on
      // this path: the only stop is Foundry's own, and it was issued strictly
      // BEFORE this callback ran (its listener is registered first), so it can
      // never land after the restart and silence a track the engine believes is
      // playing. The timed paths, which issue their own stop, still need the
      // wait - see the next test.
      const { playlist, s1 } = buildSameSoundChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();
      controller.stopTrack.mockClear();

      await fireEnd(s1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controller.stopTrack).not.toHaveBeenCalled();
      expect(controller.playTrack).toHaveBeenCalledWith(s1);
    });

    it('still waits for its OWN stop to land before restarting the same sound (timed path)', async () => {
      // A loopCount > 1 track never fires 'end' (H3) - the engine stops it
      // itself, so _pendingStops is still what keeps the next node's start from
      // racing that stop.
      const { playlist, s1 } = buildSameSoundLoopChain();
      let releaseStop;
      const stopLanded = new Promise((resolve) => {
        releaseStop = resolve;
      });
      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();
      // Clears the playing flags exactly as the real stopTrack does, so t2 takes
      // the clean-start path rather than adopting a sound the mock left marked
      // playing - the wait under test only guards a clean start.
      controller.stopTrack = vi.fn((sound) => {
        sound.playing = false;
        sound.sound.playing = false;
        return stopLanded;
      });

      await vi.advanceTimersByTimeAsync(2500); // past 2 loops * 1s
      expect(controller.stopTrack).toHaveBeenCalledWith(s1);
      expect(controller.playTrack).not.toHaveBeenCalled();

      releaseStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.playTrack).toHaveBeenCalledWith(s1);
    });

    it('does not restart the same sound if the engine was stopped while its own stop was in flight', async () => {
      const { playlist, s1 } = buildSameSoundLoopChain();
      let releaseStop;
      const stopLanded = new Promise((resolve) => {
        releaseStop = resolve;
      });
      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();
      controller.stopTrack = vi.fn((sound) => {
        sound.playing = false;
        sound.sound.playing = false;
        return stopLanded;
      });

      await vi.advanceTimersByTimeAsync(2500);
      await engine.stop({ stopAudio: false });
      releaseStop();
      await vi.advanceTimersByTimeAsync(0);

      expect(controller.playTrack).not.toHaveBeenCalled();
    });
  });

  describe('predictive hand-off arming', () => {
    /** start -> t1 (10s) -> t2, distinct sounds; the plain plannable shape. */
    function buildArmChain() {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Track 2');
      s1.sound.duration = 10;
      s1.sound.loaded = true;
      s2.sound.loaded = true;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't2' }
        ]
      });
      return { playlist, s1, s2 };
    }

    it('starts the next track on the audio clock at the seam, not after it', async () => {
      vi.useFakeTimers();
      const { playlist, s1, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();

      // Nothing yet, well before the lead window.
      await vi.advanceTimersByTimeAsync(9000);
      expect(s2.sound.play).not.toHaveBeenCalled();

      // Armed: the audio is scheduled (STARTING, not yet started) and the
      // document update is already on the wire.
      await vi.advanceTimersByTimeAsync(900); // t = 9900, past the ~245ms lead
      expect(s2.sound.play).toHaveBeenCalledTimes(1);
      expect(s2.sound.play.mock.calls[0][0]).toMatchObject({ offset: 0, fade: 0, loop: false });
      expect(s2.sound.play.mock.calls[0][0].delay).toBeGreaterThan(0);
      expect(s2.sound.starting).toBe(true);
      expect(s2.sound.started).toBeFalsy();
      expect(controller.playTrack).toHaveBeenCalledWith(s2);

      // Seam: the audio actually starts, and the token follows.
      await vi.advanceTimersByTimeAsync(300);
      expect(s2.sound.started).toBe(true);
      expect(engine.activityState.activeNodeIds).toEqual(['t2']);
      vi.useRealTimers();
    });

    it('levels a cleanly-started track itself, without waiting for an updatePlaylistSound hook', async () => {
      // The hook cannot be relied on: a PlaylistSound's `playing` flag is not reset when audio
      // ends naturally, so on a graph's second pass Playlist#playSound writes playing:true over
      // playing:true, the diff is empty, and no update event is ever emitted.
      vi.useFakeTimers();
      setMockSetting('game-orchestra', 'activeDuck', { factor: 0.4, exemptPlaylistIds: [] });
      const { playlist, s1 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      await vi.advanceTimersByTimeAsync(50);

      expect(s1.sound.fade).toHaveBeenCalledWith(0.4, { duration: 0 });
      setMockSetting('game-orchestra', 'activeDuck', {});
      vi.useRealTimers();
    });

    it('re-levels an armed track AFTER the seam, since Sound##queuePlay overwrites the volume there', async () => {
      vi.useFakeTimers();
      setMockSetting('game-orchestra', 'activeDuck', { factor: 0.25, exemptPlaylistIds: ['layerP'] });
      const { playlist, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // Through the arm and the seam, but not yet past the deferred assert.
      await vi.advanceTimersByTimeAsync(10000);
      s2.sound.fade.mockClear();

      await vi.advanceTimersByTimeAsync(200);

      // A level to the ducked volume, applied instantly - not a crossfade.
      expect(s2.sound.fade).toHaveBeenCalledWith(0.25, { duration: 0 });
      setMockSetting('game-orchestra', 'activeDuck', {});
      vi.useRealTimers();
    });

    it('adopts the armed sound instead of starting it a second time', async () => {
      vi.useFakeTimers();
      const { playlist, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();

      await vi.advanceTimersByTimeAsync(11000);

      // Exactly one document update for s2 - the one issued at arm time.
      expect(controller.playTrack.mock.calls.filter((c) => c[0] === s2)).toHaveLength(1);
      expect(s2.update).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('logs path=armed for a successful arm, and a reason when it bails', async () => {
      // Regression: the latency line used to be gated behind `if
      // (!alreadyPlaying)`, and an armed start necessarily HAS
      // sound.sound.playing === true - so the one outcome worth confirming was
      // the only one that printed nothing. Shipped that way once; the resulting
      // logs could not distinguish "arming works" from "arming never runs".
      setMockSetting('game-orchestra', 'enableDebug', true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.useFakeTimers();
      const { playlist } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(11000);

      const lines = logSpy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('start latency') && l.includes('path=armed'))).toBe(true);
      vi.useRealTimers();
      logSpy.mockRestore();
    });

    it('refuses to arm a delayed start against a suspended AudioContext', async () => {
      // Sound#play({delay}) waits on an AudioTimeout driven by an
      // AudioBufferSourceNode on that context. Suspended, it never fires: the
      // Sound sits in STARTING (playing === true, no audio, no 'end' ever) and
      // the graph stops on that node for good. Confirmed live.
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const { playlist, s2 } = buildArmChain();
      s2.sound.context = { state: 'suspended' };
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(9990); // into the lead window

      expect(s2.sound.play).not.toHaveBeenCalled();
      const lines = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('not arming') && l.includes('[audio-suspended]'))).toBe(true);
      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('restarts armed audio that never actually started, instead of holding a silent token forever', async () => {
      // The wedge: the context stalls AFTER the arm goes out, so play({delay})
      // is accepted but its delay never elapses. Every downstream check is
      // satisfied (Sound#playing is true for STARTING) while nothing is audible,
      // the document stays playing:true, and no 'end' event can ever arrive.
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const { playlist, s2 } = buildArmChain();
      // A play() that reports STARTING and stays there - exactly what a stalled
      // AudioTimeout leaves behind.
      s2.sound.play = vi.fn(() => {
        s2.sound.playing = true;
        s2.sound.startTime = undefined;
        return Promise.resolve(s2.sound);
      });
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(10000); // through the seam: adopted as path=armed
      expect(s2.sound.play).toHaveBeenCalledTimes(1);
      expect(s2.sound.play.mock.calls[0][0].delay).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(400); // past the verification window

      expect(s2.sound.stop).toHaveBeenCalled();
      expect(s2.sound.play).toHaveBeenCalledTimes(2);
      expect(s2.sound.play.mock.calls[1][0].delay).toBeUndefined(); // no delay to wedge on
      const lines = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('never actually started'))).toBe(true);
      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it('leaves a healthy armed start alone', async () => {
      // The verification must not fire on the ordinary case: a sound that is a
      // few ms late is not a wedged one, and restarting it would put an audible
      // hole in every single hand-off.
      vi.useFakeTimers();
      const { playlist, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(10400); // seam, plus the whole verification window

      expect(s2.sound.play).toHaveBeenCalledTimes(1);
      expect(s2.sound.stop).not.toHaveBeenCalled();
      expect(s2.sound.started).toBe(true);
      vi.useRealTimers();
    });

    it('says why it did not arm, rather than bailing silently', async () => {
      // Every bail path must name itself: an arming failure is inaudible in the
      // logs but audible in the room, and a silent one cost a debugging cycle.
      setMockSetting('game-orchestra', 'enableDebug', true);
      setMockSetting('game-orchestra', 'graphCrossfade', 200);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { playlist } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      const lines = warnSpy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('not arming') && l.includes('[crossfade]'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('carries the bail reason onto the next track\'s latency line', async () => {
      // A gap is noticed on the INCOMING track, so that is where the
      // explanation has to be readable - correlating a level-2 warning against
      // a level-3 latency line by hand is exactly what does not happen in
      // practice, and cost a debugging round-trip here.
      setMockSetting('game-orchestra', 'enableDebug', true);
      setMockSetting('game-orchestra', 'graphCrossfade', 200);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { playlist, s1 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await fireEnd(s1);

      const lines = logSpy.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('path=clean') && l.includes('whyNotArmed=crossfade@t1'))).toBe(true);
      vi.restoreAllMocks();
    });

    /** start -> ta (until phaseChanged) -> tb: the engine-timed exit shape. */
    function buildUntilChain(condition = { kind: 'combatIdle' }) {
      const sA = createMockSound('sa', 'Loop');
      const sB = createMockSound('sb', 'Next');
      sA.sound.duration = 1;
      sA.sound.loaded = true;
      sB.sound.loaded = true;
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'until', condition, boundary: 'immediate', minLoops: 1, maxLoops: null } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'ta' },
          { id: 'e2', from: 'ta', to: 'tb' }
        ]
      });
      return { playlist, sA, sB };
    }

    it("arms an until-loop's escape instead of cutting straight to the next track", async () => {
      // These are the phase-change transitions, and they used to be the ONLY
      // hand-offs left un-armed - _queueNextHandoff runs solely in the
      // loopCount === 1 branch, which an until track returns before reaching.
      vi.useFakeTimers();
      const { playlist, sA, sB } = buildUntilChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(1200); // past the minLoops floor; condition true
      // Armed, not exited: the next sound is scheduled and its update is out,
      // but the outgoing track is still playing.
      expect(sB.sound.play).toHaveBeenCalledTimes(1);
      expect(controller.stopTrack).not.toHaveBeenCalledWith(sA);

      await vi.advanceTimersByTimeAsync(400); // past the lead, onto the seam
      expect(sB.sound.started).toBe(true);
      expect(engine.activityState.activeNodeIds).toEqual(['tb']);
      vi.useRealTimers();
    });

    it('cuts the outgoing until-track at the seam - nothing else ever will', async () => {
      // An until track plays on native repeat, so no 'end' event is coming and
      // Playlist#_onSoundEnd never fires: unlike the natural-end path, the
      // engine MUST stop it itself or it plays over the next track and stays
      // marked playing in the world.
      vi.useFakeTimers();
      const { playlist, sA } = buildUntilChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(1600);

      expect(sA.sound.stop).toHaveBeenCalled(); // local, immediate - no round-trip overlap
      expect(controller.stopTrack).toHaveBeenCalledWith(sA); // and the document follows
      vi.useRealTimers();
    });

    it('still exits when an armed until-hand-off is discarded, rather than stranding the token', async () => {
      // The natural-end path can fall back on its 'end' watcher when a plan is
      // invalidated at the seam. An until exit has no watcher, so without an
      // explicit fallback the token would sit forever on a node whose escape
      // condition has already matched - silent and permanent.
      vi.useFakeTimers();
      const { playlist, sA, sB } = buildUntilChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(1200);
      expect(engine._armedHandoff).not.toBeNull();
      // Invalidate the plan the way real state change would: make the target
      // unreachable to the planner.
      engine._planNextHandoff = () => null;

      await vi.advanceTimersByTimeAsync(400);

      expect(sB.sound.stop).toHaveBeenCalled(); // armed audio discarded
      expect(controller.stopTrack).toHaveBeenCalledWith(sA); // ...but we still left
      expect(engine.activityState.activeNodeIds).toEqual(['tb']);
      vi.useRealTimers();
    });

    it('does not arm an unplannable graph, and hands off the ordinary way', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Track 2');
      s1.sound.duration = 10;
      s1.sound.loaded = true;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'f', type: 'fork' },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 'f' },
          { id: 'e3', from: 'f', to: 't2' }
        ]
      });
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();

      await fireEnd(s1);

      expect(s2.sound.play).not.toHaveBeenCalled();
      expect(controller.playTrack).toHaveBeenCalledWith(s2);
    });

    it('discards the plan when a condition changes inside the lead window (H7)', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Combat');
      const s3 = createMockSound('s3', 'Calm');
      s1.sound.duration = 10;
      s1.sound.loaded = true;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2, s3], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'c', type: 'condition' },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } },
          { id: 't3', type: 'track', soundId: 's3', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 'c' },
          { id: 'e3', from: 'c', to: 't2', condition: { kind: 'combatActive' } },
          { id: 'e4', from: 'c', to: 't3', condition: { kind: 'default' } }
        ]
      });
      game.combat = { started: true }; // plans t2 (the combat track)
      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(9900);
      expect(s2.sound.play).toHaveBeenCalled(); // armed the combat track

      game.combat.started = false; // combat ends inside the lead window
      await vi.advanceTimersByTimeAsync(300);

      expect(s2.sound.stop).toHaveBeenCalled(); // armed audio discarded
      expect(engine.activityState.activeNodeIds).toEqual(['t1']); // no premature hop
      vi.useRealTimers();

      await fireEnd(s1); // the ordinary walk now takes the calm exit
      expect(controller.playTrack).toHaveBeenCalledWith(s3);
    });

    it('advances exactly once when the track ends before the computed seam', async () => {
      vi.useFakeTimers();
      const { playlist, s1, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      controller.playTrack.mockClear();

      await vi.advanceTimersByTimeAsync(9900); // armed
      vi.useRealTimers();
      await fireEnd(s1); // ...but the file actually ends early

      expect(engine.activityState.activeNodeIds).toEqual(['t2']);
      expect(controller.playTrack.mock.calls.filter((c) => c[0] === s2)).toHaveLength(1);
    });

    it('cancels an armed hand-off on teardown, clearing its persisted playing flag', async () => {
      vi.useFakeTimers();
      const { playlist, s2 } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      await vi.advanceTimersByTimeAsync(9900); // armed
      await engine.stop();

      expect(s2.sound.stop).toHaveBeenCalled();
      expect(controller.stopTrack).toHaveBeenCalledWith(s2);
      vi.useRealTimers();
    });

    it('sizes the lead from measured update round-trips, clamped at both ends', async () => {
      const { playlist } = buildArmChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      expect(engine._handoffLeadMs()).toBe(245); // DEFAULT_UPDATE_RTT_MS seed

      engine._recordUpdateRtt(0); // ignored - not a usable sample
      expect(engine._handoffLeadMs()).toBe(245);

      for (let i = 0; i < 20; i++) engine._recordUpdateRtt(1000);
      expect(engine._handoffLeadMs()).toBe(500); // MAX_HANDOFF_LEAD_MS

      for (let i = 0; i < 40; i++) engine._recordUpdateRtt(1);
      expect(engine._handoffLeadMs()).toBe(60); // MIN_HANDOFF_LEAD_MS
    });
  });

  describe('hand-off latency (gapless track transitions)', () => {
    /** start -> t1 -> t2, two distinct sounds; t2's audio starts un-decoded. */
    function buildPreloadChain() {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Track 2');
      s2.sound.loaded = false;
      s2.sound.load = vi.fn(() => Promise.resolve());
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't2' }
        ]
      });
      return { playlist, s1, s2 };
    }

    it("preloads the next track's audio while the current one is still playing", async () => {
      // Otherwise the fetch+decode happens entirely inside the gap between the
      // two tracks, where it is the largest single contributor.
      const { playlist, s2 } = buildPreloadChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();

      expect(s2.sound.load).toHaveBeenCalled();
    });

    it('preloads every branch of a Random node, since the exit taken is not known in advance', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      for (const s of [sA, sB]) {
        s.sound.loaded = false;
        s.sound.load = vi.fn(() => Promise.resolve());
      }
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 'rand', type: 'random' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 'rand' },
          { id: 'e3', from: 'rand', to: 'ta', weight: 1 },
          { id: 'e4', from: 'rand', to: 'tb', weight: 1 }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(sA.sound.load).toHaveBeenCalled();
      expect(sB.sound.load).toHaveBeenCalled();
    });

    it('keeps playing when a preload fails', async () => {
      const { playlist, s1, s2 } = buildPreloadChain();
      s2.sound.load = vi.fn(() => Promise.reject(new Error('404')));
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fireEnd(s1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controller.playTrack).toHaveBeenCalledWith(s2);
    });

    it("preloads through PlaylistSound#load(), which also covers a track with no Sound instance yet", async () => {
      // Foundry creates the underlying Sound lazily; PlaylistSound#load() does
      // `this.sound ||= this._createSound()` first, so it is the entry point
      // that works for a track which has never played this session - exactly
      // the track a lookahead exists to warm.
      const { playlist, s2 } = buildPreloadChain();
      s2.sound = null;
      s2.load = vi.fn(() => Promise.resolve());
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();

      expect(s2.load).toHaveBeenCalled();
    });

    it('warns when a graph track carries a fade, which Foundry applies around the seam itself', async () => {
      // PlaylistSound#_onStart fades the track in from silence and schedules a
      // fade to zero before the end of any non-repeating sound. No amount of
      // engine-side timing compensates for that, so it is reported.
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s1 = createMockSound('s1', 'Track 1');
      s1.fadeDuration = 2000;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      const lines = warnSpy.mock.calls.map((args) => args.join(' '));
      expect(lines.some((l) => l.includes('2000ms fade') && l.includes('seamless cut'))).toBe(true);
      warnSpy.mockRestore();
    });

    it('reports the fade once per sound, not on every loop of it', async () => {
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s1 = createMockSound('s1', 'Track 1');
      s1.fadeDuration = 2000;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 't1' },
          { id: 'e2', from: 't1', to: 't1' }
        ]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      await fireEnd(s1);
      await new Promise((resolve) => setTimeout(resolve, 400));

      const fadeLines = warnSpy.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes('seamless cut'));
      expect(fadeLines).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it('says nothing when no fade is configured', async () => {
      setMockSetting('game-orchestra', 'enableDebug', true); // or the warn would be gated off and this would pass trivially
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { playlist } = buildPreloadChain();
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();

      const lines = warnSpy.mock.calls.map((args) => args.join(' '));
      expect(lines.some((l) => l.includes('seamless cut'))).toBe(false);
      warnSpy.mockRestore();
    });

    describe('crossfade hand-off (graphCrossfade setting)', () => {
      /** start -> t1 -> t2, distinct sounds, t1 with a known 10s duration. */
      function buildTimedChain() {
        const s1 = createMockSound('s1', 'Track 1');
        const s2 = createMockSound('s2', 'Track 2');
        s1.sound.duration = 10;
        s1.sound.loaded = true;
        const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
        playlist.setFlag('game-orchestra', 'customPlayback', {
          version: 1,
          nodes: [
            { id: 'start', type: 'start' },
            { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
            { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
          ],
          edges: [
            { id: 'e1', from: 'start', to: 't1' },
            { id: 'e2', from: 't1', to: 't2' }
          ]
        });
        return { playlist, s1, s2 };
      }

      describe('per-playlist override (graph.crossfadeMs)', () => {
        it('uses the override even when the world setting is 0/off', async () => {
          vi.useFakeTimers(); // world graphCrossfade left unset (off)
          const { playlist, s1, s2 } = buildTimedChain();
          playlist.getFlag('game-orchestra', 'customPlayback').crossfadeMs = 200;
          const engine = new CustomPlaybackEngine({ playlist }, controller);
          await engine.start();

          await vi.advanceTimersByTimeAsync(9850);
          expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 200 });
          expect(controller.playTrack).toHaveBeenCalledWith(s2);
        });

        it('an explicit 0 override disables crossfade even when the world setting is non-zero', async () => {
          setMockSetting('game-orchestra', 'graphCrossfade', 200);
          vi.useFakeTimers();
          const { playlist, s1, s2 } = buildTimedChain();
          playlist.getFlag('game-orchestra', 'customPlayback').crossfadeMs = 0;
          const engine = new CustomPlaybackEngine({ playlist }, controller);
          await engine.start();

          await vi.advanceTimersByTimeAsync(11000);
          expect(crossfadeOutCalls(s1)).toHaveLength(0);

          vi.useRealTimers();
          await fireEnd(s1);
          expect(controller.playTrack).toHaveBeenCalledWith(s2);
        });

        it('a larger override than the world setting is honored in full', async () => {
          setMockSetting('game-orchestra', 'graphCrossfade', 50);
          vi.useFakeTimers();
          const { playlist, s1, s2 } = buildTimedChain();
          playlist.getFlag('game-orchestra', 'customPlayback').crossfadeMs = 300;
          const engine = new CustomPlaybackEngine({ playlist }, controller);
          await engine.start();

          // 10s track, 300ms override -> hand-off at 9700ms, not 9950ms.
          await vi.advanceTimersByTimeAsync(9650);
          expect(controller.playTrack).not.toHaveBeenCalledWith(s2);

          await vi.advanceTimersByTimeAsync(100);
          expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 300 });
        });

        it('falls back to the world setting when the graph has no override (null)', async () => {
          setMockSetting('game-orchestra', 'graphCrossfade', 150);
          vi.useFakeTimers();
          const { playlist, s1, s2 } = buildTimedChain(); // crossfadeMs left unset on the flag
          const engine = new CustomPlaybackEngine({ playlist }, controller);
          await engine.start();

          await vi.advanceTimersByTimeAsync(9900);
          expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 150 });
        });

        it('a malformed override (negative) falls back to the world setting rather than breaking', async () => {
          setMockSetting('game-orchestra', 'graphCrossfade', 150);
          vi.useFakeTimers();
          const { playlist, s1, s2 } = buildTimedChain();
          playlist.getFlag('game-orchestra', 'customPlayback').crossfadeMs = -50;
          const engine = new CustomPlaybackEngine({ playlist }, controller);
          await engine.start();

          await vi.advanceTimersByTimeAsync(9900);
          expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 150 });
        });
      });

      it('starts the next track early and fades the outgoing one out across the overlap', async () => {
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s1, s2 } = buildTimedChain();
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        // 10s track, 200ms crossfade -> hand-off at 9800ms, not 10000ms.
        await vi.advanceTimersByTimeAsync(9700);
        expect(controller.playTrack).not.toHaveBeenCalledWith(s2);

        await vi.advanceTimersByTimeAsync(150);
        expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 200 });
        expect(controller.playTrack).toHaveBeenCalledWith(s2);
        // The outgoing track is still audible during the overlap - stopping it
        // now is exactly the gap this feature exists to remove.
        expect(controller.stopTrack).not.toHaveBeenCalledWith(s1);

        // ...and it is stopped once the fade has run its course.
        await vi.advanceTimersByTimeAsync(250);
        expect(controller.stopTrack).toHaveBeenCalledWith(s1);
      });

      it('is off by default: the outgoing track is never faded', async () => {
        // The seam itself is still handed off early - that is _armHandoff, which
        // starts the next track on the audio clock and is deliberately NOT a
        // crossfade. What "crossfade off" means is precisely that the outgoing
        // track is cut rather than faded, so that is what this asserts.
        vi.useFakeTimers();
        const { playlist, s1 } = buildTimedChain();
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(11000);

        expect(crossfadeOutCalls(s1)).toHaveLength(0);
        vi.useRealTimers();
      });

      it('does not arm a hand-off at all while the crossfade owns the seam', async () => {
        // Two mechanisms racing for one seam would double-hop the token, so
        // _queueNextHandoff bails outright whenever a crossfade is configured.
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s2 } = buildTimedChain();
        s2.sound.loaded = true;
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(9000); // before the crossfade hand-off

        expect(s2.sound.play).not.toHaveBeenCalled();
        vi.useRealTimers();
      });

      it('does not double-advance when the end event also fires', async () => {
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s1, s2 } = buildTimedChain();
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(9900); // crossfade hand-off has fired
        expect(controller.playTrack).toHaveBeenCalledWith(s2);

        // The real 'end' lands 200ms later. The watcher must have been disarmed.
        controller.playTrack.mockClear();
        vi.useRealTimers();
        await fireEnd(s1);
        expect(controller.playTrack).not.toHaveBeenCalled();
      });

      it('falls back to the natural end when the next track reuses the same sound', async () => {
        // One Sound cannot play two positions at once, so there is nothing to
        // overlap with.
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const s1 = createMockSound('s1', 'Track 1');
        s1.sound.duration = 10;
        s1.sound.loaded = true;
        const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
        playlist.setFlag('game-orchestra', 'customPlayback', {
          version: 1,
          nodes: [
            { id: 'start', type: 'start' },
            { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
            { id: 't2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
          ],
          edges: [
            { id: 'e1', from: 'start', to: 't1' },
            { id: 'e2', from: 't1', to: 't2' }
          ]
        });

        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();
        await vi.advanceTimersByTimeAsync(11000);

        expect(crossfadeOutCalls(s1)).toHaveLength(0);
      });

      it('falls back to the natural end for a track shorter than the crossfade', async () => {
        setMockSetting('game-orchestra', 'graphCrossfade', 500);
        vi.useFakeTimers();
        const { playlist, s1, s2 } = buildTimedChain();
        s1.sound.duration = 0.2; // 200ms track, 500ms crossfade
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(2000);
        expect(crossfadeOutCalls(s1)).toHaveLength(0);
        expect(controller.playTrack).not.toHaveBeenCalledWith(s2);
      });

      it('stops a sound left mid-fade when the engine is torn down, so it is not resurrected on reload', async () => {
        // The node is released the moment the overlap starts, so the fading
        // sound is no longer reachable through _activeNodes - stop() has to
        // find it via _fadingOutSounds or its persisted `playing` flag survives.
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s1 } = buildTimedChain();
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(9850); // mid-fade
        expect(controller.stopTrack).not.toHaveBeenCalledWith(s1);

        await engine.stop({ stopAudio: true });
        expect(controller.stopTrack).toHaveBeenCalledWith(s1);
      });

      it('reports a fading sound as still active while it plays out', async () => {
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s1, s2 } = buildTimedChain();
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        await vi.advanceTimersByTimeAsync(9850); // mid-fade: both audible
        expect(engine.activeSounds).toContain(s1);
        expect(engine.activeSounds).toContain(s2);
      });

      it('pulls a loopCount boundary forward by the crossfade too', async () => {
        setMockSetting('game-orchestra', 'graphCrossfade', 200);
        vi.useFakeTimers();
        const { playlist, s1, s2 } = buildTimedChain();
        playlist.setFlag('game-orchestra', 'customPlayback', {
          version: 1,
          nodes: [
            { id: 'start', type: 'start' },
            { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 2 } },
            { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
          ],
          edges: [
            { id: 'e1', from: 'start', to: 't1' },
            { id: 'e2', from: 't1', to: 't2' }
          ]
        });

        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();

        // 2 loops * 10s = 20000ms, minus the 200ms overlap.
        await vi.advanceTimersByTimeAsync(19700);
        expect(controller.playTrack).not.toHaveBeenCalledWith(s2);

        await vi.advanceTimersByTimeAsync(150);
        expect(s1.sound.fade).toHaveBeenCalledWith(0, { duration: 200 });
        expect(controller.playTrack).toHaveBeenCalledWith(s2);
      });
    });

    it('skips the pausedTime/repeat update when the document already holds those values', async () => {
      // An update that changes nothing still costs a full server round-trip,
      // and it lands squarely in the middle of the hand-off.
      const s1 = createMockSound('s1', 'Track 1');
      s1.pausedTime = 0;
      s1.repeat = false;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(s1.update).not.toHaveBeenCalled();
      expect(controller.playTrack).toHaveBeenCalledWith(s1);
    });

    it('still issues the update when repeat has to change for a looping track', async () => {
      const s1 = createMockSound('s1', 'Track 1');
      s1.pausedTime = 0;
      s1.repeat = false;
      const playlist = createMockPlaylist('pl1', 'Graph', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 3 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(s1.update).toHaveBeenCalledWith({ pausedTime: 0, repeat: true });
    });
  });

  describe("activity broadcast (drives the editor's live highlight)", () => {
    /** start -> t1 -> t2 -> start (a two-track loop). */
    function buildLoopGraph() {
      const s1 = createMockSound('s1', 'Track 1');
      const s2 = createMockSound('s2', 'Track 2');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: 'start:output_1->t1', from: 'start', to: 't1' },
          { id: 't1:output_1->t2', from: 't1', to: 't2' },
          { id: 't2:output_1->t1', from: 't2', to: 't1' }
        ]
      });
      return { playlist, s1, s2 };
    }

    /** Every 'gameOrchestraGraphActivity' payload broadcast so far, in order. */
    function activityPayloads() {
      return Hooks.callAll.mock.calls.filter(([event]) => event === 'gameOrchestraGraphActivity').map(([, payload]) => payload);
    }

    it('reports the node just entered and the edge being followed', async () => {
      const { playlist } = buildLoopGraph();
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();

      const payloads = activityPayloads();
      expect(payloads.some((p) => p.enteredNodeId === 'start')).toBe(true);
      expect(payloads.some((p) => p.traversedEdgeIds.includes('start:output_1->t1'))).toBe(true);
      expect(payloads.every((p) => p.playlistId === 'pl1')).toBe(true);
    });

    it('reports a Track node as active while it plays and no longer once it advances', async () => {
      const { playlist, s1 } = buildLoopGraph();
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();
      expect(activityPayloads().at(-1).activeNodeIds).toEqual(['t1']);

      Hooks.callAll.mockClear();
      await fireEnd(s1);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const payloads = activityPayloads();
      // t1 is released, the exit is followed, then t2 registers as the active node.
      expect(payloads.some((p) => p.activeNodeIds.length === 0)).toBe(true);
      expect(payloads.some((p) => p.traversedEdgeIds.includes('t1:output_1->t2'))).toBe(true);
      expect(payloads.at(-1).activeNodeIds).toEqual(['t2']);
    });

    it('broadcasts an empty active set when the engine stops, clearing any highlight', async () => {
      const { playlist } = buildLoopGraph();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      Hooks.callAll.mockClear();
      await engine.stop();

      expect(activityPayloads().at(-1).activeNodeIds).toEqual([]);
    });

    it('exposes the same snapshot via activityState, for priming an editor opened mid-playback', async () => {
      const { playlist } = buildLoopGraph();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      expect(engine.activityState).toEqual({
        playlistId: 'pl1',
        runId: engine._runId,
        activeNodeIds: ['t1'],
        activeTimings: [], // this mock sound never reports a duration, so nothing is timed
        enteredNodeId: null,
        traversedEdgeIds: []
      });
    });

    it('keeps playing when a listener throws - highlighting must never break audio', async () => {
      const { playlist, s1 } = buildLoopGraph();
      Hooks.on('gameOrchestraGraphActivity', () => {
        throw new Error('listener blew up');
      });
      const engine = new CustomPlaybackEngine({ playlist }, controller);

      await engine.start();
      expect(controller.playTrack).toHaveBeenCalledWith(s1);

      await fireEnd(s1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controller.playTrack).toHaveBeenCalledTimes(2); // advanced to t2 regardless
    });
  });

  describe('playlist nodes (docs/playlist-node-plan.md)', () => {
    function directRef(playlistId) {
      return { source: 'direct', playlistId };
    }

    /** A minimal playlist: Start -> [Playlist node targeting `nextId`, if given] -> Track(sound) [-> End]. */
    function chainPlaylist(id, sound, nextId) {
      const nodes = [{ id: 'start', type: 'start' }];
      const edges = [];
      if (nextId) {
        nodes.push({ id: 'p', type: 'playlist', playlistRef: directRef(nextId), loop: { mode: 'count', count: 1 } });
        nodes.push({ id: 't', type: 'track', soundId: sound.id, loop: { mode: 'count', count: 1 } });
        edges.push({ id: 'e1', from: 'start', to: 'p' }, { id: 'e2', from: 'p', to: 't' });
      } else {
        nodes.push({ id: 't', type: 'track', soundId: sound.id, loop: { mode: 'count', count: 1 } });
        edges.push({ id: 'e1', from: 'start', to: 't' });
      }
      const playlist = createMockPlaylist(id, id, [sound], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes, edges });
      return playlist;
    }

    it('a direct reference to a playlist with its own graph plays that graph, then advances on idle', async () => {
      const targetSound = createMockSound('ts1', 'Target Track');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      });

      const rootSound = createMockSound('rs1', 'Root Track');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(targetSound);
      expect(engine._activeNodes.has('p1')).toBe(true); // holds the token while the pass runs
      expect(engine.isPlayingPlaylist('pl-target')).toBe(true);

      await fireEnd(targetSound);

      expect(controller.playTrack).toHaveBeenCalledWith(rootSound); // advanced past the Playlist node into t2
      expect(engine.isPlayingPlaylist('pl-target')).toBe(false);
      expect(engine._activeNodes.has('p1')).toBe(false);
    });

    it('a direct reference to a native playlist with no stored graph plays it via a graph synthesized from its own Foundry mode', async () => {
      const t1 = createMockSound('nt1', 'Native 1');
      const t2 = createMockSound('nt2', 'Native 2');
      const nativePlaylist = createMockPlaylist('pl-native', 'Native', [t1, t2], 0); // SEQUENTIAL, no stored graph

      const rootSound = createMockSound('rs1', 'Root Track');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-native'), loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-native' ? nativePlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(t1);
      expect(controller.playTrack).not.toHaveBeenCalledWith(t2);

      await fireEnd(t1);
      expect(controller.playTrack).toHaveBeenCalledWith(t2);

      await fireEnd(t2);
      expect(controller.playTrack).toHaveBeenCalledWith(rootSound); // both native sounds played in order, then advanced
    });

    it('loopCount runs that many passes before following the exit', async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      });

      const rootSound = createMockSound('rs1', 'Root');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'count', count: 2 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledTimes(1); // pass 1's track

      await fireEnd(targetSound); // pass 1 completes
      await vi.advanceTimersByTimeAsync(510); // clear the between-pass throttle + EngineClock's fallback tick

      expect(controller.playTrack).toHaveBeenCalledTimes(2); // pass 2 started, NOT the exit
      expect(controller.playTrack).not.toHaveBeenCalledWith(rootSound);

      await fireEnd(targetSound); // pass 2 completes
      await vi.advanceTimersByTimeAsync(510);

      expect(controller.playTrack).toHaveBeenCalledWith(rootSound); // now it exits, after exactly 2 passes
    });

    it("loop: { mode: 'forever' } never follows an exit and keeps starting new passes forever", async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } }, { id: 'end', type: 'end' }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      });

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(engine._activeNodes.has('p1')).toBe(true);
      expect(controller.playTrack).toHaveBeenCalledTimes(1);

      await fireEnd(targetSound);
      await vi.advanceTimersByTimeAsync(510);

      expect(engine._activeNodes.has('p1')).toBe(true); // still active - started another pass, no exit exists
      expect(controller.playTrack).toHaveBeenCalledTimes(2);
    });

    it("H12: a child engine built around a loop.mode 'until' Track (plays seamlessly, like forever) still goes idle and completes the parent Playlist node's pass once its condition matches", async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
          { id: 'end', type: 'end' }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      });
      targetSound.sound.duration = 1;
      targetSound.sound.loaded = true;

      const rootSound = createMockSound('rs1', 'Root');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));
      game.combat = { started: true }; // combatIdle false - the child's until-track keeps looping

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(targetSound);

      // The child engine's Track plays seamlessly (repeat: true, same as forever) for as long as
      // combat is active - the parent Playlist node's pass has NOT completed, so the root's own
      // track must not have started yet.
      await vi.advanceTimersByTimeAsync(1500);
      expect(controller.playTrack).not.toHaveBeenCalledWith(rootSound);
      expect(engine._activeNodes.has('p1')).toBe(true);

      // Combat ends - the until-track's condition matches, it takes its one exit to the child's
      // own End, the child engine has nothing left in flight and goes idle, and THAT is what
      // reports the pass as complete to the parent Playlist node (H12).
      game.combat.started = false;
      await vi.advanceTimersByTimeAsync(500); // next poll tick
      await vi.advanceTimersByTimeAsync(510); // clear the between-pass/exit throttle

      expect(controller.playTrack).toHaveBeenCalledWith(rootSound);
      expect(engine._activeNodes.has('p1')).toBe(false);
    });

    it('a self-reference is refused, logged, and treated as a zero-length pass', async () => {
      const rootSound = createMockSound('rs1', 'Root');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-root'), loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-root' ? rootPlaylist : null));
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(rootSound); // skipped straight through to t2
      expect(engine._children.size).toBe(0); // no child engine was ever spawned
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('an indirect A -> B -> A cycle is refused at the second hop, not the first', async () => {
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      const playlistA = createMockPlaylist('pl-a', 'A', [sA], -1);
      const playlistB = createMockPlaylist('pl-b', 'B', [sB], -1);

      playlistA.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p_to_b', type: 'playlist', playlistRef: directRef('pl-b'), loop: { mode: 'count', count: 1 } },
          { id: 't_a', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p_to_b' }, { id: 'e2', from: 'p_to_b', to: 't_a' }]
      });
      playlistB.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p_to_a', type: 'playlist', playlistRef: directRef('pl-a'), loop: { mode: 'count', count: 1 } },
          { id: 't_b', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p_to_a' }, { id: 'e2', from: 'p_to_a', to: 't_b' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-a' ? playlistA : id === 'pl-b' ? playlistB : null));

      const engine = new CustomPlaybackEngine({ playlist: playlistA }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(sB); // B's own track, after its cyclic reference back to A was refused
      expect(controller.playTrack).not.toHaveBeenCalledWith(sA); // A's own pass hasn't completed - still waiting on B
      expect(engine.isPlayingPlaylist('pl-b')).toBe(true);
    });

    it('nesting deeper than the nesting limit is refused', async () => {
      const sounds = Array.from({ length: 6 }, (_, i) => createMockSound(`s${i}`, `Track ${i}`));
      const playlists = [];
      for (let i = 5; i >= 0; i--) {
        const nextId = i < 5 ? `pl-${i + 1}` : null;
        playlists[i] = chainPlaylist(`pl-${i}`, sounds[i], nextId);
      }
      const byId = Object.fromEntries(playlists.map((p) => [p.id, p]));
      game.playlists.get = vi.fn((id) => byId[id] || null);

      const engine = new CustomPlaybackEngine({ playlist: playlists[0] }, controller);
      await engine.start();

      // pl-0 (depth 0) -> pl-1 (depth 1) -> pl-2 (depth 2) -> pl-3 (depth 3) -> pl-4 (depth 4):
      // all allowed. pl-4's own Playlist node (entered by the depth-4 child) targets
      // pl-5, which would need depth 5 - refused, so pl-4's own track plays instead.
      expect(controller.playTrack).toHaveBeenCalledWith(sounds[4]);
      expect(controller.playTrack).not.toHaveBeenCalledWith(sounds[5]);
    });

    it('an indirect reference that fails to resolve (no scene, no override) is skipped, not stranded', async () => {
      const rootSound = createMockSound('rs1', 'Root');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'none' }, loop: { mode: 'count', count: 1 } },
          { id: 't2', type: 'track', soundId: 'rs1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 't2' }]
      });

      // game.scenes.active is null by default (setupFoundryMocks) - the scene
      // section can't be read, so the reference has nothing to resolve.
      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(rootSound);
      expect(engine._children.size).toBe(0);
    });

    it('stop() tears down child engines spawned by Playlist nodes and stops their sounds', async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(targetSound);
      expect(engine._children.size).toBe(1);

      await engine.stop();

      expect(controller.stopTrack).toHaveBeenCalledWith(targetSound);
      expect(engine._children.size).toBe(0);
      expect(engine.isPlayingPlaylist('pl-target')).toBe(false);
    });

    it('stop({ stopAudio: false }) leaves a child engine\'s sounds audible, for H11 crossfade', async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();
      expect(controller.playTrack).toHaveBeenCalledWith(targetSound);

      await engine.stop({ stopAudio: false });

      expect(controller.stopTrack).not.toHaveBeenCalled();
    });

    it('isPlayingPlaylist reflects the whole engine tree, not just this engine\'s own playlist', async () => {
      const targetSound = createMockSound('ts1', 'Target');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [targetSound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 'ts1', loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        edges: [{ id: 'e1', from: 'start', to: 't1' }, { id: 'e2', from: 't1', to: 'end' }]
      });

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'count', count: 1 } },
          { id: 'end', type: 'end' }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'end' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(engine.isPlayingPlaylist('pl-root')).toBe(true);
      expect(engine.isPlayingPlaylist('pl-target')).toBe(true);
      expect(engine.isPlayingPlaylist('pl-other')).toBe(false);

      const found = engine.findEngineFor('pl-target');
      expect(found).not.toBeNull();
      expect(found.playlist?.id).toBe('pl-target');
      expect(engine.findEngineFor('pl-root')).toBe(engine);
      expect(engine.findEngineFor('pl-nonexistent')).toBeNull();

      await fireEnd(targetSound);

      expect(engine.isPlayingPlaylist('pl-target')).toBe(false); // pass complete, released
    });

    it('the entry throttle bounds a Playlist node whose exit loops back to itself, mirroring Track\'s rapid-restart floor', async () => {
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          // playlistId: null never resolves, so this node is always skipped -
          // and its exit loops straight back to itself.
          { id: 'p1', type: 'playlist', playlistRef: directRef(null), loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }, { id: 'e2', from: 'p1', to: 'p1' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      const enterSpy = vi.spyOn(engine, '_enterPlaylist');
      engine.start(); // this graph never terminates on its own - fire-and-forget

      await vi.advanceTimersByTimeAsync(2000);

      const totalCalls = enterSpy.mock.calls.length;
      // ~2000ms bounded by the 300ms floor is roughly 4-7 re-entries (the
      // EngineClock fallback ticker's own 500ms cadence widens that further);
      // an unthrottled spin would produce many times that within the same
      // fake-timer window.
      expect(totalCalls).toBeGreaterThan(1);
      expect(totalCalls).toBeLessThan(15);
      expect(engine._runId).not.toBe(-1); // still running - the throttle bounded it, not the circuit breaker
    });
  });

  describe('refreshOverlayReactiveTargets (MusicController#transitionToContext calls this on a re-resolution that leaves the root graph running)', () => {
    function directRef(playlistId) {
      return { source: 'direct', playlistId };
    }

    function setDefaultAreaMoods(overlays) {
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: { area: { overlays } } } } });
    }

    it('swaps an active Playlist node to the newly-resolved target when the active mood changed', async () => {
      const calmSound = createMockSound('cs1', 'Calm');
      const calmPlaylist = createMockPlaylist('pl-calm', 'Calm', [calmSound], -1);
      calmPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'cs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const bossSound = createMockSound('bs1', 'Boss');
      const bossPlaylist = createMockPlaylist('pl-boss', 'Boss', [bossSound], -1);
      bossPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'bs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'active' }, loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => ({ 'pl-calm': calmPlaylist, 'pl-boss': bossPlaylist }[id] || null));
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      setDefaultAreaMoods({ calm: { playlist: 'pl-calm' }, boss: { playlist: 'pl-boss' } });

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(calmSound);
      expect(engine.isPlayingPlaylist('pl-calm')).toBe(true);

      setMockSetting('game-orchestra', 'activeMood', 'boss');
      await engine.refreshOverlayReactiveTargets();

      expect(controller.stopTrack).toHaveBeenCalledWith(calmSound);
      expect(controller.playTrack).toHaveBeenCalledWith(bossSound);
      expect(engine.isPlayingPlaylist('pl-calm')).toBe(false);
      expect(engine.isPlayingPlaylist('pl-boss')).toBe(true);
    });

    it('does nothing when the resolved target is unchanged', async () => {
      const sound = createMockSound('s1', 'Sound');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [sound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'active' }, loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      setDefaultAreaMoods({ calm: { playlist: 'pl-target' } });

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();
      const childBefore = [...engine._children][0];
      controller.stopTrack.mockClear();

      // A different, unrelated setting change re-triggers a re-resolution, but
      // 'calm' still resolves to the same pl-target - nothing should move.
      await engine.refreshOverlayReactiveTargets();

      expect(controller.stopTrack).not.toHaveBeenCalled();
      expect([...engine._children][0]).toBe(childBefore);
    });

    it('leaves overlayMode "none" and "specific" nodes alone - they do not track the active overlay', async () => {
      const fixedSound = createMockSound('fs1', 'Fixed');
      const fixedPlaylist = createMockPlaylist('pl-fixed', 'Fixed', [fixedSound], -1);
      fixedPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'fs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const bossSound = createMockSound('bs1', 'Boss');
      const bossPlaylist = createMockPlaylist('pl-boss', 'Boss', [bossSound], -1);
      bossPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'bs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'specific', overlayId: 'calm' }, loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => ({ 'pl-fixed': fixedPlaylist, 'pl-boss': bossPlaylist }[id] || null));
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      setDefaultAreaMoods({ calm: { playlist: 'pl-fixed' }, boss: { playlist: 'pl-boss' } });

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();
      const childBefore = [...engine._children][0];

      // Even though the world's active mood changes to 'boss', this node is
      // pinned to 'calm' specifically and must keep resolving pl-fixed.
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      await engine.refreshOverlayReactiveTargets();

      expect(engine.isPlayingPlaylist('pl-fixed')).toBe(true);
      expect(engine.isPlayingPlaylist('pl-boss')).toBe(false);
      expect([...engine._children][0]).toBe(childBefore);
    });

    it('leaves a direct-reference Playlist node alone', async () => {
      const sound = createMockSound('s1', 'Sound');
      const targetPlaylist = createMockPlaylist('pl-target', 'Target', [sound], -1);
      targetPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: directRef('pl-target'), loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null));

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();
      const childBefore = [...engine._children][0];

      setMockSetting('game-orchestra', 'activeMood', 'boss');
      await engine.refreshOverlayReactiveTargets();

      expect([...engine._children][0]).toBe(childBefore);
    });

    it('leaves the root graph\'s own position (a sibling Track node reached via Fork) untouched while swapping a nested mood-reactive node', async () => {
      const calmSound = createMockSound('cs1', 'Calm');
      const calmPlaylist = createMockPlaylist('pl-calm', 'Calm', [calmSound], -1);
      calmPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'cs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      const bossSound = createMockSound('bs1', 'Boss');
      const bossPlaylist = createMockPlaylist('pl-boss', 'Boss', [bossSound], -1);
      bossPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'bs1', loop: { mode: 'forever' } }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });

      const rootAmbSound = createMockSound('ra1', 'Root Ambience');
      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [rootAmbSound], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'fork' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'active' }, loop: { mode: 'forever' } },
          { id: 'tRoot', type: 'track', soundId: 'ra1', loop: { mode: 'forever' } }
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'fork' },
          { id: 'e2', from: 'fork', to: 'p1' },
          { id: 'e3', from: 'fork', to: 'tRoot' }
        ]
      });

      game.playlists.get = vi.fn((id) => ({ 'pl-calm': calmPlaylist, 'pl-boss': bossPlaylist }[id] || null));
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      setDefaultAreaMoods({ calm: { playlist: 'pl-calm' }, boss: { playlist: 'pl-boss' } });

      const engine = new CustomPlaybackEngine({ playlist: rootPlaylist }, controller);
      await engine.start();

      expect(controller.playTrack).toHaveBeenCalledWith(rootAmbSound);
      expect(engine._activeNodes.has('tRoot')).toBe(true);

      setMockSetting('game-orchestra', 'activeMood', 'boss');
      await engine.refreshOverlayReactiveTargets();

      // The nested reactive node swapped...
      expect(engine.isPlayingPlaylist('pl-boss')).toBe(true);
      // ...but the root graph's own Track node (reached via the Fork's other
      // branch) was never touched - still the same active node, sound never stopped.
      expect(engine._activeNodes.has('tRoot')).toBe(true);
      expect(controller.stopTrack).not.toHaveBeenCalledWith(rootAmbSound);
    });
  });
  describe("Track timing broadcast (drives the editor's drain overlay)", () => {
    /** start -> ta, with ta's loop spec under test. */
    function buildTimedGraph(loop) {
      const sA = createMockSound('sa', 'Track A');
      sA.sound.duration = 30;
      sA.sound.loaded = true;
      const playlist = createMockPlaylist('pl1', 'Graph', [sA], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'ta', type: 'track', soundId: 'sa', loop }],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }]
      });
      return { playlist, sA };
    }

    const timings = () =>
      Hooks.callAll.mock.calls
        .filter(([event]) => event === 'gameOrchestraGraphActivity')
        .map(([, payload]) => payload.activeTimings)
        .findLast((t) => t.length > 0) || [];

    it("reports one pass of the sound, and how many passes it will make", async () => {
      const { playlist } = buildTimedGraph({ mode: 'count', count: 3 });
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      // The duration is ONE pass, not all three: the editor restarts the sweep
      // on every loop, so multiplying it here would drain three times too slowly.
      expect(timings()).toEqual([{ nodeId: 'ta', durationMs: 30_000, startedAt: expect.any(Number), iterations: 3 }]);
    });

    it('reports an unbounded pass count for a track that never advances on its own', async () => {
      for (const loop of [{ mode: 'forever' }, { mode: 'until', condition: { kind: 'combatActive' }, minLoops: 1 }]) {
        Hooks.callAll.mockClear();
        const { playlist } = buildTimedGraph(loop);
        const engine = new CustomPlaybackEngine({ playlist }, controller);
        await engine.start();
        // null, not a number: the editor repeats the drain indefinitely for these.
        expect(timings()[0]).toMatchObject({ nodeId: 'ta', iterations: null });
        await engine.stop();
      }
    });

    it('reports nothing, and still plays, when the sound never reports a duration', async () => {
      const { playlist, sA } = buildTimedGraph({ mode: 'count', count: 1 });
      sA.sound.duration = 0;
      sA.sound.loaded = false;
      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      await vi.advanceTimersByTimeAsync(3000);

      expect(controller.playTrack).toHaveBeenCalledWith(sA);
      expect(engine.activityState.activeTimings).toEqual([]);
    });

    it('drops the timing once the track advances, so the drain stops', async () => {
      const sA = createMockSound('sa', 'Track A');
      sA.sound.duration = 30;
      const sB = createMockSound('sb', 'Track B');
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 1 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();
      expect(engine.activityState.activeTimings.map((t) => t.nodeId)).toEqual(['ta']);

      await fireEnd(sA);
      expect(engine.activityState.activeTimings.map((t) => t.nodeId)).not.toContain('ta');
    });

    it("does not cancel the exit schedule's own duration probe", async () => {
      // Both probes run against the same node from the same _enterTrack call and
      // both retry on the shared EngineClock, where scheduling an id REPLACES it.
      // Under one key the two chains overwrite each other, whichever loses never
      // fires again, and a loop-counted track then never advances - silently.
      const sA = createMockSound('sa', 'Track A');
      const sB = createMockSound('sb', 'Track B');
      sA.sound.loaded = false;
      sA.sound.duration = 0;
      const playlist = createMockPlaylist('pl1', 'Graph', [sA, sB], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'ta', type: 'track', soundId: 'sa', loop: { mode: 'count', count: 2 } },
          { id: 'tb', type: 'track', soundId: 'sb', loop: { mode: 'count', count: 1 } }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'ta' }, { id: 'e2', from: 'ta', to: 'tb' }]
      });

      vi.useFakeTimers();
      const engine = new CustomPlaybackEngine({ playlist }, controller);
      await engine.start();

      sA.sound.loaded = true;
      sA.sound.duration = 1;
      await vi.advanceTimersByTimeAsync(3000);

      // Both probes landed: the track advanced on its 2-loop schedule, AND the
      // editor got a timing for it before it did.
      // The exit is armed rather than immediate: the next track's document
      // update goes out now, and the outgoing track is cut one hand-off lead
      // later, at the seam its audio actually starts on. See _tryArmTimedExit.
      // 400ms comfortably clears the 245ms lead an untimed engine defaults to
      // (DEFAULT_UPDATE_RTT_MS; mocked round-trips are 0ms and never sampled).
      await vi.advanceTimersByTimeAsync(400);
      expect(controller.stopTrack).toHaveBeenCalledWith(sA);
      expect(controller.playTrack).toHaveBeenLastCalledWith(sB);
      expect(timings()[0]).toMatchObject({ nodeId: 'ta', durationMs: 1000, iterations: 2 });
    });
  });
});
