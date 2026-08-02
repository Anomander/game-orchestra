/**
 * Rect-select (marquee) and group-drag for CustomPlaylistEditor's canvas,
 * extracted from custom-playlist-editor.mjs to keep that file's already-large
 * DOM/Drawflow surface from growing further. Pure method definitions added to
 * the class's prototype chain via mixin - no different in behavior from
 * defining them directly in the class body, since every method here still
 * runs with `this` bound to the live CustomPlaylistEditor instance and reads/
 * writes the same instance fields (this._drawflow, this.graph,
 * this.selectedNodeId, etc.) the rest of the class does.
 *
 * Field ownership (initialized in CustomPlaylistEditor's own constructor,
 * not here - see that class's constructor comment):
 * - `_multiSelectedNodeIds` (Set<string>) - node ids currently marquee-selected,
 *   distinct from `selectedNodeId`/Drawflow's own single-node selection (see
 *   `_onCanvasMouseDown`'s doc for why the two never mix).
 * - `_rectSelectStart`/`_rectSelectMoved`/`_rectSelectEl` - in-progress marquee drag.
 * - `_groupDrag` - in-progress group drag of the current marquee selection.
 *
 * Depends on methods defined elsewhere on the same class: `_nodeElement()`
 * (editor-highlight-mixin.mjs), `_renderInspector()`, `_syncFromDrawflow()`,
 * `_restyleNodeWires()` (custom-playlist-editor.mjs).
 * @param {typeof ApplicationV2} Base
 */
