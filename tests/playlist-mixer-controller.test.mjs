import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { MixerController, refreshMixerViews } from '../scripts/playlist-mixer-controller.mjs';
import { clearSolo, getSoloIds } from '../scripts/playlist-mix-apply.mjs';

/**
 * createMockPlaylist() points each sound's `parent` at a stub carrying only the fields the
 * engine needs. The mixer reads the playlist's own flags through that same reference (a real
 * PlaylistSound#parent IS the Playlist document), so the two are joined up here.
 */
function makePlaylist(sounds, { mode = 0 } = {}) {
  const playlist = createMockPlaylist('pl1', 'Ambience', sounds, mode);
  for (const sound of sounds) {
    sound.parent = Object.assign(sound.parent, {
      id: playlist.id,
      getFlag: playlist.getFlag,
      sounds: playlist.sounds
    });
  }
  game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));
  return playlist;
}

const soundAt = (volume, overrides = {}) => Object.assign(createMockSound(`s${volume * 100}`, `Track ${volume}`), { volume, ...overrides });

/** A controller with the host's refresh callback stubbed, as both real hosts supply one. */
const controllerFor = (playlist, options = {}) => {
  const controller = new MixerController({ playlistId: playlist?.id, onRefresh: vi.fn(), ...options });
  controllers.push(controller);
  return controller;
};

/** Controllers register themselves globally on construction; leaking them across tests would
 *  make refreshMixerViews() fire into dead fixtures. */
let controllers = [];

beforeEach(() => {
  for (const controller of controllers) controller.teardown();
  controllers = [];
  clearSolo('pl1');
  foundry.applications.instances = new Map();
});

