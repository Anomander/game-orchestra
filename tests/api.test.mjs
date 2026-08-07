import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { createApi, GameOrchestraApiError, API_VERSION } from '../scripts/api.mjs';
import { CONST } from '../scripts/config.mjs';
import { createEmptyGraph } from '../scripts/custom-playback-schema.mjs';
import { beginScriptExecution, endScriptExecution, resetScriptExecution } from '../scripts/script-runtime.mjs';

/**
 * The API is the module's only *contract* - the one surface a third party depends on and the one
 * that therefore cannot be refactored freely. Two kinds of test guard it, and they guard different
 * things:
 *
 * 1. **Shape.** Every documented name exists and is the documented kind. This is what makes a
 *    signature change show up as a failing test here rather than as somebody's broken macro three
 *    releases later. It is the contract's enforcement, the way tests/lang.test.mjs is HR-E's.
 * 2. **Refusal.** Every method that cannot do what its name says on this client THROWS, with the
 *    documented code. The whole reason for that design is that the alternative - returning
 *    quietly, the way playCurrentTrack() does on a non-head client - is a silent failure a macro
 *    author never notices. A test per throwing method is what keeps that promise honest.
 */

/** Walk a nested object and yield `path -> value` for every leaf and namespace. */
function flatten(object, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out[path] = value;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Set)) {
      Object.assign(out, flatten(value, path));
    }
  }
  return out;
}

