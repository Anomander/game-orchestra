import { CONST } from './config.mjs';
import { log, getCustomGraph, isHeadGM, getGraphTargetPlaylists } from './helpers.mjs';
import { createEmptyGraph, createDefaultLoop, createDefaultUntilLoop } from './custom-playback-schema.mjs';
import { PlaylistMixerApp } from './playlist-mixer.mjs';
import { MixerController } from './playlist-mixer-controller.mjs';
import { graphToDrawflowExport, drawflowExportToGraph, portIndex } from './graph-drawflow-bridge.mjs';
import { validateGraph } from './graph-validation.mjs';
import { buildInspectorHtml, buildValidationHtml, buildIssueBalloonHtml } from './custom-playlist-inspector.mjs';
import {
  computeNodeDetail,
  buildNodeInnerHtml,
  computeNodeHeightPx,
  computeExitChip,
  buildExitChipHtml,
  exitWeightTotal,
  nodeDisplayLabel,
  nextNodeLabel,
  zoomTier,
  EXPANDABLE_EXIT_NODE_TYPES
} from './custom-playlist-node-render.mjs';
import { parseCurvePath, buildSelfLoopPath, uncertainEdges, buildRoutedPath, parsePathEndpoints, connectionPortSelectors, connectionEndpoints } from './custom-playlist-connection-render.mjs';
import { planEdgeInsertion, planNodeBypass } from './graph-splice.mjs';
import { GRAPH_PRESETS, getPreset } from './graph-presets.mjs';
import { edgeSelector, portFromEdgeId } from './graph-activity-highlight.mjs';
import { dispatchChangeAction } from './app-mixins.mjs';
import { EditorSelectionMixin } from './editor-selection-mixin.mjs';
import { EditorHighlightMixin } from './editor-highlight-mixin.mjs';
import { createDefaultPlaylistRef, normalizePlaylistRef, describePlaylistRef } from './playlist-ref.mjs';
import { resolveGraphDrop } from './graph-drop.mjs';
import { GraphHistory } from './graph-history.mjs';
import { COLUMN_WIDTH_PX } from './graph-builder.mjs';
import {
  setMarker,
  clearMarkers,
  PORT_HOVER_ATTR,
  EDGE_HOVER_ATTR,
  PORT_REVEAL_ATTR,
  UNCERTAIN_EDGE_ATTR,
  ISSUE_EDGE_ATTR,
  INSERT_EDGE_ATTR
} from './graph-decorations.mjs';

/** Minimum vertical clearance (px) a self-loop's arc keeps above a node. */
const SELF_LOOP_MIN_CLEARANCE_PX = 40;

/**
 * Node classes carrying validation state, applied alongside the corner badge.
 * Indexed by the same severity strings _refreshIssueBadges() already computes.
 *
 * Classes are fine HERE and nowhere near a port or a wire: every marker this
 * editor puts on one of THOSE is an attribute instead, for the reason
 * graph-decorations.mjs opens with.
 */
const ISSUE_STATE_CLASSES = { warning: 'game-orchestra-node-warning', error: 'game-orchestra-node-error' };

/**
 * A distinct glyph per severity, so warning and error are never told apart by
 * colour alone (amber vs red is exactly the pair red-green colour blindness
 * collapses). Both were 'fa-exclamation' before the node itself started
 * carrying the state colour, when the badge's own colour was doing all the
 * work at a size where a glyph difference wouldn't have registered.
 */
const ISSUE_BADGE_ICONS = { warning: 'fa-exclamation', error: 'fa-xmark' };

/**
 * The canvas "+" affordance on a node whose exits are expandable
 * (EXPANDABLE_EXIT_NODE_TYPES) - see _refreshExitAdder().
 *
 * This MUST be the element's first (and here, only) class. Drawflow's mousedown
 * handler switches on `ele_selected.classList[0]` - the same positional class
 * reading HR-B warns about on the mount element - and it is that switch falling
 * through to no case at all which keeps a press on this button from selecting
 * the node and starting a drag. A class ordered ahead of this one that happened
 * to read 'drawflow-node'/'output'/'main-path' would hand the press straight
 * back to Drawflow.
 */
const ADD_EXIT_CLASS = 'game-orchestra-node-add-exit';

/** Node types whose inspector lists one configurable row per output port. */
const EXIT_LIST_NODE_TYPES = new Set(['random', 'condition', 'fork']);

/**
 * Condition kind a newly added exit starts on. Never 'default' - that one is
 * the node's fixed fallback exit and there is exactly one of it.
 */
const NEW_CONDITION_KIND = 'combatActive';

/**
 * Resolve a validation issue's message key (graph-validation.mjs emits keys,
 * not localized strings, since that module has no dependency on Foundry).
 * Interpolates via game.i18n.format() when the issue carries data (e.g.
 * UnknownNodeType's {type}), otherwise a plain localize().
 * @param {string} key
 * @param {object} [data]
 * @returns {string}
 */
function localizeIssue(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DragDrop } = foundry.applications.ux;

/**
 * Node palette entries: type id, default input/output port counts, and the
 * default `data` a freshly-added node of that type starts with.
 */
const NODE_DEFAULTS = {
  start: { inputs: 0, outputs: 1, data: {} },
  end: { inputs: 1, outputs: 0, data: {} },
  track: { inputs: 1, outputs: 1, data: { soundId: null, loop: createDefaultLoop() } },
  fork: { inputs: 1, outputs: 2, data: {} },
  delay: { inputs: 1, outputs: 1, data: { delay: { min: 1, max: 1 } } },
  random: { inputs: 1, outputs: 1, data: { exits: [{ weight: 1, cooldown: 0 }], avoidRepeat: false } },
  condition: { inputs: 1, outputs: 1, data: { exits: [{ condition: { kind: 'default' } }] } },
  playlist: { inputs: 1, outputs: 1, data: { playlistRef: createDefaultPlaylistRef(), loop: createDefaultLoop() } }
};

/**
 * The palette deliberately has NO Track entry, and must not regain one.
 *
 * A Track node's sound is fixed at creation and the Properties pane shows it
 * read-only (custom-playlist-inspector.mjs) - so a Track added from the palette
 * would start with soundId: null and there would be no way, anywhere in this
 * window, to ever give it one. It could only sit on the canvas failing
 * validation with TrackNoSound until deleted.
 *
 * Track nodes are created per-sound instead, by the two routes that carry a
 * sound with them: dragging a Tracks-pane row (or a sidebar PlaylistSound) onto
 * the canvas, and the Tracks pane's own per-row "+" button (handleAddTrackNode).
 * NODE_DEFAULTS.track stays - both of those routes go through _addNodeOfType().
 */
const NODE_PALETTE = [
  { type: 'start', label: 'GameOrchestra.CustomEditor.NodeType.Start' },
  { type: 'playlist', label: 'GameOrchestra.CustomEditor.NodeType.Playlist' },
  { type: 'fork', label: 'GameOrchestra.CustomEditor.NodeType.Fork' },
  { type: 'delay', label: 'GameOrchestra.CustomEditor.NodeType.Delay' },
  { type: 'random', label: 'GameOrchestra.CustomEditor.NodeType.Random' },
  { type: 'condition', label: 'GameOrchestra.CustomEditor.NodeType.Condition' },
  { type: 'end', label: 'GameOrchestra.CustomEditor.NodeType.End' }
];

/**
 * Visual node-graph editor for a playlist's custom playback graph
 * (custom-playback-schema.mjs). Hosts a Drawflow canvas (scripts/vendor) inside
 * a Foundry ApplicationV2 window, mirroring the host-window structure of
 * MoodConfigApp (mood-config.mjs) - static `actions` map, a working copy
 * mutated in place until Save.
 *
 * Drawflow's live internal graph (this._drawflow) is the single source of
 * truth for the canvas while the window is open; `this.graph` is a derived
 * CustomGraph snapshot recomputed via _syncFromDrawflow() after every
 * structural change, used for validation/inspector display and written out
 * on Save.
 *
 * IMPORTANT (found via live testing): the inspector panel is intentionally
 * updated via _renderInspector() - direct DOM innerHTML replacement of just
 * .game-orchestra-editor-inspector - and NEVER via a full ApplicationV2 this.render().
 * Drawflow's own 'nodeSelected' event fires synchronously inside its mousedown
 * handler, *before* it sets up a drag. A full this.render() at that point
 * regenerates this app's whole Handlebars-rendered content (including the
 * empty <div class="game-orchestra-drawflow-canvas">), tearing down and replacing
 * Drawflow's live canvas mid-mousedown - the drag continues on an orphaned,
 * now-detached copy while a fresh instance renders in its place, so nodes
 * select but silently never move, with no console error. Every mutation
 * handler below (add/remove node or exit, inspector field edits, a failed
 * Save validation) must go through _renderInspector(), never this.render(),
 * for the same reason.
 */
