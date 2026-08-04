/**
 * Drawflow has no built-in concept of a self-loop (a node whose own output
 * connects back to its own input) - its default bezier curve just draws
 * directly between the two port positions, which for a self-loop cuts
 * straight across (or through) the node's own body instead of visibly
 * looping around it. There is no supported way to influence this: Drawflow's
 * interactive "reroute point" feature is only reachable via a live
 * double-click gesture (it reads the mouse position at click time), not a
 * documented programmatic API.
 *
 * The approach here is instead to let Drawflow compute the connection as
 * normal (so its start/end coordinates stay correct across zoom/pan, which
 * apply via a CSS transform on the whole canvas and don't need recomputing),
 * then parse the *known-correct* endpoints back out of the `d` attribute
 * Drawflow already wrote and replace only the curve's *shape* with a wide
 * arc that clears the node's own bounding box - never touching Drawflow's
 * own endpoint math, only overriding its cosmetic path.
 *
 * This module also decides which wires are drawn as "uncertain" - see
 * uncertainEdges() below.
 */

import { portFromEdgeId } from './graph-activity-highlight.mjs';

/**
 * Node types whose exits are NOT all taken. A Random picks exactly one of its
 * exits; a Condition picks the first exit whose test passes (and its fallback
 * only fires when none of them do, so the fallback is no more certain than a
 * branch and gets no special case).
 *
 * A Fork is deliberately absent: it takes every one of its exits at once, so
 * its wires are as certain as a Track's single exit. Start/Track/Delay/Playlist
 * all have exactly one exit that is always eventually followed.
 */
const UNCERTAIN_SOURCE_TYPES = new Set(['random', 'condition']);

/**
 * The edges whose traversal is conditional, for the editor to draw thinner and
 * faded (a Grasshopper borrow: there, wire style encodes the kind of data
 * flowing through it). Width+opacity rather than colour or a dash pattern
 * specifically so this composes with every existing wire state - the active/
 * pulse highlight owns the dash pattern and cyan, and exit-row hover owns
 * amber, so an uncertain wire that is also currently being followed still
 * reads as both.
 *
 * Pure - takes the working graph and returns plain refs; the caller turns them
 * into selectors via graph-activity-highlight.mjs#edgeSelector.
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @returns {Array<{from: string, to: string, port: string|null}>} EdgeRef-shaped,
 *   matching what edgeSelector() consumes.
 */
export function uncertainEdges(graph) {
  const typeById = new Map((graph?.nodes || []).map((n) => [n?.id, n?.type]));
  return (graph?.edges || [])
    .filter((edge) => UNCERTAIN_SOURCE_TYPES.has(typeById.get(edge?.from)))
    .map((edge) => ({ from: edge.from, to: edge.to, port: portFromEdgeId(edge.id) }));
}

/**
 * How far (px) a wire runs straight out of a port along that port's own normal
 * before it starts curving. This is the "parallel part": without it a wire
 * leaves the port aimed straight at its destination, which reads as the wire
 * cutting into the node rather than plugging into it, and looks outright wrong
 * on a port that faces up or down (a Condition's exits) since Drawflow's own
 * curve is horizontal at both ends regardless of which edge the port sits on.
 */
const CONNECTION_STUB_PX = 10;

