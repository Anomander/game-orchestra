import { describe, it, expect, beforeEach } from 'vitest';
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
});