export class CustomPlaylistEditor extends EditorSelectionMixin(EditorHighlightMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-custom-playlist-editor',
    tag: 'div',
    window: { title: 'GameOrchestra.CustomEditor.Title', icon: 'fas fa-project-diagram', resizable: true, minimizable: true },
    classes: ['game-orchestra-custom-playlist-editor'],
    position: { width: 960, height: 680 },
    actions: {
      addNode: CustomPlaylistEditor.handleAddNode,
      addExit: CustomPlaylistEditor.handleAddExit,
      removeExit: CustomPlaylistEditor.handleRemoveExit,
      undo: CustomPlaylistEditor.handleUndo,
      redo: CustomPlaylistEditor.handleRedo,
      zoomIn: CustomPlaylistEditor.handleZoomIn,
      zoomOut: CustomPlaylistEditor.handleZoomOut,
      zoomReset: CustomPlaylistEditor.handleZoomReset,
      focusNode: CustomPlaylistEditor.handleFocusNode,
      openMixer: CustomPlaylistEditor.handleOpenMixer,
      save: CustomPlaylistEditor.handleSave,
      removeCustomPlayback: CustomPlaylistEditor.handleRemoveCustomPlayback,
      togglePane: CustomPlaylistEditor.handleTogglePane,
      addTrackNode: CustomPlaylistEditor.handleAddTrackNode
    },
    // dragSelector matches the Tracks pane's own rows (an internal drag source);
    // dropSelector is the canvas wrapper, not [data-drawflow-mount] itself - that
    // element must stay class-free for Drawflow's own click-dispatch logic (see
    // the template's comment on it), so drop handling binds one level up instead.
    dragDrop: [{ dragSelector: '[data-vg-drag]', dropSelector: '.game-orchestra-drawflow-canvas', permissions: { dragstart: true, drop: true }, callbacks: {} }]
  };

  /** @override */
  static PARTS = { form: { template: 'modules/game-orchestra/templates/custom-playlist-editor.hbs' } };

  /**
   * Maps `data-change-action` values on inspector inputs to their handler
   * method name, mirroring GameOrchestraConfig._CHANGE_ACTIONS (app.mjs).
   */
  static _CHANGE_ACTIONS = {
    applyPreset: 'handleApplyPreset',
    updateNodeLabel: 'handleUpdateNodeLabel',
    updateTrackLoopCount: 'handleUpdateTrackLoopCount',
    updateTrackInfinite: 'handleUpdateTrackInfinite',
    updateTrackUntilToggle: 'handleUpdateTrackUntilToggle',
    updateTrackUntilKind: 'handleUpdateTrackUntilKind',
    updateTrackUntilValue: 'handleUpdateTrackUntilValue',
    updateTrackUntilBoundary: 'handleUpdateTrackUntilBoundary',
    updateTrackUntilMinLoops: 'handleUpdateTrackUntilMinLoops',
    updateTrackUntilMaxLoops: 'handleUpdateTrackUntilMaxLoops',
    updateDelayMin: 'handleUpdateDelayMin',
    updateDelayMax: 'handleUpdateDelayMax',
    updateRandomExitWeight: 'handleUpdateRandomExitWeight',
    updateRandomExitCooldown: 'handleUpdateRandomExitCooldown',
    updateRandomAvoidRepeat: 'handleUpdateRandomAvoidRepeat',
    updateConditionExitKind: 'handleUpdateConditionExitKind',
    updateConditionExitValue: 'handleUpdateConditionExitValue',
    updatePlaylistSource: 'handleUpdatePlaylistSource',
    updatePlaylistTarget: 'handleUpdatePlaylistTarget',
    updatePlaylistSection: 'handleUpdatePlaylistSection',
    updatePlaylistOverlayMode: 'handleUpdatePlaylistOverlayMode',
    updatePlaylistOverlayId: 'handleUpdatePlaylistOverlayId',
    updatePlaylistInfinite: 'handleUpdatePlaylistInfinite',
    updatePlaylistLoopCount: 'handleUpdatePlaylistLoopCount'
  };

  /**
   * @param {object} playlist - Foundry Playlist document to edit custom playback for.
   * @param {object} [options]
   */
  constructor(playlist, options = {}) {
    super(options);
    this.playlist = playlist;
    this.graph = foundry.utils.deepClone(getCustomGraph(playlist) || createEmptyGraph());
    this.selectedNodeId = null;
    this._drawflow = null;
    // The highlight currently painted on the canvas (graph-activity-highlight.mjs),
    // kept so it can be lifted again before the next one is applied.
    this._activityHighlight = null;
    this._activityHookId = null;
    this._pulseTimeout = null;
    // {nodeId, portName} of the exit row currently hovered in the inspector.
    this._hoveredExit = null;
    // The rendered <svg class="connection"> the pointer is currently over, kept
    // so its two ports can be un-revealed again when the pointer moves off it.
    this._hoveredWire = null;
    // The wire a drag is currently offering to splice into (_setInsertTargetEdge). Separate from
    // _hoveredWire: that one tracks the mouse and reveals ports, this one exists only while
    // something draggable is over the canvas and promises a rewire on drop.
    this._insertTargetEdge = null;
    // Node ids currently marquee-selected via left-drag rect-select - distinct
    // from selectedNodeId/Drawflow's own single-node selection (see
    // _onCanvasMouseDown's class doc for why the two never mix).
    this._multiSelectedNodeIds = new Set();
    // Cascades each successive node added without an explicit drop point (palette
    // click, Tracks pane "+" button) so repeated adds don't stack exactly on top
    // of one another - see _defaultNodePoint().
    this._addCascade = -1;
    // The node a newly-added node auto-wires itself onto, and the reason building a
    // sequence costs one gesture per track instead of two - see _chainAnchor().
    //
    // Distinct from selectedNodeId, and deliberately: _addNodeOfType() does not select
    // what it creates (that would collapse the Tracks pane mid-flow), so anchoring on
    // the Drawflow selection would wire every node in a run onto the same source. This
    // advances to each new node instead, so add-add-add builds a chain.
    this._chainAnchorId = null;
    // Issue balloon (_toggleIssueBalloon): the open balloon's element and the
    // node it belongs to, plus the localized messages per node that
    // _refreshIssueBadges() last computed - the balloon opens on a click long
    // after that, so it can't be handed them directly.
    this._issueBalloonEl = null;
    this._issueBalloonNodeId = null;
    this._issueMessages = new Map();
    // Undo/redo (graph-history.mjs). Per-window and in-memory only: the history
    // is seeded at mount and dies with this instance, so reopening the editor
    // starts from whatever is saved on the playlist.
    this._history = new GraphHistory();
    // Set while _restoreSnapshot() is rewriting the canvas, so the resyncs it
    // performs don't record themselves as fresh edits.
    this._historySuspended = false;
    // A capture is already queued for the end of the current task - see
    // _recordHistory() for why one gesture must not become several steps.
    this._historyPending = false;
  }

  /**
   * Static shell context: rendered once via Handlebars when the window first
   * opens (palette, playlist name, footer). Also reused by _renderInspector()
   * as the single source of truth for the inspector's data - see the class
   * doc for why the inspector itself is never re-rendered through this path.
   * @override
   */
  _prepareContext(_options) {
    // Every playlist a Playlist node could target, and every configured mood/phase -
    // shared between validateGraph()'s target-existence/cycle checks and the
    // inspector's own dropdowns, so both agree on the same world state.
    const targetPlaylists = getGraphTargetPlaylists();
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const moodIds = configuredMoods.map((m) => m.id);
    const phaseIds = configuredPhases.map((p) => p.id);
    const validation = validateGraph(this.graph, { playlist: this.playlist, playlists: targetPlaylists, moodIds, phaseIds });
    const selectedNode = this.graph.nodes.find((n) => n.id === this.selectedNodeId) || null;
    const sounds = this._playlistSounds();
    const soundOptions = sounds.map((s) => ({
      id: s.id,
      name: s.name,
      selected: s.id === selectedNode?.soundId
    }));
    // The playlist being edited is never a legal direct target (a validation
    // error either way - PlaylistSelfReference) - omitted rather than offered
    // and immediately rejected.
    const playlistOptions = targetPlaylists
      .filter((p) => p.id !== this.playlist?.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        selected: selectedNode?.type === 'playlist' && selectedNode.playlistRef?.source === 'direct' && selectedNode.playlistRef?.playlistId === p.id
      }));
    // Which definition list applies depends on the selected Playlist node's OWN
    // referenced section (area -> mood, combat -> phase - config.mjs#sectionAxis),
    // not on anything global - two different Playlist nodes in the same graph can
    // reference different sections and need different dropdown contents.
    const overlayDefs = selectedNode?.type === 'playlist' && selectedNode.playlistRef?.section === 'combat' ? configuredPhases : configuredMoods;
    const overlayOptions = overlayDefs.map((m) => ({
      id: m.id,
      label: m.label?.startsWith('GameOrchestra.') ? game.i18n.localize(m.label) : m.label,
      selected: selectedNode?.type === 'playlist' && selectedNode.playlistRef?.overlayMode === 'specific' && selectedNode.playlistRef?.overlayId === m.id
    }));
    // Both axes' full definitions, for a 'mood'/'phase' Condition's own value dropdown
    // (Condition node exits, a Track's until-loop escape condition) - unlike overlayOptions
    // above, a condition's axis is its own `kind`, not tied to any node's `section`, so both
    // lists are always available rather than picked per-node.
    const moodOptions = configuredMoods.map((m) => ({ id: m.id, label: m.label?.startsWith('GameOrchestra.') ? game.i18n.localize(m.label) : m.label }));
    const phaseOptions = configuredPhases.map((p) => ({ id: p.id, label: p.label?.startsWith('GameOrchestra.') ? game.i18n.localize(p.label) : p.label }));
    // A preset the playlist doesn't have enough tracks for is offered disabled
    // rather than hidden, so it's clear the option exists and what unlocks it.
    const presets = GRAPH_PRESETS.map((preset) => ({
      id: preset.id,
      labelKey: preset.labelKey,
      descriptionKey: preset.descriptionKey,
      enabled: sounds.length >= preset.minSounds
    }));
    const selectedExits = selectedNode ? this._buildExitRows(selectedNode) : [];
    return {
      palette: NODE_PALETTE,
      presets,
      playlistName: this.playlist?.name,
      hasExistingGraph: !!getCustomGraph(this.playlist),
      // The engine only runs on the head GM, and its activity isn't broadcast
      // over a socket - so on any other client the canvas would just sit inert
      // during playback with no explanation. Say why instead.
      activityUnavailable: !isHeadGM() && !!getCustomGraph(this.playlist),
      validation,
      selectedNode,
      soundOptions,
      playlistOptions,
      overlayOptions,
      moodOptions,
      phaseOptions,
      selectedExits
    };
  }

  /**
   * One inspector row per output PORT of a multi-exit node, in port order.
   *
   * Keyed on ports rather than on edges, which matters in two ways the old
   * edge-derived list got wrong: a port the user added but hasn't wired yet
   * still gets a row (so it can be configured before anything is connected),
   * and each row's `portName` is the port it actually belongs to. Deriving
   * port names by counting edges silently mislabels every row after an unwired
   * port - which would then remove or highlight the wrong exit.
   *
   * Exit metadata comes from the node's own `data.exits[]` (parallel to the
   * ports by index - see graph-drawflow-bridge.mjs), and the edge, if any, is
   * matched by the port encoded in its id.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @returns {Array<object>} Rows of {portName, index, edge, ...exit metadata}.
   * @private
   */
  _buildExitRows(node) {
    if (!EXIT_LIST_NODE_TYPES.has(node.type)) return [];
    const liveNode = this._liveNode(node.id);
    if (!liveNode) {
      // Before the canvas has mounted there are no ports to enumerate; the
      // graph's edges are all there is, and they carry their own metadata.
      return this.graph.edges.filter((e) => e.from === node.id).map((edge, i) => ({ ...edge, portName: `output_${i + 1}` }));
    }
    const exits = liveNode.data?.exits || [];
    return Object.keys(liveNode.outputs || {})
      .sort((a, b) => portIndex(a) - portIndex(b))
      .map((portName, i) => ({ ...(exits[i] || {}), portName }));
  }

  /**
   * Default name for a node about to be created, unique among the names the
   * graph is already using.
   * @param {string} type
   * @returns {string}
   * @private
   */
  _nextNodeLabel(type) {
    return nextNodeLabel(type, this.graph.nodes.map((n) => nodeDisplayLabel(n)));
  }

  /**
   * This playlist's sounds as a plain array, tolerating both the Collection
   * (`.contents`) and Map-like (`.values()`) shapes the document exposes.
   * @returns {Array<object>}
   * @private
   */
  _playlistSounds() {
    return this.playlist?.sounds?.contents || Array.from(this.playlist?.sounds?.values() || []);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);
    this._mountDrawflow();
    this._renderInspector();
    this._renderTracks();
    // Rebinds every render, deliberately unguarded - mirrors GameOrchestraAppMixin's
    // own _setupDragDrop() call (app-mixins.mjs): Foundry's DragDrop#bind() is
    // not delegated, it queries dragSelector/dropSelector once at bind time
    // against whatever DOM exists right then. In practice this editor's
    // _onRender only ever fires once (see the class doc), so in practice this
    // runs once too - the missing guard is defense in depth against any future
    // re-render, the same reasoning as _mountDrawflow()'s own idempotency check.
    if (this.element) this._setupDragDrop();
    if (this.element && !this._changeListenerBound) {
      this._onChangeInputHandler = (event) => this._onChangeInput(event);
      this.element.addEventListener('change', this._onChangeInputHandler);
      // Bound on document, not this.element: clicking a Drawflow node doesn't
      // move DOM focus into this window's subtree (nothing in it is
      // focusable), so a listener scoped to this.element alone would never
      // see the keydown. _onKeyDown itself checks that focus isn't sitting in
      // some unrelated text field before acting.
      this._onKeyDownHandler = (event) => this._onKeyDown(event);
      document.addEventListener('keydown', this._onKeyDownHandler);
      // Capture phase, bound above the canvas (not on it) - see
      // _onCanvasMouseDown's class doc for why this has to run and
      // stopPropagate() BEFORE Drawflow's own bubble-phase mousedown handler
      // (bound directly on the canvas container in its constructor) ever sees
      // a left-button background click.
      this._onCanvasMouseDownHandler = (event) => this._onCanvasMouseDown(event);
      this.element.addEventListener('mousedown', this._onCanvasMouseDownHandler, { capture: true });
      // Live playback highlight: the engine broadcasts where its tokens are
      // (CustomPlaybackEngine#_emitActivity). Prime from the running engine
      // right away so a window opened mid-playback isn't blank until the next
      // transition - which, for a long track, could be minutes away.
      // One delegated mouseover drives both hover highlights - the inspector's
      // exit rows and the canvas's wires. mouseover (not mouseenter) so a
      // single listener covers elements that don't exist yet: inspector rows
      // are rebuilt on every render, and Drawflow discards and rebuilds a
      // wire's <svg> whenever a connection changes. mouseleave on the window
      // itself catches the pointer leaving without passing over anything else.
      this._onWindowHoverHandler = (event) => {
        this._onExitHover(event);
        this._onWireHover(event);
      };
      this._onWindowHoverLeaveHandler = () => {
        this._setHoveredExit(null, null);
        this._setHoveredWire(null);
      };
      this.element.addEventListener('mouseover', this._onWindowHoverHandler);
      this.element.addEventListener('mouseleave', this._onWindowHoverLeaveHandler);
      // DragDrop (bound via _setupDragDrop() below) only ever wires up dragover/drop/dragstart -
      // it has no dragleave concept of its own - so the canvas's drop-hover feedback needs its
      // own listener, the same way mouseover/mouseleave above are bound directly rather than
      // through that mechanism.
      this._onDragLeaveHandler = (event) => this._onDragLeaveCanvas(event);
      this.element.addEventListener('dragleave', this._onDragLeaveHandler);
      // On document, not this.element: this both opens a node's issue balloon
      // (badge click) and dismisses it on a click anywhere else, including
      // outside this window entirely - which a listener scoped to this.element
      // would never see.
      this._onDocumentClickHandler = (event) => this._onDocumentClick(event);
      document.addEventListener('click', this._onDocumentClickHandler);
      // Capture phase - see _onEscapeKey for why it can't wait its turn.
      this._onEscapeKeyHandler = (event) => this._onEscapeKey(event);
      document.addEventListener('keydown', this._onEscapeKeyHandler, { capture: true });
      this._activityHookId = Hooks.on('gameOrchestraGraphActivity', (payload) => this._onGraphActivity(payload));
      this._onGraphActivity(game.gameOrchestra?.musicController?.getGraphActivity?.(this.playlist) ?? null);
      this._changeListenerBound = true;
    }
  }

  /** @override */
  _onClose(options) {
    if (this.element && this._onChangeInputHandler) {
      this.element.removeEventListener('change', this._onChangeInputHandler);
    }
    if (this._onKeyDownHandler) {
      document.removeEventListener('keydown', this._onKeyDownHandler);
      this._onKeyDownHandler = null;
    }
    if (this.element && this._onCanvasMouseDownHandler) {
      this.element.removeEventListener('mousedown', this._onCanvasMouseDownHandler, { capture: true });
      this._onCanvasMouseDownHandler = null;
    }
    if (this.element && this._onWindowHoverHandler) {
      this.element.removeEventListener('mouseover', this._onWindowHoverHandler);
      this.element.removeEventListener('mouseleave', this._onWindowHoverLeaveHandler);
      this._onWindowHoverHandler = null;
      this._onWindowHoverLeaveHandler = null;
    }
    if (this.element && this._onDragLeaveHandler) {
      this.element.removeEventListener('dragleave', this._onDragLeaveHandler);
      this._onDragLeaveHandler = null;
    }
    if (this._onDocumentClickHandler) {
      document.removeEventListener('click', this._onDocumentClickHandler);
      this._onDocumentClickHandler = null;
    }
    if (this._onEscapeKeyHandler) {
      document.removeEventListener('keydown', this._onEscapeKeyHandler, { capture: true });
      this._onEscapeKeyHandler = null;
    }
    // Lives on document.body, so unlike everything else in this window it is
    // NOT torn down with the window's own DOM - it would outlive the editor.
    this._closeIssueBalloon();
    if (this._activityHookId !== null) {
      Hooks.off('gameOrchestraGraphActivity', this._activityHookId);
      this._activityHookId = null;
    }
    if (this._pulseTimeout) {
      clearTimeout(this._pulseTimeout);
      this._pulseTimeout = null;
    }
    this._activityHighlight = null;
    this._teardownRectSelectDrag(); // in case the window closes mid-drag
    this._teardownGroupDrag();
    this._changeListenerBound = false;
    this._drawflow = null; // torn down along with its container DOM; nothing else to release
    this._mixer?.teardown();
    this._mixer = null;
    super._onClose(options);
  }

  /**
   * Toggle one accordion pane's collapsed state. Exactly one pane is open at a time: expanding
   * one collapses every other. This supersedes docs/graph-editor-panel-plan.md D2, which specified
   * independently collapsible panes - the panel now stretches to the bottom of the window and the
   * open pane claims all of the leftover height (see .game-orchestra-pane-stack in game-orchestra.css), which
   * only works if there is a single one to give it to.
   *
   * Clicking the OPEN pane's own header still closes it, leaving none open - a deliberate escape
   * hatch, not an oversight: it hands the whole column back to the pinned validation region when
   * a graph has a long list of issues to read through.
   */
  static handleTogglePane(event, target) {
    event.preventDefault();
    const section = target.closest('.game-orchestra-pane');
    if (!section) return;
    this._setPaneCollapsed(target.dataset.pane, !section.classList.contains('game-orchestra-collapsed'));
  }

  /**
   * Collapse or expand one pane. Expanding collapses every sibling - see handleTogglePane for
   * why the panel is single-open. Collapsing touches only the named pane.
   * @param {string} paneId
   * @param {boolean} collapsed
   * @private
   */
  _setPaneCollapsed(paneId, collapsed) {
    const section = this.element?.querySelector(`.game-orchestra-pane[data-pane="${paneId}"]`);
    if (!section) return;
    this._applyPaneCollapsed(section, collapsed);
    if (collapsed) return;
    // Read the sibling list from the DOM rather than a hardcoded id list, so a pane added to the
    // template is folded into the accordion automatically instead of silently staying open
    // alongside whatever the user just expanded.
    for (const other of this.element?.querySelectorAll?.('.game-orchestra-pane') || []) {
      if (other !== section) this._applyPaneCollapsed(other, true);
    }
  }

  /**
   * @param {HTMLElement} section - A `.game-orchestra-pane`.
   * @param {boolean} collapsed
   * @private
   */
  _applyPaneCollapsed(section, collapsed) {
    section.classList.toggle('game-orchestra-collapsed', collapsed);
    section.querySelector('.game-orchestra-pane-header')?.setAttribute('aria-expanded', String(!collapsed));
  }

  /**
   * Bind this window's drag-and-drop: the Tracks pane's own rows (playlist-mixer-render.mjs) as
   * an internal drag source, and the canvas wrapper as the drop target for both that internal
   * drag and a real Playlist/PlaylistSound dragged in from the Foundry sidebar - see
   * docs/graph-editor-panel-plan.md D8 for the full rule matrix _onDropExternal() applies.
   *
   * Called on every render, deliberately unguarded (see _onRender's comment on this call) -
   * mirrors GameOrchestraConfig/PlaylistTreeApp (app-mixins.mjs). Builds a fresh config object per
   * call rather than mutating DEFAULT_OPTIONS.dragDrop in place, since that array is shared
   * across every instance of this class.
   * @private
   */
  _setupDragDrop() {
    const dragDropConfigs = this.options.dragDrop || CustomPlaylistEditor.DEFAULT_OPTIONS.dragDrop || [];
    for (const dragDropOptions of dragDropConfigs) {
      const instanceOptions = {
        ...dragDropOptions,
        callbacks: {
          dragstart: this._onDragStartInternal.bind(this),
          dragover: this._onDragOverExternal.bind(this),
          drop: this._onDropExternal.bind(this)
        }
      };
      new DragDrop(instanceOptions).bind(this.element);
    }
  }

  /**
   * Drag-start for a Tracks pane row: writes the exact dataTransfer payload shape Foundry's own
   * sidebar produces for a dragged PlaylistSound, so _onDropExternal() has only one payload shape
   * to parse regardless of where the drag started.
   * @param {DragEvent} event
   * @private
   */
  _onDragStartInternal(event) {
    const row = event.target?.closest?.('[data-vg-drag]');
    if (!row) return;
    event.dataTransfer.setData('text/plain', JSON.stringify({ type: row.dataset.dragType, uuid: row.dataset.uuid }));
  }

  /**
   * @param {DragEvent} event
   * @private
   */
  _onDragOverExternal(event) {
    event.preventDefault(); // required for 'drop' to fire at all
    if (!event.dataTransfer.types.includes('text/plain')) return;
    event.currentTarget.classList.add('drop-hover');
    // Live, per-frame, because a wire is a thin target and "which one am I over" is not
    // answerable from the cursor alone. Dropping is what commits it - see _onDropExternal.
    this._setInsertTargetEdge(this._edgeUnderPointer(event));
  }

  /**
   * The wire under a drag, or null. Nodes win ties: a wire passing beneath a node is still
   * hit-testable at its edges, and a drop aimed at a node (which repoints a Track, or lands on
   * open canvas) is the more specific gesture of the two.
   *
   * `.connection` carries `pointer-events: none` and only its `.main-path` child is hit-testable,
   * so `event.target` during a dragover lands on the path and this walks up to the `<svg>` that
   * owns the endpoint classes - the same traversal _onWireHover() does for the mouse.
   * @param {DragEvent} event
   * @returns {Element|null}
   * @private
   */
  _edgeUnderPointer(event) {
    if (event.target?.closest?.('.drawflow-node')) return null;
    return event.target?.closest?.('.connection') || null;
  }

  /**
   * Mark (or unmark) the wire a drop would splice into. Idempotent per element so the marker is
   * not rewritten on every dragover frame.
   * @param {Element|null} connectionEl
   * @private
   */
  _setInsertTargetEdge(connectionEl) {
    const next = connectionEl || null;
    if (this._insertTargetEdge === next) return;
    // Lifted from the OLD element even if Drawflow has since detached it, for the same reason
    // _setHoveredWire() does: a detached <svg> is harmless, a stranded marker is not.
    setMarker(this._insertTargetEdge, INSERT_EDGE_ATTR, false);
    this._insertTargetEdge = next;
    setMarker(next, INSERT_EDGE_ATTR, true);
  }

  /**
   * Clear the canvas's drop-hover feedback once a drag genuinely leaves it (as opposed to moving
   * between its child elements, which also fires dragleave on it).
   * @param {DragEvent} event
   * @private
   */
  _onDragLeaveCanvas(event) {
    const box = event.target?.closest?.('.game-orchestra-drawflow-canvas');
    if (!box) return;
    if (event.relatedTarget && box.contains(event.relatedTarget)) return;
    box.classList.remove('drop-hover');
    // Leaving the canvas ends the insertion offer too - otherwise a drag abandoned outside the
    // window leaves a wire lit up with nothing driving it.
    this._setInsertTargetEdge(null);
  }

  /**
   * Handle a Playlist/PlaylistSound dropped onto the canvas - from the Foundry sidebar, or from
   * this window's own Tracks pane (_onDragStartInternal emits the identical payload shape).
   * Creates a Track node for a sound from the playlist being edited, a Playlist node for any
   * other playlist, or rejects with an explanation - graph-drop.mjs#resolveGraphDrop carries the
   * full rule matrix and the reasoning behind each case (in particular, why a sound from a
   * DIFFERENT playlist is rejected rather than silently promoted to a Playlist node).
   * @param {DragEvent} event
   * @private
   */
  async _onDropExternal(event) {
    event.preventDefault();
    event.currentTarget.classList.remove('drop-hover');
    // All three captured synchronously, before the fromUuid() await below - the event object is
    // not reliable to read from once an event handler has yielded.
    const point = this._pointFromEvent(event);
    const dropTargetNodeId = this._trackNodeUnderDrop(event);
    const insertEdge = connectionEndpoints(this._edgeUnderPointer(event)?.classList);
    // The offer is consumed by the drop whether or not it ends up applying (a rejected drop
    // leaves nothing lit).
    this._setInsertTargetEdge(null);

    let data;
    try {
      const dataString = event.dataTransfer.getData('text/plain');
      if (!dataString) return;
      data = JSON.parse(dataString);
    } catch (error) {
      return; // not a Foundry drag (e.g. an OS file) - silent no-op, not an error toast
    }
    if (!['Playlist', 'PlaylistSound'].includes(data?.type) || !data.uuid) return;

    const document = await fromUuid(data.uuid);
    if (!this._drawflow) return; // the window may have closed while the lookup above was pending

    const dropped =
      data.type === 'PlaylistSound'
        ? { type: 'PlaylistSound', playlistId: document?.parent?.id ?? null, soundId: document?.id ?? null }
        : { type: 'Playlist', playlistId: document?.id ?? null, soundId: null };

    const result = resolveGraphDrop(dropped, { editedPlaylistId: this.playlist?.id ?? null });
    if (result.action === 'reject') {
      ui.notifications?.warn(game.i18n.localize(result.reasonKey));
      return;
    }
    // Dropped ON an existing Track node: repoint that node instead of creating a second one.
    if (result.action === 'track' && dropTargetNodeId) return this._repointTrackNode(dropTargetNodeId, result.soundId);

    // Dropped on a WIRE: the new node is spliced into it, so auto-chaining is suppressed - the
    // edge already says where this node belongs, and the chain anchor would wire it a second
    // time from somewhere else entirely.
    const [type, overrides] =
      result.action === 'track'
        ? ['track', { soundId: result.soundId }]
        : ['playlist', { playlistRef: { source: 'direct', playlistId: result.playlistId } }];
    const nodeId = this._addNodeOfType(type, overrides, point, { chain: !insertEdge });
    if (nodeId && insertEdge) this._insertNodeOnEdge(nodeId, insertEdge);
  }

  /**
   * Splice a just-created node into the edge it was dropped on: `A -> B` becomes `A -> N -> B`.
   *
   * The plan (which wires to drop, which to make) is graph-splice.mjs#planEdgeInsertion - pure and
   * unit-tested there. This half is only the Drawflow calls and the refresh, in the order the plan
   * gives them: removals first, so the source's output port is never momentarily holding both its
   * old wire and the new one.
   * @param {string} nodeId
   * @param {import('./graph-splice.mjs').GraphEdgeEnds} edge
   * @private
   */
  _insertNodeOnEdge(nodeId, edge) {
    if (!this._drawflow) return;
    const node = this._liveNode(nodeId);
    if (!node) return;
    const plan = planEdgeInsertion(edge, nodeId, { outputCount: Object.keys(node.outputs || {}).length });
    for (const wire of plan.remove) this._drawflow.removeSingleConnection(wire.from, wire.to, wire.outputPort, wire.inputPort);
    for (const wire of plan.connect) this._drawflow.addConnection(wire.from, wire.to, wire.outputPort, wire.inputPort);
    // Every call above fires its own connection event, each of which resyncs - this is the one
    // that reflects the finished shape. All still inside the same task, so _recordHistory()'s
    // end-of-task capture makes the whole splice ONE undo step.
    this._syncFromDrawflow(this._drawflow);
    this._refreshNodeDisplay(nodeId);
    this._renderInspector();
  }

  /**
   * The id of the Track node a drop landed on, or null for a drop onto open canvas.
   *
   * Must be read synchronously, before _onDropExternal's fromUuid() await - `event.target` is
   * not reliable once a handler has yielded, the same reason the drop point is captured early.
   * @param {DragEvent} event
   * @returns {string|null}
   * @private
   */
  _trackNodeUnderDrop(event) {
    const element = event.target?.closest?.('.drawflow-node');
    const nodeId = element?.id?.startsWith?.('node-') ? element.id.slice(5) : null;
    if (!nodeId) return null;
    return this._liveNode(nodeId)?.name === 'track' ? nodeId : null;
  }

  /**
   * Point an existing Track node at a different sound, keeping its wires, position and name.
   *
   * A Track node's sound is deliberately read-only in the inspector
   * (custom-playlist-inspector.mjs): a Track node IS a sound's position in the graph, not a slot
   * you repoint, and that is what the Tracks pane's per-sound usage counts are built around.
   * That concept is intact here - this is still the drag route, and the counts still recompute -
   * but fixing a misdrag no longer costs a delete, a re-drag and two rewires. Dropping the right
   * sound onto the wrong node is the same gesture that created it.
   * @param {string} nodeId
   * @param {string} soundId
   * @private
   */
  _repointTrackNode(nodeId, soundId) {
    const node = this._liveNode(nodeId);
    if (!node) return;
    if (node.data?.soundId === soundId) return; // dropped a sound onto the node already playing it
    this._patchNodeData(nodeId, { ...node.data, soundId });
  }

  /**
   * Canvas coordinates the current viewport's centre corresponds to, with a small cascade so
   * repeated adds without an explicit drop point (a palette click, the Tracks pane's "+" button)
   * don't stack every new node on the exact same pixel.
   * @returns {{x: number, y: number}}
   * @private
   */
  _defaultNodePoint() {
    const editor = this._drawflow;
    const container = editor?.container;
    const zoom = editor?.zoom || 1;
    const x = ((container?.clientWidth || 800) / 2 - (editor?.canvas_x || 0)) / zoom - 70;
    const y = ((container?.clientHeight || 600) / 2 - (editor?.canvas_y || 0)) / zoom - 40;
    this._addCascade = (this._addCascade + 1) % 6;
    const step = this._addCascade * 26;
    return { x: x + step, y: y + step };
  }

  /**
   * Canvas coordinates under the pointer for a drop event, so a dragged-in node lands where it
   * was dropped rather than at the viewport's centre. Measured against Drawflow's own
   * `precanvas` element, whose bounding rect already folds in the current pan offset - only the
   * zoom scale has to be divided back out.
   * @param {DragEvent} event
   * @returns {{x: number, y: number}}
   * @private
   */
  _pointFromEvent(event) {
    const rect = this._drawflow?.precanvas?.getBoundingClientRect?.();
    if (!rect) return this._defaultNodePoint();
    const zoom = this._drawflow?.zoom || 1;
    return { x: (event.clientX - rect.left) / zoom - 70, y: (event.clientY - rect.top) / zoom - 40 };
  }

  /**
   * Shared node-creation path for the palette's Add Element buttons (handleAddNode), the Tracks
   * pane's per-row "+" button (handleAddTrackNode), and drag-in from the sidebar
   * (_onDropExternal) - the NODE_DEFAULTS lookup + default-data clone + label assignment +
   * addNode() + resync + refresh sequence exists in exactly one place instead of being
   * duplicated across those three call sites.
   * @param {string} type
   * @param {object} [dataOverrides] - Merged over this type's default data (e.g. a Track's
   *   soundId, or a Playlist's playlistRef) before the node is created, so it never flashes onto
   *   the canvas unconfigured.
   * @param {{x: number, y: number}} [point]
   * @param {object} [options]
   * @param {boolean} [options.chain] - Pass false to suppress auto-chaining, for a caller that is
   *   about to wire this node up itself (dropping onto an edge - see _insertNodeOnEdge).
   * @returns {string|null} The new node's id, or null if the type is unknown or no canvas is mounted.
   * @private
   */
  _addNodeOfType(type, dataOverrides = {}, point, { chain = true } = {}) {
    const defaults = NODE_DEFAULTS[type];
    if (!this._drawflow || !defaults) return null;
    // Resolved before the node exists, so the new node can never be its own anchor.
    const anchor = chain && defaults.inputs > 0 ? this._chainAnchor() : null;
    const { x, y } = point || this._chainPoint(anchor) || this._defaultNodePoint();
    // Named on creation rather than left blank, so every node has something
    // stable to be referred to by (on the canvas, and in validation messages)
    // before anyone gets around to renaming it.
    const data = { ...foundry.utils.deepClone(defaults.data), ...dataOverrides, label: this._nextNodeLabel(type) };
    const nodeId = String(this._drawflow.addNode(type, defaults.inputs, defaults.outputs, x, y, `game-orchestra-node-${type}`, data, type));
    if (anchor) {
      // Fires 'connectionCreated', which resyncs and re-renders on its own; the calls below
      // are still unconditional because the unanchored path needs them. Both land in the same
      // synchronous task, so _recordHistory()'s end-of-task capture makes add-and-wire ONE
      // undo step rather than two - which is what a user pressing Ctrl+Z expects to undo.
      this._drawflow.addConnection(anchor.id, nodeId, 'output_1', 'input_1');
    }
    // Advance the chain so a run of adds builds a run of nodes. An End node has no output,
    // so it terminates the chain rather than leaving a dead anchor behind.
    this._chainAnchorId = defaults.outputs > 0 ? nodeId : null;
    this._syncFromDrawflow(this._drawflow);
    this._refreshNodeDisplay(nodeId);
    this._renderInspector();
    return nodeId;
  }

  /**
   * The node a new node should wire itself onto, or null to create an orphan as before.
   *
   * Building a sequence by hand used to cost two gestures per track - place the node, then
   * drag a wire to it - and the wire is pure ceremony when the node was just added onto the
   * end of a chain. Anchoring is deliberately conservative, because a wrong guess is worse
   * than no guess: the anchor must have **exactly one output port** and that port must be
   * **unconnected**.
   *
   * That excludes precisely the cases where the intended branch is ambiguous - a Fork (two
   * outputs from the start), a Random or Condition that has been given extra exits, and any
   * node whose single exit is already spoken for. It leaves the linear spine (Start, Track,
   * Delay, Playlist, and a fresh Random/Condition) where there is only one thing "connect
   * this" could mean.
   * @returns {{id: string}|null}
   * @private
   */
  _chainAnchor() {
    if (!this._chainAnchorId) return null;
    const node = this._liveNode(this._chainAnchorId);
    if (!node) return null;
    const ports = Object.keys(node.outputs || {});
    if (ports.length !== 1) return null;
    if ((node.outputs[ports[0]]?.connections || []).length > 0) return null;
    return { id: this._chainAnchorId };
  }

  /**
   * Canvas position one column to the right of the chain anchor, so an auto-wired node lands
   * where the wire can actually be read instead of at the viewport centre with its connection
   * doubling back across the canvas. Same column pitch the presets lay their graphs out on
   * (graph-builder.mjs), so a hand-built chain and a generated one look alike.
   * @param {{id: string}|null} anchor
   * @returns {{x: number, y: number}|null}
   * @private
   */
  _chainPoint(anchor) {
    if (!anchor) return null;
    const node = this._liveNode(anchor.id);
    if (!node) return null;
    return { x: (node.pos_x ?? 0) + COLUMN_WIDTH_PX, y: node.pos_y ?? 0 };
  }

  /**
   * Ctrl/Cmd+C copies the current selection's type + config per node (not
   * position, id, or wiring - a paste is always fresh, unconnected nodes);
   * Ctrl/Cmd+V pastes them as new nodes offset from the originals, preserving
   * their relative positions to each other. A rect-select (marquee)
   * selection takes priority over a single Drawflow-selected node if both
   * happen to be non-empty (shouldn't normally happen - selecting a single
   * node already clears the marquee selection - but priority still needs to
   * be well-defined). Ignored while an unrelated text field elsewhere on the
   * page has focus, so normal text copy/paste (e.g. in a Mood ID input) is
   * never intercepted.
   *
   * Delete/Backspace on a MARQUEE selection is handled here too - see
   * _deleteMultiSelection() for why Drawflow can't do it.
   * @param {KeyboardEvent} event
   * @private
   */
  _onKeyDown(event) {
    const active = document.activeElement;
    if (active && active !== document.body && !this.element?.contains(active)) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(active?.tagName)) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // A single Drawflow-selected node is Drawflow's OWN key handler's job (it deletes
      // this.node_selected on the same keys) - stay out of its way and only cover what it
      // cannot see. The two never overlap: selecting a single node clears the marquee.
      if (this._multiSelectedNodeIds.size === 0) return;
      event.preventDefault();
      this._deleteMultiSelection();
      return;
    }
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key?.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      this._copySelection();
    } else if (key === 'v') {
      event.preventDefault();
      this._pasteClipboard();
    } else if (key === 'z' || key === 'y') {
      // stopPropagation, not just preventDefault: Foundry's KeyboardManager
      // listens on WINDOW and ignores defaultPrevented entirely (checked
      // against the installed client source), and core registers Ctrl+Z as its
      // own uneditable "undo" binding - which, with a scene loaded, calls
      // canvas.activeLayer.undoHistory() and quietly reverts the GM's last
      // placeable edit. This listener is on document, below window, so
      // stopping propagation here is what keeps an undo in this window from
      // also being an undo out on the scene.
      event.preventDefault();
      event.stopPropagation();
      // Ctrl+Shift+Z and Ctrl+Y are the same command - both conventions are
      // in wide use and neither is wrong. `key` is already lowercased, which
      // is what makes the shifted 'Z' match.
      if (key === 'y' || event.shiftKey) this._redo();
      else this._undo();
    }
  }

  /**
   * Delete every marquee-selected node.
   *
   * Drawflow's own Delete/Backspace handler only ever removes `this.node_selected` - the single
   * node IT considers selected. A marquee selection is entirely this module's concept (see
   * editor-selection-mixin.mjs), and it deliberately leaves `node_selected` null, so pressing
   * Delete with several nodes rect-selected removed nothing at all.
   *
   * The Start node is skipped rather than removed, matching _copySelection(): a graph may only
   * have one, and dropping it silently out of a group delete would leave an unrunnable graph with
   * no indication of why.
   *
   * removeNodeId() takes the DOM id ('node-<n>'), not the bare numeric id - the same form
   * Drawflow passes itself from `this.node_selected.id`.
   * @private
   */
  _deleteMultiSelection() {
    if (!this._drawflow) return;
    const ids = [...this._multiSelectedNodeIds];
    let skippedStart = false;
    let removed = 0;
    for (const id of ids) {
      const node = this._liveNode(id);
      if (!node) continue;
      if (node.name === 'start') {
        skippedStart = true;
        continue;
      }
      // Fires 'nodeRemoved' per node, which resyncs and re-renders the inspector. Left as-is
      // rather than batched: a marquee selection is a handful of nodes, and routing every
      // removal through Drawflow's own path is what keeps the wires attached to them cleaned up.
      this._drawflow.removeNodeId(`node-${id}`);
      removed += 1;
    }
    if (skippedStart) ui.notifications?.warn(game.i18n.localize('GameOrchestra.CustomEditor.Canvas.CannotDeleteStart'));
    // Unconditional: the ids are gone from the canvas either way, and a stale set would leave
    // the next Delete trying to remove nodes that no longer exist.
    this._clearMultiSelection();
    if (removed === 0) return;
    this._syncFromDrawflow(this._drawflow);
    this._renderInspector();
  }

  /**
   * @private
   */
  _copySelection() {
    const ids = this._multiSelectedNodeIds.size > 0 ? [...this._multiSelectedNodeIds] : this.selectedNodeId ? [this.selectedNodeId] : [];
    if (ids.length === 0) return;

    const entries = [];
    let skippedStart = false;
    for (const id of ids) {
      const node = this._liveNode(id);
      if (!node) continue;
      if (node.name === 'start') {
        skippedStart = true; // only one Start is ever allowed - can't be copied, in a group or alone
        continue;
      }
      entries.push({
        type: node.name,
        data: foundry.utils.deepClone(node.data),
        outputCount: Object.keys(node.outputs || {}).length,
        x: node.pos_x ?? 0,
        y: node.pos_y ?? 0
      });
    }
    if (skippedStart) ui.notifications?.warn(game.i18n.localize('GameOrchestra.CustomEditor.Canvas.CannotCopyStart'));
    if (entries.length === 0) return;
    this._clipboard = entries;
    this._pasteOffset = 0;
  }

  /**
   * @param {{type: string, data: object, outputCount: number}} entry
   * @returns {number}
   * @private
   */
  _outputCountForPastedEntry({ type, data, outputCount }) {
    switch (type) {
      case 'end':
        return 0;
      case 'track':
      case 'playlist':
        return data.loop?.mode === 'forever' ? 0 : 1;
      case 'fork':
        return Math.max(2, outputCount || 2);
      case 'random':
      case 'condition':
        return Math.max(1, data.exits?.length ?? 1);
      default:
        return 1; // start, delay
    }
  }

  /**
   * Pastes every entry in the clipboard as a fresh node, offset from its
   * original position by the same shared amount - the group's relative
   * layout is preserved even though nothing about how they were wired to
   * each other is (a paste is always unconnected, single node or many).
   *
   * _syncFromDrawflow() (a full editor.export() + graph rebuild) runs once
   * after the loop rather than once per pasted node - labels still can't
   * collide within the same paste, since `usedLabels` is tracked locally and
   * seeded from the working graph before the loop starts.
   * @private
   */
  _pasteClipboard() {
    if (!this._clipboard?.length || !this._drawflow) return;
    this._pasteOffset += 30;
    const usedLabels = this.graph.nodes.map((n) => nodeDisplayLabel(n));
    const pastedNodeIds = [];
    for (const entry of this._clipboard) {
      const inputs = entry.type === 'start' ? 0 : 1;
      const outputs = this._outputCountForPastedEntry(entry);
      // A fresh name per paste: two nodes sharing one name would make every
      // validation message about either of them ambiguous.
      const label = nextNodeLabel(entry.type, usedLabels);
      usedLabels.push(label);
      const data = { ...foundry.utils.deepClone(entry.data), label };
      const nodeId = String(
        this._drawflow.addNode(
          entry.type,
          inputs,
          outputs,
          entry.x + this._pasteOffset,
          entry.y + this._pasteOffset,
          `game-orchestra-node-${entry.type}`,
          data,
          entry.type
        )
      );
      pastedNodeIds.push(nodeId);
    }
    if (pastedNodeIds.length === 0) return;
    this._syncFromDrawflow(this._drawflow);
    const lookup = this._buildGraphLookup();
    for (const nodeId of pastedNodeIds) this._refreshNodeDisplay(nodeId, lookup);
    // Selects the new nodes and renders the inspector for them, replacing the
    // bare _renderInspector() this used to end with. Repeated pastes therefore
    // stack: each one leaves its own output selected, so Ctrl+V twice copies the
    // first paste's originals again, not the paste of the paste - the clipboard
    // itself is never touched here.
    this._selectNodes(pastedNodeIds);
  }

  /**
   * Internal delegated change-event listener for inspector inputs, mirroring
   * GameOrchestraConfig._onChangeInput (app.mjs).
   * @param {Event} event
   * @private
   */
  _onChangeInput(event) {
    dispatchChangeAction(this, event);
  }

  /**
   * Rebuild the inspector panel's contents in place from the current graph
   * state. Deliberately a direct DOM update, never this.render() - see the
   * class doc for why a full ApplicationV2 re-render here breaks dragging.
   * @private
   */
  _renderInspector() {
    const context = this._prepareContext({});
    const { validation, selectedNode, soundOptions, playlistOptions, overlayOptions, moodOptions, phaseOptions, selectedExits } = context;
    const container = this.element?.querySelector('.game-orchestra-editor-inspector');
    if (container) {
      // The hovered row is about to be replaced; its canvas-side highlight would
      // otherwise be stranded with nothing left to clear it.
      this._clearExitHover();
      container.innerHTML = buildInspectorHtml({
        selectedNode,
        soundOptions,
        playlistOptions,
        overlayOptions,
        moodOptions,
        phaseOptions,
        selectedExits,
        localize: localizeIssue
      });
    }
    this._refreshIssueBadges(validation);
    this._renderTracks();
    this._renderValidation(validation);
  }

  /**
   * Rebuild the Tracks pane in place.
   *
   * ONE pane, doing two jobs: the playlist's track list (drag a row onto the canvas, or press its
   * `+`) and its mixer (volume, mute, solo, the playlist's gain/ceiling/crossfade). They were two
   * panes and are one because they answer questions about the same rows - "which of these haven't
   * I placed?" and "why is this one so loud?" - and in a single-open accordion, two panes meant
   * switching back and forth to compare.
   *
   * Rendered by MixerController in its compact + graph-tools flavour, by direct innerHTML, never
   * through this.render(). That is not merely consistency with _renderInspector(): the controller
   * refreshes itself after a mute, a row selection, a settled slider - several times a minute in
   * use - and a full re-render at any of those moments detaches the live Drawflow canvas and
   * silently kills whatever drag is in progress (HR-A).
   *
   * The controller is given the WORKING graph, not the saved flag, so a Track node added a second
   * ago is already counted.
   * @private
   */
  _renderTracks() {
    const container = this.element?.querySelector('.game-orchestra-editor-tracks');
    if (!container) return;
    this._mixer ??= new MixerController({
      playlistId: this.playlist?.id,
      getPlaylist: () => this.playlist,
      onRefresh: () => this._renderTracks(),
      compact: true,
      graphTools: true,
      // Off here: arrows, M and S belong to the canvas in this window, and a pane quietly
      // stealing them would be worse than not having them.
      keyboard: false,
      getGraph: () => this.graph,
      // Every settled level change becomes an undo step, exactly like a node edit - they are
      // made in the same pane, and a Ctrl+Z that covered only half of it would be worse than one
      // that covered none.
      onCommit: () => this._recordHistory()
    });
    container.innerHTML = this._mixer.buildHtml();
    // Delegated on this container, which survives the innerHTML write above, so this is a no-op
    // after the first call rather than a stacking rebind.
    this._mixer.attach(container);
    // CONFIRMED LIVE (when this pane was a plain track list): without this, dragging a track onto
    // the canvas worked exactly once - until the first refresh - and then silently stopped, with
    // no console error.
    //
    // Foundry's DragDrop#bind() is not delegated: it walks dragSelector once, at call time, and
    // assigns `element.ondragstart` on each row it finds right then. The line above replaces every
    // one of those rows, so the handlers go with them. _onRender()'s own _setupDragDrop() call
    // can't cover this - it fires once per window, while this method reruns on every selection
    // change, node add, label edit, and now every level change too.
    //
    // Rebinding here is safe to repeat because bind() ASSIGNS the on* properties rather than
    // addEventListener-ing them (checked against the installed client source), so the canvas's
    // drop handlers are overwritten, not stacked - a stacked drop would create one node per
    // accumulated binding.
    this._setupDragDrop();
  }

  /**
   * Rebuild the pinned validation region below the accordion panel - kept outside every
   * `.game-orchestra-pane` (see docs/graph-editor-panel-plan.md D4) so a failed Save's reasons stay
   * visible even while the Properties pane is collapsed.
   * @param {{errors: Array, warnings: Array, infos: Array}} [validation]
   * @private
   */
  _renderValidation(validation) {
    const container = this.element?.querySelector('.game-orchestra-editor-validation');
    if (!container) return;
    const resolved = validation ?? this._prepareContext({}).validation;
    const html = buildValidationHtml({ validation: resolved, localize: localizeIssue });
    container.innerHTML = html;
    container.style.display = html ? '' : 'none';
  }

  /**
   * Mark every node that has a validation issue: a badge at its corner, plus a
   * state class that colours the whole node amber/red (see the
   * .game-orchestra-node-warning/.game-orchestra-node-error rules in game-orchestra.css). Colouring
   * the node itself, not only an 18px dot, is what makes an invalid graph
   * legible without hunting - and is why node borders no longer carry a
   * per-type colour, which would otherwise compete with it.
   *
   * Refreshed here, from the inspector render, because validation is a property
   * of the whole graph: wiring one node up can clear a warning on a completely
   * different one, so badges can never be maintained per-node from
   * _refreshNodeDisplay(). The badge and the state class both go on the node
   * element itself and not on its content, which _refreshNodeDisplay() replaces
   * wholesale - a class written there would silently disappear on the next
   * content refresh.
   * @param {{errors: Array, warnings: Array}} validation
   * @private
   */
  _refreshIssueBadges(validation) {
    if (!this._drawflow?.container || typeof document?.createElement !== 'function') return;
    const severityByNode = new Map();
    const messagesByNode = new Map();
    const record = (issue, severity) => {
      // An issue about a RELATIONSHIP between nodes (a cycle) carries every
      // node it implicates in nodeIds; marking only the anchor would leave the
      // rest of the loop looking innocent. Single-node issues carry nodeId
      // alone and are unaffected.
      const nodeIds = issue?.nodeIds ?? (issue?.nodeId ? [issue.nodeId] : []);
      if (!nodeIds.length) return;
      const message = localizeIssue(issue.messageKey, issue.messageData);
      for (const nodeId of nodeIds) {
        // An error outranks a warning on the same node - it's the one that
        // actually blocks saving.
        if (severity === 'error' || !severityByNode.has(nodeId)) severityByNode.set(nodeId, severity);
        messagesByNode.set(nodeId, [...(messagesByNode.get(nodeId) || []), message]);
      }
    };
    for (const warning of validation?.warnings || []) record(warning, 'warning');
    for (const error of validation?.errors || []) record(error, 'error');

    // Kept for the balloon, which is opened later by a click and so can't be
    // handed the messages directly - and must never re-derive them itself, or
    // it could show a different answer than the badge it hangs off.
    this._issueMessages = messagesByNode;

    for (const node of this.graph.nodes) {
      const nodeEl = this._nodeElement(node.id);
      if (!nodeEl) continue;
      let badge = nodeEl.querySelector?.('.game-orchestra-node-issue');
      const severity = severityByNode.get(node.id);
      nodeEl.classList?.remove?.(ISSUE_STATE_CLASSES.warning, ISSUE_STATE_CLASSES.error);
      if (!severity) {
        badge?.remove?.();
        continue;
      }
      nodeEl.classList?.add?.(ISSUE_STATE_CLASSES[severity]);
      if (!badge) {
        badge = document.createElement('div');
        nodeEl.appendChild?.(badge);
      }
      // Rewritten every pass, not only on creation: a node can go from warning
      // to error (or back) without its badge being removed in between, and the
      // glyph is half of what distinguishes the two.
      badge.innerHTML = `<i class="fas ${ISSUE_BADGE_ICONS[severity]}"></i>`;
      badge.className = `game-orchestra-node-issue game-orchestra-node-issue-${severity}`;
      badge.dataset.nodeId = node.id;
      badge.dataset.severity = severity;
      // Left in place alongside the balloon: hovering still answers "what's
      // wrong here" without a click, and it's the fallback if the balloon
      // can't open (no document, mid-teardown).
      badge.title = (messagesByNode.get(node.id) || []).join('\n');
    }

    // A node whose issues just cleared may be the one the open balloon belongs
    // to, and a balloon still showing resolved problems is worse than none.
    if (this._issueBalloonNodeId && !severityByNode.has(this._issueBalloonNodeId)) this._closeIssueBalloon();

    this._refreshIssueEdges(validation);
  }

  /**
   * Colour the connections named by any issue's `edgeIds`.
   *
   * Badging the nodes is not enough for a cycle: on a canvas with more wires
   * than fit the viewport, "these four nodes form a loop" still leaves the
   * reader tracing curves by hand to find WHICH of their exits closes it - and
   * a Fork's exits all leave from the same node. Painting the loop's own edges
   * is what turns the error from a true statement into a place to click.
   *
   * Repainted from scratch each pass (rather than diffed like the activity
   * highlight) because validation is a whole-graph property - one rewire can
   * move the cycle somewhere else entirely.
   * @param {{errors: Array, warnings: Array}} validation
   * @private
   */
  _refreshIssueEdges(validation) {
    const container = this._drawflow?.container;
    if (!container) return;
    clearMarkers(container, ISSUE_EDGE_ATTR);

    const edgeIds = new Set();
    for (const issue of [...(validation?.errors || []), ...(validation?.warnings || [])]) {
      for (const id of issue?.edgeIds || []) edgeIds.add(id);
    }
    if (!edgeIds.size) return;

    for (const edge of this.graph?.edges || []) {
      if (!edgeIds.has(edge.id)) continue;
      // Same EdgeRef shape (and same port-less over-highlight fallback) the
      // activity highlight uses - see edgeSelector()'s doc comment.
      for (const el of this._connectionElements({ from: edge.from, to: edge.to, port: portFromEdgeId(edge.id) })) {
        setMarker(el, ISSUE_EDGE_ATTR, true);
      }
    }
  }

  /**
   * Open (or close, if it's already this node's) the balloon listing every
   * validation message for one node - Grasshopper's warning balloon, which
   * puts a component's messages next to the component instead of only in a
   * panel somewhere else. The pinned validation region keeps its own role as
   * the whole graph's list; this answers "what is wrong with THIS node".
   * @param {string} nodeId
   * @param {HTMLElement} badgeEl - The badge clicked, used to position the balloon.
   * @private
   */
  _toggleIssueBalloon(nodeId, badgeEl) {
    if (this._issueBalloonNodeId === nodeId) return this._closeIssueBalloon();
    this._closeIssueBalloon();
    const html = buildIssueBalloonHtml(this._issueMessages?.get(nodeId) || [], badgeEl?.dataset?.severity);
    if (!html || typeof document?.createElement !== 'function') return;

    const balloon = document.createElement('div');
    balloon.className = 'game-orchestra-issue-balloon';
    balloon.innerHTML = html;
    document.body.appendChild(balloon);
    // Screen coordinates, and position:fixed on document.body rather than
    // inside the canvas: .game-orchestra-drawflow-canvas is overflow:hidden, so a
    // balloon parented there would be clipped exactly when the badge is near
    // an edge - which is when it most needs to escape. The cost is that
    // Drawflow's pan/zoom transform doesn't carry it along, which is why the
    // editor closes it on zoom/translate/nodeMoved instead of re-anchoring.
    const rect = badgeEl?.getBoundingClientRect?.();
    if (rect) {
      balloon.style.left = `${rect.right + 8}px`;
      balloon.style.top = `${rect.top}px`;
      // Flip to the badge's other side when the default position would run off
      // the right edge of the window.
      const balloonWidth = balloon.offsetWidth || 0;
      if (rect.right + 8 + balloonWidth > (window.innerWidth || 0)) {
        balloon.style.left = `${Math.max(rect.left - 8 - balloonWidth, 0)}px`;
      }
    }
    this._issueBalloonEl = balloon;
    this._issueBalloonNodeId = nodeId;
  }

  /**
   * Escape closes the issue balloon, and only the balloon.
   *
   * A dedicated listener rather than a branch in _onKeyDown(), for two
   * reasons. It has to run in the CAPTURE phase: Escape on an open Foundry
   * window normally closes that window, and the only way to reliably get in
   * first - without depending on which handler Foundry registered where, or in
   * what order - is to capture on document before the event reaches anything
   * else. And _onKeyDown is a bubble-phase listener whose Ctrl+C/Ctrl+V
   * ordering shouldn't be disturbed just to add an unrelated key.
   *
   * Both propagation and the default are stopped ONLY when a balloon was
   * actually open, so Escape still closes the window every other time.
   * @param {KeyboardEvent} event
   * @private
   */
  _onEscapeKey(event) {
    if (event.key !== 'Escape' || !this._issueBalloonNodeId) return;
    this._closeIssueBalloon();
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  /**
   * Remove the issue balloon, if one is open. Safe to call unconditionally -
   * it runs from several unrelated dismissal paths (outside click, Escape,
   * pan/zoom/drag, validation refresh, window close).
   * @private
   */
  _closeIssueBalloon() {
    this._issueBalloonEl?.remove?.();
    this._issueBalloonEl = null;
    this._issueBalloonNodeId = null;
  }

  /**
   * Document-level click: opens a node's issue balloon when its badge is
   * clicked, and dismisses an open one on any other click.
   *
   * Bound on document rather than this.element so a click anywhere else on the
   * page dismisses it too. Deliberately does NOT stopPropagation() on a badge
   * click - the badge sits inside the node element, so the same click has to
   * keep reaching Drawflow and selecting the node underneath, which is
   * existing behaviour a user relies on to open that node's properties.
   * @param {MouseEvent} event
   * @private
   */
  _onDocumentClick(event) {
    const badge = event.target?.closest?.('.game-orchestra-node-issue');
    if (badge) {
      const nodeId = badge.dataset?.nodeId;
      if (nodeId) this._toggleIssueBalloon(nodeId, badge);
      return;
    }
    // A click inside the balloon itself (scrolling it, selecting a message)
    // must not dismiss the thing being read.
    if (event.target?.closest?.('.game-orchestra-issue-balloon')) return;
    this._closeIssueBalloon();
  }

  /**
   * Bring a node into view and select it. Bound to the validation list, where
   * an issue naming a node is only actionable if you can get to that node -
   * which on a graph bigger than the viewport may mean scrolling blind.
   */
  static handleFocusNode(event, target) {
    event?.preventDefault?.();
    const nodeId = (target.closest?.('[data-node-id]') || target)?.dataset?.nodeId;
    if (nodeId) this._focusNode(nodeId);
  }

  /**
   * Pan the canvas so a node sits in the middle of the viewport, then select it.
   *
   * Writes Drawflow's own pan offsets and transform rather than going through
   * any of its methods - it exposes no "scroll to node" of its own, and its
   * panning only ever happens as a side effect of a drag. The transform string
   * mirrors zoom_refresh()'s exactly, so a later zoom picks up from here
   * correctly instead of snapping back.
   * @param {string} nodeId
   * @private
   */
  _focusNode(nodeId) {
    const editor = this._drawflow;
    const nodeEl = this._nodeElement(nodeId);
    if (!editor || !nodeEl) return;
    const zoom = editor.zoom || 1;
    const record = this._nodeRecord(nodeId);
    // Node positions are unscaled canvas coordinates; the viewport is in screen
    // pixels, hence the zoom factor on the node side of the sum only.
    const centreX = (record?.pos_x ?? 0) + (nodeEl.offsetWidth || 0) / 2;
    const centreY = (record?.pos_y ?? 0) + (nodeEl.offsetHeight || 0) / 2;
    editor.canvas_x = (editor.container?.clientWidth || 0) / 2 - centreX * zoom;
    editor.canvas_y = (editor.container?.clientHeight || 0) / 2 - centreY * zoom;
    if (editor.precanvas?.style) {
      editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${zoom})`;
    }
    this._selectSingleNode(nodeId);
  }

  /**
   * Mount a Drawflow instance into this window's canvas container and
   * populate it from the current working graph. Only ever mounts once per
   * window lifetime (idempotent) - _onRender now only fires once under normal
   * operation since no handler in this class calls this.render() after the
   * initial open, but this guard is defense in depth against any other
   * trigger of a re-render tearing down an in-progress interaction the same
   * way the 'nodeSelected' bug did (see class doc).
   * @private
   */
  _mountDrawflow() {
    if (this._drawflow) return;
    // Drawflow must own this element's entire classList (see the template's
    // comment on [data-drawflow-mount] for why) - it must not be an element
    // that already carries one of our own CSS classes.
    const container = this.element?.querySelector('[data-drawflow-mount]');
    if (!container || typeof Drawflow === 'undefined') {
      if (typeof Drawflow === 'undefined') log(1, 'CustomPlaylistEditor: the Drawflow library was not found on window - is scripts/vendor/drawflow.min.js loading?');
      return;
    }
    container.innerHTML = '';
    const editor = new Drawflow(container);
    editor.reroute = true;
    editor.start();
    // Set before import/refresh below so _refreshNodeDisplay() (which reads
    // this._drawflow) works during initial mount, not just on later edits.
    this._drawflow = editor;
    // Drawflow's drag math divides by the container's live clientWidth/clientHeight;
    // 0 in either produces silent NaN offsets (no console error, nodes just don't
    // move). Logged at debug level so a report of "nodes won't drag" can be
    // diagnosed from this number alone instead of requiring a DevTools session.
    log(3, `CustomPlaylistEditor: drawflow canvas mounted at ${container.clientWidth}x${container.clientHeight}px`);
    editor.import(graphToDrawflowExport(this.graph));
    this._refreshAllNodeDisplays();
    this._refreshUncertainEdges();
    // Stamped here as well as from the 'zoom' subscription below, because that
    // event only fires on a CHANGE - a window restored at a non-default zoom
    // would otherwise start with no tier attribute at all.
    this._applyZoomTier(editor.zoom);

    // Every zoom path funnels through Drawflow's zoom_refresh(), which
    // dispatches this - zoom_in/zoom_out/zoom_reset AND ctrl+wheel. Subscribing
    // to the event rather than patching this class's three toolbar handlers is
    // what makes wheel zoom work too.
    editor.on('zoom', (zoom) => {
      this._applyZoomTier(zoom);
      // The balloon is positioned in screen coordinates and doesn't ride the
      // canvas transform - see _toggleIssueBalloon.
      this._closeIssueBalloon();
    });
    // Panning moves nodes out from under the balloon for the same reason.
    editor.on('translate', () => this._closeIssueBalloon());

    editor.on('nodeSelected', (id) => {
      this._clearMultiSelection(); // a real single-select supersedes any marquee selection
      this.selectedNodeId = String(id);
      // Clicking a node re-points the chain (_chainAnchor): "select this, then add" is the
      // one gesture that says where the next node belongs, and it is also how a user breaks
      // out of a chain to start a new branch elsewhere.
      this._chainAnchorId = this.selectedNodeId;
      // The one automatic pane move in this window: a newly-selected node's
      // properties should be visible without an extra click. Under the single-open
      // accordion (handleTogglePane) this does now collapse whatever the user had
      // open, superseding docs/graph-editor-panel-plan.md D2 - acceptable because
      // it is driven by an explicit CLICK on a node. Adding a node never selects it
      // (_addNodeOfType), so dragging track after track out of the Tracks pane
      // leaves that pane open throughout.
      this._setPaneCollapsed('properties', false);
      this._renderInspector();
    });
    editor.on('nodeUnselected', () => {
      this.selectedNodeId = null;
      // Clicking empty canvas ends the chain: the next node added is an orphan again. Without
      // this, deselecting would leave adds silently wiring onto a node nothing is highlighting.
      this._chainAnchorId = null;
      this._renderInspector();
    });
    const resync = () => this._syncFromDrawflow(editor);
    // Drawflow redraws every path touching the dragged node on each frame of
    // the drag, restoring its own curve, so the routing has to be reapplied
    // per frame - not just on nodeMoved (which fires once, on release). Without
    // this the wires visibly flip to Drawflow's shape for the whole drag and
    // only snap back on mouse-up. 'mouseMove' is dispatched at the end of
    // Drawflow's own position() handler, after it has moved the node and
    // updated the connections, so by here the paths are current.
    editor.on('mouseMove', () => {
      if (!editor.drag) return;
      const draggedId = editor.ele_selected?.id?.slice(5); // 'node-<id>'
      if (!draggedId) return;
      this._restyleNodeWires(draggedId);
    });

    this._installRemovalHealing(editor);

    editor.on('nodeMoved', (id) => {
      resync();
      this._closeIssueBalloon(); // the node it points at has moved out from under it
      // Dragging doesn't route through _refreshNodeDisplay(), so a moved node's
      // routing and self-loop arc need reapplying here - Drawflow recalculates
      // its own default path on every drag frame, which would otherwise
      // silently replace both.
      this._restyleNodeWires(String(id));
    });
    editor.on('nodeRemoved', () => {
      this.selectedNodeId = null;
      // The removed node may well BE the anchor (Delete acts on the selection, and selecting
      // is what sets the anchor). _chainAnchor() re-looks-up the node and would return null
      // anyway, but clearing here keeps the two fields telling the same story.
      this._chainAnchorId = null;
      resync();
      this._renderInspector();
    });
    // A new/removed connection can change a Fork/Random/Condition source
    // node's exit count, which its rendered detail line summarizes.
    // Wiring nodes up is the main way validation results change - most
    // warnings are about what is or isn't connected - so the inspector (and
    // with it the canvas issue badges) has to be refreshed here too, not just
    // on the mutations that go through this class's own handlers.
    // Completing (or removing) a connection makes Drawflow call
    // updateConnectionNodes() for BOTH endpoint nodes, and each of those
    // redraws every wire touching that node in EITHER direction - not just the
    // one wire that changed. So the target node's other wires lose their
    // routing too, and restyling only the source left them drawn with
    // Drawflow's default curve until something else happened to move them.
    // Confirmed live: connecting a wire re-oriented an unrelated one, and
    // dragging the node put it right again.
    const onConnectionChanged = (info) => {
      resync();
      this._refreshNodeDisplay(String(info.output_id));
      this._restyleNodeWires(String(info.input_id));
      // Drawflow builds a brand-new <svg class="connection"> for each wire it
      // draws, so the uncertainty class has to be reapplied here - it isn't
      // carried over from anything.
      this._refreshUncertainEdges();
      // The hovered wire's <svg> is one of the ones Drawflow just replaced, so
      // whatever this holds is stale by now. Dropping it un-reveals its ports
      // and lets the next mouseover pick up the new element.
      this._setHoveredWire(null);
      this._renderInspector();
    };
    editor.on('connectionCreated', onConnectionChanged);
    editor.on('connectionRemoved', onConnectionChanged);

    // Seed the undo history with the graph as opened, so the first edit has
    // something to come back to. Nothing above this point is undoable, and the
    // import() a few lines up deliberately isn't: it isn't an edit, it's the
    // starting position. Last in the mount, so the seed matches what the user
    // is actually looking at.
    this._history.reset(this._captureSnapshot());
    this._updateHistoryButtons();
  }

  /**
   * Make deleting a node out of the middle of a chain heal the gap: removing the Delay from
   * `A -> Delay -> B` leaves `A -> B` instead of two loose ends.
   *
   * Implemented by **wrapping `removeNodeId()`** rather than listening for `nodeRemoved`, because
   * by the time that event fires the node's connections are already gone - the neighbours have to
   * be read while the node still knows about them.
   *
   * Wrapping is also what makes this cover every removal path from one place. Drawflow's own
   * Delete/Backspace handler calls `this.removeNodeId(this.node_selected.id)` internally and we
   * never see that keypress (HR-A's cousin: we deliberately stay out of its way for a single
   * selection - see _onKeyDown), and _deleteMultiSelection() calls the same public method. A
   * listener would have missed the first; a change at our own call site would have missed it too.
   *
   * Deleting a contiguous run composes correctly, one healing per removal: with `A->B->C->D` and
   * both B and C selected, removing B gives `A->C` and removing C then gives `A->D`.
   *
   * `removeNodeId()` takes the DOM id ('node-<n>'); everything else here uses the bare id.
   * @param {object} editor - The mounted Drawflow instance.
   * @private
   */
  _installRemovalHealing(editor) {
    const original = editor.removeNodeId.bind(editor);
    editor.removeNodeId = (domId) => {
      const bypass = this._historySuspended ? null : planNodeBypass(this._liveNode(String(domId).slice(5)));
      original(domId);
      // After the removal, so the wire is drawn between two nodes that still exist and no port is
      // briefly holding a connection to a node on its way out.
      if (bypass) editor.addConnection(bypass.from, bypass.to, bypass.outputPort, bypass.inputPort);
    };
  }

  /**
   * Tag the canvas with the current level of node detail, which CSS uses to
   * hide per-node text once it's too small to read - see zoomTier() and the
   * `[data-zoom-tier]` rules in game-orchestra.css. An attribute on one element, so a
   * zoom costs a single DOM write no matter how many nodes are on the canvas
   * (and, as everywhere else in this class, never a re-render).
   * @param {number} zoom - Drawflow's current zoom factor.
   * @private
   */
  _applyZoomTier(zoom) {
    const canvasEl = this.element?.querySelector?.('.game-orchestra-drawflow-canvas');
    if (canvasEl) canvasEl.dataset.zoomTier = zoomTier(zoom);
  }

  /**
   * Mark the wires that leave a Random or Condition node, which take only one
   * of their exits, so they read as conditional rather than as guaranteed
   * flow - see uncertainEdges() for the rule and the
   * `[data-go-edge-uncertain]` rule in game-orchestra.css for the treatment.
   *
   * Cleared and reapplied wholesale rather than diffed: a single node changing
   * type would otherwise leave stale markers behind, and the wire count here
   * is bounded by the size of a hand-authored graph.
   * @private
   */
  _refreshUncertainEdges() {
    const container = this._drawflow?.container;
    if (!container?.querySelectorAll) return;
    clearMarkers(container, UNCERTAIN_EDGE_ATTR);
    for (const edge of uncertainEdges(this.graph)) {
      for (const el of container.querySelectorAll(edgeSelector(edge))) setMarker(el, UNCERTAIN_EDGE_ATTR, true);
    }
  }

  /**
   * Point out on the canvas which exit an inspector row belongs to: its output
   * port, plus the wire leaving that port if it's connected to anything.
   *
   * A single delegated mouseover, resolving whatever is under the pointer to
   * an exit row (or to nothing), rather than per-row enter/leave pairs - rows
   * are rebuilt on every inspector render, so per-element listeners would have
   * to be rebound each time and could leave a highlight stranded when their
   * element disappears mid-hover.
   * @param {MouseEvent} event
   * @private
   */
  _onExitHover(event) {
    const row = event.target?.closest?.('[data-exit-port]');
    this._setHoveredExit(row?.dataset?.nodeId || null, row?.dataset?.exitPort || null);
  }

  /**
   * @param {string|null} nodeId
   * @param {string|null} portName - Drawflow output port, e.g. 'output_2'.
   * @private
   */
  _setHoveredExit(nodeId, portName) {
    if (this._hoveredExit?.nodeId === nodeId && this._hoveredExit?.portName === portName) return;
    this._clearExitHover();
    if (!nodeId || !portName) return;
    setMarker(this._drawflow?.container?.querySelector?.(`#node-${nodeId} .outputs .output.${portName}`), PORT_HOVER_ATTR, true);
    // No `to`: this asks for whatever that port is wired to, which the
    // inspector has no need to know (and an unwired port simply matches nothing).
    for (const el of this._drawflow?.container?.querySelectorAll?.(edgeSelector({ from: nodeId, port: portName })) || []) {
      setMarker(el, EDGE_HOVER_ATTR, true);
      // Highlighting the wire reveals what it lands ON as well, so the row
      // answers "and where does it go?" without a second look. Shares
      // PORT_REVEAL_ATTR with the canvas-side wire hover above; the two never
      // overlap in practice (the pointer is either in the inspector or on the
      // canvas, and moving between them fires this side's mouseleave first).
      this._setWirePortsRevealed(el, true);
    }
    this._hoveredExit = { nodeId, portName };
  }

  /**
   * @private
   */
  _clearExitHover() {
    const hovered = this._hoveredExit;
    if (!hovered) return;
    this._hoveredExit = null;
    const container = this._drawflow?.container;
    setMarker(container?.querySelector?.(`#node-${hovered.nodeId} .outputs .output.${hovered.portName}`), PORT_HOVER_ATTR, false);
    for (const el of container?.querySelectorAll?.(edgeSelector({ from: hovered.nodeId, port: hovered.portName })) || []) {
      setMarker(el, EDGE_HOVER_ATTR, false);
      this._setWirePortsRevealed(el, false);
    }
  }

  /**
   * Lift both ports of the wire under the pointer out of their tucked-in
   * resting size, so a wire you are inspecting shows you exactly which two
   * ports it joins. The rest of the canvas stays tucked.
   *
   * Only reachable from JS: the wire is an `<svg>` sibling of the nodes, and
   * CSS has no way to select from a hovered element into two arbitrary
   * elsewhere-in-the-tree descendants.
   * @param {MouseEvent} event
   * @private
   */
  _onWireHover(event) {
    // `.connection` carries pointer-events:none and only its `.main-path`
    // child is hit-testable, so the pointer lands on the path and this walks
    // back up to the connection that owns the endpoint classes.
    this._setHoveredWire(event.target?.closest?.('.connection') || null);
  }

  /**
   * @param {Element|null} connectionEl
   * @private
   */
  _setHoveredWire(connectionEl) {
    const next = connectionEl || null;
    if (this._hoveredWire === next) return;
    // Cleared from the OLD element, even if Drawflow has since
    // detached it (deleting a wire while hovering it does exactly that): a
    // detached <svg> still knows which ports it used to join, and those ports
    // are still in the document waiting to be un-revealed.
    this._setWirePortsRevealed(this._hoveredWire, false);
    this._hoveredWire = next;
    this._setWirePortsRevealed(next, true);
  }

  /**
   * @param {Element|null} connectionEl
   * @param {boolean} revealed
   * @private
   */
  _setWirePortsRevealed(connectionEl, revealed) {
    if (!connectionEl) return;
    const selectors = connectionPortSelectors(connectionEl.classList);
    if (!selectors) return;
    const container = this._drawflow?.container;
    for (const selector of [selectors.output, selectors.input]) {
      setMarker(container?.querySelector?.(selector), PORT_REVEAL_ATTR, revealed);
    }
  }

  /**
   * Refresh a single node's visible content (icon + detail line) and, for
   * Fork/Random's "vertical bar" shape, its height - on the canvas, to
   * reflect its current data. E.g. a Track node's detail line shows the
   * selected sound's name and loop count; a Fork/Random node's bar grows
   * taller as exits are added, giving each stacked output port more room. A
   * direct DOM update via plain innerHTML/inline style, not Drawflow's df-*
   * binding: that binding only writes an element's `.value`, which has no
   * visual effect on anything but actual form controls, not the read-only
   * content this renders.
   * @param {string} nodeId
   * @param {{nodesById: Map, edgesByFrom: Map}} [lookup] - Pre-built lookups from
   *   _buildGraphLookup(), so a caller refreshing every node in the graph builds
   *   them once instead of this method re-scanning this.graph.nodes/edges per call.
   *   Omitted for single-node refreshes (paste, exit add/remove), which scan directly.
   * @private
   */
  _refreshNodeDisplay(nodeId, lookup) {
    if (!this._drawflow) return;
    const node = lookup ? lookup.nodesById.get(nodeId) : this.graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const soundName = node.type === 'track' && node.soundId ? this.playlist?.sounds?.get(node.soundId)?.name : undefined;
    const refLabel = node.type === 'playlist' ? this._describePlaylistRefForNode(node) : undefined;
    let exitCount = lookup ? (lookup.edgesByFrom.get(nodeId)?.length ?? 0) : this.graph.edges.filter((e) => e.from === nodeId).length;
    // An expandable node's exit count reflects the number of output PORTS
    // (slots), not wired connections: the shape must grow taller the instant an
    // exit is added, so there is somewhere to drag the new wire TO, not only
    // once it is connected.
    const liveNode = this._liveNode(nodeId);
    if (EXPANDABLE_EXIT_NODE_TYPES.has(node.type)) {
      exitCount = liveNode ? Object.keys(liveNode.outputs || {}).length : exitCount;
    }
    const detail = computeNodeDetail(node, { soundName, refLabel, exitCount, localize: localizeIssue });
    const contentEl = this._drawflow.container?.querySelector(`#node-${nodeId} .drawflow_content_node`);
    if (contentEl) {
      contentEl.innerHTML = buildNodeInnerHtml(node.type, detail, { label: nodeDisplayLabel(node) });
      // The line above threw away the drain overlay along with everything else
      // inside the node, so a Delay or Track counting down right now goes blank
      // and stays blank until the engine's next broadcast - which, mid-track,
      // is the whole length of that track away. Reported live: editing any
      // field on a playing Track node made its progress fill disappear.
      // Re-armed from the timing already in hand rather than waiting; it
      // carries startedAt, so it resumes at the right point rather than
      // restarting.
      const timing = this._activityHighlight?.activeTimings?.find((t) => t.nodeId === nodeId);
      if (timing) this._setNodeDrain(nodeId, timing);
    }
    const heightPx = computeNodeHeightPx(node.type, exitCount);
    const nodeEl = this._drawflow.container?.querySelector(`#node-${nodeId}`);
    if (nodeEl) {
      nodeEl.style.height = heightPx ? `${heightPx}px` : '';
      this._refreshExitAdder(node, nodeEl);
      this._refreshExitChips(node, nodeId, liveNode);
      // Resizing a node via inline style is a plain DOM mutation Drawflow's
      // own wire-drawing code has no way to know about - it only recomputes
      // connection paths in response to its own drag/connect events, so
      // without this call, a node's ports visibly move when it grows but the
      // SVG wires stay drawn at their old (now wrong)
      // coordinates. This forces a recompute for every connection touching
      // this node, in either direction.
      this._drawflow.updateConnectionNodes?.(`node-${nodeId}`);
    }
    // Must run AFTER updateConnectionNodes() above: that call is what resets
    // every path touching this node back to Drawflow's own default curve in
    // the first place, so re-styling has to happen last, not before.
    this._restyleNodeWires(nodeId);
  }

  /**
   * Give a node whose exits are expandable (EXPANDABLE_EXIT_NODE_TYPES) a "+"
   * button at its top-LEFT corner, so an exit can be added straight on the
   * canvas without the node being selected and the left panel switching to
   * Properties. It dispatches the existing `addExit` action, so a click here
   * and the inspector's own "Add Exit" run identical code (handleAddExit,
   * including _addConditionExit's fallback-stays-last handling).
   *
   * Three things about it are load-bearing:
   *
   * 1. It is a child of the NODE element, a sibling of .drawflow_content_node -
   *    never inside it. Drawflow's mousedown re-targets anything inside the
   *    content up to the node ("ele_selected = closest('.drawflow_content_node')
   *    .parentElement", read out of the vendored source) and then matches
   *    classList[0] === 'drawflow-node', which fires nodeSelected and sets
   *    drag = true. nodeSelected auto-opens the Properties pane - exactly what
   *    this button exists to avoid - and the drag would move the node under a
   *    click meant for a button. Outside the content, ele_selected stays the
   *    button itself and its class matches none of Drawflow's cases, so the
   *    switch falls through: no selection, no drag, no connection. Same
   *    mechanism the issue badge already relies on. See ADD_EXIT_CLASS.
   * 2. It therefore also SURVIVES _refreshNodeDisplay()'s innerHTML replacement
   *    of the content, which is what the drain overlay above does not (see the
   *    re-arm there) - so there is nothing to rebuild per refresh.
   * 3. Top-left, not on the exit side. Both expandable shapes grow away from
   *    their fixed top-left origin - Fork/Random 26px taller per exit
   *    (BAR_HEIGHT_PER_EXIT_PX), Condition 52px wider (CONDITION_WIDTH_PER_BRANCH_PX)
   *    - so a button anchored anywhere near the ports walks out from under the
   *    cursor after a single click, and a Condition's branch ports redistribute
   *    across the whole bottom edge on every add anyway. Adding three exits is
   *    three clicks with no pointer travel only if the anchor cannot move. The
   *    opposite corner from the issue badge, which reads as a corner grammar:
   *    left = add, right = problems.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {Element} nodeEl - The node's own element (not its content).
   * @private
   */
  _refreshExitAdder(node, nodeEl) {
    const existing = nodeEl.querySelector?.(`.${ADD_EXIT_CLASS}`);
    if (!EXPANDABLE_EXIT_NODE_TYPES.has(node?.type)) {
      // A node never changes type, so this only fires for a would-be future
      // type that stops being expandable - cheap insurance against the button
      // outliving the capability.
      existing?.remove?.();
      return;
    }
    if (existing || typeof document?.createElement !== 'function') return;
    const button = document.createElement('button');
    // Not 'submit': ApplicationV2 treats a submit button inside its form part
    // as a form submission, and every other button in this window is explicit
    // about it for the same reason.
    button.type = 'button';
    button.className = ADD_EXIT_CLASS;
    button.dataset.action = 'addExit';
    button.dataset.nodeId = node.id;
    button.innerHTML = '<i class="fas fa-plus"></i>';
    // Labelled, not a bare glyph: on a Condition the new exit arrives with a
    // placeholder condition and immediately fails validation, so the node
    // sprouts an error badge in response to a click the user just made on
    // purpose. Saying "Add branch" up front makes the follow-up step expected
    // rather than a surprise.
    const label = game.i18n.localize(node.type === 'condition' ? 'GameOrchestra.CustomEditor.Node.AddBranch' : 'GameOrchestra.CustomEditor.Node.AddExit');
    button.title = label;
    button.setAttribute?.('aria-label', label);
    nodeEl.appendChild?.(button);
  }

  /**
   * Write each guarded exit's chip into its own output PORT element - channel 4
   * of docs/wiki/node-anatomy.md, answering "when or why does the token leave
   * by this exit?" without opening the Properties pane.
   *
   * Parented to the port rather than to the node, because only the port knows
   * where it is: Fork/Random/Condition outputs sit in Drawflow's normal flow
   * inside `.outputs`, so their vertical positions are a layout result nothing
   * here can predict. A chip inside the port inherits that position for free.
   *
   * Two constraints come with that parenting:
   *
   * - The chip is `pointer-events: none` (in CSS). It sits BESIDE its port, so
   *   it floats over canvas and over the start of the wire leaving that port.
   *   Hit-testable, it would be a dead patch: Drawflow's mousedown switch falls
   *   through on 'game-orchestra-exit-chip', and _isBackgroundTarget() rejects it too
   *   (it is inside .drawflow-node), so neither selecting the wire under it nor
   *   starting a marquee rect-select there would work.
   * - The chip carries a transform (centring it on the port). That is safe only
   *   because it is on the CHILD: a transform on the port element itself moves
   *   the rect Drawflow measures wire endpoints from while leaving its layout
   *   box alone, which is the exact trap the port-dot ::after exists to avoid.
   *   Never move this transform up onto the port.
   *
   * Rewritten wholesale on every refresh rather than diffed: ports are rebuilt
   * by addNodeOutput/removeNodeOutput, exits renumber contiguously on removal
   * (H5), and every one of those paths already routes through here.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @param {string} nodeId
   * @param {object|null} liveNode - The live Drawflow node, if the canvas is mounted.
   * @private
   */
  _refreshExitChips(node, nodeId, liveNode) {
    if (!liveNode) return;
    const portNames = Object.keys(liveNode.outputs || {}).sort((a, b) => portIndex(a) - portIndex(b));
    if (portNames.length === 0) return;
    const exits = liveNode.data?.exits || [];
    // One total for the whole node, so every Random chip normalizes against the
    // same denominator instead of each recomputing its own.
    const weightTotal = node.type === 'random' ? exitWeightTotal(exits.length ? exits : portNames.map(() => ({}))) : 0;
    const overlayLabel = (id) => this._overlayLabel(id);
    portNames.forEach((portName, i) => {
      const portEl = this._drawflow?.container?.querySelector?.(`#node-${nodeId} .outputs .output.${portName}`);
      if (!portEl) return;
      const chip = computeExitChip(node, exits[i], { weightTotal, localize: localizeIssue, overlayLabel });
      const html = buildExitChipHtml(chip);
      // Assigning innerHTML unconditionally (rather than only when there is a
      // chip) is what CLEARS a stale one - an exit that loses its guard, or a
      // port that inherited a lower index after a removal.
      if (portEl.innerHTML !== html) portEl.innerHTML = html;
    });
  }

  /**
   * A configured mood or phase id resolved to its display label, for an exit
   * chip naming one. Both axes are searched rather than picking by section: a
   * condition's axis is its own `kind`, and one Condition node's exits can mix
   * 'mood' and 'phase' freely (see the inspector's buildConditionValueSelect).
   * @param {string} id
   * @returns {string|null}
   * @private
   */
  _overlayLabel(id) {
    if (!id) return null;
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const entry = [...configuredMoods, ...configuredPhases].find((m) => m.id === id);
    if (!entry) return null;
    return entry.label?.startsWith('GameOrchestra.') ? game.i18n.localize(entry.label) : entry.label;
  }

  /**
   * Resolved display description for a Playlist node's reference, for its
   * canvas detail line - see playlist-ref.mjs#describePlaylistRef. Builds the
   * name/overlay lookups from live documents/settings on every call, the same
   * way _prepareContext() builds overlayOptions - this only runs once per
   * refreshed node, not on a hot path.
   * @param {import('./custom-playback-schema.mjs').GraphNode} node
   * @returns {string}
   * @private
   */
  _describePlaylistRefForNode(node) {
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const overlayDefs = node.playlistRef?.section === 'combat' ? configuredPhases : configuredMoods;
    return describePlaylistRef(node.playlistRef, {
      playlistName: (id) => game.playlists?.get?.(id)?.name ?? null,
      overlayLabel: (id) => {
        const entry = overlayDefs.find((m) => m.id === id);
        if (!entry) return null;
        return entry.label?.startsWith('GameOrchestra.') ? game.i18n.localize(entry.label) : entry.label;
      },
      localize: localizeIssue
    });
  }

  /**
   * Node-by-id and edges-by-source-node lookups for the current working
   * graph, for _refreshAllNodeDisplays() to build once rather than having
   * _refreshNodeDisplay() re-scan this.graph.nodes/edges for every node.
   * @returns {{nodesById: Map<string, object>, edgesByFrom: Map<string, Array>}}
   * @private
   */
  _buildGraphLookup() {
    const nodesById = new Map(this.graph.nodes.map((n) => [n.id, n]));
    const edgesByFrom = new Map();
    for (const edge of this.graph.edges) {
      if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
      edgesByFrom.get(edge.from).push(edge);
    }
    return { nodesById, edgesByFrom };
  }

  /**
   * Refresh every node's rendered content in one pass, building the
   * node/edge lookups once instead of once per node - used after a full
   * canvas rebuild (initial mount, applying a preset), where node count
   * scales with graph size.
   * @private
   */
  _refreshAllNodeDisplays() {
    const lookup = this._buildGraphLookup();
    for (const node of this.graph.nodes) this._refreshNodeDisplay(node.id, lookup);
  }

  /**
   * Reapply both path overrides to every wire touching a node: the general
   * routing, then any self-loop arc on top of it.
   *
   * These two always belong together - anything that makes Drawflow redraw a
   * path wipes both at once - so they are paired here rather than at each of
   * the six call sites, where forgetting one is exactly the kind of mistake
   * that shows up as a single wire quietly rendering in the wrong shape.
   * @param {string} nodeId
   * @private
   */
  _restyleNodeWires(nodeId) {
    this._routeConnections(nodeId);
    this._styleSelfLoopConnections(nodeId);
  }

  /**
   * Re-route every wire touching a node so it leaves and enters along its
   * ports' own normals, replacing Drawflow's always-horizontal curve - see
   * buildRoutedPath(). Endpoint coordinates are read back out of the path
   * Drawflow already wrote (parsePathEndpoints), never recomputed: Drawflow
   * measures live port positions and gets that part right, including under
   * zoom and pan. Only the curve between them is ours.
   *
   * Self-loops are skipped - _styleSelfLoopConnections owns those, and its wide
   * clearing arc would be undone by a general route.
   *
   * Has to run after anything that makes Drawflow redraw a path, since a
   * redraw restores its own curve: that means updateConnectionNodes() (in
   * _refreshNodeDisplay), a finished drag, and every frame of an in-progress
   * one.
   * @param {string} nodeId
   * @private
   */
  _routeConnections(nodeId) {
    const container = this._drawflow?.container;
    if (!container?.querySelectorAll) return;
    for (const edge of this.graph.edges) {
      if (edge.from !== nodeId && edge.to !== nodeId) continue;
      if (edge.from === edge.to) continue;
      const port = portFromEdgeId(edge.id);
      for (const connectionEl of container.querySelectorAll(edgeSelector({ from: edge.from, to: edge.to, port }))) {
        const pathEl = connectionEl.querySelector?.('.main-path');
        if (!pathEl) continue;
        const points = parsePathEndpoints(pathEl.getAttribute('d'));
        if (!points) continue;
        // Every node type puts its outputs on the right edge and its inputs on
        // the left. Condition was the one exception until its branch exits
        // moved off the bottom edge into the right-edge stack, which is why
        // _outputPortDirection() is gone. buildRoutedPath still supports 'up'
        // and 'down' - the geometry work behind them (the per-end handle
        // lengths, the backward-facing swing) is general and independently
        // tested - so a future node type that wants a vertical port only has
        // to pass the direction here.
        pathEl.setAttribute('d', buildRoutedPath(points.startX, points.startY, points.endX, points.endY, { startDir: 'right', endDir: 'left' }));
      }
    }
  }

  /**
   * Override the rendered path of any connection where this node's own
   * output feeds back into its own input, so it visibly arcs over the node
   * instead of Drawflow's default curve cutting straight across (or through)
   * it. See custom-playlist-connection-render.mjs for why this reads
   * Drawflow's own already-correct endpoint coordinates back out of its
   * rendered path rather than recomputing them - endpoint math is left
   * entirely to Drawflow; only the curve's shape is overridden.
   * @param {string} nodeId
   * @private
   */
  _styleSelfLoopConnections(nodeId) {
    if (!this._drawflow) return;
    const hasSelfLoop = this.graph.edges.some((e) => e.from === nodeId && e.to === nodeId);
    if (!hasSelfLoop) return;
    const nodeEl = this._drawflow.container?.querySelector(`#node-${nodeId}`);
    const nodeHeight = nodeEl?.offsetHeight || 64;
    const clearance = nodeHeight / 2 + SELF_LOOP_MIN_CLEARANCE_PX;
    const connections = this._drawflow.container?.querySelectorAll?.(`.connection.node_in_node-${nodeId}.node_out_node-${nodeId}`) || [];
    for (const connectionEl of connections) {
      const pathEl = connectionEl.querySelector?.('.main-path');
      if (!pathEl) continue;
      const points = parseCurvePath(pathEl.getAttribute('d'));
      if (!points) continue;
      pathEl.setAttribute('d', buildSelfLoopPath(points.startX, points.startY, points.endX, points.endY, clearance));
    }
  }

  /**
   * Pull the working graph back out of the live Drawflow instance so
   * validation/the inspector/Save see the latest structure.
   * @param {object} editor - The live Drawflow instance.
   * @private
   */
  _syncFromDrawflow(editor) {
    // drawflowExportToGraph() rebuilds a plain {version, nodes, edges} object
    // from Drawflow's OWN export shape, which has no representation for a
    // graph-level (not per-node) field - crossfadeMs would otherwise be
    // silently dropped on every one of the many _syncFromDrawflow() call
    // sites (after nearly every node mutation, and again right before Save),
    // exactly the class of bug the schema-union round-trip lesson warns
    // about. Carry it across by hand instead.
    const crossfadeMs = this.graph?.crossfadeMs ?? null;
    this.graph = drawflowExportToGraph(editor.export());
    this.graph.crossfadeMs = crossfadeMs;
    // THE single designed trigger for undo/redo (graph-history.mjs). Every
    // mutation route in this window already ends up here - the palette and
    // drag-in (_addNodeOfType), every inspector field (_patchNodeData), paste,
    // group drag, and Drawflow's own nodeMoved/nodeRemoved/connection events -
    // so recording here rather than at each of those sites is what stops a
    // future mutation path from silently not being undoable. The few read-only
    // callers (handleSave, handleApplyPreset's destructive-change check) cost
    // nothing: an unchanged state dedups against the present one and creates
    // no step. The one mutation that does NOT pass through here is the
    // graph-level crossfade, which never touches Drawflow; it records itself.
    this._recordHistory();
  }

  /**
   * Queue an undo snapshot of the state at the end of the current task.
   *
   * Coalesced through a microtask rather than captured inline, because ONE
   * user gesture routinely produces several mutations, and each of them
   * resyncs: deleting a marquee selection removes N nodes one at a time (each
   * firing 'nodeRemoved'), pasting adds N, and adding a Condition exit moves
   * the fallback's wiring - remove + add + patch. Captured inline, a single
   * Delete would need N presses of Ctrl+Z to come back. Everything
   * synchronous shares one microtask, so a gesture is one step, and the
   * snapshot is taken once the whole gesture has settled.
   *
   * This also removes any need to care where in a handler the recording sits
   * relative to the rest of its work.
   * @private
   */
  _recordHistory() {
    if (this._historySuspended || this._historyPending || !this._drawflow) return;
    this._historyPending = true;
    Promise.resolve().then(() => {
      this._historyPending = false;
      // The window can be closed, or a restore begun, between queueing and
      // flushing - _drawflow is nulled on close (_onClose).
      if (this._historySuspended || !this._drawflow) return;
      const snapshot = this._captureSnapshot();
      // The state being left keeps the selection as it stands right now, not
      // the one it was first reached with - clicking a node between two edits
      // records no step, so without this an undo would step back into a
      // snapshot that deselects for reasons the user can't see. An edit that
      // clears the selection itself (a delete) has already done so by here,
      // and correctly records that.
      this._history.updatePresentSelection(snapshot);
      if (this._history.push(snapshot)) this._updateHistoryButtons();
    });
  }

  /**
   * The full editor state one undo step restores.
   *
   * `export()` deep-clones (checked against the vendored source), so the
   * Drawflow half is already detached from the live registry and safe to
   * hold. `crossfadeMs` is carried separately for the same reason
   * _syncFromDrawflow() has to carry it: Drawflow's export shape has no
   * representation for a graph-level field.
   *
   * The selection rides along so that stepping back also restores what was
   * selected at the time - it is deliberately NOT part of the snapshot's
   * identity (see snapshotKey), so clicking around never creates a step.
   * @returns {object|null}
   * @private
   */
  _captureSnapshot() {
    if (!this._drawflow) return null;
    return {
      drawflow: this._drawflow.export(),
      crossfadeMs: this.graph?.crossfadeMs ?? null,
      levels: this._captureLevels(),
      selectedNodeId: this.selectedNodeId,
      multiSelectedNodeIds: [...this._multiSelectedNodeIds]
    };
  }

  /**
   * The Tracks pane's mixer half, as one plain comparable object: the playlist's mix flag plus
   * each sound's own volume and fade.
   *
   * Captured from the LIVE documents, which is safe even mid-debounce because the mixer applies
   * every change locally through `updateSource` before scheduling the database write - so the
   * value is already here when the commit fires.
   *
   * Sorted by id, because two states that differ only in key order are the same state and would
   * otherwise push an undo step for nothing (snapshotKey is a JSON.stringify).
   * @returns {{mix: object|null, tracks: Object<string, {volume: number, fade: number|null}>}}
   * @private
   */
  _captureLevels() {
    const playlist = this.playlist;
    const tracks = {};
    for (const id of Array.from(playlist?.sounds ?? [])
      .map((sound) => sound.id)
      .sort()) {
      const sound = playlist.sounds.get(id);
      tracks[id] = { volume: sound.volume ?? null, fade: sound.fade ?? null };
    }
    return {
      mix: foundry.utils.deepClone(playlist?.getFlag?.(CONST.moduleId, 'mix') ?? null),
      fade: playlist?.fade ?? null,
      tracks
    };
  }

  /**
   * Put the playlist's levels back to a captured state.
   *
   * **This is the one part of an undo that writes to the world.** Everything else a snapshot
   * holds is unsaved working state that only reaches the playlist on Save; levels are persisted
   * the moment they are changed, so putting them back means writing them back. Only what actually
   * differs is written, so undoing a pure graph edit costs no round-trips at all.
   *
   * Asynchronous and deliberately not awaited by the caller: `_restoreSnapshot()` is driven from
   * a keypress and the canvas half of it is synchronous. The re-render happens from the resulting
   * `updatePlaylistSound`/`updatePlaylist` hooks (refreshMixerViews), the same path an external
   * change takes.
   * @param {object|null} levels - From _captureLevels().
   * @returns {Promise<void>}
   * @private
   */
  async _restoreLevels(levels) {
    const playlist = this.playlist;
    if (!playlist || !levels) return;
    try {
      const changes = [];
      for (const [id, values] of Object.entries(levels.tracks ?? {})) {
        const sound = playlist.sounds.get(id);
        // A sound deleted since the snapshot was taken simply has nothing to restore - the mixer
        // is not in the business of recreating documents.
        if (!sound) continue;
        if ((sound.volume ?? null) !== values.volume || (sound.fade ?? null) !== values.fade) {
          changes.push({ _id: id, volume: values.volume, fade: values.fade });
        }
      }
      if (changes.length > 0) await playlist.updateEmbeddedDocuments('PlaylistSound', changes);
      if ((playlist.fade ?? null) !== (levels.fade ?? null)) await playlist.update({ fade: levels.fade ?? null });

      const currentMix = playlist.getFlag(CONST.moduleId, 'mix') ?? null;
      if (JSON.stringify(currentMix ?? null) !== JSON.stringify(levels.mix ?? null)) {
        // unsetFlag, not setFlag(null): a flag write is a recursive merge, so writing a smaller
        // object over a larger one leaves the extra keys behind (the same hazard PlaylistMix#muted
        // documents). Clearing and rewriting is the only way back to an exact earlier state.
        await playlist.unsetFlag(CONST.moduleId, 'mix');
        if (levels.mix) await playlist.setFlag(CONST.moduleId, 'mix', levels.mix);
      }
    } catch (error) {
      log(1, 'Failed to restore playlist levels for an undo/redo step:', error);
      ui.notifications?.error(game.i18n.localize('GameOrchestra.Mixer.SaveFailed'));
    }
  }

  /**
   * Put the canvas back into a previously captured state.
   *
   * Mechanically identical to handleApplyPreset()'s import path, and for the
   * same reasons: import() calls clear(), which wipes the canvas element's
   * entire innerHTML, so every node element and connection SVG is destroyed
   * and rebuilt. Anything still pointing at the old DOM is a dangling
   * reference, and none of the events this editor normally resyncs on are
   * dispatched, so the working graph, node contents, wire styling and
   * inspector all have to be refreshed by hand. It leaves zoom and pan alone
   * (import() doesn't touch canvas_x/canvas_y or the precanvas transform), so
   * an undo doesn't also throw away where you were looking.
   * @param {object} snapshot - From _captureSnapshot().
   * @private
   */
  _restoreSnapshot(snapshot) {
    if (!this._drawflow || !snapshot) return;
    const editor = this._drawflow;
    // Everything below resyncs and re-renders; without this every one of those
    // would try to record the restore itself as a new edit, which at best
    // dedups and at worst buries the redo stack it just built.
    this._historySuspended = true;
    try {
      editor.import(snapshot.drawflow);
      // Same dangling-reference cleanup as handleApplyPreset (_clearMultiSelection()
      // deliberately isn't used: it queries elements that no longer exist).
      editor.node_selected = null;
      this.selectedNodeId = null;
      this._multiSelectedNodeIds.clear();
      this._hoveredWire = null;
      this._syncFromDrawflow(editor);
      // _syncFromDrawflow carries the crossfade across from the graph it is
      // replacing, which is the state being undone AWAY from - the snapshot's
      // own value has to win.
      this.graph.crossfadeMs = snapshot.crossfadeMs ?? null;
      // Async, and intentionally not awaited - see _restoreLevels. The pane re-renders from the
      // document-update hooks it triggers.
      this._restoreLevels(snapshot.levels);
      this._refreshAllNodeDisplays();
      this._refreshUncertainEdges();
      this._closeIssueBalloon();
      // The import destroyed every node element and connection SVG the live
      // playback highlight was painted on. _applyActivityHighlight() re-resolves
      // both sides from ids and is idempotent, so repainting the state already
      // in hand puts the glow back at once instead of leaving the canvas dark
      // until the engine's next broadcast - which, mid-track, is a whole track
      // away. Node ids survive an import unchanged, so the state still applies.
      // (handleApplyPreset deliberately does NOT do this: a preset replaces the
      // graph, so a highlight computed against the old one is meaningless.)
      if (this._activityHighlight) this._applyActivityHighlight(this._activityHighlight);
      this._restoreSnapshotSelection(snapshot);
      this._renderInspector();
    } finally {
      this._historySuspended = false;
    }
    this._updateHistoryButtons();
  }

  /**
   * Reselect whatever the snapshot had selected, skipping ids the restored
   * graph no longer contains (undoing an add leaves the node that was selected
   * when it happened gone). Honours the never-mix rule the rest of this window
   * follows: one node is a real single selection, several are a marquee.
   * @param {object} snapshot
   * @private
   */
  _restoreSnapshotSelection(snapshot) {
    const exists = (id) => id && this.graph.nodes.some((node) => node.id === id);
    const multi = (snapshot.multiSelectedNodeIds || []).filter(exists);
    if (multi.length > 0) {
      this._selectNodes(multi);
      return;
    }
    if (exists(snapshot.selectedNodeId)) this._selectSingleNode(snapshot.selectedNodeId);
  }

  /**
   * Enable/disable the toolbar's undo and redo buttons to match what the
   * history can actually do. A direct DOM write, never a re-render (HR-A).
   * @private
   */
  _updateHistoryButtons() {
    const undoButton = this.element?.querySelector?.('[data-action="undo"]');
    const redoButton = this.element?.querySelector?.('[data-action="redo"]');
    if (undoButton) undoButton.disabled = !this._history.canUndo;
    if (redoButton) redoButton.disabled = !this._history.canRedo;
  }

  /**
   * Step the canvas back one edit. No-op with an empty history, so both the
   * disabled button and a stray Ctrl+Z are harmless.
   * @private
   */
  _undo() {
    const snapshot = this._history.undo();
    if (!snapshot) return;
    log(3, () => `CustomPlaylistEditor: undo (${this._history.depth.past} back, ${this._history.depth.future} forward)`);
    this._restoreSnapshot(snapshot);
  }

  /**
   * Step the canvas forward one undone edit.
   * @private
   */
  _redo() {
    const snapshot = this._history.redo();
    if (!snapshot) return;
    log(3, () => `CustomPlaylistEditor: redo (${this._history.depth.past} back, ${this._history.depth.future} forward)`);
    this._restoreSnapshot(snapshot);
  }

  /**
   * Read a node's current live data from Drawflow. getNodeFromId already
   * returns a fresh deep clone, so the result can be mutated directly before
   * being passed back to updateNodeDataFromId.
   * @param {string} nodeId
   * @returns {object|null}
   * @private
   */
  _liveNode(nodeId) {
    if (!this._drawflow) return null;
    try {
      return this._drawflow.getNodeFromId(nodeId);
    } catch (error) {
      return null;
    }
  }

  /**
   * Apply a patched data object to a node in the live Drawflow graph, then
   * resync and refresh the inspector so validation/fields reflect the change.
   * @param {string} nodeId
   * @param {object} data
   * @private
   */
  _patchNodeData(nodeId, data) {
    if (!this._drawflow) return;
    this._drawflow.updateNodeDataFromId(nodeId, data);
    this._syncFromDrawflow(this._drawflow);
    this._refreshNodeDisplay(nodeId);
    this._renderInspector();
  }

  /**
   * Replace the whole canvas with a preset starter graph (graph-presets.mjs).
   * Destructive whenever the canvas holds anything beyond a bare Start node, so
   * that case confirms first - nothing is written to the playlist either way
   * (Save still has to be pressed), but an accidental pick would otherwise
   * silently discard unsaved work.
   */
  static async handleApplyPreset(event, target) {
    const preset = getPreset(target.value);
    // Reset immediately so the same preset can be picked again, and so a
    // cancelled confirmation doesn't leave the dropdown showing a preset that
    // was never applied.
    target.value = '';
    if (!preset || !this._drawflow) return;

    this._syncFromDrawflow(this._drawflow);
    const isDestructive = this.graph.nodes.length > 1 || this.graph.edges.length > 0;
    if (isDestructive) {
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize('GameOrchestra.CustomEditor.Preset.ConfirmTitle') },
        content: `<p>${game.i18n.localize('GameOrchestra.CustomEditor.Preset.ConfirmContent')}</p>`,
        modal: true
      });
      if (!confirmed) return;
    }

    const sounds = this._playlistSounds().map((sound) => ({ id: sound.id, name: sound.name }));
    this._drawflow.import(graphToDrawflowExport(preset.build(sounds)));

    // Drawflow's import() calls clear(), which wipes the canvas element's entire
    // innerHTML - every node element and connection SVG is destroyed and rebuilt.
    // Anything still pointing at the old DOM is now a dangling reference and has
    // to be dropped here. (_clearMultiSelection() deliberately isn't used: it
    // queries elements that no longer exist.)
    this._drawflow.node_selected = null;
    this.selectedNodeId = null;
    this._multiSelectedNodeIds.clear();

    // import() dispatches none of the events (nodeRemoved/connectionRemoved/
    // nodeSelected) this editor normally resyncs on, so the working graph, the
    // rendered node contents and the inspector all have to be refreshed by hand.
    this._syncFromDrawflow(this._drawflow);
    this._refreshAllNodeDisplays();
    // Every connection SVG was destroyed and rebuilt by import() above, taking
    // the uncertainty classes with it; the balloon points at a node element
    // that no longer exists.
    this._refreshUncertainEdges();
    this._closeIssueBalloon();
    this._renderInspector();
    ui.notifications?.info(game.i18n.localize('GameOrchestra.CustomEditor.Preset.Applied'));
  }

  /**
   * Open the mixer for this playlist - the crossfade override, the per-track
   * volumes, and the fades all live there now (playlist-mixer.mjs). Goes
   * through PlaylistMixerApp.open() so a mixer already open for this playlist
   * is brought forward rather than duplicated.
   */
  static handleOpenMixer(event, _target) {
    event?.preventDefault?.();
    PlaylistMixerApp.open(this.playlist);
  }

  static handleAddNode(event, target) {
    event.preventDefault();
    this._addNodeOfType(target.dataset.nodeType);
  }

  /**
   * Add a Track node preset with a specific sound already selected - the Tracks pane's per-row
   * "+" button (playlist-mixer-render.mjs).
   */
  static handleAddTrackNode(event, target) {
    event.preventDefault();
    const soundId = target.dataset.soundId;
    if (!soundId) return;
    this._addNodeOfType('track', { soundId });
  }

  /**
   * Toolbar Undo. The keyboard route (_onKeyDown) calls the same _undo().
   */
  static handleUndo(event, target) {
    event.preventDefault();
    this._undo();
  }

  /**
   * Toolbar Redo.
   */
  static handleRedo(event, target) {
    event.preventDefault();
    this._redo();
  }

  static handleZoomIn(event, target) {
    event.preventDefault();
    this._drawflow?.zoom_in();
  }

  static handleZoomOut(event, target) {
    event.preventDefault();
    this._drawflow?.zoom_out();
  }

  static handleZoomReset(event, target) {
    event.preventDefault();
    this._drawflow?.zoom_reset();
  }

  static handleAddExit(event, target) {
    event.preventDefault();
    const nodeId = target.dataset.nodeId;
    const node = this._liveNode(nodeId);
    if (!this._drawflow || !node) return;
    if (node.name === 'condition') return this._addConditionExit(nodeId, node);
    this._drawflow.addNodeOutput(nodeId);
    // Fork exits are bare ports with no per-exit metadata (every exit is
    // taken at once, so there's nothing to configure) - only Random/Condition
    // carry a weight/cooldown or condition alongside each exit.
    if (node.name === 'random') {
      node.data.exits = [...(node.data.exits || []), { weight: 1, cooldown: 0 }];
    }
    this._patchNodeData(nodeId, node.data);
  }

  /**
   * Add a Condition exit *before* the node's fixed fallback exit, so 'default'
   * stays last - the engine follows the first exit whose condition matches, so
   * a fallback sitting anywhere but last would shadow everything after it (and
   * validateGraph rejects that outright).
   *
   * Drawflow can only append a port, so the new port is created at the end and
   * the fallback's existing wiring is moved onto it; the new exit inherits the
   * slot the fallback vacated. Moving the connection (rather than leaving it on
   * the old port and shuffling metadata around it) is what keeps an already-
   * wired fallback pointing at the same target instead of silently handing its
   * edge to the blank new exit.
   * @param {string} nodeId
   * @param {object} node - The live Drawflow node (a mutable clone).
   * @private
   */
  _addConditionExit(nodeId, node) {
    const portNames = Object.keys(node.outputs || {}).sort((a, b) => portIndex(a) - portIndex(b));
    const exits = [...(node.data.exits || [])];
    const newExit = { condition: { kind: NEW_CONDITION_KIND } };
    const fallbackIsLast = exits.length > 0 && exits[exits.length - 1]?.condition?.kind === 'default';

    this._drawflow.addNodeOutput(nodeId);
    const newPortName = `output_${portNames.length + 1}`;

    if (fallbackIsLast) {
      const fallbackPort = portNames[portNames.length - 1];
      // `output` on an outgoing connection is the TARGET's input port name
      // (Drawflow's naming, mirrored in graph-drawflow-bridge.mjs).
      for (const connection of node.outputs?.[fallbackPort]?.connections || []) {
        this._drawflow.removeSingleConnection(nodeId, connection.node, fallbackPort, connection.output);
        this._drawflow.addConnection(nodeId, connection.node, newPortName, connection.output);
      }
      exits.splice(exits.length - 1, 0, newExit);
    } else {
      // A legacy graph with no fallback (or one that isn't last) - just append
      // and let validation report the ordering if it's wrong.
      exits.push(newExit);
    }
    node.data.exits = exits;
    this._patchNodeData(nodeId, node.data);
  }

  static handleRemoveExit(event, target) {
    event.preventDefault();
    const nodeId = target.dataset.nodeId;
    const portName = target.dataset.port; // e.g. 'output_2'
    const node = this._liveNode(nodeId);
    if (!this._drawflow || !node || !portName) return;
    const index = parseInt(portName.split('_')[1], 10) - 1;
    // Belt and braces: the inspector renders no remove button for a fixed exit
    // (a Condition's fallback, or a Random's last remaining one), but nothing
    // else stops a stale button from a previous render reaching this handler.
    if (!CustomPlaylistEditor._isRemovableExit(node, index)) return;
    this._drawflow.removeNodeOutput(nodeId, portName);
    // Drawflow renumbers remaining output ports contiguously after a removal
    // (custom-playlist-plan.md H5) - splice the parallel exits array the same
    // way so per-port metadata stays aligned with the shifted port indices.
    if (Array.isArray(node.data.exits)) node.data.exits.splice(index, 1);
    this._patchNodeData(nodeId, node.data);
  }

  /**
   * Whether an exit may be removed at all. A Condition's 'default' exit is its
   * permanent fallback, and a Random's last remaining exit is what keeps it
   * from becoming a dead end; every other exit is fair game. Fork exits are
   * bounded by validation (>=2) rather than here.
   * @param {object} node - The live Drawflow node.
   * @param {number} index - Zero-based exit index.
   * @returns {boolean}
   * @private
   */
  static _isRemovableExit(node, index) {
    const exits = node?.data?.exits || [];
    if (node?.name === 'condition') return exits[index]?.condition?.kind !== 'default';
    if (node?.name === 'random') return exits.length > 1;
    return true;
  }

  /**
   * Rename a node. An emptied field falls back to the type name rather than
   * storing a blank, so a node is never nameless on the canvas.
   */
  static handleUpdateNodeLabel(event, target) {
    const nodeId = target.dataset.nodeId;
    const node = this._liveNode(nodeId);
    if (!node) return;
    const label = String(target.value ?? '').trim();
    if (label) node.data.label = label;
    else delete node.data.label;
    this._patchNodeData(nodeId, node.data);
  }

  static handleUpdateTrackLoopCount(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.loop = { mode: 'count', count: Math.max(1, parseInt(target.value, 10) || 1) };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /**
   * Toggle a Track node between finite (one exit, loop.count plays) and
   * forever (no exit, loops via native repeat). The exit port itself has to
   * be added/removed on the live Drawflow node directly - _patchNodeData
   * only ever touches a node's `data`, never its port count (see handleAddExit/
   * handleRemoveExit for the same pattern on Fork/Random/Condition).
   */
  static handleUpdateTrackInfinite(event, target) {
    const nodeId = target.dataset.nodeId;
    const node = this._liveNode(nodeId);
    if (!this._drawflow || !node) return;
    const infinite = !!target.checked;
    const hasOutput = Object.keys(node.outputs || {}).length > 0;
    if (infinite) {
      if (hasOutput) this._drawflow.removeNodeOutput(nodeId, 'output_1');
      node.data.loop = { mode: 'forever' };
    } else {
      if (!hasOutput) this._drawflow.addNodeOutput(nodeId);
      node.data.loop = { mode: 'count', count: 1 };
    }
    this._patchNodeData(nodeId, node.data);
  }

  /**
   * Toggle a (non-forever) Track node between a fixed loop count and looping
   * until a condition is met. Both sub-modes keep exactly one exit port, so
   * unlike handleUpdateTrackInfinite this never touches the live Drawflow
   * node's ports - only handleUpdateTrackInfinite's forever <-> non-forever
   * transition does that.
   */
  static handleUpdateTrackUntilToggle(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    const until = !!target.checked;
    node.data.loop = until ? createDefaultUntilLoop() : { mode: 'count', count: 1 };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateTrackUntilKind(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node || node.data.loop?.mode !== 'until') return;
    node.data.loop = { ...node.data.loop, condition: { kind: target.value } };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateTrackUntilValue(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node || node.data.loop?.mode !== 'until') return;
    node.data.loop = { ...node.data.loop, condition: { ...node.data.loop.condition, value: target.value || undefined } };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateTrackUntilBoundary(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node || node.data.loop?.mode !== 'until') return;
    node.data.loop = { ...node.data.loop, boundary: target.value === 'loopEnd' ? 'loopEnd' : 'immediate' };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateTrackUntilMinLoops(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node || node.data.loop?.mode !== 'until') return;
    node.data.loop = { ...node.data.loop, minLoops: Math.max(1, parseInt(target.value, 10) || 1) };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /** Blank/zero/negative clears maxLoops back to unbounded (null). */
  static handleUpdateTrackUntilMaxLoops(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node || node.data.loop?.mode !== 'until') return;
    const raw = parseInt(target.value, 10);
    node.data.loop = { ...node.data.loop, maxLoops: Number.isFinite(raw) && raw > 0 ? raw : null };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateDelayMin(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.delay = { ...node.data.delay, min: Math.max(0, Number(target.value) || 0) };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateDelayMax(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.delay = { ...node.data.delay, max: Math.max(0, Number(target.value) || 0) };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateRandomExitWeight(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    const index = parseInt(target.dataset.exitIndex, 10);
    if (!node || Number.isNaN(index) || !node.data.exits?.[index]) return;
    node.data.exits[index].weight = Math.max(0, Number(target.value) || 0);
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateRandomExitCooldown(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    const index = parseInt(target.dataset.exitIndex, 10);
    if (!node || Number.isNaN(index) || !node.data.exits?.[index]) return;
    node.data.exits[index].cooldown = Math.max(0, parseInt(target.value, 10) || 0);
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateRandomAvoidRepeat(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.avoidRepeat = !!target.checked;
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateConditionExitKind(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    const index = parseInt(target.dataset.exitIndex, 10);
    if (!node || Number.isNaN(index) || !node.data.exits?.[index]) return;
    // The fallback exit is fixed in both directions: its own kind can't be
    // changed, and no other exit can be turned into a second fallback. The
    // inspector offers neither, so this only catches a stale control.
    if (node.data.exits[index].condition?.kind === 'default' || target.value === 'default') return;
    node.data.exits[index].condition = { kind: target.value };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdateConditionExitValue(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    const index = parseInt(target.dataset.exitIndex, 10);
    if (!node || Number.isNaN(index) || !node.data.exits?.[index]) return;
    node.data.exits[index].condition = { ...node.data.exits[index].condition, value: target.value || undefined };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /**
   * Switch a Playlist node's reference between direct/scene/default. Routed
   * through normalizePlaylistRef() rather than a plain merge, so switching
   * source leaves a coherent ref object instead of a mix of both shapes'
   * fields (e.g. a stale direct playlistId surviving a switch to 'scene', or
   * a stale section/overlayMode surviving a switch back to 'direct').
   */
  static handleUpdatePlaylistSource(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.playlistRef = normalizePlaylistRef({ ...node.data.playlistRef, source: target.value });
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdatePlaylistTarget(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.playlistRef = { ...node.data.playlistRef, source: 'direct', playlistId: target.value || null };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /**
   * Switching section also switches the overlay axis (area -> mood, combat ->
   * phase - config.mjs#sectionAxis), so a 'specific' overlayId from the OLD
   * axis's list is cleared here rather than left to silently point at an id
   * that means nothing (or something different) on the new axis.
   */
  static handleUpdatePlaylistSection(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.playlistRef = normalizePlaylistRef({ ...node.data.playlistRef, section: target.value, overlayId: null });
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdatePlaylistOverlayMode(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.playlistRef = normalizePlaylistRef({ ...node.data.playlistRef, overlayMode: target.value });
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  static handleUpdatePlaylistOverlayId(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.playlistRef = { ...node.data.playlistRef, overlayId: target.value || null };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /**
   * Toggle a Playlist node between finite (one exit, loop.count passes) and
   * forever (no exit, repeats forever). Mirrors handleUpdateTrackInfinite -
   * the exit port itself has to be added/removed on the live Drawflow node
   * directly; _patchNodeData only ever touches a node's `data`.
   */
  static handleUpdatePlaylistInfinite(event, target) {
    const nodeId = target.dataset.nodeId;
    const node = this._liveNode(nodeId);
    if (!this._drawflow || !node) return;
    const infinite = !!target.checked;
    const hasOutput = Object.keys(node.outputs || {}).length > 0;
    if (infinite) {
      if (hasOutput) this._drawflow.removeNodeOutput(nodeId, 'output_1');
      node.data.loop = { mode: 'forever' };
    } else {
      if (!hasOutput) this._drawflow.addNodeOutput(nodeId);
      node.data.loop = { mode: 'count', count: 1 };
    }
    this._patchNodeData(nodeId, node.data);
  }

  static handleUpdatePlaylistLoopCount(event, target) {
    const node = this._liveNode(target.dataset.nodeId);
    if (!node) return;
    node.data.loop = { mode: 'count', count: Math.max(1, parseInt(target.value, 10) || 1) };
    this._patchNodeData(target.dataset.nodeId, node.data);
  }

  /**
   * Validate, force the playlist into UNSEQUENCED mode (required - see H1),
   * and persist the graph to the playlist's customPlayback flag.
   */
  static async handleSave(event, target) {
    event.preventDefault();
    if (this._drawflow) this._syncFromDrawflow(this._drawflow);
    const validation = validateGraph(this.graph, { playlist: this.playlist });
    if (!validation.valid) {
      ui.notifications.error(game.i18n.localize('GameOrchestra.CustomEditor.ValidationFailed'));
      this._renderInspector();
      return;
    }
    try {
      const unsequencedMode = globalThis.CONST?.PLAYLIST_MODES?.UNSEQUENCED ?? -1;
      // UNSEQUENCED is the only Foundry playlist mode that neither auto-advances
      // a finished sound nor stops one sound to start another - the graph engine
      // (and Fork's simultaneous playback) require both properties (H1).
      if (this.playlist.mode !== unsequencedMode) await this.playlist.update({ mode: unsequencedMode });
      // setFlag() fires Foundry's 'updatePlaylist' hook, which hooks.mjs's
      // handleUpdatePlaylist() already forwards to onCustomGraphChanged() for
      // exactly this flag - that is the single designed trigger for a live
      // rebuild (custom-playlist-plan.md H8/Phase 5.1), including for a graph
      // edited from another client. Calling onCustomGraphChanged() again here
      // would rebuild the engine twice per save, racing its own teardown
      // against itself (see CustomPlaybackEngine.stop()'s doc comment for the
      // exact race two overlapping stop/start pairs can hit).
      await this.playlist.setFlag(CONST.moduleId, 'customPlayback', this.graph);
      ui.notifications.info(game.i18n.localize('GameOrchestra.CustomEditor.Saved'));
      // Deliberately does NOT close. Saving is the only way to hear the graph - the engine
      // rebuilds off the 'updatePlaylist' hook this setFlag() just fired - so closing on save
      // meant the live activity highlight (editor-highlight-mixin.mjs: the drains, the pulses,
      // the active-edge markers) could only ever be seen by reopening the window afterwards.
      // The whole feature was gated behind the one action that dismissed it. Iterating on a
      // graph while listening to it is now one click; the window closes from its own header.
      this._enableRemoveButton();
    } catch (error) {
      log(1, 'Error saving custom playback graph:', error);
      ui.notifications.error(game.i18n.localize('GameOrchestra.CustomEditor.SaveFailed'));
    }
  }

  /**
   * Enable the footer's Remove button after the first successful save.
   *
   * The footer is Handlebars-rendered and this window must never re-render itself (HR-A), so
   * the button is always in the markup and starts `disabled` when the playlist has no graph -
   * flipping one property here is the whole update. Rendering it conditionally instead would
   * leave a freshly-saved graph with no way to remove it until the window was reopened.
   * @private
   */
  _enableRemoveButton() {
    const button = this.element?.querySelector?.('[data-action="removeCustomPlayback"]');
    if (button) button.disabled = false;
  }

  /**
   * Remove the custom playback graph, reverting the playlist to native behavior.
   * Destructive and irreversible (the graph itself isn't recoverable once
   * unset), so confirm first rather than acting on a single misclick.
   */
  static async handleRemoveCustomPlayback(event, target) {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('GameOrchestra.CustomEditor.RemoveConfirm.Title') },
      content: `<p>${game.i18n.localize('GameOrchestra.CustomEditor.RemoveConfirm.Content')}</p>`,
      modal: true
    });
    if (!confirmed) return;
    try {
      // See handleSave()'s comment above: unsetFlag() fires 'updatePlaylist' too,
      // and hooks.mjs's handleUpdatePlaylist() is the single designed trigger for
      // onCustomGraphChanged() - calling it again here would rebuild twice.
      await this.playlist.unsetFlag(CONST.moduleId, 'customPlayback');
      ui.notifications.info(game.i18n.localize('GameOrchestra.CustomEditor.Removed'));
      this.close();
    } catch (error) {
      log(1, 'Error removing custom playback graph:', error);
      ui.notifications.error(game.i18n.localize('GameOrchestra.CustomEditor.SaveFailed'));
    }
  }
}
