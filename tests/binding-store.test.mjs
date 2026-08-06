import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting } from './mocks/foundry.mjs';

setupFoundryMocks();

import {
  toDeletionKey,
  bindingPath,
  coercePriority,
  documentFlagStore,
  updateObjectStore,
  globalSettingStore,
  applyBindingPlaylist,
  applyBindingTrack,
  applyBindingPriority,
  applyBindingLayer,
  applyBindingDuck,
  clearBindingOverlay
} from '../scripts/binding-store.mjs';
import { CONST } from '../scripts/config.mjs';

/**
 * A BindingStore over a plain object, so the operations can be exercised with no
 * Foundry surface at all - the whole point of the store/ops split.
 */
function fakeStore(initial = {}) {
  const data = foundry.utils.deepClone(initial);
  const plans = [];
  return {
    data,
    plans,
    get: (path) => foundry.utils.getProperty(data, path) ?? null,
    apply: async (plan) => {
      plans.push(plan);
      for (const [path, value] of Object.entries(plan.set || {})) foundry.utils.setProperty(data, path, value);
      for (const path of plan.unset || []) {
        const cut = path.lastIndexOf('.');
        const parent = cut < 0 ? data : foundry.utils.getProperty(data, path.slice(0, cut));
        if (parent) delete parent[cut < 0 ? path : path.slice(cut + 1)];
      }
    }
  };
}

describe('binding-store path helpers', () => {
  describe('toDeletionKey', () => {
    it('moves the -= operator onto the leaf, not the front of the path', () => {
      expect(toDeletionKey('music.combat.playlist')).toBe('music.combat.-=playlist');
    });

    it('handles a single-segment path', () => {
      expect(toDeletionKey('playlist')).toBe('-=playlist');
    });
  });

  describe('bindingPath', () => {
    it('builds a section path when no overlay is given', () => {
      expect(bindingPath('area')).toBe('music.area');
    });

    it('builds an overlay path when one is', () => {
      expect(bindingPath('combat', 'enrage')).toBe('music.combat.overlays.enrage');
    });
  });

  describe('coercePriority', () => {
    it('keeps 0 rather than treating it as blank', () => {
      expect(coercePriority('0')).toBe(0);
    });

    it('returns null for blank and whitespace, meaning "inherit"', () => {
      expect(coercePriority('')).toBeNull();
      expect(coercePriority('   ')).toBeNull();
      expect(coercePriority(null)).toBeNull();
    });

    it('returns null rather than NaN for a non-numeric value', () => {
      expect(coercePriority('abc')).toBeNull();
    });

    it('accepts negatives', () => {
      expect(coercePriority('-20')).toBe(-20);
    });
  });
});

