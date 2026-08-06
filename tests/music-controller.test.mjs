import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockSound, createMockPlaylist, MockDocument } from './mocks/foundry.mjs';

setupFoundryMocks();

// The engine itself is unit-tested in custom-playback-engine.test.mjs; here we only
// need to verify the controller wires into it correctly, so it's mocked out.
vi.mock('../scripts/custom-playback-engine.mjs', () => {
  class MockCustomPlaybackEngine {
    constructor(playlistContext, controller, options = {}) {
      this.playlistContext = playlistContext;
      this.controller = controller;
      this.options = options;
      this.playlist = playlistContext?.playlist ?? null;
      // Mirrors the real constructor's fallback chain, so a test can tell an explicitly-passed
      // graph (what a layer needs, since its target may be a plain native playlist) apart from
      // the empty-graph default that would start and immediately go idle in silence.
      this.graph = options.graph || { version: 1, nodes: [], edges: [] };
      // The sounds this engine's durational nodes currently own. Tests that care about the
      // layer's teardown fade set this per-instance.
      this.activeSounds = [];
      this.start = vi.fn().mockResolvedValue();
      // Mirrors the real engine: live from construction until stop() runs -
      // see CustomPlaybackEngine's isRunning getter (backed by _runId).
      this.isRunning = true;
      this.stop = vi.fn(() => {
        this.isRunning = false;
      });
      // Sensible single-engine defaults (no nested Playlist-node children);
      // tests exercising the nested case override these per-instance.
      this.isPlayingPlaylist = vi.fn((id) => !!id && this.playlist?.id === id);
      this.findEngineFor = vi.fn((id) => (id && this.playlist?.id === id ? this : null));
      this.refreshOverlayReactiveTargets = vi.fn().mockResolvedValue();
      this.activityState = {
        playlistId: this.playlist?.id ?? null,
        runId: 0,
        activeNodeIds: [],
        activeTimings: [],
        enteredNodeId: null,
        traversedEdgeIds: []
      };
      MockCustomPlaybackEngine.instances.push(this);
    }
  }
  MockCustomPlaybackEngine.instances = [];
  return { CustomPlaybackEngine: MockCustomPlaybackEngine };
});

import { MusicController } from '../scripts/music-controller.mjs';
import { CustomPlaybackEngine } from '../scripts/custom-playback-engine.mjs';

