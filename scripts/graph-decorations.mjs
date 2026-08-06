/**
 * The one rule for decorating Drawflow's own elements: a marker this editor
 * puts on a PORT (`.output.output_N`) or a CONNECTION (`<svg class="connection">`)
 * is an ATTRIBUTE, never a class.
 *
 * Drawflow reads those two elements' class lists BY POSITION, and it rewrites
 * them in place:
 *
 * - `updateConnectionNodes()` (which runs on every drag frame and at the end of
 *   every `removeNodeOutput()`) resolves a wire's endpoints as
 *   `classList[3]`/`classList[4]` - the `output_N`/`input_N` pair - and
 *   immediately reads `.offsetWidth` off whatever those select.
 * - `removeNodeOutput()` renumbers a wire's port class by REMOVING
 *   `output_N` and `input_N` and re-ADDING them, which moves them to the END of
 *   the class list. Any class of ours already on that element slides down into
 *   index 3, and the very next `updateConnectionNodes()` dereferences
 *   `undefined`.
 *
 * That is not a hypothetical. Reproduced against the vendored drawflow.min.js in
 * a real DOM: with `game-orchestra-edge-uncertain` on the wire, deleting a
 * Random node's middle exit threw `Cannot read properties of undefined (reading
 * 'offsetWidth')` from inside `removeNodeOutput()` - so `handleRemoveExit()`
 * aborted midway, after Drawflow had dropped the port but BEFORE the matching
 * `data.exits[]` entry was spliced. The node was left with two ports and three
 * exits, its weight chips still reading 33% each, and the mangled class order
 * then made every later `updateConnectionNodes()` on that node throw too (so
 * dragging it stopped working) until the window was reopened.
 *
 * The same positional read applies to ports: `removeNodeOutput()` finds a port's
 * index at `classList[1]` and renumbers it with the same remove/re-add.
 *
 * Attributes are invisible to all of that. Style them with `[data-go-*]`
 * selectors, which carry the same specificity as a class.
 *
 * Node elements are NOT covered by this rule and keep their classes - Drawflow
 * only ever reads `classList[0]` there (`'drawflow-node'`, which it never
 * rewrites), so appended classes are safe.
 */

/** Applied while an inspector exit row is hovered, to point out its exit on the canvas. */
export const PORT_HOVER_ATTR = 'data-go-port-hover';
export const EDGE_HOVER_ATTR = 'data-go-edge-hover';

/**
 * Lifts a port out of its tucked-in resting size (see the port-dot block in
 * game-orchestra.css). Applied to both ports of whichever wire the pointer is
 * over - hovering a port itself is handled by plain CSS `:hover` and needs no
 * marker.
 */
export const PORT_REVEAL_ATTR = 'data-go-port-revealed';

/** Applied to wires leaving a Random/Condition node - see uncertainEdges(). */
export const UNCERTAIN_EDGE_ATTR = 'data-go-edge-uncertain';

/**
 * Applied to a connection named by an issue's `edgeIds` - see
 * _refreshIssueEdges(). One marker for both severities, unlike the node state
 * classes: the only issue that names edges today is an error, and a wire is too
 * thin to carry a glyph the way a badge does, so a second colour here would be
 * distinguishable by hue alone.
 */
export const ISSUE_EDGE_ATTR = 'data-go-edge-issue';

/** Playback highlight on a wire - see editor-highlight-mixin.mjs. */
export const ACTIVE_EDGE_ATTR = 'data-go-edge-active';
export const PULSE_EDGE_ATTR = 'data-go-edge-pulse';

/**
 * Applied to the wire a drag is currently over, while something draggable is being held above
 * the canvas - the "drop here to splice this node into this edge" affordance
 * (_setInsertTargetEdge). Loud on purpose: unlike every other marker here it appears only during
 * a drag, and it is promising a rewire rather than reporting a state.
 */
export const INSERT_EDGE_ATTR = 'data-go-edge-insert';

/**
 * Add or remove one marker attribute on a port/connection element.
 *
 * Optional-chained throughout for the same reason the classList calls it
 * replaced were: every caller resolves its element from a live DOM query that
 * can legitimately match nothing (a wire deleted while hovered, a port removed
 * mid-refresh), and a marker that lands nowhere is never worth a throw.
 * @param {Element|null|undefined} el
 * @param {string} attr - One of the *_ATTR constants above.
 * @param {boolean} on
 */
export function setMarker(el, attr, on) {
  if (on) el?.setAttribute?.(attr, '');
  else el?.removeAttribute?.(attr);
}

/**
 * Drop one marker from every element in a container that carries it - the
 * "clear wholesale, then reapply" half of the repaints that don't diff.
 * @param {Element|null|undefined} container
 * @param {string} attr - One of the *_ATTR constants above.
 */
export function clearMarkers(container, attr) {
  for (const el of container?.querySelectorAll?.(`[${attr}]`) || []) setMarker(el, attr, false);
}
