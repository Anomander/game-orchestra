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

/* -------------------------------------------- */
/*  The input layer                             */
/* -------------------------------------------- */

/**
 * The mixer's markup, reduced to the selectors the controller actually queries.
 *
 * There is no jsdom here, and the controller's listeners are delegated - they resolve everything
 * from the event target and from `_root.querySelector`. So the fixture only needs to answer those
 * queries: one row (with its two readouts) and one slider per sound, plus `contains`, which
 * `_onClick` uses to make sure it only claims buttons inside its own subtree.
 * @param {string[]} soundIds
 * @returns {object} A root stub, with the per-sound elements exposed for assertions.
 */
function fakeMixerDom(soundIds) {
  const rows = {};
  const sliders = {};
  const readouts = {};
  const effectives = {};

  for (const id of soundIds) {
    readouts[id] = { textContent: '' };
    effectives[id] = { textContent: '' };
    rows[id] = {
      dataset: { soundId: id },
      classList: { contains: () => false },
      querySelector: (sel) => (sel.includes('effective') ? effectives[id] : sel.includes('readout') ? readouts[id] : null)
    };
    sliders[id] = { value: '', dataset: { soundId: id } };
  }

  const root = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    contains: () => true,
    querySelector: (sel) => {
      // refresh() bails while a slider is under the pointer; nothing here is being dragged.
      if (sel.includes(':active')) return null;
      const match = /data-sound-id="([^"]+)"/.exec(sel);
      if (!match) return null;
      if (sel.includes('mixer-volume')) return sliders[match[1]] ?? null;
      if (sel.includes('mixer-row')) return rows[match[1]] ?? null;
      return null;
    }
  };
  return Object.assign(root, { rows, sliders, readouts, effectives });
}

/** A range input carrying a `data-mix-action`, as every mixer slider does. */
const slider = (mixAction, value, extra = {}) => ({
  type: 'range',
  value: String(value),
  dataset: { mixAction, ...(extra.dataset ?? {}) },
  parentElement: extra.parentElement ?? null
});

/** A non-range field carrying a `data-mix-action` - the crossfade and fade boxes. */
const field = (mixAction, value, extra = {}) => ({
  type: 'number',
  value: String(value),
  dataset: { mixAction, ...(extra.dataset ?? {}) }
});

/** An event whose target resolves `closest()` from an explicit selector map. */
function clickOn(ancestors, extra = {}) {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { closest: (sel) => ancestors[sel] ?? null },
    ...extra
  };
}

