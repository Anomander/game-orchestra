/**
 * The module's **public API** - the supported surface for macros and other modules.
 *
 * This is a **facade with no logic of its own.** Every method delegates to the module that owns
 * the behaviour (music-controller.mjs, binding-store.mjs, transport.mjs, playlist-mix-apply.mjs,
 * helpers.mjs, the pure graph modules). When a method needs something that does not exist yet,
 * that something goes in the owning module and this file calls it - the way
 * helpers.mjs#writeCustomGraph and playlist-mix-apply.mjs#patchPlaylistMix were both extracted
 * for exactly this reason. A facade that starts computing is a second implementation, and
 * docs/wiki/ux.md UX-2 is the record of what those cost.
 *
 * ## Two rules that shape every method here
 *
 * **1. A call that cannot do what its name says THROWS.** The engine is head-GM-only (CLAUDE.md
 * rule 5), so `playCurrentTrack()` returns early on every other client - a player's macro calling
 * it would otherwise do nothing at all and report success. That is the silent-failure class this
 * codebase's comments exist to warn about, and an API is the worst possible place to introduce a
 * new instance of it. Callers branch with {@link isHeadGM}/{@link canControl} first.
 *
 * The check happens at the TOP of each method, before delegating. Calling through and inspecting
 * the result cannot distinguish "returned early because not head GM" from "ran and had nothing to
 * do".
 *
 * **2. Permission is Foundry's answer, not ours.** A write attempts the operation and translates
 * the rejection; it does not re-derive whether this user may write a Scene flag. A second
 * permission model drifts from core's the first time ownership rules change.
 *
 * ## Stability
 *
 * `version` is this contract's own semver, independent of the module's. It starts at 0.x
 * deliberately: the shape has not been used by anyone yet, and pretending otherwise buys a
 * compatibility shim for decisions nobody has tested. Under 0.x a signature may be corrected in a
 * minor bump, with a release note. Anything reachable from the returned object is contract;
 * `game.gameOrchestra`'s legacy keys and every `_`-prefixed member of every class are not.
 *
 * Objects handed OUT are clones or frozen. Objects handed IN are untrusted and normalized through
 * the existing resolvers, so a caller's malformed graph degrades exactly the way a malformed
 * stored one does rather than taking a second path.
 *
 * See docs/wiki/api.md.
 */

import { CONST } from './config.mjs';
import {
  GraphValidationError,
  describePlaylistContext,
  getActiveOverlayId,
  getCustomGraph,
  getDocumentCategory,
  getPlaylistById,
  isHeadGM as isHeadGMHelper,
  macroValidationList,
  removeCustomGraph,
  writeCustomGraph
} from './helpers.mjs';
import {
  applyBindingLayer,
  applyBindingPlaylist,
  applyBindingTrack,
  bindingPath,
  clearBindingOverlay,
  documentFlagStore,
  globalSettingStore,
  updateObjectStore
} from './binding-store.mjs';
import { describeResolution, localizeResolution, setSuppression, suppressionState } from './transport.mjs';
import {
  applyMixToPlaylist,
  clearSolo,
  getActiveDuck,
  getPlaylistMix,
  getSoloIds,
  patchPlaylistMix,
  setPlaylistMuted,
  toggleSolo as toggleSoloSession
} from './playlist-mix-apply.mjs';
import { clampVolume, coerceDuckFactor, effectiveVolume, normalizeMix } from './playlist-mix.mjs';
import { validateGraph } from './graph-validation.mjs';
import { inlineScriptsAllowed, isExecutingScriptFor, isScriptExecuting, scriptCompiles } from './script-runtime.mjs';
import { createBuilder } from './graph-builder.mjs';
import { GRAPH_PRESETS } from './graph-presets.mjs';
import * as schema from './custom-playback-schema.mjs';

/** This API contract's own version. See the header - deliberately 0.x. */
export const API_VERSION = '0.1.0';

