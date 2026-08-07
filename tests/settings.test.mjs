import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks } from './mocks/foundry.mjs';

setupFoundryMocks();

import { registerSettings, registerKeybindings, primeOverlayBaseline } from '../scripts/settings.mjs';
import { log } from '../scripts/helpers.mjs';
import { CONST } from '../scripts/config.mjs';

describe('registerKeybindings', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  /**
   * Every binding ships with a default key. They previously registered with no
   * `editable` at all, which left all four inert until the GM assigned keys by hand -
   * so the keybinding route the README and the wiki both advertise did nothing on a
   * fresh install. An unbound play-time shortcut is not a shortcut.
   */
  it('gives every binding a default key', () => {
    registerKeybindings();

    const calls = game.keybindings.register.mock.calls;
    expect(calls.map(([, action]) => action)).toEqual([
      'toggleAreaMusic',
      'toggleCombatMusic',
      'toggleMoodWidget',
      'togglePlaylistTree'
    ]);
    for (const [, action, config] of calls) {
      expect(config.editable, `${action} ships unbound`).toHaveLength(1);
      expect(config.editable[0].key).toMatch(/^Key[A-Z]$/);
      // Core reserves plain letters and Ctrl+letter; Alt+letter is the free space.
      expect(config.editable[0].modifiers).toEqual(['Alt']);
      // GM-only: all four either mutate world settings or open management apps.
      expect(config.restricted).toBe(true);
    }
  });

  it('binds four distinct keys', () => {
    registerKeybindings();

    const keys = game.keybindings.register.mock.calls.map(([, , config]) => config.editable[0].key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * A bound key that dispatches nothing is the same dead shortcut the `editable` defaults were
   * added to fix, one layer down - and just as invisible, since registration still looks correct.
   */
  describe('onDown', () => {
    /** @param {string} action @returns {Function} The registered onDown for a binding. */
    const onDownFor = (action) => game.keybindings.register.mock.calls.find(([, a]) => a === action)?.[2]?.onDown;

    beforeEach(() => {
      registerKeybindings();
    });

    it('routes the two suppression keys through the shared transport action', async () => {
      // The same route the scene-control bar and the widget take, which is what keeps all three
      // showing the same state.
      await onDownFor('toggleAreaMusic')();
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressArea, true);

      await onDownFor('toggleCombatMusic')();
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressCombat, true);
    });

    it('toggles rather than only ever switching on', async () => {
      await onDownFor('toggleAreaMusic')();
      await onDownFor('toggleAreaMusic')();

      expect(game.settings.set).toHaveBeenLastCalledWith(CONST.moduleId, CONST.settings.suppressArea, false);
    });

    it('opens the widget and the hub', () => {
      game.gameOrchestra = { moodWidget: null, playlistTree: null };

      expect(() => onDownFor('toggleMoodWidget')()).not.toThrow();
      expect(game.gameOrchestra.moodWidget).not.toBeNull();

      expect(() => onDownFor('togglePlaylistTree')()).not.toThrow();
      expect(game.gameOrchestra.playlistTree).toBeDefined();
    });
  });
});

