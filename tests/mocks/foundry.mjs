import { vi } from 'vitest';

export class MockDocument {
  constructor(data = {}) {
    Object.assign(this, data);
  }
}

function getProperty(obj, path) {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

function setProperty(obj, path, value) {
  if (!obj || typeof obj !== 'object' || !path) return false;
  const parts = path.split('.');
  let curr = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (curr[part] == null || typeof curr[part] !== 'object') {
      curr[part] = {};
    }
    curr = curr[part];
  }
  curr[parts[parts.length - 1]] = value;
  return true;
}

function createMockSettings() {
  const store = new Map();
  return {
    get: vi.fn((moduleId, key) => store.get(`${moduleId}.${key}`)),
    set: vi.fn((moduleId, key, val) => {
      store.set(`${moduleId}.${key}`, val);
      return Promise.resolve(val);
    }),
    register: vi.fn(),
    registerMenu: vi.fn(),
    _store: store
  };
}

class MockApplicationV2 {
  static DEFAULT_OPTIONS = {};
  static PARTS = {};
  constructor(options = {}) {
    this.options = options;
  }
  _onRender(context, options) {}
  _onClose(options) {}
  _onPosition(position) {}
  /**
   * ApplicationV2#_renderFrame builds and returns the window chrome. `MoodWidget` overrides it to
   * inject its own header buttons into what the base class returns, so `super._renderFrame()` has
   * to hand back something queryable - a subclass that only ever received `undefined` here would
   * take the `if (closeBtn)` bail-out on every path and the injection would never be exercised.
   * The test parks the frame it wants to inspect on `_mockFrame`.
   */
  async _renderFrame(options) {
    return this._mockFrame ?? null;
  }
  render() {}
  close() {}
  setPosition(position) {}
}

function MockHandlebarsApplicationMixin(Base) {
  return class extends Base {};
}

/**
 * Mirrors Foundry's real `DragDrop#bind(html)` contract closely enough to
 * catch the class of bug a pure call-counter can't: it is NOT delegated.
 * `bind()` queries `html.querySelectorAll(dropSelector)` once, at call time,
 * and attaches `dragover`/`drop` listeners directly to whatever elements
 * match right then - elements that appear later (e.g. after a re-render
 * replaces the part's DOM) get nothing unless `bind()` runs again against the
 * new tree. A caller that binds once per window lifetime instead of once per
 * render silently loses drag-and-drop the moment those elements are recreated.
 *
 * Also binds `dragstart` on elements matching `dragSelector` (the graph editor's
 * Tracks pane rows are the source of an internal drag, not just a drop target -
 * see custom-playlist-editor.mjs's dragDrop config), mirroring Foundry's own
 * dragSelector/dropSelector split rather than treating every bound element the
 * same way.
 *
 * Also counts every bind() call across every MockDragDrop instance, so a test
 * can assert how many times setup ran (once per render, not once per window).
 */
class MockDragDrop {
  static bindCallCount = 0;
  static resetBindCallCount() {
    MockDragDrop.bindCallCount = 0;
  }
  constructor(options = {}) {
    this.options = options;
  }
  bind(html) {
    MockDragDrop.bindCallCount++;
    const dragTargets = this.options.dragSelector ? Array.from(html?.querySelectorAll?.(this.options.dragSelector) || []) : [];
    for (const target of dragTargets) {
      target.addEventListener?.('dragstart', this.options.callbacks?.dragstart);
    }
    const dropTargets = this.options.dropSelector ? Array.from(html?.querySelectorAll?.(this.options.dropSelector) || []) : [html];
    for (const target of dropTargets) {
      target.addEventListener?.('dragover', this.options.callbacks?.dragover);
      target.addEventListener?.('drop', this.options.callbacks?.drop);
    }
    return this;
  }
}

/**
 * A working stand-in for Foundry's Hooks registry - not just spies. The module
 * dispatches its own 'gameOrchestraGraphActivity' hook from the playback engine and
 * listens for it in the graph editor, so tests need real on/off/callAll
 * behavior (including the numeric id `on` returns, which `off` takes) rather
 * than no-op stubs.
 */
