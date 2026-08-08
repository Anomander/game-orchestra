import { CONST } from './config.mjs';
import { getDocumentCategory, getProperty, log, getAvailablePlaylists, resolveInitialTrack } from './helpers.mjs';
import { GameOrchestraAppMixin } from './app-mixins.mjs';
import { buildCombatPhaseGrid } from './binding-cards.mjs';
import { coerceDuckFactor } from './playlist-mix.mjs';
import {
  updateObjectStore,
  bindingPath,
  applyBindingPlaylist,
  applyBindingTrack,
  applyBindingDuck,
  applyBindingExclusive,
  clearBindingOverlay
} from './binding-store.mjs';

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
    // No form handler and no Save button. Every control writes immediately through
    // `data-change-action`, as the hub does and as core v13+ sheets do. The old handler only ever
    // harvested the deleted scene form's `initialTrack` selects, so it had nothing left to
    // collect - keeping an inert Save would have promised a commit step that no longer exists.
    form: { closeOnSubmit: false, submitOnChange: false },
    position: { width: 'auto', height: 'auto' },
    actions: {
      clearPhaseEntry: GameOrchestraConfig.handleClearPhaseEntry,
      clearDefaultEntry: GameOrchestraConfig.handleClearDefaultEntry,
      toggleSection: GameOrchestraConfig.handleToggleSection
    },
    // `.context-box[data-drop-scope]` - the same selector the hub uses, now that both render the
    // same partial. It used to be `.playlist-section[data-section]`, which matched TWO unrelated
    // elements (the grid's boxes and the deleted scene form's wrapper) and was the stated blocker
    // on sharing this markup at all (docs/wiki/ux.md § Why the markup merge stopped there).
    dragDrop: [{ dragSelector: null, dropSelector: '.context-box[data-drop-scope]', permissions: { dragstart: false, drop: true }, callbacks: {} }]
  };

  /** @override */
  static PARTS = { form: { template: 'modules/game-orchestra/templates/music-config.hbs' } };

  /**
   * Create a new configuration instance
   * @param {Scene|TokenDocument|PrototypeToken} object The Scene or Token/PrototypeToken document to configure
   * @param {object} [options] Additional application options
   */
  constructor(object, options = {}) {
    super(options);
    this.document = object;
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
   * This window's handler names, for the shared `combat-grid.hbs` partial. The hub's counterpart
   * is `PlaylistTreeApp._ACTOR_ACTIONS` - same markup, different handlers, so the names travel in
   * the view model rather than being hard-coded in a template that two windows share.
   */
  static _GRID_ACTIONS = Object.freeze({
    overlay: 'updatePhaseEntry',
    overlayTrack: 'updatePhaseTrack',
    clearOverlay: 'clearPhaseEntry',
    default: 'updateDefaultEntry',
    defaultTrack: 'updateDefaultTrack',
    clearDefault: 'clearDefaultEntry',
    exclusive: 'toggleExclusive',
    duck: 'updateDuck'
  });

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
      // Through the binding ops, not a hand-built deletion key. These two handlers were the last
      // binding writes in the module bypassing binding-store.mjs, which is precisely the shape
      // that let three copies of this logic drift apart before it existed (D1).
      await applyBindingDuck(this.bindingStore, bindingPath('combat', null), factor);
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
      await applyBindingExclusive(this.bindingStore, bindingPath('combat', null), !!checkbox.checked);
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

  /** @override */
  _prepareContext(_options) {
    const activeWorldPhase = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const docData = getProperty(this.document, this.updateDataPrefix) || {};

    const context = {
      documentType: this.documentTypeName,
      isTokenPhaseGrid: this.isTokenPhaseGrid
    };
    if (this.isTokenPhaseGrid) Object.assign(context, this._preparePhaseGridContext(docData, configuredPhases, activeWorldPhase));
    else log(1, `GameOrchestraConfig: no music sections for document type '${this.documentTypeName}'`);
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

    const currentControllerContext = game.gameOrchestra?.musicController?.currentContext || null;
    const isWinner = currentControllerContext?.contextEntity === this.document;
    const winnerIsPhaseOverlay = !!(currentControllerContext?.isOverlay && currentControllerContext?.overlayAxis === 'phase');

    // One builder, shared with the hub's Actors group (binding-cards.mjs). Building this shape
    // twice is exactly how the two binding surfaces drifted apart in the first place (D1).
    const grid = buildCombatPhaseGrid({
      combatSection: docData.music?.combat,
      configuredPhases,
      availablePlaylists,
      activePhase: activeWorldPhase,
      keyPrefix: 'tokenPhase',
      isCollapsed: (key, hasOverride) => this.isSectionCollapsed(key, hasOverride),
      isWinner,
      winnerIsPhaseOverlay,
      dropScope: 'token',
      actions: GameOrchestraConfig._GRID_ACTIONS
    });

    // `availablePlaylists` comes back out of the grid rather than being re-added here. This
    // window used to add its own copy, so it rendered correctly while the hub's actor rows - which
    // only spread the grid - showed two empty pickers. One source, no second chance to forget.
    return {
      ...grid,
      phasesKey: 'tokenPhases',
      defaultKey: 'tokenDefault',
      phasesCollapsed: this.isSectionCollapsed('tokenPhases', grid.hasPhasesOverride),
      defaultCollapsed: this.isSectionCollapsed('tokenDefault', grid.hasDefaultOverride)
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

}
