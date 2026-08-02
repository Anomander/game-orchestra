import { INSTANTANEOUS_NODE_TYPES, conditionMissingValue, conditionSignature } from './custom-playback-schema.mjs';
import { nodeDisplayLabel } from './custom-playlist-node-render.mjs';
import { PLAYLIST_REF_SOURCES, PLAYLIST_REF_SECTIONS, PLAYLIST_REF_OVERLAY_MODES } from './playlist-ref.mjs';
import { CONST } from './config.mjs';

/**
 * Mirrors Foundry's CONST.PLAYLIST_MODES.UNSEQUENCED. Hardcoded rather than read
 * off `globalThis.CONST` (the fallback the rest of the codebase uses) because this
 * module has no dependency on a live Foundry environment at all - see the header
 * comment on validateGraph().
 */
const UNSEQUENCED_MODE = -1;

/**
 * @typedef {object} ValidationIssue
 * @property {string|null} nodeId - The offending node, or null for a graph-wide issue.
 * @property {string|null} nodeLabel - That node's display name, so a message can say which
 *   node it is about without the reader having to hunt for a highlighted shape.
 * @property {string} messageKey - i18n key under GameOrchestra.CustomEditor.Validation.*; this
 *   module has no dependency on Foundry/game.i18n, so it emits keys (+ optional
 *   messageData for interpolation) rather than localized strings - the caller localizes
 *   at the render boundary (custom-playlist-inspector.mjs, custom-playlist-editor.mjs).
 * @property {object} [messageData] - Interpolation data for game.i18n.format(), when the
 *   message has a placeholder - UnknownNodeType's {type}, ConditionExitDuplicate's
 *   {index}/{first}, InstantaneousCycle's {path}.
 * @property {string[]} [nodeIds] - Every node the issue implicates, when it is about a
 *   RELATIONSHIP between nodes rather than one node's own settings (a cycle is the only
 *   such issue today). `nodeId` is then the first of them, so the existing click-to-focus
 *   still has one place to jump to; the editor badges all of them.
 * @property {string[]} [edgeIds] - Likewise for the edges involved, so the editor can
 *   colour the offending connections rather than leaving the reader to infer which of a
 *   large graph's wires form the loop.
 */

/**
 * Find a cycle confined entirely to instantaneous node types (start, fork,
 * random, condition - end has no exits and can't participate). Such a cycle
 * would spin the engine's synchronous walk without ever reaching a Track or
 * Delay node to hold the token for real time - and with a Fork on it, each lap
 * MULTIPLIES the token count, so the engine's MAX_SYNCHRONOUS_DEPTH guard is
 * reached only after a combinatorial number of node hops. The editor rejects it
 * outright rather than relying on that runtime safety net.
 *
 * Returns the cycle itself, not just a boolean: the error this feeds is
 * unactionable without it, since in a graph of any size there is no way to see
 * which wires form the loop.
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @returns {{nodeIds: string[], edgeIds: string[]}|null} The cycle in traversal
 *   order, and the edge ids joining them (one per node - the last closes the
 *   loop back to the first). Null when there is no such cycle.
 */