describe('_onInput (live slider movement)', () => {
  it('writes a track slider through to the document and updates its readouts without a rebuild', () => {
    // A rebuild mid-drag would replace the very <input type="range"> under the pointer.
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);
    const root = fakeMixerDom([sound.id]);
    controller.attach(root);

    controller._onInput({ target: slider('trackVolume', 0.8, { dataset: { soundId: sound.id } }) });

    expect(sound.volume).toBeCloseTo(Math.pow(0.8, 1.5), 5);
    expect(sound.debounceVolume).toHaveBeenCalled();
    expect(root.readouts[sound.id].textContent).toBe('80%');
    expect(controller._onRefresh).not.toHaveBeenCalled();
  });

  it('moves the whole selection *relatively* by default, preserving the balance already dialled in', () => {
    const loud = soundAt(0.8);
    const quiet = soundAt(0.4);
    const playlist = makePlaylist([loud, quiet]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([loud.id, quiet.id]));
    controller.selection = new Set([loud.id, quiet.id]);

    // Target peak 0.4^1.5; the loudest selected track lands there and the other keeps its ratio.
    controller._onInput({ target: slider('gain', 0.4), altKey: false });

    const target = Math.pow(0.4, 1.5);
    expect(loud.volume).toBeCloseTo(target, 5);
    expect(quiet.volume).toBeCloseTo(target * (0.4 / 0.8), 5);
    expect(quiet.volume).toBeLessThan(loud.volume); // the balance survived
  });

  it('flattens the selection to one absolute level when Alt is held', () => {
    const loud = soundAt(0.8);
    const quiet = soundAt(0.4);
    const playlist = makePlaylist([loud, quiet]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([loud.id, quiet.id]));
    controller.selection = new Set([loud.id, quiet.id]);

    controller._onInput({ target: slider('gain', 0.4), altKey: true });

    expect(loud.volume).toBeCloseTo(quiet.volume, 5);
    expect(loud.volume).toBeCloseTo(Math.pow(0.4, 1.5), 5);
  });

  it('pushes group volumes back onto the sliders and readouts it did not come from', () => {
    const loud = soundAt(0.8);
    const quiet = soundAt(0.4);
    const controller = controllerFor(makePlaylist([loud, quiet]));
    const root = fakeMixerDom([loud.id, quiet.id]);
    controller.attach(root);
    controller.selection = new Set([loud.id, quiet.id]);

    controller._onInput({ target: slider('gain', 0.4), altKey: true });

    expect(Number(root.sliders[loud.id].value)).toBeCloseTo(0.4, 2);
    expect(Number(root.sliders[quiet.id].value)).toBeCloseTo(0.4, 2);
    expect(root.readouts[quiet.id].textContent).toBe('40%');
  });

  it('with nothing selected, the gain slider is the playlist gain and is persisted to the mix flag', async () => {
    vi.useFakeTimers();
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([sound.id]));

    controller._onInput({ target: slider('gain', 0.5) });

    expect(sound.volume).toBe(0.5); // the tracks themselves are untouched
    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'mix', expect.objectContaining({ gain: Math.pow(0.5, 1.5) }));
    vi.useRealTimers();
  });

  it('persists a ceiling move to the mix flag', async () => {
    vi.useFakeTimers();
    const playlist = makePlaylist([soundAt(1)]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));

    controller._onInput({ target: slider('ceiling', 0.5) });

    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'mix', expect.objectContaining({ ceiling: Math.pow(0.5, 1.5) }));
    vi.useRealTimers();
  });

  it('updates the header readout next to the slider that moved', () => {
    const readout = { textContent: '' };
    const parentElement = { querySelector: (sel) => (sel.includes('readout') ? readout : null) };
    const controller = controllerFor(makePlaylist([soundAt(1)]));
    controller.attach(fakeMixerDom([]));

    controller._onInput({ target: slider('ceiling', 0.25, { parentElement }) });

    expect(readout.textContent).toBe('25%');
  });

  it('makes a dragged gain audible immediately, before the debounced write lands', () => {
    // Otherwise the slider moves and nothing is heard until the write settles.
    const playing = soundAt(1, { playing: true });
    playing.sound.playing = true;
    const controller = controllerFor(makePlaylist([playing]));
    controller.attach(fakeMixerDom([playing.id]));

    controller._onInput({ target: slider('gain', 0.5) });

    expect(playing.sound.fade).toHaveBeenCalled();
    const [target] = playing.sound.fade.mock.calls.at(-1);
    expect(target).toBeLessThan(1);
  });

  it('previews a soloed selection by silencing everything else', () => {
    const kept = soundAt(1, { playing: true });
    const silenced = soundAt(0.5, { playing: true });
    kept.sound.playing = true;
    silenced.sound.playing = true;
    const controller = controllerFor(makePlaylist([kept, silenced]));
    controller.attach(fakeMixerDom([kept.id, silenced.id]));
    controller.toggleSolo(kept.id);
    kept.sound.fade.mockClear();
    silenced.sound.fade.mockClear();

    controller._onInput({ target: slider('ceiling', 0.9) });

    expect(silenced.sound.fade.mock.calls.at(-1)[0]).toBe(0);
    expect(kept.sound.fade.mock.calls.at(-1)[0]).toBeGreaterThan(0);
  });

  it('ignores an input event that is not one of its sliders', () => {
    const sound = soundAt(0.5);
    const controller = controllerFor(makePlaylist([sound]));
    controller.attach(fakeMixerDom([sound.id]));

    controller._onInput({ target: { type: 'range', value: '0.1', dataset: {} } }); // no mix action
    controller._onInput({ target: field('trackVolume', 0.1, { dataset: { soundId: sound.id } }) }); // not a range

    expect(sound.volume).toBe(0.5);
  });
});

