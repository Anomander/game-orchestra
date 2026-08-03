import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks } from './mocks/foundry.mjs';

setupFoundryMocks();

import { MoodConfigApp, PhaseConfigApp, OverlayConfigApp } from '../scripts/mood-config.mjs';
import { MoodWidget } from '../scripts/mood-widget.mjs';
import { registerSettings } from '../scripts/settings.mjs';
import { CONST } from '../scripts/config.mjs';
import { setMockSetting } from './mocks/foundry.mjs';

describe('MoodConfigApp', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('formHandler', () => {
    it('canonicalizes and deduplicates mood IDs on submission', async () => {
      const mockApp = {
        constructor: MoodConfigApp,
        close: vi.fn()
      };

      const formData = {
        object: {
          'items.0.label': 'Calm Mood',
          'items.0.icon': 'fas fa-leaf',
          'items.0.color': '#4caf50',
          'items.1.label': 'Calm Mood',
          'items.1.icon': 'fas fa-music',
          'items.1.color': '#3b82f6',
          'items.2.label': '  ', // empty label, should be filtered out
          'items.2.icon': 'fas fa-music'
        }
      };

      await MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.configuredMoods,
        [
          { id: 'calm-mood', label: 'Calm Mood', icon: 'fas fa-leaf', color: '#4caf50' },
          { id: 'calm-mood-2', label: 'Calm Mood', icon: 'fas fa-music', color: '#3b82f6' }
        ]
      );

      expect(mockApp.close).toHaveBeenCalled();
    });

    it('preserves an existing mood id across a label rename instead of regenerating it', async () => {
      const mockApp = { constructor: MoodConfigApp, close: vi.fn() };

      const formData = {
        object: {
          'items.0.id': 'boss',
          'items.0.label': 'Final Boss',
          'items.0.icon': 'fas fa-skull',
          'items.0.color': '#f44336'
        }
      };

      await MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.configuredMoods,
        [{ id: 'boss', label: 'Final Boss', icon: 'fas fa-skull', color: '#f44336' }]
      );
    });

    it('generates a fresh id from the label for a new row with no id', async () => {
      const mockApp = { constructor: MoodConfigApp, close: vi.fn() };

      const formData = {
        object: {
          'items.0.id': 'boss',
          'items.0.label': 'Boss',
          'items.0.icon': 'fas fa-skull',
          'items.0.color': '#f44336',
          'items.1.id': '',
          'items.1.label': 'Stealth',
          'items.1.icon': 'fas fa-user-ninja',
          'items.1.color': '#9c27b0'
        }
      };

      await MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      expect(game.settings.set).toHaveBeenCalledWith(
        CONST.moduleId,
        CONST.settings.configuredMoods,
        [
          { id: 'boss', label: 'Boss', icon: 'fas fa-skull', color: '#f44336' },
          { id: 'stealth', label: 'Stealth', icon: 'fas fa-user-ninja', color: '#9c27b0' }
        ]
      );
    });

    it('handles settings.set error rejection gracefully', async () => {
      const mockApp = { constructor: MoodConfigApp, close: vi.fn() };
      game.settings.set.mockRejectedValueOnce(new Error('Permission denied'));

      const formData = { object: { 'items.0.label': 'Test Mood' } };

      await expect(MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData)).resolves.toBeUndefined();
      expect(ui.notifications.error).toHaveBeenCalledWith('GameOrchestra.MoodConfig.SaveFailed');
    });
  });

  describe('handleAddItem', () => {
    it('pushes a new mood entry with defaults and re-renders app', () => {
      const mockApp = { constructor: MoodConfigApp, items: [], render: vi.fn() };
      const event = { preventDefault: vi.fn() };

      MoodConfigApp.handleAddItem.call(mockApp, event, null);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockApp.items).toHaveLength(1);
      expect(mockApp.items[0].label).toBe('New Mood');
      expect(mockApp.render).toHaveBeenCalledWith(false);
    });
  });

  describe('handleDeleteItem', () => {
    it('removes mood entry at target index and re-renders app', () => {
      const mockApp = { constructor: MoodConfigApp, items: [{ id: 'm1' }, { id: 'm2' }], render: vi.fn() };
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { index: '0' } };

      MoodConfigApp.handleDeleteItem.call(mockApp, event, target);

      expect(mockApp.items).toHaveLength(1);
      expect(mockApp.items[0].id).toBe('m2');
      expect(mockApp.render).toHaveBeenCalledWith(false);
    });

    it('warns that overrides referencing the deleted mood id will be orphaned', () => {
      const mockApp = { constructor: MoodConfigApp, items: [{ id: 'boss', label: 'Boss' }], render: vi.fn() };
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { index: '0' } };

      MoodConfigApp.handleDeleteItem.call(mockApp, event, target);

      expect(ui.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Boss'));
    });

    it('does not warn when the removed row never had an id (unsaved new row)', () => {
      const mockApp = { constructor: MoodConfigApp, items: [{ id: '', label: 'New Mood' }], render: vi.fn() };
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { index: '0' } };

      MoodConfigApp.handleDeleteItem.call(mockApp, event, target);

      expect(ui.notifications.warn).not.toHaveBeenCalled();
    });

    it('refuses to delete the currently active mood', () => {
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      const mockApp = { constructor: MoodConfigApp, items: [{ id: 'boss', label: 'Boss' }, { id: 'calm', label: 'Calm' }], render: vi.fn() };
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { index: '0' } };

      MoodConfigApp.handleDeleteItem.call(mockApp, event, target);

      expect(mockApp.items).toHaveLength(2); // nothing removed
      expect(mockApp.render).not.toHaveBeenCalled();
      expect(ui.notifications.warn).toHaveBeenCalledWith('GameOrchestra.MoodConfig.DeleteActiveBlocked');
    });

    it('still allows deleting a different, non-active mood', () => {
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      const mockApp = { constructor: MoodConfigApp, items: [{ id: 'boss', label: 'Boss' }, { id: 'calm', label: 'Calm' }], render: vi.fn() };
      const event = { preventDefault: vi.fn() };
      const target = { dataset: { index: '1' } };

      MoodConfigApp.handleDeleteItem.call(mockApp, event, target);

      expect(mockApp.items).toEqual([{ id: 'boss', label: 'Boss' }]);
      expect(mockApp.render).toHaveBeenCalledWith(false);
    });
  });

  describe('handleResetDefaults', () => {
    it('resets items to CONST.defaultMoods and re-renders app', () => {
      const mockApp = { constructor: MoodConfigApp, items: [], render: vi.fn() };
      const event = { preventDefault: vi.fn() };

      MoodConfigApp.handleResetDefaults.call(mockApp, event, null);

      expect(mockApp.items).toEqual(CONST.defaultMoods);
      expect(mockApp.render).toHaveBeenCalledWith(false);
    });
  });
});