/**
 * Bezier handle length, as applied to the span split into two components: how
 * far the far end lies ALONG this port's normal, and how far it lies PERPENDICULAR
 * to it. Plus a floor and a cap.
 *
 * Handle length is what sets how tight the wire's turns are, and the
 * relationship is the opposite of what it looks like: a *short* handle
 * produces a HARD turn. The path has to get from its port-parallel departure
 * to the heading that reaches the far end, and the handle is the distance it
 * has to do that in - short handles cram the whole direction change into a
 * small radius near the port (a visible elbow), long handles spread it into
 * one gentle sweep.
 *
 * Splitting the span matters because the two components want different things:
 * distance straight ahead can be eaten up gradually (hence the larger 0.5),
 * while distance off to the side has to be turned through (hence 0.35, enough
 * to round the turn without overshooting). Measuring plain straight-line
 * distance instead over-reaches on a wire whose target is off to one side, and
 * Drawflow's own version - which measures only the HORIZONTAL gap - collapses
 * to a straight diagonal for vertically-stacked nodes and bows the wrong way
 * for a target to the left.
 *
 * The floor keeps a very short wire from kinking; the cap keeps a very long
 * one from bowing, and only engages where a 280px radius is already gentle.
 *
 * These four were raised together (from 0.5 / 0.35 / 28 / 240) to make wires
 * visibly rounder, which is a look, not a correctness property - so it was
 * chosen by rendering the router's output for nine representative geometries
 * at four settings and measuring each, rather than by eye alone. Two things
 * that fall out of that and are easy to get wrong:
 *
 * - Longer handles alone make the tightest turn on the canvas WORSE, not
 *   better. Past roughly these values the two control points start reaching
 *   past each other and the curve folds into an S with a hard middle - a
 *   forward wire with a slight drop is the first to go, and a backward one
 *   from a Condition's downward exit is the worst of them.
 * - The backward swing below has to come up with them. At the old 0.45 the
 *   tightest turn across those geometries dropped from 21px to 11px; at 0.6 it
 *   lands back at 18px, i.e. no worse than before while every wire bows about
 *   a quarter more. Raise one of these and re-check the other.
 */
const CONNECTION_CURVE_RATIO = 0.65;
const CONNECTION_PERP_RATIO = 0.45;
const CONNECTION_MIN_CURVE_PX = 36;
const CONNECTION_MAX_CURVE_PX = 280;

/**
 * How far a control point is pushed sideways when the far end lies BEHIND the
 * port (a wire that has to double back - a loop to an earlier node, the common
 * case in a music graph).
 *
 * Handle length alone cannot fix this one: a wire leaving rightward that has
 * to arrive at something on its left must reverse, and at every handle length
 * the curve folds back through itself into a cusp - a literal zero-radius
 * corner, measured. Pushing both control points to the same side separates the
 * two lobes so the reversal becomes a smooth U instead. Applied only on the
 * ends that are actually facing backwards, so an ordinary forward wire is
 * untouched.
 *
 * Tied to the handle lengths above: the longer the handles, the more sideways
 * separation the reversal needs before the two lobes stop colliding. See the
 * second bullet in that comment before changing either.
 */
const CONNECTION_BACKWARD_SWING_RATIO = 0.6;
const CONNECTION_MAX_SWING_PX = 300;

/** Unit vector pointing out of a port, away from the node it belongs to. */
const PORT_NORMALS = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };

/** Trim float noise out of the emitted path - these are screen pixels. */
const round = (n) => Math.round(n * 100) / 100;

/**
 * The bezier control point for one end of a wire: out along that port's own
 * normal by the handle length, plus a sideways swing if the far end is behind
 * it.
 *
 * Computed per end, from that end's own normal, because the two ends can
 * disagree about which way the wire is going: a Condition's downward exit
 * reaching a node that is below but to the LEFT is travelling forwards as far
 * as the exit is concerned, and backwards as far as the left-facing input is
 * concerned. Judging both ends by the source's normal leaves the input end
 * folding back through itself - measured as a zero-radius cusp.
 * @param {number} px - This port's stub end.
 * @param {number} py
 * @param {number} normalX - This port's outward normal.
 * @param {number} normalY
 * @param {number} otherX - The wire's other stub end.
 * @param {number} otherY
 * @param {number} maxCurve
 * @returns {[number, number]}
 */