describe('binding operations', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('applyBindingPlaylist', () => {
    it('writes playlist and resolved track in ONE plan, not one call per field', async () => {
      const store = fakeStore();
      await applyBindingPlaylist(store, 'music.area', 'pl-1', 'tr-9');

      expect(store.plans).toHaveLength(1);
      expect(store.plans[0].set).toEqual({
        'music.area.playlist': 'pl-1',
        'music.area.initialTrack': 'tr-9'
      });
    });

    it('uses an explicit track override verbatim instead of resolving one', async () => {
      const store = fakeStore({ music: { area: { initialTrack: 'tr-old' } } });
      await applyBindingPlaylist(store, 'music.area', 'pl-1', 'tr-dropped');

      expect(store.get('music.area.initialTrack')).toBe('tr-dropped');
    });

    it('clears playlist, track AND priority together when the playlist is removed', async () => {
      const store = fakeStore({ music: { area: { playlist: 'pl-1', initialTrack: 'tr-1', priority: 5 } } });
      await applyBindingPlaylist(store, 'music.area', null);

      expect(store.plans).toHaveLength(1);
      expect(store.plans[0].unset).toEqual(['music.area.playlist', 'music.area.initialTrack', 'music.area.priority']);
      expect(store.data.music.area).toEqual({});
    });

    it('leaves a section-level exclusive/duck standing when the playlist is cleared', async () => {
      // Those belong to the section, not the binding - clearing the playlist must not
      // silently turn a layer into an exclusive theme (architecture.md § Layers).
      const store = fakeStore({ music: { combat: { playlist: 'pl-1', exclusive: true, duck: 0.4 } } });
      await applyBindingPlaylist(store, 'music.combat', null);

      expect(store.data.music.combat).toEqual({ exclusive: true, duck: 0.4 });
    });
  });

  describe('applyBindingTrack', () => {
    it('sets the track', async () => {
      const store = fakeStore();
      await applyBindingTrack(store, 'music.area', 'tr-2');
      expect(store.get('music.area.initialTrack')).toBe('tr-2');
    });

    it('unsets the track when cleared', async () => {
      const store = fakeStore({ music: { area: { initialTrack: 'tr-2' } } });
      await applyBindingTrack(store, 'music.area', null);
      expect(store.get('music.area.initialTrack')).toBeNull();
    });
  });

  describe('applyBindingPriority', () => {
    it('stores an explicit 0 rather than unsetting', async () => {
      const store = fakeStore();
      await applyBindingPriority(store, 'music.area', 0);
      expect(store.get('music.area.priority')).toBe(0);
    });

    it('unsets on null, so the entry inherits the section baseline again', async () => {
      const store = fakeStore({ music: { area: { priority: 12 } } });
      await applyBindingPriority(store, 'music.area', null);
      expect(store.get('music.area.priority')).toBeNull();
    });
  });

  describe('clearBindingOverlay', () => {
    it('removes the whole overlay entry, not just its fields', async () => {
      const store = fakeStore({ music: { combat: { overlays: { p1: { playlist: 'pl-1', initialTrack: 't' }, p2: { playlist: 'pl-2' } } } } });
      await clearBindingOverlay(store, 'combat', 'p1');

      expect(store.data.music.combat.overlays.p1).toBeUndefined();
      expect(store.data.music.combat.overlays.p2).toEqual({ playlist: 'pl-2' });
    });

    it('takes layer and duck with it, so neither can outlive the binding', async () => {
      // A cleared entry that kept `layer: true` would silently start layering again the next
      // time a playlist was picked for it, for a reason nothing on screen explains.
      const store = fakeStore({ music: { area: { overlays: { calm: { playlist: 'pl-1', layer: true, duck: 0.3 } } } } });
      await clearBindingOverlay(store, 'area', 'calm');

      expect(store.data.music.area.overlays.calm).toBeUndefined();
    });
  });

  describe('applyBindingLayer', () => {
    it('stores the flag when the overlay is made a layer', async () => {
      const store = fakeStore({ music: { area: { overlays: { calm: { playlist: 'pl-1' } } } } });
      await applyBindingLayer(store, 'music.area.overlays.calm', true);

      expect(store.data.music.area.overlays.calm.layer).toBe(true);
    });

    it('unsets rather than storing false - replacing is the absent-value default', async () => {
      const store = fakeStore({ music: { area: { overlays: { calm: { playlist: 'pl-1', layer: true } } } } });
      await applyBindingLayer(store, 'music.area.overlays.calm', false);

      expect('layer' in store.data.music.area.overlays.calm).toBe(false);
    });

    it('clears the duck alongside it, so a stale attenuation cannot come back', async () => {
      const store = fakeStore({ music: { area: { overlays: { calm: { playlist: 'pl-1', layer: true, duck: 0.2 } } } } });
      await applyBindingLayer(store, 'music.area.overlays.calm', false);

      expect('duck' in store.data.music.area.overlays.calm).toBe(false);
      expect(store.data.music.area.overlays.calm.playlist).toBe('pl-1');
    });
  });

  describe('applyBindingDuck', () => {
    it('stores the multiplier', async () => {
      const store = fakeStore({ music: { area: { overlays: { calm: {} } } } });
      await applyBindingDuck(store, 'music.area.overlays.calm', 0.35);

      expect(store.data.music.area.overlays.calm.duck).toBe(0.35);
    });

    it('removes the key at 1, so "no ducking" stays the absent value', async () => {
      const store = fakeStore({ music: { area: { overlays: { calm: { duck: 0.35 } } } } });
      await applyBindingDuck(store, 'music.area.overlays.calm', 1);

      expect('duck' in store.data.music.area.overlays.calm).toBe(false);
    });

    it('writes each change as one whole plan, never a path at a time', async () => {
      const store = fakeStore({});
      await applyBindingDuck(store, 'music.area.overlays.calm', 0.5);

      expect(store.plans).toHaveLength(1);
    });
  });
});