function createMockHooks() {
  const listeners = new Map(); // event -> [{ id, fn, once }]
  let nextId = 1;

  const add = (event, fn, once) => {
    const id = nextId++;
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push({ id, fn, once });
    return id;
  };

  return {
    _listeners: listeners,
    on: vi.fn((event, fn) => add(event, fn, false)),
    once: vi.fn((event, fn) => add(event, fn, true)),
    off: vi.fn((event, idOrFn) => {
      const entries = listeners.get(event) || [];
      const index = entries.findIndex((e) => e.id === idOrFn || e.fn === idOrFn);
      if (index >= 0) entries.splice(index, 1);
    }),
    callAll: vi.fn((event, ...args) => {
      // Copied before iterating: a listener may unregister itself (or another)
      // during dispatch, exactly as it can in Foundry.
      for (const entry of [...(listeners.get(event) || [])]) {
        if (entry.once) listeners.get(event)?.splice(listeners.get(event).indexOf(entry), 1);
        entry.fn(...args);
      }
      return true;
    })
  };
}

export function setupFoundryMocks(overrides = {}) {
  const settings = createMockSettings();
  const gmUser = { id: 'gm1', isGM: true, active: true };

  globalThis.game = {
    settings,
    user: gmUser,
    users: Object.assign([gmUser], {
      filter: function (fn) {
        return Array.prototype.filter.call(this, fn);
      }
    }),
    scenes: Object.assign([], { active: null }),
    combats: { active: null },
    playlists: Object.assign([], { get: vi.fn(), playing: [] }),
    audio: { locked: false },
    gameOrchestra: { musicController: null, moodWidget: null },
    i18n: {
      localize: vi.fn((key) => key),
      // Stands in for Foundry's real i18n.format(), which interpolates data into
      // the actual translated string for `key` - this mock has no real
      // translation table to interpolate INTO, so it appends the data values
      // after the (untranslated) key instead, keeping both visible to assertions.
      format: vi.fn((key, data = {}) => `${key} ${Object.values(data).map(String).join(' ')}`.trim())
    },
    keybindings: { register: vi.fn() },
    ...overrides
  };

  globalThis.ui = {
    notifications: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn()
    }
  };

  globalThis.foundry = {
    abstract: { Document: MockDocument },
    utils: {
      getProperty: vi.fn(getProperty),
      setProperty: vi.fn(setProperty),
      mergeObject: vi.fn((original, other) => ({ ...original, ...other })),
      expandObject: vi.fn((obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        const res = {};
        for (const [k, v] of Object.entries(obj)) setProperty(res, k, v);
        return res;
      }),
      deepClone: vi.fn((obj) => (obj ? JSON.parse(JSON.stringify(obj)) : obj))
    },
    applications: {
      api: {
        ApplicationV2: MockApplicationV2,
        HandlebarsApplicationMixin: MockHandlebarsApplicationMixin,
        DialogV2: { confirm: vi.fn(() => Promise.resolve(true)) }
      },
      ux: {
        DragDrop: MockDragDrop
      },
      // The mixer looks its own open window up here (one window per playlist), and the graph
      // editor is found through it too. Left empty by default; a test registers what it needs.
      instances: new Map()
    },
    // Real AudioHelper's volume curve, which the mixer routes through rather than
    // reimplementing so that its percentages agree with the sidebar's. Mocked at the same
    // default order (1.5) for the same reason.
    audio: {
      AudioHelper: {
        inputToVolume: (value, order = 1.5) => Math.pow(Number(value) || 0, order),
        volumeToInput: (volume, order = 1.5) => Math.pow(Number(volume) || 0, 1 / order),
        volumeToPercentage: (volume) => `${Math.round((Number(volume) || 0) * 100)}%`
      }
    }
  };

  globalThis.CONST = {
    PLAYLIST_MODES: { UNSEQUENCED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 }
  };

  globalThis.loadTemplates = vi.fn().mockResolvedValue(undefined);

  globalThis.Hooks = createMockHooks();

  if (!globalThis.document) {
    globalThis.document = {};
  }
  globalThis.document.addEventListener = vi.fn();
  globalThis.document.removeEventListener = vi.fn();
  if (!globalThis.document.body) globalThis.document.body = { appendChild: vi.fn(), removeChild: vi.fn() };
  // Enough of an element for the code that builds small DOM fragments by hand
  // (the rect-select rectangle, a node's validation badge).
  globalThis.document.createElement = vi.fn((tag) => {
    const classes = new Set();
    const element = {
      tagName: String(tag).toUpperCase(),
      className: '',
      innerHTML: '',
      title: '',
      // Real elements always have one; the validation badge stores the node id
      // and severity here for the issue balloon's click handler to read back.
      dataset: {},
      style: {},
      children: [],
      parentElement: null,
      // Recorded rather than ignored so an accessible name set this way is
      // actually assertable - the canvas exit-adder button sets aria-label.
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
      },
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c)
      },
      // Recorded by type so a test can fire what was wired up - the token
      // sheet's injected config button carries its click handler this way.
      listeners: {},
      addEventListener(type, handler) {
        this.listeners[type] = handler;
      },
      removeEventListener(type) {
        delete this.listeners[type];
      },
      appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
      },
      remove() {
        const siblings = this.parentElement?.children;
        const index = siblings?.indexOf(this) ?? -1;
        if (index >= 0) siblings.splice(index, 1);
        this.parentElement = null;
      }
    };
    return element;
  });

  return { settings, MockDocument };
}

