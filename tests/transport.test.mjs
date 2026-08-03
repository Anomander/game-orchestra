import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting } from './mocks/foundry.mjs';

setupFoundryMocks();

import {
  SUPPRESSION_CONTROLS,
  suppressionState,
  setSuppression,
  describeResolution,
  localizeResolutionSource,
  isBindingEligible
} from '../scripts/transport.mjs';
import { CONST } from '../scripts/config.mjs';

describe('describeResolution', () => {
  // Pure: no Foundry surface, no settings reads. This is what makes the hub's pill
  // and the widget's pill provably the same sentence rather than two similar ones.
  const scene = { documentName: 'Scene', name: 'Cavern' };

  it('returns null when nothing is playing', () => {
    expect(describeResolution({ context: null, referenceScene: scene, activeMood: '', activePhase: '' })).toBeNull();
  });

  it('names the reference scene\'s own default', () => {
    const result = describeResolution({
      context: { contextEntity: scene, isOverlay: false },
      referenceScene: scene,
      activeMood: '',
      activePhase: ''
    });
    expect(result).toEqual({ key: 'GameOrchestra.PlaylistTree.ActiveAudioSceneDefault', format: null, name: null });
  });

  it('picks the mood key for an area overlay and passes the active mood', () => {
    const result = describeResolution({
      context: { contextEntity: scene, isOverlay: true, overlayAxis: 'mood' },
      referenceScene: scene,
      activeMood: 'tense',
      activePhase: 'enrage'
    });
    expect(result.key).toBe('GameOrchestra.PlaylistTree.ActiveAudioSceneMood');
    expect(result.format).toEqual({ mood: 'tense' });
  });

  it('picks the phase key for a combat overlay and passes the active phase', () => {
    const result = describeResolution({
      context: { contextEntity: scene, isOverlay: true, overlayAxis: 'phase' },
      referenceScene: scene,
      activeMood: 'tense',
      activePhase: 'enrage'
    });
    expect(result.key).toBe('GameOrchestra.PlaylistTree.ActiveAudioScenePhase');
    expect(result.format).toEqual({ mood: 'enrage' });
  });

  it('distinguishes the world default from a scene', () => {
    const result = describeResolution({
      context: { contextEntity: { documentName: 'DefaultMusic' }, isOverlay: false },
      referenceScene: scene,
      activeMood: '',
      activePhase: ''
    });
    expect(result.key).toBe('GameOrchestra.PlaylistTree.ActiveAudioGlobalDefault');
  });

  it('uses the global overlay key when the world default wins through an overlay', () => {
    const result = describeResolution({
      context: { contextEntity: { documentName: 'DefaultMusic' }, isOverlay: true, overlayAxis: 'phase' },
      referenceScene: scene,
      activeMood: '',
      activePhase: 'p2'
    });
    expect(result.key).toBe('GameOrchestra.PlaylistTree.ActiveAudioGlobalPhase');
    expect(result.format).toEqual({ mood: 'p2' });
  });

  it('returns a token/actor by name rather than through a key', () => {
    const result = describeResolution({
      context: { contextEntity: { documentName: 'Token', name: 'Dragon' }, isOverlay: false },
      referenceScene: scene,
      activeMood: '',
      activePhase: ''
    });
    expect(result.name).toBe('Dragon');
  });

  it('treats a DIFFERENT scene as a named entity, not as "this scene"', () => {
    // The widget's reference scene is the active one and the hub's is whichever is
    // selected, so the same context can legitimately describe itself either way.
    const other = { documentName: 'Scene', name: 'Throne Room' };
    const result = describeResolution({
      context: { contextEntity: other, isOverlay: false },
      referenceScene: scene,
      activeMood: '',
      activePhase: ''
    });
    expect(result.name).toBe('Throne Room');
  });

  it('falls back to None when a context has no entity at all', () => {
    const result = describeResolution({ context: { contextEntity: null }, referenceScene: scene, activeMood: '', activePhase: '' });
    expect(result.key).toBe('GameOrchestra.None');
  });
});

describe('isBindingEligible', () => {
  // Pure. Mirrors the two rules that run BEFORE priority is consulted, which is what
  // makes a "beaten by X" label honest: a row that was never in the contest did not
  // lose it.
  it('drops area rows while combat is live, and vice versa', () => {
    expect(isBindingEligible({ section: 'area', overlayId: null, activeOverlayId: '', inCombat: true })).toBe(false);
    expect(isBindingEligible({ section: 'combat', overlayId: null, activeOverlayId: '', inCombat: false })).toBe(false);
  });

  it('counts an overlay row only when its own id is the live one', () => {
    expect(isBindingEligible({ section: 'area', overlayId: 'tense', activeOverlayId: 'tense', inCombat: false })).toBe(true);
    expect(isBindingEligible({ section: 'area', overlayId: 'calm', activeOverlayId: 'tense', inCombat: false })).toBe(false);
  });

  it('counts a section default only while the live overlay has nothing configured', () => {
    // An overlay WITH a playlist replaces the section's own config, so the default
    // is not losing a contest - it is not in one.
    expect(isBindingEligible({ section: 'area', overlayId: null, activeOverlayId: 'tense', inCombat: false, activeOverlayConfigured: false })).toBe(true);
    expect(isBindingEligible({ section: 'area', overlayId: null, activeOverlayId: 'tense', inCombat: false, activeOverlayConfigured: true })).toBe(false);
  });

  it('counts a live combat overlay during combat', () => {
    expect(isBindingEligible({ section: 'combat', overlayId: 'enrage', activeOverlayId: 'enrage', inCombat: true })).toBe(true);
  });
});

describe('localizeResolutionSource', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  it('returns the bare source, without the "Active Audio:" prefix', () => {
    const source = localizeResolutionSource({ key: 'GameOrchestra.PlaylistTree.ActiveAudioSceneDefault', format: null, name: null });
    expect(source).not.toContain('ActiveAudioPrefix');
  });

  it('prefers a named entity verbatim', () => {
    expect(localizeResolutionSource({ key: 'x', format: null, name: 'Dragon' })).toBe('Dragon');
  });

  it('returns null when nothing is playing', () => {
    expect(localizeResolutionSource(null)).toBeNull();
  });
});

describe('suppression controls', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  it('defines exactly the two toggles both hosts render', () => {
    expect(SUPPRESSION_CONTROLS.map((c) => c.setting)).toEqual([CONST.settings.suppressArea, CONST.settings.suppressCombat]);
  });

  it('reads live on/off state', () => {
    setMockSetting('game-orchestra', 'suppressArea', true);
    const [area, combat] = suppressionState();
    expect(area.active).toBe(true);
    expect(combat.active).toBe(false);
  });

  it('toggles the current value when no explicit target is given', async () => {
    setMockSetting('game-orchestra', 'suppressCombat', true);
    await setSuppression(CONST.settings.suppressCombat);
    expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressCombat, false);
  });

  it('honours an explicit target, which is what the scene-control bar passes', async () => {
    await setSuppression(CONST.settings.suppressArea, true);
    expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressArea, true);
  });

  it('re-initializes the control bar so a widget-side toggle updates it too', async () => {
    ui.controls = { initialize: vi.fn() };
    await setSuppression(CONST.settings.suppressArea);
    expect(ui.controls.initialize).toHaveBeenCalled();
  });

  it('does not throw when the settings write is rejected', async () => {
    game.settings.set.mockRejectedValueOnce(new Error('nope'));
    await expect(setSuppression(CONST.settings.suppressArea)).resolves.toBeUndefined();
  });
});
