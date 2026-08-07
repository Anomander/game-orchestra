import { describe, it, expect, beforeEach, vi } from 'vitest';
// Deliberately no explicit setupFoundryMocks() call here (unlike every other
// test file): merely importing './mocks/foundry.mjs' already runs it once as
// a side effect (see that file's own bottom comment), and ES import hoisting
// means every import in this file - including game-orchestra.mjs below - evaluates
// before any of this file's own body statements. A body-level
// setupFoundryMocks() call would therefore run AFTER game-orchestra.mjs has already
// registered its hooks, replacing globalThis.Hooks with a fresh empty one and
// silently discarding every registration this file exists to verify.
import './mocks/foundry.mjs';

// game-orchestra.mjs is the module's entry point (esmodules[0] in module.json): its
// top-level statements register every Hooks.once/Hooks.on the module has, and
// nothing else in the test suite imports it (each other test file imports its
// own script directly). A typo'd hook name here would ship silently - Foundry
// just never calls the handler - so this test protects the one file with no
// coverage at all (0% in the coverage report) by asserting the exact set of
// registrations, and that the 'init' handler wires up game.gameOrchestra correctly.
import {
  getSceneControlButtons,
  handleCanvasReady,
  handleCreateCombatant,
  handleDeleteCombat,
  handleDeleteCombatant,
  handlePlaylistConfigRender,
  handleReady,
  handleSceneConfigRender,
  handleTokenConfigRender,
  handleUpdateActor,
  handleUpdateCombat,
  handleUpdateCombatant,
  handleUpdatePlaylist,
  handleUpdatePlaylistSound,
  handlePlaylistContextMenu,
  handleUpdateScene,
  handleUpdateToken,
  handleUserConnected
} from '../scripts/hooks.mjs';
import { MusicController } from '../scripts/music-controller.mjs';
import { MoodWidget } from '../scripts/mood-widget.mjs';
import { MoodConfigApp, PhaseConfigApp } from '../scripts/mood-config.mjs';
import { CustomPlaylistEditor } from '../scripts/custom-playlist-editor.mjs';
import { GameOrchestraConfig } from '../scripts/app.mjs';
import { PlaylistMixerApp } from '../scripts/playlist-mixer.mjs';

import '../scripts/game-orchestra.mjs';

