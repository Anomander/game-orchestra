import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { PlaylistMixerApp } from '../scripts/playlist-mixer.mjs';
import { refreshMixerViews, MixerController } from '../scripts/playlist-mixer-controller.mjs';

/**
 * The window is a thin ApplicationV2 shell over MixerController (which the graph editor's pane
 * shares) - so what is worth testing here is the shell: identity, lifecycle, and the refresh
 * plumbing. The behaviour itself lives in playlist-mixer-controller.test.mjs.
 */
function makePlaylist(sounds = []) {
  const playlist = createMockPlaylist('pl1', 'Ambience', sounds);
  for (const sound of sounds) sound.parent = Object.assign(sound.parent, { id: playlist.id, getFlag: playlist.getFlag, sounds: playlist.sounds });
  game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));
  return playlist;
}

beforeEach(() => {
  foundry.applications.instances = new Map();
});

describe('PlaylistMixerApp', () => {
  it('takes an id derived from the playlist, which is what makes it one window per playlist', () => {
    const app = new PlaylistMixerApp(makePlaylist());
    expect(app.options.id).toBe('game-orchestra-mixer-pl1');
    app.controller.teardown();
  });

  it('owns a controller with the keyboard shortcuts on - unlike the editor pane, nothing else here wants those keys', () => {
    const app = new PlaylistMixerApp(makePlaylist());
    expect(app.controller).toBeInstanceOf(MixerController);
    expect(app.controller.keyboard).toBe(true);
    expect(app.controller.compact).toBe(false);
    app.controller.teardown();
  });

  it('tears the controller down when the window closes, so no solo or pending write outlives it', () => {
    const app = new PlaylistMixerApp(makePlaylist());
    const teardown = vi.spyOn(app.controller, 'teardown');

    app._onClose({});

    expect(teardown).toHaveBeenCalled();
  });

  it('re-attaches the delegated listeners on every render, onto the container ApplicationV2 keeps', () => {
    const app = new PlaylistMixerApp(makePlaylist([createMockSound('s1', 'A')]));
    const attach = vi.spyOn(app.controller, 'attach');
    const content = { innerHTML: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: () => null };

    app._replaceHTML('<p>x</p>', content, {});

    expect(content.innerHTML).toBe('<p>x</p>');
    expect(attach).toHaveBeenCalledWith(content);
    app.controller.teardown();
  });
});

describe('PlaylistMixerApp.open', () => {
  it('brings an already-open mixer forward instead of opening a second one for the same playlist', () => {
    const playlist = makePlaylist();
    const existing = { bringToFront: vi.fn(), rendered: true };
    foundry.applications.instances.set('game-orchestra-mixer-pl1', existing);

    expect(PlaylistMixerApp.open(playlist)).toBe(existing);
    expect(existing.bringToFront).toHaveBeenCalled();
  });

  it('is a no-op for a missing playlist rather than opening an empty window', () => {
    expect(PlaylistMixerApp.open(null)).toBeNull();
  });
});

describe('refreshMixerViews', () => {
  it('refreshes every live view of that playlist - the window and the editor pane can both be open', () => {
    const playlist = makePlaylist();
    const first = vi.fn();
    const second = vi.fn();
    const controllers = [
      new MixerController({ playlistId: 'pl1', onRefresh: first }),
      new MixerController({ playlistId: 'pl1', onRefresh: second })
    ];

    refreshMixerViews(playlist);

    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    for (const controller of controllers) controller.teardown();
  });

  it('leaves views of other playlists alone', () => {
    const onRefresh = vi.fn();
    const controller = new MixerController({ playlistId: 'other', onRefresh });

    refreshMixerViews(makePlaylist());

    expect(onRefresh).not.toHaveBeenCalled();
    controller.teardown();
  });

  it('holds off while a slider is being dragged - a rebuild would replace the element under the pointer', () => {
    const onRefresh = vi.fn();
    const controller = new MixerController({ playlistId: 'pl1', onRefresh });
    controller.attach({ querySelector: () => ({}), addEventListener: vi.fn(), removeEventListener: vi.fn() });

    refreshMixerViews(makePlaylist());

    expect(onRefresh).not.toHaveBeenCalled();
    controller.teardown();
  });

  it('stops refreshing a torn-down view, so a closed window is never rendered into', () => {
    const onRefresh = vi.fn();
    const controller = new MixerController({ playlistId: 'pl1', onRefresh });
    controller.teardown();

    refreshMixerViews(makePlaylist());

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does nothing for a missing playlist', () => {
    expect(() => refreshMixerViews(null)).not.toThrow();
  });
});
