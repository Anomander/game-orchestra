/**
 * Shared ApplicationV2 plumbing duplicated (byte-for-byte, in places) across
 * GameOrchestraConfig (app.mjs) and PlaylistTreeApp (playlist-tree.mjs): collapsed-
 * section bookkeeping, the delegated `change`/`dragleave` listeners (bound
 * once, on the persistent root element), and the DragDrop rebind-per-render
 * lifecycle (see the note on the drag-drop block below - unlike `change`/
 * `dragleave`, this one deliberately does NOT bind once).
 *
 * CustomPlaylistEditor (custom-playlist-editor.mjs) has an otherwise
 * completely different _onRender/_onClose (Drawflow canvas, keydown,
 * mousedown, activity-hook listeners) that doesn't fit this shared lifecycle,
 * but reuses dispatchChangeAction() below for its own `change` dispatch so
 * the same lookup-by-data-attribute logic exists in exactly one place.
 */

/**
 * Resolve and invoke the static handler registered for a delegated `change`
 * event's `data-change-action`, mirrored across all three apps. Matches on
 * `dataset.changeAction` alone (not element tag): CustomPlaylistEditor's inspector
 * puts this attribute on checkboxes and text/number inputs, playlist-tree.hbs puts
 * it on the overlay layer checkbox and duck slider, and music-config.hbs on the
 * token's exclusive checkbox and duck slider - a `<select>`-only tag check would
 * silently ignore every one of them.
 * @param {object} instance - The app instance dispatching (becomes `this` inside the handler).
 * @param {Event} event - The `change` event.
 */
export function dispatchChangeAction(instance, event) {
  const target = event.target;
  if (!target?.dataset?.changeAction) return;
  const methodName = instance.constructor._CHANGE_ACTIONS?.[target.dataset.changeAction];
  const handler = methodName && instance.constructor[methodName];
  if (typeof handler === 'function') handler.call(instance, event, target);
}

/**
 * Mixes in the collapsed-section helper, the `_onChangeInput` delegate, and
 * the `change`/`dragleave`/drag-drop listener lifecycle shared by
 * GameOrchestraConfig and PlaylistTreeApp. A consuming class must still provide:
 * - `_setupDragDrop()` - binds this window's DragDrop config(s); differs per
 *   class in how many entries it has and what each one's callbacks do.
 * - `_onDragLeaveExternal(event)` - differs per class only in which CSS
 *   selector identifies a drop-hover target box.
 * @param {typeof ApplicationV2} Base
 */
export function GameOrchestraAppMixin(Base) {
  return class extends Base {
    /**
     * Keys of the `<details data-disclosure-key>` blocks the user has opened.
     *
     * A native `<details>` holds its open state in the DOM and nowhere else, and
     * HandlebarsApplicationMixin replaces a part's DOM **wholesale** on every render (the same
     * property HR-D is about). So a control *inside* a disclosure closes the disclosure the
     * instant it writes, because writing re-renders - confirmed live with the tree's
     * `Play as overlay` checkbox, which slammed its own Advanced block shut on every click.
     *
     * Mirroring the open state here and rendering `open` from it is what makes the block survive.
     * A class field rather than a constructor line so neither consuming class has to remember it.
     * @type {Set<string>}
     */
    openDisclosures = new Set();

    /**
     * Helper to evaluate if a section or card is collapsed
     * @param {string} key - Section or card identifier key
     * @param {boolean} hasOverride - Whether the item has active overrides configured
     * @returns {boolean} True if collapsed
     */
    isSectionCollapsed(key, hasOverride) {
      if (this.expandedSections.has(key)) return false;
      if (this.collapsedSections.has(key)) return true;
      return !hasOverride;
    }

    /**
     * Internal delegated change event listener for select/input elements
     * carrying `data-change-action`.
     * @param {Event} event - The change event
     * @private
     */
    _onChangeInput(event) {
      dispatchChangeAction(this, event);
    }

    /**
     * Record a `<details>` opening or closing, so the next render can restore it.
     *
     * Deliberately does NOT re-render: the DOM already shows what the user just did, and
     * re-rendering here would replace the very element they clicked mid-interaction.
     * @param {Event} event - The `toggle` event; its target is the `<details>`.
     * @private
     */
    _onDisclosureToggle(event) {
      const key = event.target?.dataset?.disclosureKey;
      if (!key) return;
      if (event.target.open) this.openDisclosures.add(key);
      else this.openDisclosures.delete(key);
    }

    /** @override */
    _onRender(context, options) {
      super._onRender(context, options);
      if (this.element && !this._changeListenerBound) {
        this._onChangeInputHandler = (event) => this._onChangeInput(event);
        this.element.addEventListener('change', this._onChangeInputHandler);
        this._changeListenerBound = true;
      }
      if (this.element && !this._dragLeaveListenerBound) {
        this._onDragLeaveHandler = (event) => this._onDragLeaveExternal(event);
        this.element.addEventListener('dragleave', this._onDragLeaveHandler);
        this._dragLeaveListenerBound = true;
      }
      // CAPTURE phase, and that is not a style choice: `toggle` is one of the few DOM events
      // that does NOT bubble, so a delegated listener on the root element never sees it during
      // the bubble phase. Capturing listeners still fire on ancestors for non-bubbling events.
      // Bound once like the two above - it is delegated, so it survives the part being replaced.
      if (this.element && !this._disclosureListenerBound) {
        this._onDisclosureToggleHandler = (event) => this._onDisclosureToggle(event);
        this.element.addEventListener('toggle', this._onDisclosureToggleHandler, true);
        this._disclosureListenerBound = true;
      }
      // Rebind on every render, deliberately not guarded like the two blocks
      // above: `change`/`dragleave` are delegated listeners on the persistent
      // root element, so binding once is correct. Foundry's DragDrop#bind(),
      // by contrast, is not delegated - it does `html.querySelectorAll(dropSelector)`
      // at bind time and attaches listeners straight to whatever matches right
      // then. HandlebarsApplicationMixin's render replaces a part's DOM wholesale
      // (not a diff/morph), so every render after the first produces brand-new
      // `.context-box`/section-box elements that were never bound - guarding this
      // the same way as the listeners above silently orphans drag-and-drop after
      // the window's first re-render (which happens on nearly any interaction,
      // e.g. selecting a scene). `_setupDragDrop()` builds a fresh config object
      // per call rather than mutating DEFAULT_OPTIONS.dragDrop in place, so
      // calling it repeatedly never leaks callbacks between instances - the old
      // elements' listeners simply go away with them when the part is replaced.
      if (this.element) {
        this._setupDragDrop();
      }
    }

    /** @override */
    _onClose(options) {
      super._onClose(options);
      if (this.element && this._onChangeInputHandler) {
        this.element.removeEventListener('change', this._onChangeInputHandler);
      }
      this._changeListenerBound = false;
      if (this.element && this._onDragLeaveHandler) {
        this.element.removeEventListener('dragleave', this._onDragLeaveHandler);
      }
      this._dragLeaveListenerBound = false;
      if (this.element && this._onDisclosureToggleHandler) {
        // The `true` has to match the addEventListener above: capture is part of the listener's
        // identity, so removing without it silently leaves the listener attached.
        this.element.removeEventListener('toggle', this._onDisclosureToggleHandler, true);
      }
      this._disclosureListenerBound = false;
    }
  };
}