describe('PhaseConfigApp', () => {
  // PhaseConfigApp shares its whole implementation with MoodConfigApp via the
  // OverlayConfigApp base class (mood-config.mjs) - these tests exist to prove
  // the axis parametrization actually reaches the right setting/defaults,
  // not to re-verify logic MoodConfigApp's tests above already cover.
  beforeEach(() => {
    setupFoundryMocks();
  });

  it('saves to configuredPhases, not configuredMoods', async () => {
    const mockApp = { constructor: PhaseConfigApp, close: vi.fn() };
    const formData = { object: { 'items.0.id': 'p2', 'items.0.label': 'Phase Two', 'items.0.icon': 'fas fa-droplet', 'items.0.color': '#ff9800' } };

    await PhaseConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

    expect(game.settings.set).toHaveBeenCalledWith(
      CONST.moduleId,
      CONST.settings.configuredPhases,
      [{ id: 'p2', label: 'Phase Two', icon: 'fas fa-droplet', color: '#ff9800' }]
    );
  });

  it('resets items to CONST.defaultPhases, not CONST.defaultMoods', () => {
    const mockApp = { constructor: PhaseConfigApp, items: [], render: vi.fn() };
    PhaseConfigApp.handleResetDefaults.call(mockApp, { preventDefault: vi.fn() }, null);

    expect(mockApp.items).toEqual(CONST.defaultPhases);
    expect(mockApp.items).not.toEqual(CONST.defaultMoods);
  });

  it('refuses to delete the currently active phase, checking activePhase (not activeMood)', () => {
    setMockSetting('game-orchestra', 'activePhase', 'p2');
    const mockApp = { constructor: PhaseConfigApp, items: [{ id: 'p2', label: 'Phase Two' }], render: vi.fn() };
    const event = { preventDefault: vi.fn() };
    const target = { dataset: { index: '0' } };

    PhaseConfigApp.handleDeleteItem.call(mockApp, event, target);

    expect(mockApp.items).toHaveLength(1);
    expect(mockApp.render).not.toHaveBeenCalled();
  });
});

