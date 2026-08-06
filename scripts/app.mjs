import { CONST } from './config.mjs';
import { getDocumentCategory, getProperty, log, getAvailablePlaylists, buildPlaylistEntry, resolveInitialTrack } from './helpers.mjs';
import { GameOrchestraAppMixin } from './app-mixins.mjs';
import { coerceDuckFactor } from './playlist-mix.mjs';
import { updateObjectStore, bindingPath, applyBindingPlaylist, applyBindingTrack, clearBindingOverlay } from './binding-store.mjs';

const _loc = (key) => game.i18n.localize(key);

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DragDrop } = foundry.applications.ux;

/**
 * Main application window for Game Orchestra scene/token music configuration
 */
export class GameOrchestraConfig extends GameOrchestraAppMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-config',
    tag: 'form',
    window: { title: 'GameOrchestra.ConfigTitle', icon: 'fas fa-music', resizable: true, minimizable: true },
    // NOT modal (docs/wiki/ux.md D3). Assigning a playlist is precisely the task
    // where a GM wants to see - and drag from - the Playlists sidebar, which this
    // window supports via dragDrop below and a modal would block outright. The hub
    // has always been non-modal; this window disagreeing was the tell.
    classes: ['game-orchestra-config'],
    form: {
      handler: GameOrchestraConfig.formHandler,
      closeOnSubmit: false,
      submitOnChange: false
    },
    position: { width: 'auto', height: 'auto' },
    actions: {
      reset: GameOrchestraConfig.handleReset,
      openPlaylist: GameOrchestraConfig.openPlaylist,
      deletePlaylist: GameOrchestraConfig.deletePlaylist,
      selectOverlay: GameOrchestraConfig.selectOverlay,
      clearPhaseEntry: GameOrchestraConfig.handleClearPhaseEntry,
      clearDefaultEntry: GameOrchestraConfig.handleClearDefaultEntry,
      toggleSection: GameOrchestraConfig.handleToggleSection
    },
    dragDrop: [{ dragSelector: null, dropSelector: '.playlist-section[data-section]', permissions: { dragstart: false, drop: true }, callbacks: {} }]
  };

  /** @override */
  static PARTS = { form: { template: 'modules/game-orchestra/templates/music-config.hbs' } };

  config = [];

  /**
   * Create a new configuration instance
   * @param {Scene|TokenDocument|PrototypeToken} object The Scene or Token/PrototypeToken document to configure
   * @param {object} [options] Additional application options
   */
  constructor(object, options = {}) {
    super(options);
    this.document = object;
    // Two independent tab selections, one per overlay axis (config.mjs#sectionAxis) -
    // an area section's tabs are moods, a combat section's are phases, and the
    // Scene layout shows both at once (see _prepareContext/initializeConfig).
    this.selectedMood = options.selectedMood || game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    this.selectedPhase = options.selectedPhase || game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    this.expandedSections = new Set(options.expandedSections || []);
    this.collapsedSections = new Set(options.collapsedSections || []);
    if (game.gameOrchestra) game.gameOrchestra.configApp = this;
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if (game.gameOrchestra?.configApp === this) {
      game.gameOrchestra.configApp = null;
    }
  }

  /**
   * Handle selecting a mood or phase tab. Which instance field it writes is
   * decided by the tab's own `data-axis` ('mood' or 'phase'), not by which
   * section it happens to render under - see config.mjs#sectionAxis.
   */
  static selectOverlay(event, target) {
    event.preventDefault();
    const axis = target.dataset.axis === 'phase' ? 'phase' : 'mood';
    if (axis === 'phase') this.selectedPhase = target.dataset.overlay || '';
    else this.selectedMood = target.dataset.overlay || '';
    this.render(false);
  }

  /**
   * Maps `data-change-action` values to their handler method name. Looked up
   * dynamically on the class (rather than captured by reference) so that
   * spying/mocking a handler is honored by dispatch.
   */
  static _CHANGE_ACTIONS = {
    updatePhaseEntry: 'handleUpdatePhaseEntry',
    updatePhaseTrack: 'handleUpdatePhaseTrack',
    updateDefaultEntry: 'handleUpdateDefaultEntry',
    updateDefaultTrack: 'handleUpdateDefaultTrack',
    toggleExclusive: 'handleToggleExclusive',
    updateDuck: 'handleUpdateDuck'
  };

  /**
   * Handle the layer's duck slider - how far everything that isn't this layer is attenuated
   * while it plays. Stored as the resulting MULTIPLIER in [0, 1] (100% = untouched), matching
   * the mixer's own gain field, and at section level like `exclusive`. 1 removes the key rather
   * than storing it, so "no ducking" stays the absent-value default.
   */
  static async handleUpdateDuck(event, target) {
    const slider = target.closest('input[type="range"]') || target;
    const factor = coerceDuckFactor(slider.value);
    try {
      if (factor < 1) await this.updateObject({ 'music.combat.duck': factor });
      else await this.updateObject({ 'music.combat.-=duck': null });
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token layer duck:', error);
    }
  }

  /**
   * Handle toggling "play exclusively" for a token's combat music. Written at SECTION level
   * (`music.combat.exclusive`), never under the selected phase overlay - one flag governs
   * whichever playlist the section resolves to for any phase. Unticked (the default) means the
   * theme plays as an additive layer over the winning context instead of replacing it; see
   * MusicController#getCombatantLayerContext.
   */
  static async handleToggleExclusive(event, target) {
    const checkbox = target.closest('input[type="checkbox"]') || target;
    try {
      if (checkbox.checked) await this.updateObject({ 'music.combat.exclusive': true });
      else await this.updateObject({ 'music.combat.-=exclusive': null });
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token exclusive-playback flag:', error);
    }
  }

  /**
   * This window's data as a plain object, for {@link updateObjectStore} to read
   * through. Kept separate from `updateObject` (the write side) so the store has
   * a symmetric pair and no knowledge of which of the three document shapes it is
   * actually talking to.
   * @returns {object}
   */
  readData() {
    return getProperty(this.document, this.updateDataPrefix) || {};
  }

  /**
   * The BindingStore for this window's document. Every binding write below goes
   * through it, so a Token's flags, a Scene's flags and the world default all get
   * the same assign/clear semantics (docs/wiki/ux.md UX-2, binding-store.mjs).
   * @returns {import('./binding-store.mjs').BindingStore}
   */
  get bindingStore() {
    return updateObjectStore(this);
  }

  /**
   * Handle updating a phase-scoped combat playlist entry (token phase-grid layout)
   */
  static async handleUpdatePhaseEntry(event, target) {
    const select = target.closest('select') || target;
    const phaseId = select.dataset.phaseId;
    const playlistId = select.value || null;
    try {
      if (playlistId) await applyBindingPlaylist(this.bindingStore, bindingPath('combat', phaseId), playlistId);
      else await clearBindingOverlay(this.bindingStore, 'combat', phaseId);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token phase override:', error);
    }
  }

  /**
   * Handle updating a phase-scoped combat track entry
   */
  static async handleUpdatePhaseTrack(event, target) {
    const select = target.closest('select') || target;
    const phaseId = select.dataset.phaseId;
    const trackId = select.value || null;
    try {
      await applyBindingTrack(this.bindingStore, bindingPath('combat', phaseId), trackId);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token phase track:', error);
    }
  }

  /**
   * Handle clearing a phase-scoped combat override
   */
  static async handleClearPhaseEntry(event, target) {
    event.preventDefault();
    const btn = target.closest('[data-phase-id]') || target;
    const phaseId = btn.dataset.phaseId;
    try {
      await clearBindingOverlay(this.bindingStore, 'combat', phaseId);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to clear token phase override:', error);
    }
  }

  /**
   * Handle updating the default (non-overlay) combat playlist entry
   */
  static async handleUpdateDefaultEntry(event, target) {
    const select = target.closest('select') || target;
    const playlistId = select.value || null;
    try {
      // Section-level, so a null clears playlist/track/priority but deliberately
      // leaves `exclusive` and `duck` standing - see clearBindingOverlay's doc.
      await applyBindingPlaylist(this.bindingStore, bindingPath('combat'), playlistId);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token default override:', error);
    }
  }

  /**
   * Handle updating the default (non-mood) combat track entry
   */
  static async handleUpdateDefaultTrack(event, target) {
    const select = target.closest('select') || target;
    const trackId = select.value || null;
    try {
      await applyBindingTrack(this.bindingStore, bindingPath('combat'), trackId);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to update token default track:', error);
    }
  }

  /**
   * Handle clearing the default (non-mood) combat override
   */
  static async handleClearDefaultEntry(event, target) {
    event.preventDefault();
    try {
      await applyBindingPlaylist(this.bindingStore, bindingPath('combat'), null);
      game.gameOrchestra?.musicController?.playCurrentTrack();
    } catch (error) {
      log(1, 'Failed to clear token default override:', error);
    }
  }

  /**
   * Handle toggling mood-grid section/card collapse state
   */
  static handleToggleSection(event, target) {
    event?.preventDefault?.();
    // `data-collapse-key`, NOT `data-section`. This template uses `data-section` for
    // the *music* section ('area'/'combat') on its context boxes, so a collapse key
    // sharing that attribute name meant one attribute with two meanings and a
    // `closest('[data-section]')` that could walk out of a card header and into a
    // binding box - returning 'combat' as a collapse key.
    const element = target.closest('[data-collapse-key]') || target;
    const sectionKey = element?.dataset?.collapseKey;
    if (!sectionKey) return;
    const instance = this instanceof GameOrchestraConfig ? this : game.gameOrchestra?.configApp;
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
   * Get the update data prefix based on document type
   * @returns {string} The prefix path for flag updates
   */
  get updateDataPrefix() {
    const category = getDocumentCategory(this.document);
    if (category === 'Document' || category === 'PrototypeToken') return 'flags.game-orchestra';
    return 'data.game-orchestra';
  }

  /**
   * Check if the configured object is a Document
   * @returns {boolean} True if document instance
   */
  get isDocument() {
    return getDocumentCategory(this.document) === 'Document';
  }

  /**
   * Get the document type name for playlist sections lookup
   * Handles both Documents and DataModels (like PrototypeToken)
   * @returns {string|undefined} The document type name
   */
  get documentTypeName() {
    if (this.document.documentName) return this.document.documentName;
    if (getDocumentCategory(this.document) === 'PrototypeToken') return 'Token';
    log(2, `GameOrchestraConfig.documentTypeName: Unknown document class name: ${this.document?.constructor?.name}`);
    return undefined;
  }

  /**
   * Whether this document type uses the phase-card-grid layout (all phases shown
   * as simultaneous cards, matching PlaylistTreeApp) instead of the tabbed form.
   * Tokens have only a Combat section (config.mjs#playlistSections), and combat
   * resolves via phase, never mood (config.mjs#sectionAxis) - so this grid is
   * always phase-based, never mood-based.
   * @returns {boolean}
   */
  get isTokenPhaseGrid() {
    return this.documentTypeName === 'Token';
  }

  /**
   * Initialize the playlist configuration from document or defaults. Each
   * section reads its own axis's tab selection (area -> selectedMood, combat ->
   * selectedPhase - config.mjs#sectionAxis), so a Scene document's Area and
   * Combat fieldsets can show different overrides at once.
   */
  initializeConfig() {
    try {
      const docType = this.documentTypeName;
      const sections = CONST.playlistSections[docType];
      if (!sections) {
        log(1, 'No sections found for document type:', docType);
        this.config = [];
        return;
      }
      const data = getProperty(this.document, this.updateDataPrefix) || {};
      this.config = Object.entries(sections).map(([key, sectionConfig]) => {
        const axis = CONST.sectionAxis[key];
        const overlayId = (axis === 'phase' ? this.selectedPhase : this.selectedMood) || '';
        const rawSection = getProperty(data, `music.${key}`) || {};
        const effectiveData = overlayId ? (rawSection.overlays?.[overlayId] || {}) : rawSection;
        const playlistId = effectiveData.playlist;
        const playlist = playlistId ? game.playlists.get(playlistId) : null;
        const tracks =
          playlist?.playbackOrder?.reduce((obj, id) => {
            const track = playlist.sounds.get(id);
            if (track) obj[id] = track.name;
            return obj;
          }, {}) || {};
        return {
          id: key,
          axis,
          label: sectionConfig.label,
          order: effectiveData.order || sectionConfig.priority || 0,
          enabled: !!playlist,
          playlist,
          tracks,
          data: effectiveData
        };
      });
      this.config.sort((a, b) => a.order - b.order);
    } catch (error) {
      log(1, 'Error initializing configuration:', error);
      this.config = [];
    }
  }

  /** @override */
  _prepareContext(_options) {
    this.initializeConfig();
    const playlistConfig = this.config.map((section, index) => ({
      ...section,
      index,
      labelLocalized: _loc(section.label),
      selectedOverlay: (section.axis === 'phase' ? this.selectedPhase : this.selectedMood) || ''
    }));
    const buttons = [
      { type: 'submit', icon: 'fas fa-save', label: 'GameOrchestra.UI.Save' },
      { type: 'button', action: 'reset', icon: 'fas fa-undo', label: 'GameOrchestra.UI.Reset' }
    ];
    const activeWorldMood = game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    const activeWorldPhase = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const docData = getProperty(this.document, this.updateDataPrefix) || {};

    // hasOverride only scans sections whose OWN axis matches - an area section's
    // overlays never make a phase "have an override" and vice versa.
    const sectionKeysForAxis = (axis) => Object.entries(CONST.sectionAxis).filter(([, a]) => a === axis).map(([key]) => key);
    const hasAnyOverride = (id, axis) =>
      sectionKeysForAxis(axis).some((secKey) => !!docData.music?.[secKey]?.overlays?.[id]?.playlist);

    const availableMoods = configuredMoods.map((m) => ({
      ...m,
      isActive: m.id === (this.selectedMood || ''),
      isWorldActive: m.id === activeWorldMood,
      hasOverride: hasAnyOverride(m.id, 'mood')
    }));
    const availablePhases = configuredPhases.map((p) => ({
      ...p,
      isActive: p.id === (this.selectedPhase || ''),
      isWorldActive: p.id === activeWorldPhase,
      hasOverride: hasAnyOverride(p.id, 'phase')
    }));
    const context = {
      playlistConfig,
      buttons,
      documentType: this.documentTypeName,
      availableMoods,
      selectedMood: this.selectedMood || '',
      activeWorldMood,
      availablePhases,
      selectedPhase: this.selectedPhase || '',
      activeWorldPhase,
      isTokenPhaseGrid: this.isTokenPhaseGrid
    };
    if (this.isTokenPhaseGrid) Object.assign(context, this._preparePhaseGridContext(docData, configuredPhases, activeWorldPhase));
    return context;
  }

  /**
   * Build phase-card-grid context data for Token/PrototypeToken documents,
   * mirroring PlaylistTreeApp's scene phase-grid + scene-defaults structure
   * (Token only has a Combat section, so each card holds a single context box)
   * @param {object} docData - This document's game-orchestra flags/data namespace
   * @param {Array} configuredPhases - World-configured phases
   * @param {string} activeWorldPhase - Currently active world phase ID
   * @returns {object} Context fragment: availablePlaylists, phaseCards, defaultEntry, phasesResolving, defaultResolving, collapsed
   * @private
   */
  _preparePhaseGridContext(docData, configuredPhases, activeWorldPhase) {
    const availablePlaylists = getAvailablePlaylists();
    const combatSection = docData.music?.combat || {};

    const currentControllerContext = game.gameOrchestra?.musicController?.currentContext || null;
    const winningEntity = currentControllerContext?.contextEntity;
    const winningIsPhaseOverlay = currentControllerContext?.isOverlay && currentControllerContext?.overlayAxis === 'phase';

    const phaseCards = configuredPhases.map((p) => {
      const playlistId = combatSection.overlays?.[p.id]?.playlist || null;
      const trackId = combatSection.overlays?.[p.id]?.initialTrack || null;
      const hasOverride = !!playlistId;
      const isResolving = winningEntity === this.document && winningIsPhaseOverlay && activeWorldPhase === p.id;
      const cardKey = `tokenPhase:${p.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        phaseId: p.id,
        label: p.label,
        icon: p.icon,
        color: p.color,
        combat: buildPlaylistEntry(availablePlaylists, playlistId, trackId),
        isActive: activeWorldPhase === p.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey
      };
    });

    const defaultEntry = { combat: buildPlaylistEntry(availablePlaylists, combatSection.playlist || null, combatSection.initialTrack || null) };

    const phasesResolving = winningEntity === this.document && winningIsPhaseOverlay;
    const defaultResolving = winningEntity === this.document && !winningIsPhaseOverlay;

    const hasPhasesOverride = phaseCards.some((p) => p.hasOverride);
    const hasDefaultOverride = !!defaultEntry.combat.playlistId;

    const collapsed = {
      phases: this.isSectionCollapsed('tokenPhases', hasPhasesOverride),
      default: this.isSectionCollapsed('tokenDefault', hasDefaultOverride)
    };

    // Section level, deliberately read off combatSection rather than the selected phase overlay:
    // one flag governs whichever playlist this section resolves to for any phase. Only offered
    // once something is actually configured - the choice is meaningless with no playlist set.
    const combatExclusive = combatSection.exclusive === true;
    const hasAnyCombatPlaylist = !!defaultEntry.combat.playlistId || phaseCards.some((p) => p.hasOverride);
    // Stored as the multiplier the rest of the music is taken to, so 1 is "no ducking" and the
    // slider reads the same way round as the mixer's gain.
    const combatDuck = coerceDuckFactor(combatSection.duck);

    return {
      availablePlaylists,
      phaseCards,
      defaultEntry,
      phasesResolving,
      defaultResolving,
      collapsed,
      combatExclusive,
      hasAnyCombatPlaylist,
      combatDuck,
      combatDuckPercent: Math.round(combatDuck * 100)
    };
  }

  /**
   * Set up drag and drop handlers for external (sidebar Playlist/PlaylistSound)
   * drops onto a section box.
   *
   * Called on every render (see the mixin's _onRender - app-mixins.mjs), not
   * just the first: the section boxes it targets live inside the Handlebars
   * part content, which is replaced wholesale on each render, so a binding
   * from an earlier render points at detached elements the user can no longer
   * see or drop onto.
   *
   * Builds a fresh config object per call rather than mutating
   * DEFAULT_OPTIONS.dragDrop in place, since that array is shared across every
   * instance of this class - writing instance-bound callbacks onto it would
   * let a second open window silently steal the callbacks of an earlier one.
   * @private
   */
  _setupDragDrop() {
    const dragDropConfigs = this.options.dragDrop || GameOrchestraConfig.DEFAULT_OPTIONS.dragDrop || [];
    for (const dragDropOptions of dragDropConfigs) {
      const callbacks = { dragover: this.onDragOverExternal.bind(this), drop: this.onDropExternal.bind(this) };
      const dragDropHandler = new DragDrop({ ...dragDropOptions, callbacks });
      dragDropHandler.bind(this.element);
    }
  }

  /**
   * Handle drag over event for external drops
   * @param {DragEvent} event - The drag event
   */
  onDragOverExternal(event) {
    event.preventDefault();
    const hasExternalData = event.dataTransfer.types.includes('text/plain');
    if (hasExternalData) event.currentTarget.classList.add('drop-hover');
  }

  /**
   * Clear hover feedback once a drag genuinely leaves a drop target (as opposed
   * to moving between its child elements, which also fires dragleave on it)
   * @param {DragEvent} event
   * @private
   */
  _onDragLeaveExternal(event) {
    const box = event.target.closest?.('.playlist-section[data-section]');
    if (!box) return;
    if (event.relatedTarget && box.contains(event.relatedTarget)) return;
    box.classList.remove('drop-hover');
  }

  /**
   * Handle drop event for external playlist/sound drops
   * @param {DragEvent} event - The drop event
   * @returns {Promise<boolean>} Whether drop was handled successfully
   */
  async onDropExternal(event) {
    try {
      event.preventDefault();
      this.element.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'));
      const dataString = event.dataTransfer.getData('text/plain');
      if (!dataString) {
        log(2, 'Failed to handle external drop: empty drag data');
        return false;
      }
      let data;
      try {
        data = JSON.parse(dataString);
      } catch (e) {
        log(1, 'Failed to parse drag data:', e);
        return false;
      }
      if (!['Playlist', 'PlaylistSound'].includes(data.type) || !data.uuid) {
        log(2, `Failed to handle external drop: invalid document type '${data.type}'`);
        return false;
      }
      const section = event.currentTarget.dataset.section;
      if (!section) {
        log(2, 'Failed to handle external drop: section data not found on drop target');
        return false;
      }
      const document = await fromUuid(data.uuid);
      if (!document) {
        log(2, `Failed to handle external drop: document with UUID '${data.uuid}' not found`);
        return false;
      }
      let playlist, sound;
      if (document instanceof PlaylistSound) {
        playlist = document.parent;
        sound = document;
      } else if (document instanceof Playlist) {
        playlist = document;
      } else {
        log(2, `Failed to handle external drop: resolved document is not a Playlist or PlaylistSound`);
        return false;
      }
      if (!CONST.playlistSections[this.documentTypeName]?.[section]) {
        log(2, `Failed to handle external drop: no section configuration found for '${section}'`);
        return false;
      }
      // Which overlay id applies: an explicit per-card dataset attribute (Token
      // phase-grid cards; PlaylistTreeApp-style boxes) wins when present, else
      // this section's own axis tab selection (config.mjs#sectionAxis).
      const axis = CONST.sectionAxis[section];
      const datasetKey = axis === 'phase' ? 'phaseId' : 'moodId';
      const fallbackOverlay = axis === 'phase' ? this.selectedPhase : this.selectedMood;
      const targetOverlay = event.currentTarget.dataset[datasetKey] !== undefined ? event.currentTarget.dataset[datasetKey] : fallbackOverlay || '';
      const overlayPath = targetOverlay ? `music.${section}.overlays.${targetOverlay}` : `music.${section}`;
      const currentData = getProperty(this.document, this.updateDataPrefix) || {};
      const existingTrackId = getProperty(currentData, `${overlayPath}.initialTrack`) || null;
      const initialTrackId = sound ? sound.id : resolveInitialTrack(playlist.id, existingTrackId);
      const updateData = { [`${overlayPath}.playlist`]: playlist.id };
      if (initialTrackId) updateData[`${overlayPath}.initialTrack`] = initialTrackId;
      // Deliberately does NOT seed a priority. The scope's baseline is applied at
      // resolution time now (helpers.mjs#sectionBaselinePriority); writing it here
      // made a dragged binding resolve differently from a visually identical one
      // picked from the dropdown, which stored nothing. A stored priority now means
      // exactly one thing: someone deliberately overrode the hierarchy.
      await this.updateObject(updateData);
      log(3, `Successfully handled external drop: assigned playlist '${playlist.name}' (track: '${initialTrackId || 'none'}') to section '${section}' (overlay: '${targetOverlay || 'default'}')`);
      return true;
    } catch (error) {
      log(1, 'Error handling external drop:', error);
      return false;
    }
  }

  /**
   * Update the document with new data
   * @param {object} data - The data to update
   * @returns {Promise<void>} Resolves when update completes
   */
  async updateObject(data) {
    const expandedData = Object.entries(data).reduce((acc, [key, value]) => {
      acc[`${this.updateDataPrefix}.${key}`] = value;
      return acc;
    }, {});
    // Names the branch taken and the exact keys written. Every silent-write bug
    // this method has had (a preview clone, a bracketed flag path) was invisible
    // precisely because the caller's own "success" log fired regardless.
    log(3, () => `GameOrchestraConfig.updateObject: category=${getDocumentCategory(this.document)} keys=${Object.keys(expandedData).join(', ')}`);
    if (this.isDocument) {
      const result = await this.document.update(expandedData);
      this.render(false);
      return result;
    }
    if (getDocumentCategory(this.document) === 'PrototypeToken') {
      const actor = this.document.parent;
      if (!actor) {
        log(1, 'GameOrchestraConfig.updateObject: PrototypeToken has no parent Actor; nothing was saved');
        return;
      }
      // Plain dot notation, NOT `flags['game-orchestra']`. Foundry expands update
      // keys with foundry.utils.expandObject -> setProperty, which splits on "."
      // and has no bracket syntax at all: the bracketed form produced a literal
      // `flags['game-orchestra']` key on prototypeToken, which the Actor schema
      // then dropped during cleaning. The update resolved successfully and wrote
      // NOTHING - confirmed live, and the reason every prototype-token playlist
      // assignment looked accepted and then came back empty. The module id needs
      // no escaping here; a hyphen is fine in a dot path.
      const prototypeData = Object.entries(data).reduce((acc, [key, value]) => {
        acc[`prototypeToken.flags.${CONST.moduleId}.${key}`] = value;
        return acc;
      }, {});
      const result = await actor.update(prototypeData);
      this.document = actor.prototypeToken;
      this.render(false);
      return result;
    }
    // Falling through used to be a silent no-op - every dropdown pick and every
    // drop looked accepted and saved nothing. If this fires, `this.document` is
    // neither a live Document nor a PrototypeToken (the classic cause: something
    // handed this window a detached preview clone - see hooks.mjs#handleTokenConfigRender).
    log(1, 'GameOrchestraConfig.updateObject: unsupported document type; nothing was saved:', this.document?.constructor?.name);
  }

  /**
   * Handle reset action
   * @param {Event} event - The click event
   * @param {HTMLFormElement} _form - The form element
   */
  static handleReset(event, _form) {
    event.preventDefault();
    this.initializeConfig();
    this.render(false);
  }

  /**
   * Open playlist sheet action
   * @param {Event} _event - The click event
   * @param {HTMLElement} target - The target element
   */
  static async openPlaylist(_event, target) {
    const playlistId = target.closest('.playlist-section').dataset.itemId;
    const playlist = game.playlists.get(playlistId);
    if (playlist) playlist.sheet.render(true);
  }

  /**
   * Delete playlist action
   * @param {Event} _event - The click event
   * @param {HTMLElement} target - The target element
   */
  static async deletePlaylist(_event, target) {
    const section = target.closest('.playlist-section').dataset.section;
    const axis = CONST.sectionAxis[section];
    const overlayId = (axis === 'phase' ? this.selectedPhase : this.selectedMood) || '';
    try {
      if (overlayId) {
        await this.updateObject({ [`music.${section}.overlays.-=${overlayId}`]: null });
        log(3, `Successfully deleted playlist override for ${axis} '${overlayId}', section '${section}'`);
      } else {
        await this.updateObject({ [`music.-=${section}`]: null });
        log(3, `Successfully deleted default playlist configuration override for section '${section}'`);
      }
    } catch (error) {
      log(1, `Failed to delete playlist configuration override for section '${section}':`, error);
    }
  }

  /**
   * Handle form submission
   * @param {Event} _event - The submit event
   * @param {HTMLFormElement} _form - The form element
   * @param {object} formData - The form data
   * @returns {Promise<boolean>} Whether submission succeeded
   * @override
   */
  static async formHandler(_event, _form, formData) {
    const updateData = Object.fromEntries(Object.entries(formData.object).filter(([key]) => key.startsWith('music.')));
    if (Object.keys(updateData).length > 0) {
      // Validate Soundboard playlists: auto-assign the first track when none was
      // picked. resolveInitialTrack() already excludes custom playlists (H2) -
      // a stray trackId would otherwise bypass their graph entirely.
      for (const key of Object.keys(updateData)) {
        if (key.endsWith('.playlist')) {
          const playlistId = updateData[key];
          const trackKey = key.replace(/\.playlist$/, '.initialTrack');
          if (playlistId) {
            const initialTrackId = resolveInitialTrack(playlistId, updateData[trackKey]);
            if (initialTrackId) updateData[trackKey] = initialTrackId;
          }
        }
      }
      try {
        log(3, 'Saving Game Orchestra configuration updates:', updateData);
        await this.updateObject(updateData);
        game.gameOrchestra?.musicController?.playCurrentTrack();
        log(3, 'Successfully saved Game Orchestra configuration updates.');
        this.close();
      } catch (error) {
        log(1, 'Error updating data:', error);
        ui.notifications.error(_loc('GameOrchestra.SaveFailed'));
        return false;
      }
    } else {
      log(3, 'Form submitted with no updates.');
      this.close();
    }
    return true;
  }
}