describe('api.mjs (the public API contract)', () => {
  let api;
  let playlist;

  beforeEach(() => {
    setupFoundryMocks();
    api = createApi();
    playlist = createMockPlaylist('pl1', 'Tavern', [createMockSound('s1', 'Lute')], -1);
    game.playlists = Object.assign([playlist], {
      get: vi.fn((id) => (id === 'pl1' ? playlist : null)),
      playing: []
    });
    game.gameOrchestra = { musicController: null, moodWidget: null };
  });

  describe('shape', () => {
    it('exposes exactly the documented top-level names', () => {
      expect(Object.keys(api).sort()).toEqual(
        ['Error', 'bind', 'canControl', 'graph', 'hooks', 'isHeadGM', 'mix', 'playback', 'transport', 'version'].sort()
      );
    });

    it('reports a 0.x version - the contract is deliberately not frozen yet', () => {
      expect(api.version).toBe(API_VERSION);
      expect(api.version).toMatch(/^0\./);
    });

    it('is frozen, namespaces included, so a caller cannot monkey-patch the contract', () => {
      expect(Object.isFrozen(api)).toBe(true);
      for (const ns of ['transport', 'bind', 'graph', 'mix', 'playback']) {
        expect(Object.isFrozen(api[ns])).toBe(true);
      }
    });

    it('exposes every documented method, and each is a function', () => {
      const expected = {
        transport: ['getMood', 'getPhase', 'setMood', 'setPhase', 'listMoods', 'listPhases', 'getSuppression', 'setSuppression', 'refresh', 'describeCurrent'],
        bind: ['set', 'setTrack', 'setLayer', 'clear', 'read', 'resolve'],
        graph: ['get', 'set', 'remove', 'validate', 'localizeIssue', 'builder'],
        mix: ['get', 'patch', 'setVolume', 'setMuted', 'setSolo', 'getSolo', 'clearSolo', 'effectiveVolume', 'getDuck', 'setDuck'],
        playback: ['isPlaying', 'currentContext', 'currentPlaylists', 'activity', 'play', 'stop']
      };
      for (const [namespace, methods] of Object.entries(expected)) {
        for (const method of methods) {
          expect(typeof api[namespace][method], `api.${namespace}.${method}`).toBe('function');
        }
      }
      expect(Array.isArray(api.graph.presets)).toBe(true);
      expect(typeof api.graph.schema).toBe('object');
    });

    it('publishes the hook names, and every one is a real gameOrchestra* string', () => {
      expect(api.hooks).toBe(CONST.hooks);
      expect(Object.isFrozen(api.hooks)).toBe(true);
      expect(api.hooks.GRAPH_ACTIVITY).toBe('gameOrchestraGraphActivity');
      for (const name of Object.values(api.hooks)) {
        expect(name).toMatch(/^gameOrchestra[A-Z]/);
      }
    });

    it('has no accidental undefined leaves anywhere in the tree', () => {
      for (const [path, value] of Object.entries(flatten(api))) {
        expect(value, path).toBeDefined();
      }
    });
  });

  describe('refusal - a call that cannot do what its name says throws', () => {
    /**
     * Every write, with the argument shape that gets it past validation and to the permission
     * check. Driven as a table so a method added without a refusal test is visibly missing rather
     * than quietly untested.
     */
    const gmOnly = [
      ['transport.setMood', (a) => a.transport.setMood('calm')],
      ['transport.setPhase', (a) => a.transport.setPhase('p1')],
      ['transport.setSuppression', (a) => a.transport.setSuppression('area', true)],
      ['bind.set', (a) => a.bind.set('default', { section: 'area', playlistId: 'pl1' })],
      ['bind.setTrack', (a) => a.bind.setTrack('default', { section: 'area', trackId: 's1' })],
      ['bind.setLayer', (a) => a.bind.setLayer('default', { section: 'area', overlayId: 'calm', layer: true })],
      ['bind.clear', (a) => a.bind.clear('default', { section: 'area' })],
      ['graph.set', (a) => a.graph.set('pl1', createEmptyGraph())],
      ['graph.remove', (a) => a.graph.remove('pl1')],
      ['mix.patch', (a) => a.mix.patch('pl1', { gain: 0.5 })],
      ['mix.setVolume', (a) => a.mix.setVolume('pl1', 's1', 0.5)],
      ['mix.setMuted', (a) => a.mix.setMuted('pl1', 's1', true)],
      ['mix.setDuck', (a) => a.mix.setDuck(0.5)]
    ];

    it.each(gmOnly)('%s rejects a non-GM with NOT_PERMITTED', async (_name, call) => {
      game.user = { id: 'player1', isGM: false, active: true };
      await expect(call(api)).rejects.toMatchObject({ name: 'GameOrchestraApiError', code: 'NOT_PERMITTED' });
    });

    const headGmOnly = [
      ['playback.play', (a) => a.playback.play()],
      ['playback.stop', (a) => a.playback.stop()],
      ['transport.refresh', (a) => a.transport.refresh()]
    ];

    it.each(headGmOnly)('%s rejects a non-head-GM with NOT_HEAD_GM', async (_name, call) => {
      // A *second* GM: isGM is true, so this is not a permission problem - it is the case that
      // used to return quietly and report success, which is exactly what this API exists to stop.
      game.user = { id: 'gm2', isGM: true, active: true };
      await expect(call(api)).rejects.toMatchObject({ name: 'GameOrchestraApiError', code: 'NOT_HEAD_GM' });
    });

    it('checks head-GM BEFORE delegating, so the controller is never even consulted', async () => {
      const controller = { playCurrentTrack: vi.fn(), transitionToContext: vi.fn() };
      game.gameOrchestra.musicController = controller;
      game.user = { id: 'gm2', isGM: true, active: true };
      await expect(api.playback.play()).rejects.toThrow(GameOrchestraApiError);
      // The point of checking at the top: calling through and inspecting the result cannot
      // distinguish "returned early because not head GM" from "ran and had nothing to play".
      expect(controller.playCurrentTrack).not.toHaveBeenCalled();
    });

    it('reports isHeadGM and canControl so a caller can branch before calling', () => {
      expect(api.isHeadGM()).toBe(true);
      expect(api.canControl()).toBe(true);
      game.user = { id: 'player1', isGM: false, active: true };
      expect(api.canControl()).toBe(false);
      expect(api.isHeadGM()).toBe(false);
    });

    it('rejects an unknown section with INVALID_ARGUMENT rather than writing a bogus path', async () => {
      await expect(api.bind.set('default', { section: 'ambience', playlistId: 'pl1' }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(api.transport.setSuppression('ambience', true))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('rejects an unknown playlist id with NOT_FOUND', async () => {
      expect(() => api.graph.get('nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
      await expect(api.graph.set('nope', createEmptyGraph())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a non-Document bind target with INVALID_ARGUMENT', () => {
      expect(() => api.bind.read({ nope: true }, { section: 'area' }))
        .toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    });

    it('reads never throw on permission - a player may ask what is playing', () => {
      game.user = { id: 'player1', isGM: false, active: true };
      expect(() => api.playback.isPlaying()).not.toThrow();
      expect(() => api.playback.currentContext()).not.toThrow();
      expect(() => api.transport.getMood()).not.toThrow();
      expect(() => api.bind.read('default', { section: 'area' })).not.toThrow();
      expect(() => api.graph.get('pl1')).not.toThrow();
    });
  });

  describe('transport', () => {
    it('round-trips the active mood and phase through the world settings', async () => {
      await api.transport.setMood('tense');
      expect(api.transport.getMood()).toBe('tense');
      await api.transport.setPhase('enrage');
      expect(api.transport.getPhase()).toBe('enrage');
    });

    it('clears an axis when given null', async () => {
      await api.transport.setMood('tense');
      await api.transport.setMood(null);
      expect(api.transport.getMood()).toBe('');
    });

    it('localizes overlay labels at this boundary - the definitions store i18n keys', () => {
      setMockSetting(CONST.moduleId, CONST.settings.configuredMoods, [{ id: 'calm', label: 'GameOrchestra.Mood.Calm', icon: 'i', color: '#fff' }]);
      setMockSetting(CONST.moduleId, CONST.settings.activeMood, 'calm');
      const [mood] = api.transport.listMoods();
      expect(game.i18n.localize).toHaveBeenCalledWith('GameOrchestra.Mood.Calm');
      expect(mood).toMatchObject({ id: 'calm', active: true });
    });

    it('reads suppression for both sections', async () => {
      setMockSetting(CONST.moduleId, CONST.settings.suppressCombat, true);
      expect(api.transport.getSuppression()).toEqual({ area: false, combat: true });
    });
  });

  describe('bind', () => {
    it('writes and reads back a world-default binding', async () => {
      await api.bind.set('default', { section: 'area', playlistId: 'pl1' });
      expect(api.bind.read('default', { section: 'area' })).toMatchObject({ playlistId: 'pl1' });
    });

    it('writes an overlay-scoped binding under its own overlay id', async () => {
      await api.bind.set('default', { section: 'combat', overlayId: 'enrage', playlistId: 'pl1' });
      expect(api.bind.read('default', { section: 'combat', overlayId: 'enrage' }).playlistId).toBe('pl1');
      expect(api.bind.read('default', { section: 'combat' }).playlistId).toBeNull();
    });

    it('refuses to store a playlist id that does not exist', async () => {
      await expect(api.bind.set('default', { section: 'area', playlistId: 'ghost' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(api.bind.read('default', { section: 'area' }).playlistId).toBeNull();
    });

    it('clearing a binding also clears its priority, never leaving a stale one behind', async () => {
      await api.bind.set('default', { section: 'area', playlistId: 'pl1' });
      await api.bind.clear('default', { section: 'area' });
      const read = api.bind.read('default', { section: 'area' });
      expect(read.playlistId).toBeNull();
      expect(read.priority).toBeNull();
    });

    it('setLayer needs an overlay - layering is an overlay-level setting', async () => {
      await expect(api.bind.setLayer('default', { section: 'area', layer: true }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('routes a PrototypeToken through its parent Actor using DOT PATHS, never bracket syntax', async () => {
      // HR-J: Foundry expands update keys with expandObject -> setProperty, which splits on "."
      // and has no bracket syntax. The bracketed form produced a literal key the Actor schema
      // silently dropped - the update resolved successfully and wrote NOTHING, confirmed live.
      const actor = { update: vi.fn(() => Promise.resolve()) };
      const proto = { flags: {}, parent: actor, constructor: { name: 'PrototypeToken' } };
      globalThis.foundry.data = { PrototypeToken: function PrototypeToken() {} };
      Object.setPrototypeOf(proto, globalThis.foundry.data.PrototypeToken.prototype);

      await api.bind.set(proto, { section: 'combat', playlistId: 'pl1' });

      expect(actor.update).toHaveBeenCalledTimes(1);
      const written = actor.update.mock.calls[0][0];
      for (const key of Object.keys(written)) {
        expect(key).toMatch(/^prototypeToken\.flags\.game-orchestra\./);
        expect(key).not.toContain('[');
      }
    });

    it('refuses a PrototypeToken with no parent Actor rather than writing nowhere', async () => {
      globalThis.foundry.data = { PrototypeToken: function PrototypeToken() {} };
      const orphan = Object.setPrototypeOf({ flags: {}, parent: null }, globalThis.foundry.data.PrototypeToken.prototype);
      await expect(api.bind.set(orphan, { section: 'combat', playlistId: 'pl1' }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });

  describe('graph', () => {
    it('returns a deep clone, so mutating the result cannot silently write nothing', () => {
      const stored = createEmptyGraph();
      playlist.setFlag(CONST.moduleId, 'customPlayback', stored);
      const first = api.graph.get('pl1');
      first.nodes.push({ id: 'x', type: 'end', x: 0, y: 0 });
      expect(api.graph.get('pl1').nodes).toHaveLength(1);
    });

    it('returns null for a playlist with no graph', () => {
      expect(api.graph.get('pl1')).toBeNull();
    });

    it('saves a valid graph and forces UNSEQUENCED mode (H1)', async () => {
      const native = createMockPlaylist('pl2', 'Native', [createMockSound('s2', 'Drum')], 0);
      game.playlists.get = vi.fn((id) => (id === 'pl2' ? native : id === 'pl1' ? playlist : null));
      const graph = { version: 1, nodes: [{ id: '1', type: 'start', x: 0, y: 0 }, { id: '2', type: 'end', x: 1, y: 0 }], edges: [{ id: 'e1', from: '1', to: '2' }] };

      await api.graph.set('pl2', graph);

      expect(native.update).toHaveBeenCalledWith({ mode: -1 });
      expect(native.getFlag(CONST.moduleId, 'customPlayback')).toEqual(graph);
    });

    it('refuses an invalid graph with VALIDATION_FAILED and writes nothing', async () => {
      // No Start node: an error-level issue, the same bar the editor's Save button uses.
      await expect(api.graph.set('pl1', { version: 1, nodes: [], edges: [] }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeUndefined();
    });

    it('carries the full validation result on the thrown error', async () => {
      const error = await api.graph.set('pl1', { version: 1, nodes: [], edges: [] }).catch((e) => e);
      expect(error.validation.errors.length).toBeGreaterThan(0);
      expect(error.validation.errors[0].messageKey).toMatch(/^GameOrchestra\./);
    });

    /**
     * set() promises it applies "the same bar as the editor's Save button". Every Script-node rule
     * in graph-validation.mjs is environment-dependent and SELF-SKIPS when its context is missing,
     * so for as long as set() passed no context that promise was false in the one direction that
     * matters: a graph the editor would have refused went straight to the flag.
     *
     * The failure mode is not a crash but a graph that looks saved and can never do anything.
     */
    describe('holds Script nodes to the same bar as the editor', () => {
      const scriptGraph = (script) => ({
        version: 1,
        nodes: [
          { id: '1', type: 'start', x: 0, y: 0 },
          { id: '2', type: 'script', script, x: 1, y: 0 },
          { id: '3', type: 'end', x: 2, y: 0 }
        ],
        edges: [{ id: 'e1', from: '1', to: '2' }, { id: 'e2', from: '2', to: '3' }]
      });

      it('refuses inline source that cannot compile, and writes nothing', async () => {
        await expect(api.graph.set('pl1', scriptGraph({ mode: 'inline', source: 'return (;' })))
          .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeUndefined();
      });

      it('returns macro warnings rather than throwing - warnings never block a save', async () => {
        game.macros = [];
        const result = await api.graph.set('pl1', scriptGraph({ mode: 'macro', macroUuid: 'Macro.gone' }));

        expect(result.warnings.map((w) => w.messageKey))
          .toContain('GameOrchestra.CustomEditor.Validation.ScriptMacroNotFound');
        expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeTruthy();
      });

      it('resolves a real script macro with no complaint at all', async () => {
        game.macros = [{ uuid: 'Macro.ok', name: 'Boss FX', type: 'script' }];
        const result = await api.graph.set('pl1', scriptGraph({ mode: 'macro', macroUuid: 'Macro.ok' }));
        expect(result.warnings.filter((w) => w.messageKey.includes('Script'))).toEqual([]);
      });

      /**
       * The deliberate asymmetry with the editor (see api.mjs#scriptValidationContext): canAuthor
       * gates an editor FIELD, and asking it of an API caller answers the wrong question - the
       * module writing a graph is not the person who will later run it. inlineScriptsAllowed(), at
       * execution time, is the check that actually decides anything.
       */
      it('does NOT consult MACRO_SCRIPT permission - that is an editor affordance, not a gate', async () => {
        game.user.can = vi.fn(() => false);
        const result = await api.graph.set('pl1', scriptGraph({ mode: 'inline', source: 'return 1;' }));

        expect(result.warnings.map((w) => w.messageKey))
          .not.toContain('GameOrchestra.CustomEditor.Validation.ScriptNoPermission');
        expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeTruthy();
      });

      it('lets a caller override the environment context it supplies for itself', async () => {
        // A module validating against a world it is not currently in - the reason set() takes
        // options at all rather than hard-coding the live answers.
        const result = await api.graph.set(
          'pl1',
          scriptGraph({ mode: 'inline', source: 'return (;' }),
          { scripting: { inlineAllowed: true, compiles: () => true } }
        );
        expect(result.valid).toBe(true);
      });
    });

    it('validate() emits i18n KEYS, never localized strings', () => {
      const result = api.graph.validate({ version: 1, nodes: [], edges: [] });
      expect(result.valid).toBe(false);
      expect(result.errors[0].messageKey).toMatch(/^GameOrchestra\.CustomEditor\.Validation\./);
    });

    it('removes a graph', async () => {
      playlist.setFlag(CONST.moduleId, 'customPlayback', createEmptyGraph());
      await api.graph.remove('pl1');
      expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeUndefined();
    });

    it('hands out a working builder that produces a valid graph', () => {
      const builder = api.graph.builder();
      expect(typeof builder.node).toBe('function');
      expect(typeof builder.build).toBe('function');
    });
  });

  describe('mix', () => {
    it('returns a normalized mix even when nothing is stored', () => {
      expect(api.mix.get('pl1')).toMatchObject({ gain: 1, muted: [] });
    });

    it('patches the mix flag and leaves customPlayback untouched (HR-H)', async () => {
      await api.mix.patch('pl1', { gain: 0.4 });
      expect(api.mix.get('pl1').gain).toBe(0.4);
      // Sharing the flag would mean nudging a volume slider audibly restarted the music.
      expect(playlist.getFlag(CONST.moduleId, 'customPlayback')).toBeUndefined();
    });

    it('mutes and unmutes, and unmuting actually persists', async () => {
      // The muted list is an ARRAY rebuilt whole: a flag write is a recursive merge server-side,
      // so a map-shaped `muted` would merge the old `true` straight back in and unmute would
      // silently never persist. This is that bug's regression test at the API boundary.
      await api.mix.setMuted('pl1', 's1', true);
      expect(api.mix.get('pl1').muted).toEqual(['s1']);
      await api.mix.setMuted('pl1', 's1', false);
      expect(api.mix.get('pl1').muted).toEqual([]);
    });

    it('solo is session state and needs no GM - it is an audition tool', () => {
      game.user = { id: 'player1', isGM: false, active: true };
      expect(api.mix.setSolo('pl1', 's1')).toBe(true);
      expect(api.mix.getSolo('pl1')).toEqual(['s1']);
      api.mix.clearSolo('pl1');
      expect(api.mix.getSolo('pl1')).toEqual([]);
    });

    it('rejects an unknown sound with NOT_FOUND', async () => {
      await expect(api.mix.setVolume('pl1', 'ghost', 0.5)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(() => api.mix.effectiveVolume('pl1', 'ghost')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    });
  });

  describe('the re-entrancy guard (D-B1)', () => {
    /**
     * A Script node runs on the head GM, so every API call in its context passes the head-GM and
     * permission gates - there is no NOT_HEAD_GM to catch these. Two shapes eat their own engine:
     * rewriting the running graph (which tears down and restarts from Start, H8/H9, while the
     * script's node holds a token) and stopping playback from inside one of its own nodes.
     *
     * The throttle and the circuit breaker would eventually intervene, but a breaker trip is a
     * diagnosis, not a guardrail - and the music restarts in a loop until it fires.
     */
    beforeEach(() => {
      resetScriptExecution();
    });

    it('refuses to rewrite the graph of the playlist whose script is running', async () => {
      beginScriptExecution(new Set(['pl1']));
      await expect(api.graph.set('pl1', createEmptyGraph())).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
      await expect(api.graph.remove('pl1')).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
    });

    it('refuses to stop or restart playback while any script is executing', async () => {
      game.gameOrchestra.musicController = { playCurrentTrack: vi.fn(), transitionToContext: vi.fn() };
      beginScriptExecution(new Set(['pl1']));
      await expect(api.playback.stop()).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
      await expect(api.playback.play()).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
      await expect(api.transport.refresh()).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
    });

    it('covers the whole engine TREE, not just the root', async () => {
      // Child engines share the registry by reference, so a script in a nested Playlist node's
      // target must not be able to restart the root.
      const nested = createMockPlaylist('pl2', 'Nested', []);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : id === 'pl2' ? nested : null));
      beginScriptExecution(new Set(['pl1', 'pl2']));
      await expect(api.graph.set('pl2', createEmptyGraph())).rejects.toMatchObject({ code: 'SELF_REENTRANT' });
    });

    it('still allows a script to rewrite a DIFFERENT playlist - the point of having the node', async () => {
      const other = createMockPlaylist('pl2', 'Other', [], -1);
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : id === 'pl2' ? other : null));
      beginScriptExecution(new Set(['pl1']));

      const graph = {
        version: 1,
        nodes: [{ id: '1', type: 'start', x: 0, y: 0 }, { id: '2', type: 'end', x: 1, y: 0 }],
        edges: [{ id: 'e1', from: '1', to: '2' }]
      };
      await expect(api.graph.set('pl2', graph)).resolves.toBeTruthy();
    });

    it('lifts the refusal once execution ends', async () => {
      const registry = new Set(['pl1']);
      beginScriptExecution(registry);
      endScriptExecution(registry);
      await expect(api.graph.remove('pl1')).resolves.toBeUndefined();
    });
  });

  describe('playback', () => {
    it('reports not-playing with no controller at all', () => {
      expect(api.playback.isPlaying()).toBe(false);
      expect(api.playback.currentContext()).toBeNull();
      expect(api.playback.currentPlaylists()).toEqual([]);
    });

    it('describes the winning context as a frozen plain descriptor, not the live object', () => {
      const context = { playlist, context: 'area', priority: -20, isOverlay: false, overlayAxis: null, contextEntity: { name: 'Cave', documentName: 'Scene' } };
      game.gameOrchestra.musicController = { currentContext: context, _layers: new Map() };
      const described = api.playback.currentContext();
      expect(described).toMatchObject({ playlistId: 'pl1', playlistName: 'Tavern', section: 'area', sourceName: 'Cave', sourceType: 'Scene' });
      expect(Object.isFrozen(described)).toBe(true);
      // The live PlaylistContext carries methods and document references; handing it out would
      // make its internals part of the contract.
      expect(described.playlist).toBeUndefined();
    });

    it('lists the base playlist plus every layer, deduplicated', () => {
      const layerPlaylist = createMockPlaylist('pl9', 'Choir', []);
      game.gameOrchestra.musicController = {
        currentContext: { playlist },
        _layers: new Map([['k1', { context: { playlist: layerPlaylist } }], ['k2', { context: { playlist } }]])
      };
      expect(api.playback.currentPlaylists()).toEqual([{ id: 'pl1', name: 'Tavern' }, { id: 'pl9', name: 'Choir' }]);
    });
  });
});