export function findInstantaneousCycle(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const instantaneousIds = new Set(nodes.filter((n) => INSTANTANEOUS_NODE_TYPES.has(n.type) && n.type !== 'end').map((n) => n.id));

  const adjacency = new Map();
  for (const id of instantaneousIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (instantaneousIds.has(edge.from) && instantaneousIds.has(edge.to)) {
      adjacency.get(edge.from).push(edge);
    }
  }

  const visited = new Set();
  const inStack = new Set();
  // The DFS path, kept explicitly so a back-edge can be turned into the actual
  // cycle (stack.slice from where it closes) rather than just "a cycle exists".
  // pathEdges[i] is the edge taken INTO pathNodes[i + 1], so it always trails
  // pathNodes by exactly one entry.
  const pathNodes = [];
  const pathEdges = [];

  const visit = (id) => {
    visited.add(id);
    inStack.add(id);
    pathNodes.push(id);
    for (const edge of adjacency.get(id) || []) {
      if (inStack.has(edge.to)) {
        const from = pathNodes.indexOf(edge.to);
        return { nodeIds: pathNodes.slice(from), edgeIds: [...pathEdges.slice(from).map((e) => e.id), edge.id] };
      }
      if (visited.has(edge.to)) continue;
      pathEdges.push(edge);
      const found = visit(edge.to);
      if (found) return found;
      pathEdges.pop();
    }
    pathNodes.pop();
    inStack.delete(id);
    return null;
  };

  // Seeded in node order rather than Set order so the reported cycle is stable
  // across renders - the message names the path, and one that reshuffled
  // between two identical validations would read as a different problem.
  for (const node of nodes) {
    if (!instantaneousIds.has(node.id) || visited.has(node.id)) continue;
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/**
 * Whether the graph contains an all-instantaneous cycle. Thin wrapper over
 * findInstantaneousCycle() for callers that only need the yes/no.
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @returns {boolean}
 */
export function hasInstantaneousCycle(graph) {
  return findInstantaneousCycle(graph) !== null;
}

/**
 * Find every node not reachable from the graph's Start node via a
 * breadth-first walk of all edges (direction only, ignoring node semantics).
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @returns {string[]} Node ids unreachable from Start.
 */
export function findUnreachableNodes(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const start = nodes.find((n) => n.type === 'start');
  if (!start) return nodes.map((n) => n.id);

  const visited = new Set([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const edge of edges) {
      if (edge.from === id && !visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
}

/**
 * Whether following DIRECT Playlist-node references out of `startId` can reach
 * `targetId`. Only direct references are traceable statically - an indirect
 * one (scene/default) depends on live scene/mood state, so a cycle through
 * one is caught at runtime by the engine's shared in-flight registry instead
 * (docs/playlist-node-plan.md D6), not here.
 * @param {string} startId
 * @param {string} targetId
 * @param {Map<string, {graph?: import('./custom-playback-schema.mjs').CustomGraph|null}>} playlistsById
 * @returns {boolean}
 */
export function reachesPlaylist(startId, targetId, playlistsById) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const graph = playlistsById.get(id)?.graph;
    for (const node of graph?.nodes || []) {
      if (node.type !== 'playlist' || node.playlistRef?.source !== 'direct') continue;
      const nextId = node.playlistRef.playlistId;
      if (!nextId) continue;
      if (nextId === targetId) return true;
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }
  return false;
}

/**
 * Validate a CustomGraph against the schema's structural rules (custom-playlist-plan.md
 * Phase 4.3; Playlist-node rules added per docs/playlist-node-plan.md Phase 5). Pure
 * function - takes plain data, has no dependency on Drawflow or a live Foundry
 * environment, so it is fully unit-testable in isolation.
 * @param {import('./custom-playback-schema.mjs').CustomGraph} graph
 * @param {object} [options]
 * @param {{sounds?: {get: (id: string) => any}, id?: string}} [options.playlist] - The playlist
 *   being edited. Track nodes are checked against it for a soundId that no longer exists;
 *   Playlist nodes are checked against its own id for a direct self-reference.
 * @param {Array<{id: string, name: string, mode: number, isCustom: boolean, soundCount: number,
 *   graph: import('./custom-playback-schema.mjs').CustomGraph|null}>} [options.playlists] - Every
 *   playlist a Playlist node could target (helpers.mjs#getGraphTargetPlaylists()). When omitted,
 *   checks that need to know about OTHER playlists (missing target, cycle) are skipped.
 * @param {string[]} [options.moodIds] - Configured mood ids, for validating a 'specific' overlay
 *   reference on an 'area' section. When omitted, that check is skipped.
 * @param {string[]} [options.phaseIds] - Configured phase ids, for validating a 'specific' overlay
 *   reference on a 'combat' section. When omitted, that check is skipped.
 * @returns {{valid: boolean, errors: ValidationIssue[], warnings: ValidationIssue[], infos: ValidationIssue[]}}
 */
export function validateGraph(graph, { playlist, playlists, moodIds, phaseIds } = {}) {
  const errors = [];
  const warnings = [];
  const infos = [];

  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const exitsOf = (nodeId) => edges.filter((e) => e.from === nodeId);

  const starts = nodes.filter((n) => n.type === 'start');
  if (starts.length === 0) {
    errors.push({ nodeId: null, messageKey: 'GameOrchestra.CustomEditor.Validation.NoStartNode' });
  } else if (starts.length > 1) {
    for (const extra of starts.slice(1)) {
      errors.push({ nodeId: extra.id, messageKey: 'GameOrchestra.CustomEditor.Validation.MultipleStartNodes' });
    }
  }
  for (const start of starts) {
    if (exitsOf(start.id).length !== 1) errors.push({ nodeId: start.id, messageKey: 'GameOrchestra.CustomEditor.Validation.StartMustHaveOneExit' });
  }

  for (const node of nodes) {
    const exits = exitsOf(node.id);
    switch (node.type) {
      case 'start':
        break; // validated above
      case 'end':
        if (exits.length !== 0) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.EndMustHaveNoExits' });
        break;
      case 'track':
        if (node.loop?.mode === 'forever') {
          if (exits.length !== 0) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.InfiniteTrackMustHaveNoExit' });
        } else if (node.loop?.mode === 'until') {
          // Inverts the 'forever' rule above: an until-loop DOES advance
          // eventually, so - like 'count' - it needs exactly one exit.
          if (exits.length !== 1) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.UntilTrackMustHaveOneExit' });
          if (!node.loop?.condition?.kind) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.UntilMissingCondition' });
          // Having a KIND is not enough: "Mood Is ..." with no mood picked can
          // never match, so the loop would run to maxLoops (or forever) instead
          // of escaping. Same defect as the Condition exit below, and the same
          // "(not set)" chip on the canvas.
          else if (conditionMissingValue(node.loop.condition)) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.UntilMissingValue' });
          }
          if (!(node.loop?.minLoops >= 1)) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.LoopMinLoopsMin' });
          if (node.loop?.maxLoops != null && !(node.loop.maxLoops >= (node.loop?.minLoops ?? 1))) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.LoopMaxLoopsBelowMin' });
          }
          if (exits.some((e) => e.to === node.id)) {
            warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackSelfLoopWarning' });
          }
        } else {
          if (exits.length !== 1) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackMustHaveOneExit' });
          if (!(node.loop?.count >= 1)) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackLoopCountMin' });
          if (exits.some((e) => e.to === node.id)) {
            warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackSelfLoopWarning' });
          }
        }
        if (!node.soundId) {
          errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackNoSound' });
        } else if (playlist && !playlist.sounds?.get?.(node.soundId)) {
          errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.TrackMissingSound' });
        }
        break;
      case 'delay':
        if (exits.length !== 1) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.DelayMustHaveOneExit' });
        if (!(node.delay?.min >= 0) || !(node.delay?.max >= (node.delay?.min ?? 0))) {
          errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.DelayInvalidRange' });
        }
        if (exits.some((e) => e.to === node.id) && (node.delay?.max ?? 0) === 0 && (node.delay?.min ?? 0) === 0) {
          warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.DelaySelfLoopZeroWarning' });
        }
        break;
      case 'fork':
        if (exits.length < 2) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.ForkMinExits' });
        break;
      case 'random':
        if (exits.length === 0) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.RandomMinExits' });
        for (const edge of exits) {
          if (!(edge.weight >= 0)) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.RandomExitMissingWeight' });
        }
        if (exits.length > 0 && exits.every((edge) => (edge.weight ?? 1) === 0)) {
          warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.RandomAllZeroWeight' });
        }
        break;
      case 'condition': {
        if (exits.length === 0) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionMinExits' });
        // First index each distinct condition was seen at, so a repeat can name
        // the exit that shadows it rather than just saying "duplicate".
        const seenAt = new Map();
        exits.forEach((edge, i) => {
          if (!edge.condition?.kind) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionExitMissingCondition' });
          // An error, not a warning: a mood/phase condition with no id can
          // never match (_evaluateCondition compares the active overlay id
          // against undefined), so the exit is unreachable and the branch is
          // dead. Reported live from a canvas showing "(not set)" chips on a
          // graph that saved cleanly.
          else if (conditionMissingValue(edge.condition)) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionExitMissingValue' });
          } else if (edge.condition.kind !== 'default') {
            // _enterCondition returns on the FIRST matching edge, so a repeat of
            // an earlier condition is unreachable however the game state falls -
            // the same shape of bug as a 'default' that isn't last, and an error
            // for the same reason.
            //
            // 'default' is excluded deliberately, not overlooked: it matches
            // unconditionally, so two of them are already caught by
            // ConditionDefaultMustBeLast below (with two or more, at least one
            // cannot be last). Flagging them here too would put two errors on
            // one node for a single mistake. Exits that are themselves
            // incomplete are skipped for the same reason - they have already
            // been reported by one of the two branches above.
            const signature = conditionSignature(edge.condition);
            if (seenAt.has(signature)) {
              errors.push({
                nodeId: node.id,
                messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionExitDuplicate',
                messageData: { index: i, first: seenAt.get(signature) }
              });
            } else {
              seenAt.set(signature, i);
            }
          }
          if (edge.condition?.kind === 'default' && i !== exits.length - 1) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.ConditionDefaultMustBeLast' });
          }
        });
        break;
      }
      case 'playlist': {
        if (node.loop?.mode === 'forever') {
          if (exits.length !== 0) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.InfinitePlaylistMustHaveNoExit' });
        } else {
          if (exits.length !== 1) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistMustHaveOneExit' });
          if (!(node.loop?.count >= 1)) errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistLoopCountMin' });
        }

        const ref = node.playlistRef;
        if (!ref || !PLAYLIST_REF_SOURCES.includes(ref.source)) {
          errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistNoReference' });
          break;
        }

        if (ref.source === 'direct') {
          if (!ref.playlistId) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistNoTarget' });
          } else if (ref.playlistId === playlist?.id) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistSelfReference' });
          } else if (playlists) {
            const target = playlists.find((p) => p.id === ref.playlistId);
            if (!target) {
              errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistMissingTarget' });
            } else {
              if (!target.graph && target.mode === UNSEQUENCED_MODE) {
                warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistSoundboardTarget' });
              }
              if (!target.graph && !(target.soundCount > 0)) {
                warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistEmptyTarget' });
              }
            }
          }
        } else {
          const validSection = PLAYLIST_REF_SECTIONS.includes(ref.section);
          const validOverlayMode = PLAYLIST_REF_OVERLAY_MODES.includes(ref.overlayMode);
          const missingSpecificOverlay = ref.overlayMode === 'specific' && !ref.overlayId;
          if (!validSection || !validOverlayMode || missingSpecificOverlay) {
            errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistInvalidSection' });
          } else if (ref.overlayMode === 'specific') {
            // Which id list applies depends on the referenced section's own
            // axis - area overlays are moods, combat overlays are phases
            // (config.mjs#sectionAxis).
            const overlayIds = CONST.sectionAxis[ref.section] === 'phase' ? phaseIds : moodIds;
            if (overlayIds && !overlayIds.includes(ref.overlayId)) {
              warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistUnknownOverlay' });
            }
          }
        }
        break;
      }
      default:
        errors.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.UnknownNodeType', messageData: { type: node.type } });
    }
  }

  // A direct Playlist-node reference whose target can (transitively, via
  // other direct references) lead back to the playlist being edited - not an
  // error, since the engine's shared in-flight registry refuses it safely at
  // runtime (docs/playlist-node-plan.md D6/D7), but worth flagging: the node
  // it's on will never actually run a pass.
  if (playlist?.id && playlists) {
    const playlistsById = new Map(playlists.map((p) => [p.id, p]));
    for (const node of nodes) {
      if (node.type !== 'playlist' || node.playlistRef?.source !== 'direct') continue;
      const targetId = node.playlistRef.playlistId;
      if (!targetId || targetId === playlist.id) continue; // self-reference is PlaylistSelfReference, not this
      if (reachesPlaylist(targetId, playlist.id, playlistsById)) {
        warnings.push({ nodeId: node.id, messageKey: 'GameOrchestra.CustomEditor.Validation.PlaylistReferenceCycle' });
      }
    }
  }

  if (starts.length === 1) {
    for (const orphanId of findUnreachableNodes(graph)) {
      warnings.push({ nodeId: orphanId, messageKey: 'GameOrchestra.CustomEditor.Validation.NodeUnreachable' });
    }
  }

  const cycle = findInstantaneousCycle(graph);
  if (cycle) {
    // Anchored on a node (rather than the graph-wide nodeId: null it used to
    // be) so the panel entry is clickable and every node on the loop gets a
    // badge. The {path} names the loop in full - in a large graph the error was
    // otherwise true but unactionable, since nothing pointed at the wires.
    const labelFor = (id) => {
      const node = nodes.find((n) => n.id === id);
      return node ? nodeDisplayLabel(node) : id;
    };
    errors.push({
      nodeId: cycle.nodeIds[0],
      nodeIds: cycle.nodeIds,
      edgeIds: cycle.edgeIds,
      messageKey: 'GameOrchestra.CustomEditor.Validation.InstantaneousCycle',
      messageData: { path: [...cycle.nodeIds, cycle.nodeIds[0]].map(labelFor).join(' → ') }
    });
  } else if (errors.length === 0 && nodes.some((n) => n.type === 'end')) {
    infos.push({ nodeId: null, messageKey: 'GameOrchestra.CustomEditor.Validation.GraphEndsInfo' });
  }

  // Attached once at the end rather than at all 20-odd push sites: every issue
  // that names a node needs to say WHICH node, or the reader is left hunting
  // the canvas for it.
  const labelOf = (issue) => {
    // A multi-node issue already names every node it involves inside its own
    // message (the cycle path), so prefixing it with just the first one would
    // read as "Fork: ... Fork -> Fork 1 -> Fork" - the same label twice, and
    // misleadingly singling out one node of several.
    if (issue.nodeIds) return null;
    const node = issue.nodeId ? nodes.find((n) => n.id === issue.nodeId) : null;
    return node ? nodeDisplayLabel(node) : null;
  };
  const withLabels = (issues) => issues.map((issue) => ({ ...issue, nodeLabel: labelOf(issue) }));

  return { valid: errors.length === 0, errors: withLabels(errors), warnings: withLabels(warnings), infos: withLabels(infos) };
}
