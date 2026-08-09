import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, MockDocument, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import {
  canonicalizeId,
  getFirstAvailableGM,
  isHeadGM,
  getDocumentCategory,
  sectionBaselinePriority,
  PlaylistContext,
  FadingTrack,
  log,
  setDebugEnabled,
  getCustomGraph,
  isCustomPlaylist,
  resolveInitialTrack,
  getAvailablePlaylists,
  buildPlaylistEntry,
  emitHook,
  describePlaylistContext,
  sectionHasBinding,
  listBoundActors
} from '../scripts/helpers.mjs';

describe('helpers.mjs', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('canonicalizeId', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(canonicalizeId(null)).toBe('');
      expect(canonicalizeId(undefined)).toBe('');
      expect(canonicalizeId('')).toBe('');
    });

    it('strips "GameOrchestra.Mood." prefix before canonicalization', () => {
      expect(canonicalizeId('GameOrchestra.Mood.Calm')).toBe('calm');
    });

    it('strips "GameOrchestra." prefix before canonicalization', () => {
      expect(canonicalizeId('GameOrchestra.Tense')).toBe('tense');
    });

    it('lowercases and replaces non-alphanumeric chars with dashes', () => {
      expect(canonicalizeId('Epic Boss Battle!')).toBe('epic-boss-battle');
    });

    it('trims leading and trailing dashes from result', () => {
      expect(canonicalizeId('---Special-Mood---')).toBe('special-mood');
    });
  });

  describe('getDocumentCategory', () => {
    it('returns "Document" for foundry.abstract.Document instances', () => {
      const doc = new MockDocument();
      expect(getDocumentCategory(doc)).toBe('Document');
    });

    it('returns "PrototypeToken" when constructor.name is "PrototypeToken"', () => {
      function PrototypeToken() {}
      const pt = new PrototypeToken();
      expect(getDocumentCategory(pt)).toBe('PrototypeToken');
    });

    it('returns "DefaultMusic" when documentName is "DefaultMusic"', () => {
      const dm = { documentName: 'DefaultMusic' };
      expect(getDocumentCategory(dm)).toBe('DefaultMusic');
    });

    it('returns null for null/undefined input', () => {
      expect(getDocumentCategory(null)).toBeNull();
      expect(getDocumentCategory(undefined)).toBeNull();
    });

    it('returns null for unrecognized object types', () => {
      expect(getDocumentCategory({ foo: 'bar' })).toBeNull();
    });
  });

  describe('getFirstAvailableGM', () => {
    it('returns first active GM sorted alphabetically by id', () => {
      game.users = [
        { id: 'gm2', isGM: true, active: true },
        { id: 'gm1', isGM: true, active: true },
        { id: 'player1', isGM: false, active: true }
      ];

      const firstGM = getFirstAvailableGM();
      expect(firstGM.id).toBe('gm1');
    });

    it('returns null when no GMs are active', () => {
      game.users = [
        { id: 'gm1', isGM: true, active: false },
        { id: 'player1', isGM: false, active: true }
      ];

      expect(getFirstAvailableGM()).toBeNull();
    });
  });

  describe('isHeadGM', () => {
    it('returns true when game.user matches getFirstAvailableGM', () => {
      const gm = { id: 'gm1', isGM: true, active: true };
      game.users = [gm];
      game.user = gm;

      expect(isHeadGM()).toBe(true);
    });

    it('returns false when game.user is not the first active GM', () => {
      const gm1 = { id: 'gm1', isGM: true, active: true };
      const gm2 = { id: 'gm2', isGM: true, active: true };
      game.users = [gm1, gm2];
      game.user = gm2;

      expect(isHeadGM()).toBe(false);
    });
  });

  describe('sectionBaselinePriority', () => {
    // The hierarchy the module actually promises: a token's theme outranks the scene
    // it stands in, which outranks the world default.
    it('gives a Scene its per-section baselines', () => {
      expect(sectionBaselinePriority({ documentName: 'Scene' }, 'area')).toBe(-20);
      expect(sectionBaselinePriority({ documentName: 'Scene' }, 'combat')).toBe(-15);
    });

    it('gives a Token the combat baseline that outranks both scene sections', () => {
      expect(sectionBaselinePriority({ documentName: 'Token' }, 'combat')).toBe(20);
    });

    it('treats an Actor as its prototype token, since that is who it speaks for', () => {
      expect(sectionBaselinePriority({ documentName: 'Actor' }, 'combat')).toBe(20);
    });

    it('gives the world default its own baselines rather than falling through to 0', () => {
      // This used to short-circuit to 0 - which is ABOVE the scene's -20, so the world
      // default beat every scene binding and the hierarchy ran backwards. Asserting the
      // number is not enough on its own; see the relational tests just below.
      expect(sectionBaselinePriority({ documentName: 'DefaultMusic' }, 'area')).toBe(-40);
      expect(sectionBaselinePriority({ documentName: 'DefaultMusic' }, 'combat')).toBe(-35);
    });

    it('ranks world default < scene < token, which is the promise the module makes', () => {
      const world = sectionBaselinePriority({ documentName: 'DefaultMusic' }, 'combat');
      const scene = sectionBaselinePriority({ documentName: 'Scene' }, 'combat');
      const token = sectionBaselinePriority({ documentName: 'Token' }, 'combat');
      expect(world).toBeLessThan(scene);
      expect(scene).toBeLessThan(token);

      expect(sectionBaselinePriority({ documentName: 'DefaultMusic' }, 'area'))
        .toBeLessThan(sectionBaselinePriority({ documentName: 'Scene' }, 'area'));
    });

    it('returns 0 for a section a scope has no entry for, rather than undefined', () => {
      // Only reachable for a scope/section pair nothing can bind to (Token has no `area`),
      // which is why 0 is safe here even though it would outrank a scene if it ever leaked.
      expect(sectionBaselinePriority({ documentName: 'Token' }, 'area')).toBe(0);
      expect(sectionBaselinePriority(null, 'area')).toBe(0);
    });
  });

  describe('PlaylistContext._extractSectionConfig', () => {
    it('returns null values for null/undefined section', () => {
      const config = PlaylistContext._extractSectionConfig(null, '');
      expect(config).toEqual({ playlistId: null, trackId: null, priority: 0, isOverlay: false });
    });

    describe('scope baseline', () => {
      // The scope's inherent standing is applied HERE, at resolution time, instead of
      // being written into a flag by whichever code path happened to create the
      // binding. Previously only the drag-and-drop path seeded it, so a dragged
      // binding resolved at -20 while an identical dropdown-picked one resolved at 0.
      it('uses the baseline when the section stores no priority of its own', () => {
        const section = { playlist: 'pl1' };
        expect(PlaylistContext._extractSectionConfig(section, '', -20).priority).toBe(-20);
      });

      it('lets a stored priority override the baseline entirely', () => {
        const section = { playlist: 'pl1', priority: 5 };
        expect(PlaylistContext._extractSectionConfig(section, '', -20).priority).toBe(5);
      });

      it('treats a stored 0 as a deliberate override, not as absent', () => {
        const section = { playlist: 'pl1', priority: 0 };
        expect(PlaylistContext._extractSectionConfig(section, '', -20).priority).toBe(0);
      });

      it('adds the overlay offset on top of the baseline', () => {
        // This is what makes a mood/phase row outrank its own section default with
        // no manual priority juggling - the reason most GMs never touch the number.
        const section = { playlist: 'base', overlays: { boss: { playlist: 'boss-pl' } } };
        expect(PlaylistContext._extractSectionConfig(section, 'boss', -20).priority).toBe(-10);
      });

      it('defaults the baseline to 0 when omitted, matching the world default scope', () => {
        expect(PlaylistContext._extractSectionConfig({ playlist: 'pl1' }, '').priority).toBe(0);
      });
    });

    it('returns base section values when no overlay is active', () => {
      const section = { playlist: 'pl1', initialTrack: 'tr1', priority: 5 };
      const config = PlaylistContext._extractSectionConfig(section, '');
      expect(config).toEqual({ playlistId: 'pl1', trackId: 'tr1', priority: 5, isOverlay: false });
    });

    it('returns overlay values when the active overlay id has a playlist', () => {
      const section = {
        playlist: 'base-pl',
        priority: 5,
        overlays: {
          boss: { playlist: 'boss-pl', initialTrack: 'boss-tr', priority: 10 }
        }
      };
      const config = PlaylistContext._extractSectionConfig(section, 'boss');
      expect(config).toEqual({ playlistId: 'boss-pl', trackId: 'boss-tr', priority: 10, isOverlay: true });
    });

    it('falls back to base section when the active overlay id has no playlist', () => {
      const section = {
        playlist: 'base-pl',
        priority: 5,
        overlays: {
          calm: { priority: 2 }
        }
      };
      const config = PlaylistContext._extractSectionConfig(section, 'calm');
      expect(config.playlistId).toBe('base-pl');
      expect(config.isOverlay).toBe(false);
    });

    it('adds an overlay priority offset (+10) when the active overlay id has a playlist but no explicit priority specified', () => {
      const section = {
        playlist: 'base-pl',
        priority: 7,
        overlays: {
          calm: { playlist: 'calm-pl' }
        }
      };
      const config = PlaylistContext._extractSectionConfig(section, 'calm');
      expect(config.priority).toBe(17);
      expect(config.isOverlay).toBe(true);
    });

    it('falls through to the base section when the active overlay is marked as a layer', () => {
      // The whole mechanism behind an overlay layer: it plays ON TOP of the section rather than
      // instead of it, so the section still has to resolve or there is nothing underneath.
      const section = {
        playlist: 'base-pl',
        initialTrack: 'base-tr',
        overlays: { calm: { playlist: 'rain-pl', layer: true } }
      };
      const config = PlaylistContext._extractSectionConfig(section, 'calm');
      expect(config.playlistId).toBe('base-pl');
      expect(config.trackId).toBe('base-tr');
      expect(config.isOverlay).toBe(false);
    });

    it('resolves to nothing when a layering overlay is the section\'s only binding', () => {
      const section = { overlays: { calm: { playlist: 'rain-pl', layer: true } } };
      expect(PlaylistContext._extractSectionConfig(section, 'calm').playlistId).toBeNull();
    });
  });

  describe('PlaylistContext.layerFromDocument', () => {
    let scene, rainPl;

    beforeEach(() => {
      rainPl = createMockPlaylist('rainP', 'Rain', []);
      game.playlists.get = vi.fn((id) => (id === 'rainP' ? rainPl : null));
      setMockSetting('game-orchestra', 'activeMood', 'calm');
      scene = new MockDocument({
        name: 'Scene',
        id: 'sc1',
        getFlag: vi.fn((mod, key) => (key === 'music.area'
          ? { playlist: 'baseP', overlays: { calm: { playlist: 'rainP', initialTrack: 'rt1', layer: true } } }
          : null))
      });
    });

    it('builds a layer context from the active overlay, flagged as such', () => {
      const ctx = PlaylistContext.layerFromDocument(scene, 'area', scene);
      expect(ctx.playlist).toBe(rainPl);
      expect(ctx.trackId).toBe('rt1');
      expect(ctx.isLayer).toBe(true);
      expect(ctx.isOverlay).toBe(true);
      expect(ctx.overlayId).toBe('calm');
    });

    it('carries no priority - a layer never competes, so the number is never read', () => {
      expect(PlaylistContext.layerFromDocument(scene, 'area', scene).priority).toBe(0);
    });

    it('returns null for an overlay that replaces rather than layers', () => {
      scene.getFlag = vi.fn((mod, key) => (key === 'music.area'
        ? { overlays: { calm: { playlist: 'rainP' } } }
        : null));
      expect(PlaylistContext.layerFromDocument(scene, 'area', scene)).toBeNull();
    });

    it('returns null when the live overlay id is a different one', () => {
      setMockSetting('game-orchestra', 'activeMood', 'tense');
      expect(PlaylistContext.layerFromDocument(scene, 'area', scene)).toBeNull();
    });

    it('returns null when the named playlist no longer exists', () => {
      game.playlists.get = vi.fn(() => null);
      expect(PlaylistContext.layerFromDocument(scene, 'area', scene)).toBeNull();
    });

    it('returns null for a document category this module does not configure', () => {
      expect(PlaylistContext.layerFromDocument({ some: 'object' }, 'area')).toBeNull();
      expect(PlaylistContext.layerFromDocument(null, 'area')).toBeNull();
    });

    it('reads the phase axis for a combat section, not the mood one', () => {
      setMockSetting('game-orchestra', 'activePhase', 'enrage');
      scene.getFlag = vi.fn((mod, key) => (key === 'music.combat'
        ? { overlays: { enrage: { playlist: 'rainP', layer: true } } }
        : null));
      expect(PlaylistContext.layerFromDocument(scene, 'combat', scene)?.playlist).toBe(rainPl);
    });
  });

  describe('PlaylistContext._resolveTracks', () => {
    it('returns empty array when playlist is null', () => {
      const ctx = new PlaylistContext('area', null, null, null);
      expect(ctx.tracks).toEqual([]);
    });

    it('returns specific track when trackId is set and exists', () => {
      const sound1 = createMockSound('tr1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Playlist 1', [sound1]);
      const ctx = new PlaylistContext('area', null, playlist, 'tr1');

      expect(ctx.tracks).toEqual([sound1]);
    });

    it('returns empty array when trackId is set but does not exist', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      const ctx = new PlaylistContext('area', null, playlist, 'nonexistent');

      expect(ctx.tracks).toEqual([]);
    });

    it('SIMULTANEOUS mode: returns all sounds', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const s2 = createMockSound('s2', 'Sound 2');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1, s2], 2); // 2 = SIMULTANEOUS
      const ctx = new PlaylistContext('area', null, playlist, null);

      expect(ctx.tracks).toEqual([s1, s2]);
    });

    it('SHUFFLE mode: returns currently playing track if one exists', () => {
      const s1 = createMockSound('s1', 'Sound 1', { playing: false });
      const s2 = createMockSound('s2', 'Sound 2', { playing: true });
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1, s2], 1); // 1 = SHUFFLE
      const ctx = new PlaylistContext('area', null, playlist, null);

      expect(ctx.tracks).toEqual([s2]);
    });

    it('UNSEQUENCED mode: returns empty array', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1], -1); // -1 = UNSEQUENCED
      const ctx = new PlaylistContext('area', null, playlist, null);

      expect(ctx.tracks).toEqual([]);
    });

    it('SEQUENTIAL mode: returns first track from playbackOrder', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const s2 = createMockSound('s2', 'Sound 2');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1, s2], 0); // 0 = SEQUENTIAL
      const ctx = new PlaylistContext('area', null, playlist, null);

      expect(ctx.tracks).toEqual([s1]);
    });

    it('custom graph: returns the sounds of its own Track nodes, ignoring trackId', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const s2 = createMockSound('s2', 'Sound 2');
      const playlist = createMockPlaylist('pl1', 'Graph', [s1, s2], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 's1' }, { id: 't2', type: 'track', soundId: 's2' }],
        edges: []
      });
      // A stale trackId (H2) must not short-circuit past the graph.
      const ctx = new PlaylistContext('area', null, playlist, 's2');

      expect(ctx.tracks).toEqual([s1, s2]);
    });
  });

  describe('PlaylistContext._resolveTracks: Playlist-node references (docs/playlist-node-plan.md Phase 4.4)', () => {
    it('a direct reference to a target WITH its own graph recurses into that graph\'s Track-node sounds', () => {
      const ts1 = createMockSound('ts1', 'Target Sound');
      const target = createMockPlaylist('pl-target', 'Target', [ts1], -1);
      target.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 't1', type: 'track', soundId: 'ts1' }],
        edges: []
      });

      const rs1 = createMockSound('rs1', 'Root Sound');
      const root = createMockPlaylist('pl-root', 'Root', [rs1], -1);
      root.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't1', type: 'track', soundId: 'rs1' },
          { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-target' } }
        ],
        edges: []
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-target' ? target : null));
      const ctx = new PlaylistContext('area', null, root, null);

      expect(ctx.tracks).toEqual(expect.arrayContaining([rs1, ts1]));
      expect(ctx.tracks).toHaveLength(2);
    });

    it('a direct reference to a target with NO graph returns every one of its sounds', () => {
      const ns1 = createMockSound('ns1', 'Native 1');
      const ns2 = createMockSound('ns2', 'Native 2');
      const nativeTarget = createMockPlaylist('pl-native', 'Native', [ns1, ns2], 0);

      const root = createMockPlaylist('pl-root', 'Root', [], -1);
      root.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-native' } }],
        edges: []
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-native' ? nativeTarget : null));
      const ctx = new PlaylistContext('area', null, root, null);

      expect(ctx.tracks).toEqual(expect.arrayContaining([ns1, ns2]));
      expect(ctx.tracks).toHaveLength(2);
    });

    it('does NOT follow an indirect (scene/default) reference - that depends on live state this static resolution cannot evaluate', () => {
      const root = createMockPlaylist('pl-root', 'Root', [], -1);
      root.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', moodMode: 'none' } }],
        edges: []
      });

      const ctx = new PlaylistContext('area', null, root, null);
      expect(ctx.tracks).toEqual([]);
    });

    it('terminates on a Playlist-node reference cycle instead of recursing forever', () => {
      const sa = createMockSound('sa', 'A Sound');
      const sb = createMockSound('sb', 'B Sound');
      const playlistA = createMockPlaylist('pl-a', 'A', [sa], -1);
      const playlistB = createMockPlaylist('pl-b', 'B', [sb], -1);
      playlistA.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't', type: 'track', soundId: 'sa' },
          { id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-b' } }
        ],
        edges: []
      });
      playlistB.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: 'start', type: 'start' },
          { id: 't', type: 'track', soundId: 'sb' },
          { id: 'p', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-a' } }
        ],
        edges: []
      });

      game.playlists.get = vi.fn((id) => (id === 'pl-a' ? playlistA : id === 'pl-b' ? playlistB : null));
      const ctx = new PlaylistContext('area', null, playlistA, null);

      expect(ctx.tracks).toEqual(expect.arrayContaining([sa, sb]));
      expect(ctx.tracks).toHaveLength(2);
    });

    it('a direct reference to a playlist that cannot be resolved contributes no sounds', () => {
      const root = createMockPlaylist('pl-root', 'Root', [], -1);
      root.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'gone' } }],
        edges: []
      });

      game.playlists.get = vi.fn(() => null);
      const ctx = new PlaylistContext('area', null, root, null);

      expect(ctx.tracks).toEqual([]);
    });
  });

  describe('PlaylistContext.fromDocument', () => {
    it('returns null for null document', () => {
      expect(PlaylistContext.fromDocument(null)).toBeNull();
    });

    it('creates context from Document with getFlag', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      game.playlists.push(playlist);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      const doc = new MockDocument({
        name: 'Test Scene',
        getFlag: vi.fn((mod, path) => (path === 'music.area' ? { playlist: 'pl1', priority: 5 } : null))
      });

      const ctx = PlaylistContext.fromDocument(doc, 'area', doc);
      expect(ctx).not.toBeNull();
      expect(ctx.playlist).toBe(playlist);
      expect(ctx.priority).toBe(5);
    });

    it('creates context from PrototypeToken', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      function PrototypeToken() {
        this.flags = { 'game-orchestra': { music: { combat: { playlist: 'pl1', priority: 3 } } } };
      }
      const protoToken = new PrototypeToken();

      const ctx = PlaylistContext.fromDocument(protoToken, 'combat', protoToken);
      expect(ctx).not.toBeNull();
      expect(ctx.playlist).toBe(playlist);
      expect(ctx.priority).toBe(3);
    });

    it('creates context from DefaultMusic configuration object', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      const defaultDoc = {
        documentName: 'DefaultMusic',
        data: { 'game-orchestra': { music: { area: { playlist: 'pl1', priority: -25 } } } }
      };

      const ctx = PlaylistContext.fromDocument(defaultDoc, 'area', null);
      expect(ctx).not.toBeNull();
      expect(ctx.playlist).toBe(playlist);
      expect(ctx.priority).toBe(-25);
    });

    it('returns null when resolved playlist does not exist', () => {
      game.playlists.get = vi.fn(() => null);
      const doc = new MockDocument({
        name: 'Test Scene',
        getFlag: vi.fn(() => ({ playlist: 'nonexistent' }))
      });

      expect(PlaylistContext.fromDocument(doc, 'area')).toBeNull();
    });
  });

  describe('FadingTrack', () => {
    it('removes itself from controller.fadingTracks after timeout', () => {
      vi.useFakeTimers();
      const mockTrack = createMockSound('tr1', 'Track 1');
      const controller = { fadingTracks: [], currentTrack: null, playCurrentTrack: vi.fn() };
      game.gameOrchestra = { musicController: controller };

      const fading = new FadingTrack(mockTrack, 100);
      controller.fadingTracks.push(fading);

      expect(controller.fadingTracks).toHaveLength(1);
      vi.advanceTimersByTime(115);
      expect(controller.fadingTracks).toHaveLength(0);

      vi.useRealTimers();
    });

    it('triggers playCurrentTrack when deleted track matches currentTrack', () => {
      vi.useFakeTimers();
      const mockTrack = createMockSound('tr1', 'Track 1');
      const controller = { fadingTracks: [], currentTrack: mockTrack, playCurrentTrack: vi.fn() };
      game.gameOrchestra = { musicController: controller };

      const fading = new FadingTrack(mockTrack, 100);
      controller.fadingTracks.push(fading);

      vi.advanceTimersByTime(115);
      expect(controller.playCurrentTrack).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('getCustomGraph / isCustomPlaylist', () => {
    it('returns null / false for a playlist with no customPlayback flag', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      expect(getCustomGraph(playlist)).toBeNull();
      expect(isCustomPlaylist(playlist)).toBe(false);
    });

    it('returns the stored graph / true once a customPlayback flag is set', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist 1', []);
      const graph = { version: 1, nodes: [], edges: [] };
      playlist.setFlag('game-orchestra', 'customPlayback', graph);
      expect(getCustomGraph(playlist)).toEqual(graph);
      expect(isCustomPlaylist(playlist)).toBe(true);
    });

    it('handles a null playlist without throwing', () => {
      expect(getCustomGraph(null)).toBeNull();
      expect(isCustomPlaylist(null)).toBe(false);
    });
  });

  describe('H2 guards: custom playlists never receive an implicit initial track', () => {
    it('resolveInitialTrack auto-assigns the first track for a plain Soundboard (UNSEQUENCED, non-custom)', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Soundboard', [s1], -1);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      expect(resolveInitialTrack('pl1', null)).toBe('s1');
    });

    it('resolveInitialTrack does NOT auto-assign a track for a custom playlist, even in UNSEQUENCED mode', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Custom Playlist', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      expect(resolveInitialTrack('pl1', null)).toBeNull();
    });
  });

  describe('resolveInitialTrack: stale track carried over from a different playlist', () => {
    // Regression: reassigning a tree entry to a different playlist (via the
    // dropdown or dragging a bare Playlist, not a specific track) passed the
    // OLD playlist's initialTrack through as `existingTrackId`. Without
    // checking that the id is actually one of the NEW playlist's own sounds,
    // it got written back verbatim - PlaylistContext._resolveTracks() then
    // did `newPlaylist.sounds.get(oldTrackId)`, found nothing, and silently
    // resolved to zero tracks.
    it('drops an existingTrackId that does not belong to the selected playlist (Soundboard mode)', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Soundboard', [s1], -1);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      // 'stale-from-other-playlist' isn't in pl1's sounds - must fall back to
      // the Soundboard auto-first-track behavior, not be kept verbatim.
      expect(resolveInitialTrack('pl1', 'stale-from-other-playlist')).toBe('s1');
    });

    it('drops an existingTrackId that does not belong to the selected playlist (Sequential mode, no auto-assign)', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Sequential', [s1], 0);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      // Non-Soundboard playlists get no auto-assign either way, but a foreign
      // id must still be cleared to null rather than kept.
      expect(resolveInitialTrack('pl1', 'stale-from-other-playlist')).toBeNull();
    });

    it('keeps an existingTrackId that does belong to the selected playlist', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const s2 = createMockSound('s2', 'Sound 2');
      const playlist = createMockPlaylist('pl1', 'Sequential', [s1, s2], 0);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));

      expect(resolveInitialTrack('pl1', 's2')).toBe('s2');
    });

    it('getAvailablePlaylists reports isSoundboard=false and isCustom=true for a custom UNSEQUENCED playlist', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Custom Playlist', [s1], -1);
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      game.playlists = Object.assign([playlist], { get: vi.fn(() => playlist), contents: [playlist] });

      const [entry] = getAvailablePlaylists();
      expect(entry.isSoundboard).toBe(false);
      expect(entry.isCustom).toBe(true);
    });

    it('getAvailablePlaylists still reports isSoundboard=true for a plain (non-custom) UNSEQUENCED playlist', () => {
      const s1 = createMockSound('s1', 'Sound 1');
      const playlist = createMockPlaylist('pl1', 'Soundboard', [s1], -1);
      game.playlists = Object.assign([playlist], { get: vi.fn(() => playlist), contents: [playlist] });

      const [entry] = getAvailablePlaylists();
      expect(entry.isSoundboard).toBe(true);
      expect(entry.isCustom).toBe(false);
    });

    it('buildPlaylistEntry does not auto-select a first track for a custom playlist entry', () => {
      const availablePlaylists = [
        { id: 'pl1', name: 'Custom', isSoundboard: false, isCustom: true, tracks: [{ id: 's1', name: 'Sound 1' }] }
      ];
      const entry = buildPlaylistEntry(availablePlaylists, 'pl1', null);
      expect(entry.initialTrackId).toBeNull();
      expect(entry.isCustom).toBe(true);
    });
  });

  describe('log', () => {
    it('always logs level 1 errors to console.error', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      log(1, 'Test error');
      expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'Test error');
      spy.mockRestore();
    });

    it('logs level 2 warnings to console.warn when enableDebug is true', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setMockSetting('game-orchestra', 'enableDebug', true);
      log(2, 'Test warning');
      expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'Test warning');
      spy.mockRestore();
    });

    it('gracefully handles settings.get throwing error before initialization', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      game.settings.get.mockImplementationOnce(() => {
        throw new Error('Settings not initialized');
      });

      expect(() => log(3, 'Test msg')).not.toThrow();
      expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'Test msg');
      spy.mockRestore();
    });

    it('suppresses level 3 logs when enableDebug is false', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setMockSetting('game-orchestra', 'enableDebug', false);
      log(3, 'Debug msg');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('outputs level 3 logs when enableDebug is true', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      setMockSetting('game-orchestra', 'enableDebug', true);
      log(3, 'Debug msg');
      expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'Debug msg');
      spy.mockRestore();
    });

    describe('thunk argument (used by custom-playback-engine.mjs hot per-hop sites)', () => {
      it('never invokes the thunk when the level is suppressed, so the message is never built', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        setMockSetting('game-orchestra', 'enableDebug', false);
        const thunk = vi.fn(() => 'expensive message');

        log(3, thunk);

        expect(thunk).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });

      it('invokes the thunk and logs its return value when the level will actually print', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        setMockSetting('game-orchestra', 'enableDebug', true);
        const thunk = vi.fn(() => 'lazily built message');

        log(3, thunk);

        expect(thunk).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'lazily built message');
        spy.mockRestore();
      });

      it('always invokes a level-1 thunk, since errors are never suppressed', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const thunk = vi.fn(() => 'error message');

        log(1, thunk);

        expect(thunk).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'error message');
        spy.mockRestore();
      });
    });

    describe('setDebugEnabled cache (avoids a game.settings.get() call on every hot-path log)', () => {
      it('uses the cached value instead of re-reading game.settings once set', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        setDebugEnabled(true);
        const getSpy = vi.spyOn(game.settings, 'get');

        log(3, 'Cached debug msg');

        expect(spy).toHaveBeenCalledWith('Game Orchestra |', 'Cached debug msg');
        expect(getSpy).not.toHaveBeenCalledWith('game-orchestra', 'enableDebug');
        spy.mockRestore();
        getSpy.mockRestore();
      });

      it('suppresses level 3 logs once the cache is set to false, without consulting game.settings', () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
        setDebugEnabled(false);
        const getSpy = vi.spyOn(game.settings, 'get');

        log(3, 'Should not print');

        expect(spy).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalledWith('game-orchestra', 'enableDebug');
        spy.mockRestore();
        getSpy.mockRestore();
      });
    });
  });

  describe('emitHook (every public hook is fire-and-forget and non-fatal)', () => {
    it('forwards the payload to Hooks.callAll under the given name', () => {
      const seen = [];
      Hooks.on('gameOrchestraTrackStarted', (payload) => seen.push(payload));

      emitHook('gameOrchestraTrackStarted', { soundId: 's1' });

      expect(seen).toEqual([{ soundId: 's1' }]);
    });

    it('SWALLOWS a throwing listener, because Hooks.callAll runs listeners synchronously', () => {
      // This is the entire reason emitHook exists. Several of these hooks are emitted from
      // inside the graph engine's token walk; an exception from a third-party listener would
      // otherwise propagate straight back into the walk and silently stop playback. A listener
      // is an observer - it must never be able to break audio.
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      Hooks.on('gameOrchestraTrackStarted', () => { throw new Error('third-party listener bug'); });

      expect(() => emitHook('gameOrchestraTrackStarted', { soundId: 's1' })).not.toThrow();
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('tolerates Hooks being absent entirely', () => {
      const saved = globalThis.Hooks;
      delete globalThis.Hooks;
      expect(() => emitHook('gameOrchestraTrackStarted', {})).not.toThrow();
      globalThis.Hooks = saved;
    });
  });

  describe('describePlaylistContext', () => {
    it('flattens a context into a frozen descriptor carrying no live documents', () => {
      const described = describePlaylistContext({
        playlist: { id: 'p1', name: 'Cave' },
        context: 'combat',
        priority: 20,
        isOverlay: true,
        overlayAxis: 'phase',
        contextEntity: { name: 'Ogre', documentName: 'Token' }
      });

      expect(described).toEqual({
        playlistId: 'p1', playlistName: 'Cave', section: 'combat', priority: 20,
        isOverlay: true, overlayAxis: 'phase', sourceName: 'Ogre', sourceType: 'Token'
      });
      expect(Object.isFrozen(described)).toBe(true);
    });

    it('returns null for no context', () => {
      expect(describePlaylistContext(null)).toBeNull();
    });
  });

  describe('sectionHasBinding', () => {
    it('is true for a section playlist', () => {
      expect(sectionHasBinding({ playlist: 'pl-1' })).toBe(true);
    });

    it('is true for an overlay-only binding', () => {
      expect(sectionHasBinding({ overlays: { enrage: { playlist: 'pl-1' } } })).toBe(true);
    });

    it('is FALSE for a section left holding only exclusive/duck after a clear', () => {
      // Clearing a section deliberately leaves those standing (binding-store.mjs), so the object
      // survives with nothing bound in it. "The section exists" is not "something is bound".
      expect(sectionHasBinding({ exclusive: true, duck: 0.4 })).toBe(false);
    });

    it('is false for an overlay entry whose playlist was removed', () => {
      expect(sectionHasBinding({ overlays: { enrage: { layer: true } } })).toBe(false);
    });

    it('is false for null and undefined', () => {
      expect(sectionHasBinding(null)).toBe(false);
      expect(sectionHasBinding(undefined)).toBe(false);
    });
  });

  describe('listBoundActors', () => {
    const actor = (id, name, combat) => new MockDocument({
      documentName: 'Actor', id, name,
      getFlag: vi.fn((_mod, key) => (key === 'music.combat' ? combat : null))
    });

    it('returns only actors carrying a combat binding, sorted by name', () => {
      game.actors = [
        actor('a1', 'Zombie', { playlist: 'pl-z' }),
        actor('a2', 'Peasant', null),
        actor('a3', 'Archmage', { overlays: { enrage: { playlist: 'pl-a' } } })
      ];

      expect(listBoundActors().map((a) => a.name)).toEqual(['Archmage', 'Zombie']);
    });

    it('returns an empty list rather than throwing when there are no actors at all', () => {
      game.actors = undefined;
      expect(listBoundActors()).toEqual([]);
    });
  });
});