export function EditorSelectionMixin(Base) {
  return class extends Base {
    /**
     * True for a mousedown target that isn't a node, port, or connection - i.e.
     * empty canvas. Mirrors the classification Drawflow's own click() (bound as
     * its mousedown handler) does internally to decide "background click".
     * @param {EventTarget} target
     * @returns {boolean}
     * @private
     */
    _isBackgroundTarget(target) {
      if (!target || typeof target.closest !== 'function') return false;
      if (target.closest('.drawflow-node')) return false;
      if (target.closest('.main-path')) return false;
      if (target.classList?.contains('input') || target.classList?.contains('output')) return false;
      return true;
    }

    /**
     * Left-button-drag on empty canvas draws a rect-select instead of panning;
     * right-button-drag is left alone so Drawflow's own native pan still works
     * unmodified. Drawflow binds its own mousedown handler directly on the
     * canvas container, in the bubble phase (confirmed against the vendored
     * source) - a capture-phase listener bound higher up (this.element, not the
     * container itself) is the only way to reliably run and stopPropagate()
     * BEFORE it, regardless of whether the click's actual target is the
     * container or one of its descendants.
     * @param {MouseEvent} event
     * @private
     */
    _onCanvasMouseDown(event) {
      if (event.button !== 0) return; // only left-button starts a rect-select
      if (!this._drawflow?.container?.contains?.(event.target)) return; // outside the canvas (e.g. a palette button)
      // A press on a node that's part of the marquee selection drags the whole
      // selection, and must be caught here for the same reason the background
      // case is: Drawflow's own mousedown handler would otherwise fire
      // 'nodeSelected' (which collapses the selection down to that one node) and
      // then drag only it.
      const groupTarget = this._groupDragTarget(event.target);
      if (groupTarget) return this._startGroupDrag(event, groupTarget);
      if (!this._isBackgroundTarget(event.target)) return; // node/port/connection - Drawflow's own business
      event.stopPropagation();
      this._rectSelectStart = { x: event.clientX, y: event.clientY };
      this._rectSelectMoved = false;
      this._onRectSelectMoveHandler = (e) => this._onRectSelectMove(e);
      this._onRectSelectUpHandler = (e) => this._onRectSelectUp(e);
      document.addEventListener('mousemove', this._onRectSelectMoveHandler);
      document.addEventListener('mouseup', this._onRectSelectUpHandler);
    }

    /**
     * The node element a group drag should start from: one that belongs to the
     * current marquee selection. Returns null for anything else - a press on an
     * unselected node, on a port (which must still start a connection drag), on
     * a control sitting on the node, or on empty canvas - leaving those paths
     * untouched.
     * @param {EventTarget} target
     * @returns {Element|null}
     * @private
     */
    _groupDragTarget(target) {
      if (this._multiSelectedNodeIds.size === 0) return null;
      if (!target || typeof target.closest !== 'function') return null;
      if (target.classList?.contains('input') || target.classList?.contains('output')) return null;
      // Controls parented to the node element itself - the "+" exit adder, the
      // issue badge. They are inside .drawflow-node, so without this a press on
      // one while a marquee selection is live starts dragging the whole
      // selection instead of doing what the control says. This runs BEFORE the
      // _isBackgroundTarget check in _onCanvasMouseDown, so it is the only
      // place that can catch them.
      if (target.closest('.game-orchestra-node-add-exit') || target.closest('.game-orchestra-node-issue')) return null;
      const nodeEl = target.closest('.drawflow-node');
      const nodeId = nodeEl?.id?.startsWith?.('node-') ? nodeEl.id.slice(5) : null;
      return nodeId && this._multiSelectedNodeIds.has(nodeId) ? nodeEl : null;
    }

    /**
     * Begin dragging every marquee-selected node as one unit.
     * @param {MouseEvent} event
     * @param {Element} nodeEl - The node the press landed on.
     * @private
     */
    _startGroupDrag(event, nodeEl) {
      event.stopPropagation(); // keep Drawflow from collapsing the selection and dragging one node
      this._groupDrag = {
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        nodeId: nodeEl.id.slice(5),
        nodeIds: [...this._multiSelectedNodeIds]
      };
      this._onGroupDragMoveHandler = (e) => this._onGroupDragMove(e);
      this._onGroupDragUpHandler = (e) => this._onGroupDragUp(e);
      document.addEventListener('mousemove', this._onGroupDragMoveHandler);
      document.addEventListener('mouseup', this._onGroupDragUpHandler);
    }

    /**
     * Move every node in the drag by the pointer's delta since the last frame.
     *
     * The math (delta / zoom, applied to each element's current offsetLeft/Top)
     * and the write-through to Drawflow's own node registry both mirror what
     * Drawflow's position() does for a single-node drag - deliberately, so a
     * group drag lands the nodes in exactly the state a series of individual
     * drags would have. The registry write is what makes the new positions
     * survive: _syncFromDrawflow() reads them straight back out via export(), so
     * without it a drag would visibly move the nodes and then be discarded.
     * @param {MouseEvent} event
     * @private
     */
    _onGroupDragMove(event) {
      const drag = this._groupDrag;
      if (!drag) return;
      if (!drag.moved && Math.abs(event.clientX - drag.lastX) < 4 && Math.abs(event.clientY - drag.lastY) < 4) return;
      drag.moved = true;
      event.preventDefault(); // suppress text selection while dragging

      const zoom = this._drawflow?.zoom || 1;
      const dx = (event.clientX - drag.lastX) / zoom;
      const dy = (event.clientY - drag.lastY) / zoom;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;

      for (const nodeId of drag.nodeIds) {
        const el = this._nodeElement(nodeId);
        if (!el) continue;
        const left = (el.offsetLeft || 0) + dx;
        const top = (el.offsetTop || 0) + dy;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        const record = this._nodeRecord(nodeId);
        if (record) {
          record.pos_x = left;
          record.pos_y = top;
        }
        this._drawflow.updateConnectionNodes?.(`node-${nodeId}`);
        // That call restored Drawflow's own curve for every wire touching this
        // node, so the path overrides have to be reapplied per frame - a group
        // drag never goes through Drawflow's own drag handler, so nothing else
        // does it for us until the mouse is released.
        this._restyleNodeWires(nodeId);
      }
    }

    /**
     * @param {MouseEvent} event
     * @private
     */
    _onGroupDragUp(event) {
      const drag = this._groupDrag;
      this._teardownGroupDrag();
      if (!drag) return;

      if (!drag.moved) {
        // A plain click on a selected node. Drawflow never saw the mousedown
        // (it was stopPropagation'd above), so stand in for its own behavior:
        // a single click selects just that node and drops the marquee.
        this._selectSingleNode(drag.nodeId);
        return;
      }
      // Drawflow's 'nodeMoved' never fired for these, so do its follow-up work
      // here: pull the new positions into the working graph and reapply the
      // wire routing and any self-loop arcs that the connection redraw above
      // reset to Drawflow's default curve.
      this._syncFromDrawflow(this._drawflow);
      for (const nodeId of drag.nodeIds) this._restyleNodeWires(nodeId);
    }

    /**
     * @private
     */
    _teardownGroupDrag() {
      if (this._onGroupDragMoveHandler) document.removeEventListener('mousemove', this._onGroupDragMoveHandler);
      if (this._onGroupDragUpHandler) document.removeEventListener('mouseup', this._onGroupDragUpHandler);
      this._onGroupDragMoveHandler = null;
      this._onGroupDragUpHandler = null;
      this._groupDrag = null;
    }

    /**
     * Select exactly one node, as clicking it normally would - used on the paths
     * where this class intercepted the mousedown before Drawflow could do it
     * itself.
     * @param {string} nodeId
     * @private
     */
    _selectSingleNode(nodeId) {
      this._clearMultiSelection();
      const el = this._nodeElement(nodeId);
      if (this._drawflow) {
        this._drawflow.node_selected?.classList?.remove('selected');
        this._drawflow.node_selected = el || null;
      }
      el?.classList?.add('selected');
      this.selectedNodeId = nodeId;
      // Optional chaining: this mixin has no accordion-panel concept of its own -
      // only CustomPlaylistEditor (custom-playlist-editor.mjs) defines
      // _setPaneCollapsed(), and this call is a no-op for anything that doesn't.
      this._setPaneCollapsed?.('properties', false);
      this._renderInspector();
    }

    /**
     * Select a freshly-created group of nodes, as if they had just been
     * rect-selected. Used by paste, so the new nodes can be dragged, deleted, or
     * re-pasted immediately without hunting for them on the canvas.
     *
     * A single node goes through _selectSingleNode() rather than becoming a
     * one-node marquee: the two selection concepts are deliberately mutually
     * exclusive (see _onCanvasMouseDown), and only the single one populates the
     * inspector - a paste of one node should behave exactly like clicking it.
     * @param {string[]} nodeIds
     * @private
     */
    _selectNodes(nodeIds) {
      if (nodeIds.length === 0) return;
      if (nodeIds.length === 1) return this._selectSingleNode(nodeIds[0]);
      // Renders the inspector back to its empty state - a marquee selection has
      // no single node to inspect.
      this._clearSingleSelection();
      this._clearMultiSelection();
      for (const nodeId of nodeIds) {
        this._multiSelectedNodeIds.add(nodeId);
        this._nodeElement(nodeId)?.classList?.add('game-orchestra-multi-selected');
      }
    }

    /**
     * A node's live entry in Drawflow's internal registry - the object its own
     * drag code writes pos_x/pos_y to, and the one export() reads back. Unlike
     * getNodeFromId() (which deep-clones) this is the real record, so it can be
     * mutated in place.
     * @param {string} nodeId
     * @returns {object|null}
     * @private
     */
    _nodeRecord(nodeId) {
      const editor = this._drawflow;
      return editor?.drawflow?.drawflow?.[editor.module]?.data?.[nodeId] || null;
    }

    /**
     * @param {MouseEvent} event
     * @private
     */
    _onRectSelectMove(event) {
      if (!this._rectSelectStart) return;
      const dx = event.clientX - this._rectSelectStart.x;
      const dy = event.clientY - this._rectSelectStart.y;
      if (!this._rectSelectMoved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // below the click-vs-drag threshold
      this._rectSelectMoved = true;
      if (!this._rectSelectEl && typeof document.createElement === 'function') {
        this._rectSelectEl = document.createElement('div');
        this._rectSelectEl.className = 'game-orchestra-rect-select';
        document.body.appendChild(this._rectSelectEl);
      }
      if (this._rectSelectEl) {
        Object.assign(this._rectSelectEl.style, {
          left: `${Math.min(event.clientX, this._rectSelectStart.x)}px`,
          top: `${Math.min(event.clientY, this._rectSelectStart.y)}px`,
          width: `${Math.abs(dx)}px`,
          height: `${Math.abs(dy)}px`
        });
      }
    }

    /**
     * @param {MouseEvent} event
     * @private
     */
    _onRectSelectUp(event) {
      const start = this._rectSelectStart;
      const moved = this._rectSelectMoved;
      this._teardownRectSelectDrag();
      if (!start) return;

      if (!moved) {
        // A plain click on empty canvas - Drawflow never saw the mousedown
        // (stopPropagation'd it above), so replicate its own deselect behavior.
        this._clearSingleSelection();
        this._clearMultiSelection();
        return;
      }

      const rect = {
        left: Math.min(event.clientX, start.x),
        right: Math.max(event.clientX, start.x),
        top: Math.min(event.clientY, start.y),
        bottom: Math.max(event.clientY, start.y)
      };
      this._clearSingleSelection();
      this._clearMultiSelection();
      for (const node of this.graph.nodes) {
        const el = this._drawflow?.container?.querySelector?.(`#node-${node.id}`);
        if (!el?.getBoundingClientRect) continue;
        const box = el.getBoundingClientRect();
        const intersects = box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
        if (intersects) {
          this._multiSelectedNodeIds.add(node.id);
          el.classList?.add('game-orchestra-multi-selected');
        }
      }
    }

    /**
     * @private
     */
    _teardownRectSelectDrag() {
      if (this._onRectSelectMoveHandler) document.removeEventListener('mousemove', this._onRectSelectMoveHandler);
      if (this._onRectSelectUpHandler) document.removeEventListener('mouseup', this._onRectSelectUpHandler);
      this._onRectSelectMoveHandler = null;
      this._onRectSelectUpHandler = null;
      this._rectSelectEl?.remove?.();
      this._rectSelectEl = null;
      this._rectSelectStart = null;
      this._rectSelectMoved = false;
    }

    /**
     * Deselect whatever Drawflow itself currently considers selected. Only
     * needed because a background click that reaches here had its mousedown
     * intercepted before Drawflow's own click() (which normally does this
     * itself) ever ran.
     * @private
     */
    _clearSingleSelection() {
      if (this._drawflow?.node_selected) {
        this._drawflow.node_selected.classList?.remove('selected');
        this._drawflow.node_selected = null;
      }
      this.selectedNodeId = null;
      this._renderInspector();
    }

    /**
     * @private
     */
    _clearMultiSelection() {
      for (const id of this._multiSelectedNodeIds) {
        this._drawflow?.container?.querySelector?.(`#node-${id}`)?.classList?.remove('game-orchestra-multi-selected');
      }
      this._multiSelectedNodeIds.clear();
    }
  };
}