// Automatically setup defaults upon import so top-level destructured globals work
setupFoundryMocks();

export function setMockSetting(moduleId, key, value) {
  game.settings._store.set(`${moduleId}.${key}`, value);
}

export function createMockSound(id, name, overrides = {}) {
  // Modeled on foundry.audio.Sound, which extends EventEmitterMixin and (as of
  // v14) only supports the standard addEventListener/removeEventListener form -
  // the legacy on()/off()/emit() aliases were removed in v14. Backing this with
  // a real EventTarget lets tests dispatch 'end'/'stop' events realistically.
  const innerSound = Object.assign(new EventTarget(), {
    currentTime: 0,
    duration: 0,
    loaded: true,
    playing: false,
    repeat: false,
    fade: vi.fn(() => Promise.resolve()),
    stop: vi.fn(),
    volume: 1.0,
    // Foundry assigns this immediately after playback actually begins and clears
    // it back to undefined on stop, which makes it the one field that tells a
    // sound still counting out a play({delay}) apart from one truly playing -
    // both report playing === true. The engine's armed-start verification reads
    // exactly this, so the property must EXIST here (undefined, not absent).
    startTime: undefined,
    // A running AudioContext by default: _armHandoff refuses to arm a delayed
    // start against a suspended one, since the delay is timed by that context.
    context: { state: 'running' }
  });
  // Models foundry.audio.Sound#play({delay}). The real implementation creates
  // its nodes immediately, marks itself STARTING (Sound#playing is true for
  // STARTING, which is what makes PlaylistSound#sync() a no-op mid-arm), waits
  // out the delay on the audio clock, and only then starts the source; stop()
  // cancels a pending delayed start. CustomPlaybackEngine's hand-off arming
  // (_armHandoff) depends on all four of those behaviours, so a mock that only
  // flipped a boolean would let a broken arming path pass.
  let pendingStart = null;
  innerSound.play = vi.fn((options = {}) => {
    if (innerSound.playing) return Promise.resolve(innerSound); // already LOADED->STARTING/PLAYING
    innerSound.starting = true;
    innerSound.playing = true; // STARTING counts as playing, exactly as in Foundry
    innerSound.startTime = undefined; // not assigned until the delay has elapsed
    pendingStart = setTimeout(() => {
      pendingStart = null;
      innerSound.starting = false;
      innerSound.started = true;
      innerSound.startTime = 0;
    }, (options.delay ?? 0) * 1000);
    return Promise.resolve(innerSound);
  });
  const baseStop = innerSound.stop;
  innerSound.stop = vi.fn((...args) => {
    if (pendingStart) {
      clearTimeout(pendingStart);
      pendingStart = null;
    }
    innerSound.starting = false;
    innerSound.started = false;
    innerSound.playing = false;
    innerSound.startTime = undefined;
    return baseStop(...args);
  });
  const sound = {
    id,
    name,
    playing: false,
    volume: 1.0,
    pausedTime: null,
    repeat: false,
    sound: innerSound,
    parent: { playSound: vi.fn(() => Promise.resolve()), stopSound: vi.fn(() => Promise.resolve()) },
    play: vi.fn(() => Promise.resolve()),
    stop: vi.fn()
  };
  // Models Foundry document.update(): merges the patch into the document
  // in place so assertions can inspect resulting field values, not just call args.
  sound.update = vi.fn((data = {}) => {
    Object.assign(sound, data);
    return Promise.resolve(sound);
  });
  // Document#updateSource - a LOCAL, non-persisted field write. Real code uses it for immediate
  // feedback while a slider is moving (PlaylistDirectory#_onSoundVolume does exactly this), with
  // the database write debounced separately, so the two must stay distinguishable here.
  sound.updateSource = vi.fn((data = {}) => {
    Object.assign(sound, data);
    return sound;
  });
  // PlaylistSound#debounceVolume - core's own debounced {volume} update.
  sound.debounceVolume = vi.fn((volume) => sound.update({ volume }));
  Object.assign(sound, overrides);
  return sound;
}

