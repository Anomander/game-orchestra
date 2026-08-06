/**
 * Builds the visible content shown inside a graph node on the Drawflow
 * canvas. Nodes are distinguished by shape + icon alone (see game-orchestra.css for
 * the per-type clip-path/border-radius shapes - triangle/octagon/pill/
 * hexagon/parallelogram/diamond) rather than a text label, plus an optional
 * one-line detail summarizing the node's configuration (e.g. a Track node's
 * selected sound name). The type name still appears as the content's `title`
 * attribute (a hover tooltip) so it's not lost for sighted mouse users or
 * screen readers, just not rendered as visible text taking up shape-interior
 * space. Pure functions - no DOM, no Drawflow instance - so they're testable
 * in isolation, matching the pattern already used for the inspector panel
 * (custom-playlist-inspector.mjs).
 *
 * The editor refreshes a node's rendered content directly via plain DOM
 * manipulation (querying `#node-<id> .drawflow_content_node` and replacing
 * its innerHTML) rather than relying on Drawflow's df-* live-binding
 * attributes: that binding only writes to a bound element's `.value`, which
 * has no visual effect on anything but actual form controls (input/select/
 * textarea) - not the plain <div>/<span> a read-only summary line needs.
 */

import { resolveLoop, CONDITION_KINDS_WITH_VALUE, conditionMissingValue } from './custom-playback-schema.mjs';

/**
 * HTML-escape untrusted text (sound/mood names, node labels) before
 * interpolating it into markup built as plain strings. Shared with
 * custom-playlist-inspector.mjs, which imports it from here rather than
 * duplicating it, since this module already exports NODE_LABELS for that
 * file to use.
 * @param {*} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/**
 * The glyph each node type wears on the canvas. Exported because the editor's
 * palette renders each entry as a PREVIEW of the node it adds
 * (custom-playlist-editor.mjs#NODE_PALETTE) and must read the icon from here
 * rather than re-listing it: a second list is free to drift, and a chip showing
 * a different glyph than the node it drops is a lie about what the button does.
 */
export const NODE_ICONS = {
  start: 'fa-play',
  end: 'fa-flag-checkered',
  track: 'fa-music',
  fork: 'fa-code-branch',
  delay: 'fa-clock',
  random: 'fa-dice',
  condition: 'fa-signs-post',
  playlist: 'fa-compact-disc'
};

export const NODE_LABELS = {
  start: 'Start',
  end: 'End',
  track: 'Track',
  fork: 'Fork',
  delay: 'Delay',
  random: 'Random',
  condition: 'Condition',
  playlist: 'Playlist'
};

/**
 * A node's own name, falling back to its type when it has none - which is the
 * case for every node saved before names existed, and is why nothing may
 * assume `label` is set.
 * @param {import('./custom-playback-schema.mjs').GraphNode} node
 * @returns {string}
 */
export function nodeDisplayLabel(node) {
  const label = typeof node?.label === 'string' ? node.label.trim() : '';
  return label || NODE_LABELS[node?.type] || node?.type || '';
}

/**
 * Pick the default name for a newly created node: its type followed by the
 * lowest number that isn't taken yet, so adding three Tracks gives "Track 1",
 * "Track 2", "Track 3" even after "Track 2" has been renamed or deleted.
 * @param {string} type
 * @param {Iterable<string>} [existingLabels] - Names already used in the graph.
 * @returns {string}
 */