describe('MusicController', () => {
  let controller;

  beforeEach(() => {
    setupFoundryMocks();
    controller = new MusicController();
    CustomPlaybackEngine.instances = [];
  });

  describe('currentTrack getter', () => {
    it('returns first element of currentTracks array', () => {
      const track1 = createMockSound('t1', 'Track 1');
      const track2 = createMockSound('t2', 'Track 2');
      controller.currentTracks = [track1, track2];

      expect(controller.currentTrack).toBe(track1);
    });

    it('returns null when currentTracks is empty', () => {
      controller.currentTracks = [];
      expect(controller.currentTrack).toBeNull();
    });
  });

  describe('isAudioLocked', () => {
    it('returns true when game.audio.locked is true', () => {
      game.audio = { locked: true };
      expect(controller.isAudioLocked()).toBe(true);
    });

    it('returns false when game.audio.locked is false', () => {
      game.audio = { locked: false };
      expect(controller.isAudioLocked()).toBe(false);
    });

    it('returns false when game.audio is undefined', () => {
      delete game.audio;
      expect(controller.isAudioLocked()).toBe(false);
    });
  });

  describe('filterPlaylists', () => {
    it('rejects combat context when combat is not started', () => {
      game.combats = { active: { started: false } };
      const ctx = { context: 'combat' };
      expect(controller.filterPlaylists(ctx)).toBe(false);
    });

    it('rejects combat context when suppressCombat setting is true', () => {
      game.combats = { active: { started: true } };
      setMockSetting('game-orchestra', 'suppressCombat', true);
      const ctx = { context: 'combat' };
      expect(controller.filterPlaylists(ctx)).toBe(false);
    });

    it('rejects area context when suppressArea setting is true', () => {
      setMockSetting('game-orchestra', 'suppressArea', true);
      const ctx = { context: 'area' };
      expect(controller.filterPlaylists(ctx)).toBe(false);
    });

    it('accepts combat context when combat started and not suppressed', () => {
      game.combats = { active: { started: true } };
      setMockSetting('game-orchestra', 'suppressCombat', false);
      const ctx = { context: 'combat' };
      expect(controller.filterPlaylists(ctx)).toBe(true);
    });

    it('accepts area context when not suppressed', () => {
      setMockSetting('game-orchestra', 'suppressArea', false);
      const ctx = { context: 'area' };
      expect(controller.filterPlaylists(ctx)).toBe(true);
    });
  });

  describe('excludeAreaWhenCombatApplies', () => {
    it('drops area contexts when a combat context is present', () => {
      const area = { context: 'area' };
      const combat = { context: 'combat' };

      expect(controller.excludeAreaWhenCombatApplies([area, combat])).toEqual([combat]);
    });

    it('leaves area contexts untouched when no combat context is present', () => {
      const area = { context: 'area' };

      expect(controller.excludeAreaWhenCombatApplies([area])).toEqual([area]);
    });

    it('drops every area context when multiple are present alongside one combat context', () => {
      const sceneArea = { context: 'area', playlist: 'scene' };
      const globalArea = { context: 'area', playlist: 'global' };
      const combat = { context: 'combat' };

      expect(controller.excludeAreaWhenCombatApplies([sceneArea, globalArea, combat])).toEqual([combat]);
    });

    it('returns an empty array unchanged', () => {
      expect(controller.excludeAreaWhenCombatApplies([])).toEqual([]);
    });
  });

  describe('sortPlaylists', () => {
    it('prioritizes context entity matching current combatant token', () => {
      const token = { id: 'tok1' };
      const combat = { combatant: { token } };
      const ctxA = { contextEntity: token, priority: 0 };
      const ctxB = { contextEntity: {}, priority: 10 };

      expect(controller.sortPlaylists(ctxA, ctxB, combat)).toBe(-1);
    });

    it('prioritizes context entity matching current combatant actor', () => {
      const actor = { id: 'act1' };
      const combat = { combatant: { actor } };
      const ctxA = { contextEntity: {}, priority: 10 };
      const ctxB = { contextEntity: actor, priority: 0 };

      expect(controller.sortPlaylists(ctxA, ctxB, combat)).toBe(1);
    });

    it('sorts by descending priority when neither matches current combatant', () => {
      const combat = { combatant: null };
      const ctxA = { contextEntity: {}, priority: 5 };
      const ctxB = { contextEntity: {}, priority: 15 };

      expect(controller.sortPlaylists(ctxA, ctxB, combat)).toBe(10); // 15 - 5 > 0 => b comes before a
    });
  });

  describe('additive layers', () => {
    /** A prototype-token-shaped music source, the shape a combatant resolves through. */
    function combatSource(section) {
      function PrototypeToken() {
        this.flags = { 'game-orchestra': { music: { combat: section } } };
      }
      return new PrototypeToken();
    }

    /** Put `token` on the current combatant's turn in a started combat. */
    function combatWith(token) {
      const combatant = { token, isDefeated: false };
      game.combats = { active: { started: true, combatant, combatants: [combatant] } };
      return combatant;
    }

    /** The engine running under one layer key; layers are keyed by what asked for them. */
    const layerEngine = (key = 'combatant') => controller._layers.get(key)?.engine ?? null;

    it('keeps a layering combatant out of the winner pool and exposes it as the layer', () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP', priority: 20 }));

      expect(controller.getAllCurrentPlaylists().map((c) => c.playlist)).not.toContain(bossPl);
      expect(controller.getCombatantLayerContext()?.playlist).toBe(bossPl);
    });

    it('puts an exclusive combatant in the winner pool and produces no layer', () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP', priority: 20, exclusive: true }));

      expect(controller.getAllCurrentPlaylists().map((c) => c.playlist)).toContain(bossPl);
      expect(controller.getCombatantLayerContext()).toBeNull();
    });

    it('suppresses the layer under the same rules as any combat context', () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP' }));

      setMockSetting('game-orchestra', 'suppressCombat', true);
      expect(controller.getCombatantLayerContext()).toBeNull();

      setMockSetting('game-orchestra', 'suppressCombat', false);
      game.combats.active.started = false;
      expect(controller.getCombatantLayerContext()).toBeNull();
    });

    it('starts the layer on a second engine, over a graph synthesized from a native playlist', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', [createMockSound('b1', 'Horns')]);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP' }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };

      await controller._syncLayers();

      expect(layerEngine()).not.toBeNull();
      expect(layerEngine().playlist).toBe(bossPl);
      expect(layerEngine().start).toHaveBeenCalled();
      // The empty-graph default would start and go idle in silence - a native layer target has
      // no stored graph, so one has to be synthesized for it.
      expect(layerEngine().graph.nodes.length).toBeGreaterThan(0);
      // The base engine is untouched: a layer is additive, never a transition.
      expect(controller._customEngine).toBeNull();
    });

    it('refuses to layer the playlist the base context is already playing', async () => {
      const sharedPl = createMockPlaylist('sharedP', 'Shared', []);
      game.playlists.get = vi.fn((id) => (id === 'sharedP' ? sharedPl : null));
      combatWith(combatSource({ playlist: 'sharedP' }));
      controller.currentContext = { playlist: sharedPl };

      await controller._syncLayers();

      expect(layerEngine()).toBeNull();
    });

    it('refuses to layer a playlist already in flight inside the base engine tree', async () => {
      const nestedPl = createMockPlaylist('nestedP', 'Nested', []);
      game.playlists.get = vi.fn((id) => (id === 'nestedP' ? nestedPl : null));
      combatWith(combatSource({ playlist: 'nestedP' }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };
      controller._customEngine = { isRunning: true, isPlayingPlaylist: vi.fn(() => true) };

      await controller._syncLayers();

      expect(layerEngine()).toBeNull();
    });

    it('leaves a layer that resolved to the same playlist running rather than restarting it', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP' }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };

      await controller._syncLayers();
      const first = layerEngine();
      await controller._syncLayers();

      expect(layerEngine()).toBe(first);
      expect(first.stop).not.toHaveBeenCalled();
      expect(first.start).toHaveBeenCalledTimes(1);
    });

    it('retires the layer and fades its sounds when the turn passes to someone without one', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 2);
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP' }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };

      await controller._syncLayers();
      const engine = layerEngine();
      const layerSound = createMockSound('b1', 'Horns', { playing: true });
      engine.activeSounds = [layerSound];

      // Turn passes to a combatant with nothing configured.
      combatWith(combatSource({}));
      await controller._syncLayers();

      expect(engine.stop).toHaveBeenCalledWith({ stopAudio: false });
      expect(layerSound.sound.fade).toHaveBeenCalledWith(0, { duration: 2000 });
      expect(layerEngine()).toBeNull();
      expect(controller.currentLayerContext).toBeNull();
    });

    it('publishes the layer duck as a world setting, exempting the layer engine tree', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP', duck: 0.3 }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };

      await controller._syncLayers();
      // Stand in for a Playlist node inside the layer graph having entered a nested target.
      layerEngine()._registry = new Set(['bossP', 'nestedP']);
      await controller._syncLayers();

      const stored = game.settings.get('game-orchestra', 'activeDuck');
      expect(stored.factor).toBe(0.3);
      expect(stored.exemptPlaylistIds).toEqual(['bossP', 'nestedP']);
    });

    it('writes nothing at all when the layer asks for no ducking', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP' }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };

      await controller._syncLayers();

      // Not merely "stores an empty object": a settings write is broadcast to every client and
      // its onChange re-glides audio that is already at the right level. With no duck asked for
      // and none applied, there is nothing to say.
      expect(game.settings.set.mock.calls.filter((c) => c[1] === 'activeDuck')).toHaveLength(0);
      expect(game.settings.get('game-orchestra', 'activeDuck') ?? {}).toEqual({});
    });

    it('lifts the duck when the layer is retired', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPl : null));
      combatWith(combatSource({ playlist: 'bossP', duck: 0.3 }));
      controller.currentContext = { playlist: createMockPlaylist('baseP', 'Base', []) };
      await controller._syncLayers();

      combatWith(combatSource({}));
      await controller._syncLayers();

      expect(game.settings.get('game-orchestra', 'activeDuck')).toEqual({});
    });

    it('lifts a duck left behind by a previous session, even with no engine to retire', async () => {
      setMockSetting('game-orchestra', 'activeDuck', { factor: 0.2, exemptPlaylistIds: ['gone'] });
      game.combats = { active: null };

      await controller.reconcileRestoredPlayback();

      expect(game.settings.get('game-orchestra', 'activeDuck')).toEqual({});
    });

    it('leaves the layer playing across a base transition that stops every other managed sound', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 2);
      const layerSound = createMockSound('layer1', 'Horns', { playing: true });
      const baseSound = createMockSound('old1', 'Old Track', { playing: true });
      game.playlists.playing = [createMockPlaylist('mixedP', 'Playing', [layerSound, baseSound])];
      controller._managedSoundIds.add('layer1');
      controller._managedSoundIds.add('old1');
      controller._layers.set('combatant', { engine: { isRunning: true, activeSounds: [layerSound] }, context: {} });

      const newSound = createMockSound('new1', 'New Track');
      vi.spyOn(controller, 'playTrack').mockResolvedValue();
      await controller.transitionToContext({
        playlist: createMockPlaylist('newP', 'New Playlist', [newSound]),
        tracks: [newSound],
        scopeEntity: null
      });

      expect(baseSound.sound.fade).toHaveBeenCalledWith(0, { duration: 2000 });
      expect(layerSound.sound.fade).not.toHaveBeenCalled();
      expect(layerSound.playing).toBe(true);
    });
  });

  describe('overlay layers (a mood or phase playing over its section default)', () => {
    let basePl, overlayPl;

    /** A scene whose `music.<section>` flag is exactly `section`. */
    function sceneWith(sections) {
      const scene = new MockDocument({
        name: 'Test Scene',
        id: 'sc1',
        getFlag: vi.fn((mod, key) => {
          if (key === 'music.area') return sections.area ?? null;
          if (key === 'music.combat') return sections.combat ?? null;
          return null;
        })
      });
      game.scenes.active = scene;
      return scene;
    }

    const layerEngine = (key) => controller._layers.get(key)?.engine ?? null;

    beforeEach(() => {
      basePl = createMockPlaylist('baseP', 'Scene Ambience', []);
      overlayPl = createMockPlaylist('overlayP', 'Rain', []);
      const map = { baseP: basePl, overlayP: overlayPl };
      game.playlists.get = vi.fn((id) => map[id] || null);
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      setMockSetting('game-orchestra', 'activePhase', 'p1');
    });

    it('leaves the section default resolving instead of being replaced, and layers the overlay', () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });

      const winners = controller.getAllCurrentPlaylists();
      // The whole mechanism: without the `layer` skip in _extractSectionConfig the overlay would
      // replace the base here and there would be nothing left for it to play over.
      expect(winners.map((c) => c.playlist)).toEqual([basePl]);
      expect(winners[0].isOverlay).toBe(false);

      const layers = controller.getOverlayLayerContexts();
      expect(layers).toHaveLength(1);
      expect(layers[0].playlist).toBe(overlayPl);
      expect(layers[0].isLayer).toBe(true);
      expect(layers[0].overlayId).toBe('calm');
    });

    it('still replaces the section default when the overlay is not marked as a layer', () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP' } } } });

      expect(controller.getAllCurrentPlaylists().map((c) => c.playlist)).toEqual([overlayPl]);
      expect(controller.getOverlayLayerContexts()).toEqual([]);
    });

    it('ignores an overlay on an id that is not the live one for its axis', () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { tense: { playlist: 'overlayP', layer: true } } } });

      expect(controller.getOverlayLayerContexts()).toEqual([]);
    });

    it('takes the scene over the world default rather than layering both', () => {
      const globalPl = createMockPlaylist('globalP', 'Global Rain', []);
      game.playlists.get = vi.fn((id) => ({ baseP: basePl, overlayP: overlayPl, globalP: globalPl })[id] || null);
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });
      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: { 'game-orchestra': { music: { area: { overlays: { calm: { playlist: 'globalP', layer: true } } } } } }
      });

      // Scope is a fallback chain, not a contest - two scopes layering one section at once
      // would be two streams over one base for a single mood.
      const layers = controller.getOverlayLayerContexts();
      expect(layers.map((c) => c.playlist)).toEqual([overlayPl]);
    });

    it('falls back to the world default when the scene marks no layer of its own', () => {
      const globalPl = createMockPlaylist('globalP', 'Global Rain', []);
      game.playlists.get = vi.fn((id) => ({ baseP: basePl, globalP: globalPl })[id] || null);
      sceneWith({ area: { playlist: 'baseP' } });
      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: { 'game-orchestra': { music: { area: { overlays: { calm: { playlist: 'globalP', layer: true } } } } } }
      });

      expect(controller.getOverlayLayerContexts().map((c) => c.playlist)).toEqual([globalPl]);
    });

    it('suppresses an overlay layer under the same rules as any context of its section', () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });

      setMockSetting('game-orchestra', 'suppressArea', true);
      expect(controller.getOverlayLayerContexts()).toEqual([]);
    });

    it('drops an area layer once combat music has won the base resolution', () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });

      expect(controller.getOverlayLayerContexts()).toHaveLength(1);
      // Moods are the area axis: an ambience layer left running over a boss fight is not what
      // "an overlay over the base area music" means.
      controller.currentContext = { context: 'combat', playlist: basePl };
      expect(controller.getOverlayLayerContexts()).toEqual([]);
    });

    it('requires combat to have started before a phase layer applies', () => {
      sceneWith({ combat: { playlist: 'baseP', overlays: { p1: { playlist: 'overlayP', layer: true } } } });

      game.combats = { active: { started: false } };
      expect(controller.getOverlayLayerContexts()).toEqual([]);

      game.combats = { active: { started: true, combatant: null, combatants: [] } };
      expect(controller.getOverlayLayerContexts().map((c) => c.playlist)).toEqual([overlayPl]);
    });

    it('runs the overlay layer on its own engine, keyed by section', async () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });
      controller.currentContext = { context: 'area', playlist: basePl };

      await controller._syncLayers();

      expect(layerEngine('overlay:area')?.playlist).toBe(overlayPl);
      expect(layerEngine('overlay:area').start).toHaveBeenCalled();
      // A native layer target has no stored graph, so one has to be synthesized - the engine's
      // own empty-graph default would start and go idle in silence.
      expect(layerEngine('overlay:area').graph.nodes.length).toBeGreaterThan(0);
      expect(controller._customEngine).toBeNull();
    });

    it('reads the duck off the overlay entry, not the section', async () => {
      sceneWith({
        area: {
          playlist: 'baseP',
          duck: 0.9,
          overlays: { calm: { playlist: 'overlayP', layer: true, duck: 0.25 } }
        }
      });
      controller.currentContext = { context: 'area', playlist: basePl };

      await controller._syncLayers();

      const stored = game.settings.get('game-orchestra', 'activeDuck');
      expect(stored.factor).toBe(0.25);
      expect(stored.exemptPlaylistIds).toEqual(['overlayP']);
    });

    it('runs a combatant layer and an overlay layer side by side, ducking to the deeper of the two', async () => {
      const bossPl = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => ({ baseP: basePl, overlayP: overlayPl, bossP: bossPl })[id] || null);
      sceneWith({ combat: { playlist: 'baseP', overlays: { p1: { playlist: 'overlayP', layer: true, duck: 0.5 } } } });
      function PrototypeToken() {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: 'bossP', duck: 0.2 } } } };
      }
      const combatant = { token: new PrototypeToken(), isDefeated: false };
      game.combats = { active: { started: true, combatant, combatants: [combatant] } };
      controller.currentContext = { context: 'combat', playlist: basePl };

      await controller._syncLayers();

      expect(layerEngine('combatant')?.playlist).toBe(bossPl);
      expect(layerEngine('overlay:combat')?.playlist).toBe(overlayPl);
      const stored = game.settings.get('game-orchestra', 'activeDuck');
      // The deeper duck wins, and BOTH layers are exempt - one layer must never duck another.
      expect(stored.factor).toBe(0.2);
      expect(stored.exemptPlaylistIds.sort()).toEqual(['bossP', 'overlayP']);
    });

    it('refuses an overlay layer whose playlist is the base it would play over (H15)', async () => {
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'baseP', layer: true } } } });
      controller.currentContext = { context: 'area', playlist: basePl };

      await controller._syncLayers();

      expect(layerEngine('overlay:area')).toBeNull();
    });

    it('retires the overlay layer, and only it, when the mood changes', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 2);
      sceneWith({ area: { playlist: 'baseP', overlays: { calm: { playlist: 'overlayP', layer: true } } } });
      controller.currentContext = { context: 'area', playlist: basePl };
      await controller._syncLayers();

      const engine = layerEngine('overlay:area');
      const layerSound = createMockSound('r1', 'Rain', { playing: true });
      engine.activeSounds = [layerSound];

      setMockSetting('game-orchestra', 'activeMood', 'tense');
      await controller._syncLayers();

      expect(engine.stop).toHaveBeenCalledWith({ stopAudio: false });
      expect(layerSound.sound.fade).toHaveBeenCalledWith(0, { duration: 2000 });
      expect(controller._layers.size).toBe(0);
      expect(controller.currentLayerContexts).toEqual([]);
    });

    it('collects overlay-layer playlists for the stale-playback sweep, every overlay id', async () => {
      sceneWith({
        area: {
          overlays: {
            calm: { playlist: 'overlayP', layer: true },
            tense: { playlist: 'baseP', layer: true }
          }
        }
      });

      // Which overlay was live in the PREVIOUS session is unknowable from here, so all of them
      // are candidates for having left a sound marked as playing.
      expect(controller._collectLayerPlaylists().map((p) => p.id).sort()).toEqual(['baseP', 'overlayP']);
    });
  });

  describe('_getCombatantMusicSources', () => {
    it('returns nothing when both token and actor are null', () => {
      expect(controller._getCombatantMusicSources(null, null)).toEqual([]);
    });

    it('linked + useTokenMusic=true: token first', () => {
      const token = { actorLink: true, getFlag: () => true };
      const actor = { id: 'act1' };

      expect(controller._getCombatantMusicSources(token, actor)[0]).toBe(token);
    });

    it('linked + useTokenMusic=false: actor first', () => {
      const token = { actorLink: true, getFlag: () => false };
      const actor = { id: 'act1' };

      expect(controller._getCombatantMusicSources(token, actor)[0]).toBe(actor);
    });

    it('linked + useTokenMusic=false: never consults the token itself', () => {
      const token = { actorLink: true, getFlag: () => false };
      const protoToken = { id: 'proto1' };
      const actor = { id: 'act1', prototypeToken: protoToken };

      expect(controller._getCombatantMusicSources(token, actor)).toEqual([actor, protoToken]);
    });

    it('linked but actorless: falls back to the token', () => {
      const token = { actorLink: true, getFlag: () => false };

      expect(controller._getCombatantMusicSources(token, null)).toEqual([token]);
    });

    it('unlinked: token first', () => {
      const token = { actorLink: false };
      const actor = { id: 'act1' };

      expect(controller._getCombatantMusicSources(token, actor)[0]).toBe(token);
    });

    it('unlinked with a placed token: still offers the prototype token as a fallback', () => {
      const token = { actorLink: false };
      const protoToken = { id: 'proto1' };
      const actor = { id: 'act1', prototypeToken: protoToken };

      expect(controller._getCombatantMusicSources(token, actor)).toEqual([token, protoToken, actor]);
    });

    it('unlinked + no token: prototypeToken first', () => {
      const protoToken = { id: 'proto1' };
      const actor = { prototypeToken: protoToken };

      expect(controller._getCombatantMusicSources(null, actor)[0]).toBe(protoToken);
    });

    it('unlinked + no token + no prototypeToken: actor only', () => {
      const actor = { id: 'act1' };
      expect(controller._getCombatantMusicSources(null, actor)).toEqual([actor]);
    });
  });

  describe('playTrack', () => {
    it('does nothing for null/undefined sound', async () => {
      await expect(controller.playTrack(null)).resolves.toBeUndefined();
    });

    it('calls parent.playSound when available', async () => {
      const sound = createMockSound('s1', 'Sound 1');
      await controller.playTrack(sound);
      expect(sound.parent.playSound).toHaveBeenCalledWith(sound);
    });

    it('falls back to sound.play() when parent.playSound is missing', async () => {
      const sound = createMockSound('s1', 'Sound 1', { parent: null });
      await controller.playTrack(sound);
      expect(sound.play).toHaveBeenCalled();
    });

    it('silently swallows AbortError exceptions', async () => {
      const abortError = new Error('The play request was interrupted');
      abortError.name = 'AbortError';
      const sound = createMockSound('s1', 'Sound 1', {
        parent: { playSound: vi.fn().mockRejectedValue(abortError) }
      });

      await expect(controller.playTrack(sound)).resolves.toBeUndefined();
    });
  });

  describe('stopTrack', () => {
    it('does nothing for null/undefined sound', () => {
      expect(() => controller.stopTrack(null)).not.toThrow();
    });

    it('calls parent.stopSound when available', () => {
      const sound = createMockSound('s1', 'Sound 1');
      controller.stopTrack(sound);
      expect(sound.parent.stopSound).toHaveBeenCalledWith(sound);
    });

    it('falls back to sound.sound.stop() when parent is missing', () => {
      const sound = createMockSound('s1', 'Sound 1', { parent: null });
      controller.stopTrack(sound);
      expect(sound.sound.stop).toHaveBeenCalled();
    });

    it('releases the sound from _managedSoundIds (regression: a sound stayed "managed" forever, so a later manual replay of the same sound got silently faded out)', () => {
      const sound = createMockSound('s1', 'Sound 1');
      controller._managedSoundIds.add('s1');

      controller.stopTrack(sound);

      expect(controller._managedSoundIds.has('s1')).toBe(false);
    });
  });

  describe('savePlaylistData / getPlaylistData', () => {
    it('saves and retrieves offset keyed by entity + soundId', () => {
      const entity = { documentName: 'Scene', id: 'sc1', name: 'Scene 1' };
      const sound = createMockSound('s1', 'Track 1', { sound: { currentTime: 45.5 } });

      controller.savePlaylistData(entity, sound);
      const savedOffset = controller.getPlaylistData(entity, sound);

      expect(savedOffset).toBe(45.5);
    });

    it('returns 0 for entity/sound with no saved data', () => {
      const entity = { documentName: 'Scene', id: 'sc1' };
      const sound = createMockSound('s1', 'Track 1');

      expect(controller.getPlaylistData(entity, sound)).toBe(0);
    });

    it('returns 0 when entity or sound is null', () => {
      expect(controller.getPlaylistData(null, null)).toBe(0);
      expect(controller.getPlaylistData({}, null)).toBe(0);
    });

    it('evicts oldest entry when cache exceeds 50 entities', () => {
      const sound = createMockSound('s1', 'Track 1', { sound: { currentTime: 10 } });

      for (let i = 1; i <= 52; i++) {
        const entity = { documentName: 'Scene', id: `sc_${i}` };
        controller.savePlaylistData(entity, sound);
      }

      // First entry sc_1 should have been evicted
      const firstEntity = { documentName: 'Scene', id: 'sc_1' };
      const lastEntity = { documentName: 'Scene', id: 'sc_52' };

      expect(controller.getPlaylistData(firstEntity, sound)).toBe(0);
      expect(controller.getPlaylistData(lastEntity, sound)).toBe(10);
    });

    it('is a real LRU cache: touching an old entry (save or get) protects it from eviction, even though it was inserted first (regression: eviction was insertion-order/FIFO, not LRU as the code comment claimed)', () => {
      const sound = createMockSound('s1', 'Track 1', { sound: { currentTime: 10 } });
      const oldestEntity = { documentName: 'Scene', id: 'sc_1' };

      for (let i = 1; i <= 49; i++) {
        controller.savePlaylistData({ documentName: 'Scene', id: `sc_${i}` }, sound);
      }
      // Cache is now one below its 50-entry cap. Touch the oldest entry (a
      // save counts as a use) so it becomes the most-recently-used, not the
      // least - under the old FIFO-by-insertion-order behavior this save
      // would leave sc_1's original position untouched, since re-saving an
      // already-present key never even reached the eviction check.
      controller.savePlaylistData(oldestEntity, sound);
      controller.savePlaylistData({ documentName: 'Scene', id: 'sc_50' }, sound); // fills the cache to exactly 50

      // One more distinct entity pushes the cache over its cap, forcing exactly
      // one eviction. Under the old FIFO behavior sc_1 (never moved) would be
      // "oldest" and get evicted; under real LRU sc_2 is oldest instead, since
      // sc_1 was just touched.
      controller.savePlaylistData({ documentName: 'Scene', id: 'sc_51' }, sound);

      expect(controller.getPlaylistData(oldestEntity, sound)).toBe(10);
      expect(controller.getPlaylistData({ documentName: 'Scene', id: 'sc_2' }, sound)).toBe(0);
      expect(controller.getPlaylistData({ documentName: 'Scene', id: 'sc_3' }, sound)).toBe(10);
    });

    it('getPlaylistData() touching an entry also protects it from eviction, not just savePlaylistData()', () => {
      const sound = createMockSound('s1', 'Track 1', { sound: { currentTime: 10 } });
      const oldestEntity = { documentName: 'Scene', id: 'sc_1' };

      for (let i = 1; i <= 50; i++) {
        controller.savePlaylistData({ documentName: 'Scene', id: `sc_${i}` }, sound);
      }
      // A mere read of the oldest entry should count as a use.
      controller.getPlaylistData(oldestEntity, sound);

      controller.savePlaylistData({ documentName: 'Scene', id: 'sc_51' }, sound);

      expect(controller.getPlaylistData(oldestEntity, sound)).toBe(10);
      expect(controller.getPlaylistData({ documentName: 'Scene', id: 'sc_2' }, sound)).toBe(0);
    });
  });

  describe('playCurrentTrack', () => {
    it('returns early when isDebouncing is true', async () => {
      controller.isDebouncing = true;
      const spy = vi.spyOn(controller, 'getAllCurrentPlaylists');
      await controller.playCurrentTrack();
      expect(spy).not.toHaveBeenCalled();
    });

    it('returns early when current user is not head GM', async () => {
      const gm1 = { id: 'gm1', isGM: true, active: true };
      const gm2 = { id: 'gm2', isGM: true, active: true };
      game.users = [gm1, gm2];
      game.user = gm2;

      const spy = vi.spyOn(controller, 'getAllCurrentPlaylists');
      await controller.playCurrentTrack();
      expect(spy).not.toHaveBeenCalled();
    });

    it('registers unlock listener when game audio is locked', async () => {
      game.audio = { locked: true };
      await controller.playCurrentTrack();

      expect(controller._audioUnlockRegistered).toBe(true);
      expect(globalThis.document.addEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), { once: true });
      expect(globalThis.document.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), { once: true });
    });

    it('does not re-register unlock listener if already registered', async () => {
      game.audio = { locked: true };
      controller._audioUnlockRegistered = true;
      globalThis.document.addEventListener.mockClear();

      await controller.playCurrentTrack();
      expect(globalThis.document.addEventListener).not.toHaveBeenCalled();
    });

    it('executes context resolution and calls transitionToContext', async () => {
      vi.useFakeTimers();
      const sound1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('p1', 'Playlist 1', [sound1]);
      const targetCtx = { playlist, tracks: [sound1], context: 'area' };

      vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([targetCtx]);
      vi.spyOn(controller, 'filterPlaylists').mockReturnValue(true);
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockResolvedValue();

      await controller.playCurrentTrack();

      expect(transitionSpy).toHaveBeenCalledWith(targetCtx);
      vi.advanceTimersByTime(350);
      expect(controller.isDebouncing).toBe(false);
      vi.useRealTimers();
    });

    it('picks the combat context over a same-priority area context once combat applies (regression: area no longer wins ties)', async () => {
      vi.useFakeTimers();
      const areaSound = createMockSound('a1', 'Area Sound');
      const combatSound = createMockSound('c1', 'Combat Sound');
      const areaPlaylist = createMockPlaylist('area-pl', 'Tavern Ambience', [areaSound]);
      const combatPlaylist = createMockPlaylist('combat-pl', 'Boss Fight', [combatSound]);
      const areaCtx = { playlist: areaPlaylist, tracks: [areaSound], context: 'area', priority: 0 };
      const combatCtx = { playlist: combatPlaylist, tracks: [combatSound], context: 'combat', priority: 0 };

      // Both tied at priority 0, area pushed before combat — reproduces the pre-fix ordering
      vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([areaCtx, combatCtx]);
      vi.spyOn(controller, 'filterPlaylists').mockReturnValue(true);
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockResolvedValue();

      await controller.playCurrentTrack();

      expect(transitionSpy).toHaveBeenCalledWith(combatCtx);
      vi.advanceTimersByTime(350);
      vi.useRealTimers();
    });

    it('falls back to area when no combat context is available, even during combat', async () => {
      vi.useFakeTimers();
      const areaSound = createMockSound('a1', 'Area Sound');
      const areaPlaylist = createMockPlaylist('area-pl', 'Tavern Ambience', [areaSound]);
      const areaCtx = { playlist: areaPlaylist, tracks: [areaSound], context: 'area', priority: 0 };

      vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([areaCtx]);
      vi.spyOn(controller, 'filterPlaylists').mockReturnValue(true);
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockResolvedValue();

      await controller.playCurrentTrack();

      expect(transitionSpy).toHaveBeenCalledWith(areaCtx);
      vi.advanceTimersByTime(350);
      vi.useRealTimers();
    });

    it('queues a pending debounced play when called while debouncing', async () => {
      vi.useFakeTimers();
      controller.isDebouncing = true;
      const executeSpy = vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([]);

      await controller.playCurrentTrack();
      expect(controller._pendingDebouncedPlay).toBe(true);
      expect(executeSpy).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('skips transition if current tracks already match resolved target context and audio is playing', async () => {
      const sound1 = createMockSound('s1', 'Sound 1', { playing: true });
      const playlist = createMockPlaylist('p1', 'Playlist 1', [sound1]);
      const targetCtx = { playlist, tracks: [sound1], context: 'area' };

      controller.currentContext = { playlist };
      controller.currentTracks = [sound1];

      vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([targetCtx]);
      vi.spyOn(controller, 'filterPlaylists').mockReturnValue(true);
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockResolvedValue();

      await controller.playCurrentTrack();
      expect(transitionSpy).not.toHaveBeenCalled();
    });

    it('restarts transition if context matches but audio is not actually playing (stuck-silent state)', async () => {
      // sound1.playing = false simulates the stuck state after rapid transitions
      const sound1 = createMockSound('s1', 'Sound 1', { playing: false });
      const playlist = createMockPlaylist('p1', 'Playlist 1', [sound1]);
      const targetCtx = { playlist, tracks: [sound1], context: 'area' };

      controller.currentContext = { playlist };
      controller.currentTracks = [sound1];

      vi.spyOn(controller, 'getAllCurrentPlaylists').mockReturnValue([targetCtx]);
      vi.spyOn(controller, 'filterPlaylists').mockReturnValue(true);
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockResolvedValue();

      await controller.playCurrentTrack();
      expect(transitionSpy).toHaveBeenCalledWith(targetCtx);
    });
  });

  describe('transitionToContext', () => {
    it('fades out playing active tracks not in target context and starts new tracks', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 2); // 2 seconds

      const playingSound = createMockSound('old1', 'Old Track', { playing: true });
      const playingPlaylist = createMockPlaylist('oldP', 'Old Playlist', [playingSound]);
      game.playlists.playing = [playingPlaylist];
      // Establish 'old1' as a track this controller itself started, matching real usage
      // where a transition always follows an earlier one rather than pre-existing audio.
      controller._managedSoundIds.add('old1');

      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();
      const stopTrackSpy = vi.spyOn(controller, 'stopTrack');

      await controller.transitionToContext(targetCtx);

      expect(playingSound.sound.fade).toHaveBeenCalledWith(0, { duration: 2000 });
      expect(controller.currentContext).toBe(targetCtx);
      expect(controller.currentTracks).toEqual([newSound]);
      expect(playTrackSpy).toHaveBeenCalledWith(newSound);
    });

    it('immediately stops playing tracks when fadeDuration is 0', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 0);

      const playingSound = createMockSound('old1', 'Old Track', { playing: true });
      const playingPlaylist = createMockPlaylist('oldP', 'Old Playlist', [playingSound]);
      game.playlists.playing = [playingPlaylist];
      controller._managedSoundIds.add('old1');

      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      const stopTrackSpy = vi.spyOn(controller, 'stopTrack');
      await controller.transitionToContext(targetCtx);

      expect(stopTrackSpy).toHaveBeenCalledWith(playingSound);
    });

    it('does not touch a playing track the controller never started (e.g. a GM-started ambience playlist)', async () => {
      setMockSetting('game-orchestra', 'fadeDuration', 2);

      const unmanagedSound = createMockSound('ambience1', 'Rain Ambience', { playing: true });
      const unmanagedPlaylist = createMockPlaylist('ambP', 'Ambience Playlist', [unmanagedSound]);
      game.playlists.playing = [unmanagedPlaylist];
      // Deliberately not added to controller._managedSoundIds - simulates audio the
      // GM started manually, outside of Game Orchestra's control.

      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      const stopTrackSpy = vi.spyOn(controller, 'stopTrack');
      await controller.transitionToContext(targetCtx);

      expect(unmanagedSound.sound.fade).not.toHaveBeenCalled();
      expect(stopTrackSpy).not.toHaveBeenCalledWith(unmanagedSound);
      expect(unmanagedSound.playing).toBe(true);
    });

    it('does not touch a sound it previously managed and stopped, if a GM later starts it manually by hand (regression: a stopped sound stayed "managed" forever)', async () => {
      // First transition starts and later stops trackX - simulating a normal
      // fade-out/stop cycle.
      const trackX = createMockSound('x1', 'Track X');
      const playlistX = createMockPlaylist('pX', 'Playlist X', [trackX]);
      controller._managedSoundIds.add('x1');
      controller.stopTrack(trackX);
      expect(controller._managedSoundIds.has('x1')).toBe(false);

      // The GM now starts that same sound manually from the sidebar, outside
      // Game Orchestra's control - it is playing but was never (re-)added to the
      // managed set.
      trackX.playing = true;
      trackX.sound.playing = true;
      game.playlists.playing = [playlistX];

      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      const stopTrackSpy = vi.spyOn(controller, 'stopTrack');
      await controller.transitionToContext(targetCtx);

      expect(stopTrackSpy).not.toHaveBeenCalledWith(trackX);
      expect(trackX.playing).toBe(true);
    });

    it('adds newly started target tracks to the managed set so a later transition can stop them', async () => {
      const trackA = createMockSound('a1', 'Track A');
      const playlistA = createMockPlaylist('pA', 'Playlist A', [trackA]);
      const ctxA = { playlist: playlistA, tracks: [trackA], scopeEntity: null };

      await controller.transitionToContext(ctxA);

      expect(controller._managedSoundIds.has('a1')).toBe(true);
    });

    it('does not fade in a track once its transition has been superseded by a newer one (regression: a stale fade-in used to ramp a faded-out/stopped track back up)', async () => {
      vi.useFakeTimers();
      try {
        setMockSetting('game-orchestra', 'fadeDuration', 2); // 2 seconds, so _fadeInWhenReady runs

        const firstSound = createMockSound('first1', 'First Track');
        firstSound.sound.loaded = false; // keeps _fadeInWhenReady's retry loop going
        const firstPlaylist = createMockPlaylist('firstP', 'First Playlist', [firstSound]);
        const firstCtx = { playlist: firstPlaylist, tracks: [firstSound], scopeEntity: null };

        vi.spyOn(controller, 'playTrack').mockResolvedValue();

        await controller.transitionToContext(firstCtx);
        // Still waiting for firstSound to report loaded - no fade applied yet.
        expect(firstSound.sound.fade).not.toHaveBeenCalled();

        // A newer transition supersedes the first before its fade-in ever completes.
        const secondSound = createMockSound('second1', 'Second Track', { playing: true });
        const secondPlaylist = createMockPlaylist('secondP', 'Second Playlist', [secondSound]);
        const secondCtx = { playlist: secondPlaylist, tracks: [secondSound], scopeEntity: null };
        await controller.transitionToContext(secondCtx);

        // Let every retry the stale fade-in could have made play out.
        await vi.advanceTimersByTimeAsync(3000);

        expect(firstSound.sound.fade).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not restart a target track that is already playing (redundant transition to the same context)', async () => {
      const areaSound = createMockSound('area1', 'Area Track', { playing: true });
      const areaPlaylist = createMockPlaylist('areaP', 'Area Playlist', [areaSound]);
      const areaCtx = { playlist: areaPlaylist, tracks: [areaSound], scopeEntity: null };

      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(areaCtx);

      expect(playTrackSpy).not.toHaveBeenCalled();
      expect(areaSound.update).not.toHaveBeenCalled();
    });

    it('does not restart a target track whose nested sound object reports playing, even if the top-level flag lags', async () => {
      const areaSound = createMockSound('area1', 'Area Track', { playing: false, sound: { currentTime: 12, loaded: true, playing: true, fade: vi.fn(() => Promise.resolve()), stop: vi.fn(), volume: 1.0 } });
      const areaPlaylist = createMockPlaylist('areaP', 'Area Playlist', [areaSound]);
      const areaCtx = { playlist: areaPlaylist, tracks: [areaSound], scopeEntity: null };

      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(areaCtx);

      expect(playTrackSpy).not.toHaveBeenCalled();
      expect(areaSound.update).not.toHaveBeenCalled();
    });

    it('still starts playback normally for a target track that is not currently playing', async () => {
      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(targetCtx);

      expect(playTrackSpy).toHaveBeenCalledWith(newSound);
      expect(newPlaylist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', [{ _id: 'new1', pausedTime: 0 }]);
    });

    it('triggers _refreshUI and re-renders open playlistTree and moodWidget applications', async () => {
      const treeRender = vi.fn();
      const widgetRender = vi.fn();
      game.gameOrchestra = {
        playlistTree: { rendered: true, render: treeRender },
        moodWidget: { rendered: true, render: widgetRender }
      };

      await controller.transitionToContext(null);

      expect(treeRender).toHaveBeenCalledWith(false);
      expect(widgetRender).toHaveBeenCalledWith(false);
    });

    it('resumes a track at its saved position via pausedTime, not offset', async () => {
      const scopeEntity = { id: 'scene1', documentName: 'Scene' };
      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity };

      controller._savedPlaylistPositions.set('Scene_scene1', { new1: 42.5 });

      await controller.transitionToContext(targetCtx);

      expect(newPlaylist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', [{ _id: 'new1', pausedTime: 42.5 }]);
      expect(newSound.pausedTime).toBe(42.5);
      expect(newPlaylist.updateEmbeddedDocuments).not.toHaveBeenCalledWith('PlaylistSound', [expect.objectContaining({ offset: expect.anything() })]);
    });

    it('sets pausedTime to 0 when no saved position exists for a fresh track', async () => {
      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const targetCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };

      await controller.transitionToContext(targetCtx);

      expect(newPlaylist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', [{ _id: 'new1', pausedTime: 0 }]);
    });

    it('batches simultaneous track starts into one updateEmbeddedDocuments call instead of one update() per track', async () => {
      const s1 = createMockSound('s1', 'Layer 1');
      const s2 = createMockSound('s2', 'Layer 2');
      const s3 = createMockSound('s3', 'Layer 3');
      const layeredPlaylist = createMockPlaylist('layeredP', 'Layered Ambience', [s1, s2, s3], 2); // SIMULTANEOUS
      const targetCtx = { playlist: layeredPlaylist, tracks: [s1, s2, s3], scopeEntity: null };

      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(targetCtx);

      expect(layeredPlaylist.updateEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(layeredPlaylist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', [
        { _id: 's1', pausedTime: 0 },
        { _id: 's2', pausedTime: 0 },
        { _id: 's3', pausedTime: 0 }
      ]);
      expect(s1.update).not.toHaveBeenCalled();
      expect(s2.update).not.toHaveBeenCalled();
      expect(s3.update).not.toHaveBeenCalled();
      expect(playTrackSpy).toHaveBeenCalledTimes(3);
    });

    it('does not start any track from a batch whose transition was superseded while the batched position update was still in flight', async () => {
      const s1 = createMockSound('s1', 'Layer 1');
      const s2 = createMockSound('s2', 'Layer 2');
      const layeredPlaylist = createMockPlaylist('layeredP', 'Layered Ambience', [s1, s2], 2);
      const targetCtx = { playlist: layeredPlaylist, tracks: [s1, s2], scopeEntity: null };

      let resolveUpdate;
      layeredPlaylist.updateEmbeddedDocuments = vi.fn(() => new Promise((resolve) => (resolveUpdate = resolve)));
      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      const transitionPromise = controller.transitionToContext(targetCtx);
      // Let the function run up to (and including) the updateEmbeddedDocuments
      // call - it awaits this._customEngine?.stop() first, which still yields
      // a microtask even though _customEngine is null.
      await Promise.resolve();
      await Promise.resolve();
      expect(typeof resolveUpdate).toBe('function');

      // Supersede before the batched update resolves - mirrors a second
      // transitionToContext() call bumping _transitionSequenceId mid-flight.
      controller._transitionSequenceId++;
      resolveUpdate([]);
      await transitionPromise;

      expect(playTrackSpy).not.toHaveBeenCalled();
    });
  });

  describe('transitionToContext: custom (graph) playlists', () => {
    function createCustomTargetCtx(id = 'graphP') {
      const trackSound = createMockSound('gt1', 'Graph Track');
      const playlist = createMockPlaylist(id, 'Graph Playlist', [trackSound], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'gt1', loopCount: 1 }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      return { playlist, tracks: [trackSound], scopeEntity: null };
    }

    it('delegates to a CustomPlaybackEngine instead of the native per-track loop', async () => {
      const targetCtx = createCustomTargetCtx();
      const playTrackSpy = vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(targetCtx);

      expect(CustomPlaybackEngine.instances).toHaveLength(1);
      expect(CustomPlaybackEngine.instances[0].start).toHaveBeenCalled();
      expect(controller._customEngine).toBe(CustomPlaybackEngine.instances[0]);
      // The native per-track loop must not also have run for a custom target.
      expect(playTrackSpy).not.toHaveBeenCalled();
    });

    it('sets currentTracks to [] for a custom playlist so the next transition never saves resume positions for graph sounds (H9)', async () => {
      const targetCtx = createCustomTargetCtx();

      await controller.transitionToContext(targetCtx);

      expect(controller.currentContext).toBe(targetCtx);
      expect(controller.currentTracks).toEqual([]);
    });

    it('retires a previously running custom engine with stopAudio:false when transitioning away (H11: crossfade, not hard cut)', async () => {
      const customCtx = createCustomTargetCtx();
      await controller.transitionToContext(customCtx);
      const previousEngine = CustomPlaybackEngine.instances[0];

      const newSound = createMockSound('new1', 'New Track');
      const newPlaylist = createMockPlaylist('newP', 'New Playlist', [newSound]);
      const nativeCtx = { playlist: newPlaylist, tracks: [newSound], scopeEntity: null };
      vi.spyOn(controller, 'playTrack').mockResolvedValue();

      await controller.transitionToContext(nativeCtx);

      expect(previousEngine.stop).toHaveBeenCalledWith({ stopAudio: false });
      expect(controller._customEngine).toBeNull();
    });

    it('retires a previous custom engine when transitioning to a genuinely different custom playlist', async () => {
      const firstCtx = createCustomTargetCtx('graphP1');
      await controller.transitionToContext(firstCtx);
      const firstEngine = CustomPlaybackEngine.instances[0];

      const secondCtx = createCustomTargetCtx('graphP2');
      await controller.transitionToContext(secondCtx);

      expect(firstEngine.stop).toHaveBeenCalledWith({ stopAudio: false });
      expect(CustomPlaybackEngine.instances).toHaveLength(2);
      expect(controller._customEngine).toBe(CustomPlaybackEngine.instances[1]);
    });

    it('regression: leaves an already-running graph alone when re-resolving to the SAME playlist (e.g. an unrelated mood change)', async () => {
      // Before this guard existed, playCurrentTrack() re-resolving on every
      // activeMood setting change - regardless of whether the winning context
      // actually depends on mood - fell straight through to the unconditional
      // stop-and-rebuild below, restarting the graph from Start on every
      // irrelevant mood toggle. Worse, since the old engine was retired with
      // stopAudio:false (for legitimate crossfades between different targets),
      // its sounds stayed audible while a brand-new engine for the identical
      // graph started fresh copies alongside them - audibly overlapping.
      const ctx = createCustomTargetCtx('graphP');
      await controller.transitionToContext(ctx);
      const engine = CustomPlaybackEngine.instances[0];

      // A fresh PlaylistContext instance resolving to the same underlying
      // playlist document, exactly as a re-resolution produces.
      const reResolvedCtx = { playlist: ctx.playlist, tracks: ctx.tracks, scopeEntity: null };
      await controller.transitionToContext(reResolvedCtx);

      expect(engine.stop).not.toHaveBeenCalled();
      expect(CustomPlaybackEngine.instances).toHaveLength(1);
      expect(controller._customEngine).toBe(engine);
      expect(controller.currentContext).toBe(reResolvedCtx);
    });

    it('still tells the running engine to re-resolve overlay-reactive nested Playlist nodes, even though the root graph itself is left alone', async () => {
      // The root graph not restarting must not mean nested indirect ('scene'/
      // 'default' source, overlayMode 'active') Playlist-node references stop
      // reacting to mood/phase changes - that reactivity has to come from
      // somewhere else now that it can no longer piggyback on a full root restart.
      const ctx = createCustomTargetCtx('graphP');
      await controller.transitionToContext(ctx);
      const engine = CustomPlaybackEngine.instances[0];

      const reResolvedCtx = { playlist: ctx.playlist, tracks: ctx.tracks, scopeEntity: null };
      await controller.transitionToContext(reResolvedCtx);

      expect(engine.refreshOverlayReactiveTargets).toHaveBeenCalled();
    });

    it('does restart a same-id graph once it is no longer running (e.g. after onCustomGraphChanged tore it down)', async () => {
      const ctx = createCustomTargetCtx('graphP');
      await controller.transitionToContext(ctx);
      const engine = CustomPlaybackEngine.instances[0];
      engine.isRunning = false; // simulates onCustomGraphChanged's explicit stop()

      await controller.transitionToContext(ctx);

      expect(CustomPlaybackEngine.instances).toHaveLength(2);
      expect(controller._customEngine).toBe(CustomPlaybackEngine.instances[1]);
    });
  });

  describe('onCustomGraphChanged (H8: rebuild a running engine after a live graph edit)', () => {
    function createCustomTargetCtx() {
      const trackSound = createMockSound('gt1', 'Graph Track');
      const playlist = createMockPlaylist('graphP', 'Graph Playlist', [trackSound], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'gt1', loopCount: 1 }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      return { playlist, tracks: [trackSound], scopeEntity: null };
    }

    it('forces a rebuild when the changed playlist is the one currently playing', async () => {
      const ctx = createCustomTargetCtx();
      await controller.transitionToContext(ctx);
      const staleEngine = controller._customEngine;
      const playCurrentTrackSpy = vi.spyOn(controller, 'playCurrentTrack');

      await controller.onCustomGraphChanged(ctx.playlist);

      expect(staleEngine.stop).toHaveBeenCalled();
      expect(controller._customEngine).toBeNull();
      expect(controller.currentContext).toBeNull();
      expect(playCurrentTrackSpy).toHaveBeenCalled();
    });

    it('waits for the stale engine to actually finish stopping before starting a replacement (closes the race described in CustomPlaybackEngine.stop()\'s doc comment)', async () => {
      const ctx = createCustomTargetCtx();
      await controller.transitionToContext(ctx);
      const staleEngine = controller._customEngine;
      const playCurrentTrackSpy = vi.spyOn(controller, 'playCurrentTrack');

      let resolveStop;
      staleEngine.stop = vi.fn(() => new Promise((resolve) => { resolveStop = resolve; }));

      const changedPromise = controller.onCustomGraphChanged(ctx.playlist);

      // Stale engine's stop() is still pending - nothing about starting the
      // replacement should have happened yet.
      expect(controller._customEngine).toBe(staleEngine);
      expect(playCurrentTrackSpy).not.toHaveBeenCalled();

      resolveStop();
      await changedPromise;

      expect(controller._customEngine).toBeNull();
      expect(playCurrentTrackSpy).toHaveBeenCalled();
    });

    it('does nothing when the changed playlist is not the one currently playing', async () => {
      const ctx = createCustomTargetCtx();
      await controller.transitionToContext(ctx);
      const runningEngine = controller._customEngine;
      const playCurrentTrackSpy = vi.spyOn(controller, 'playCurrentTrack');

      const otherPlaylist = createMockPlaylist('other', 'Other Playlist', []);
      await controller.onCustomGraphChanged(otherPlaylist);

      expect(runningEngine.stop).not.toHaveBeenCalled();
      expect(controller._customEngine).toBe(runningEngine);
      expect(playCurrentTrackSpy).not.toHaveBeenCalled();
    });

    it('does nothing when nothing is currently playing', () => {
      expect(() => controller.onCustomGraphChanged(createMockPlaylist('pl1', 'Playlist', []))).not.toThrow();
    });

    it('forces a rebuild when the changed playlist is nested (a Playlist node\'s target), even though it is not the root context\'s own playlist', async () => {
      const ctx = createCustomTargetCtx();
      await controller.transitionToContext(ctx);
      const rootEngine = controller._customEngine;
      rootEngine.isPlayingPlaylist = vi.fn((id) => id === 'nested1');
      const playCurrentTrackSpy = vi.spyOn(controller, 'playCurrentTrack');

      const nestedPlaylist = createMockPlaylist('nested1', 'Nested Playlist', []);
      await controller.onCustomGraphChanged(nestedPlaylist);

      expect(rootEngine.stop).toHaveBeenCalled();
      expect(controller._customEngine).toBeNull();
      expect(controller.currentContext).toBeNull();
      expect(playCurrentTrackSpy).toHaveBeenCalled();
    });
  });

  describe('getGraphActivity', () => {
    function customCtx(id = 'graphP') {
      const trackSound = createMockSound('gt1', 'Graph Track');
      const playlist = createMockPlaylist(id, 'Graph Playlist', [trackSound], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'gt1', loopCount: 1 }],
        edges: [{ id: 'e1', from: 'start', to: 't1' }]
      });
      return { playlist, tracks: [trackSound], scopeEntity: null };
    }

    it('returns null when nothing is playing', () => {
      expect(controller.getGraphActivity(createMockPlaylist('pl1', 'Playlist', []))).toBeNull();
    });

    it('returns null when passed no playlist', async () => {
      await controller.transitionToContext(customCtx());
      expect(controller.getGraphActivity(null)).toBeNull();
    });

    it("returns the root engine's activityState for the currently-playing playlist", async () => {
      const ctx = customCtx();
      await controller.transitionToContext(ctx);

      expect(controller.getGraphActivity(ctx.playlist)).toBe(controller._customEngine.activityState);
    });

    it("walks into a descendant engine for a playlist reached only as a Playlist node's target", async () => {
      const ctx = customCtx();
      await controller.transitionToContext(ctx);
      const rootEngine = controller._customEngine;

      const nestedState = { playlistId: 'nested1', runId: 1, activeNodeIds: ['x'], activeTimings: [], enteredNodeId: null, traversedEdgeIds: [] };
      rootEngine.findEngineFor = vi.fn((id) => (id === 'nested1' ? { activityState: nestedState } : null));

      const nestedPlaylist = createMockPlaylist('nested1', 'Nested Playlist', []);
      expect(controller.getGraphActivity(nestedPlaylist)).toBe(nestedState);
    });

    it('returns null for a playlist no engine anywhere in the tree is playing', async () => {
      await controller.transitionToContext(customCtx());
      expect(controller.getGraphActivity(createMockPlaylist('unrelated', 'Unrelated', []))).toBeNull();
    });
  });

  describe('getAllCurrentPlaylists', () => {
    it('returns empty array when no scene, combat, or default music configured', () => {
      game.scenes.active = null;
      game.combats.active = null;
      expect(controller.getAllCurrentPlaylists()).toEqual([]);
    });

    it('collects scene area and combat contexts when active scene exists', () => {
      const areaPlaylist = createMockPlaylist('p1', 'Area Playlist', []);
      const combatPlaylist = createMockPlaylist('p2', 'Combat Playlist', []);
      game.playlists.get = vi.fn((id) => (id === 'p1' ? areaPlaylist : id === 'p2' ? combatPlaylist : null));

      const activeScene = new MockDocument({
        name: 'Scene 1',
        id: 'scene1',
        getFlag: vi.fn((mod, key) => {
          if (key === 'music.area') return { playlist: 'p1' };
          if (key === 'music.combat') return { playlist: 'p2' };
          return null;
        })
      });
      game.scenes.active = activeScene;

      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).toContain(areaPlaylist);
      expect(contexts.map((c) => c.playlist)).toContain(combatPlaylist);
    });

    it('collects default music context when configured', () => {
      const defaultPlaylist = createMockPlaylist('defP', 'Default Area', []);
      game.playlists.get = vi.fn((id) => (id === 'defP' ? defaultPlaylist : null));

      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: { 'game-orchestra': { music: { area: { playlist: 'defP' } } } }
      });

      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).toContain(defaultPlaylist);
    });

    it('falls back to the prototype token when the placed token and actor carry no override', () => {
      const themePlaylist = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? themePlaylist : null));

      function PrototypeToken() {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: 'bossP', priority: 20, exclusive: true } } } };
      }
      const prototypeToken = new PrototypeToken();
      // A linked, placed token whose own flags are empty - exactly what a token gets when the
      // music was assigned on the Actor's prototype token after the token was already placed.
      const token = new MockDocument({ name: 'B', id: 'tok1', actorLink: true, getFlag: vi.fn(() => null) });
      const actor = new MockDocument({ name: 'B', id: 'act1', getFlag: vi.fn(() => null) });
      actor.prototypeToken = prototypeToken;

      const combatant = { token, actor, isDefeated: false };
      game.combats = { active: { started: true, combatant, combatants: [combatant] } };

      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).toContain(themePlaylist);
      expect(contexts.filter((c) => c.playlist === themePlaylist)).toHaveLength(1);
    });

    it('excludes a defeated combatant from context resolution entirely', () => {
      const themePlaylist = createMockPlaylist('bossP', 'Boss Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? themePlaylist : null));

      function PrototypeToken() {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: 'bossP', priority: 20, exclusive: true } } } };
      }
      const defeatedToken = new PrototypeToken();
      const combatant = { token: defeatedToken, isDefeated: true };
      game.combats = { active: { started: true, combatant, combatants: [combatant] } };

      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).not.toContain(themePlaylist);
    });

    it('only the combatant whose turn it is contributes a context', () => {
      const bossPlaylist = createMockPlaylist('bossP', 'Boss Theme', []);
      const scenePlaylist = createMockPlaylist('sceneP', 'Scene Combat', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPlaylist : id === 'sceneP' ? scenePlaylist : null));

      game.scenes.active = new MockDocument({
        name: 'Scene 1',
        id: 'scene1',
        getFlag: vi.fn((mod, key) => (key === 'music.combat' ? { playlist: 'sceneP' } : null))
      });

      function PrototypeToken(playlistId) {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: playlistId, priority: 20, exclusive: true } } } };
      }
      const bossToken = new PrototypeToken('bossP');
      const plainToken = new PrototypeToken(null);
      const boss = { token: bossToken, isDefeated: false };
      const plain = { token: plainToken, isDefeated: false };

      // The boss's turn: its own theme wins.
      game.combats = { active: { started: true, combatant: boss, combatants: [boss, plain] } };
      expect(controller.getAllCurrentPlaylists().map((c) => c.playlist)).toContain(bossPlaylist);

      // The next combatant has no override of its own, so the boss theme must NOT carry over -
      // resolution falls through to the scene's combat music.
      game.combats.active.combatant = plain;
      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).not.toContain(bossPlaylist);
      expect(contexts.map((c) => c.playlist)).toContain(scenePlaylist);
    });

    it('uses the live current combatant, ignoring a defeated one elsewhere in the tracker', () => {
      const bossPlaylist = createMockPlaylist('bossP', 'Boss Theme', []);
      const allyPlaylist = createMockPlaylist('allyP', 'Ally Theme', []);
      game.playlists.get = vi.fn((id) => (id === 'bossP' ? bossPlaylist : id === 'allyP' ? allyPlaylist : null));

      function PrototypeToken(playlistId) {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: playlistId, priority: 20, exclusive: true } } } };
      }
      const defeatedToken = new PrototypeToken('bossP');
      const aliveToken = new PrototypeToken('allyP');
      game.combats = {
        active: {
          started: true,
          combatant: { token: aliveToken },
          combatants: [
            { token: defeatedToken, isDefeated: true },
            { token: aliveToken, isDefeated: false }
          ]
        }
      };

      const contexts = controller.getAllCurrentPlaylists();
      expect(contexts.map((c) => c.playlist)).not.toContain(bossPlaylist);
      expect(contexts.map((c) => c.playlist)).toContain(allyPlaylist);
    });
  });

  describe('6-tier hierarchy resolution', () => {
    let globalDefaultPl, globalMoodPl, sceneDefaultPl, sceneMoodPl, tokenDefaultPl, tokenMoodPl;

    beforeEach(() => {
      globalDefaultPl = createMockPlaylist('g-def', 'Global Default', []);
      globalMoodPl = createMockPlaylist('g-mood', 'Global Mood', []);
      sceneDefaultPl = createMockPlaylist('s-def', 'Scene Default', []);
      sceneMoodPl = createMockPlaylist('s-mood', 'Scene Mood', []);
      tokenDefaultPl = createMockPlaylist('t-def', 'Token Default', []);
      tokenMoodPl = createMockPlaylist('t-mood', 'Token Mood', []);

      const playlistsMap = {
        'g-def': globalDefaultPl,
        'g-mood': globalMoodPl,
        's-def': sceneDefaultPl,
        's-mood': sceneMoodPl,
        't-def': tokenDefaultPl,
        't-mood': tokenMoodPl
      };
      game.playlists.get = vi.fn((id) => playlistsMap[id] || null);

      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: {
          'game-orchestra': {
            music: {
              area: {
                playlist: 'g-def',
                priority: -40,
                overlays: { calm: { playlist: 'g-mood' } }
              }
            }
          }
        }
      });
    });

    it('Level 1 vs Level 2: Global Mood beats Global Default when mood is active', () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      game.scenes.active = null;

      const contexts = controller.getAllCurrentPlaylists();
      contexts.sort((a, b) => controller.sortPlaylists(a, b, null));

      expect(contexts[0].playlist).toBe(globalMoodPl);
      expect(contexts[0].priority).toBe(-30);
    });

    it('Level 2 vs Level 3: Scene Default beats Global Mood', () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const activeScene = new MockDocument({
        name: 'Test Scene',
        id: 'sc1',
        getFlag: vi.fn((mod, key) => (key === 'music.area' ? { playlist: 's-def', priority: -20 } : null))
      });
      game.scenes.active = activeScene;

      const contexts = controller.getAllCurrentPlaylists();
      contexts.sort((a, b) => controller.sortPlaylists(a, b, null));

      expect(contexts[0].playlist).toBe(sceneDefaultPl);
      expect(contexts[0].priority).toBe(-20);
    });

    it('Level 3 vs Level 4: Scene Mood beats Scene Default and Global Mood', () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const activeScene = new MockDocument({
        name: 'Test Scene',
        id: 'sc1',
        getFlag: vi.fn((mod, key) => {
          if (key === 'music.area') {
            return {
              playlist: 's-def',
              priority: -20,
              overlays: { calm: { playlist: 's-mood' } }
            };
          }
          return null;
        })
      });
      game.scenes.active = activeScene;

      const contexts = controller.getAllCurrentPlaylists();
      contexts.sort((a, b) => controller.sortPlaylists(a, b, null));

      expect(contexts[0].playlist).toBe(sceneMoodPl);
      expect(contexts[0].priority).toBe(-10);
    });

    it('Level 4 vs Level 5: Token Default beats Scene Mood', () => {
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      const activeScene = new MockDocument({
        name: 'Test Scene',
        id: 'sc1',
        getFlag: vi.fn((mod, key) => {
          if (key === 'music.area') {
            return {
              playlist: 's-def',
              priority: -20,
              overlays: { calm: { playlist: 's-mood' } }
            };
          }
          return null;
        })
      });
      game.scenes.active = activeScene;

      function PrototypeToken() {
        this.flags = {
          'game-orchestra': {
            music: {
              combat: { playlist: 't-def', priority: 20, exclusive: true }
            }
          }
        };
      }
      const token = new PrototypeToken();
      game.combats = {
        active: {
          started: true,
          combatant: { token },
          combatants: [{ token }]
        }
      };

      const contexts = controller.getAllCurrentPlaylists();
      contexts.sort((a, b) => controller.sortPlaylists(a, b, game.combats.active));

      expect(contexts[0].playlist).toBe(tokenDefaultPl);
      expect(contexts[0].priority).toBe(20);
    });

    it('Level 5 vs Level 6: Token Phase beats Token Default (combat resolves via phase, not mood - see config.mjs#sectionAxis)', () => {
      // activeMood is deliberately left unset here: a combat section's overlay
      // now resolves against activePhase, never activeMood (overlays-and-loop-modes-plan.md O1).
      setMockSetting('game-orchestra', 'activePhase', 'p2');
      function PrototypeToken() {
        this.flags = {
          'game-orchestra': {
            music: {
              combat: {
                playlist: 't-def',
                priority: 20,
                exclusive: true,
                overlays: { p2: { playlist: 't-mood' } }
              }
            }
          }
        };
      }
      const token = new PrototypeToken();
      game.combats = {
        active: {
          started: true,
          combatant: { token },
          combatants: [{ token }]
        }
      };

      const contexts = controller.getAllCurrentPlaylists();
      contexts.sort((a, b) => controller.sortPlaylists(a, b, game.combats.active));

      expect(contexts[0].playlist).toBe(tokenMoodPl);
      expect(contexts[0].priority).toBe(30);
    });
  });

  describe('reconcileRestoredPlayback (playback resurrected from a previous session)', () => {
    /** A playlist whose sounds are all marked as still playing in the document. */
    function playlistWithPlayingSounds(id, name, soundNames, { custom = false } = {}) {
      const sounds = soundNames.map((soundName, i) => createMockSound(`${id}-s${i}`, soundName, { playing: true }));
      const playlist = createMockPlaylist(id, name, sounds, -1);
      if (custom) {
        playlist.setFlag('game-orchestra', 'customPlayback', {
          version: 1,
          nodes: [{ id: '1', type: 'start' }],
          edges: []
        });
      }
      return { playlist, sounds };
    }

    it('stops every custom-playlist sound a previous session left marked as playing', async () => {
      // A hard refresh gives the engine no teardown, so whatever a graph had in
      // flight (with a Fork, several tracks at once) stays playing:true in the
      // world and is restored on the next load, over the graph's fresh run.
      const { playlist, sounds } = playlistWithPlayingSounds('pl1', 'Graph', ['Ambience', 'Drums'], { custom: true });
      game.playlists = Object.assign([playlist], { get: vi.fn(), playing: [] });

      await controller.reconcileRestoredPlayback();

      expect(sounds[0].parent.stopSound).toHaveBeenCalledWith(sounds[0]);
      expect(sounds[1].parent.stopSound).toHaveBeenCalledWith(sounds[1]);
    });

    it('leaves native playlists alone - only graphs are required to restart from Start', async () => {
      const { sounds: nativeSounds, playlist: native } = playlistWithPlayingSounds('pl2', 'Native', ['Tavern']);
      game.playlists = Object.assign([native], { get: vi.fn(), playing: [] });

      await controller.reconcileRestoredPlayback();

      expect(nativeSounds[0].parent.stopSound).not.toHaveBeenCalled();
    });

    it('ignores sounds that are not marked as playing', async () => {
      const { playlist, sounds } = playlistWithPlayingSounds('pl1', 'Graph', ['Ambience'], { custom: true });
      sounds[0].playing = false;
      game.playlists = Object.assign([playlist], { get: vi.fn(), playing: [] });

      await controller.reconcileRestoredPlayback();

      expect(sounds[0].parent.stopSound).not.toHaveBeenCalled();
    });

    it('does nothing on a client that is not the head GM (document updates come from one client)', async () => {
      game.user = { id: 'gm2', isGM: true, active: true };
      game.users = Object.assign([{ id: 'gm1', isGM: true, active: true }, game.user], {
        filter: function (fn) {
          return Array.prototype.filter.call(this, fn);
        }
      });
      const { playlist, sounds } = playlistWithPlayingSounds('pl1', 'Graph', ['Ambience'], { custom: true });
      game.playlists = Object.assign([playlist], { get: vi.fn(), playing: [] });

      await controller.reconcileRestoredPlayback();

      expect(sounds[0].parent.stopSound).not.toHaveBeenCalled();
    });

    it('runs once per session, before the first transition can start an engine', async () => {
      const spy = vi.spyOn(controller, 'reconcileRestoredPlayback').mockResolvedValue();
      game.playlists = Object.assign([], { get: vi.fn(), playing: [] });
      const transitionSpy = vi.spyOn(controller, 'transitionToContext').mockImplementation(async () => {
        expect(spy).toHaveBeenCalled(); // ordering: cleanup lands before anything starts playing
      });

      await controller.playCurrentTrack();
      controller.isDebouncing = false;
      await controller.playCurrentTrack();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(transitionSpy).toHaveBeenCalled();
    });

    it('is deferred until audio is unlocked, so it cannot race Foundry flushing its pending playback', async () => {
      game.audio.locked = true;
      const spy = vi.spyOn(controller, 'reconcileRestoredPlayback').mockResolvedValue();

      await controller.playCurrentTrack();

      expect(spy).not.toHaveBeenCalled();
    });

    it("also stops resurrected sounds in a DIRECTLY-referenced Playlist-node target, even when that target has no graph of its own", async () => {
      const targetSounds = [createMockSound('nat-s0', 'Native Sound', { playing: true })];
      const nativeTarget = createMockPlaylist('pl-native', 'Native Target', targetSounds, 0);

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-native' }, loopCount: 1 }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.playlists = Object.assign([rootPlaylist], {
        get: vi.fn((id) => (id === 'pl-native' ? nativeTarget : id === 'pl-root' ? rootPlaylist : null)),
        playing: []
      });

      await controller.reconcileRestoredPlayback();

      expect(targetSounds[0].parent.stopSound).toHaveBeenCalledWith(targetSounds[0]);
    });

    it('also stops resurrected sounds in an INDIRECTLY-referenced Playlist-node target, resolved against live scene state', async () => {
      const targetSounds = [createMockSound('area-s0', 'Area Sound', { playing: true })];
      const areaPlaylist = createMockPlaylist('pl-area', 'Area Target', targetSounds, 0);

      const rootPlaylist = createMockPlaylist('pl-root', 'Root', [], -1);
      rootPlaylist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', moodMode: 'none' }, loopCount: 1 }
        ],
        edges: [{ id: 'e1', from: 'start', to: 'p1' }]
      });

      game.scenes.active = new MockDocument({
        name: 'Scene 1',
        id: 'scene1',
        getFlag: vi.fn((mod, key) => (key === 'music.area' ? { playlist: 'pl-area' } : null))
      });

      game.playlists = Object.assign([rootPlaylist], {
        get: vi.fn((id) => (id === 'pl-area' ? areaPlaylist : id === 'pl-root' ? rootPlaylist : null)),
        playing: []
      });

      await controller.reconcileRestoredPlayback();

      expect(targetSounds[0].parent.stopSound).toHaveBeenCalledWith(targetSounds[0]);
    });

    it('terminates on a Playlist-node reference cycle instead of recursing forever', async () => {
      const soundsA = [createMockSound('a-s0', 'A Sound', { playing: true })];
      const soundsB = [createMockSound('b-s0', 'B Sound', { playing: true })];
      const playlistA = createMockPlaylist('pl-a', 'A', soundsA, -1);
      const playlistB = createMockPlaylist('pl-b', 'B', soundsB, -1);
      playlistA.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-b' }, loopCount: 1 }],
        edges: [{ id: 'e1', from: 'start', to: 'p' }]
      });
      playlistB.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-a' }, loopCount: 1 }],
        edges: [{ id: 'e1', from: 'start', to: 'p' }]
      });

      game.playlists = Object.assign([playlistA, playlistB], {
        get: vi.fn((id) => (id === 'pl-a' ? playlistA : id === 'pl-b' ? playlistB : null)),
        playing: []
      });

      await expect(controller.reconcileRestoredPlayback()).resolves.not.toThrow();

      expect(soundsA[0].parent.stopSound).toHaveBeenCalledWith(soundsA[0]);
      expect(soundsB[0].parent.stopSound).toHaveBeenCalledWith(soundsB[0]);
    });
  });
});
