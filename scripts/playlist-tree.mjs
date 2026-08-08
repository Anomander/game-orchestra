import { CONST } from './config.mjs';
import { log, getAvailablePlaylists, buildPlaylistEntry, listBoundActors, readMusicSection } from './helpers.mjs';
import { buildCombatPhaseGrid } from './binding-cards.mjs';
import {
  documentFlagStore,
  globalSettingStore,
  storeForTarget,
  bindingPath,
  applyBindingPlaylist,
  applyBindingTrack,
  applyBindingLayer,
  applyBindingDuck,
  applyBindingExclusive,
  clearBindingOverlay
} from './binding-store.mjs';
import { coerceDuckFactor } from './playlist-mix.mjs';
import { MoodConfigApp } from './mood-config.mjs';
import { CustomPlaylistEditor } from './custom-playlist-editor.mjs';
import { PlaylistMixerApp } from './playlist-mixer.mjs';
import { GameOrchestraAppMixin } from './app-mixins.mjs';
import { resolutionPills, describeResolution, localizeResolutionSource, isBindingEligible } from './transport.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DragDrop } = foundry.applications.ux;

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
    // Two kinds of drop target in one selector: a binding box takes a Playlist/PlaylistSound, and
    // the Actors zone takes an Actor. _onDropExternal branches on the payload type, so a wrong
    // pairing (an Actor onto a binding box) is refused rather than half-applied.
    dragDrop: [{
      dragSelector: null,
      dropSelector: '.context-box[data-drop-scope], .actor-add-zone',
      permissions: { dragstart: false, drop: true },
      callbacks: {}
    }],
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
      clearActorOverlay: PlaylistTreeApp.handleClearActorOverlay,
      clearActorDefault: PlaylistTreeApp.handleClearActorDefault,
      unpinActor: PlaylistTreeApp.handleUnpinActor,
      openOverlayConfig: PlaylistTreeApp.handleOpenOverlayConfig,
      openCustomGraph: PlaylistTreeApp.handleOpenCustomGraph,
      openMixer: PlaylistTreeApp.handleOpenMixer,
      toggleSection: PlaylistTreeApp.handleToggleSection
    }
  };

  /** @override */
  static PARTS = { main: { template: 'modules/game-orchestra/templates/playlist-tree.hbs' } };

  /**
   * Handler names the shared `combat-grid.hbs` partial writes into its own markup.
   *
   * Carried in the view model rather than passed as partial hash params: the markup is identical
   * between this window and `GameOrchestraConfig` and only the handler names differ, so one
   * object built here beats eight `{{> partial a=… b=…}}` arguments at the include site.
   * Every name must exist in `_ENTRY_SPECS` (actions) or `_CHANGE_ACTIONS` (change events), or
   * the control renders perfectly and does nothing.
   */
  static _ACTOR_ACTIONS = Object.freeze({
    overlay: 'updateActorOverlay',
    overlayTrack: 'updateActorOverlayTrack',
    clearOverlay: 'clearActorOverlay',
    default: 'updateActorDefault',
    defaultTrack: 'updateActorDefaultTrack',
    clearDefault: 'clearActorDefault',
    exclusive: 'updateActorExclusive',
    duck: 'updateActorDuck'
  });

  constructor(options = {}) {
    super(options);
    const activeSceneId = game.scenes?.active?.id || '';
    // Scoped mode (docs/wiki/ux.md UX-3): the same component, narrowed to one
    // document. A Scene sheet's music button opens this window pinned to that
    // scene with the picker and the global sections hidden - it is not a second
    // window with a second layout, which is exactly what D1 was about.
    this.scopedSceneId = options.scopedSceneId || null;
    // The other half of scoped mode: a Token/PrototypeToken/Actor sheet pins its own document
    // here. Held as the document rather than an id because it may be a PrototypeToken, which
    // lives on its parent Actor and is not in any collection to look up by id later.
    this.scopedDocument = options.scopedDocument || null;
    this.selectedSceneId = this.scopedSceneId || options.selectedSceneId || activeSceneId || 'global';
    this.expandedSections = new Set(options.expandedSections || []);
    this.collapsedSections = new Set(options.collapsedSections || []);
    /**
     * Actors shown despite having nothing bound yet - the ones just dragged in.
     *
     * In memory and per-instance, exactly like `expandedSections`: an actor pinned but never
     * bound is a half-finished gesture, not a preference, and it should not outlive the window.
     * Once something IS bound, `listBoundActors()` finds the actor on its own and the pin stops
     * mattering.
     * @type {Set<string>}
     */
    this.pinnedActorIds = new Set(options.pinnedActorIds || []);
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
    /**
     * One context box's view model.
     *
     * `isLayer`/`duck` are the overlay-only half: an overlay entry marked `layer` plays *over*
     * its section's base music instead of replacing it, and `duck` is how far everything else is
     * attenuated while it does (architecture.md § Layers). A section default is never a layer -
     * it is the thing layers play over - so those stay absent there rather than rendering an
     * inert control.
     *
     * Priority is deliberately not here, and no longer anywhere on any surface. It is still
     * stored and still honoured at resolution time - it is simply not something a GM types. See
     * ux.md D8 for why the number was the wrong interface even when it was the only thing behind
     * `Advanced`.
     */
    const buildEntry = (playlistId, trackId, overlay = null) => ({
      ...buildPlaylistEntry(availablePlaylists, playlistId, trackId),
      isLayer: overlay?.layer === true,
      duck: coerceDuckFactor(overlay?.duck),
      duckPercent: Math.round(coerceDuckFactor(overlay?.duck) * 100),
      // Set by decorate() below once the winner is known - a row can only be called
      // "beaten" after resolution has actually run.
      beatenBy: null,
      // Set below from the controller's live layers: a layering overlay never wins the base
      // resolution, so `is-resolving` can never light up for it and UX-7 would otherwise have
      // nothing at all to say about a row that is audibly playing.
      isLayerActive: false
    });

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
      const areaOverlay = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.area.overlays.${m.id}`) || null : null;
      const areaPlId = areaOverlay?.playlist || null;
      const areaTrId = areaOverlay?.initialTrack || null;
      const hasOverride = !!areaPlId;
      const isResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'mood' && activeMood === m.id;
      const cardKey = `sceneMood:${m.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        moodId: m.id,
        label: m.label,
        icon: m.icon,
        color: m.color,
        area: buildEntry(areaPlId, areaTrId, areaOverlay),
        isActive: activeMood === m.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey,
        advancedKey: `${cardKey}:advanced`,
        // A native <details> keeps its open state in the DOM alone, and every write in this
        // window re-renders the part that holds it - so the state has to be mirrored here or
        // the disclosure slams shut the moment anything inside it is used.
        advancedOpen: this.openDisclosures.has(`${cardKey}:advanced`)
      };
    });

    const scenePhases = configuredPhases.map((p) => {
      const combatOverlay = selectedScene ? selectedScene.getFlag(CONST.moduleId, `music.combat.overlays.${p.id}`) || null : null;
      const combatPlId = combatOverlay?.playlist || null;
      const combatTrId = combatOverlay?.initialTrack || null;
      const hasOverride = !!combatPlId;
      const isResolving = winningEntity === selectedScene && winningIsOverlay && winningOverlayAxis === 'phase' && activePhase === p.id;
      const cardKey = `scenePhase:${p.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        phaseId: p.id,
        label: p.label,
        icon: p.icon,
        color: p.color,
        combat: buildEntry(combatPlId, combatTrId, combatOverlay),
        isActive: activePhase === p.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey,
        advancedKey: `${cardKey}:advanced`,
        // A native <details> keeps its open state in the DOM alone, and every write in this
        // window re-renders the part that holds it - so the state has to be mirrored here or
        // the disclosure slams shut the moment anything inside it is used.
        advancedOpen: this.openDisclosures.has(`${cardKey}:advanced`)
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
      const areaOverlay = defaultData.area?.overlays?.[m.id] || null;
      const areaPlId = areaOverlay?.playlist || null;
      const areaTrId = areaOverlay?.initialTrack || null;
      const hasOverride = !!areaPlId;
      const isResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'mood' && activeMood === m.id;
      const cardKey = `globalMood:${m.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        moodId: m.id,
        label: m.label,
        icon: m.icon,
        color: m.color,
        area: buildEntry(areaPlId, areaTrId, areaOverlay),
        isActive: activeMood === m.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey,
        advancedKey: `${cardKey}:advanced`,
        // A native <details> keeps its open state in the DOM alone, and every write in this
        // window re-renders the part that holds it - so the state has to be mirrored here or
        // the disclosure slams shut the moment anything inside it is used.
        advancedOpen: this.openDisclosures.has(`${cardKey}:advanced`)
      };
    });

    const globalPhases = configuredPhases.map((p) => {
      const combatOverlay = defaultData.combat?.overlays?.[p.id] || null;
      const combatPlId = combatOverlay?.playlist || null;
      const combatTrId = combatOverlay?.initialTrack || null;
      const hasOverride = !!combatPlId;
      const isResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'phase' && activePhase === p.id;
      const cardKey = `globalPhase:${p.id}`;
      const isCardCollapsed = this.isSectionCollapsed(cardKey, hasOverride);

      return {
        phaseId: p.id,
        label: p.label,
        icon: p.icon,
        color: p.color,
        combat: buildEntry(combatPlId, combatTrId, combatOverlay),
        isActive: activePhase === p.id,
        isResolving,
        hasOverride,
        isCardCollapsed,
        cardKey,
        advancedKey: `${cardKey}:advanced`,
        // A native <details> keeps its open state in the DOM alone, and every write in this
        // window re-renders the part that holds it - so the state has to be mirrored here or
        // the disclosure slams shut the moment anything inside it is used.
        advancedOpen: this.openDisclosures.has(`${cardKey}:advanced`)
      };
    });

    const globalDefaults = {
      area: buildEntry(defaultData.area?.playlist || null, defaultData.area?.initialTrack || null),
      combat: buildEntry(defaultData.combat?.playlist || null, defaultData.combat?.initialTrack || null)
    };

    const globalMoodsResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'mood';
    const globalPhasesResolving = winningEntity?.documentName === 'DefaultMusic' && winningIsOverlay && winningOverlayAxis === 'phase';
    const globalDefaultsResolving = winningEntity?.documentName === 'DefaultMusic' && !winningIsOverlay;

    // ------------------------------------------------------------------ actors
    // Bound actors, plus any pinned this session, plus - in a scoped popout - the one document
    // that popout is about (which may be a TokenDocument or a PrototypeToken, not an Actor).
    //
    // Combat only: CONST.playlistSections.Token has no `area` entry, so an actor has one section
    // and one axis. Rendering a mood grid here would be four inert cards.
    const actorDocuments = this.scopedDocument
      ? [this.scopedDocument]
      : (() => {
        const bound = listBoundActors();
        const seen = new Set(bound.map((a) => a.id));
        const pinned = [...this.pinnedActorIds]
          .filter((id) => !seen.has(id))
          .map((id) => game.actors?.get(id))
          .filter(Boolean);
        return [...bound, ...pinned];
      })();

    const actors = actorDocuments.map((actor) => {
      const combatSection = readMusicSection(actor, 'combat') || {};
      const isWinner = winningEntity === actor;
      const grid = buildCombatPhaseGrid({
        combatSection,
        configuredPhases,
        availablePlaylists,
        activePhase,
        // Namespaced per actor: several rows render at once, and a shared prefix would make all
        // of them collapse and expand together.
        keyPrefix: `actorPhase:${actor.id}`,
        isCollapsed: (key, hasOverride) => this.isSectionCollapsed(key, hasOverride),
        isWinner,
        winnerIsPhaseOverlay: winningIsOverlay && winningOverlayAxis === 'phase',
        dropScope: 'actor',
        actions: PlaylistTreeApp._ACTOR_ACTIONS
      });
      const hasOverride = grid.hasAnyCombatPlaylist;
      const rowKey = `actor:${actor.id}`;

      return {
        actorId: actor.id,
        name: actor.name,
        img: actor.img || actor.prototypeToken?.texture?.src || null,
        ...grid,
        hasOverride,
        // Nothing bound and nothing to clear - so this row can only be removed by unpinning it.
        isPinnedOnly: !hasOverride,
        isResolving: isWinner,
        rowKey,
        isRowCollapsed: this.isSectionCollapsed(rowKey, isWinner || hasOverride),
        phasesKey: `${rowKey}:phases`,
        defaultKey: `${rowKey}:default`,
        phasesCollapsed: this.isSectionCollapsed(`${rowKey}:phases`, grid.hasPhasesOverride),
        defaultCollapsed: this.isSectionCollapsed(`${rowKey}:default`, grid.hasDefaultOverride)
      };
    });

    const actorsGroupResolving = actors.some((a) => a.isResolving);
    const hasActorsOverride = actors.length > 0;

    // Both status pills come from the shared transport builder, so this window and
    // the Mood Widget state the winning context in the same sentence rather than two
    // similar ones (docs/wiki/ux.md UX-2/UX-7, transport.mjs).
    const { active: activeResolutionInfo, layers: layerResolutionInfos } = resolutionPills(selectedScene);

    // Which overlay rows are audibly playing as layers right now. A layering overlay never wins
    // the base resolution, so the `is-resolving` badge it would otherwise earn can never light up
    // for it - without this a row that is genuinely playing would show nothing at all (UX-7).
    const liveLayers = game.gameOrchestra?.musicController?.currentLayerContexts || [];
    const markLiveLayers = (cards, section, idKey, entryKey, matches) => {
      for (const card of cards) {
        card[entryKey].isLayerActive = liveLayers.some((ctx) =>
          ctx.isLayer && ctx.context === section && ctx.overlayId === card[idKey] && matches(ctx));
      }
    };
    const fromScene = (ctx) => !!selectedScene && ctx.contextEntity === selectedScene;
    const fromGlobal = (ctx) => ctx.contextEntity?.documentName === 'DefaultMusic';
    markLiveLayers(sceneMoods, 'area', 'moodId', 'area', fromScene);
    markLiveLayers(scenePhases, 'combat', 'phaseId', 'combat', fromScene);
    markLiveLayers(globalMoods, 'area', 'moodId', 'area', fromGlobal);
    markLiveLayers(globalPhases, 'combat', 'phaseId', 'combat', fromGlobal);

    // "Beaten by X" on the rows that actually lost - the answer a GM needs when the
    // music is not what they configured, and the thing a raw priority number never
    // told them (UX-7: show the resolution, not just the assignment).
    //
    // Only rows that were genuinely IN the contest are labelled. A mood row for a
    // mood that isn't live, or an area row during combat, did not lose - it does not
    // currently apply, and calling that "beaten" would teach the wrong model.
    const inCombat = !!game.combats?.active?.started;
    const winnerSource = localizeResolutionSource(describeResolution({
      context: currentControllerContext,
      referenceScene: selectedScene,
      activeMood,
      activePhase
    }));
    // Whether the winning context came from this row's scope. Identity works for the
    // scene (it is the same live document); the world default is a synthetic
    // pseudo-document rebuilt on every read, so it has to be matched by documentName.
    const winnerIsScene = currentControllerContext?.contextEntity === selectedScene && !!selectedScene;
    const winnerIsGlobal = currentControllerContext?.contextEntity?.documentName === 'DefaultMusic';
    const decorateLoser = (entry, { section, overlayId, scope, activeOverlayConfigured }) => {
      if (!entry?.playlistId || !currentControllerContext || !winnerSource) return entry;
      // A layer was never in the contest and cannot lose one: it plays alongside the winner by
      // construction, so "beaten by" would be a flat lie about a row that is currently audible.
      if (entry.isLayer) return entry;
      if (scope === 'scene' ? winnerIsScene : winnerIsGlobal) return entry;
      const activeOverlayId = section === 'combat' ? activePhase : activeMood;
      if (!isBindingEligible({ section, overlayId, activeOverlayId, inCombat, activeOverlayConfigured })) return entry;
      entry.beatenBy = winnerSource;
      return entry;
    };
    // "Configured" here means "replaces the section", which is what decides whether the section
    // default is still in the running. A layering overlay plays *over* the default rather than
    // instead of it, so it leaves the default fully eligible.
    const replaces = (entry) => !!entry?.playlistId && !entry.isLayer;
    const activeSceneMoodConfigured = replaces(sceneMoods.find((m) => m.moodId === activeMood)?.area);
    const activeScenePhaseConfigured = replaces(scenePhases.find((p) => p.phaseId === activePhase)?.combat);
    const activeGlobalMoodConfigured = replaces(globalMoods.find((m) => m.moodId === activeMood)?.area);
    const activeGlobalPhaseConfigured = replaces(globalPhases.find((p) => p.phaseId === activePhase)?.combat);

    for (const card of sceneMoods) decorateLoser(card.area, { section: 'area', overlayId: card.moodId, scope: 'scene' });
    for (const card of scenePhases) decorateLoser(card.combat, { section: 'combat', overlayId: card.phaseId, scope: 'scene' });
    decorateLoser(sceneDefaults.area, { section: 'area', overlayId: null, scope: 'scene', activeOverlayConfigured: activeSceneMoodConfigured });
    decorateLoser(sceneDefaults.combat, { section: 'combat', overlayId: null, scope: 'scene', activeOverlayConfigured: activeScenePhaseConfigured });
    for (const card of globalMoods) decorateLoser(card.area, { section: 'area', overlayId: card.moodId, scope: 'global' });
    for (const card of globalPhases) decorateLoser(card.combat, { section: 'combat', overlayId: card.phaseId, scope: 'global' });
    decorateLoser(globalDefaults.area, { section: 'area', overlayId: null, scope: 'global', activeOverlayConfigured: activeGlobalMoodConfigured });
    decorateLoser(globalDefaults.combat, { section: 'combat', overlayId: null, scope: 'global', activeOverlayConfigured: activeGlobalPhaseConfigured });

    const hasSceneMoodsOverride = sceneMoods.some((m) => m.hasOverride);
    const hasScenePhasesOverride = scenePhases.some((p) => p.hasOverride);
    const hasSceneDefaultsOverride = !!(sceneDefaults.area.playlistId || sceneDefaults.combat.playlistId);
    const hasGlobalMoodsOverride = globalMoods.some((m) => m.hasOverride);
    const hasGlobalPhasesOverride = globalPhases.some((p) => p.hasOverride);
    const hasGlobalDefaultsOverride = !!(globalDefaults.area.playlistId || globalDefaults.combat.playlistId);

    // The three top-level groups. A group is "resolving" when the winning context - or a live
    // layer - came from any scope inside it, so the badge and the open-by-default rule below
    // agree with each other by construction.
    const scenesGroupResolving = sceneMoodsResolving || scenePhasesResolving || sceneDefaultsResolving
      || liveLayers.some(fromScene);
    const worldGroupResolving = globalMoodsResolving || globalPhasesResolving || globalDefaultsResolving
      || liveLayers.some(fromGlobal);

    const hasScenesOverride = hasSceneMoodsOverride || hasScenePhasesOverride || hasSceneDefaultsOverride;
    const hasWorldOverride = hasGlobalMoodsOverride || hasGlobalPhasesOverride || hasGlobalDefaultsOverride;

    const anyGroupResolving = actorsGroupResolving || scenesGroupResolving || worldGroupResolving;
    /**
     * What a group opens on by default: **what is audible**, not what is merely configured.
     *
     * The six sections have always defaulted to open on `hasOverride`, and that is right for a
     * section - but applying it a level up means a configured world renders every group open,
     * which is the wall this grouping exists to remove. So the audible group opens and the rest
     * stay shut.
     *
     * The fallback matters as much as the rule: during prep there is often nothing playing at
     * all, and three closed headers would be a worse hub than the flat list was. With no group
     * resolving anywhere, every group holding a binding opens - i.e. exactly the old behaviour,
     * which is the correct answer when "what is playing" has no answer.
     *
     * Manual toggles still win over both, via isSectionCollapsed's expanded/collapsed Sets.
     * @param {boolean} isResolvingHere - Something inside this group is currently audible
     * @param {boolean} hasOverride - This group holds at least one binding
     * @returns {boolean} True when the group should render open
     */
    const groupOpen = (isResolvingHere, hasOverride) => isResolvingHere || (!anyGroupResolving && hasOverride);

    const collapsed = {
      groupActors: this.isSectionCollapsed('groupActors', groupOpen(actorsGroupResolving, hasActorsOverride)),
      groupScenes: this.isSectionCollapsed('groupScenes', groupOpen(scenesGroupResolving, hasScenesOverride)),
      groupWorld: this.isSectionCollapsed('groupWorld', groupOpen(worldGroupResolving, hasWorldOverride)),
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
      // Scoped to one scene: the picker and the global sections are hidden, since
      // neither is this document's business. Everything else renders identically -
      // same cards, same handlers, same immediate writes (UX-3).
      isScoped: !!this.scopedSceneId || !!this.scopedDocument,
      // Which half a scoped popout is showing. A Scene sheet pins a scene and wants the scene
      // sections; a Token/Actor sheet pins a document and wants the actor row. Neither wants the
      // other's, and neither wants the world defaults.
      isSceneScoped: !!this.scopedSceneId,
      isDocumentScoped: !!this.scopedDocument,
      availablePlaylists,
      actors,
      actorsGroupResolving,
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
      scenesGroupResolving,
      worldGroupResolving,
      activeResolutionInfo,
      layerResolutionInfos,
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
    const box = event.target.closest?.('.context-box[data-drop-scope], .actor-add-zone');
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
   * Handle dropping a Playlist or PlaylistSound from the sidebar onto an Area/Combat context box,
   * or an Actor onto the Actors group's zone.
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
      if (data.type === 'Actor') return this._onDropActor(data, target);
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
      // A binding drop needs a real scope on the element it landed on. Without this guard an
      // element that is a drop target for something else - the Actors zone - falls through to
      // `global` with contextType defaulting to 'area', so a playlist dropped a few pixels off
      // silently rewrites the WORLD DEFAULT area music. Caught by test, not in the wild.
      if (!['scene', 'actor', 'global'].includes(dropScope)) {
        log(2, `Ignoring playlist drop on an element with no binding scope ('${dropScope}')`);
        return false;
      }
      const axis = CONST.sectionAxis[contextType];
      const overlayId = (axis === 'phase' ? phaseId : moodId) || null;
      const path = bindingPath(contextType, overlayId);

      const bindTarget = PlaylistTreeApp._targetFor(dropScope, this, target);
      if (dropScope !== 'global' && !bindTarget) return false;
      const scope = dropScope;
      await applyBindingPlaylist(PlaylistTreeApp._storeFor(scope, bindTarget), path, playlist.id, sound?.id);

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

  /**
   * Handle an Actor dropped onto the Actors group's zone - how an actor with no binding yet gets
   * a row to bind in.
   *
   * Refused anywhere but that zone: dropping an Actor onto a *binding* box is asking for a
   * playlist to be an actor, which has no sensible reading, so it is rejected rather than
   * quietly interpreted as something else.
   * @param {{uuid?: string, id?: string}} data - The parsed drag payload
   * @param {HTMLElement} target - The element the drop landed on
   * @returns {Promise<boolean>}
   * @private
   */
  async _onDropActor(data, target) {
    // Identified by its dataset rather than its class, matching how every other branch of this
    // handler reads its target - and unambiguous, since only the zone carries it.
    if (target?.dataset?.dropZone !== 'actors') return false;
    const actor = data.uuid ? await fromUuid(data.uuid) : game.actors?.get(data.id);
    if (!actor?.id) {
      log(2, `Failed to handle actor drop: no Actor for '${data.uuid || data.id}'`);
      return false;
    }
    this.pinnedActorIds.add(actor.id);
    // No playCurrentTrack() here, unlike every other drop: pinning binds nothing, so there is
    // nothing for resolution to reconsider.
    this.render(false);
    log(3, `Pinned actor '${actor.name}' into the hub's Actors group`);
    return true;
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
    updateSceneOverlayLayer: 'handleUpdateSceneOverlayLayer',
    updateSceneOverlayDuck: 'handleUpdateSceneOverlayDuck',
    updateSceneDefault: 'handleUpdateSceneDefault',
    updateSceneDefaultTrack: 'handleUpdateSceneDefaultTrack',
    updateGlobalOverlay: 'handleUpdateGlobalOverlay',
    updateGlobalOverlayTrack: 'handleUpdateGlobalOverlayTrack',
    updateGlobalOverlayLayer: 'handleUpdateGlobalOverlayLayer',
    updateGlobalOverlayDuck: 'handleUpdateGlobalOverlayDuck',
    updateGlobalDefault: 'handleUpdateGlobalDefault',
    updateGlobalDefaultTrack: 'handleUpdateGlobalDefaultTrack',
    updateActorOverlay: 'handleUpdateActorOverlay',
    updateActorOverlayTrack: 'handleUpdateActorOverlayTrack',
    updateActorDefault: 'handleUpdateActorDefault',
    updateActorDefaultTrack: 'handleUpdateActorDefaultTrack',
    updateActorExclusive: 'handleUpdateActorExclusive',
    updateActorDuck: 'handleUpdateActorDuck'
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
   * The BindingStore for one scope - a Scene's flags, an Actor's flags, or the global
   * defaultMusic setting. Everything a write then does with it lives in binding-store.mjs and is
   * shared with GameOrchestraConfig (docs/wiki/ux.md UX-2); this window only decides *which*
   * backend a given row belongs to.
   *
   * The actor branch goes through `storeForTarget` rather than calling `documentFlagStore`
   * directly, because a scoped popout hands this the document its host sheet is about - which may
   * be a TokenDocument or a PrototypeToken, and the prototype-token write path is the one that
   * fails silently when it is written out a second time (HR-J).
   * @param {'scene'|'actor'|'global'} scope
   * @param {Scene|Actor|TokenDocument|PrototypeToken|null} document
   * @returns {import('./binding-store.mjs').BindingStore}
   * @private
   */
  static _storeFor(scope, document) {
    if (scope === 'scene') return documentFlagStore(document);
    if (scope === 'actor') return storeForTarget(document);
    return globalSettingStore();
  }

  /**
   * Resolve the document a row's write should land on.
   *
   * Scene and global rows read their target from **instance state** - one scene is selected at a
   * time, and the world default is a singleton. An actor row cannot: the Actors group shows
   * several at once, so the target has to come off the **element** that fired. Getting this wrong
   * writes every actor's binding onto whichever actor happened to be first.
   * @param {'scene'|'actor'|'global'} scope
   * @param {PlaylistTreeApp|null} instance
   * @param {HTMLElement} element - The control that dispatched, or the drop target
   * @returns {object|null} The document, or null when the scope needs one and it cannot be found
   * @private
   */
  static _targetFor(scope, instance, element) {
    if (scope === 'scene') return game.scenes?.get(instance?.selectedSceneId) || null;
    if (scope !== 'actor') return null;
    // A scoped popout pins one document and renders no actor id - it may not even be an Actor
    // (a TokenConfig scopes to its TokenDocument). Prefer that pin over any dataset lookup.
    if (instance?.scopedDocument) return instance.scopedDocument;
    const actorId = element?.closest?.('[data-actor-id]')?.dataset?.actorId;
    return (actorId && game.actors?.get(actorId)) || null;
  }

  /**
   * Descriptor table for the update/clear handlers below - each one differs only along three
   * axes: scope (scene, actor or global), field (playlist, track, layer, duck or exclusive), and
   * whether the entry is overlay-scoped (a mood or phase id, whichever the card's own section
   * implies - config.mjs#sectionAxis) or the section's plain default, plus whether the action
   * clears rather than updates. Every handler stays a real named static method (rather than
   * existing only as a table entry) since DEFAULT_OPTIONS.actions and _CHANGE_ACTIONS both
   * reference them by name/identity.
   *
   * Three fields are scope-shaped rather than universal, and the asymmetry is the model's, not an
   * oversight (architecture.md § Layers):
   *
   * - `layer`/`duck` on an OVERLAY row only. A section default is what a layer plays *over*, so
   *   the pair would be inert there.
   * - `exclusive`/`duck` on an ACTOR row only, and at SECTION level. One flag governs whichever
   *   playlist the section resolves to for any phase, and it means nothing on a scene or the
   *   world default - neither of those is ever a combatant.
   */
  static _ENTRY_SPECS = {
    updateSceneOverlay: { scope: 'scene', field: 'playlist', overlay: true, clear: false },
    updateSceneOverlayTrack: { scope: 'scene', field: 'track', overlay: true, clear: false },
    updateSceneOverlayLayer: { scope: 'scene', field: 'layer', overlay: true, clear: false },
    updateSceneOverlayDuck: { scope: 'scene', field: 'duck', overlay: true, clear: false },
    clearSceneOverlay: { scope: 'scene', field: 'playlist', overlay: true, clear: true },
    updateSceneDefault: { scope: 'scene', field: 'playlist', overlay: false, clear: false },
    updateSceneDefaultTrack: { scope: 'scene', field: 'track', overlay: false, clear: false },
    clearSceneDefault: { scope: 'scene', field: 'playlist', overlay: false, clear: true },
    updateGlobalOverlay: { scope: 'global', field: 'playlist', overlay: true, clear: false },
    updateGlobalOverlayTrack: { scope: 'global', field: 'track', overlay: true, clear: false },
    updateGlobalOverlayLayer: { scope: 'global', field: 'layer', overlay: true, clear: false },
    updateGlobalOverlayDuck: { scope: 'global', field: 'duck', overlay: true, clear: false },
    clearGlobalOverlay: { scope: 'global', field: 'playlist', overlay: true, clear: true },
    updateGlobalDefault: { scope: 'global', field: 'playlist', overlay: false, clear: false },
    updateGlobalDefaultTrack: { scope: 'global', field: 'track', overlay: false, clear: false },
    clearGlobalDefault: { scope: 'global', field: 'playlist', overlay: false, clear: true },
    updateActorOverlay: { scope: 'actor', field: 'playlist', overlay: true, clear: false },
    updateActorOverlayTrack: { scope: 'actor', field: 'track', overlay: true, clear: false },
    clearActorOverlay: { scope: 'actor', field: 'playlist', overlay: true, clear: true },
    updateActorDefault: { scope: 'actor', field: 'playlist', overlay: false, clear: false },
    updateActorDefaultTrack: { scope: 'actor', field: 'track', overlay: false, clear: false },
    clearActorDefault: { scope: 'actor', field: 'playlist', overlay: false, clear: true },
    updateActorExclusive: { scope: 'actor', field: 'exclusive', overlay: false, clear: false },
    updateActorDuck: { scope: 'actor', field: 'duck', overlay: false, clear: false }
  };

  /**
   * Shared implementation for every handleUpdate.../handleClear... method below.
   * Resolves the dispatching element (a <select> for an update, a button for
   * a clear - both always carry their own data-mood-id/data-phase-id/
   * data-context-type, so one combined selector covers both without needing
   * to know which fired), derives the section path and value per `spec`
   * (which overlay-id dataset key applies is decided by the context type's
   * own axis - config.mjs#sectionAxis), applies it via the matching
   * binding-store operation, then re-triggers playback and a re-render.
   * @param {{scope: 'scene'|'actor'|'global', field: 'playlist'|'track'|'layer'|'duck'|'exclusive', overlay: boolean, clear: boolean}} spec
   * @param {string} actionName - Key into _ENTRY_SPECS, for the error log only.
   * @param {Event} event
   * @param {HTMLElement} target
   * @private
   */
  static async _handleEntryAction(spec, actionName, event, target) {
    event?.preventDefault?.();
    const el = target.closest('select, input, [data-mood-id], [data-phase-id], [data-context-type]') || target;
    const contextType = el.dataset.contextType || 'area';
    const axis = CONST.sectionAxis[contextType];
    const overlayId = spec.overlay ? (axis === 'phase' ? el.dataset.phaseId : el.dataset.moodId) : null;
    const raw = spec.clear ? null : el.value || null;
    const path = bindingPath(contextType, overlayId);

    const instance = PlaylistTreeApp._resolveInstance(this);
    // `target`, not `el`: the actor id lives on the row wrapper, and `el` may be a <select> that
    // sits inside it either way - but resolving from the element the event actually reached is
    // the version that stays right if the markup nests differently later.
    const document = PlaylistTreeApp._targetFor(spec.scope, instance, target);
    if (spec.scope !== 'global' && !document) return;
    const store = PlaylistTreeApp._storeFor(spec.scope, document);

    try {
      if (spec.field === 'layer') await applyBindingLayer(store, path, !!el.checked);
      else if (spec.field === 'exclusive') await applyBindingExclusive(store, path, !!el.checked);
      // A blank value is 1 (no ducking), NOT coerceDuckFactor's answer for it: `Number(null)` and
      // `Number('')` are both 0, so handing a missing slider value straight through would silence
      // everything but the layer.
      else if (spec.field === 'duck') await applyBindingDuck(store, path, raw === null ? 1 : coerceDuckFactor(raw));
      else if (spec.field === 'track') await applyBindingTrack(store, path, raw);
      // Emptying an OVERLAY row removes the whole `overlays.<id>` entry rather than blanking its
      // fields, so `layer`/`duck` cannot linger and silently re-apply to whatever is bound next -
      // see clearBindingOverlay. A section-level clear deliberately keeps its own flags standing.
      else if (spec.overlay && raw === null) await clearBindingOverlay(store, contextType, overlayId);
      else await applyBindingPlaylist(store, path, raw);
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

  /** Handle toggling whether a scene overlay plays as a layer over its section's base music */
  static async handleUpdateSceneOverlayLayer(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneOverlayLayer, 'updateSceneOverlayLayer', event, target);
  }

  /** Handle updating a scene overlay layer's duck */
  static async handleUpdateSceneOverlayDuck(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateSceneOverlayDuck, 'updateSceneOverlayDuck', event, target);
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

  /** Handle toggling whether a global overlay plays as a layer over its section's base music */
  static async handleUpdateGlobalOverlayLayer(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalOverlayLayer, 'updateGlobalOverlayLayer', event, target);
  }

  /** Handle updating a global overlay layer's duck */
  static async handleUpdateGlobalOverlayDuck(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateGlobalOverlayDuck, 'updateGlobalOverlayDuck', event, target);
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

  /** Handle updating an actor's phase-overlay playlist (combat only - an actor has no area section) */
  static async handleUpdateActorOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorOverlay, 'updateActorOverlay', event, target);
  }

  /** Handle updating an actor's phase-overlay track */
  static async handleUpdateActorOverlayTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorOverlayTrack, 'updateActorOverlayTrack', event, target);
  }

  /** Handle clearing an actor's phase-overlay override */
  static async handleClearActorOverlay(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearActorOverlay, 'clearActorOverlay', event, target);
  }

  /** Handle updating an actor's combat default playlist */
  static async handleUpdateActorDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorDefault, 'updateActorDefault', event, target);
  }

  /** Handle updating an actor's combat default track */
  static async handleUpdateActorDefaultTrack(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorDefaultTrack, 'updateActorDefaultTrack', event, target);
  }

  /** Handle clearing an actor's combat default override */
  static async handleClearActorDefault(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.clearActorDefault, 'clearActorDefault', event, target);
  }

  /**
   * Handle toggling "play exclusively" for an actor's combat music - written at SECTION level,
   * never under a phase overlay. Unticked (the default) means the theme plays as an additive
   * layer over the winning context for that combatant's turn, rather than replacing it.
   */
  static async handleUpdateActorExclusive(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorExclusive, 'updateActorExclusive', event, target);
  }

  /** Handle an actor layer's duck - how far everything else is attenuated while its theme plays */
  static async handleUpdateActorDuck(event, target) {
    return PlaylistTreeApp._handleEntryAction.call(this, PlaylistTreeApp._ENTRY_SPECS.updateActorDuck, 'updateActorDuck', event, target);
  }

  /**
   * Handle removing an actor row that has nothing bound on it.
   *
   * Only unpins - it never touches the document. A row with a binding disappears by having that
   * binding cleared, which is the same act in every other scope; offering a second "remove" that
   * silently deleted flags would be a different operation wearing the same button.
   */
  static handleUnpinActor(event, target) {
    event?.preventDefault?.();
    const actorId = target?.closest?.('[data-actor-id]')?.dataset?.actorId;
    const instance = PlaylistTreeApp._resolveInstance(this);
    if (!actorId || !instance) return;
    instance.pinnedActorIds.delete(actorId);
    instance.render(false);
  }

  /**
   * Handle opening the overlay dictionary - one window holding both axes.
   *
   * `MoodConfigApp` is used purely as the door that lands on the Moods tab; it shares
   * `OverlayConfigApp`'s id, so the window's own tab strip reaches phases from here. The footer
   * deliberately offers ONE button: two buttons onto one window (D4) read as two windows, and
   * the destination is named "Moods & Phases" in its own title bar (UX-5).
   */
  static handleOpenOverlayConfig(event) {
    event?.preventDefault?.();
    new MoodConfigApp().render(true);
  }

  /**
   * Resolve the playlist a row-level tool button acts on.
   *
   * `closest()` because the click may land on the button's inner `<i>`, as elsewhere in this file.
   * @param {HTMLElement} target
   * @param {string} what - What the caller was going to do, for the warning only
   * @returns {object|null} Playlist document
   * @private
   */
  static _playlistFromButton(target, what) {
    const button = target?.closest?.('[data-playlist-id]') || target;
    const playlistId = button?.dataset?.playlistId;
    const playlist = game.playlists?.get(playlistId);
    if (!playlist) log(2, `PlaylistTreeApp: playlist '${playlistId}' not found; cannot ${what}.`);
    return playlist || null;
  }

  /**
   * Handle opening the graph editor for a playlist bound to one of the tree's rows, so it can be
   * edited without hunting the playlist down in the sidebar and opening its config sheet first.
   *
   * Rendered on **every** bound row, not only `entry.isCustom` ones. The editor is never
   * mode-gated - `handleSave` force-writes UNSEQUENCED itself (H1) - so hiding the button on a
   * native playlist hid a control that would have worked. UX-9's corrected reference is exactly
   * this case: check that pressing it would actually fail before taking it away. It would not; it
   * would create the graph, and the label says so.
   */
  static handleOpenCustomGraph(event, target) {
    event?.preventDefault?.();
    const playlist = PlaylistTreeApp._playlistFromButton(target, 'open its playback graph');
    if (playlist) new CustomPlaylistEditor(playlist).render(true);
  }

  /**
   * Handle opening the mixer for a playlist bound to one of the tree's rows.
   *
   * The mixer was reachable from the playlist sheet, the sidebar context menu and the graph
   * editor - but not from the hub, which is the one surface showing which playlist is bound
   * where. "Why is this too loud?" (J4) began by closing the window that had just answered
   * "what is playing?" (UX-4).
   */
  static handleOpenMixer(event, target) {
    event?.preventDefault?.();
    const playlist = PlaylistTreeApp._playlistFromButton(target, 'open its mixer');
    if (playlist) PlaylistMixerApp.open(playlist);
  }

  /**
   * Handle toggling section collapse state
   */
  static handleToggleSection(event, target) {
    event?.preventDefault?.();
    // `data-collapse-key`, never `data-section`. A collapse key and a music section are two
    // different things, and while the tree's boxes happen to use `data-context-type` today,
    // a shared partial puts `data-section`-shaped attributes back within reach of this
    // `closest()` - at which point a header click would return 'combat' as a collapse key.
    // music-config.hbs was renamed for exactly that reason (docs/wiki/ux.md step 6).
    const element = target.closest('[data-collapse-key]') || target;
    const sectionKey = element?.dataset?.collapseKey;
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

  /**
   * Open this window narrowed to one scene - what a Scene sheet's music button
   * does (hooks.mjs#handleSceneConfigRender).
   *
   * An already-open *unscoped* hub is not hijacked into scoped mode: the GM asked
   * to see this scene, not to have their whole map replaced. It is instead pointed
   * at that scene and brought forward, which shows the same rows in a superset of
   * the context.
   * @param {Scene} scene
   */
  static openScoped(scene) {
    if (!game.gameOrchestra || !scene?.id) return;
    const existing = game.gameOrchestra.playlistTree;
    if (existing?.rendered) {
      existing.selectedSceneId = scene.id;
      existing.render(true);
      return;
    }
    PlaylistTreeApp.open({ scopedSceneId: scene.id });
  }

  /**
   * Open this window narrowed to one Token, PrototypeToken or Actor - what a token sheet's music
   * button does (hooks.mjs#handleTokenConfigRender). The other half of `openScoped`.
   *
   * Scoped to **the document the sheet is about**, not to its Actor. The unscoped Actors group is
   * actor-centric on purpose (one row per actor, and the Actor is in both resolution chains), but
   * an unlinked token's own override is a real thing a GM configures from that token's sheet, and
   * routing it to the Actor would silently edit a different document than the one they opened.
   *
   * An already-open hub is re-pointed rather than re-scoped, for the same reason `openScoped`
   * does it: the GM asked to see this document, not to have their whole map replaced.
   * @param {object} document - A TokenDocument, PrototypeToken, or Actor. NEVER `app.token`,
   *   which is a detached preview clone whose `_id` may be dropped entirely (HR-I).
   */
  static openScopedDocument(document) {
    if (!game.gameOrchestra || !document) return;
    const existing = game.gameOrchestra.playlistTree;
    if (existing?.rendered) {
      existing.scopedDocument = document;
      existing.render(true);
      return;
    }
    PlaylistTreeApp.open({ scopedDocument: document });
  }
}
