import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockPlaylist } from './mocks/foundry.mjs';

setupFoundryMocks();

import {
  handleUpdateCombat,
  handleDeleteCombat,
  handleCreateCombatant,
  handleDeleteCombatant,
  handleUpdateCombatant,
  handleUserConnected,
  handleCanvasReady,
  handleUpdateScene,
  handleUpdatePlaylist,
  handlePlaylistConfigRender,
  handlePlaylistContextMenu,
  handleUpdateActor,
  handleUpdateToken,
  handleReady,
  getSceneControlButtons,
  handleTokenConfigRender
} from '../scripts/hooks.mjs';
import { CONST } from '../scripts/config.mjs';
import { MoodWidget } from '../scripts/mood-widget.mjs';
import { GameOrchestraConfig } from '../scripts/app.mjs';

describe('hooks.mjs', () => {
  let mockController;

  beforeEach(() => {
    setupFoundryMocks();
    mockController = { playCurrentTrack: vi.fn(), onCustomGraphChanged: vi.fn() };
    game.gameOrchestra = { musicController: mockController };
  });

  describe('handleUpdateCombat', () => {
    it('calls playCurrentTrack when combat.started and updateData.turn is updated', () => {
      const combat = { started: true };
      handleUpdateCombat(combat, { turn: 2 });
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('calls playCurrentTrack when combat.started and updateData.round is updated', () => {
      const combat = { started: true };
      handleUpdateCombat(combat, { round: 1 });
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack when combat is not started', () => {
      const combat = { started: false };
      handleUpdateCombat(combat, { turn: 2 });
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('does NOT call when neither turn nor round is in updateData', () => {
      const combat = { started: true };
      handleUpdateCombat(combat, { active: true });
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('refreshes a rendered Mood Widget when combat.started changes, so its strip flips between moods and phases', () => {
      game.gameOrchestra.moodWidget = { rendered: true, render: vi.fn() };
      const combat = { started: true };

      handleUpdateCombat(combat, { started: true });

      expect(game.gameOrchestra.moodWidget.render).toHaveBeenCalledWith(false);
    });

    it('does not touch the Mood Widget for a turn/round update (only a started change)', () => {
      game.gameOrchestra.moodWidget = { rendered: true, render: vi.fn() };
      const combat = { started: true };

      handleUpdateCombat(combat, { turn: 2 });

      expect(game.gameOrchestra.moodWidget.render).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteCombat', () => {
    it('calls playCurrentTrack on combat deletion when the phase was already at rest', async () => {
      await handleDeleteCombat();
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('resets activePhase to the first configured phase when resetPhaseOnCombatEnd is on', async () => {
      setMockSetting('game-orchestra', 'resetPhaseOnCombatEnd', true);
      setMockSetting('game-orchestra', 'activePhase', 'enrage');
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'p1', label: 'Phase One' }, { id: 'enrage', label: 'Enrage' }]);

      await handleDeleteCombat();

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activePhase, 'p1');
    });

    it('does not write activePhase when it is already at the reset target', async () => {
      setMockSetting('game-orchestra', 'resetPhaseOnCombatEnd', true);
      setMockSetting('game-orchestra', 'activePhase', 'p1');
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'p1', label: 'Phase One' }]);

      await handleDeleteCombat();

      expect(game.settings.set).not.toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activePhase, expect.anything());
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does not reset activePhase when resetPhaseOnCombatEnd is off', async () => {
      setMockSetting('game-orchestra', 'resetPhaseOnCombatEnd', false);
      setMockSetting('game-orchestra', 'activePhase', 'enrage');

      await handleDeleteCombat();

      expect(game.settings.set).not.toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activePhase, expect.anything());
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCanvasReady', () => {
    it('calls playCurrentTrack on canvas ready', () => {
      handleCanvasReady();
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleUserConnected', () => {
    it('calls playCurrentTrack on any GM connect/disconnect so headship handoff is picked up', () => {
      handleUserConnected({ id: 'gm2', isGM: true }, false);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleCreateCombatant', () => {
    it('calls playCurrentTrack when parent combat is started', () => {
      const combatant = { parent: { started: true } };
      handleCreateCombatant(combatant);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack when parent combat is not started', () => {
      const combatant = { parent: { started: false } };
      handleCreateCombatant(combatant);
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteCombatant', () => {
    it('calls playCurrentTrack when parent combat is started', () => {
      const combatant = { parent: { started: true } };
      handleDeleteCombatant(combatant);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack when parent combat is not started', () => {
      const combatant = { parent: { started: false } };
      handleDeleteCombatant(combatant);
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdateCombatant', () => {
    it('calls playCurrentTrack when defeated status changes and parent combat is started', () => {
      const combatant = { parent: { started: true } };
      handleUpdateCombatant(combatant, { defeated: true });
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack when parent combat is not started', () => {
      const combatant = { parent: { started: false } };
      handleUpdateCombatant(combatant, { defeated: true });
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('does NOT call playCurrentTrack for unrelated updates', () => {
      const combatant = { parent: { started: true } };
      handleUpdateCombatant(combatant, { initiative: 15 });
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdateScene', () => {
    it('calls playCurrentTrack when game-orchestra music flag changes', () => {
      const scene = {};
      const updateData = { flags: { [CONST.moduleId]: { music: { area: { playlist: 'p1' } } } } };

      handleUpdateScene(scene, updateData);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('calls playCurrentTrack when scene active property changes', () => {
      const scene = {};
      const updateData = { active: true };

      handleUpdateScene(scene, updateData);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack for unrelated scene updates', () => {
      const scene = {};
      const updateData = { name: 'New Name' };

      handleUpdateScene(scene, updateData);
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdatePlaylist', () => {
    it('calls onCustomGraphChanged when the customPlayback flag is set', () => {
      const playlist = { id: 'pl1' };
      const updateData = { flags: { [CONST.moduleId]: { customPlayback: { version: 1, nodes: [], edges: [] } } } };

      handleUpdatePlaylist(playlist, updateData);
      expect(mockController.onCustomGraphChanged).toHaveBeenCalledWith(playlist);
    });

    it('calls onCustomGraphChanged when the customPlayback flag is removed', () => {
      const playlist = { id: 'pl1' };
      const updateData = { flags: { [CONST.moduleId]: { '-=customPlayback': null } } };

      handleUpdatePlaylist(playlist, updateData);
      expect(mockController.onCustomGraphChanged).toHaveBeenCalledWith(playlist);
    });

    it('does NOT call onCustomGraphChanged for unrelated playlist updates', () => {
      const playlist = { id: 'pl1' };
      const updateData = { mode: 0 };

      handleUpdatePlaylist(playlist, updateData);
      expect(mockController.onCustomGraphChanged).not.toHaveBeenCalled();
    });
  });

  describe('handlePlaylistConfigRender', () => {
    it('returns early when current user is not GM', () => {
      game.user = { isGM: false };
      const html = { querySelector: vi.fn() };

      handlePlaylistConfigRender({}, html);
      expect(html.querySelector).not.toHaveBeenCalled();
    });

    it('returns early when the mode select is not found, without throwing', () => {
      game.user = { isGM: true };
      const html = { querySelector: vi.fn().mockReturnValue(null) };

      expect(() => handlePlaylistConfigRender({}, html)).not.toThrow();
      expect(html.querySelector).toHaveBeenCalledWith('select[name="mode"]');
    });

    describe('availability (the graph editor only works on unsequenced playlists - H1)', () => {
      /** A DOM element stand-in with just the surface handlePlaylistConfigRender touches. */
      function fakeElement(tag) {
        const listeners = {};
        return {
          tagName: tag.toUpperCase(),
          children: [],
          dataset: {},
          className: '',
          textContent: '',
          innerHTML: '',
          disabled: false,
          value: '',
          type: '',
          appendChild(child) {
            this.children.push(child);
            return child;
          },
          insertAdjacentElement: (_position, element) => element,
          addEventListener(type, fn) {
            (listeners[type] ||= []).push(fn);
          },
          /** Test helper: dispatch a listener bound via addEventListener. */
          fire(type) {
            for (const fn of listeners[type] || []) fn({ preventDefault: vi.fn() });
          }
        };
      }

      /**
       * Run the hook against a fake sheet and hand back the pieces it injected.
       * @param {number} mode - Playlist#mode, also the mode <select>'s current value.
       * @param {object|null} graph - An existing customPlayback flag, if any.
       */
      function renderSheet(mode, graph = null) {
        game.user = { isGM: true };
        const playlist = createMockPlaylist('pl1', 'Playlist', [], mode);
        if (graph) playlist.setFlag('game-orchestra', 'customPlayback', graph);

        const created = [];
        global.document.createElement = vi.fn((tag) => {
          const element = fakeElement(tag);
          created.push(element);
          return element;
        });

        const modeSelect = fakeElement('select');
        modeSelect.value = String(mode);
        modeSelect.closest = () => fakeElement('div');

        handlePlaylistConfigRender({ document: playlist }, {
          querySelector: (sel) => (sel === 'select[name="mode"]' ? modeSelect : null)
        });

        return {
          modeSelect,
          button: created.find((el) => el.dataset.action === 'game-orchestra-custom-playback'),
          hint: created.find((el) => el.className === 'hint')
        };
      }

      const UNSEQUENCED = -1;
      const SHUFFLE = 1;

      it('enables the button on an unsequenced playlist', () => {
        const { button, hint } = renderSheet(UNSEQUENCED);
        expect(button.disabled).toBe(false);
        expect(hint.textContent).toBe('GameOrchestra.CustomEditor.PlaylistConfigHint');
      });

      it('disables it on a sequenced playlist and explains why', () => {
        const { button, hint } = renderSheet(SHUFFLE);
        expect(button.disabled).toBe(true);
        expect(hint.textContent).toBe('GameOrchestra.CustomEditor.UnsequencedOnlyHint');
      });

      it('keeps it enabled for a playlist that already has a graph, whatever its mode says', () => {
        // Otherwise a mode change made elsewhere would strand the graph: no way
        // back into the editor to edit it, and no way to remove it.
        const { button } = renderSheet(SHUFFLE, { version: 1, nodes: [], edges: [] });
        expect(button.disabled).toBe(false);
      });

      it('re-evaluates as the mode select changes, before the sheet is saved', () => {
        const { button, hint, modeSelect } = renderSheet(SHUFFLE);
        expect(button.disabled).toBe(true);

        modeSelect.value = String(UNSEQUENCED);
        modeSelect.fire('change');

        expect(button.disabled).toBe(false);
        expect(hint.textContent).toBe('GameOrchestra.CustomEditor.PlaylistConfigHint');
      });

      it('falls back to the saved mode when the select has no value of its own', () => {
        const { button, modeSelect } = renderSheet(UNSEQUENCED);
        modeSelect.value = '';
        modeSelect.fire('change');
        expect(button.disabled).toBe(false);
      });

      it('does not open the editor when clicked while disabled', () => {
        const { button } = renderSheet(SHUFFLE);
        expect(() => button.fire('click')).not.toThrow();
      });

      it('injects the mixer button too, and never disables it by mode', () => {
        // The mixer is the one window that works for every playlist type - gating it the way
        // the graph editor is gated would put per-track volume back behind the mode check it
        // exists to escape.
        const created = [];
        global.document.createElement = vi.fn((tag) => {
          const element = fakeElement(tag);
          created.push(element);
          return element;
        });
        game.user = { isGM: true };
        const modeSelect = fakeElement('select');
        modeSelect.value = String(SHUFFLE);
        modeSelect.closest = () => fakeElement('div');
        handlePlaylistConfigRender({ document: createMockPlaylist('pl1', 'Playlist', [], SHUFFLE) }, {
          querySelector: (sel) => (sel === 'select[name="mode"]' ? modeSelect : null)
        });

        const mixerButton = created.find((el) => el.dataset.action === 'game-orchestra-mixer');
        expect(mixerButton).toBeTruthy();
        expect(mixerButton.disabled).toBe(false);
      });
    });
  });

  describe('handlePlaylistContextMenu', () => {
    it('adds one mixer entry to the playlist directory menu', () => {
      game.user = { isGM: true };
      const entries = [];

      handlePlaylistContextMenu({}, entries);

      expect(entries).toHaveLength(1);
      expect(entries[0].label).toBe('GameOrchestra.Mixer.MenuEntry');
      expect(typeof entries[0].onClick).toBe('function');
    });

    it('adds nothing for a non-GM', () => {
      game.user = { isGM: false };
      const entries = [];

      handlePlaylistContextMenu({}, entries);

      expect(entries).toHaveLength(0);
    });

    it('resolves the playlist from the enclosing [data-entry-id], not the clicked header', () => {
      // The menu is anchored on `.playlist > header`, which carries no id of its own.
      game.user = { isGM: true };
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));
      const entries = [];
      handlePlaylistContextMenu({}, entries);

      const header = { closest: vi.fn(() => ({ dataset: { entryId: 'pl1' } })) };
      expect(() => entries[0].onClick({}, header)).not.toThrow();
      expect(header.closest).toHaveBeenCalledWith('[data-entry-id]');
    });

    it('survives a hook called with something other than an entry list', () => {
      game.user = { isGM: true };
      expect(() => handlePlaylistContextMenu({}, null)).not.toThrow();
    });
  });

  describe('handleUpdatePlaylist (mix vs. graph)', () => {
    it('rebuilds the engine only for a customPlayback change', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);

      handleUpdatePlaylist(playlist, { flags: { [CONST.moduleId]: { customPlayback: { version: 1 } } } });
      expect(mockController.onCustomGraphChanged).toHaveBeenCalledTimes(1);
    });

    it('does NOT rebuild the engine for a mix change - a volume nudge must not restart the graph from Start (H9)', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);

      handleUpdatePlaylist(playlist, { flags: { [CONST.moduleId]: { mix: { gain: 0.5 } } } });

      expect(mockController.onCustomGraphChanged).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdateActor', () => {
    it('calls playCurrentTrack when game-orchestra music flag changes', () => {
      const actor = {};
      const updateData = { flags: { [CONST.moduleId]: { music: {} } } };

      handleUpdateActor(actor, updateData);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack for unrelated actor updates', () => {
      const actor = {};
      const updateData = { name: 'New Hero' };

      handleUpdateActor(actor, updateData);
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('handleUpdateToken', () => {
    it('calls playCurrentTrack when game-orchestra music flag changes', () => {
      const token = {};
      const updateData = { flags: { [CONST.moduleId]: { useTokenMusic: true } } };

      handleUpdateToken(token, updateData);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
    });

    it('does NOT call playCurrentTrack for unrelated token updates', () => {
      const token = {};
      const updateData = { x: 100, y: 200 };

      handleUpdateToken(token, updateData);
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
    });
  });

  describe('getSceneControlButtons', () => {
    it('populates music suppression tools into controls.sounds.tools', () => {
      const controls = {
        sounds: {
          tools: {}
        }
      };

      getSceneControlButtons(controls);

      expect(controls.sounds.tools['suppress-area-music']).toBeDefined();
      expect(controls.sounds.tools['suppress-combat-music']).toBeDefined();
      expect(controls.sounds.tools['mood-widget']).toBeDefined();
    });

    it('gracefully handles missing sounds tools object', () => {
      expect(() => getSceneControlButtons({})).not.toThrow();
    });

    it('logs a diagnostic when the sounds control group is missing (regression: a core rename would otherwise fail silently)', () => {
      setMockSetting('game-orchestra', 'enableDebug', true);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      getSceneControlButtons({});

      const lines = warnSpy.mock.calls.map((args) => args.join(' '));
      expect(lines.some((l) => l.includes("'sounds' scene control group"))).toBe(true);
      warnSpy.mockRestore();
    });

    it('does not populate tools for non-GM users', () => {
      game.user = { isGM: false };
      const controls = { sounds: { tools: {} } };

      getSceneControlButtons(controls);

      expect(controls.sounds.tools['suppress-area-music']).toBeUndefined();
      expect(controls.sounds.tools['suppress-combat-music']).toBeUndefined();
      expect(controls.sounds.tools['mood-widget']).toBeUndefined();
    });
  });

  describe('handleTokenConfigRender', () => {
    it('returns early when current user is not GM', () => {
      game.user = { isGM: false };
      const app = {};
      const html = { querySelector: vi.fn() };

      handleTokenConfigRender(app, html);
      expect(html.querySelector).not.toHaveBeenCalled();
    });

    it('returns early when identity tab is not found', () => {
      game.user = { isGM: true };
      const app = {};
      const html = { querySelector: vi.fn().mockReturnValue(null) };

      handleTokenConfigRender(app, html);
      expect(html.querySelector).toHaveBeenCalledWith('[data-application-part="identity"]');
    });

    /**
     * Build just enough of a rendered token sheet for the injector: an identity
     * part holding one .form-group that accepts insertAdjacentElement.
     * @returns {{html: object, inserted: object[]}}
     */
    const mockSheetHtml = () => {
      const inserted = [];
      const nameField = { insertAdjacentElement: (_pos, el) => inserted.push(el) };
      const identityTab = { querySelector: vi.fn().mockReturnValue(nameField) };
      const html = { querySelector: vi.fn((sel) => (sel === '[data-application-part="identity"]' ? identityTab : null)) };
      return { html, inserted };
    };

    /**
     * Click the injected config button and report which document the window got.
     * @param {object} app - Mock token sheet.
     * @returns {object|undefined} The document handed to GameOrchestraConfig.
     */
    const openConfigFrom = (app) => {
      const { html, inserted } = mockSheetHtml();
      let captured;
      const renderSpy = vi.spyOn(GameOrchestraConfig.prototype, 'render').mockImplementation(function () {
        captured = this.document;
        return this;
      });
      handleTokenConfigRender(app, html);
      const find = (el) => (el.className === 'game-orchestra-token-config' ? el : el.children?.reduce((hit, c) => hit || find(c), null));
      const button = inserted.reduce((hit, el) => hit || find(el), null);
      button.listeners.click({ preventDefault: () => {} });
      renderSpy.mockRestore();
      return captured;
    };

    it('regression: opens the config on the real TokenDocument, never the sheet preview clone', () => {
      game.user = { isGM: true };
      const realToken = { documentName: 'Token', id: 'tok1', actorLink: false, getFlag: vi.fn() };
      // TokenConfig#token is `this._preview ?? this.document` - a detached clone
      // that swallows every flag write (hooks.mjs#handleTokenConfigRender).
      const previewClone = { documentName: 'Token', id: 'tok1', actorLink: false, getFlag: vi.fn() };

      const captured = openConfigFrom({ isPrototype: false, document: realToken, token: previewClone });

      expect(captured).toBe(realToken);
      expect(captured).not.toBe(previewClone);
    });

    it('regression: opens the config on the actor\'s real PrototypeToken, never the sheet preview clone', () => {
      game.user = { isGM: true };
      const realPrototype = { id: 'proto1', actorLink: true, getFlag: vi.fn() };
      const previewClone = { id: 'proto1', actorLink: true, getFlag: vi.fn() };
      const actor = { prototypeToken: realPrototype };

      const captured = openConfigFrom({ isPrototype: true, actor, token: previewClone });

      expect(captured).toBe(realPrototype);
      expect(captured).not.toBe(previewClone);
    });
  });

  describe('handleReady', () => {
    it('calls playCurrentTrack after delay', () => {
      vi.useFakeTimers();
      handleReady();
      expect(mockController.playCurrentTrack).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1050);
      expect(mockController.playCurrentTrack).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('restores mood widget open state when isOpen is true in position settings', () => {
      const openSpy = vi.spyOn(MoodWidget, 'open').mockImplementation(() => {});

      setMockSetting('game-orchestra', 'moodWidgetPosition', { isOpen: true });

      handleReady();

      expect(openSpy).toHaveBeenCalledTimes(1);
      openSpy.mockRestore();
    });
  });
});
