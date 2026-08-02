import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupFoundryMocks } from './mocks/foundry.mjs';

setupFoundryMocks();

import { applyMixToPlaylist, applyMixToSound, clearSolo, getPlaylistMix, getSoloIds, handleUpdatePlaylistMix, handleUpdatePlaylistSoundMix, mixedVolume, playlistNeedsMix, toggleSolo } from '../scripts/playlist-mix-apply.mjs';

/**
 * A playlist and its sounds in the shape this module actually reads: PlaylistSound#parent is the
 * Playlist document itself, and the mix is a flag on it.
 */
function makePlaylist(id, mix, sounds) {
  const playlist = {
    id,
    name: `Playlist ${id}`,
    getFlag: (mod, key) => (mod === 'game-orchestra' && key === 'mix' ? mix : undefined)
  };
  const docs = sounds.map((spec) => {
    const raw = { playing: spec.audioPlaying ?? spec.playing ?? false, fade: vi.fn(), volume: 1 };
    return { id: spec.id, name: spec.id, volume: spec.volume ?? 1, playing: spec.playing ?? false, parent: playlist, sound: raw };
  });
  playlist.sounds = docs;
  playlist.sounds.get = (soundId) => docs.find((d) => d.id === soundId);
  return { playlist, sounds: docs };
}

const fadeCallsFor = (sound) => sound.sound.fade.mock.calls;

beforeEach(() => {
  clearSolo('p1');
  clearSolo('p2');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getPlaylistMix', () => {
  it('reads the game-orchestra.mix flag, and survives a playlist that has none', () => {
    const { playlist } = makePlaylist('p1', { gain: 0.5 }, []);
    expect(getPlaylistMix(playlist)).toEqual({ gain: 0.5 });
    expect(getPlaylistMix(null)).toBeNull();
    expect(getPlaylistMix({})).toBeNull();
  });
});

describe('mixedVolume', () => {
  it('is the document volume when nothing is configured', () => {
    const { sounds } = makePlaylist('p1', null, [{ id: 's1', volume: 0.6 }]);
    expect(mixedVolume(sounds[0])).toBe(0.6);
  });

  it('applies the playlist gain and ceiling', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5, ceiling: 0.2 }, [{ id: 's1', volume: 1 }]);
    expect(mixedVolume(sounds[0])).toBe(0.2);
  });

  it('honours a stored mute', () => {
    const { sounds } = makePlaylist('p1', { muted: { s1: true } }, [{ id: 's1', volume: 1 }, { id: 's2', volume: 1 }]);
    expect(mixedVolume(sounds[0])).toBe(0);
    expect(mixedVolume(sounds[1])).toBe(1);
  });

  it('silences everything but the soloed sounds while a solo is live', () => {
    const { sounds } = makePlaylist('p1', null, [{ id: 's1', volume: 1 }, { id: 's2', volume: 1 }]);
    toggleSolo('p1', 's1');
    expect(mixedVolume(sounds[0])).toBe(1);
    expect(mixedVolume(sounds[1])).toBe(0);
  });

  it('returns 0 rather than throwing for a missing sound', () => {
    expect(mixedVolume(null)).toBe(0);
  });
});

describe('solo state', () => {
  it('toggles on and off, and reports the new state', () => {
    expect(toggleSolo('p1', 's1')).toBe(true);
    expect(getSoloIds('p1')).toEqual(new Set(['s1']));
    expect(toggleSolo('p1', 's1')).toBe(false);
    expect(getSoloIds('p1').size).toBe(0);
  });

  it('is scoped per playlist, so soloing in one mixer cannot silence another playlist', () => {
    toggleSolo('p1', 's1');
    expect(getSoloIds('p2').size).toBe(0);
  });

  it('is dropped entirely by clearSolo - a solo outliving its window would silence tracks with no visible cause', () => {
    toggleSolo('p1', 's1');
    clearSolo('p1');
    expect(getSoloIds('p1').size).toBe(0);
  });
});

describe('playlistNeedsMix', () => {
  it('is false for the overwhelmingly common untouched playlist', () => {
    const { playlist } = makePlaylist('p1', null, []);
    expect(playlistNeedsMix(playlist)).toBe(false);
    expect(playlistNeedsMix(null)).toBe(false);
  });

  it('is true once a level is set, or a solo is live', () => {
    const { playlist } = makePlaylist('p1', { gain: 0.5 }, []);
    expect(playlistNeedsMix(playlist)).toBe(true);

    const { playlist: plain } = makePlaylist('p1', null, []);
    toggleSolo('p1', 's1');
    expect(playlistNeedsMix(plain)).toBe(true);
  });
});