/**
 * Every error this API throws. The `code` is the stable part - a caller branches on it, never on
 * the message, which is prose and may be reworded.
 *
 * - `NOT_HEAD_GM` - the operation only means anything on the client running the engine.
 * - `NOT_PERMITTED` - Foundry refused the write, or this user is not a GM.
 * - `INVALID_ARGUMENT` - the caller passed something this method cannot use.
 * - `NOT_FOUND` - a referenced playlist/document does not exist.
 * - `VALIDATION_FAILED` - a graph had error-level validation issues; see `.validation`.
 * - `SELF_REENTRANT` - the call would tear down the engine currently executing the script that
 *   made it. See {@link refuseSelfReentrant}.
 */
export class GameOrchestraApiError extends Error {
  /**
   * @param {'NOT_HEAD_GM'|'NOT_PERMITTED'|'INVALID_ARGUMENT'|'NOT_FOUND'|'VALIDATION_FAILED'|'SELF_REENTRANT'} code
   * @param {string} message
   * @param {object} [details] - Extra fields merged onto the error (e.g. `validation`).
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GameOrchestraApiError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** @returns {boolean} Whether this client is the head GM - the one running the playback engine. */
function isHeadGM() {
  return isHeadGMHelper();
}

/**
 * Whether this user may perform transport and binding writes. World settings and the module's
 * flags are GM-only; this is the cheap pre-check so a caller need not catch to find out.
 * @returns {boolean}
 */
function canControl() {
  return game.user?.isGM === true;
}

/**
 * @throws {GameOrchestraApiError} NOT_HEAD_GM when this client is not running the engine.
 */
function requireHeadGM(what) {
  if (!isHeadGM()) {
    throw new GameOrchestraApiError('NOT_HEAD_GM', `${what} only runs on the head GM's client; this client is not it. Check api.isHeadGM() first.`);
  }
}

/**
 * @throws {GameOrchestraApiError} NOT_PERMITTED when this user is not a GM.
 */
function requireGM(what) {
  if (!canControl()) {
    throw new GameOrchestraApiError('NOT_PERMITTED', `${what} requires a GM. Check api.canControl() first.`);
  }
}

/**
 * Refuse a call that would tear down the engine currently executing the script making it (D-B1).
 *
 * A Script node runs on the head GM, so **every** API call in its context passes the head-GM and
 * permission gates - there is no `NOT_HEAD_GM` to catch this. Two shapes eat their own engine:
 * `graph.set()`/`remove()` on the running playlist fires `updatePlaylist` -> `onCustomGraphChanged`
 * -> teardown and restart from Start (H8/H9) *while this script's node holds a token*; and
 * `playback.play()`/`stop()` retires the tree from inside one of its own nodes. The 300 ms throttle
 * and the circuit breaker would eventually intervene, but a breaker trip is a diagnosis, not a
 * guardrail - and the music restarts in a loop until it fires.
 *
 * Scoped to the executing tree, never global: rewriting a *different* playlist's graph from a
 * script is one of the better reasons to have the node at all.
 * @param {string|null} playlistId - Null means "any engine executing a script" (play/stop).
 * @param {string} what
 * @throws {GameOrchestraApiError} SELF_REENTRANT
 */
function refuseSelfReentrant(playlistId, what) {
  const busy = playlistId === null ? isScriptExecuting() : isExecutingScriptFor(playlistId);
  if (!busy) return;
  throw new GameOrchestraApiError(
    'SELF_REENTRANT',
    `${what} would tear down the engine currently executing this script. Act on a different playlist, or let the script finish and let the graph route there instead.`
  );
}

/**
 * Coerce a playlist argument - a Playlist document or its id - to a document.
 * @param {object|string} playlistOrId
 * @returns {object}
 * @throws {GameOrchestraApiError} INVALID_ARGUMENT / NOT_FOUND
 */
function resolvePlaylist(playlistOrId) {
  if (!playlistOrId) throw new GameOrchestraApiError('INVALID_ARGUMENT', 'A playlist or playlist id is required.');
  if (typeof playlistOrId === 'string') {
    const found = getPlaylistById(playlistOrId);
    if (!found) throw new GameOrchestraApiError('NOT_FOUND', `No playlist with id '${playlistOrId}'.`);
    return found;
  }
  if (typeof playlistOrId.getFlag !== 'function') {
    throw new GameOrchestraApiError('INVALID_ARGUMENT', 'Expected a Playlist document or a playlist id.');
  }
  return playlistOrId;
}

/** @returns {import('./music-controller.mjs').MusicController|null} */
function controller() {
  return game.gameOrchestra?.musicController ?? null;
}

/**
 * Translate a Foundry write rejection into NOT_PERMITTED, leaving anything else alone.
 *
 * Rule 2 in this file's header: permission is core's answer. A rejected `update()` is what
 * "you may not write this" actually looks like, and re-deriving ownership here would drift.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function translatingPermission(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GameOrchestraApiError) throw error;
    const message = String(error?.message ?? '');
    if (/permission|not authorized|lack/i.test(message)) {
      throw new GameOrchestraApiError('NOT_PERMITTED', message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// J5 - Perform
// ---------------------------------------------------------------------------

/**
 * Set one overlay axis's active id. Shared by setMood/setPhase, which differ only by axis
 * (config.mjs#overlayAxes models the two as one mechanism - docs/wiki/ux.md D4 is the record of
 * what splitting them costs).
 * @param {'mood'|'phase'} axis
 * @param {string|null} id - '' or null clears the axis.
 * @returns {Promise<void>}
 */
async function setOverlay(axis, id) {
  requireGM(`Setting the active ${axis}`);
  const value = id == null ? '' : String(id);
  return translatingPermission(() => game.settings.set(CONST.moduleId, CONST.overlayAxes[axis].activeSetting, value));
}

/**
 * The configured overlays on one axis, with labels localized at this boundary (the definitions
 * store i18n keys - see the render-boundary rule in CLAUDE.md).
 * @param {'mood'|'phase'} axis
 * @returns {Array<{id: string, label: string, icon: string, color: string, active: boolean}>}
 */
function listOverlays(axis) {
  const stored = game.settings.get(CONST.moduleId, CONST.overlayAxes[axis].listSetting) || [];
  const activeId = getActiveOverlayId(axis);
  return stored.map((entry) => ({
    id: entry.id,
    label: game.i18n?.localize?.(entry.label) ?? entry.label,
    icon: entry.icon,
    color: entry.color,
    active: entry.id === activeId
  }));
}

const transport = {
  /** @returns {string} The active mood id, or ''. */
  getMood: () => getActiveOverlayId('mood'),
  /** @returns {string} The active phase id, or ''. */
  getPhase: () => getActiveOverlayId('phase'),
  /** @param {string|null} moodId @returns {Promise<void>} */
  setMood: (moodId) => setOverlay('mood', moodId),
  /** @param {string|null} phaseId @returns {Promise<void>} */
  setPhase: (phaseId) => setOverlay('phase', phaseId),
  /** @returns {Array<object>} Configured moods, labels localized. */
  listMoods: () => listOverlays('mood'),
  /** @returns {Array<object>} Configured phases, labels localized. */
  listPhases: () => listOverlays('phase'),

  /** @returns {{area: boolean, combat: boolean}} Which sections are currently suppressed. */
  getSuppression() {
    const state = suppressionState();
    return {
      area: !!state.find((c) => c.setting === CONST.settings.suppressArea)?.active,
      combat: !!state.find((c) => c.setting === CONST.settings.suppressCombat)?.active
    };
  },

  /**
   * Suppress or un-suppress one music section. Omit `value` to toggle.
   * @param {'area'|'combat'} section
   * @param {boolean} [value]
   * @returns {Promise<void>}
   */
  async setSuppression(section, value = undefined) {
    requireGM('Changing suppression');
    const setting = section === 'area' ? CONST.settings.suppressArea : section === 'combat' ? CONST.settings.suppressCombat : null;
    if (!setting) throw new GameOrchestraApiError('INVALID_ARGUMENT', `Unknown section '${section}'; expected 'area' or 'combat'.`);
    return translatingPermission(() => setSuppression(setting, value));
  },

  /**
   * Re-resolve and apply the winning context - the same thing a mood change triggers.
   * @returns {Promise<void>}
   */
  async refresh() {
    requireHeadGM('Refreshing playback');
    refuseSelfReentrant(null, 'Refreshing playback');
    return controller()?.playCurrentTrack();
  },

  /**
   * A localized sentence describing what is winning and why - the exact string the hub's and the
   * widget's status pills show, via the same pure describer, so a macro cannot produce a fourth
   * description of resolution (UX-2).
   * @returns {string|null} Null when nothing is playing.
   */
  describeCurrent() {
    const ctrl = controller();
    return localizeResolution(describeResolution({
      context: ctrl?.currentContext ?? null,
      referenceScene: ctrl?.currentScene ?? null,
      activeMood: getActiveOverlayId('mood'),
      activePhase: getActiveOverlayId('phase')
    }));
  }
};

// ---------------------------------------------------------------------------
// J1 - Bind
// ---------------------------------------------------------------------------

/**
 * Pick the {@link import('./binding-store.mjs').BindingStore} backing one binding target.
 *
 * Three of the four targets need no code of their own; the prototype token is the exception and
 * is the reason this function exists rather than being inlined.
 * @param {'default'|object} target - `'default'`, or a Scene / TokenDocument / Actor /
 *   PrototypeToken document.
 * @returns {import('./binding-store.mjs').BindingStore}
 * @throws {GameOrchestraApiError} INVALID_ARGUMENT
 */
function storeForTarget(target) {
  if (target === 'default') return globalSettingStore();
  if (!target || typeof target !== 'object') {
    throw new GameOrchestraApiError('INVALID_ARGUMENT', "Expected 'default' or a Scene / TokenDocument / Actor / PrototypeToken document.");
  }
  if (getDocumentCategory(target) === 'PrototypeToken') {
    const actor = target.parent;
    if (!actor) {
      throw new GameOrchestraApiError('INVALID_ARGUMENT', 'That PrototypeToken has no parent Actor, so there is nothing to write to.');
    }
    // Mirrors GameOrchestraConfig#updateObject's PrototypeToken branch, and must keep mirroring
    // it. Plain DOT NOTATION, never `flags['game-orchestra']`: Foundry expands update keys with
    // expandObject -> setProperty, which splits on "." and has no bracket syntax (HR-J). The
    // bracketed form produced a literal key the Actor schema dropped while cleaning - the update
    // resolved successfully and wrote NOTHING, confirmed live.
    //
    // Headless on purpose (HR-I): there is no sheet here, so there is no `app.token` preview
    // clone to be caught by. That immunity is an argument for this host over reusing the window's.
    return updateObjectStore({
      readData: () => target.flags?.[CONST.moduleId] ?? {},
      updateObject: (data) => actor.update(Object.entries(data).reduce((acc, [key, value]) => {
        acc[`prototypeToken.flags.${CONST.moduleId}.${key}`] = value;
        return acc;
      }, {}))
    });
  }
  if (typeof target.setFlag !== 'function') {
    throw new GameOrchestraApiError('INVALID_ARGUMENT', `Cannot bind against a ${target.constructor?.name ?? 'value'} - it is not a Document.`);
  }
  return documentFlagStore(target);
}

/**
 * Validate a section argument.
 * @param {'area'|'combat'} section
 * @returns {'area'|'combat'}
 */
function requireSection(section) {
  if (section !== 'area' && section !== 'combat') {
    throw new GameOrchestraApiError('INVALID_ARGUMENT', `Unknown section '${section}'; expected 'area' or 'combat'.`);
  }
  return section;
}

const bind = {
  /**
   * Assign a playlist to one *scope × section × overlay* slot.
   *
   * **`setToken(actor)` and `setToken(actor.prototypeToken)` are different operations** and this
   * is not a detail the API should paper over: a placed token holds a *copy* of the prototype's
   * flags taken at creation time, so editing the prototype changes nothing about tokens already
   * on the canvas (H14). Both documents are in the resolution chain; which one you write decides
   * which tokens are affected.
   * @param {'default'|object} target - `'default'`, or a Scene / TokenDocument / Actor /
   *   PrototypeToken document.
   * @param {object} binding
   * @param {'area'|'combat'} binding.section
   * @param {string|null} [binding.overlayId] - A mood id for `area`, a phase id for `combat`
   *   (config.mjs#sectionAxis). Omit for the section's own default.
   * @param {string|null} binding.playlistId - Null clears the binding.
   * @param {string|null} [binding.trackId] - Used verbatim when provided; otherwise resolved
   *   (and deliberately never invented for a custom-graph playlist - H2).
   * @returns {Promise<void>}
   */
  async set(target, { section, overlayId = null, playlistId, trackId = undefined } = {}) {
    requireGM('Changing a binding');
    requireSection(section);
    if (playlistId) resolvePlaylist(playlistId); // fail loudly on a bad id rather than storing it
    const store = storeForTarget(target);
    return translatingPermission(() => applyBindingPlaylist(store, bindingPath(section, overlayId), playlistId ?? null, trackId));
  },

  /**
   * Set or clear a binding's initial track.
   * @param {'default'|object} target
   * @param {object} binding
   * @param {'area'|'combat'} binding.section
   * @param {string|null} [binding.overlayId]
   * @param {string|null} binding.trackId - Null clears it.
   * @returns {Promise<void>}
   */
  async setTrack(target, { section, overlayId = null, trackId } = {}) {
    requireGM('Changing a binding');
    requireSection(section);
    const store = storeForTarget(target);
    return translatingPermission(() => applyBindingTrack(store, bindingPath(section, overlayId), trackId ?? null));
  },

  /**
   * Set whether an overlay binding plays as an additive **layer** over its section's base music
   * instead of replacing it (docs/wiki/architecture.md § Layers). Overlay-scoped only.
   * @param {'default'|object} target
   * @param {object} binding
   * @param {'area'|'combat'} binding.section
   * @param {string} binding.overlayId
   * @param {boolean} binding.layer
   * @returns {Promise<void>}
   */
  async setLayer(target, { section, overlayId, layer } = {}) {
    requireGM('Changing a binding');
    requireSection(section);
    if (!overlayId) throw new GameOrchestraApiError('INVALID_ARGUMENT', 'setLayer needs an overlayId - layering is an overlay-level setting.');
    const store = storeForTarget(target);
    return translatingPermission(() => applyBindingLayer(store, bindingPath(section, overlayId), !!layer));
  },

  /**
   * Clear a binding.
   *
   * Clearing a **section** keeps its `exclusive`/`duck`; clearing an **overlay** removes the
   * entry outright, including its `layer`/`duck`. That asymmetry is deliberate and lives in
   * binding-store.mjs - see clearBindingOverlay's comment.
   * @param {'default'|object} target
   * @param {object} binding
   * @param {'area'|'combat'} binding.section
   * @param {string|null} [binding.overlayId]
   * @returns {Promise<void>}
   */
  async clear(target, { section, overlayId = null } = {}) {
    requireGM('Clearing a binding');
    requireSection(section);
    const store = storeForTarget(target);
    return translatingPermission(() => (overlayId
      ? clearBindingOverlay(store, section, overlayId)
      : applyBindingPlaylist(store, bindingPath(section, null), null)));
  },

  /**
   * Read one slot's stored binding. Reads never throw on permission - a player may legitimately
   * ask what is configured.
   * @param {'default'|object} target
   * @param {object} binding
   * @param {'area'|'combat'} binding.section
   * @param {string|null} [binding.overlayId]
   * @returns {{playlistId: string|null, initialTrack: string|null, priority: number|null,
   *   layer: boolean, duck: number|null, exclusive: boolean}}
   */
  read(target, { section, overlayId = null } = {}) {
    requireSection(section);
    const store = storeForTarget(target);
    const path = bindingPath(section, overlayId);
    return {
      playlistId: store.get(`${path}.playlist`) ?? null,
      initialTrack: store.get(`${path}.initialTrack`) ?? null,
      priority: store.get(`${path}.priority`) ?? null,
      layer: !!store.get(`${path}.layer`),
      duck: store.get(`${path}.duck`) ?? null,
      exclusive: !!store.get(`music.${section}.exclusive`)
    };
  },

  /**
   * The context currently winning, as a plain descriptor.
   * @returns {object|null} See {@link playback.currentContext}.
   */
  resolve: () => playback.currentContext()
};

// ---------------------------------------------------------------------------
// J3 - Behaviour (the graph)
// ---------------------------------------------------------------------------

/**
 * The environment-dependent half of graph validation, for the API's own write path.
 *
 * Without this, `graph.set()` silently held Script nodes to a *lower* bar than the editor's Save
 * button - every macro and inline-source rule in graph-validation.mjs self-skips when its context
 * is absent, so a graph with source that cannot compile went straight to the flag with no error.
 * That was the opposite of this method's documented promise.
 *
 * `canAuthor` is deliberately NOT included. It is an editor affordance - it disables the source
 * field for a user without MACRO_SCRIPT - and asking it of an API caller answers the wrong
 * question: a module writing a graph is not the person who will later run it. The check that
 * actually decides whether inline source executes is inlineScriptsAllowed(), at execution time,
 * where it covers every write path including the raw setFlag() this module can never intercept.
 * See script-runtime.mjs#canAuthorInlineScripts.
 * @returns {{macros: Array, scripting: {inlineAllowed: boolean, compiles: Function}}}
 * @private
 */
function scriptValidationContext() {
  return {
    macros: macroValidationList(),
    scripting: { inlineAllowed: inlineScriptsAllowed(), compiles: scriptCompiles }
  };
}

const graph = {
  /**
   * A playlist's stored playback graph.
   *
   * **A deep clone**, always. Handing back the live flag object invites a caller to mutate it in
   * place, which writes nothing and then surprises them.
   * @param {object|string} playlistOrId
   * @returns {import('./custom-playback-schema.mjs').CustomGraph|null}
   */
  get(playlistOrId) {
    const stored = getCustomGraph(resolvePlaylist(playlistOrId));
    return stored ? foundry.utils.deepClone(stored) : null;
  },

  /**
   * Save a graph to a playlist.
   *
   * Refuses on **error**-level issues only, matching the editor's Save button - an API stricter
   * than the UI would be its own surprise. Warnings are returned so a caller can surface them.
   *
   * "Matching the editor" includes the environment-dependent Script-node rules, which this method
   * supplies for itself ({@link scriptValidationContext}) - pass `options` to override any of them.
   *
   * Two consequences worth knowing before calling this on a live playlist:
   * - it force-writes `mode: UNSEQUENCED` (H1) and never assigns an `initialTrack` (H2);
   * - saving a graph that is **currently playing restarts it from Start** (H8 + H9). There is no
   *   in-place patch, deliberately.
   * @param {object|string} playlistOrId
   * @param {import('./custom-playback-schema.mjs').CustomGraph} newGraph
   * @param {object} [options] - Extra validation context, merged over the environment context this
   *   method supplies for itself. See graph-validation.mjs#validateGraph.
   * @returns {Promise<{valid: boolean, errors: Array, warnings: Array, infos: Array}>}
   * @throws {GameOrchestraApiError} VALIDATION_FAILED - carries `.validation`.
   */
  async set(playlistOrId, newGraph, options = {}) {
    requireGM('Saving a graph');
    const playlist = resolvePlaylist(playlistOrId);
    refuseSelfReentrant(playlist.id, 'Saving this graph');
    return translatingPermission(async () => {
      try {
        return await writeCustomGraph(playlist, newGraph, { ...scriptValidationContext(), ...options });
      } catch (error) {
        if (error instanceof GraphValidationError) {
          throw new GameOrchestraApiError('VALIDATION_FAILED', error.message, { validation: error.validation });
        }
        throw error;
      }
    });
  },

  /**
   * Remove a playlist's graph, reverting it to native playback. The playlist's mode is left as
   * UNSEQUENCED - see removeCustomGraph for why guessing at a restore would be worse.
   * @param {object|string} playlistOrId
   * @returns {Promise<void>}
   */
  async remove(playlistOrId) {
    requireGM('Removing a graph');
    const playlist = resolvePlaylist(playlistOrId);
    refuseSelfReentrant(playlist.id, 'Removing this graph');
    return translatingPermission(() => removeCustomGraph(playlist));
  },

  /**
   * Validate a graph without saving it. Emits **i18n keys**, never localized strings - the
   * validator is deliberately Foundry-free. Use {@link graph.localizeIssue} at your own render
   * boundary.
   * @param {import('./custom-playback-schema.mjs').CustomGraph} candidate
   * @param {object} [options] - Extra context; see graph-validation.mjs#validateGraph.
   * @returns {{valid: boolean, errors: Array, warnings: Array, infos: Array}}
   */
  validate: (candidate, options = {}) => validateGraph(candidate, options),

  /**
   * Localize one validation issue.
   * @param {{messageKey: string, format?: object, nodeLabel?: string|null}} issue
   * @returns {string}
   */
  localizeIssue(issue) {
    if (!issue?.messageKey) return '';
    return issue.format ? game.i18n.format(issue.messageKey, issue.format) : game.i18n.localize(issue.messageKey);
  },

  /**
   * A fresh graph builder - the same one the presets and the native-mode synthesis use, so a
   * programmatically built graph gets the numeric-id and port-order rules for free.
   * @returns {ReturnType<typeof createBuilder>}
   */
  builder: () => createBuilder(),

  /** The starter graphs, frozen. @type {ReadonlyArray<object>} */
  presets: Object.freeze([...GRAPH_PRESETS]),

  /** The schema module's pure helpers and type sets (resolveLoop, DURATIONAL_NODE_TYPES, …). */
  schema: Object.freeze({ ...schema })
};

// ---------------------------------------------------------------------------
// J4 - Levels
// ---------------------------------------------------------------------------

const mix = {
  /**
   * A playlist's normalized mix. Normalized rather than raw, so a caller sees the same values the
   * engine and the mixer do rather than whatever happens to be stored.
   * @param {object|string} playlistOrId
   * @returns {import('./playlist-mix.mjs').PlaylistMix}
   */
  get: (playlistOrId) => normalizeMix(getPlaylistMix(resolvePlaylist(playlistOrId))),

  /**
   * Merge a patch into a playlist's mix (`gain`, `floor`, `ceiling`, `crossfadeMs`, `muted`), then
   * re-level anything of that playlist already playing.
   * @param {object|string} playlistOrId
   * @param {object} patch
   * @returns {Promise<void>}
   */
  async patch(playlistOrId, patch) {
    requireGM('Changing a mix');
    const playlist = resolvePlaylist(playlistOrId);
    await translatingPermission(() => patchPlaylistMix(playlist, patch));
    applyMixToPlaylist(playlist);
  },

  /**
   * Set one sound's own document volume. This is the track's level, not the mixer's ceiling -
   * `api.mix.patch` is the latter.
   * @param {object|string} playlistOrId
   * @param {string} soundId
   * @param {number} volume - 0..1.
   * @returns {Promise<void>}
   */
  async setVolume(playlistOrId, soundId, volume) {
    requireGM('Changing a volume');
    const playlist = resolvePlaylist(playlistOrId);
    const sound = playlist.sounds?.get?.(soundId);
    if (!sound) throw new GameOrchestraApiError('NOT_FOUND', `No sound '${soundId}' in playlist '${playlist.name}'.`);
    return translatingPermission(() => sound.update({ volume: clampVolume(Number(volume) || 0, normalizeMix(getPlaylistMix(playlist))) }));
  },

  /**
   * Mute or unmute one sound in a playlist's mix.
   * @param {object|string} playlistOrId
   * @param {string} soundId
   * @param {boolean} muted
   * @returns {Promise<boolean>} The resulting state.
   */
  async setMuted(playlistOrId, soundId, muted) {
    requireGM('Changing a mix');
    const playlist = resolvePlaylist(playlistOrId);
    const result = await translatingPermission(() => setPlaylistMuted(playlist, soundId, muted));
    applyMixToPlaylist(playlist);
    return result;
  },

  /**
   * Solo one sound - **session state, this client only, never persisted.** It is an audition
   * tool; the rest of the table goes on hearing the real mix, which is also why this needs no GM
   * check and is synchronous.
   * @param {object|string} playlistOrId
   * @param {string} soundId
   * @returns {boolean} The resulting solo state.
   */
  setSolo(playlistOrId, soundId) {
    const playlist = resolvePlaylist(playlistOrId);
    const result = toggleSoloSession(playlist.id, soundId);
    applyMixToPlaylist(playlist);
    return result;
  },

  /**
   * The soloed sound ids on this client.
   * @param {object|string} playlistOrId
   * @returns {string[]}
   */
  getSolo: (playlistOrId) => [...getSoloIds(resolvePlaylist(playlistOrId).id)],

  /**
   * Drop every solo for a playlist on this client.
   * @param {object|string} playlistOrId
   */
  clearSolo(playlistOrId) {
    const playlist = resolvePlaylist(playlistOrId);
    clearSolo(playlist.id);
    applyMixToPlaylist(playlist);
  },

  /**
   * The volume one sound should actually be heard at right now, given its document volume, its
   * playlist's mix and any solo. Pure arithmetic - no audio is touched.
   * @param {object|string} playlistOrId
   * @param {string} soundId
   * @returns {number}
   */
  effectiveVolume(playlistOrId, soundId) {
    const playlist = resolvePlaylist(playlistOrId);
    const sound = playlist.sounds?.get?.(soundId);
    if (!sound) throw new GameOrchestraApiError('NOT_FOUND', `No sound '${soundId}' in playlist '${playlist.name}'.`);
    return effectiveVolume(sound.volume, normalizeMix(getPlaylistMix(playlist)), soundId);
  },

  /** @returns {{factor: number, exemptPlaylistIds: string[]}} The world's current duck. */
  getDuck: () => getActiveDuck(),

  /**
   * Set the world duck factor - the attenuation applied to everything that is not an additive
   * layer. 1 is "no duck".
   * @param {number} factor - 0..1.
   * @returns {Promise<void>}
   */
  async setDuck(factor) {
    requireGM('Changing the duck');
    const current = getActiveDuck();
    return translatingPermission(() => game.settings.set(CONST.moduleId, CONST.settings.activeDuck, {
      ...current,
      factor: coerceDuckFactor(factor)
    }));
  }
};

// ---------------------------------------------------------------------------
// Playback / engine state
// ---------------------------------------------------------------------------

const playback = {
  /** @returns {boolean} Whether the module currently has a resolved, playing context. */
  isPlaying: () => !!controller()?.currentContext,

  /** @returns {object|null} The winning context as a frozen descriptor. */
  currentContext: () => describePlaylistContext(controller()?.currentContext ?? null),

  /**
   * Every playlist currently driven by the module - the base context plus every additive layer.
   * @returns {Array<{id: string, name: string}>}
   */
  currentPlaylists() {
    const ctrl = controller();
    if (!ctrl) return [];
    const seen = new Map();
    const add = (playlist) => { if (playlist?.id && !seen.has(playlist.id)) seen.set(playlist.id, { id: playlist.id, name: playlist.name }); };
    add(ctrl.currentContext?.playlist);
    for (const run of ctrl._layers?.values?.() ?? []) add(run?.context?.playlist);
    return [...seen.values()];
  },

  /**
   * A live snapshot of which graph nodes are active for a playlist - the same payload the
   * `gameOrchestraGraphActivity` hook carries, for priming a listener that started late.
   * @param {object|string} playlistOrId
   * @returns {object|null}
   */
  activity: (playlistOrId) => controller()?.getGraphActivity(resolvePlaylist(playlistOrId)) ?? null,

  /**
   * Resolve the winning context and start it. Head GM only.
   * @returns {Promise<void>}
   */
  async play() {
    requireHeadGM('Starting playback');
    refuseSelfReentrant(null, 'Starting playback');
    return controller()?.playCurrentTrack();
  },

  /**
   * Stop the module's playback. Retires engines the same way a transition does, so sounds
   * **crossfade out rather than being cut dead** (H11).
   * @returns {Promise<void>}
   */
  async stop() {
    requireHeadGM('Stopping playback');
    refuseSelfReentrant(null, 'Stopping playback');
    return controller()?.transitionToContext(null);
  }
};

/**
 * Build the public API object.
 *
 * A factory rather than a module-level constant so tests can build one against a fake `game`
 * without importing side effects, and so the entry point controls when it exists.
 * @returns {object} The frozen API.
 */
export function createApi() {
  return Object.freeze({
    version: API_VERSION,
    isHeadGM,
    canControl,
    Error: GameOrchestraApiError,
    hooks: CONST.hooks,
    transport: Object.freeze(transport),
    bind: Object.freeze(bind),
    graph: Object.freeze(graph),
    mix: Object.freeze(mix),
    playback: Object.freeze(playback)
  });
}