describe('OverlayConfigApp - one window, two tabs', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('axisOf', () => {
    it("prefers the live instance's active tab over the class's default axis", () => {
      // A PhaseConfigApp instance whose user has clicked over to the Moods tab
      // must edit moods, not phases - the class only chose the *initial* tab.
      expect(OverlayConfigApp.axisOf({ constructor: PhaseConfigApp, activeAxis: 'mood' })).toBe('mood');
    });

    it('falls back to the class axis when there is no instance state', () => {
      expect(OverlayConfigApp.axisOf({ constructor: PhaseConfigApp })).toBe('phase');
      expect(OverlayConfigApp.axisOf({ constructor: MoodConfigApp })).toBe('mood');
    });

    it('falls back to mood for an unrecognized axis rather than throwing', () => {
      expect(OverlayConfigApp.axisOf({ activeAxis: 'nonsense' })).toBe('mood');
      expect(OverlayConfigApp.axisOf(undefined)).toBe('mood');
    });
  });

  describe('handleSelectAxis', () => {
    it('switches the active tab and re-renders', () => {
      const mockApp = { constructor: MoodConfigApp, activeAxis: 'mood', render: vi.fn(), _harvestActiveAxis: vi.fn() };
      const event = { preventDefault: vi.fn() };

      OverlayConfigApp.handleSelectAxis.call(mockApp, event, { dataset: { axis: 'phase' } });

      expect(mockApp.activeAxis).toBe('phase');
      expect(mockApp.render).toHaveBeenCalledWith(false);
    });

    it('harvests the outgoing tab before switching, so typed edits are not lost', () => {
      const mockApp = { constructor: MoodConfigApp, activeAxis: 'mood', render: vi.fn(), _harvestActiveAxis: vi.fn() };

      OverlayConfigApp.handleSelectAxis.call(mockApp, { preventDefault: vi.fn() }, { dataset: { axis: 'phase' } });

      expect(mockApp._harvestActiveAxis).toHaveBeenCalled();
    });

    it('is a no-op when the clicked tab is already active', () => {
      const mockApp = { constructor: MoodConfigApp, activeAxis: 'mood', render: vi.fn(), _harvestActiveAxis: vi.fn() };

      OverlayConfigApp.handleSelectAxis.call(mockApp, { preventDefault: vi.fn() }, { dataset: { axis: 'mood' } });

      expect(mockApp.render).not.toHaveBeenCalled();
      expect(mockApp._harvestActiveAxis).not.toHaveBeenCalled();
    });

    it('ignores an unknown axis', () => {
      const mockApp = { constructor: MoodConfigApp, activeAxis: 'mood', render: vi.fn(), _harvestActiveAxis: vi.fn() };

      OverlayConfigApp.handleSelectAxis.call(mockApp, { preventDefault: vi.fn() }, { dataset: { axis: 'colour' } });

      expect(mockApp.activeAxis).toBe('mood');
      expect(mockApp.render).not.toHaveBeenCalled();
    });
  });

  describe('formHandler saving both tabs', () => {
    it('also writes the tab that is not visible, whose edits live only in itemsByAxis', async () => {
      const mockApp = {
        constructor: MoodConfigApp,
        activeAxis: 'mood',
        itemsByAxis: { mood: [], phase: [{ id: 'p9', label: 'Ninth', icon: 'fas fa-fire', color: '#f44336' }] },
        close: vi.fn()
      };
      const formData = { object: { 'items.0.id': 'calm', 'items.0.label': 'Calm', 'items.0.icon': 'fas fa-leaf', 'items.0.color': '#4caf50' } };

      await MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.configuredMoods, [
        { id: 'calm', label: 'Calm', icon: 'fas fa-leaf', color: '#4caf50' }
      ]);
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.configuredPhases, [
        { id: 'p9', label: 'Ninth', icon: 'fas fa-fire', color: '#f44336' }
      ]);
    });

    it('leaves the other tab alone when it matches what is already stored', async () => {
      setMockSetting('game-orchestra', 'configuredPhases', CONST.defaultPhases);
      const mockApp = {
        constructor: MoodConfigApp,
        activeAxis: 'mood',
        itemsByAxis: { mood: [], phase: foundry.utils.deepClone(CONST.defaultPhases) },
        close: vi.fn()
      };
      const formData = { object: { 'items.0.id': 'calm', 'items.0.label': 'Calm' } };

      await MoodConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      const phaseWrites = game.settings.set.mock.calls.filter((c) => c[1] === CONST.settings.configuredPhases);
      expect(phaseWrites).toEqual([]);
    });

    it('writes only the active axis when driven with a bare single-axis context', async () => {
      const mockApp = { constructor: PhaseConfigApp, close: vi.fn() };
      const formData = { object: { 'items.0.id': 'p2', 'items.0.label': 'Phase Two' } };

      await PhaseConfigApp.formHandler.call(mockApp, new Event('submit'), null, formData);

      const settingsWritten = game.settings.set.mock.calls.map((c) => c[1]);
      expect(settingsWritten).toContain(CONST.settings.configuredPhases);
      expect(settingsWritten).not.toContain(CONST.settings.configuredMoods);
    });
  });
});

