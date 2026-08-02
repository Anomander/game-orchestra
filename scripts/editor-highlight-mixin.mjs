import { computeHighlight, edgeSelector } from './graph-activity-highlight.mjs';

/**
 * How long (ms) an instantaneous node or a just-followed edge stays flashed.
 * A token crosses Start/Fork/Random/Condition in well under a millisecond, so
 * without this the highlight would appear to teleport between Track nodes with
 * nothing visible in between.
 */
const ACTIVITY_PULSE_MS = 700;

const ACTIVE_NODE_CLASS = 'game-orchestra-node-active';
const PULSE_NODE_CLASS = 'game-orchestra-node-pulse';
const ACTIVE_EDGE_CLASS = 'game-orchestra-edge-active';
const PULSE_EDGE_CLASS = 'game-orchestra-edge-pulse';

/**
 * Which keyframes drain which node type - a Delay empties downward over its
 * wait, a Track sweeps left to right over one pass of its sound. Both are
 * declared in game-orchestra.css next to the overlay they animate; see _setNodeDrain
 * for why the name is applied from here rather than by a per-type CSS rule.
 */
const DRAIN_ANIMATIONS = { delay: 'game-orchestra-delay-drain', track: 'game-orchestra-track-drain' };

/**
 * Live playback-highlight painting for CustomPlaylistEditor's canvas,
 * extracted from custom-playlist-editor.mjs to keep that file's already-large
 * DOM/Drawflow surface from growing further. Pure method definitions added to
 * the class's prototype chain via mixin - no different in behavior from
 * defining them directly in the class body, since every method here still
 * runs with `this` bound to the live CustomPlaylistEditor instance.
 *
 * Field ownership (initialized in CustomPlaylistEditor's own constructor, not
 * here): `_activityHighlight` (the highlight state currently painted, so it
 * can be lifted again before the next one is applied), `_pulseTimeout`.
 *
 * `_nodeElement()`/`_connectionElements()` are general-purpose DOM lookups
 * also used elsewhere in custom-playlist-editor.mjs (_refreshNodeDisplay,
 * _focusNode, editor-selection-mixin.mjs's group drag) - they live here
 * because this is their heaviest consumer, not because they're
 * highlight-exclusive; mixin composition makes them reachable via `this`
 * from every other method on the class regardless of which file defines them.
 * @param {typeof ApplicationV2} Base
 */