describe('applyMixToSound', () => {
  it('fades a playing sound to its mixed volume', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    applyMixToSound(sounds[0], { duration: 0 });
    expect(fadeCallsFor(sounds[0])[0]).toEqual([0.5, { duration: 0 }]);
  });

  it('does nothing for a sound the document says is not playing', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: false, audioPlaying: true }]);
    applyMixToSound(sounds[0]);
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });

  it('waits for audio that has not started yet, rather than dropping the change', () => {
    // PlaylistSound#sync() starts playback with an async load({autoplay}), so on the update that
    // begins a track there is a window where the document says playing and there is no audio yet.
    vi.useFakeTimers();
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: false }]);
    applyMixToSound(sounds[0], { duration: 0 });
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);

    sounds[0].sound.playing = true;
    vi.advanceTimersByTime(200);
    expect(fadeCallsFor(sounds[0])[0]).toEqual([0.5, { duration: 0 }]);
  });

  it('gives up rather than retrying forever when the audio never arrives', () => {
    vi.useFakeTimers();
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: false }]);
    applyMixToSound(sounds[0]);
    vi.advanceTimersByTime(60_000);
    sounds[0].sound.playing = true;
    vi.advanceTimersByTime(60_000);
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });

  it('abandons the wait if the document stops in the meantime - sync() owns the stop', () => {
    vi.useFakeTimers();
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: false }]);
    applyMixToSound(sounds[0]);
    sounds[0].playing = false;
    sounds[0].sound.playing = true;
    vi.advanceTimersByTime(500);
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });
});

describe('applyMixToPlaylist', () => {
  it('re-levels every playing sound and leaves the stopped ones alone', () => {
    const { playlist, sounds } = makePlaylist('p1', { gain: 0.5 }, [
      { id: 's1', volume: 1, playing: true, audioPlaying: true },
      { id: 's2', volume: 1, playing: false, audioPlaying: false }
    ]);
    applyMixToPlaylist(playlist, { duration: 0 });
    expect(fadeCallsFor(sounds[0])).toHaveLength(1);
    expect(fadeCallsFor(sounds[1])).toHaveLength(0);
  });

  it('never stops or restarts anything - the whole point of the mix living in its own flag', () => {
    const { playlist, sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    applyMixToPlaylist(playlist);
    expect(sounds[0].playing).toBe(true);
    expect(sounds[0].sound.playing).toBe(true);
  });
});

describe('handleUpdatePlaylistSoundMix', () => {
  it('re-asserts when a sound starts', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistSoundMix(sounds[0], { playing: true });
    // No glide on a start, or the first tenth of a second plays at the unmixed volume.
    expect(fadeCallsFor(sounds[0])[0]).toEqual([0.5, { duration: 0 }]);
  });

  it('re-asserts when the volume changes underneath us (the sidebar slider, a macro)', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistSoundMix(sounds[0], { volume: 0.8 });
    expect(fadeCallsFor(sounds[0])[0][1].duration).toBeGreaterThan(0);
  });

  it('ignores updates that touch neither', () => {
    const { sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistSoundMix(sounds[0], { pausedTime: 12 });
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });

  it('does no work at all for a playlist with no mix', () => {
    const { sounds } = makePlaylist('p1', null, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistSoundMix(sounds[0], { playing: true });
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });
});

describe('handleUpdatePlaylistMix', () => {
  it('re-levels the playlist when the mix flag changes', () => {
    const { playlist, sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistMix(playlist, { flags: { 'game-orchestra': { mix: { gain: 0.5 } } } });
    expect(fadeCallsFor(sounds[0])).toHaveLength(1);
  });

  it('also fires on the unset form, so a Reset is applied and not just saved', () => {
    const { playlist, sounds } = makePlaylist('p1', null, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistMix(playlist, { flags: { 'game-orchestra': { '-=mix': null } } });
    expect(fadeCallsFor(sounds[0])).toHaveLength(1);
  });

  it('ignores a customPlayback change - that one belongs to the engine rebuild (H8), not here', () => {
    const { playlist, sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistMix(playlist, { flags: { 'game-orchestra': { customPlayback: { version: 1 } } } });
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });

  it('ignores an update with no flags at all', () => {
    const { playlist, sounds } = makePlaylist('p1', { gain: 0.5 }, [{ id: 's1', volume: 1, playing: true, audioPlaying: true }]);
    handleUpdatePlaylistMix(playlist, { name: 'Renamed' });
    expect(fadeCallsFor(sounds[0])).toHaveLength(0);
  });
});