export function nextNodeLabel(type, existingLabels = []) {
  const base = NODE_LABELS[type] || type;
  const taken = new Set([...existingLabels].map((label) => String(label ?? '').trim()));
  for (let n = 1; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Below this zoom level a node's text is too small to read, so the canvas
 * drops to showing shape + icon only (see the `[data-zoom-tier='compact']`
 * rules in game-orchestra.css). Borrowed from Grasshopper, which hides component
 * text and widgets the same way as you zoom out - at low zoom the detail line
 * and the name caption stop being information and become noise, and the name
 * in particular is positioned BELOW the node, where at low zoom it collides
 * with whatever sits underneath.
 */
const COMPACT_ZOOM_THRESHOLD = 0.6;

/**
 * Which level of node detail the canvas should render at a given zoom.
 * Deliberately a two-way split rather than a continuous scale: the class it
 * drives is stamped once per zoom change and everything below it is plain CSS.
 * @param {number} zoom - Drawflow's current zoom factor (1 = 100%).
 * @returns {'full'|'compact'} 'compact' hides the detail line and name caption.
 */
export function zoomTier(zoom) {
  // Anything that isn't a usable zoom falls back to showing everything, rather
  // than silently blanking every label on the canvas. Both halves of the guard
  // earn their place: NaN turns up when Drawflow's container measured 0px (see
  // the mount-time size log in custom-playlist-editor.mjs), and the >0 check
  // catches null/0 - Number(null) is 0, which is finite and below the
  // threshold, so without it a missing zoom would read as "zoomed way out".
  const value = Number(zoom);
  return Number.isFinite(value) && value > 0 && value < COMPACT_ZOOM_THRESHOLD ? 'compact' : 'full';
}

/**
 * Node types whose output ports stack down their right edge, and whose shape
 * therefore grows TALLER as exits are added so each port keeps its room.
 *
 * `perExitPx` must stay above the port's own rendered stride (a 16px port plus
 * the vendor's 5px margin-bottom = 25px), or stacked ports overflow the shape.
 * `baseHeightPx` is each type's one-exit height, matching its `min-height` in
 * game-orchestra.css - change one and you must change the other.
 *
 * Condition joined this table when its branch exits moved from the bottom edge
 * to the right-edge stack (see docs/wiki/node-anatomy.md): spread along the
 * bottom, its exit chips collided with each other and buried the name caption,
 * and its fallback exit - which validation requires to be evaluated LAST - sat
 * at the top, reading first. Stacked, evaluation order reads top to bottom and
 * a chip can be any length. `computeNodeWidthPx()` went with it, and so did the
 * 150px box: with the exits gone from the bottom edge and the detail line empty
 * by design (R1), that width had nothing to fill and rendered as a large empty
 * square. All three entries are identical today; the table stays per-type so a
 * future one can differ without touching the others.
 */
const EXIT_STACK_METRICS = {
  fork: { baseHeightPx: 64, perExitPx: 26 },
  random: { baseHeightPx: 64, perExitPx: 26 },
  condition: { baseHeightPx: 64, perExitPx: 26 }
};

/**
 * The height a node's shape needs to give every stacked output port its own
 * room. Types with a fixed shape return null (the editor then leaves their
 * height to CSS rather than setting an inline style).
 * @param {string} type
 * @param {number} [exitCount]
 * @returns {number|null} Target height in pixels, or null if this type doesn't scale.
 */
export function computeNodeHeightPx(type, exitCount) {
  const metrics = EXIT_STACK_METRICS[type];
  if (!metrics) return null;
  const count = Math.max(exitCount ?? 0, 1);
  return metrics.baseHeightPx + (count - 1) * metrics.perExitPx;
}

/**
 * Node types whose exit count is expandable by the user - the ones that grow a
 * new output port on demand (custom-playlist-editor.mjs#handleAddExit), and so
 * the ones that carry the canvas "+" affordance.
 *
 * Exported rather than re-listed per site for the same reason DRAIN_NODE_TYPES
 * is: three places already need this exact answer - the detail line below, the
 * editor's port-count override in _refreshNodeDisplay(), and the "+" button it
 * appends - and a second hardcoded list is free to drift out of step with this
 * one the moment a fourth expandable type is added.
 *
 * If a type ever needs a CAP on its exits, this becomes a Map to a predicate
 * and the "+" gains a disabled state; nothing today is bounded that way (a
 * Fork/Random/Condition may have any number).
 */
export const EXPANDABLE_EXIT_NODE_TYPES = new Set(['fork', 'random', 'condition']);

/**
 * The loop quantifier appended to a Track/Playlist node's detail line, in the
 * shared notation of docs/wiki/node-anatomy.md § Notation:
 *
 *   × 3     exactly three plays, then advance
 *   × ∞     never advances
 *   × 2–8   an until-loop: at least 2, at most 8 (the escape CONDITION is not
 *           here - it is a guard on the node's exit, and renders as that exit's
 *           chip, exactly like a Condition node's branch)
 *   × 2+    an until-loop with no maximum
 *
 * `until` used to fall through to `count ?? 1` and render as "× 1" - identical
 * to a genuine single play, and the single most misleading label the field
 * could produce for a track that loops indefinitely. Routed through
 * resolveLoop() so a missing/malformed loop coerces here exactly as it does in
 * the engine, rather than this being a second, quieter guess at the default.
 * @param {import('./custom-playback-schema.mjs').LoopSpec} [loop]
 * @returns {string} Leading space included, so callers can concatenate directly.
 */
function formatLoopQuantifier(loop) {
  const resolved = resolveLoop({ loop });
  if (resolved.mode === 'forever') return ' × ∞';
  if (resolved.mode === 'until') return resolved.maxLoops == null ? ` × ${resolved.minLoops}+` : ` × ${resolved.minLoops}–${resolved.maxLoops}`;
  return ` × ${resolved.count}`;
}

/**
 * The node's own detail line - channel 3 of docs/wiki/node-anatomy.md, which
 * answers "what does this node do while it holds the token?" and NOTHING about
 * where the token goes next. Anything indexed by exit belongs to that exit's
 * chip instead (computeExitChip), which is why Random and Condition no longer
 * report an exit count here: their chips supersede it. Fork keeps one, because
 * Fork is the one branching type with no chips at all (every exit fires, so
 * there is no per-exit guard to state) and its line would otherwise be empty.
 *
 * @param {import('./custom-playback-schema.mjs').GraphNode} node
 * @param {object} [options]
 * @param {string} [options.soundName] - Resolved display name for node.soundId (Track nodes only).
 * @param {string} [options.refLabel] - Resolved display description for node.playlistRef
 *   (Playlist nodes only) - see playlist-ref.mjs#describePlaylistRef.
 * @param {number} [options.exitCount] - Live output-PORT count, not wired edges: a Fork's line has
 *   to update the instant an exit is added, before any wire reaches it.
 * @param {(key: string, data?: object) => string} [options.localize] - Injected so this module
 *   stays Foundry-free, same convention as playlist-ref.mjs#describePlaylistRef. Defaults to
 *   returning the key.
 * @returns {string} A short, human-readable summary of this node's configuration, or '' for none.
 */
export function computeNodeDetail(node, { soundName, refLabel, exitCount, localize } = {}) {
  const loc = localize || ((key) => key);
  switch (node?.type) {
    case 'track':
      return `${soundName || loc('GameOrchestra.CustomEditor.Node.NoSound')}${formatLoopQuantifier(node.loop)}`;
    case 'delay':
      return `${node.delay?.min ?? 0}–${node.delay?.max ?? 0}s`;
    case 'playlist':
      return `${refLabel || loc('GameOrchestra.CustomEditor.Node.NoPlaylist')}${formatLoopQuantifier(node.loop)}`;
    case 'random':
      // avoidRepeat is node-level, not per-exit, so it belongs here rather than
      // on the chips - and it was previously invisible on the canvas entirely.
      return node.avoidRepeat ? loc('GameOrchestra.CustomEditor.Node.NoRepeat') : '';
    case 'fork':
      return loc('GameOrchestra.CustomEditor.Node.ExitCount', { count: exitCount ?? 0 });
    default:
      return '';
  }
}

/**
 * A condition rendered for a chip: short enough to sit beside a port, unlike
 * the inspector's own longer wording ("Combat Active", "Mood Is"). The lang key
 * suffix is the kind string capitalized, exactly as the inspector derives its
 * own - so a new kind needs no lookup table here either, only a lang entry.
 * @param {import('./custom-playback-schema.mjs').GraphCondition} [condition]
 * @param {object} [lookups]
 * @param {(key: string, data?: object) => string} [lookups.localize]
 * @param {(id: string) => string|null} [lookups.overlayLabel] - Resolves a mood/phase id to its
 *   configured label; the caller owns that lookup so this module stays Foundry-free.
 * @returns {string}
 */
export function describeExitCondition(condition, { localize, overlayLabel } = {}) {
  const loc = localize || ((key) => key);
  const kind = condition?.kind;
  if (!kind) return loc('GameOrchestra.CustomEditor.ExitChip.Unset');
  const label = loc(`GameOrchestra.CustomEditor.ExitChip.${kind.charAt(0).toUpperCase()}${kind.slice(1)}`);
  if (!CONDITION_KINDS_WITH_VALUE.has(kind)) return label;
  // "Unset" is decided by conditionMissingValue(), the same helper
  // graph-validation uses to raise ConditionExitMissingValue - so the chip on
  // the canvas and the error badge on the node can never disagree about what
  // counts as unset. A plain truthiness check would have let a whitespace-only
  // value render as a blank-looking chip while validation flagged it.
  if (conditionMissingValue(condition)) return `${label} = ${loc('GameOrchestra.CustomEditor.ExitChip.Unset')}`;
  return `${label} = ${overlayLabel?.(condition.value) || condition.value}`;
}

/**
 * Total weight across a Random node's exits, for normalizing each one's share.
 * A missing weight counts as 1, matching the engine's own default.
 * @param {Array<{weight?: number}>} [exits]
 * @returns {number}
 */
export function exitWeightTotal(exits) {
  return (exits || []).reduce((sum, exit) => sum + Math.max(0, Number.isFinite(exit?.weight) ? exit.weight : 1), 0);
}

/**
 * The chip for one exit - channel 4 of docs/wiki/node-anatomy.md, answering
 * "when or why does the token leave by THIS exit?".
 *
 * Returns null for an UNGUARDED exit, and that absence is meaningful: a Fork's
 * exits all fire together, a Start/Delay/Playlist/counted-Track has exactly one
 * unconditional exit, and none of them get a chip. Only three things are guards
 * today - a Random exit's weight, a Condition exit's predicate, and an until
 * Track's escape condition. The last two produce identical chips on purpose:
 * an until-loop's escape condition IS a guard on that node's one exit, so it
 * should read exactly like a Condition branch rather than inventing a notation.
 *
 * @param {import('./custom-playback-schema.mjs').GraphNode} node - The exit's SOURCE node.
 * @param {object} [exit] - That exit's metadata from the node's parallel data.exits[] (H5).
 * @param {object} [options]
 * @param {number} [options.weightTotal] - From exitWeightTotal(), so every chip on a Random node
 *   normalizes against the same total rather than each recomputing it.
 * @param {(key: string, data?: object) => string} [options.localize]
 * @param {(id: string) => string|null} [options.overlayLabel]
 * @returns {{text: string, cooldown: number|null, title: string}|null}
 */
export function computeExitChip(node, exit, { weightTotal, localize, overlayLabel } = {}) {
  const loc = localize || ((key) => key);
  if (node?.type === 'random') {
    // Weights are RELATIVE, so the number itself says nothing without the
    // others - a share is the only reading that works from the canvas alone.
    // Rounded independently per exit rather than forced to sum to 100: a
    // largest-remainder pass would silently show a weight as something its own
    // value doesn't explain.
    const weight = Math.max(0, Number.isFinite(exit?.weight) ? exit.weight : 1);
    const total = weightTotal ?? weight;
    const percent = total > 0 ? Math.round((weight / total) * 100) : 0;
    const cooldown = Math.max(0, Math.round(Number(exit?.cooldown) || 0));
    return {
      text: `${percent}%`,
      cooldown: cooldown > 0 ? cooldown : null,
      title: loc('GameOrchestra.CustomEditor.ExitChip.WeightTitle', { weight, total, percent, cooldown })
    };
  }
  // An until Track guards its single exit with the loop's escape condition;
  // every other loop mode leaves unconditionally and gets no chip.
  const condition = node?.type === 'condition' ? exit?.condition : node?.type === 'track' && node.loop?.mode === 'until' ? node.loop.condition : null;
  if (!condition) return null;
  const text = describeExitCondition(condition, { localize, overlayLabel });
  return { text, cooldown: null, title: text };
}

/**
 * @param {{text: string, cooldown: number|null, title: string}|null} chip - From computeExitChip().
 * @returns {string} HTML for the chip element, or '' when the exit is unguarded.
 */
export function buildExitChipHtml(chip) {
  if (!chip) return '';
  // The cooldown rides along as an icon rather than more words: it is rare, and
  // the chip has to stay short enough to sit beside a port without becoming the
  // most prominent thing on the canvas.
  const cooldownHtml = chip.cooldown ? ` <i class="fas fa-hourglass-half"></i>${escapeHtml(chip.cooldown)}` : '';
  return `<span class="game-orchestra-exit-chip" title="${escapeHtml(chip.title)}">${escapeHtml(chip.text)}${cooldownHtml}</span>`;
}

/**
 * Node types that render a drain overlay - see buildNodeInnerHtml(). Exported
 * for the editor, which needs the same answer to decide whether an engine
 * timing has anywhere to be painted, and must not re-derive it from a second
 * hardcoded list that could drift out of step with this one.
 */
export const DRAIN_NODE_TYPES = new Set(['delay', 'track']);

/**
 * @param {string} type - Node type ('start'|'end'|'track'|'fork'|'delay'|'random'|'condition').
 * @param {string} [detail] - Precomputed detail line from computeNodeDetail(), or '' for none.
 * @param {object} [options]
 * @param {string} [options.label] - The node's name, rendered on a caption BELOW the
 *   shape (positioned by CSS) rather than inside it - several shapes clip their own
 *   corners away, leaving too little interior room for a name of any useful length.
 * @returns {string} HTML for the node's .drawflow_content_node inner content.
 */
export function buildNodeInnerHtml(type, detail, { label } = {}) {
  const icon = NODE_ICONS[type] || 'fa-circle';
  const typeLabel = NODE_LABELS[type] || type;
  const detailHtml = detail ? `<div class="game-orchestra-node-detail">${escapeHtml(detail)}</div>` : '';
  const labelHtml = label ? `<div class="game-orchestra-node-name">${escapeHtml(label)}</div>` : '';
  // The drain overlay, for the two node types that hold a token for a KNOWN
  // length of time: a Delay's wait, and a Track's one pass through its sound.
  // Both show the same thing - how much of the current stretch is left - and
  // both are driven by the engine's real timings (see _setNodeDrain); only the
  // direction differs, and that is CSS's business, not this function's.
  //
  // Two elements, not one: the outer is clipped to the node's own shape and
  // stays put, while the inner is the level the countdown animates. One element
  // can't both clip itself to a shape and animate inside that clip.
  const fillHtml = DRAIN_NODE_TYPES.has(type) ? '<span class="game-orchestra-node-fill"><span class="game-orchestra-node-fill-level"></span></span>' : '';
  return `${fillHtml}<div class="game-orchestra-node-content" title="${escapeHtml(typeLabel)}"><i class="fas ${icon} game-orchestra-node-icon"></i>${detailHtml}</div>${labelHtml}`;
}