export function EditorHighlightMixin(Base) {
  return class extends Base {
    /**
     * Handle one 'gameOrchestraGraphActivity' broadcast from a running playback engine.
     * Payloads for other playlists are ignored; a null payload (nothing playing,
     * or this client isn't the head GM) clears the highlight.
     * @param {object|null} payload
     * @private
     */
    _onGraphActivity(payload) {
      if (payload && payload.playlistId !== this.playlist?.id) return;
      this._applyActivityHighlight(computeHighlight(this.graph, payload));
    }

    /**
     * Paint the playback highlight onto the canvas: a persistent glow on the
     * nodes holding a token plus their known exit edges, and a short-lived flash
     * on whatever a token just crossed.
     *
     * Always lifts the previous highlight first rather than diffing. Drawflow
     * rewrites connection paths on every drag frame and destroys/recreates the
     * whole `<svg class="connection">` element when a connection is remade, so a
     * class applied earlier cannot be assumed to still be where it was put -
     * re-resolving both sides from ids each time keeps this idempotent.
     *
     * Pure classList work: never this.render() (see the class doc) and never
     * _renderInspector() either - playback state has no bearing on the inspector.
     * @param {ReturnType<import('./graph-activity-highlight.mjs').computeHighlight>} state
     * @private
     */
    _applyActivityHighlight(state) {
      if (!this._drawflow?.container) return;
      this._liftActivityHighlight();

      for (const id of state.activeNodeIds) this._nodeElement(id)?.classList?.add(ACTIVE_NODE_CLASS);
      for (const id of state.pulseNodeIds) this._nodeElement(id)?.classList?.add(PULSE_NODE_CLASS);
      for (const edge of state.activeEdges) {
        for (const el of this._connectionElements(edge)) el.classList?.add(ACTIVE_EDGE_CLASS);
      }
      for (const edge of state.pulseEdges) {
        for (const el of this._connectionElements(edge)) el.classList?.add(PULSE_EDGE_CLASS);
      }
      for (const timing of state.activeTimings || []) this._setNodeDrain(timing.nodeId, timing);
      this._activityHighlight = state;

      if (this._pulseTimeout) clearTimeout(this._pulseTimeout);
      if (state.pulseNodeIds.length > 0 || state.pulseEdges.length > 0) {
        this._pulseTimeout = setTimeout(() => this._clearPulseHighlight(), ACTIVITY_PULSE_MS);
      } else {
        this._pulseTimeout = null;
      }
    }

    /**
     * Remove every class the last _applyActivityHighlight() added.
     * @private
     */
    _liftActivityHighlight() {
      const previous = this._activityHighlight;
      if (!previous) return;
      for (const id of [...previous.activeNodeIds, ...previous.pulseNodeIds]) {
        this._nodeElement(id)?.classList?.remove(ACTIVE_NODE_CLASS, PULSE_NODE_CLASS);
      }
      for (const edge of [...previous.activeEdges, ...previous.pulseEdges]) {
        for (const el of this._connectionElements(edge)) el.classList?.remove(ACTIVE_EDGE_CLASS, PULSE_EDGE_CLASS);
      }
      for (const timing of previous.activeTimings || []) this._setNodeDrain(timing.nodeId, null);
      this._activityHighlight = null;
    }

    /**
     * Drop just the transient part of the highlight once its flash has run,
     * leaving the persistent active-node/active-edge glow in place.
     * @private
     */
    _clearPulseHighlight() {
      this._pulseTimeout = null;
      const current = this._activityHighlight;
      if (!current) return;
      for (const id of current.pulseNodeIds) this._nodeElement(id)?.classList?.remove(PULSE_NODE_CLASS);
      for (const edge of current.pulseEdges) {
        for (const el of this._connectionElements(edge)) el.classList?.remove(PULSE_EDGE_CLASS);
      }
      this._activityHighlight = { ...current, pulseNodeIds: [], pulseEdges: [] };
    }

    /**
     * Run (or stop) a node's drain: an overlay that starts full and empties over
     * the time the engine says that node holds its token for. A Delay drains
     * downward over its wait, like sand through an hourglass; a Track drains
     * left to right over one pass of its sound, restarting on each loop.
     *
     * Driven by a CSS animation given the real duration rather than by a
     * per-frame timer here - the browser then owns the interpolation, and it
     * keeps working while this window is busy. The negative animation-delay is
     * what makes an editor opened halfway through a wait (or three loops into a
     * track) pick the drain up where it actually is instead of restarting it
     * from full.
     *
     * The animation NAME has to be written here rather than left to a per-type
     * CSS rule, even though the direction is otherwise purely a styling
     * question. Clearing only the inline duration would leave the CSS-named
     * animation attached to the element with a 0s duration, already finished,
     * and its start time is fixed at the moment the name first applied - so
     * re-arming it later by setting a duration would resume a timeline that has
     * been running since the node was drawn, not start a fresh one, and the
     * negative delay would land somewhere meaningless.
     * @param {string} nodeId
     * @param {{durationMs: number, startedAt: number, iterations?: number|null, type?: string}|null} timing -
     *   null to stop. `iterations` null = repeat indefinitely (a forever or
     *   until loop), absent = one run; `type` picks the drain direction.
     * @private
     */
    _setNodeDrain(nodeId, timing) {
      const el = this._drawflow?.container?.querySelector?.(`#node-${nodeId} .game-orchestra-node-fill-level`);
      if (!el?.style) return;
      el.style.animation = '';
      if (!timing) return;
      const animation = DRAIN_ANIMATIONS[timing.type];
      // A timing for a type with no drain overlay (nothing emits one today, but
      // the payload is the engine's, not this file's) simply leaves it stopped.
      if (!animation) return;
      // Reading a layout property between clearing and re-setting forces the
      // style flush that makes the browser treat this as a NEW animation; without
      // it, re-entering the same Delay would leave the old (finished) one in place.
      void el.offsetHeight;
      const elapsedMs = Math.max(0, Date.now() - (timing.startedAt ?? Date.now()));
      // null and undefined mean different things here, so `??` would be wrong:
      // an explicit null is the engine saying "this repeats until something
      // stops it" (a forever/until Track), while a payload that carries no
      // iterations at all is a single run - which is every Delay.
      const iterations = timing.iterations === undefined ? 1 : timing.iterations === null ? 'infinite' : Math.max(1, timing.iterations);
      el.style.animation = `${animation} ${Math.max(0, timing.durationMs || 0)}ms linear ${-elapsedMs}ms ${iterations} forwards`;
    }

    /**
     * @param {string} nodeId
     * @returns {Element|null}
     * @private
     */
    _nodeElement(nodeId) {
      return this._drawflow?.container?.querySelector?.(`#node-${nodeId}`) || null;
    }

    /**
     * Every rendered connection matching an edge. Plural because an edge whose id
     * carried no port matches all connections between that node pair - see
     * edgeSelector().
     * @param {{from: string, to: string, port: string|null}} edge
     * @returns {Iterable<Element>}
     * @private
     */
    _connectionElements(edge) {
      return this._drawflow?.container?.querySelectorAll?.(edgeSelector(edge)) || [];
    }
  };
}