describe('_onChange (committed fields)', () => {
  it('reflects a clamped crossfade back into the field and stores it', async () => {
    vi.useFakeTimers();
    const playlist = makePlaylist([soundAt(1)]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));
    const target = field('crossfade', ' 1234.6 ');

    controller._onChange({ target, stopPropagation: vi.fn() });

    expect(target.value).toBe('1235'); // rounding reflected back, so the box never lies
    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'mix', expect.objectContaining({ crossfadeMs: 1235 }));
    vi.useRealTimers();
  });

  it('clears a blanked crossfade back to inheriting', async () => {
    vi.useFakeTimers();
    const playlist = makePlaylist([soundAt(1)]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));
    const target = field('crossfade', '   ');

    controller._onChange({ target, stopPropagation: vi.fn() });

    expect(target.value).toBe('');
    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'mix', expect.objectContaining({ crossfadeMs: null }));
    vi.useRealTimers();
  });

  it('writes a per-track fade to that track only', async () => {
    vi.useFakeTimers();
    const sound = soundAt(0.5);
    const other = soundAt(0.25);
    const controller = controllerFor(makePlaylist([sound, other]));
    controller.attach(fakeMixerDom([sound.id, other.id]));

    controller._onChange({ target: field('trackFade', '250', { dataset: { soundId: sound.id } }), stopPropagation: vi.fn() });

    expect(sound.updateSource).toHaveBeenCalledWith({ fade: 250 });
    await vi.advanceTimersByTimeAsync(200);
    expect(sound.fade).toBe(250);
    expect(other.fade).toBeUndefined();
    vi.useRealTimers();
  });

  it('applies a fade to every selected track in one round-trip', async () => {
    vi.useFakeTimers();
    const first = soundAt(0.5);
    const second = soundAt(0.25);
    const playlist = makePlaylist([first, second]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([first.id, second.id]));
    controller.selection = new Set([first.id, second.id]);

    controller._onChange({ target: field('fade', '400'), stopPropagation: vi.fn() });

    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.updateEmbeddedDocuments).toHaveBeenCalledTimes(1);
    expect(first.fade).toBe(400);
    expect(second.fade).toBe(400);
    vi.useRealTimers();
  });

  it('with nothing selected the fade field is the playlist fade, and 0 clears it to null', async () => {
    // Playlist#fade is `positive: true` in the schema - 0 is not storable, and null already
    // means "no playlist fade".
    vi.useFakeTimers();
    const playlist = makePlaylist([soundAt(1)]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));

    controller._onChange({ target: field('fade', '0'), stopPropagation: vi.fn() });

    await vi.advanceTimersByTimeAsync(200);
    expect(playlist.update).toHaveBeenCalledWith({ fade: null });
    vi.useRealTimers();
  });

  it('rounds and floors a fade rather than storing a negative or fractional one', () => {
    const sound = soundAt(0.5);
    const controller = controllerFor(makePlaylist([sound]));
    controller.attach(fakeMixerDom([sound.id]));

    const negative = field('trackFade', '-40', { dataset: { soundId: sound.id } });
    controller._onChange({ target: negative, stopPropagation: vi.fn() });
    expect(negative.value).toBe('0');

    const fractional = field('trackFade', '99.7', { dataset: { soundId: sound.id } });
    controller._onChange({ target: fractional, stopPropagation: vi.fn() });
    expect(fractional.value).toBe('100');
  });

  it('stops the event so the graph editor\'s own delegated change dispatcher never sees it', () => {
    const controller = controllerFor(makePlaylist([soundAt(1)]));
    controller.attach(fakeMixerDom([]));
    const event = { target: field('crossfade', '100'), stopPropagation: vi.fn() };

    controller._onChange(event);

    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('ignores a range input - those are handled live on `input`', () => {
    const controller = controllerFor(makePlaylist([soundAt(1)]));
    controller.attach(fakeMixerDom([]));
    const event = { target: slider('gain', 0.5), stopPropagation: vi.fn() };

    controller._onChange(event);

    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});

describe('_onClick', () => {
  /** @returns {object} An event targeting a mixer button. */
  const buttonEvent = (action, soundId) =>
    clickOn({ '[data-action]': { dataset: { action, soundId } } });

  it('routes each of its own buttons to the matching method and stops the event there', async () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([sound.id]));

    const event = buttonEvent('toggleMute', sound.id);
    controller._onClick(event);
    await Promise.resolve();

    // Stopped so a host whose action map knows nothing about `toggleMute` never sees it - which
    // is what lets the same markup work inside the graph editor.
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'mix', expect.objectContaining({ muted: [sound.id] }));
  });

  it('routes solo, which stays local to this client', () => {
    const sound = soundAt(0.5);
    const controller = controllerFor(makePlaylist([sound]));
    controller.attach(fakeMixerDom([sound.id]));

    controller._onClick(buttonEvent('toggleSolo', sound.id));

    expect(getSoloIds('pl1')).toEqual(new Set([sound.id]));
  });

  it('routes reset', async () => {
    const playlist = makePlaylist([soundAt(0.5)]);
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));

    controller._onClick(buttonEvent('resetMix'));
    await Promise.resolve();

    expect(playlist.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'mix');
  });

  it('leaves a button outside its own subtree to whoever owns it', () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const controller = controllerFor(playlist);
    const root = fakeMixerDom([sound.id]);
    root.contains = () => false; // the click came from a sibling application
    controller.attach(root);

    const event = buttonEvent('toggleMute', sound.id);
    controller._onClick(event);

    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(playlist.setFlag).not.toHaveBeenCalled();
  });

  it('falls through to row selection for a click that is not one of its buttons', () => {
    const sound = soundAt(0.5);
    const controller = controllerFor(makePlaylist([sound]));
    const root = fakeMixerDom([sound.id]);
    controller.attach(root);

    controller._onClick(clickOn({ '.game-orchestra-mixer-row': root.rows[sound.id] }));

    expect(controller.selection).toEqual(new Set([sound.id]));
  });
});