describe('MoodWidget', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('handleSetMood', () => {
    it('sets activeMood to selected moodId when different from current active mood', async () => {
      setMockSetting('game-orchestra', 'activeMood', '');
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { moodId: 'boss' } }) };

      await MoodWidget.handleSetMood(event, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activeMood, 'boss');
    });

    it('is a no-op when clicking the currently active mood (moods always have an active one)', async () => {
      setMockSetting('game-orchestra', 'activeMood', 'boss');
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { moodId: 'boss' } }) };

      await MoodWidget.handleSetMood(event, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('does nothing for a non-GM user', async () => {
      game.user = { isGM: false };
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { moodId: 'boss' } }) };

      await MoodWidget.handleSetMood(event, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('refreshes open windows registered in ui.windows when activeMood setting changes', () => {
      registerSettings();
      const mockConfigApp = { constructor: { name: 'GameOrchestraConfig' }, rendered: true, selectedMood: '', render: vi.fn() };
      const mockTreeApp = { constructor: { name: 'PlaylistTreeApp' }, rendered: true, render: vi.fn() };
      globalThis.ui = { windows: { w1: mockConfigApp, w2: mockTreeApp } };

      const settingObj = game.settings.register.mock.calls.find((call) => call[1] === CONST.settings.activeMood)?.[2];
      expect(settingObj).toBeDefined();

      settingObj.onChange('boss');

      expect(mockConfigApp.selectedMood).toBe('boss');
      expect(mockConfigApp.render).toHaveBeenCalledWith(false);
      expect(mockTreeApp.render).toHaveBeenCalledWith(false);
    });
  });

  describe('handleSetPhase', () => {
    it('sets activePhase to selected phaseId when different from current active phase', async () => {
      setMockSetting('game-orchestra', 'activePhase', '');
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { phaseId: 'p2' } }) };

      await MoodWidget.handleSetPhase(event, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activePhase, 'p2');
    });

    it('is a no-op when clicking the currently active phase (phases always have an active one)', async () => {
      setMockSetting('game-orchestra', 'activePhase', 'p2');
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { phaseId: 'p2' } }) };

      await MoodWidget.handleSetPhase(event, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('does nothing for a non-GM user', async () => {
      game.user = { isGM: false };
      const event = { preventDefault: vi.fn() };
      const target = { closest: vi.fn().mockReturnValue({ dataset: { phaseId: 'p2' } }) };

      await MoodWidget.handleSetPhase(event, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });
  });

  describe('open', () => {
    it('does not create or render the widget for a non-GM user', () => {
      game.user = { isGM: false };
      game.gameOrchestra = { moodWidget: null };

      MoodWidget.open();

      expect(game.gameOrchestra.moodWidget).toBeNull();
    });
  });

  describe('handleOpenPlaylistTree', () => {
    it('calls PlaylistTreeApp.open to launch the hierarchy tree manager', () => {
      const event = { preventDefault: vi.fn() };
      game.gameOrchestra = { playlistTree: null };

      MoodWidget.handleOpenPlaylistTree(event, null);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(game.gameOrchestra.playlistTree).toBeDefined();
    });
  });
});