describe('game-orchestra.mjs (module entry point)', () => {
  describe('Hooks.on registrations', () => {
    it('registers exactly the expected event -> handler pairs, once each', () => {
      const registered = Hooks.on.mock.calls;
      const expected = [
        ['getSceneControlButtons', getSceneControlButtons],
        ['renderSceneConfig', handleSceneConfigRender],
        ['renderPlaylistConfig', handlePlaylistConfigRender],
        ['updateCombat', handleUpdateCombat],
        ['deleteCombat', handleDeleteCombat],
        ['canvasReady', handleCanvasReady],
        ['updateScene', handleUpdateScene],
        ['updatePlaylist', handleUpdatePlaylist],
        // Runs on every client, unlike the engine's own hooks - volume is applied per client
        // from the document (playlist-mix-apply.mjs).
        ['updatePlaylistSound', handleUpdatePlaylistSound],
        ['getPlaylistContextOptions', handlePlaylistContextMenu],
        ['updateActor', handleUpdateActor],
        ['updateToken', handleUpdateToken],
        ['createCombatant', handleCreateCombatant],
        ['deleteCombatant', handleDeleteCombatant],
        ['updateCombatant', handleUpdateCombatant],
        ['renderTokenApplication', handleTokenConfigRender],
        ['userConnected', handleUserConnected]
      ];

      for (const [event, handler] of expected) {
        const matches = registered.filter(([e, fn]) => e === event && fn === handler);
        expect(matches, `expected exactly one Hooks.on('${event}', <the imported handler>)`).toHaveLength(1);
      }
      expect(registered).toHaveLength(expected.length);
    });
  });

  describe("Hooks.once registrations", () => {
    it("registers 'init' and 'ready' exactly once each, with 'ready' wired to handleReady", () => {
      const registered = Hooks.once.mock.calls;
      const events = registered.map(([event]) => event);
      expect(events.filter((e) => e === 'init')).toHaveLength(1);
      expect(events.filter((e) => e === 'ready')).toHaveLength(1);
      expect(registered).toHaveLength(2);

      const readyEntry = registered.find(([event]) => event === 'ready');
      expect(readyEntry[1]).toBe(handleReady);
    });
  });

  describe("the 'init' handler", () => {
    beforeEach(() => {
      game.gameOrchestra = undefined;
    });

    it('populates game.gameOrchestra, registers settings/keybindings, and loads templates', async () => {
      await Hooks.callAll('init');

      expect(game.gameOrchestra).toBeTruthy();
      expect(game.gameOrchestra.musicController).toBeInstanceOf(MusicController);
      expect(game.gameOrchestra.GameOrchestraConfig).toBe(GameOrchestraConfig);
      expect(game.gameOrchestra.MoodWidget).toBe(MoodWidget);
      expect(game.gameOrchestra.MoodConfigApp).toBe(MoodConfigApp);
      expect(game.gameOrchestra.PhaseConfigApp).toBe(PhaseConfigApp);
      expect(game.gameOrchestra.CustomPlaylistEditor).toBe(CustomPlaylistEditor);
      expect(game.gameOrchestra.moodWidget).toBeNull();

      expect(game.settings.registerMenu).toHaveBeenCalled();
      expect(game.keybindings.register).toHaveBeenCalled();
      expect(globalThis.loadTemplates).toHaveBeenCalledWith(
        expect.arrayContaining([
          'modules/game-orchestra/templates/music-config.hbs',
          'modules/game-orchestra/templates/mood-widget.hbs',
          'modules/game-orchestra/templates/overlay-config.hbs',
          'modules/game-orchestra/templates/custom-playlist-editor.hbs'
        ])
      );
    });
  });

  describe('the public API surface', () => {
    beforeEach(async () => {
      game.gameOrchestra = undefined;
      game.modules.get('game-orchestra').api = undefined;
      // The registered handler, invoked directly rather than through Hooks.callAll('init'):
      // these are `Hooks.once` registrations, so the mock registry - like the real one - drops
      // them after the first dispatch, and an earlier test in this file has already spent it.
      // Going through callAll here made every assertion below run against `undefined`, which the
      // identity check was happy to accept.
      const initHandler = Hooks.once.mock.calls.find(([event]) => event === 'init')[1];
      await initHandler();
    });

    it('publishes ONE object under both names', () => {
      // The canonical name is the Foundry convention and the only one another module author will
      // guess; the legacy one already has consumers in the wild. One object, not two - two would
      // be free to drift.
      expect(game.gameOrchestra).toBeTruthy();
      expect(game.modules.get('game-orchestra').api).toBe(game.gameOrchestra);
    });

    it('carries the API namespaces alongside the legacy keys', () => {
      const published = game.gameOrchestra;
      expect(published.version).toMatch(/^0\./);
      for (const ns of ['transport', 'bind', 'graph', 'mix', 'playback', 'hooks']) {
        expect(published[ns], ns).toBeTruthy();
      }
      expect(published.musicController).toBeInstanceOf(MusicController);
    });

    it('warns ONCE per legacy class key, and still returns the class', () => {
      // Someone with a working macro did nothing wrong, so the key keeps working. Once, because
      // a macro in a loop would otherwise flood the console - and a warning nobody can read is
      // not a warning.
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(game.gameOrchestra.PlaylistMixerApp).toBe(PlaylistMixerApp);
      expect(game.gameOrchestra.PlaylistMixerApp).toBe(PlaylistMixerApp);
      expect(game.gameOrchestra.CustomPlaylistEditor).toBe(CustomPlaylistEditor);

      const messages = spy.mock.calls.map((call) => call.join(' '));
      expect(messages.filter((m) => m.includes('PlaylistMixerApp'))).toHaveLength(1);
      expect(messages.filter((m) => m.includes('CustomPlaylistEditor'))).toHaveLength(1);
      spy.mockRestore();
    });

    it('does NOT warn on musicController - the module reads it through this object itself', () => {
      // settings.mjs's own onChange handlers reach through game.gameOrchestra?.musicController on
      // every mood/phase change, so warning on it would fire the deprecation at the module.
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      void game.gameOrchestra.musicController;
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