describe('MixerController.prepareData', () => {
  it('builds one row per sound, in playlist order', () => {
    const playlist = makePlaylist([soundAt(0.5), soundAt(0.25)]);
    const data = controllerFor(playlist).prepareData();

    expect(data.tracks.map((t) => t.name)).toEqual(['Track 0.5', 'Track 0.25']);
  });

  it('converts volumes through the same curve the sidebar uses, so the two agree', () => {
    // 0.5 volume is not a 50% slider - AudioHelper applies a 1.5-order curve, and reading the
    // stored value as a percentage directly is what would make this window disagree with core.
    const playlist = makePlaylist([soundAt(0.5)]);
    const [row] = controllerFor(playlist).prepareData().tracks;

    expect(row.percent).toBe(63);
    expect(Number(row.sliderValue)).toBeCloseTo(0.63, 2);
  });

  it('reports the effective percentage separately once a gain applies', () => {
    const playlist = makePlaylist([soundAt(0.5)]);
    playlist.setFlag('game-orchestra', 'mix', { gain: 0.5 });
    const [row] = controllerFor(playlist).prepareData().tracks;

    expect(row.effectivePercent).toBeLessThan(row.percent);
  });

  it('flags a row the ceiling is holding down, but not one merely turned down by the gain', () => {
    const playlist = makePlaylist([soundAt(1), soundAt(0.2)]);
    playlist.setFlag('game-orchestra', 'mix', { ceiling: 0.5 });
    const rows = controllerFor(playlist).prepareData().tracks;

    expect(rows[0].clamped).toBe(true);
    expect(rows[1].clamped).toBe(false);
  });

  it('reports a muted row as silent, whatever its own volume says', () => {
    const loud = soundAt(1);
    const playlist = makePlaylist([loud]);
    playlist.setFlag('game-orchestra', 'mix', { muted: [loud.id] });
    const [row] = controllerFor(playlist).prepareData().tracks;

    expect(row.muted).toBe(true);
    expect(row.effectivePercent).toBe(0);
    expect(row.percent).toBe(100); // the stored level is intact and comes back on unmute
  });

  describe('the type-specific column', () => {
    it('counts Track-node references for a graph playlist', () => {
      const [a, b] = [createMockSound('s1', 'A'), createMockSound('s2', 'B')];
      const playlist = makePlaylist([a, b], { mode: -1 });
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1' },
          { id: '3', type: 'track', soundId: 's1' }
        ],
        edges: []
      });
      const rows = controllerFor(playlist).prepareData().tracks;

      expect(rows[0].usedBy).toBe(2);
      expect(rows[1].usedBy).toBe(0); // "which of my tracks isn't the graph playing?"
      expect(rows[0].order).toBeNull();
    });

    it('reports a playback position instead for a native playlist, and no usage count at all', () => {
      const playlist = makePlaylist([createMockSound('s1', 'A'), createMockSound('s2', 'B')]);
      const rows = controllerFor(playlist).prepareData().tracks;

      expect(rows.map((r) => r.order)).toEqual([1, 2]);
      expect(rows.every((r) => r.usedBy === null)).toBe(true);
    });
  });

  describe('the crossfade field', () => {
    it('is blank when nothing overrides the world setting', () => {
      setMockSetting('game-orchestra', 'graphCrossfade', 150);
      const playlist = makePlaylist([soundAt(1)]);
      const data = controllerFor(playlist).prepareData();

      expect(data.header.crossfadeMs).toBeNull();
      expect(data.header.worldCrossfadeMs).toBe(150);
    });

    it("shows a legacy graph-stored override, so a value this window never wrote is still visible and editable", () => {
      const playlist = makePlaylist([soundAt(1)], { mode: -1 });
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [], crossfadeMs: 300 });
      const data = controllerFor(playlist).prepareData();

      expect(data.header.crossfadeMs).toBe(300);
    });

    it('lets the mix override win over the legacy value', () => {
      const playlist = makePlaylist([soundAt(1)], { mode: -1 });
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [], crossfadeMs: 300 });
      playlist.setFlag('game-orchestra', 'mix', { crossfadeMs: 0 });
      const data = controllerFor(playlist).prepareData();

      // 0, not null: "never crossfade this playlist" is a value, and must not read as inheriting.
      expect(data.header.crossfadeMs).toBe(0);
    });
  });

  describe('the seam warning', () => {
    it('fires for a graph playlist with a playlist-level fade', () => {
      const playlist = makePlaylist([soundAt(1)], { mode: -1 });
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      playlist.fade = 500;

      expect(controllerFor(playlist).prepareData().header.fadeBreaksSeam).toBe(true);
    });

    it('stays quiet for a native playlist with the same fade - there is no seam to break', () => {
      const playlist = makePlaylist([soundAt(1)]);
      playlist.fade = 500;

      expect(controllerFor(playlist).prepareData().header.fadeBreaksSeam).toBe(false);
    });
  });
});

describe('mute', () => {
  it('is stored in the mix flag rather than by zeroing the document volume, so unmute restores the level', async () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);

    await controller.toggleMute(sound.id);

    expect(playlist.getFlag('game-orchestra', 'mix').muted).toEqual([sound.id]);
    expect(sound.volume).toBe(0.8);

    await controller.toggleMute(sound.id);

    // The regression this shape exists for: a flag write is a recursive MERGE server-side, so a
    // `{id: true}` map could never have the id removed - unmute flipped the UI, restored the
    // audio, and came back muted on the next reload. An array is replaced wholesale.
    expect(playlist.getFlag('game-orchestra', 'mix').muted).toEqual([]);
    expect(sound.volume).toBe(0.8);
  });
});

describe('solo', () => {
  it('is session state, never written to the playlist', () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);

    controller.toggleSolo(sound.id);

    expect(getSoloIds('pl1')).toEqual(new Set([sound.id]));
    expect(playlist.setFlag).not.toHaveBeenCalled();
  });

  it('is dropped when the window closes - a solo left behind would silence tracks with nothing left to un-silence them from', () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);
    controller.toggleSolo(sound.id);

    controller.teardown();

    expect(getSoloIds('pl1').size).toBe(0);
  });
});