function controlPoint(px, py, normalX, normalY, otherX, otherY, maxCurve) {
  const dx = otherX - px;
  const dy = otherY - py;
  // Split the span relative to THIS port's normal: how far ahead, and how far
  // off to the side. Cross product magnitude gives the perpendicular distance
  // without needing to know which side it falls on.
  const along = dx * normalX + dy * normalY;
  const perp = Math.abs(dx * normalY - dy * normalX);
  const handle = Math.min(
    Math.max(CONNECTION_CURVE_RATIO * Math.max(along, 0) + CONNECTION_PERP_RATIO * perp, CONNECTION_MIN_CURVE_PX),
    maxCurve
  );
  const swing = along < 0 ? Math.min(-along * CONNECTION_BACKWARD_SWING_RATIO, CONNECTION_MAX_SWING_PX) : 0;
  // Perpendicular to this port's normal, oriented toward whichever side the far
  // end lies on, so a doubling-back wire sweeps around the short way.
  let swingX = -normalY;
  let swingY = normalX;
  if (dx * swingX + dy * swingY < 0) {
    swingX = -swingX;
    swingY = -swingY;
  }
  return [px + normalX * handle + swingX * swing, py + normalY * handle + swingY * swing];
}

/**
 * Build a wire that leaves its source port and enters its target port along
 * each port's own outward normal, instead of Drawflow's always-horizontal
 * curve.
 *
 * Shape is stub → curve → stub: a short straight run along the normal at each
 * end, joined by a cubic whose control points continue along those same
 * normals (so the straight-to-curve joins are smooth, with no visible corner).
 * Direction matters because not every port faces right: a Condition node
 * spreads its branch exits along its BOTTOM edge and puts its fallback on top,
 * and those wires have to set off down and up respectively.
 *
 * The stub is deliberately short and the curve handles deliberately long - see
 * CONNECTION_CURVE_RATIO. A long stub forces more perpendicular travel that the
 * curve then has to undo, and short handles concentrate that correction into a
 * tight elbow; both read as the wire making a hard turn.
 *
 * Each end gets its own control point from controlPoint(), computed against its
 * own normal - the two ends genuinely can disagree about which way the wire is
 * heading.
 *
 * @param {number} startX - Source port centre.
 * @param {number} startY
 * @param {number} endX - Target port centre.
 * @param {number} endY
 * @param {object} [options]
 * @param {'right'|'left'|'up'|'down'} [options.startDir] - Which way the source port faces.
 * @param {'right'|'left'|'up'|'down'} [options.endDir] - Which way the target port faces.
 *   Inputs sit on the left edge for every node type, so this is 'left' in practice.
 * @param {number} [options.stub] - Straight run length at each end.
 * @param {number} [options.maxCurve] - Cap on the bezier handle length.
 * @returns {string} An SVG path `d` string.
 */
export function buildRoutedPath(startX, startY, endX, endY, { startDir = 'right', endDir = 'left', stub = CONNECTION_STUB_PX, maxCurve = CONNECTION_MAX_CURVE_PX } = {}) {
  const [startNormalX, startNormalY] = PORT_NORMALS[startDir] || PORT_NORMALS.right;
  const [endNormalX, endNormalY] = PORT_NORMALS[endDir] || PORT_NORMALS.left;
  const ax = startX + startNormalX * stub;
  const ay = startY + startNormalY * stub;
  const bx = endX + endNormalX * stub;
  const by = endY + endNormalY * stub;
  const [c1x, c1y] = controlPoint(ax, ay, startNormalX, startNormalY, bx, by, maxCurve);
  const [c2x, c2y] = controlPoint(bx, by, endNormalX, endNormalY, ax, ay, maxCurve);
  return `M ${round(startX)} ${round(startY)} L ${round(ax)} ${round(ay)} C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(bx)} ${round(by)} L ${round(endX)} ${round(endY)}`;
}

