import { CONST } from './config.mjs';
import { log, resolveInitialTrack, getAvailablePlaylists, buildPlaylistEntry } from './helpers.mjs';
import { MoodConfigApp, PhaseConfigApp } from './mood-config.mjs';
import { CustomPlaylistEditor } from './custom-playlist-editor.mjs';
import { GameOrchestraAppMixin } from './app-mixins.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DragDrop } = foundry.applications.ux;

const _loc = (key) => game.i18n.localize(key);

/**
 * Playlist Hierarchy Tree Manager application
 */
export class PlaylistTreeApp extends GameOrchestraAppMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-playlist-tree',
    tag: 'div',
    window: { title: 'GameOrchestra.PlaylistTree.Title', icon: 'fas fa-sitemap', resizable: true, minimizable: true },
    classes: ['game-orchestra-playlist-tree-window'],
    position: { width: 820, height: 'auto' },
    dragDrop: [{ dragSelector: null, dropSelector: '.context-box[data-drop-scope]', permissions: { dragstart: false, drop: true }, callbacks: {} }],
    actions: {
      selectScene: PlaylistTreeApp.handleSelectScene,
      updateSceneOverlay: PlaylistTreeApp.handleUpdateSceneOverlay,
      updateSceneOverlayTrack: PlaylistTreeApp.handleUpdateSceneOverlayTrack,
      clearSceneOverlay: PlaylistTreeApp.handleClearSceneOverlay,
      updateSceneDefault: PlaylistTreeApp.handleUpdateSceneDefault,
      updateSceneDefaultTrack: PlaylistTreeApp.handleUpdateSceneDefaultTrack,
      clearSceneDefault: PlaylistTreeApp.handleClearSceneDefault,
      updateGlobalOverlay: PlaylistTreeApp.handleUpdateGlobalOverlay,
      updateGlobalOverlayTrack: PlaylistTreeApp.handleUpdateGlobalOverlayTrack,
      clearGlobalOverlay: PlaylistTreeApp.handleClearGlobalOverlay,
      updateGlobalDefault: PlaylistTreeApp.handleUpdateGlobalDefault,
      updateGlobalDefaultTrack: PlaylistTreeApp.handleUpdateGlobalDefaultTrack,
      clearGlobalDefault: PlaylistTreeApp.handleClearGlobalDefault,
      openMoodConfig: PlaylistTreeApp.handleOpenMoodConfig,
      openPhaseConfig: PlaylistTreeApp.handleOpenPhaseConfig,
      openCustomGraph: PlaylistTreeApp.handleOpenCustomGraph,
      toggleSection: PlaylistTreeApp.handleToggleSection
    }
  };

  /** @override */
  static PARTS = { main: { template: 'modules/game-orchestra/templates/playlist-tree.hbs' } };

  constructor(options = {}) {
    super(options);
    const activeSceneId = game.scenes?.active?.id || '';
    this.selectedSceneId = options.selectedSceneId || activeSceneId || 'global';
    this.expandedSections = new Set(options.expandedSections || []);
    this.collapsedSections = new Set(options.collapsedSections || []);
    // Registered here (not just in open()) so an instance created any other
    // way - notably Foundry instantiating this class directly for the
    // 'playlistTreeMenu' settings menu registration (settings.mjs) - is still
    // the one _refreshUI()/_resolveInstance()/toggle() find, matching
    // GameOrchestraConfig's identical pattern for game.gameOrchestra.configApp.
    if (game.gameOrchestra) game.gameOrchestra.playlistTree = this;
  }

  /** @override */
  _prepareContext(_options) {
    const availablePlaylists = getAvailablePlaylists();
    const buildEntry = (playlistId, trackId) => buildPlaylistEntry(availablePlaylists, playlistId, trackId);

    const activeScene = game.scenes?.active || null;

    const scenes = (game.scenes?.contents || Array.from(game.scenes || [])).map((s) => ({
      id: s.id,
      name: s.name,
      isActive: s.id === activeScene?.id,
      isSelected: s.id === this.selectedSceneId
    }));

    const selectedScene = game.scenes?.get(this.selectedSceneId) || null;
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const activeMood = game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    const activePhase = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';

    // Determine current active audio resolution context
    const currentControllerContext = game.gameOrchestra?.musicController?.currentContext || null;
    const winningEntity = currentControllerContext?.contextEntity;
    const winningIsOverlay = currentControllerContext?.isOverlay ?? false;
    const winningOverlayAxis = currentControllerContext?.overlayAxis ?? null;

    // Moods overlay area music, phases overlay combat music (config.mjs#sectionAxis) -
    // each gets its OWN card grid rather than sharing one, since a scene/global
    // config can be on a different mood tab than phase tab at once.
    const sceneMoods = configuredMoods.map((m) => {
      const areaPlId = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.area.overlays.${m.id}.playlist`) || null : null;
      const areaTrId = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.area.overlays.${m.id}.initialTrack`) || null : null;
      const hasOverride = !!areaPlId;
      const isResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'mood' && activeMood === m.id;
      const cardKey = `sceneMood:${m.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        moodId: m.id,
        label: m.label,
        icon: m.icon,
        color: m.color,
        area: buildEntry(areaPlId, areaTrId),
        isActive: activeMood === m.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey
      };
    });

    const scenePhases = configuredPhases.map((p) => {
      const combatPlId = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.combat.overlays.${p.id}.playlist`) || null : null;
      const combatTrId = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.combat.overlays.${p.id}.initialTrack`) || null : null;
      const hasOverride = !!combatPlId;
      const isResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'phase' && activePhase === p.id;
      const cardKey = `scenePhase:${p.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        phaseId: p.id,
        label: p.label,
        icon: p.icon,
        color: p.color,
        combat: buildEntry(combatPlId, combatTrId),
        isActive: activePhase === p.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey
      };
    });

    // Build Scene Defaults context data - axis-agnostic (no overlay selected),
    // so area and combat stay together in one card like before.
    const sceneDefaults = {
      area: buildEntry(
        selectedScene ? selectedScene.getFlag(CONST.moduleId, 'music.area.playlist') || null : null,
        selectedScene ? selectedScene.getFlag(CONST.moduleId, 'music.area.initialTrack') || null : null
      ),
      combat: buildEntry(
        selectedScene ? selectedScene.getFlag(CONST.moduleId, 'music.combat.playlist') || null : null,
        selectedScene ? selectedScene.getFlag(CONST.moduleId, 'music.combat.initialTrack') || null : null
      )
    };

    const sceneMoodsResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'mood';
    const scenePhasesResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'phase';
    const sceneDefaultsResolving = winningEntity === selectedScene && !winningIsOverlay;

    // Build Global Default & overlay context data
    const defaultConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || {};
    const defaultData = defaultConfig?.data?.['game-orchestra']?.music || {};

    const globalMoods = configuredMoods.map((m) => {
      const areaPlId = defaultData.area?.overlays?.[m.id]?.playlist || null;
      const areaTrId = defaultData.area?.overlays?.[m.id]?.initialTrack || null;
      const hasOverride = !!areaPlId;
      const isResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'mood' && activeMood === m.id;
      const cardKey = `globalMood:${m.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        moodId: m.id,
        label: m.label,
        icon: m.icon,
        color: m.color,
        area: buildEntry(areaPlId, areaTrId),
        isActive: activeMood === m.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey
      };
    });

    const globalPhases = configuredPhases.map((p) => {
      const combatPlId = defaultData.combat?.overlays?.[p.id]?.playlist || null;
      const combatTrId = defaultData.combat?.overlays?.[p.id]?.initialTrack || null;
      const hasOverride = !!combatPlId;
      const isResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'phase' && activePhase === p.id;
      const cardKey = `globalPhase:${p.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        phaseId: p.id,
        label: p.label,
        icon: p.icon,
        color: p.color,
        combat: buildEntry(combatPlId, combatTrId),
        isActive: activePhase === p.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey
      };
    });

    const globalDefaults = {
      area: buildEntry(defaultData.area?.playlist || null, defaultData.area?.initialTrack || null),
      combat: buildEntry(defaultData.combat?.playlist || null, defaultData.combat?.initialTrack || null)
    };

    const globalMoodsResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'mood';
    const globalPhasesResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'phase';
    const globalDefaultsResolving = winningEntity?.documentName === 'DefaultMusic' && !winningIsOverlay;

    // Active resolution status pill text
    let activeResolutionInfo = null;
    if (currentControllerContext) {
      let source;
      const overlayFormatKey = winningOverlayAxis === 'phase' ? 'ActiveAudioScenePhase' : 'ActiveAudioSceneMood';
      const globalOverlayFormatKey = winningOverlayAxis === 'phase' ? 'ActiveAudioGlobalPhase' : 'ActiveAudioGlobalMood';
      const overlayValue = winningOverlayAxis === 'phase' ? activePhase : activeMood;
      if (winningEntity === selectedScene) {
        source = winningIsOverlay
          ? game.i18n.format(`GameOrchestra.PlaylistTree.${overlayFormatKey}`, { mood: overlayValue })
          : _loc('GameOrchestra.PlaylistTree.ActiveAudioSceneDefault');
      } else if (winningEntity?.documentName === 'DefaultMusic') {
        source = winningIsOverlay
          ? game.i18n.format(`GameOrchestra.PlaylistTree.${globalOverlayFormatKey}`, { mood: overlayValue })
          : _loc('GameOrchestra.PlaylistTree.ActiveAudioGlobalDefault');
      } else if (winningEntity) {
        source = winningEntity.name || _loc('GameOrchestra.PlaylistTree.ActiveAudioTokenActor');
      } else {
        source = _loc('GameOrchestra.None');
      }
      activeResolutionInfo = { label: `${_loc('GameOrchestra.PlaylistTree.ActiveAudioPrefix')} ${source}` };
    }

    const hasSceneMoodsOverride = sceneMoods.some((m) => m.hasOverride);
    const hasScenePhasesOverride = scenePhases.some((p) => p.hasOverride);
    const hasSceneDefaultsOverride = !!(sceneDefaults.area.playlistId || sceneDefaults.combat.playlistId);
    const hasGlobalMoodsOverride = globalMoods.some((m) => m.hasOverride);
    const hasGlobalPhasesOverride = globalPhases.some((p) => p.hasOverride);
    const hasGlobalDefaultsOverride = !!(globalDefaults.area.playlistId || globalDefaults.combat.playlistId);

    const collapsed = {
      sceneMoods: this.isSectionCollapsed('sceneMoods', hasSceneMoodsOverride),
      scenePhases: this.isSectionCollapsed('scenePhases', hasScenePhasesOverride),
      sceneDefaults: this.isSectionCollapsed('sceneDefaults', hasSceneDefaultsOverride),
      globalMoods: this.isSectionCollapsed('globalMoods', hasGlobalMoodsOverride),
      globalPhases: this.isSectionCollapsed('globalPhases', hasGlobalPhasesOverride),
      globalDefaults: this.isSectionCollapsed('globalDefaults', hasGlobalDefaultsOverride)
    };

    return {
      scenes,
      selectedSceneId: this.selectedSceneId,
      selectedScene,
      availablePlaylists,
      configuredMoods,
      configuredPhases,
      sceneMoods,
      scenePhases,
      sceneDefaults,
      sceneMoodsResolving,
      scenePhasesResolving,
      sceneDefaultsResolving,
      globalMoods,
      globalPhases,
      globalDefaults,
      globalMoodsResolving,
      globalPhasesResolving,
      globalDefaultsResolving,
      activeResolutionInfo,
      collapsed
    };
  }

  /**
   * Bind drop handling for Playlist/PlaylistSound documents dragged in from
   * the sidebar Playlists directory onto an Area/Combat context box.
   *
   * Called on every render (see the mixin's _onRender - app-mixins.mjs), not
   * just the first: the context boxes it targets live inside the Handlebars
   * `main` part, which is replaced wholesale on each render, so a binding from
   * an earlier render points at detached elements the user can no longer see
   * or drop onto.
   *
   * Builds a fresh config object per call rather than mutating
   * DEFAULT_OPTIONS.dragDrop in place, since that array is shared across every
   * instance of this class - writing instance-bound callbacks onto it would
   * let a second open window silently steal the callbacks of an earlier one.
   * @private
   */
  _setupDragDrop() {
    const dragDropConfigs = this.options.dragDrop || PlaylistTreeApp.DEFAULT_OPTIONS.dragDrop || [];
    for (const dragDropOptions of dragDropConfigs) {
      const instanceOptions = {
        ...dragDropOptions,
        callbacks: {
          dragover: this._onDragOverExternal.bind(this),
          drop: this._onDropExternal.bind(this)
        }
      };
      new DragDrop(instanceOptions).bind(this.element);
    }
  }

  /**
   * Clear hover feedback once a drag genuinely leaves a context box (as opposed to
   * moving between its child elements, which also fires dragleave on the box)
   * @param {DragEvent} event
   * @private
   */
  _onDragLeaveExternal(event) {
    const box = event.target.closest?.('.context-box[data-drop-scope]');
    if (!box) return;
    if (event.relatedTarget && box.contains(event.relatedTarget)) return;
    box.classList.remove('drop-hover');
  }

  /**
   * Handle drag-over on a context box to show hover feedback for a valid external drag
   * @param {DragEvent} event
   * @private
   */
  _onDragOverExternal(event) {
    event.preventDefault();
    if (event.dataTransfer.types.includes('text/plain')) event.currentTarget.classList.add('drop-hover');
  }

  /**
   * Handle dropping a Playlist or PlaylistSound from the sidebar onto an Area/Combat context box
   * @param {DragEvent} event
   * @private
   */
  async _onDropExternal(event) {
    const target = event.currentTarget;
    target.classList.remove('drop-hover');

    try {
      const dataString = event.dataTransfer.getData('text/plain');
      if (!dataString) return false;
      let data;
      try {
        data = JSON.parse(dataString);
      } catch (e) {
        log(1, 'Failed to parse drag data:', e);
        return false;
      }
      if (!['Playlist', 'PlaylistSound'].includes(data.type) || !data.uuid) return false;

      const document = await fromUuid(data.uuid);
      if (!document) {
        log(2, `Failed to handle playlist tree drop: document with UUID '${data.uuid}' not found`);
        return false;
      }

      let playlist, sound;
      if (document instanceof PlaylistSound) {
        playlist = document.parent;
        sound = document;
      } else if (document instanceof Playlist) {
        playlist = document;
      } else {
        log(2, `Failed to handle playlist tree drop: resolved document is not a Playlist or PlaylistSound`);
        return false;
      }

      const { dropScope, contextType, moodId, phaseId } = target.dataset;
      const axis = CONST.sectionAxis[contextType];
      const overlayId = (axis === 'phase' ? phaseId : moodId) || null;
      const path = PlaylistTreeApp._buildPath(contextType, overlayId);

      if (dropScope === 'scene') {
        const scene = game.scenes?.get(this.selectedSceneId);
        if (!scene) return false;
        await PlaylistTreeApp._applySceneEntry(scene, path, playlist.id, sound?.id);
      } else {
        await PlaylistTreeApp._applyGlobalEntry(path, playlist.id, sound?.id);
      }

      // Awaited, not fire-and-forget: playCurrentTrack() can itself trigger a re-render of this
      // same window (transitionToContext() -> _refreshUI(), when the drop changes the resolved
      // winning context) - see music-controller.mjs. Two overlapping, unordered render() calls on
      // one ApplicationV2 instance risk Foundry's DragDrop rebinding (_setupDragDrop(), called from
      // _onRender on every render - see app-mixins.mjs) against a DOM that a second, still-in-flight
      // render is about to replace again. Awaiting here makes the two renders strictly sequential
      // instead of racing, so whichever one runs last is guaranteed to be the one that (re)binds
      // drag-and-drop. The delegated change/dragleave listeners don't need this - they're bound
      // once on the persistent root element and survive any number of re-renders regardless of
      // ordering - which is why this symptom is specific to drag-and-drop.
      await game.gameOrchestra?.musicController?.playCurrentTrack();
      this.render(false);
      log(3, `Successfully assigned playlist '${playlist.name}' via drop (scope: '${dropScope}', context: '${contextType}', overlay: '${overlayId || 'default'}')`);
      return true;
    } catch (error) {
      log(1, 'Error handling playlist tree drop:', error);
      return false;
    }
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if (game.gameOrchestra?.playlistTree === this) {
      game.gameOrchestra.playlistTree = null;
    }
  }

  /**
   * Maps `data-change-action` values to their handler method name. Looked up
   * dynamically on the class (rather than captured by reference) so that
   * spying/mocking a handler is honored by dispatch.
   */
  static _CHANGE_ACTIONS = {
    selectScene: 'handleSelectScene',
    updateSceneOverlay: 'handleUpdateSceneOverlay',
    updateSceneOverlayTrack: 'handleUpdateSceneOverlayTrack',
    updateSceneDefault: 'handleUpdateSceneDefault',
    updateSceneDefaultTrack: 'handleUpdateSceneDefaultTrack',
    updateGlobalOverlay: 'handleUpdateGlobalOverlay',
    updateGlobalOverlayTrack: 'handleUpdateGlobalOverlayTrack',
    updateGlobalDefault: 'handleUpdateGlobalDefault',
    updateGlobalDefaultTrack: 'handleUpdateGlobalDefaultTrack'
  };

  /**
   * Handle selecting a scene from the dropdown
   */
  static handleSelectScene(event, target) {
    const select = target.closest('select') || target;
    const instance = PlaylistTreeApp._resolveInstance(this);
    if (!instance) return;
    instance.selectedSceneId = select.value || 'global';
    instance.render(false);
  }

  /**
   * Resolve the active app instance from a static-handler call context. Prefers
   * `context` (the instance Foundry actually dispatched the action on) over the
   * global registry entry: if a second window were ever open at once, a click
   * inside one must act on that same window, not silently redirect to whichever
   * instance happened to register itself globally last.
   * @param {*} context - `this` inside the calling static handler
   * @returns {PlaylistTreeApp|null}
   * @private
   */
  static _resolveInstance(context) {
    return context instanceof PlaylistTreeApp ? context : game.gameOrchestra?.playlistTree || null;
  }

  /**
   * Build the flag/setting path for a music section, optionally scoped to an
   * overlay (a mood id for 'area', a phase id for 'combat' - config.mjs#sectionAxis)
   * @private
   */
  static _buildPath(contextType, overlayId) {
    return overlayId ? `music.${contextType}.overlays.${overlayId}` : `music.${contextType}`;
  }

  /**
   * Apply a playlist selection (or clear it, when playlistId is null) to a scene flag entry
   * @param {string} [trackIdOverride] - When provided, used verbatim instead of resolving
   *   from the existing/soundboard-default track (e.g. a specific track dragged onto the entry)
   * @private
   */
  static async _applySceneEntry(scene, path, playlistId, trackIdOverride = undefined) {
    if (playlistId) {
      const existingTrackId = scene.getFlag(CONST.moduleId, `${path}.initialTrack`) || null;
      const initialTrackId = trackIdOverride !== undefined ? trackIdOverride : resolveInitialTrack(playlistId, existingTrackId);
      await scene.setFlag(CONST.moduleId, `${path}.playlist`, playlistId);
      if (initialTrackId) await scene.setFlag(CONST.moduleId, `${path}.initialTrack`, initialTrackId);
    } else {
      await scene.unsetFlag(CONST.moduleId, `${path}.playlist`);
      await scene.unsetFlag(CONST.moduleId, `${path}.initialTrack`);
    }
  }

  /**
   * Apply a track selection (or clear it, when trackId is null) to a scene flag entry
   * @private
   */
  static async _applySceneTrack(scene, path, trackId) {
    if (trackId) await scene.setFlag(CONST.moduleId, `${path}.initialTrack`, trackId);
    else await scene.unsetFlag(CONST.moduleId, `${path}.initialTrack`);
  }

  /**
   * Apply a playlist selection (or clear it, when playlistId is null) to the global defaultMusic setting
   * @param {string} [trackIdOverride] - When provided, used verbatim instead of resolving
   *   from the existing/soundboard-default track (e.g. a specific track dragged onto the entry)
   * @private
   */
  static async _applyGlobalEntry(path, playlistId, trackIdOverride = undefined) {
    const prevConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || {};
    const updateData = foundry.utils.deepClone(prevConfig);

    if (playlistId) {
      const existingTrackId = foundry.utils.getProperty(updateData, `data.game-orchestra.${path}.initialTrack`) || null;
      const initialTrackId = trackIdOverride !== undefined ? trackIdOverride : resolveInitialTrack(playlistId, existingTrackId);
      foundry.utils.setProperty(updateData, `data.game-orchestra.${path}.playlist`, playlistId);
      if (initialTrackId) foundry.utils.setProperty(updateData, `data.game-orchestra.${path}.initialTrack`, initialTrackId);
    } else {
      const section = foundry.utils.getProperty(updateData, `data.game-orchestra.${path}`);
      if (section) {
        delete section.playlist;
        delete section.initialTrack;
      }
    }

    await game.settings.set(CONST.moduleId, CONST.settings.defaultMusic, updateData);
  }

  /**
   * Apply a track selection (or clear it, when trackId is null) to the global defaultMusic setting
   * @private
   */
  static async _applyGlobalTrack(path, trackId) {
    const prevConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || {};
    const updateData = foundry.utils.deepClone(prevConfig);

    if (trackId) {
      foundry.utils.setProperty(updateData, `data.game-orchestra.${path}.initialTrack`, trackId);
    } else {
      const section = foundry.utils.getProperty(updateData, `data.game-orchestra.${path}`);
      if (section) delete section.initialTrack;
    }

    await game.settings.set(CONST.moduleId, CONST.settings.defaultMusic, updateData);
  }

  /**
   * Descriptor table for the twelve update/clear handlers below - each one
   * differs only along three axes: scope (scene vs global), field (playlist
   * vs track), and whether the entry is overlay-scoped (a mood or phase id,
   * whichever the card's own section implies - config.mjs#sectionAxis) or the
   * section's plain default, plus whether the action clears rather than
   * updates. Every handler stays a real named static method (rather than
   * existing only as a table entry) since DEFAULT_OPTIONS.actions and
   * _CHANGE_ACTIONS both reference them by name/identity.
   */
  static _ENTRY_SPECS = {
    updateSceneOverlay: { scope: 'scene', field: 'playlist', overlay: true, clear: false },
    updateSceneOverlayTrack: { scope: 'scene', field: 'track', overlay: true, clear: false },
    clearSceneOverlay: { scope: 'scene', field: 'playlist', overlay: true, clear: true },
    updateSceneDefault: { scope: 'scene', field: 'playlist', overlay: false, clear: false },
    updateSceneDefaultTrack: { scope: 'scene', field: 'track', overlay: false, clear: false },
    clearSceneDefault: { scope: 'scene', field: 'playlist', overlay: false, clear: true },
    updateGlobalOverlay: { scope: 'global', field: 'playlist', overlay: true, clear: false },
    updateGlobalOverlayTrack: { scope: 'global', field: 'track', overlay: true, clear: false },
    clearGlobalOverlay: { scope: 'global', field: 'playlist', overlay: true, clear: true },
    updateGlobalDefault: { scope: 'global', field: 'playlist', overlay: false, clear: false },
    updateGlobalDefaultTrack: { scope: 'global', field: 'track', overlay: false, clear: false },
    clearGlobalDefault: { scope: 'global', field: 'playlist', overlay: false, clear: true }
  };

  /**
   * Shared implementation for every handleUpdate.../handleClear... method below.
   * Resolves the dispatching element (a <select> for an update, a button for
   * a clear - both always carry their own data-mood-id/data-phase-id/
   * data-context-type, so one combined selector covers both without needing
   * to know which fired), derives the section path and value per `spec`
   * (which overlay-id dataset key applies is decided by the context type's
   * own axis - config.mjs#sectionAxis), applies it via the matching
   * _applySceneEntry/_applySceneTrack/_applyGlobalEntry/_applyGlobalTrack
   * helper, then re-triggers playback and a re-render - exactly what each of
   * the twelve original handlers did by hand.
   * @param {{scope: 'scene'|'global', field: 'playlist'|'track', overlay: boolean, clear: boolean}} spec
   * @param {string} actionName - Key into _ENTRY_SPECS, for the error log only.
   * @param {Event} event
   * @param {HTMLElement} target
   * @private
   */
  static async _handleEntryAction(spec, actionName, event, target) {
    event?.preventDefault?.();
    const el = target.closest('select, [data-mood-id], [data-phase-id], [data-context-type]') || target;
    const contextType = el.dataset.contextType || 'area';
    const axis = CONST.sectionAxis[contextType];
    const overlayId = spec.overlay ? (axis === 'phase' ? el.dataset.phaseId : el.dataset.moodId) : null;
    const value = spec.clear ? null : el.value || null;
    const path = PlaylistTreeApp._buildPath(contextType, overlayId);

    const instance = PlaylistTreeApp._resolveInstance(this);
    let scene = null;
    if (spec.scope === 'scene') {
      scene = game.scenes?.get(instance?.selectedSceneId);
      if (!scene) return;
    }

    try {
      if (spec.field === 'playlist') {
        if (spec.scope === 'scene') await PlaylistTreeApp._applySceneEntry(scene, path, value);
        else await PlaylistTreeApp._applyGlobalEntry(path, value);
      } else if (spec.scope === 'scene') {
        await PlaylistTreeApp._applySceneTrack(scene, path, value);
      } else {
        await PlaylistTreeApp._applyGlobalTrack(path, value);
      }
      // Awaited before the re-render below - see the identical comment in _onDropExternal.
      await game.gameOrchestra?.musicController?.playCurrentTrack();
      instance?.render(false);
    } catch (error) {
      log(1, `Failed to run '${actionName}':`, error);
    }
  }

  /** Handle updating scene overlay playlist (a mood id for area, a phase id for combat) */
  static async handleUpdateSceneOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneOverlay, 'updateSceneOverlay', event, target);
  }

  /** Handle updating scene overlay track */
  static async handleUpdateSceneOverlayTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneOverlayTrack, 'updateSceneOverlayTrack', event, target);
  }

  /** Handle clearing scene overlay override */
  static async handleClearSceneOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearSceneOverlay, 'clearSceneOverlay', event, target);
  }

  /** Handle updating scene default playlist */
  static async handleUpdateSceneDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneDefault, 'updateSceneDefault', event, target);
  }

  /** Handle updating scene default track */
  static async handleUpdateSceneDefaultTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneDefaultTrack, 'updateSceneDefaultTrack', event, target);
  }

  /** Handle clearing scene default override */
  static async handleClearSceneDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearSceneDefault, 'clearSceneDefault', event, target);
  }

  /** Handle updating global overlay playlist */
  static async handleUpdateGlobalOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalOverlay, 'updateGlobalOverlay', event, target);
  }

  /** Handle updating global overlay track */
  static async handleUpdateGlobalOverlayTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalOverlayTrack, 'updateGlobalOverlayTrack', event, target);
  }

  /** Handle clearing global overlay override */
  static async handleClearGlobalOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearGlobalOverlay, 'clearGlobalOverlay', event, target);
  }

  /** Handle updating global default playlist */
  static async handleUpdateGlobalDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalDefault, 'updateGlobalDefault', event, target);
  }

  /** Handle updating global default track */
  static async handleUpdateGlobalDefaultTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalDefaultTrack, 'updateGlobalDefaultTrack', event, target);
  }

  /** Handle clearing global default override */
  static async handleClearGlobalDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearGlobalDefault, 'clearGlobalDefault', event, target);
  }

  /**
   * Handle opening the Mood Configurator dialog
   */
  static handleOpenMoodConfig(event, target) {
    event?.preventDefault?.();
    new MoodConfigApp().render(true);
  }

  /**
   * Handle opening the Phase Configurator dialog
   */
  static handleOpenPhaseConfig(event, target) {
    event?.preventDefault?.();
    new PhaseConfigApp().render(true);
  }

  /**
   * Handle opening the graph editor for a custom playlist assigned to one of
   * the tree's entries, so it can be edited without hunting the playlist down
   * in the sidebar and opening its config sheet first. Only rendered for
   * entries whose playlist actually has a graph (entry.isCustom).
   */
  static handleOpenCustomGraph(event, target) {
    event?.preventDefault?.();
    // closest(): the click may land on the button's inner <i>, as elsewhere in this file.
    const button = target.closest?.('[data-playlist-id]') || target;
    const playlistId = button?.dataset?.playlistId;
    const playlist = game.playlists?.get(playlistId);
    if (!playlist) {
      log(2, `PlaylistTreeApp: playlist '${playlistId}' not found; cannot open its playback graph.`);
      return;
    }
    new CustomPlaylistEditor(playlist).render(true);
  }

  /**
   * Handle toggling section collapse state
   */
  static handleToggleSection(event, target) {
    event?.preventDefault?.();
    const element = target.closest('[data-section]') || target;
    const sectionKey = element?.dataset?.section;
    if (!sectionKey) return;
    const instance = PlaylistTreeApp._resolveInstance(this);
    if (!instance) return;

    const defaultCollapsed = element.dataset.defaultCollapsed === 'true';
    const currentlyCollapsed = instance.expandedSections.has(sectionKey)
      ? false
      : instance.collapsedSections.has(sectionKey)
        ? true
        : defaultCollapsed;

    if (currentlyCollapsed) {
      instance.collapsedSections.delete(sectionKey);
      instance.expandedSections.add(sectionKey);
    } else {
      instance.expandedSections.delete(sectionKey);
      instance.collapsedSections.add(sectionKey);
    }
    instance.render(false);
  }

  /**
   * Toggle window visibility
   */
  static toggle() {
    if (!game.gameOrchestra) return;
    if (game.gameOrchestra.playlistTree && game.gameOrchestra.playlistTree.rendered) {
      game.gameOrchestra.playlistTree.close();
      game.gameOrchestra.playlistTree = null;
      return;
    }
    PlaylistTreeApp.open();
  }

  /**
   * Open window
   */
  static open(options = {}) {
    if (!game.gameOrchestra) return;
    if (game.gameOrchestra.playlistTree?.rendered) {
      game.gameOrchestra.playlistTree.render(true);
      return;
    }
    game.gameOrchestra.playlistTree = new PlaylistTreeApp(options);
    game.gameOrchestra.playlistTree.render(true);
  }
}