describe('reset', () => {
  it('clears the mix and any solo, but deliberately leaves the per-track volumes alone', async () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    playlist.setFlag('game-orchestra', 'mix', { gain: 0.3 });
    const controller = controllerFor(playlist);
    controller.toggleSolo(sound.id);

    await controller.reset();

    expect(playlist.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'mix');
    expect(getSoloIds('pl1').size).toBe(0);
    // Track volumes are documents. Reset clears what the window layered ON TOP, not the levels
    // the GM set on the tracks themselves.
    expect(sound.volume).toBe(0.8);
  });
});

describe('bake', () => {
  it('writes the effective volumes onto the tracks and resets the gain and ceiling', async () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    playlist.setFlag('game-orchestra', 'mix', { gain: 0.5 });
    const controller = controllerFor(playlist);

    await controller.bake();

    expect(playlist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', [{ _id: sound.id, volume: 0.4 }]);
    const mix = playlist.getFlag('game-orchestra', 'mix');
    expect(mix.gain).toBe(1);
    expect(mix.ceiling).toBe(1);
  });

  it('leaves a muted track alone - baking it to 0 would destroy the level mute exists to preserve', async () => {
    const sound = soundAt(0.8);
    const playlist = makePlaylist([sound]);
    playlist.setFlag('game-orchestra', 'mix', { gain: 0.5, muted: [sound.id] });
    const controller = controllerFor(playlist);

    await controller.bake();

    expect(playlist.updateEmbeddedDocuments).not.toHaveBeenCalled();
    expect(playlist.getFlag('game-orchestra', 'mix').muted).toEqual([sound.id]);
    expect(sound.volume).toBe(0.8);
  });

  it('does nothing at all when the confirmation is declined', async () => {
    foundry.applications.api.DialogV2.confirm = vi.fn(() => Promise.resolve(false));
    const playlist = makePlaylist([soundAt(0.8)]);
    playlist.setFlag('game-orchestra', 'mix', { gain: 0.5 });
    const controller = controllerFor(playlist);

    await controller.bake();

    expect(playlist.updateEmbeddedDocuments).not.toHaveBeenCalled();
    expect(playlist.getFlag('game-orchestra', 'mix').gain).toBe(0.5);
    foundry.applications.api.DialogV2.confirm = vi.fn(() => Promise.resolve(true));
  });
});