describe('store backends', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('documentFlagStore', () => {
    it('reads and writes through the document flag API', async () => {
      const doc = { getFlag: vi.fn(() => 'pl-x'), setFlag: vi.fn(), unsetFlag: vi.fn() };
      const store = documentFlagStore(doc);

      expect(store.get('music.area.playlist')).toBe('pl-x');
      await store.apply({ set: { 'music.area.playlist': 'pl-y' }, unset: ['music.area.initialTrack'] });

      expect(doc.setFlag).toHaveBeenCalledWith(CONST.moduleId, 'music.area.playlist', 'pl-y');
      expect(doc.unsetFlag).toHaveBeenCalledWith(CONST.moduleId, 'music.area.initialTrack');
    });

    it('returns null rather than undefined for an absent flag', () => {
      const store = documentFlagStore({ getFlag: () => undefined });
      expect(store.get('music.area.playlist')).toBeNull();
    });
  });

  describe('updateObjectStore', () => {
    it('commits a whole plan in a SINGLE updateObject call', async () => {
      // The regression this batching exists to prevent: two writes meant two document
      // round-trips and two re-renders for one assignment.
      const host = { updateObject: vi.fn(), readData: () => ({}) };
      await updateObjectStore(host).apply({
        set: { 'music.combat.playlist': 'pl-1', 'music.combat.initialTrack': 'tr-1' },
        unset: ['music.combat.priority']
      });

      expect(host.updateObject).toHaveBeenCalledTimes(1);
      expect(host.updateObject).toHaveBeenCalledWith({
        'music.combat.playlist': 'pl-1',
        'music.combat.initialTrack': 'tr-1',
        'music.combat.-=priority': null
      });
    });

    it('reads through the host data', () => {
      const host = { updateObject: vi.fn(), readData: () => ({ music: { area: { playlist: 'pl-7' } } }) };
      expect(updateObjectStore(host).get('music.area.playlist')).toBe('pl-7');
    });
  });

  describe('globalSettingStore', () => {
    it('commits a whole plan in a SINGLE settings write', async () => {
      setMockSetting('game-orchestra', 'defaultMusic', { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } });

      await globalSettingStore().apply({ set: { 'music.area.playlist': 'pl-1', 'music.area.initialTrack': 'tr-1' } });

      const writes = game.settings.set.mock.calls.filter((c) => c[1] === CONST.settings.defaultMusic);
      expect(writes).toHaveLength(1);
      expect(writes[0][2].data['game-orchestra'].music.area).toEqual({ playlist: 'pl-1', initialTrack: 'tr-1' });
    });

    it('deletes a key on unset rather than nulling it', async () => {
      setMockSetting('game-orchestra', 'defaultMusic', {
        documentName: 'DefaultMusic',
        data: { 'game-orchestra': { music: { area: { playlist: 'pl-1', priority: 3 } } } }
      });

      await globalSettingStore().apply({ unset: ['music.area.priority'] });

      const written = game.settings.set.mock.calls.filter((c) => c[1] === CONST.settings.defaultMusic).pop()[2];
      expect('priority' in written.data['game-orchestra'].music.area).toBe(false);
      expect(written.data['game-orchestra'].music.area.playlist).toBe('pl-1');
    });
  });
});
