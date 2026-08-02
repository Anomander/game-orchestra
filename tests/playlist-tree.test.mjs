import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, MockDocument, createMockPlaylist } from './mocks/foundry.mjs';

setupFoundryMocks();

import { PlaylistTreeApp } from '../scripts/playlist-tree.mjs';
import { CONST } from '../scripts/config.mjs';

describe('PlaylistTreeApp', () => {
  let app;
  let scene1;

  beforeEach(() => {
    setupFoundryMocks();
    scene1 = new MockDocument({
      name: 'Sunken Temple',
      id: 'sc1',
      getFlag: vi.fn((mod, key) => {
        if (key === 'music.area.playlist') return 'pl-area';
        if (key === 'music.area.overlays.boss.playlist') return 'pl-boss';
        return null;
      }),
      setFlag: vi.fn().mockResolvedValue(),
      unsetFlag: vi.fn().mockResolvedValue()
    });
    game.scenes = [scene1];
    game.scenes.get = vi.fn((id) => (id === 'sc1' ? scene1 : null));
    game.scenes.active = scene1;

    const pl1 = createMockPlaylist('pl-area', 'Area Playlist', []);
    const pl2 = createMockPlaylist('pl-boss', 'Boss Playlist', []);
    game.playlists = [pl1, pl2];

    game.gameOrchestra = {
      playlistTree: null,
      musicController: {
        currentContext: null,
        playCurrentTrack: vi.fn()
      }
    };

    app = new PlaylistTreeApp();
  });

  describe('_prepareContext', () => {
    it('prepares context data with scene list, selected scene defaults, moods, and global settings', () => {
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      setMockSetting('game-orchestra', 'configuredMoods', [{ id: 'boss', label: 'Boss', icon: 'fas fa-skull', color: '#f44336' }]);
      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: {
          'game-orchestra': {
            music: {
              area: { playlist: 'g-area', overlays: { boss: { playlist: 'g-boss' } } }
            }
          }
        }
      });

      const ctx = app._prepareContext({});

      expect(ctx.scenes).toHaveLength(1);
      expect(ctx.scenes[0].id).toBe('sc1');
      expect(ctx.selectedSceneId).toBe('sc1');

      expect(ctx.sceneDefaults.area.playlistId).toBe('pl-area');
      expect(ctx.sceneMoods.find((m) => m.moodId === 'boss').area.playlistId).toBe('pl-boss');

      expect(ctx.globalDefaults.area.playlistId).toBe('g-area');
      expect(ctx.globalMoods.find((m) => m.moodId === 'boss').area.playlistId).toBe('g-boss');
    });

    it('keeps scene/global phases separate from moods, reading combat overlays instead of area ones', () => {
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'enrage', label: 'Enrage', icon: 'fas fa-fire', color: '#f44336' }]);
      scene1.getFlag = vi.fn((mod, key) => {
        if (key === 'music.combat.overlays.enrage.playlist') return 'pl-boss';
        return null;
      });

      const ctx = app._prepareContext({});

      expect(ctx.scenePhases.find((p) => p.phaseId === 'enrage').combat.playlistId).toBe('pl-boss');
      // A combat overlay must never leak into the moods (area) grid.
      expect(ctx.sceneMoods.some((m) => m.hasOverride)).toBe(false);
    });

    it('populates activeResolutionInfo when musicController has currentContext resolved via a mood overlay', () => {
      game.gameOrchestra.musicController.currentContext = {
        contextEntity: scene1,
        isOverlay: true,
        overlayAxis: 'mood',
        context: 'area'
      };
      setMockSetting('game-orchestra', 'activeMood', 'boss');

      const ctx = app._prepareContext({});

      expect(ctx.activeResolutionInfo).toBeDefined();
      expect(ctx.activeResolutionInfo.label).toContain('GameOrchestra.PlaylistTree.ActiveAudioSceneMood');
      expect(ctx.activeResolutionInfo.label).toContain('boss');
    });

    it('populates activeResolutionInfo when musicController has currentContext resolved via a phase overlay', () => {
      game.gameOrchestra.musicController.currentContext = {
        contextEntity: scene1,
        isOverlay: true,
        overlayAxis: 'phase',
        context: 'combat'
      };
      setMockSetting('game-orchestra', 'activePhase', 'enrage');

      const ctx = app._prepareContext({});

      expect(ctx.activeResolutionInfo.label).toContain('GameOrchestra.PlaylistTree.ActiveAudioScenePhase');
      expect(ctx.activeResolutionInfo.label).toContain('enrage');
    });
  });

  describe('handleSelectScene', () => {
    it('updates selectedSceneId and re-renders app', () => {
      const renderSpy = vi.spyOn(app, 'render').mockImplementation(() => {});
      game.gameOrchestra.playlistTree = app;

      const event = { preventDefault: vi.fn() };
      const target = { value: 'sc1', closest: () => null };

      PlaylistTreeApp.handleSelectScene.call(app, event, target);

      expect(app.selectedSceneId).toBe('sc1');
      expect(renderSpy).toHaveBeenCalledWith(false);
    });
  });

  describe('handleUpdateSceneOverlay and handleClearSceneOverlay (area -> mood axis)', () => {
    it('sets scene mood-overlay flag when playlistId is provided', async () => {
      game.gameOrchestra.playlistTree = app;
      app.selectedSceneId = 'sc1';

      const target = {
        value: 'pl-boss',
        dataset: { moodId: 'boss', contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateSceneOverlay(new Event('change'), target);

      expect(scene1.setFlag).toHaveBeenCalledWith('game-orchestra', 'music.area.overlays.boss.playlist', 'pl-boss');
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
    });

    it('unsets scene mood-overlay flag when clearing', async () => {
      game.gameOrchestra.playlistTree = app;
      app.selectedSceneId = 'sc1';

      const event = { preventDefault: vi.fn() };
      const target = {
        dataset: { moodId: 'boss', contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleClearSceneOverlay(event, target);

      expect(scene1.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'music.area.overlays.boss.playlist');
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
    });
  });

  describe('handleUpdateSceneOverlay (combat -> phase axis)', () => {
    it('reads data-phase-id, not data-mood-id, for a combat context', async () => {
      game.gameOrchestra.playlistTree = app;
      app.selectedSceneId = 'sc1';

      const target = {
        value: 'pl-boss',
        dataset: { phaseId: 'enrage', moodId: 'ignored-since-combat-is-phase-axis', contextType: 'combat' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateSceneOverlay(new Event('change'), target);

      expect(scene1.setFlag).toHaveBeenCalledWith('game-orchestra', 'music.combat.overlays.enrage.playlist', 'pl-boss');
    });
  });

  describe('handleUpdateSceneDefault and handleClearSceneDefault', () => {
    it('sets scene default flag when playlist is selected', async () => {
      game.gameOrchestra.playlistTree = app;
      app.selectedSceneId = 'sc1';

      const target = {
        value: 'pl-area',
        dataset: { contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateSceneDefault(new Event('change'), target);

      expect(scene1.setFlag).toHaveBeenCalledWith('game-orchestra', 'music.area.playlist', 'pl-area');
    });

    it('unsets scene default flag when clearing scene default', async () => {
      game.gameOrchestra.playlistTree = app;
      app.selectedSceneId = 'sc1';

      const event = { preventDefault: vi.fn() };
      const target = {
        dataset: { contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleClearSceneDefault(event, target);

      expect(scene1.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'music.area.playlist');
    });
  });

  describe('handleUpdateGlobalOverlay (combat -> phase axis) and handleClearGlobalOverlay', () => {
    it('updates defaultMusic setting with a global phase override', async () => {
      game.gameOrchestra.playlistTree = app;
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });

      const target = {
        value: 'pl-boss',
        dataset: { phaseId: 'boss', contextType: 'combat' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateGlobalOverlay(new Event('change'), target);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.defaultMusic,
        expect.objectContaining({
          data: expect.objectContaining({
            'game-orchestra': expect.objectContaining({
              music: expect.objectContaining({
                combat: expect.objectContaining({
                  overlays: expect.objectContaining({
                    boss: { playlist: 'pl-boss' }
                  })
                })
              })
            })
          })
        })
      );
    });
  });

  describe('handleUpdateGlobalOverlay (area -> mood axis)', () => {
    it('updates defaultMusic setting with a global mood override', async () => {
      game.gameOrchestra.playlistTree = app;
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });

      const target = {
        value: 'pl-boss',
        dataset: { moodId: 'boss', contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateGlobalOverlay(new Event('change'), target);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.defaultMusic,
        expect.objectContaining({
          data: expect.objectContaining({
            'game-orchestra': expect.objectContaining({
              music: expect.objectContaining({
                area: expect.objectContaining({
                  overlays: expect.objectContaining({
                    boss: { playlist: 'pl-boss' }
                  })
                })
              })
            })
          })
        })
      );
    });
  });

  describe('handleUpdateGlobalDefault and handleClearGlobalDefault', () => {
    it('updates defaultMusic setting with global default override', async () => {
      game.gameOrchestra.playlistTree = app;
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });

      const target = {
        value: 'pl-area',
        dataset: { contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateGlobalDefault(new Event('change'), target);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.defaultMusic,
        expect.objectContaining({
          data: expect.objectContaining({
            'game-orchestra': expect.objectContaining({
              music: expect.objectContaining({
                area: expect.objectContaining({ playlist: 'pl-area' })
              })
            })
          })
        })
      );
    });
  });

  describe('toggle and open static methods', () => {
    it('opens PlaylistTreeApp window when not already open', () => {
      PlaylistTreeApp.open();
      expect(game.gameOrchestra.playlistTree).toBeInstanceOf(PlaylistTreeApp);
    });

    it('toggles existing window closed when open', () => {
      const mockClose = vi.fn();
      game.gameOrchestra.playlistTree = { rendered: true, close: mockClose };

      PlaylistTreeApp.toggle();

      expect(mockClose).toHaveBeenCalled();
      expect(game.gameOrchestra.playlistTree).toBeNull();
    });
  });

  describe('instance registration (regression: a window opened via the settings menu - which instantiates the class directly, bypassing open() - was invisible to _refreshUI/_resolveInstance/toggle)', () => {
    it('registers itself as game.gameOrchestra.playlistTree from the constructor, not only from open()', () => {
      game.gameOrchestra.playlistTree = null;
      const direct = new PlaylistTreeApp();
      expect(game.gameOrchestra.playlistTree).toBe(direct);
    });

    it('clears game.gameOrchestra.playlistTree on close, but only if it is still the current instance', () => {
      const first = new PlaylistTreeApp();
      expect(game.gameOrchestra.playlistTree).toBe(first);

      first._onClose({});
      expect(game.gameOrchestra.playlistTree).toBeNull();
    });

    it('does not clear a newer instance registered after this one on close (stale close from an old window)', () => {
      const first = new PlaylistTreeApp();
      const second = new PlaylistTreeApp(); // supersedes `first` as the registered instance

      first._onClose({});

      expect(game.gameOrchestra.playlistTree).toBe(second);
    });

    it('_resolveInstance prefers the instance a handler actually ran on over a different globally-registered window', () => {
      const windowA = new PlaylistTreeApp();
      const windowB = new PlaylistTreeApp(); // now the globally-registered one

      // A static handler dispatched on windowA (its own instance is `this`)
      // must resolve back to windowA, not silently redirect to windowB.
      expect(PlaylistTreeApp._resolveInstance(windowA)).toBe(windowA);
      expect(PlaylistTreeApp._resolveInstance(windowB)).toBe(windowB);
    });

    it('_resolveInstance falls back to the global when context is not a PlaylistTreeApp instance (a static handler invoked with a bare `this`)', () => {
      const instance = new PlaylistTreeApp();
      expect(PlaylistTreeApp._resolveInstance(undefined)).toBe(instance);
    });
  });

  describe('Track Selection & Soundboard Validation', () => {
    it('updates initialTrack flag when selecting a track', async () => {
      game.gameOrchestra.playlistTree = app;
      const target = {
        value: 'tr-boss-1',
        dataset: { moodId: 'boss', contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateSceneOverlayTrack(new Event('change'), target);

      expect(scene1.setFlag).toHaveBeenCalledWith(
        CONST.moduleId,
        'music.area.overlays.boss.initialTrack',
        'tr-boss-1'
      );
    });

    it('automatically assigns first track when selecting a Soundboard playlist with no track set', async () => {
      game.gameOrchestra.playlistTree = app;
      const soundboardPlaylist = createMockPlaylist('pl-sfx', 'SFX Soundboard', [{ id: 'tr-sfx-1', name: 'Roar' }]);
      soundboardPlaylist.mode = -1; // UNSEQUENCED mode
      game.playlists.push(soundboardPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-sfx' ? soundboardPlaylist : null));

      const target = {
        value: 'pl-sfx',
        dataset: { moodId: 'boss', contextType: 'area' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateSceneOverlay(new Event('change'), target);

      expect(scene1.setFlag).toHaveBeenCalledWith(
        CONST.moduleId,
        'music.area.overlays.boss.playlist',
        'pl-sfx'
      );
      expect(scene1.setFlag).toHaveBeenCalledWith(
        CONST.moduleId,
        'music.area.overlays.boss.initialTrack',
        'tr-sfx-1'
      );
    });

    it('automatically assigns first track when selecting a Soundboard playlist for the global default (no overlay)', async () => {
      game.gameOrchestra.playlistTree = app;
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });
      const soundboardPlaylist = createMockPlaylist('pl-sfx', 'SFX Soundboard', [{ id: 'tr-sfx-1', name: 'Roar' }]);
      soundboardPlaylist.mode = -1; // UNSEQUENCED mode
      game.playlists.push(soundboardPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-sfx' ? soundboardPlaylist : null));

      const target = {
        value: 'pl-sfx',
        dataset: { contextType: 'combat' },
        closest: () => null
      };

      await PlaylistTreeApp.handleUpdateGlobalDefault(new Event('change'), target);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.defaultMusic,
        expect.objectContaining({
          data: expect.objectContaining({
            'game-orchestra': expect.objectContaining({
              music: expect.objectContaining({
                combat: { playlist: 'pl-sfx', initialTrack: 'tr-sfx-1' }
              })
            })
          })
        })
      );
    });
  });

  describe('_onChangeInput', () => {
    it('dispatches select change events based on data-change-action', () => {
      game.gameOrchestra.playlistTree = app;
      const spy = vi.spyOn(PlaylistTreeApp, 'handleSelectScene').mockImplementation(() => {});

      const selectEl = {
        tagName: 'SELECT',
        dataset: { changeAction: 'selectScene' }
      };

      app._onChangeInput({ target: selectEl });

      expect(spy).toHaveBeenCalledWith(expect.anything(), selectEl);
      spy.mockRestore();
    });
  });

  describe('handleOpenMoodConfig', () => {
    it('instantiates and renders MoodConfigApp when clicked', () => {
      const event = { preventDefault: vi.fn() };
      PlaylistTreeApp.handleOpenMoodConfig(event, null);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('handleOpenPhaseConfig', () => {
    it('instantiates and renders PhaseConfigApp when clicked', () => {
      const event = { preventDefault: vi.fn() };
      PlaylistTreeApp.handleOpenPhaseConfig(event, null);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('handleOpenCustomGraph', () => {
    it('is wired up as an action', () => {
      expect(PlaylistTreeApp.DEFAULT_OPTIONS.actions.openCustomGraph).toBe(PlaylistTreeApp.handleOpenCustomGraph);
    });

    it('opens the graph editor for the playlist named on the button', () => {
      const playlist = createMockPlaylist('pl-custom', 'Custom Playlist', []);
      game.playlists.get = vi.fn((id) => (id === 'pl-custom' ? playlist : null));
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { playlistId: 'pl-custom' }, closest: () => null };

      expect(() => PlaylistTreeApp.handleOpenCustomGraph(event, target)).not.toThrow();

      expect(event.preventDefault).toHaveBeenCalled();
      expect(game.playlists.get).toHaveBeenCalledWith('pl-custom');
    });

    it("resolves the playlist id from the button when the click lands on its inner icon", () => {
      const playlist = createMockPlaylist('pl-custom', 'Custom Playlist', []);
      game.playlists.get = vi.fn(() => playlist);
      const button = { dataset: { playlistId: 'pl-custom' } };
      const icon = { dataset: {}, closest: (sel) => (sel === '[data-playlist-id]' ? button : null) };

      PlaylistTreeApp.handleOpenCustomGraph({ preventDefault: vi.fn() }, icon);

      expect(game.playlists.get).toHaveBeenCalledWith('pl-custom');
    });

    it('logs and no-ops when the playlist no longer exists', () => {
      game.playlists.get = vi.fn(() => null);
      const target = { dataset: { playlistId: 'gone' }, closest: () => null };

      expect(() => PlaylistTreeApp.handleOpenCustomGraph({ preventDefault: vi.fn() }, target)).not.toThrow();
    });
  });

  describe('handleToggleSection and isSectionCollapsed', () => {
    it('toggles section key in expanded/collapsed sets and re-renders app', () => {
      game.gameOrchestra.playlistTree = app;
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { section: 'sceneMoods', defaultCollapsed: 'false' }, closest: () => null };

      PlaylistTreeApp.handleToggleSection(event, target);

      expect(app.collapsedSections.has('sceneMoods')).toBe(true);

      PlaylistTreeApp.handleToggleSection(event, target);

      expect(app.expandedSections.has('sceneMoods')).toBe(true);
    });

    it('defaults to collapsed when an item has no overrides, and expanded when it has overrides', () => {
      expect(app.isSectionCollapsed('key1', true)).toBe(false); // Expanded
      expect(app.isSectionCollapsed('key2', false)).toBe(true); // Collapsed
    });
  });

  describe('_onRender event listener management', () => {
    it('attaches change and dragleave listeners only once each, even after multiple _onRender calls', () => {
      const mockElement = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };
      app.element = mockElement;

      app._onRender({}, {});
      app._onRender({}, {});
      app._onRender({}, {});

      expect(mockElement.addEventListener).toHaveBeenCalledTimes(2);
      expect(mockElement.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
      expect(mockElement.addEventListener).toHaveBeenCalledWith('dragleave', expect.any(Function));
    });

    it('removes change and dragleave listeners on _onClose and resets flags', () => {
      const mockElement = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      };
      app.element = mockElement;

      app._onRender({}, {});
      expect(app._changeListenerBound).toBe(true);
      expect(app._dragLeaveListenerBound).toBe(true);

      app._onClose({});
      expect(mockElement.removeEventListener).toHaveBeenCalledWith('change', app._onChangeInputHandler);
      expect(mockElement.removeEventListener).toHaveBeenCalledWith('dragleave', app._onDragLeaveHandler);
      expect(app._changeListenerBound).toBe(false);
      expect(app._dragLeaveListenerBound).toBe(false);
    });

    it('rebinds drag/drop on every _onRender call, not just the first', () => {
      const mockElement = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: vi.fn(() => [])
      };
      app.element = mockElement;
      foundry.applications.ux.DragDrop.resetBindCallCount();

      app._onRender({}, {});
      app._onRender({}, {});
      app._onRender({}, {});

      // One DragDrop config entry x three renders - each render must rebind,
      // since HandlebarsApplicationMixin replaces the part's DOM wholesale on
      // every render (the boxes DragDrop targets are not the persistent root
      // that change/dragleave delegate from). Binding only once would leave
      // drop handlers attached to elements that no longer exist after the
      // window's first re-render - see PlaylistTreeApp._setupDragDrop's docstring.
      expect(foundry.applications.ux.DragDrop.bindCallCount).toBe(PlaylistTreeApp.DEFAULT_OPTIONS.dragDrop.length * 3);
    });

    it('regression: a dropzone recreated by a later render still receives a working drop handler', () => {
      // Simulates what HandlebarsApplicationMixin actually does: the `main`
      // part's DOM is discarded and rebuilt on each render, so a box element
      // queried during render N is never the one present during render N+1.
      function makeBox() {
        return { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
      }
      const firstRenderBox = makeBox();
      const secondRenderBox = makeBox();
      const mockElement = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: vi.fn().mockReturnValueOnce([firstRenderBox]).mockReturnValueOnce([secondRenderBox])
      };
      app.element = mockElement;

      app._onRender({}, {}); // binds firstRenderBox
      app._onRender({}, {}); // firstRenderBox is now detached; secondRenderBox replaces it

      expect(firstRenderBox.listeners.drop).toBeInstanceOf(Function);
      expect(secondRenderBox.listeners.drop).toBeInstanceOf(Function);
    });

  });

  describe('_onDropExternal (drag-and-drop from the Playlists directory)', () => {
    class MockPlaylistDoc {
      constructor(data) {
        Object.assign(this, data);
      }
    }
    class MockPlaylistSoundDoc {
      constructor(data) {
        Object.assign(this, data);
      }
    }

    beforeEach(() => {
      globalThis.Playlist = MockPlaylistDoc;
      globalThis.PlaylistSound = MockPlaylistSoundDoc;
    });

    function makeDropEvent(payload, dataset) {
      return {
        currentTarget: { classList: { add: vi.fn(), remove: vi.fn() }, dataset },
        dataTransfer: { getData: vi.fn(() => JSON.stringify(payload)) }
      };
    }

    it('assigns a dropped Playlist to a scene mood area box', async () => {
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-area', name: 'Area Playlist', mode: 0 });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-area' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-area' }, { dropScope: 'scene', contextType: 'area', moodId: 'boss' });

      const result = await app._onDropExternal(event);

      expect(result).toBe(true);
      expect(scene1.setFlag).toHaveBeenCalledWith(CONST.moduleId, 'music.area.overlays.boss.playlist', 'pl-area');
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
    });

    it('assigns a dropped Playlist to a scene phase combat box, reading data-phase-id', async () => {
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-boss', name: 'Boss Playlist', mode: 0 });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-boss' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-boss' }, { dropScope: 'scene', contextType: 'combat', phaseId: 'enrage' });

      const result = await app._onDropExternal(event);

      expect(result).toBe(true);
      expect(scene1.setFlag).toHaveBeenCalledWith(CONST.moduleId, 'music.combat.overlays.enrage.playlist', 'pl-boss');
    });

    it('assigns a dropped PlaylistSound as the exact track on the global default combat box', async () => {
      const parentPlaylist = { id: 'pl-combat', name: 'Combat Playlist' };
      const droppedSound = new MockPlaylistSoundDoc({ id: 'tr-1', name: 'Track One', parent: parentPlaylist });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedSound);
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });

      const event = makeDropEvent({ type: 'PlaylistSound', uuid: 'Playlist.pl-combat.PlaylistSound.tr-1' }, { dropScope: 'global', contextType: 'combat' });

      const result = await app._onDropExternal(event);

      expect(result).toBe(true);
      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.defaultMusic,
        expect.objectContaining({
          data: expect.objectContaining({
            'game-orchestra': expect.objectContaining({
              music: expect.objectContaining({
                combat: { playlist: 'pl-combat', initialTrack: 'tr-1' }
              })
            })
          })
        })
      );
    });

    it('ignores drops with unsupported document types', async () => {
      globalThis.fromUuid = vi.fn();
      const event = makeDropEvent({ type: 'Actor', uuid: 'Actor.abc' }, {});

      const result = await app._onDropExternal(event);

      expect(result).toBe(false);
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
    });

    it('awaits playCurrentTrack() before re-rendering, rather than racing it', async () => {
      // Regression guard: playCurrentTrack() can itself trigger a second render of this same
      // window (transitionToContext() -> _refreshUI(), see music-controller.mjs) whenever the
      // drop changes the resolved winning context. Two unordered render() calls on one
      // ApplicationV2 instance risk Foundry's DragDrop rebinding (_setupDragDrop(), called from
      // _onRender on every render) against a DOM a second, still-in-flight render is about to
      // replace again - reported as "drag-and-drop stops working after the first successful
      // drop." Awaiting playCurrentTrack() first makes the two renders strictly sequential.
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-area', name: 'Area Playlist', mode: 0 });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-area' ? droppedPlaylist : null));

      let resolvePlayCurrentTrack;
      game.gameOrchestra.musicController.playCurrentTrack = vi.fn(
        () => new Promise((resolve) => (resolvePlayCurrentTrack = resolve))
      );
      const renderSpy = vi.spyOn(app, 'render').mockImplementation(() => {});

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-area' }, { dropScope: 'scene', contextType: 'area', moodId: 'boss' });
      const dropPromise = app._onDropExternal(event);

      // A macrotask flush (not a fixed number of microtask ticks - the exact count between here
      // and the playCurrentTrack() call depends on how many awaits _applySceneEntry() does
      // internally) lets every pending microtask drain, so playCurrentTrack() is guaranteed to
      // have been called by the time this resolves, while render() must still not have fired -
      // its own promise is deliberately left unresolved.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
      expect(renderSpy).not.toHaveBeenCalled();

      resolvePlayCurrentTrack();
      await dropPromise;

      expect(renderSpy).toHaveBeenCalledWith(false);
    });
  });

  describe('_onDragLeaveExternal', () => {
    it('clears drop-hover when the drag genuinely leaves the context box', () => {
      const box = {
        contains: vi.fn(() => false),
        classList: { remove: vi.fn() }
      };
      const child = { closest: vi.fn(() => box) };
      const outsideEl = {};

      app._onDragLeaveExternal({ target: child, relatedTarget: outsideEl });

      expect(box.classList.remove).toHaveBeenCalledWith('drop-hover');
    });

    it('does not clear drop-hover when the drag moves between child elements of the same box', () => {
      const box = {
        contains: vi.fn(() => true),
        classList: { remove: vi.fn() }
      };
      const child = { closest: vi.fn(() => box) };
      const otherChildOfSameBox = {};

      app._onDragLeaveExternal({ target: child, relatedTarget: otherChildOfSameBox });

      expect(box.classList.remove).not.toHaveBeenCalled();
    });

    it('does nothing when the drag leaves an element outside any context box', () => {
      const target = { closest: vi.fn(() => null) };

      expect(() => app._onDragLeaveExternal({ target, relatedTarget: null })).not.toThrow();
    });
  });
});