describe('keyboard', () => {
  const key = (overrides) => ({ preventDefault: vi.fn(), target: {}, ...overrides });

  function controllerWith(sounds) {
    const playlist = makePlaylist(sounds);
    const controller = controllerFor(playlist);
    controller.attach({ querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    return { controller, playlist };
  }

  it('moves the cursor down and selects as it goes', () => {
    const { controller } = controllerWith([soundAt(0.5), soundAt(0.25)]);

    controller._onKeyDown(key({ key: 'ArrowDown' }));

    expect(controller.selection.size).toBe(1);
  });

  it('stops at the ends rather than wrapping', () => {
    const { controller } = controllerWith([soundAt(0.5), soundAt(0.25)]);
    controller._onKeyDown(key({ key: 'ArrowUp' }));
    const first = [...controller.selection][0];
    controller._onKeyDown(key({ key: 'ArrowUp' }));

    expect([...controller.selection][0]).toBe(first);
  });

  it('adjusts the cursor row\'s volume, stepping on the slider rather than on the raw volume', () => {
    // An even step in volume space is a huge move at the top of the 1.5-order curve and an
    // inaudible one at the bottom.
    const sound = soundAt(0.5);
    const { controller } = controllerWith([sound]);
    controller._onKeyDown(key({ key: 'ArrowDown' }));
    const before = sound.volume;

    controller._onKeyDown(key({ key: 'ArrowRight' }));

    expect(sound.volume).toBeGreaterThan(before);
    expect(sound.volume).toBeLessThanOrEqual(1);
    // Through core's own debounced writer, so the mixer and the sidebar coalesce the same way.
    expect(sound.debounceVolume).toHaveBeenCalled();
  });

  it('mutes and solos the cursor row', () => {
    const sound = soundAt(0.5);
    const { controller, playlist } = controllerWith([sound]);
    controller._onKeyDown(key({ key: 'ArrowDown' }));

    controller._onKeyDown(key({ key: 'm' }));
    controller._onKeyDown(key({ key: 's' }));

    expect(playlist.setFlag).toHaveBeenCalled();
    expect(getSoloIds('pl1')).toEqual(new Set([sound.id]));
  });

  it('keeps its hands off a focused text field - S in a fade box is the letter S', () => {
    const sound = soundAt(0.5);
    const { controller } = controllerWith([sound]);
    controller._onKeyDown(key({ key: 'ArrowDown' }));

    controller._onKeyDown(key({ key: 's', target: { tagName: 'INPUT', type: 'number' } }));

    expect(getSoloIds('pl1').size).toBe(0);
  });

  it('selects every row on Ctrl+A and clears on Escape', () => {
    const { controller } = controllerWith([soundAt(0.5), soundAt(0.25)]);

    controller._onKeyDown(key({ key: 'a', ctrlKey: true }));
    expect(controller.selection.size).toBe(2);

    controller._onKeyDown(key({ key: 'Escape' }));
    expect(controller.selection.size).toBe(0);
  });
});

describe('dragging vs. adjusting (reported live: grabbing the volume knob dragged the track)', () => {
  /** A row element with just the surface _onMouseDown touches. */
  function fakeRow() {
    const row = { draggable: true, matches: (sel) => sel.includes('draggable') };
    const control = { closest: (sel) => (sel.includes('input') ? control : sel.includes('game-orchestra-mixer-row') ? row : null) };
    const label = { closest: (sel) => (sel.includes('game-orchestra-mixer-row') ? row : null) };
    return { row, control, label };
  }

  let listeners;
  let realAddEventListener;
  beforeEach(() => {
    listeners = {};
    realAddEventListener = globalThis.document.addEventListener;
    globalThis.document.addEventListener = vi.fn((type, fn) => {
      (listeners[type] ||= []).push(fn);
    });
  });
  // Restored so this block cannot change how anything after it sees `document`.
  afterEach(() => {
    globalThis.document.addEventListener = realAddEventListener;
  });

  const fire = (type) => (listeners[type] || []).forEach((fn) => fn());

  it('clears the row\'s draggability while one of its controls is pressed', () => {
    const controller = controllerFor(makePlaylist([soundAt(0.5)]), { graphTools: true });
    const { row, control } = fakeRow();

    controller._onMouseDown({ target: control });

    // Draggability is resolved from the nearest draggable ANCESTOR at drag start, so leaving it
    // set means the browser starts a track drag and the slider never sees the gesture.
    expect(row.draggable).toBe(false);
  });

  it('restores it on mouseup, which is bound on document because the pointer is usually elsewhere by then', () => {
    const controller = controllerFor(makePlaylist([soundAt(0.5)]), { graphTools: true });
    const { row, control } = fakeRow();
    controller._onMouseDown({ target: control });

    fire('mouseup');

    expect(row.draggable).toBe(true);
  });

  it('leaves a press on the row itself alone - that is the drag gesture', () => {
    const controller = controllerFor(makePlaylist([soundAt(0.5)]), { graphTools: true });
    const { row, label } = fakeRow();

    controller._onMouseDown({ target: label });

    expect(row.draggable).toBe(true);
  });

  it('binds the guard only where rows are draggable at all', () => {
    const withTools = controllerFor(makePlaylist([soundAt(0.5)]), { graphTools: true });
    const plain = controllerFor(makePlaylist([soundAt(0.5)]));
    const root = () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: () => null });

    const toolsRoot = root();
    const plainRoot = root();
    withTools.attach(toolsRoot);
    plain.attach(plainRoot);

    const bound = (r) => r.addEventListener.mock.calls.map(([type]) => type);
    expect(bound(toolsRoot)).toContain('mousedown');
    expect(bound(plainRoot)).not.toContain('mousedown');
  });
});
