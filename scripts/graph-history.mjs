/**
 * Undo/redo history for the graph editor's working graph.
 *
 * Pure and Foundry-free (no `game`, no DOM, no Drawflow) so the whole
 * past/present/future state machine is unit-testable on its own - the editor
 * side is reduced to "capture a snapshot" and "restore a snapshot".
 *
 * SNAPSHOTS, NOT COMMANDS. Each entry is a full copy of the canvas state
 * rather than an inverse operation, because Drawflow owns the authoritative
 * state and does things to it that an inverse op would have to reimplement by
 * hand - renumbering output ports contiguously on removal (H5), dropping every
 * connection touching a removed node, recomputing its `nodeId` counter on
 * import. `editor.import()` already restores all of that exactly, and a graph
 * is tens of nodes, so a snapshot is cheap. See custom-playlist-editor.mjs
 * #_captureSnapshot / #_restoreSnapshot for the two ends.
 *
 * The history is per-window and lives only as long as the editor instance -
 * nothing is persisted, and closing the window discards it.
 */

/**
 * The part of a snapshot that decides whether two states are the *same* state.
 *
 * Deliberately excludes the selection: selecting a node is not an edit and
 * must never cost an undo step (a snapshot still carries its selection, so
 * that stepping back can restore what was selected at the time - that is a
 * courtesy, not the identity of the step).
 *
 * It DOES include `levels` - the Tracks pane's mixer half (per-track volumes
 * and fades, and the playlist's mix flag). Those are edited in the same window,
 * in the same pane as the graph's own track list, so Ctrl+Z has to cover them
 * or it covers "some of what you just did". They are the one part of a snapshot
 * that is already persisted when it is captured, which makes an undo of one a
 * document write rather than a canvas rebuild - see
 * custom-playlist-editor.mjs#_restoreLevels.
 *
 * This is what makes it safe to record from a single choke point
 * (`_syncFromDrawflow`) that is also called by read-only callers such as Save
 * and the preset handler's destructive-change check: a resync that changed
 * nothing produces an identical key and no step.
 * @param {object|null} snapshot
 * @returns {string}
 */
export function snapshotKey(snapshot) {
  return JSON.stringify({ d: snapshot?.drawflow ?? null, c: snapshot?.crossfadeMs ?? null, l: snapshot?.levels ?? null });
}

/**
 * A past/present/future stack of editor snapshots.
 *
 * Unbounded on purpose: a snapshot is a small JSON structure, an editing
 * session is one window's lifetime, and a cap is only ever noticed at the
 * moment it silently throws away the step someone wanted back.
 */
export class GraphHistory {
  constructor() {
    /** @type {Array<object>} */
    this._past = [];
    /** @type {Array<object>} */
    this._future = [];
    /** @type {object|null} */
    this._present = null;
    /** @type {string|null} Cached key of `_present`, so push() doesn't re-serialize it every time. */
    this._presentKey = null;
  }

  /** @returns {boolean} */
  get canUndo() {
    return this._past.length > 0;
  }

  /** @returns {boolean} */
  get canRedo() {
    return this._future.length > 0;
  }

  /**
   * The state the editor is currently showing, as far as this history knows.
   * @returns {object|null}
   */
  get present() {
    return this._present;
  }

  /**
   * Stack sizes, for tests and debug logging.
   * @returns {{past: number, future: number}}
   */
  get depth() {
    return { past: this._past.length, future: this._future.length };
  }

  /**
   * Seed the history with the state the window opened in, discarding
   * everything recorded so far. The seed is a floor, not a step: it is what
   * the first undo returns to, and there is nothing to undo until something
   * is pushed on top of it.
   * @param {object} snapshot
   */
  reset(snapshot) {
    this._past = [];
    this._future = [];
    this._present = snapshot;
    this._presentKey = snapshotKey(snapshot);
  }

  /**
   * Refresh the present state's selection in place, without creating a step.
   *
   * A selection change is not an edit, so nothing records one - which would
   * otherwise leave the present snapshot carrying whatever was selected when
   * that state was first *reached*, possibly several clicks ago. Since the
   * present snapshot is what an undo steps back INTO, calling this just before
   * a push is what makes "undo" restore the selection you had immediately
   * before the edit, rather than deselecting for no reason.
   *
   * Only the present is touched: states already on the past stack were left
   * with their own selections and keep them.
   * @param {{selectedNodeId: string|null, multiSelectedNodeIds: Array<string>}} selection
   */
  updatePresentSelection(selection) {
    if (!this._present || !selection) return;
    this._present.selectedNodeId = selection.selectedNodeId ?? null;
    this._present.multiSelectedNodeIds = [...(selection.multiSelectedNodeIds || [])];
    // No _presentKey update: the selection is deliberately outside the key
    // (see snapshotKey), so it cannot change the state's identity.
  }

  /**
   * Record a new current state.
   *
   * A snapshot equal to the present one (by snapshotKey) is dropped rather
   * than pushed - see that function for why the recording site is allowed to
   * be indiscriminate.
   *
   * Pushing clears the redo stack, the standard linear-history rule: once you
   * undo and then edit, the branch you undid is gone.
   * @param {object} snapshot
   * @returns {boolean} Whether an undo step was actually created.
   */
  push(snapshot) {
    const key = snapshotKey(snapshot);
    if (this._present === null) {
      // No seed - treat the first push as one. Nothing to undo *to* yet.
      this._present = snapshot;
      this._presentKey = key;
      return false;
    }
    if (key === this._presentKey) return false;
    this._past.push(this._present);
    this._present = snapshot;
    this._presentKey = key;
    this._future.length = 0;
    return true;
  }

  /**
   * Step back one state. The state being left is pushed onto the redo stack.
   * @returns {object|null} The snapshot to restore, or null if there is nothing to undo.
   */
  undo() {
    if (!this.canUndo) return null;
    this._future.push(this._present);
    this._present = this._past.pop();
    this._presentKey = snapshotKey(this._present);
    return this._present;
  }

  /**
   * Step forward one state, undoing an undo.
   * @returns {object|null} The snapshot to restore, or null if there is nothing to redo.
   */
  redo() {
    if (!this.canRedo) return null;
    this._past.push(this._present);
    this._present = this._future.pop();
    this._presentKey = snapshotKey(this._present);
    return this._present;
  }
}
