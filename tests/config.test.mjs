import { describe, it, expect, beforeEach } from 'vitest';
import { setupFoundryMocks } from './mocks/foundry.mjs';

beforeEach(() => {
  setupFoundryMocks();
});

import { CONST } from '../scripts/config.mjs';

describe('CONST', () => {
  it('moduleId equals "game-orchestra"', () => {
    expect(CONST.moduleId).toBe('game-orchestra');
  });

  it('settings object contains required setting keys', () => {
    expect(CONST.settings.defaultMusic).toBe('defaultMusic');
    expect(CONST.settings.suppressArea).toBe('suppressArea');
    expect(CONST.settings.suppressCombat).toBe('suppressCombat');
    expect(CONST.settings.fadeDuration).toBe('fadeDuration');
    expect(CONST.settings.activeMood).toBe('activeMood');
    expect(CONST.settings.configuredMoods).toBe('configuredMoods');
    expect(CONST.settings.moodWidgetPosition).toBe('moodWidgetPosition');
  });

  it('playlistSections contains configurations for expected document types', () => {
    expect(CONST.playlistSections.DefaultMusic).toBeDefined();
    expect(CONST.playlistSections.Scene).toBeDefined();
    expect(CONST.playlistSections.Token).toBeDefined();

    expect(CONST.playlistSections.DefaultMusic.area.priority).toBe(-40);
    expect(CONST.playlistSections.DefaultMusic.combat.priority).toBe(-35);
    expect(CONST.playlistSections.Scene.area.priority).toBe(-20);
    expect(CONST.playlistSections.Scene.combat.priority).toBe(-15);
    expect(CONST.playlistSections.Token.combat.priority).toBe(20);
  });

  // These assert the ORDER, not the numbers. The numbers alone were asserted for a long time
  // and stayed green while the hierarchy resolved backwards: the world default had no entry
  // and fell through to 0, which is above the scene's -20, and "0 is below -20" is a sentence
  // that reads as true until you notice sorting is descending. Renumber freely - just never
  // renumber past one of these.
  describe('scope ladder - higher number wins (MusicController#sortPlaylists sorts descending)', () => {
    const { DefaultMusic, Scene, Token } = CONST.playlistSections;

    it('puts the world default UNDER the scene, in both sections', () => {
      expect(DefaultMusic.area.priority).toBeLessThan(Scene.area.priority);
      expect(DefaultMusic.combat.priority).toBeLessThan(Scene.combat.priority);
    });

    it('puts the token above every scene section, so a turn theme outranks the room', () => {
      expect(Token.combat.priority).toBeGreaterThan(Scene.combat.priority);
      expect(Token.combat.priority).toBeGreaterThan(Scene.area.priority);
    });

    // An overlay resolves at its section's baseline +10 (PlaylistContext._extractSectionConfig).
    // A gap of 10 or less between two scopes would let the lower scope's mood outrank the
    // higher scope's default - the same class of inversion, one rung up.
    const OVERLAY_OFFSET = 10;

    it('keeps a scope gap wider than the overlay offset, so a mood cannot jump a scope', () => {
      expect(Scene.area.priority - DefaultMusic.area.priority).toBeGreaterThan(OVERLAY_OFFSET);
      expect(Scene.combat.priority - DefaultMusic.combat.priority).toBeGreaterThan(OVERLAY_OFFSET);
      expect(Token.combat.priority - Scene.combat.priority).toBeGreaterThan(OVERLAY_OFFSET);
    });

    it('leaves a global mood below a scene default - the case that shipped broken', () => {
      expect(DefaultMusic.area.priority + OVERLAY_OFFSET).toBeLessThan(Scene.area.priority);
    });
  });
});