describe('_onRowClick (selection)', () => {
  /** Three rows, so shift-extension has a middle to include. */
  function threeRows() {
    const sounds = [soundAt(0.9), soundAt(0.6), soundAt(0.3)];
    const controller = controllerFor(makePlaylist(sounds));
    const root = fakeMixerDom(sounds.map((s) => s.id));
    controller.attach(root);
    return { controller, root, ids: sounds.map((s) => s.id) };
  }

  const rowClick = (row, extra = {}) => clickOn({ '.game-orchestra-mixer-row': row }, extra);

  it('a plain click selects exactly that row', () => {
    const { controller, root, ids } = threeRows();

    controller._onRowClick(rowClick(root.rows[ids[1]]));

    expect(controller.selection).toEqual(new Set([ids[1]]));
  });

  it('clicking the only selected row again deselects it', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));

    controller._onRowClick(rowClick(root.rows[ids[0]]));

    expect(controller.selection.size).toBe(0);
  });

  it('ctrl/meta toggles one row without disturbing the rest', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));

    controller._onRowClick(rowClick(root.rows[ids[2]], { ctrlKey: true }));
    expect(controller.selection).toEqual(new Set([ids[0], ids[2]]));

    controller._onRowClick(rowClick(root.rows[ids[2]], { metaKey: true }));
    expect(controller.selection).toEqual(new Set([ids[0]]));
  });

  it('shift extends from the anchor, inclusive of the rows between', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));

    controller._onRowClick(rowClick(root.rows[ids[2]], { shiftKey: true }));

    expect(controller.selection).toEqual(new Set(ids));
  });

  it('shift extends backwards too', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[2]]));

    controller._onRowClick(rowClick(root.rows[ids[0]], { shiftKey: true }));

    expect(controller.selection).toEqual(new Set(ids));
  });

  it('a click on a control inside a row is the control\'s business, not a selection change', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));

    controller._onRowClick(
      clickOn({ 'input, button, [data-action]': { tagName: 'INPUT' }, '.game-orchestra-mixer-row': root.rows[ids[2]] })
    );

    expect(controller.selection).toEqual(new Set([ids[0]]));
  });

  it('clicking off the rows clears the selection', () => {
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));

    controller._onRowClick(clickOn({}));

    expect(controller.selection.size).toBe(0);
  });

  it('does not rebuild the view when clicking empty space with nothing selected', () => {
    const { controller } = threeRows();

    controller._onRowClick(clickOn({}));

    expect(controller._onRefresh).not.toHaveBeenCalled();
  });

  it('treats the column header as chrome, not a selectable row', () => {
    // It is a `.game-orchestra-mixer-row` for layout reasons only.
    const { controller, root, ids } = threeRows();
    controller._onRowClick(rowClick(root.rows[ids[0]]));
    const header = { dataset: {}, classList: { contains: (c) => c === 'game-orchestra-mixer-column-header' } };

    controller._onRowClick(rowClick(header));

    expect(controller.selection.size).toBe(0);
  });
});