/**
 * Models how Foundry actually stores a flag value: `ObjectField#_updateDiff` runs
 * `mergeObject(source, diff)`, so a write RECURSIVELY MERGES into what is already there.
 *
 * Two consequences that matter, both of which this reproduces:
 *
 * - Omitting a key does **not** remove it. Removal needs the `-=key` deletion operator.
 * - **Arrays are replaced wholesale**, not merged element-wise - which is why `PlaylistMix#muted`
 *   is an array of ids rather than an `{id: true}` map.
 *
 * Confirmed against `common/data/fields.mjs` in the installed client, not assumed.
 * @param {*} current - The currently stored value.
 * @param {*} incoming - The value being written.
 * @returns {*} The merged result.
 */
function mergeLikeFoundry(current, incoming) {
  if (!isPlainObject(current) || !isPlainObject(incoming)) return incoming;
  const result = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (key.startsWith('-=')) {
      delete result[key.slice(2)];
      continue;
    }
    result[key] = mergeLikeFoundry(result[key], value);
  }
  return result;
}

/** @param {*} value @returns {boolean} True for a plain object (not an array, not null). */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function createMockPlaylist(id, name, sounds = [], mode = 0) {
  const soundsMap = new Map(sounds.map((s) => [s.id, s]));
  soundsMap.find = (fn) => sounds.find(fn);
  soundsMap.contents = sounds;
  // Playlist#sounds is an EmbeddedCollection, which iterates its DOCUMENTS - a plain Map
  // iterates [key, value] pairs, so `for (const sound of playlist.sounds)` would hand every
  // caller a two-element array whose `.volume` and `.name` are undefined, and the failure is
  // silent rather than thrown.
  soundsMap[Symbol.iterator] = function* () {
    yield* sounds;
  };
  const flags = {};
  const playlist = {
    id,
    name,
    mode,
    uuid: `Playlist.${id}`,
    sounds: soundsMap,
    playbackOrder: sounds.map((s) => s.id),
    sheet: { render: vi.fn() }
  };
  // Real PlaylistSound#parent is the owning Playlist document itself, and its uuid is
  // Foundry's standard embedded-document form. Mirrored here (id/uuid only - the
  // parent stub's own playSound/stopSound, set by createMockSound, are left alone) so
  // the graph editor's drag-in-from-sidebar path (which reads document.parent.id and
  // a dragged sound's own .uuid) has real values to resolve against, not just stubs.
  // Models the part of Playlist#_onSoundEnd the engine now relies on: when a
  // sound ends naturally, Foundry itself writes {playing: false, pausedTime:
  // null} for it, in every playlist mode. CustomPlaybackEngine feature-detects
  // _onSoundEnd (plus isOwner) to decide whether it still needs to issue its own
  // stopSound() - without these here, every test would silently take the
  // fallback path and the change under test would never actually run.
  for (const sound of sounds) {
    sound.parent = Object.assign(sound.parent || {}, {
      id,
      name,
      mode,
      isOwner: true,
      _onSoundEnd: vi.fn((ended) => {
        ended.playing = false;
        ended.pausedTime = null;
        return Promise.resolve(playlist);
      })
    });
    sound.uuid = `Playlist.${id}.PlaylistSound.${sound.id}`;
  }
  playlist.getFlag = vi.fn((mod, key) => flags[`${mod}.${key}`]);
  // Foundry's setFlag is document.update({flags: {...}}), and a flag's value is an ObjectField
  // whose _updateDiff does `mergeObject(source, diff)` - a RECURSIVE merge, not a replacement.
  // A mock that simply assigned would make a whole class of bug untestable: writing an object
  // with a key *omitted* does not remove that key, it merges the old value back in. That is
  // exactly how mute-off silently failed to persist. Arrays are replaced wholesale, as in
  // mergeObject; `-=key` deletes.
  playlist.setFlag = vi.fn((mod, key, value) => {
    const flagKey = `${mod}.${key}`;
    flags[flagKey] = mergeLikeFoundry(flags[flagKey], value);
    return Promise.resolve(playlist);
  });
  playlist.unsetFlag = vi.fn((mod, key) => {
    delete flags[`${mod}.${key}`];
    return Promise.resolve(playlist);
  });
  playlist.update = vi.fn((data = {}) => {
    Object.assign(playlist, data);
    return Promise.resolve(playlist);
  });
  playlist.updateEmbeddedDocuments = vi.fn((embeddedName, updates = []) => {
    const updated = [];
    for (const change of updates) {
      const sound = soundsMap.get(change._id);
      if (sound) {
        Object.assign(sound, change);
        updated.push(sound);
      }
    }
    return Promise.resolve(updated);
  });
  return playlist;
}
