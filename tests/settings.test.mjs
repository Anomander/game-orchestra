import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks } from './mocks/foundry.mjs';

setupFoundryMocks();

import { registerSettings } from '../scripts/settings.mjs';
import { log } from '../scripts/helpers.mjs';
import { CONST } from '../scripts/config.mjs';

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