describe('focusNode', () => {
  /** Named exactly as the editor class is - focusNode matches on `constructor.name`. */
  class CustomPlaylistEditor {
    constructor(playlist, graph) {
      this.playlist = playlist;
      this.graph = graph;
      this._focusNode = vi.fn();
      this.bringToFront = vi.fn();
    }
  }

  it('jumps to the Track node that plays the sound in an open editor for that playlist', () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const editor = new CustomPlaylistEditor(playlist, { nodes: [{ id: 'n7', type: 'track', soundId: sound.id }] });
    foundry.applications.instances.set('editor', editor);

    controllerFor(playlist).focusNode(sound.id);

    expect(editor._focusNode).toHaveBeenCalledWith('n7');
    expect(editor.bringToFront).toHaveBeenCalled();
  });

  it('stays silent when no editor is open - the badge is primarily a count', () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);

    expect(() => controllerFor(playlist).focusNode(sound.id)).not.toThrow();
  });

  it('ignores an editor open on a different playlist', () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const editor = new CustomPlaylistEditor({ id: 'other' }, { nodes: [{ id: 'n7', type: 'track', soundId: sound.id }] });
    foundry.applications.instances.set('editor', editor);

    controllerFor(playlist).focusNode(sound.id);

    expect(editor._focusNode).not.toHaveBeenCalled();
  });

  it('does nothing when the graph has no Track node for that sound', () => {
    const sound = soundAt(0.5);
    const playlist = makePlaylist([sound]);
    const editor = new CustomPlaylistEditor(playlist, { nodes: [{ id: 'n1', type: 'delay' }] });
    foundry.applications.instances.set('editor', editor);

    controllerFor(playlist).focusNode(sound.id);

    expect(editor._focusNode).not.toHaveBeenCalled();
    expect(editor.bringToFront).not.toHaveBeenCalled();
  });
});

describe('write failures', () => {
  it('reports a failed debounced write rather than losing it silently', async () => {
    vi.useFakeTimers();
    const playlist = makePlaylist([soundAt(1)]);
    playlist.setFlag.mockRejectedValueOnce(new Error('no permission'));
    const controller = controllerFor(playlist);
    controller.attach(fakeMixerDom([]));

    controller._onInput({ target: slider('ceiling', 0.5) });
    await vi.advanceTimersByTimeAsync(200);

    expect(ui.notifications.error).toHaveBeenCalledWith('GameOrchestra.Mixer.SaveFailed');
    vi.useRealTimers();
  });

  it('reports a failed bake and leaves the mix flag untouched', async () => {
    const playlist = makePlaylist([soundAt(0.5)]);
    playlist.updateEmbeddedDocuments.mockRejectedValueOnce(new Error('nope'));
    const controller = controllerFor(playlist);

    await controller.bake();

    expect(ui.notifications.error).toHaveBeenCalledWith('GameOrchestra.Mixer.SaveFailed');
    expect(playlist.setFlag).not.toHaveBeenCalled();
  });
});