/**
 * Recover a wire's two endpoints from any `d` string this editor deals with -
 * Drawflow's own "M x y C …", buildSelfLoopPath()'s output, or
 * buildRoutedPath()'s stub/curve/stub form. It simply takes the first and last
 * coordinate pair, which every one of those formats starts and ends with.
 *
 * Format-agnostic on purpose: the routing pass re-reads paths it may itself
 * have written (nothing guarantees Drawflow rewrote one in between), so a
 * parser that only understood Drawflow's format would quietly fail on the
 * second pass and leave wires unrouted.
 * @param {string} d
 * @returns {{startX: number, startY: number, endX: number, endY: number}|null}
 */
export function parsePathEndpoints(d) {
  const matches = String(d ?? '').match(/-?\d*\.?\d+/g);
  if (!matches || matches.length < 4) return null;
  const values = matches.map(Number);
  const points = {
    startX: values[0],
    startY: values[1],
    endX: values[values.length - 2],
    endY: values[values.length - 1]
  };
  return Object.values(points).every((n) => Number.isFinite(n)) ? points : null;
}

/**
 * Resolve a rendered connection's own class list to CSS selectors for the two
 * ports it joins - what "hovering this wire lights up its ports" needs, given
 * only the `<svg class="connection">` the pointer is over.
 *
 * Drawflow tags every completed connection with four endpoint classes:
 * `node_out_node-<id>` / `node_in_node-<id>` for the nodes, and `output_N` /
 * `input_N` for the ports. They are matched here by shape, not by position:
 * the vendor reads them as classList[1]..[4], and it renumbers a port class by
 * removing and re-adding it, which reorders the list - so their indices are not
 * ours to depend on. (This editor's own wire markers stay out of the class list
 * entirely and are attributes - see graph-decorations.mjs for what happened when
 * they weren't.)
 * @param {Iterable<string>} classNames - The element's `classList`.
 * @returns {{output: string, input: string}|null} null for anything that isn't
 *   a completed connection - notably the in-progress wire Drawflow draws while
 *   you drag one out of a port, which carries the bare `connection` class and
 *   only gains its endpoint classes once it lands.
 */
export function connectionPortSelectors(classNames) {
  const classes = Array.from(classNames || []).filter((name) => typeof name === 'string');
  const outNode = classes.find((name) => name.startsWith('node_out_'));
  const inNode = classes.find((name) => name.startsWith('node_in_'));
  const outputPort = classes.find((name) => /^output_\d+$/.test(name));
  const inputPort = classes.find((name) => /^input_\d+$/.test(name));
  if (!outNode || !inNode || !outputPort || !inputPort) return null;
  return {
    output: `#${outNode.slice('node_out_'.length)} .outputs .output.${outputPort}`,
    input: `#${inNode.slice('node_in_'.length)} .inputs .input.${inputPort}`
  };
}

/**
 * Parse the start and end points out of an SVG path `d` string in the exact
 * format Drawflow's own createCurvature() produces: "M x y C x1 y1 x2 y2 x y".
 * @param {string} d
 * @returns {{startX: number, startY: number, endX: number, endY: number}|null}
 */
export function parseCurvePath(d) {
  const match = /M\s*(-?[\d.]+)\s+(-?[\d.]+)\s*C\s*-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(d || '');
  if (!match) return null;
  return { startX: parseFloat(match[1]), startY: parseFloat(match[2]), endX: parseFloat(match[3]), endY: parseFloat(match[4]) };
}

/**
 * Build an SVG path `d` string that visibly arcs from (startX,startY) to
 * (endX,endY) via a wide loop, rather than a near-direct line - both bezier
 * control points are pulled up to the same height, well clear of the node,
 * producing a single smooth "hump" shape over the top of it.
 * @param {number} startX
 * @param {number} startY
 * @param {number} endX
 * @param {number} endY
 * @param {number} clearance - How far (px) above the higher of the two endpoints the arc's peak should clear.
 * @returns {string}
 */
export function buildSelfLoopPath(startX, startY, endX, endY, clearance) {
  const peakY = Math.min(startY, endY) - Math.max(clearance, 0);
  return `M ${startX} ${startY} C ${startX} ${peakY} ${endX} ${peakY} ${endX} ${endY}`;
}
