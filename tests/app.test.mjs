import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, MockDocument, createMockPlaylist } from './mocks/foundry.mjs';

setupFoundryMocks();

import { GameOrchestraConfig } from '../scripts/app.mjs';
import { CONST } from '../scripts/config.mjs';

describe('GameOrchestraConfig', () => {
  let app;
  let tokenDoc;

  beforeEach(() => {
    setupFoundryMocks();

    tokenDoc = new MockDocument({
      documentName: 'Token',
      id: 'tok1',
      name: 'Guard',
      flags: { 'game-orchestra': { music: { combat: { overlays: { boss: { playlist: 'pl-boss' } } } } } },
      update: vi.fn().mockResolvedValue()
    });

    const pl1 = createMockPlaylist('pl-boss', 'Boss Playlist', []);
    const pl2 = createMockPlaylist('pl-area', 'Area Playlist', []);
    game.playlists = [pl1, pl2];

    game.gameOrchestra = {
      configApp: null,
      musicController: { currentContext: null, playCurrentTrack: vi.fn() }
    };

    app = new GameOrchestraConfig(tokenDoc);
  });

  describe('isTokenPhaseGrid', () => {
    it('is true for Token documents', () => {
      expect(app.isTokenPhaseGrid).toBe(true);
    });

    it('is false for Scene documents', () => {
      const sceneDoc = new MockDocument({ documentName: 'Scene', id: 'sc1', flags: {} });
      const sceneApp = new GameOrchestraConfig(sceneDoc);
      expect(sceneApp.isTokenPhaseGrid).toBe(false);
    });
  });

  describe('_prepareContext (phase-grid)', () => {
    it('builds phaseCards and defaultEntry for a Token document', () => {
      setMockSetting('game-orchestra', 'configuredPhases', CONST.defaultPhases);

      const ctx = app._prepareContext({});

      expect(ctx.isTokenPhaseGrid).toBe(true);
      expect(ctx.phaseCards.find((p) => p.phaseId === 'boss')).toBeUndefined();
      expect(ctx.defaultEntry.combat.playlistId).toBeNull();
    });

    it('builds a phase card with an override when the configured phase id matches the token flag', () => {
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'boss', label: 'Boss', icon: 'fas fa-skull', color: '#f44336' }]);

      const ctx = app._prepareContext({});

      expect(ctx.phaseCards.find((p) => p.phaseId === 'boss').combat.playlistId).toBe('pl-boss');
      expect(ctx.phaseCards.find((p) => p.phaseId === 'boss').hasOverride).toBe(true);
    });

    it('marks a phase card as resolving when it is the currently playing context', () => {
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'boss', label: 'Boss', icon: 'fas fa-skull', color: '#f44336' }]);
      setMockSetting('game-orchestra', 'activePhase', 'boss');
      game.gameOrchestra.musicController.currentContext = { contextEntity: tokenDoc, isOverlay: true, overlayAxis: 'phase' };

      const ctx = app._prepareContext({});

      expect(ctx.phaseCards.find((p) => p.phaseId === 'boss').isResolving).toBe(true);
      expect(ctx.phasesResolving).toBe(true);
      expect(ctx.defaultResolving).toBe(false);
    });

    it('does not mark a phase as resolving when the currently playing context is a mood overlay, not a phase one', () => {
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'boss', label: 'Boss', icon: 'fas fa-skull', color: '#f44336' }]);
      setMockSetting('game-orchestra', 'activePhase', 'boss');
      game.gameOrchestra.musicController.currentContext = { contextEntity: tokenDoc, isOverlay: true, overlayAxis: 'mood' };

      const ctx = app._prepareContext({});

      expect(ctx.phaseCards.find((p) => p.phaseId === 'boss').isResolving).toBe(false);
      expect(ctx.phasesResolving).toBe(false);
    });
  });

  describe('formHandler Soundboard validation (H2 guard)', () => {
    it('auto-assigns the first track when saving a plain Soundboard playlist with no explicit track', async () => {
      const soundboardPlaylist = createMockPlaylist('pl-sfx', 'SFX Soundboard', [{ id: 'tr-1', name: 'Alarm' }], -1);
      game.playlists.push(soundboardPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-sfx' ? soundboardPlaylist : null));

      const mockApp = { updateObject: vi.fn().mockResolvedValue(), close: vi.fn() };
      const formData = { object: { 'music.combat.playlist': 'pl-sfx' } };

      await GameOrchestraConfig.formHandler.call(mockApp, new Event('submit'), null, formData);

      expect(mockApp.updateObject).toHaveBeenCalledWith(
        expect.objectContaining({ 'music.combat.playlist': 'pl-sfx', 'music.combat.initialTrack': 'tr-1' })
      );
    });

    it('does NOT auto-assign a track when saving a custom (graph) playlist, even in UNSEQUENCED mode', async () => {
      const customPlaylist = createMockPlaylist('pl-custom', 'Custom Playlist', [{ id: 'tr-1', name: 'Track 1' }], -1);
      customPlaylist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      game.playlists.push(customPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-custom' ? customPlaylist : null));

      const mockApp = { updateObject: vi.fn().mockResolvedValue(), close: vi.fn() };
      const formData = { object: { 'music.combat.playlist': 'pl-custom' } };

      await GameOrchestraConfig.formHandler.call(mockApp, new Event('submit'), null, formData);

      const savedData = mockApp.updateObject.mock.calls[0][0];
      expect(savedData['music.combat.playlist']).toBe('pl-custom');
      expect(savedData['music.combat.initialTrack']).toBeUndefined();
    });
  });

  describe('handleUpdatePhaseEntry / handleClearPhaseEntry', () => {
    it('sets the phase-scoped combat playlist flag when a playlist is selected', async () => {
      const target = { value: 'pl-area', dataset: { phaseId: 'tense' }, closest: () => null };

      await GameOrchestraConfig.handleUpdatePhaseEntry.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.tense.playlist': 'pl-area' }));
      expect(game.gameOrchestra.musicController.playCurrentTrack).toHaveBeenCalled();
    });

    it('clears the phase-scoped combat entry when no playlist is selected', async () => {
      const target = { value: '', dataset: { phaseId: 'boss' }, closest: () => null };

      await GameOrchestraConfig.handleUpdatePhaseEntry.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.-=boss': null }));
    });

    it('automatically assigns the first track for a Soundboard playlist', async () => {
      const soundboardPlaylist = createMockPlaylist('pl-sfx', 'SFX Soundboard', [{ id: 'tr-1', name: 'Alarm' }]);
      soundboardPlaylist.mode = -1;
      game.playlists.push(soundboardPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-sfx' ? soundboardPlaylist : null));
      const target = { value: 'pl-sfx', dataset: { phaseId: 'boss' }, closest: () => null };

      await GameOrchestraConfig.handleUpdatePhaseEntry.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({
          'flags.game-orchestra.music.combat.overlays.boss.playlist': 'pl-sfx',
          'flags.game-orchestra.music.combat.overlays.boss.initialTrack': 'tr-1'
        })
      );
    });

    it('deletes the whole phase entry on clear', async () => {
      const target = { dataset: { phaseId: 'boss' }, closest: () => null };

      await GameOrchestraConfig.handleClearPhaseEntry.call(app, { preventDefault: vi.fn() }, target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.-=boss': null }));
    });
  });

  describe('handleUpdatePhaseTrack', () => {
    it('sets the phase-scoped track flag', async () => {
      const target = { value: 'tr-9', dataset: { phaseId: 'boss' }, closest: () => null };

      await GameOrchestraConfig.handleUpdatePhaseTrack.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.boss.initialTrack': 'tr-9' }));
    });

    it('unsets the phase-scoped track flag when cleared', async () => {
      const target = { value: '', dataset: { phaseId: 'boss' }, closest: () => null };

      await GameOrchestraConfig.handleUpdatePhaseTrack.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.boss.-=initialTrack': null }));
    });
  });

  describe('handleUpdateDefaultEntry / handleClearDefaultEntry', () => {
    it('sets the default combat playlist flag', async () => {
      const target = { value: 'pl-area', dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleUpdateDefaultEntry.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.playlist': 'pl-area' }));
    });

    it('clears the default combat entry without deleting phase overrides', async () => {
      await GameOrchestraConfig.handleClearDefaultEntry.call(app, { preventDefault: vi.fn() }, {});

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({
          'flags.game-orchestra.music.combat.-=playlist': null,
          'flags.game-orchestra.music.combat.-=initialTrack': null,
          'flags.game-orchestra.music.combat.-=priority': null
        })
      );
    });
  });

  describe('handleToggleExclusive', () => {
    it('writes the flag at section level, never under the selected phase overlay', async () => {
      app.selectedPhase = 'p2';
      const target = { checked: true, dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleToggleExclusive.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'flags.game-orchestra.music.combat.exclusive': true })
      );
      const written = Object.keys(tokenDoc.update.mock.calls[0][0]);
      expect(written.some((key) => key.includes('overlays'))).toBe(false);
    });

    it('removes the flag rather than storing false, so the default stays "layer"', async () => {
      const target = { checked: false, dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleToggleExclusive.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'flags.game-orchestra.music.combat.-=exclusive': null })
      );
    });
  });

  describe('handleUpdateDuck', () => {
    it('stores the slider position as a multiplier at section level', async () => {
      const target = { value: '0.35', dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleUpdateDuck.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'flags.game-orchestra.music.combat.duck': 0.35 })
      );
    });

    it('removes the key at 100%, so "no ducking" stays the absent-value default', async () => {
      const target = { value: '1', dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleUpdateDuck.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'flags.game-orchestra.music.combat.-=duck': null })
      );
    });

    it('coerces a malformed slider value rather than writing NaN into the flag', async () => {
      const target = { value: 'not-a-number', dataset: {}, closest: () => null };

      await GameOrchestraConfig.handleUpdateDuck.call(app, new Event('change'), target);

      expect(tokenDoc.update).toHaveBeenCalledWith(
        expect.objectContaining({ 'flags.game-orchestra.music.combat.-=duck': null })
      );
    });
  });

  describe('updateObject (PrototypeToken)', () => {
    let actor;
    let protoApp;

    beforeEach(() => {
      /** Stands in for foundry's PrototypeToken DataModel - matched by class name. */
      class PrototypeToken {
        constructor(parent, flags) {
          this.parent = parent;
          this.flags = flags;
        }
      }
      actor = { update: vi.fn().mockResolvedValue(), documentName: 'Actor' };
      actor.prototypeToken = new PrototypeToken(actor, { 'game-orchestra': {} });
      protoApp = new GameOrchestraConfig(actor.prototypeToken);
      protoApp.render = vi.fn();
    });

    it('regression: writes plain dot-notation keys, never the bracketed flags["game-orchestra"] form', async () => {
      await protoApp.updateObject({ 'music.combat.playlist': 'pl-boss' });

      expect(actor.update).toHaveBeenCalledWith({ 'prototypeToken.flags.game-orchestra.music.combat.playlist': 'pl-boss' });
      const [written] = actor.update.mock.calls[0];
      expect(Object.keys(written).some((k) => k.includes('['))).toBe(false);
    });

    it('re-points at the real prototypeToken and re-renders after a successful write', async () => {
      await protoApp.updateObject({ 'music.combat.playlist': 'pl-boss' });

      expect(protoApp.document).toBe(actor.prototypeToken);
      expect(protoApp.render).toHaveBeenCalled();
    });

    it('does not silently swallow a parentless PrototypeToken', async () => {
      protoApp.document.parent = null;

      await protoApp.updateObject({ 'music.combat.playlist': 'pl-boss' });

      expect(actor.update).not.toHaveBeenCalled();
    });
  });

  describe('_onChangeInput', () => {
    it('dispatches phase-grid select changes based on data-change-action', () => {
      const spy = vi.spyOn(GameOrchestraConfig, 'handleUpdatePhaseEntry').mockImplementation(() => {});
      const selectEl = { tagName: 'SELECT', dataset: { changeAction: 'updatePhaseEntry' } };

      app._onChangeInput({ target: selectEl });

      expect(spy).toHaveBeenCalledWith(expect.anything(), selectEl);
      spy.mockRestore();
    });

    it('ignores selects without a data-change-action (old tabbed-form fields)', () => {
      const spy = vi.spyOn(GameOrchestraConfig, 'handleUpdatePhaseEntry').mockImplementation(() => {});
      const selectEl = { tagName: 'SELECT', dataset: {} };

      app._onChangeInput({ target: selectEl });

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('handleToggleSection', () => {
    it('toggles a section key between expanded/collapsed and re-renders', () => {
      const renderSpy = vi.spyOn(app, 'render').mockImplementation(() => {});
      const target = { dataset: { collapseKey: 'tokenPhases', defaultCollapsed: 'false' }, closest: () => null };

      GameOrchestraConfig.handleToggleSection.call(app, { preventDefault: vi.fn() }, target);
      expect(app.collapsedSections.has('tokenPhases')).toBe(true);

      GameOrchestraConfig.handleToggleSection.call(app, { preventDefault: vi.fn() }, target);
      expect(app.expandedSections.has('tokenPhases')).toBe(true);
      expect(renderSpy).toHaveBeenCalled();
    });

    it('reads data-collapse-key, never data-section', () => {
      // data-section on this template means the MUSIC section ('area'/'combat') and
      // sits on the context boxes. Sharing the attribute meant a closest() lookup
      // could walk out of a card header into a binding box and return 'combat' as a
      // collapse key.
      const renderSpy = vi.spyOn(app, 'render').mockImplementation(() => {});
      const target = { dataset: { section: 'combat', defaultCollapsed: 'false' }, closest: () => null };

      GameOrchestraConfig.handleToggleSection.call(app, { preventDefault: vi.fn() }, target);

      expect(app.collapsedSections.has('combat')).toBe(false);
      expect(renderSpy).not.toHaveBeenCalled();
    });
  });

  describe('onDropExternal (drag-and-drop from the Playlists directory)', () => {
    class MockPlaylistDoc {
      constructor(data) {
        Object.assign(this, data);
      }
    }
    class MockPlaylistSoundDoc {
      constructor(data) {
        Object.assign(this, data);
      }
    }

    beforeEach(() => {
      globalThis.Playlist = MockPlaylistDoc;
      globalThis.PlaylistSound = MockPlaylistSoundDoc;
      app.element = { querySelectorAll: vi.fn(() => []) };
    });

    function makeDropEvent(payload, dataset) {
      return {
        preventDefault: vi.fn(),
        currentTarget: { classList: { add: vi.fn(), remove: vi.fn() }, dataset },
        dataTransfer: { getData: vi.fn(() => JSON.stringify(payload)) }
      };
    }

    it('assigns a dropped Playlist to the phase-grid entry indicated by data-phase-id', async () => {
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-area', name: 'Area Playlist', mode: 0 });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-area' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-area' }, { section: 'combat', phaseId: 'tense' });

      const result = await app.onDropExternal(event);

      expect(result).toBe(true);
      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.tense.playlist': 'pl-area' }));
    });

    it('falls back to the tabbed selectedPhase when data-phase-id is absent (old fieldset flow)', async () => {
      app.selectedPhase = 'victory';
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-area', name: 'Area Playlist', mode: 0 });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-area' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-area' }, { section: 'combat' });

      await app.onDropExternal(event);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.victory.playlist': 'pl-area' }));
    });

    it('carries over an existing track when dropping a non-Soundboard playlist that still contains it', async () => {
      tokenDoc.flags['game-orchestra'].music.combat.overlays.boss.initialTrack = 'tr-old';
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-boss', name: 'Boss Playlist', mode: 0, sounds: new Map([['tr-old', { id: 'tr-old', name: 'Track' }]]) });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-boss' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-boss' }, { section: 'combat', phaseId: 'boss' });

      await app.onDropExternal(event);

      expect(tokenDoc.update).toHaveBeenCalledWith(expect.objectContaining({ 'flags.game-orchestra.music.combat.overlays.boss.initialTrack': 'tr-old' }));
    });

    it('regression: drops an existing track that belongs to a DIFFERENT playlist rather than carrying it over', async () => {
      // The slot previously pointed at some other playlist's track ('tr-old').
      // Dropping pl-boss (which has its own, different sounds) must not write
      // 'tr-old' back verbatim - PlaylistContext._resolveTracks() would look it
      // up inside pl-boss's own sounds, find nothing, and silently play nothing.
      tokenDoc.flags['game-orchestra'].music.combat.overlays.boss.initialTrack = 'tr-old';
      const droppedPlaylist = new MockPlaylistDoc({ id: 'pl-boss', name: 'Boss Playlist', mode: 0, sounds: new Map([['tr-new', { id: 'tr-new', name: 'Track' }]]) });
      globalThis.fromUuid = vi.fn().mockResolvedValue(droppedPlaylist);
      game.playlists.get = vi.fn((id) => (id === 'pl-boss' ? droppedPlaylist : null));

      const event = makeDropEvent({ type: 'Playlist', uuid: 'Playlist.pl-boss' }, { section: 'combat', phaseId: 'boss' });

      await app.onDropExternal(event);

      const call = tokenDoc.update.mock.calls[0][0];
      expect(call['flags.game-orchestra.music.combat.overlays.boss.playlist']).toBe('pl-boss');
      expect(call['flags.game-orchestra.music.combat.overlays.boss.initialTrack']).not.toBe('tr-old');
    });
  });

  describe('_onDragLeaveExternal', () => {
    it('clears drop-hover when the drag genuinely leaves the drop target', () => {
      const box = { contains: vi.fn(() => false), classList: { remove: vi.fn() } };
      const child = { closest: vi.fn(() => box) };

      app._onDragLeaveExternal({ target: child, relatedTarget: {} });

      expect(box.classList.remove).toHaveBeenCalledWith('drop-hover');
    });

    it('does not clear drop-hover when moving between child elements of the same target', () => {
      const box = { contains: vi.fn(() => true), classList: { remove: vi.fn() } };
      const child = { closest: vi.fn(() => box) };

      app._onDragLeaveExternal({ target: child, relatedTarget: {} });

      expect(box.classList.remove).not.toHaveBeenCalled();
    });

    it('does nothing when leaving an element outside any drop target', () => {
      const target = { closest: vi.fn(() => null) };

      expect(() => app._onDragLeaveExternal({ target, relatedTarget: null })).not.toThrow();
    });
  });

  describe('_onRender / _onClose event listener management', () => {
    it('attaches change and dragleave listeners only once each across multiple _onRender calls', () => {
      const mockElement = { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: vi.fn(() => []) };
      app.element = mockElement;

      app._onRender({}, {});
      app._onRender({}, {});

      const changeCalls = mockElement.addEventListener.mock.calls.filter((c) => c[0] === 'change');
      const dragleaveCalls = mockElement.addEventListener.mock.calls.filter((c) => c[0] === 'dragleave');
      expect(changeCalls).toHaveLength(1);
      expect(dragleaveCalls).toHaveLength(1);
    });

    it('removes change and dragleave listeners on _onClose', () => {
      const mockElement = { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: vi.fn(() => []) };
      app.element = mockElement;

      app._onRender({}, {});
      app._onClose({});

      expect(mockElement.removeEventListener).toHaveBeenCalledWith('change', app._onChangeInputHandler);
      expect(mockElement.removeEventListener).toHaveBeenCalledWith('dragleave', app._onDragLeaveHandler);
      expect(app._changeListenerBound).toBe(false);
      expect(app._dragLeaveListenerBound).toBe(false);
    });

    it('rebinds drag/drop on every _onRender call, not just the first', () => {
      const mockElement = { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: vi.fn(() => []) };
      app.element = mockElement;
      foundry.applications.ux.DragDrop.resetBindCallCount();

      app._onRender({}, {});
      app._onRender({}, {});
      app._onRender({}, {});

      // One DragDrop config entry x three renders - see PlaylistTreeApp's
      // equivalent test/docstring: the section boxes DragDrop targets are
      // recreated wholesale by every render, so binding only once orphans
      // drag-and-drop after the window's first re-render.
      expect(foundry.applications.ux.DragDrop.bindCallCount).toBe(GameOrchestraConfig.DEFAULT_OPTIONS.dragDrop.length * 3);
    });

    it('regression: a section box recreated by a later render still receives a working drop handler', () => {
      function makeBox() {
        return { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
      }
      const firstRenderBox = makeBox();
      const secondRenderBox = makeBox();
      const mockElement = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        querySelectorAll: vi.fn().mockReturnValueOnce([firstRenderBox]).mockReturnValueOnce([secondRenderBox])
      };
      app.element = mockElement;

      app._onRender({}, {});
      app._onRender({}, {});

      expect(firstRenderBox.listeners.drop).toBeInstanceOf(Function);
      expect(secondRenderBox.listeners.drop).toBeInstanceOf(Function);
    });
  });
});