describe('registerSettings', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('phase settings (the combat-section counterpart to mood settings)', () => {
    it('registers activePhase, configuredPhases, and resetPhaseOnCombatEnd', () => {
      registerSettings();

      const activePhaseCall = game.settings.register.mock.calls.find(([, key]) => key === CONST.settings.activePhase);
      const configuredPhasesCall = game.settings.register.mock.calls.find(([, key]) => key === CONST.settings.configuredPhases);
      const resetCall = game.settings.register.mock.calls.find(([, key]) => key === CONST.settings.resetPhaseOnCombatEnd);

      expect(activePhaseCall).toBeDefined();
      expect(activePhaseCall[2].default).toBe('');
      expect(configuredPhasesCall).toBeDefined();
      expect(configuredPhasesCall[2].default).toEqual(CONST.defaultPhases);
      expect(resetCall).toBeDefined();
      expect(resetCall[2].default).toBe(true);
    });

    it("activePhase's onChange re-triggers playback and updates a rendered GameOrchestraConfig's selectedPhase", () => {
      registerSettings();
      game.gameOrchestra = { musicController: { playCurrentTrack: vi.fn() } };
      const mockConfigApp = { constructor: { name: 'GameOrchestraConfig' }, rendered: true, selectedPhase: '', render: vi.fn() };
      globalThis.ui = { windows: { w1: mockConfigApp } };

      const settingObj = game.settings.register.mock.calls.find((call) => call[1] === CONST.settings.activePhase)?.[2];
      settingObj.onChange('p2');

      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
      expect(mockConfigApp.selectedPhase).toBe('p2');
      expect(mockConfigApp.render).toHaveBeenCalledWith(false);
    });
  });

  /**
   * Every setting that matters at play time carries an `onChange` doing the actual wiring -
   * re-resolving playback, and pushing the change into whichever windows are open. Registration
   * alone proves nothing: an `onChange` that never fires is a setting that silently does not
   * apply until the next reload.
   */
  describe('onChange wiring', () => {
    /** @param {string} key @returns {Function} The registered onChange for a setting key. */
    const onChangeFor = (key) => game.settings.register.mock.calls.find(([, k]) => k === key)?.[2]?.onChange;

    /** @returns {object} An open window stub the refresh helper will recognize. */
    const windowNamed = (name, extra = {}) => ({ constructor: { name }, rendered: true, render: vi.fn(), ...extra });

    beforeEach(() => {
      registerSettings();
      game.gameOrchestra = { musicController: { playCurrentTrack: vi.fn() } };
    });

    it('re-resolves playback when the active mood changes', () => {
      onChangeFor(CONST.settings.activeMood)('stealth');
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
    });

    it('pushes the new mood into a rendered config window and refreshes the widget and tree', () => {
      const config = windowNamed('GameOrchestraConfig', { selectedMood: 'calm' });
      const widget = windowNamed('MoodWidget');
      const tree = windowNamed('PlaylistTreeApp');
      globalThis.ui = { windows: { a: config, b: widget, c: tree } };

      onChangeFor(CONST.settings.activeMood)('stealth');

      expect(config.selectedMood).toBe('stealth');
      expect(config.render).toHaveBeenCalledWith(false);
      expect(widget.render).toHaveBeenCalledWith(false);
      expect(tree.render).toHaveBeenCalledWith(false);
    });

    it('clears the config selection when the mood is cleared rather than storing undefined', () => {
      const config = windowNamed('GameOrchestraConfig', { selectedMood: 'calm' });
      globalThis.ui = { windows: { a: config } };

      onChangeFor(CONST.settings.activeMood)('');

      expect(config.selectedMood).toBe('');
    });

    it('reaches ApplicationV2 windows too, which do not live in ui.windows', () => {
      // The widget and the tree are ApplicationV2 - they are only in
      // foundry.applications.instances. Walking ui.windows alone would miss them entirely.
      const widget = windowNamed('MoodWidget');
      globalThis.ui = { windows: {} };
      foundry.applications.instances = new Map([['w', widget]]);

      onChangeFor(CONST.settings.activeMood)('tense');

      expect(widget.render).toHaveBeenCalledWith(false);
    });

    it('leaves a closed window alone', () => {
      const widget = windowNamed('MoodWidget', { rendered: false });
      globalThis.ui = { windows: { a: widget } };

      onChangeFor(CONST.settings.activeMood)('tense');

      expect(widget.render).not.toHaveBeenCalled();
    });

    it('ignores unrelated windows', () => {
      const other = windowNamed('SomeOtherModuleApp');
      globalThis.ui = { windows: { a: other } };

      onChangeFor(CONST.settings.activeMood)('tense');

      expect(other.render).not.toHaveBeenCalled();
    });

    it('refreshes every axis-aware window when the mood list is edited', () => {
      // Editing the list changes what the strips can even show, so all three redraw - but
      // unlike an active-overlay change this must NOT re-trigger playback.
      const widget = windowNamed('MoodWidget');
      const tree = windowNamed('PlaylistTreeApp');
      const config = windowNamed('GameOrchestraConfig');
      globalThis.ui = { windows: { a: widget, b: tree, c: config } };

      onChangeFor(CONST.settings.configuredMoods)([]);

      for (const app of [widget, tree, config]) expect(app.render).toHaveBeenCalledWith(false);
      expect(game.gameOrchestra.musicController.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('refreshes the same windows when the phase list is edited', () => {
      const widget = windowNamed('MoodWidget');
      globalThis.ui = { windows: {} };
      foundry.applications.instances = new Map([['w', widget]]);

      onChangeFor(CONST.settings.configuredPhases)([]);

      expect(widget.render).toHaveBeenCalledWith(false);
      expect(game.gameOrchestra.musicController.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('re-resolves playback when either suppression toggle flips', () => {
      // This is the whole mechanism behind the transport buttons and the Alt+A / Alt+C
      // keybindings: they only write the setting, and this onChange is what makes it audible.
      onChangeFor(CONST.settings.suppressArea)(true);
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalledTimes(1);

      onChangeFor(CONST.settings.suppressCombat)(true);
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalledTimes(2);
    });

    it('survives firing before the controller exists', () => {
      game.gameOrchestra = undefined;
      globalThis.ui = { windows: {} };

      for (const key of [CONST.settings.activeMood, CONST.settings.activePhase, CONST.settings.suppressArea, CONST.settings.suppressCombat]) {
        expect(() => onChangeFor(key)('x'), key).not.toThrow();
      }
    });
  });

  describe('gameOrchestraOverlayChanged', () => {
    /** The onChange for one axis, as registered. */
    const onChangeFor = (settingKey) =>
      game.settings.register.mock.calls.find(([, key]) => key === settingKey)[2].onChange;

    beforeEach(() => {
      registerSettings();
      primeOverlayBaseline();
    });

    it('fires ONE hook carrying its axis, not two hooks', () => {
      // config.mjs#overlayAxes models mood and phase as one mechanism on two axes; ux.md D4 is
      // the record of what splitting them into two of everything cost last time.
      const seen = [];
      Hooks.on('gameOrchestraOverlayChanged', (payload) => seen.push(payload));

      onChangeFor(CONST.settings.activeMood)('tense');
      onChangeFor(CONST.settings.activePhase)('enrage');

      expect(seen).toEqual([
        { axis: 'mood', from: '', to: 'tense' },
        { axis: 'phase', from: '', to: 'enrage' }
      ]);
    });

    it('reports what the value changed FROM, across successive changes', () => {
      const seen = [];
      Hooks.on('gameOrchestraOverlayChanged', (payload) => seen.push(payload));

      onChangeFor(CONST.settings.activeMood)('tense');
      onChangeFor(CONST.settings.activeMood)('calm');

      expect(seen.map((p) => `${p.from}->${p.to}`)).toEqual(['->tense', 'tense->calm']);
    });

    it('does not fire when the value did not actually change', () => {
      const seen = [];
      onChangeFor(CONST.settings.activeMood)('tense');
      Hooks.on('gameOrchestraOverlayChanged', (payload) => seen.push(payload));

      onChangeFor(CONST.settings.activeMood)('tense');

      expect(seen).toEqual([]);
    });

    it('still re-resolves playback even if a listener throws', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const playCurrentTrack = vi.fn();
      game.gameOrchestra = { musicController: { playCurrentTrack } };
      Hooks.on('gameOrchestraOverlayChanged', () => { throw new Error('third-party listener bug'); });

      expect(() => onChangeFor(CONST.settings.activeMood)('tense')).not.toThrow();
      expect(playCurrentTrack).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('enableDebug cache wiring', () => {
    it('initializes the cached debug flag from the registered default right after registration', () => {
      // The mock's game.settings.get() reflects whatever was last set()/registered;
      // simulate the real default (false) being readable immediately after register().
      game.settings.get = vi.fn(() => false);
      registerSettings();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const getSpy = vi.spyOn(game.settings, 'get');
      log(3, 'should be suppressed');

      expect(logSpy).not.toHaveBeenCalled();
      // The cache (populated at registration) is what suppressed it - not a fresh read.
      expect(getSpy).not.toHaveBeenCalledWith('game-orchestra', 'enableDebug');
      logSpy.mockRestore();
      getSpy.mockRestore();
    });

    it('registers enableDebug with an onChange that keeps the cache in sync', () => {
      registerSettings();

      const registerCall = game.settings.register.mock.calls.find(([, key]) => key === 'enableDebug');
      expect(registerCall).toBeDefined();
      const config = registerCall[2];
      expect(typeof config.onChange).toBe('function');

      // Simulate the user flipping the setting on: onChange should update the
      // cache so a subsequent log() reflects it without re-reading game.settings.
      config.onChange(true);
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      log(3, 'now visible');
      expect(logSpy).toHaveBeenCalledWith('Game Orchestra |', 'now visible');
      logSpy.mockRestore();
    });
  });
});
