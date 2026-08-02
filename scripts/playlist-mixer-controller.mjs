/**
 * MixerController - everything the mixer *does*, with no opinion about what window it lives in.
 *
 * Two hosts share it: `PlaylistMixerApp` (the standalone window) and the graph editor's Mixer
 * pane. They are very different applications - one re-renders freely, the other must never call
 * `this.render()` at all (HR-A) - so the only way to keep one set of behaviour is to put the
 * behaviour here and let each host decide how its own DOM gets refreshed, via `onRefresh`.
 *
 * The controller owns: the data the pure renderer needs, every document/flag write, the delegated
 * listeners, and the selection. It does **not** own any markup - that is
 * playlist-mixer-render.mjs - and it never touches the host's render cycle directly.
 */

import { CONST } from './config.mjs';
import { getCustomGraph, getPlaylistById, log } from './helpers.mjs';
import { applyGroupGain, coerceVolume, effectiveVolume, normalizeMix, resolveCrossfadeOverride, setGroupVolume } from './playlist-mix.mjs';
import { applyMixToPlaylist, applyMixToSound, clearSolo, getPlaylistMix, getSoloIds, mixedVolume, toggleSolo } from './playlist-mix-apply.mjs';
import { buildMixerHtml } from './playlist-mixer-render.mjs';

/** Matches PlaylistSound.VOLUME_DEBOUNCE_MS - one write per settling slider, not one per pixel. */
export const WRITE_DEBOUNCE_MS = 100;

/**
 * Every live controller, so an external change (the sidebar slider, another GM, a macro) can
 * refresh every view of that playlist at once. Keyed by playlist id; several controllers can
 * share one id - the standalone window and the editor's pane, both open on the same playlist.
 * @type {Set<MixerController>}
 */
const liveControllers = new Set();

/**
 * Refresh every open mixer view of a playlist.
 * @param {object|null} playlist - Foundry Playlist document.
 */
export function refreshMixerViews(playlist) {
  if (!playlist?.id) return;
  for (const controller of liveControllers) {
    if (controller.playlistId === playlist.id) controller.refresh();
  }
}

/**
 * Slider position -> volume, and back, through Foundry's own 1.5-order curve. Routed through
 * AudioHelper rather than reimplemented so the mixer's "50%" is by construction the same sound as
 * the sidebar's "50%", including if core ever changes the exponent.
 * @param {number} value
 * @returns {number}
 */
export function inputToVolume(value) {
  const helper = foundry.audio?.AudioHelper;
  if (typeof helper?.inputToVolume === 'function') return helper.inputToVolume(value);
  return Math.pow(Number(value) || 0, 1.5);
}

/**
 * @param {number} volume
 * @returns {number} Slider position in [0, 1].
 */
export function volumeToInput(volume) {
  const helper = foundry.audio?.AudioHelper;
  if (typeof helper?.volumeToInput === 'function') return helper.volumeToInput(volume);
  return Math.pow(Number(volume) || 0, 1 / 1.5);
}

/**
 * The percentage a volume is *displayed* as. Core labels its slider with the slider position, not
 * the volume (PlaylistDirectory#_onSoundVolume passes `slider.value` to volumeToPercentage), so
 * matching that is what keeps the two UIs agreeing.
 * @param {number} volume
 * @returns {number} 0-100, rounded.
 */
export function displayPercent(volume) {
  return Math.round(volumeToInput(coerceVolume(volume, 0)) * 100);
}

export class MixerController {
  /**
   * @param {object} params
   * @param {string} params.playlistId
   * @param {() => void} params.onRefresh - Called when the view needs rebuilding. The host decides
   *   how: a full `render()` in the standalone window, a direct `innerHTML` write in the editor
   *   (which must never re-render - HR-A).
   * @param {boolean} [params.compact] - Drop the columns that cannot fit a narrow panel.
   * @param {boolean} [params.keyboard] - Bind the row-level keyboard shortcuts. **False in the
   *   graph editor**: arrows, M and S there belong to the canvas, and a mixer pane quietly
   *   stealing them would be worse than not having them. A focused slider still takes arrow keys
   *   from the browser either way.
   * @param {boolean} [params.graphTools] - Render each row as a drag source for the canvas, with
   *   its add-node button and Track-node usage count. The graph editor's Tracks pane only.
   * @param {() => object|null} [params.getGraph] - Supplies the graph the usage counts are
   *   computed against. The editor passes its **working** graph: counting against the saved flag
   *   would leave every count stale from the moment a node is added until Save.
   * @param {() => object|null} [params.getPlaylist] - Supplies the playlist document directly.
   *   The editor already holds it, and going back through `game.playlists` would make this
   *   controller fail for a playlist the world collection cannot resolve. Defaults to a lookup by
   *   id, which is what the standalone window (opened from a uuid, a macro, a context menu) needs.
   * @param {() => void} [params.onCommit] - Called once per settled change, after the value has
   *   been applied locally. The editor records an undo step from it; the standalone window has
   *   nothing to record into and passes nothing.
   */
  constructor({ playlistId, onRefresh, compact = false, keyboard = true, graphTools = false, getGraph = null, getPlaylist = null, onCommit = null }) {
    this.playlistId = playlistId;
    this._getPlaylist = getPlaylist;
    this.compact = compact;
    this.keyboard = keyboard;
    this.graphTools = graphTools;
    this._getGraph = getGraph;
    this._onCommit = onCommit;
    this._onRefresh = onRefresh;
    /** @type {Set<string>} Selected sound ids - the bulk-edit scope. Session state. */
    this.selection = new Set();
    /** Anchor row for shift-click range selection, and the keyboard cursor. */
    this._selectionAnchor = null;
    this._writeTimers = new Map();
    this._root = null;
    liveControllers.add(this);
  }

  /** @returns {object|null} The live playlist document (never cached - it can be deleted). */
  get playlist() {
    return this._getPlaylist ? this._getPlaylist() : getPlaylistById(this.playlistId);
  }

  /**
   * Ask the host to rebuild its view.
   *
   * Skipped while a slider is being dragged: rebuilding would replace the very
   * `<input type="range">` under the pointer and the drag would die with it. The drag keeps its
   * own readouts current, and the rebuild lands as soon as the pointer is released.
   */
  refresh() {
    if (this._root?.querySelector?.('input[type="range"]:active')) return;
    this._onRefresh?.();
  }

  /**
   * Bind the delegated listeners onto whatever element holds this mixer's markup.
   * @param {HTMLElement} root - The window's element, or the editor pane's body.
   */
  attach(root) {
    if (!root || this._root === root) return;
    this.detach();
    this._root = root;
    this._handlers = {
      input: (event) => this._onInput(event),
      change: (event) => this._onChange(event),
      click: (event) => this._onClick(event)
    };
    // Only rows that are drag sources can have this conflict at all.
    if (this.graphTools) this._handlers.mousedown = (event) => this._onMouseDown(event);
    if (this.keyboard) this._handlers.keydown = (event) => this._onKeyDown(event);
    for (const [type, handler] of Object.entries(this._handlers)) root.addEventListener(type, handler);
  }

  /** Remove the listeners bound by attach(). */
  detach() {
    if (!this._root || !this._handlers) return;
    for (const [type, handler] of Object.entries(this._handlers)) this._root.removeEventListener(type, handler);
    this._handlers = null;
    this._root = null;
  }

  /**
   * Drop every listener, pending write and audition state. Hosts call this when they close.
   */
  teardown() {
    // Solo is an audition state; leaving it behind on a closed view would silence tracks with no
    // visible cause and nothing left to un-silence them from.
    if (getSoloIds(this.playlistId).size > 0) {
      clearSolo(this.playlistId);
      applyMixToPlaylist(this.playlist, { duration: 200 });
    }
    for (const timer of this._writeTimers.values()) clearTimeout(timer);
    this._writeTimers.clear();
    this.detach();
    liveControllers.delete(this);
  }

  /* -------------------------------------------- */
  /*  Data                                        */
  /* -------------------------------------------- */

  /**
   * Build the row/header data the pure builder renders. Everything curve-related is resolved here
   * so playlist-mixer-render.mjs never has to know about AudioHelper.
   * @returns {object}
   */
  prepareData() {
    const playlist = this.playlist;
    const mix = normalizeMix(getPlaylistMix(playlist));
    const solo = getSoloIds(this.playlistId);
    // The editor supplies its live working graph; everyone else reads the saved flag.
    const graph = this._getGraph ? this._getGraph() : getCustomGraph(playlist);
    const isGraph = !!graph;

    // How many Track nodes reference each sound - the same question the graph editor's Tracks
    // pane answers, and the reason the mixer is useful on a graph playlist at all ("which of
    // these am I actually still playing?").
    const usage = new Map();
    if (isGraph) {
      for (const node of graph.nodes ?? []) {
        if (node.type !== 'track' || !node.soundId) continue;
        usage.set(node.soundId, (usage.get(node.soundId) ?? 0) + 1);
      }
    }

    const order = new Map();
    if (!isGraph) {
      const ordered = playlist?.playbackOrder ?? [];
      ordered.forEach((id, index) => order.set(id, index + 1));
    }

    const tracks = Array.from(playlist?.sounds ?? []).map((sound) => {
      const volume = coerceVolume(sound.volume, 1);
      const muted = mix.muted.includes(sound.id);
      const effective = effectiveVolume(volume, mix, sound.id);
      return {
        id: sound.id,
        // Foundry's own drag payload shape - the canvas drop handler and the sidebar drag share
        // one code path, so a row dragged out of this pane must look exactly like a sidebar one.
        uuid: sound.uuid ?? '',
        name: sound.name ?? '',
        sliderValue: volumeToInput(volume).toFixed(2),
        percent: displayPercent(volume),
        effectivePercent: muted ? 0 : displayPercent(effective),
        muted,
        solo: solo.has(sound.id),
        // The ceiling, not the gain, is what is holding this row down - worth flagging, because
        // the row's own slider then does nothing audible above that point.
        clamped: !muted && volume * mix.gain > mix.ceiling,
        fade: sound.fade ?? null,
        usedBy: isGraph ? (usage.get(sound.id) ?? 0) : null,
        order: order.get(sound.id) ?? null
      };
    });

    let worldCrossfadeMs = 0;
    try {
      worldCrossfadeMs = Number(game.settings.get(CONST.moduleId, CONST.settings.graphCrossfade)) || 0;
    } catch (error) {
      log(3, () => `Mixer could not read the world crossfade setting: ${error}`);
    }

    // Shows the value actually in force, whichever link of the chain supplies it - including a
    // legacy graph-stored override this window has never written. Blank means "inheriting".
    const crossfadeMs = resolveCrossfadeOverride(mix.crossfadeMs) ?? resolveCrossfadeOverride(graph?.crossfadeMs);
    const playlistFade = playlist?.fade ?? null;

    return {
      tracks,
      selection: Array.from(this.selection),
      compact: this.compact,
      graphTools: this.graphTools,
      header: {
        gainSlider: volumeToInput(mix.gain).toFixed(2),
        gainPercent: displayPercent(mix.gain),
        ceilingSlider: volumeToInput(mix.ceiling).toFixed(2),
        ceilingPercent: displayPercent(mix.ceiling),
        crossfadeMs,
        worldCrossfadeMs,
        playlistFade,
        // The warning custom-playback-engine.mjs#_warnIfFadeBreaksTheSeam otherwise only logs
        // after the fact, moved to where the mistake is made. Not a block - a GM who wants a fade
        // on a graph playlist can still set one.
        fadeBreaksSeam: isGraph && (playlistFade ?? 0) > 0
      }
    };
  }

  /** @returns {string} The mixer body as HTML, localized. */
  buildHtml() {
    return buildMixerHtml({
      ...this.prepareData(),
      localize: (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key))
    });
  }

  /* -------------------------------------------- */
  /*  Writes                                      */
  /* -------------------------------------------- */

  /**
   * Coalesce document/flag writes per key, so dragging a slider produces one round-trip after it
   * settles rather than one per pixel. Live audio is updated immediately by the caller; only the
   * persisted write waits.
   * @param {string} key
   * @param {() => Promise<void>|void} write
   * @private
   */
  _debouncedWrite(key, write) {
    clearTimeout(this._writeTimers.get(key));
    this._writeTimers.set(
      key,
      setTimeout(async () => {
        this._writeTimers.delete(key);
        try {
          await write();
        } catch (error) {
          log(1, 'Mixer failed to save a change:', error);
          ui.notifications?.error(game.i18n.localize('GameOrchestra.Mixer.SaveFailed'));
        }
      }, WRITE_DEBOUNCE_MS)
    );
  }

  /**
   * Signal that a change has settled, once, however many events produced it.
   *
   * Debounced on the same window as the writes: one slider drag is dozens of `input` events and
   * must be one undo step, not one per pixel. Every mutating path calls this; a path that forgets
   * to is a change Ctrl+Z will skip straight over.
   *
   * The value is already applied locally by the time this fires (`updateSource` is synchronous),
   * so whoever is listening can capture live state immediately without waiting for the database
   * round-trip.
   * @private
   */
  _commit() {
    if (!this._onCommit) return;
    this._debouncedWrite('commit', () => this._onCommit());
  }

  /**
   * Merge a patch into the playlist's `game-orchestra.mix` flag.
   *
   * Kept in its own flag, never folded into `game-orchestra.customPlayback`:
   * hooks.mjs#handleUpdatePlaylist rebuilds a running engine on a customPlayback change (H8), and
   * a rebuilt graph restarts from Start (H9) - so sharing the flag would mean nudging a volume
   * slider audibly restarted the music.
   * @param {object} patch
   * @returns {Promise<void>}
   */
  async patchMix(patch) {
    const playlist = this.playlist;
    if (!playlist) return;
    const current = normalizeMix(getPlaylistMix(playlist));
    await playlist.setFlag(CONST.moduleId, 'mix', { ...current, ...patch });
  }

  /**
   * Write one sound's volume the way core's own sidebar slider does: an immediate local source
   * update so the number and the audio move together, then a debounced document write.
   * @param {object} sound - PlaylistSound document.
   * @param {number} volume
   * @private
   */
  _setSoundVolume(sound, volume) {
    if (!sound) return;
    const value = coerceVolume(volume, 0);
    sound.updateSource?.({ volume: value });
    if (sound.playing) applyMixToSound(sound, { duration: WRITE_DEBOUNCE_MS });
    // debounceVolume is core's own debounced {volume} update; falling back keeps this working
    // against a document that predates it.
    if (typeof sound.debounceVolume === 'function') sound.debounceVolume(value);
    else this._debouncedWrite(`volume:${sound.id}`, () => sound.update({ volume: value }));
    this._commit();
  }

  /**
   * Apply a batch of new volumes (a group-fader move) in one document round-trip, with immediate
   * local feedback per sound first.
   * @param {Object<string, number>} volumes - Sound id -> volume.
   * @private
   */
  _setSoundVolumes(volumes) {
    const playlist = this.playlist;
    if (!playlist) return;
    for (const [soundId, volume] of Object.entries(volumes)) {
      const sound = playlist.sounds.get(soundId);
      if (!sound) continue;
      sound.updateSource?.({ volume });
      if (sound.playing) applyMixToSound(sound, { duration: WRITE_DEBOUNCE_MS });
    }
    this._debouncedWrite('groupVolume', () => {
      const changes = Object.entries(volumes).map(([_id, volume]) => ({ _id, volume }));
      return playlist.updateEmbeddedDocuments('PlaylistSound', changes, { render: false });
    });
    this._commit();
  }

  /** @returns {Array<{id: string, volume: number}>} The selected sounds, or [] when none. */
  _selectedTracks() {
    const playlist = this.playlist;
    if (!playlist) return [];
    return Array.from(this.selection)
      .map((id) => playlist.sounds.get(id))
      .filter(Boolean)
      .map((sound) => ({ id: sound.id, volume: coerceVolume(sound.volume, 0) }));
  }

  /* -------------------------------------------- */
  /*  Input handling                              */
  /* -------------------------------------------- */

  /**
   * Suspend a row's native draggability for the duration of a press on one of its own controls.
   *
   * **Reported live: grabbing a volume knob dragged the track onto the canvas instead of moving
   * the slider.** With `draggable="true"` on the row, the browser resolves a press-and-move to
   * the nearest draggable ancestor and starts an HTML5 drag - the `<input type="range">` under
   * the pointer never sees the gesture at all. `draggable="false"` on the input does not help:
   * the search walks *up* from the target, and the row is still draggable.
   *
   * Draggability is decided at drag start, so clearing it on mousedown is enough to make the
   * browser leave that gesture to the control. It is restored on the next mouseup - bound on
   * `document`, because the pointer is routinely outside the row (and outside the window) by the
   * time a slider drag ends. `dragend` covers the case where a drag did start anyway.
   *
   * Rows that are re-rendered mid-press come back with `draggable="true"` in the markup, so a
   * missed restore self-heals on the next refresh.
   *
   * `[draggable]` in the selector is an attribute-presence test, so it keeps matching a row this
   * guard has already set to false - the property reflects as `draggable="false"`, not as a
   * removed attribute. That is what we want (the row is still a drag source, just suspended), and
   * it is worth stating because the selector reads as though it would stop matching.
   *
   * Verified against a real DOM, not deduced: pressing the slider resolves to its row and counts
   * as a control; pressing the NAME resolves to the row and does not, so dragging a track by its
   * name still works exactly as before.
   * @param {MouseEvent} event
   * @private
   */
  _onMouseDown(event) {
    const row = event.target?.closest?.('.game-orchestra-mixer-row[draggable]');
    if (!row || !event.target.closest?.('input, button')) return;
    row.draggable = false;
    const restore = () => {
      row.draggable = true;
    };
    document.addEventListener('mouseup', restore, { once: true });
    document.addEventListener('dragend', restore, { once: true });
  }

  /**
   * Live slider movement. Sliders only - number fields are handled on `change`, since reacting to
   * every keystroke in a "250" would briefly apply 2 and then 25.
   * @param {Event} event
   * @private
   */
  _onInput(event) {
    const target = event.target;
    const action = target?.dataset?.mixAction;
    if (!action || target.type !== 'range') return;
    const volume = inputToVolume(Number(target.value));

    if (action === 'trackVolume') {
      const sound = this.playlist?.sounds?.get(target.dataset.soundId);
      this._setSoundVolume(sound, volume);
      this._refreshRowReadout(target.dataset.soundId, volume);
      return;
    }

    if (action === 'gain') {
      const selected = this._selectedTracks();
      if (selected.length > 0) {
        // Group fader: relative by default so the balance already dialled in between the selected
        // tracks survives; Alt forces the flattening absolute set.
        const volumes = event.altKey ? setGroupVolume(selected, volume) : applyGroupGain(selected, volume);
        this._setSoundVolumes(volumes);
        this._refreshSelectionReadouts(volumes);
      } else {
        this._previewMix({ gain: volume });
        this._debouncedWrite('mix', () => this.patchMix({ gain: volume }));
        this._commit();
      }
      this._refreshHeaderReadout(target, volume);
      return;
    }

    if (action === 'ceiling') {
      this._previewMix({ ceiling: volume });
      this._debouncedWrite('mix', () => this.patchMix({ ceiling: volume }));
      this._commit();
      this._refreshHeaderReadout(target, volume);
    }
  }

  /**
   * Number fields (crossfade, fades), committed on change.
   * @param {Event} event
   * @private
   */
  _onChange(event) {
    const target = event.target;
    const action = target?.dataset?.mixAction;
    if (!action || target.type === 'range') return;
    // The graph editor has its own delegated `change` dispatcher on an ancestor
    // (app-mixins.mjs#dispatchChangeAction). It matches on `data-change-action`, which nothing in
    // here carries, but stopping here keeps the two from ever having to know about each other.
    event.stopPropagation();

    if (action === 'crossfade') {
      const ms = resolveCrossfadeOverride(target.value.trim());
      target.value = ms === null ? '' : String(ms); // reflect clamping/rounding back
      this._debouncedWrite('mix', () => this.patchMix({ crossfadeMs: ms }));
      this._commit();
      return;
    }

    if (action === 'trackFade') {
      const sound = this.playlist?.sounds?.get(target.dataset.soundId);
      const ms = this._parseFade(target);
      if (sound) {
        sound.updateSource?.({ fade: ms });
        this._debouncedWrite(`fade:${sound.id}`, () => sound.update({ fade: ms }));
        this._commit();
      }
      return;
    }

    if (action === 'fade') {
      const ms = this._parseFade(target);
      const selected = this._selectedTracks();
      if (selected.length > 0) {
        const playlist = this.playlist;
        for (const track of selected) playlist.sounds.get(track.id)?.updateSource?.({ fade: ms });
        this._debouncedWrite('groupFade', () =>
          playlist.updateEmbeddedDocuments(
            'PlaylistSound',
            selected.map((track) => ({ _id: track.id, fade: ms })),
            { render: false }
          )
        );
        this._commit();
        this.refresh();
      } else {
        // Playlist#fade is `positive: true` in the schema, so 0 is not a storable value there -
        // clearing it is null, which is what "no playlist fade" already means.
        this._debouncedWrite('playlistFade', () => this.playlist?.update({ fade: ms || null }));
        this._commit();
      }
    }
  }

  /**
   * @param {HTMLInputElement} target
   * @returns {number|null} A non-negative integer ms, or null when the field is blank.
   * @private
   */
  _parseFade(target) {
    const raw = target.value.trim();
    if (raw === '') return null;
    const ms = Math.max(0, Math.round(Number(raw) || 0));
    target.value = String(ms);
    return ms;
  }

  /**
   * Buttons and row selection.
   *
   * The mixer's own `[data-action]` buttons are handled here and their events stopped, so the
   * host application's action dispatcher never sees actions it has no entry for - which is what
   * lets the same markup work inside the graph editor, whose action map knows nothing about
   * `toggleMute`.
   * @param {MouseEvent} event
   * @private
   */
  _onClick(event) {
    const actionTarget = event.target.closest?.('[data-action]');
    if (actionTarget && this._root?.contains(actionTarget)) {
      const action = actionTarget.dataset.action;
      const handler = { toggleMute: 'toggleMute', toggleSolo: 'toggleSolo', resetMix: 'reset', bakeMix: 'bake', focusNode: 'focusNode' }[action];
      if (handler) {
        event.preventDefault();
        event.stopPropagation();
        this[handler](actionTarget.dataset.soundId);
        return;
      }
    }
    this._onRowClick(event);
  }

  /**
   * Row selection: plain click sets, ctrl/meta toggles, shift extends from the anchor. Clicks on a
   * control inside a row are the control's own business and must not also move the selection.
   * @param {MouseEvent} event
   * @private
   */
  _onRowClick(event) {
    if (event.target.closest('input, button, [data-action]')) return;
    const row = event.target.closest('.game-orchestra-mixer-row');
    // The column header is a `.game-orchestra-mixer-row` for layout reasons and is not selectable.
    if (!row || row.classList.contains('game-orchestra-mixer-column-header')) {
      if (this.selection.size === 0) return;
      this.selection.clear();
      this._selectionAnchor = null;
      this.refresh();
      return;
    }
    const soundId = row.dataset.soundId;
    const ids = this._rowIds();

    if (event.shiftKey && this._selectionAnchor) {
      const from = ids.indexOf(this._selectionAnchor);
      const to = ids.indexOf(soundId);
      if (from >= 0 && to >= 0) this.selection = new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      if (this.selection.has(soundId)) this.selection.delete(soundId);
      else this.selection.add(soundId);
      this._selectionAnchor = soundId;
    } else {
      const onlyThis = this.selection.size === 1 && this.selection.has(soundId);
      this.selection = onlyThis ? new Set() : new Set([soundId]);
      this._selectionAnchor = onlyThis ? null : soundId;
    }
    this.refresh();
  }

  /** @returns {string[]} Sound ids in display order. */
  _rowIds() {
    return Array.from(this.playlist?.sounds ?? []).map((sound) => sound.id);
  }

  /**
   * Keyboard, bound only when the host asked for it (see the constructor's `keyboard` option).
   *
   * | Key | Effect |
   * |---|---|
   * | ↑ / ↓ | Move the row cursor, which also becomes the selection |
   * | ← / → | Adjust the cursor row's volume by 5% (Shift: 1%) |
   * | M / S | Mute / solo the cursor row |
   * | Ctrl+A | Select every row |
   * | Escape | Clear the selection |
   *
   * Typing in a field must never be intercepted, so anything with a focused input bails first -
   * `S` in a fade field is the letter S, not a solo.
   * @param {KeyboardEvent} event
   * @private
   */
  _onKeyDown(event) {
    if (event.target?.tagName === 'INPUT' && event.target.type !== 'range') return;

    if (event.key === 'Escape' && this.selection.size > 0) {
      event.preventDefault();
      this.selection.clear();
      this._selectionAnchor = null;
      this.refresh();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.selection = new Set(this._rowIds());
      this.refresh();
      return;
    }

    const ids = this._rowIds();
    if (ids.length === 0) return;
    const cursor = ids.indexOf(this._selectionAnchor);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = ids[Math.min(ids.length - 1, Math.max(0, cursor + (event.key === 'ArrowDown' ? 1 : -1)))];
      this._selectionAnchor = next;
      this.selection = new Set([next]);
      this.refresh();
      return;
    }

    if (cursor < 0) return; // every key below acts on the cursor row; there isn't one yet
    const sound = this.playlist?.sounds?.get(ids[cursor]);
    if (!sound) return;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      // Stepped on the SLIDER, not on the volume: an even step in volume space is a huge move at
      // the top of the curve and an inaudible one at the bottom.
      const step = (event.shiftKey ? 0.01 : 0.05) * (event.key === 'ArrowRight' ? 1 : -1);
      const position = Math.min(1, Math.max(0, volumeToInput(sound.volume) + step));
      const volume = inputToVolume(position);
      this._setSoundVolume(sound, volume);
      const slider = this._root?.querySelector(`.game-orchestra-mixer-volume[data-sound-id="${sound.id}"]`);
      if (slider) slider.value = position.toFixed(2);
      this._refreshRowReadout(sound.id, volume);
      return;
    }

    if (event.key.toLowerCase() === 'm') {
      event.preventDefault();
      this.toggleMute(sound.id);
      return;
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.toggleSolo(sound.id);
    }
  }

  /* -------------------------------------------- */
  /*  Live readouts                               */
  /* -------------------------------------------- */

  /**
   * Update the percentages next to a slider without a rebuild. Rebuilding mid-drag would replace
   * the very `<input type="range">` the pointer is dragging, and the drag would die with it - the
   * same class of failure HR-A describes in the graph editor, arrived at from a different
   * direction.
   * @param {string} soundId
   * @param {number} volume
   * @private
   */
  _refreshRowReadout(soundId, volume) {
    const row = this._root?.querySelector(`.game-orchestra-mixer-row[data-sound-id="${soundId}"]`);
    if (!row) return;
    const readout = row.querySelector('.game-orchestra-mixer-readout');
    if (readout) readout.textContent = `${displayPercent(volume)}%`;
    const effective = row.querySelector('.game-orchestra-mixer-effective');
    const sound = this.playlist?.sounds?.get(soundId);
    if (effective && sound) effective.textContent = `→ ${displayPercent(mixedVolume(sound))}%`;
  }

  /**
   * @param {HTMLInputElement} slider
   * @param {number} volume
   * @private
   */
  _refreshHeaderReadout(slider, volume) {
    const readout = slider.parentElement?.querySelector('.game-orchestra-mixer-readout');
    if (readout) readout.textContent = `${displayPercent(volume)}%`;
  }

  /**
   * @param {Object<string, number>} volumes
   * @private
   */
  _refreshSelectionReadouts(volumes) {
    for (const [soundId, volume] of Object.entries(volumes)) {
      const slider = this._root?.querySelector(`.game-orchestra-mixer-volume[data-sound-id="${soundId}"]`);
      if (slider) slider.value = volumeToInput(volume).toFixed(2);
      this._refreshRowReadout(soundId, volume);
    }
  }

  /**
   * Apply a not-yet-saved mix change to live audio, so a dragged gain or ceiling is audible
   * immediately instead of after the debounce settles. Writes onto a normalized copy - nothing
   * touches the flag until the debounced write lands.
   * @param {object} patch
   * @private
   */
  _previewMix(patch) {
    const playlist = this.playlist;
    if (!playlist) return;
    const mix = { ...normalizeMix(getPlaylistMix(playlist)), ...patch };
    const solo = getSoloIds(this.playlistId);
    for (const sound of playlist.sounds) {
      if (!sound.playing) continue;
      const target = solo.size > 0 && !solo.has(sound.id) ? 0 : effectiveVolume(sound.volume, mix, sound.id);
      const raw = sound.sound;
      if (raw?.playing && typeof raw.fade === 'function') raw.fade(target, { duration: WRITE_DEBOUNCE_MS });
    }
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /**
   * Mute. Stored in the mix flag rather than by zeroing the document volume, so unmuting restores
   * the level instead of having lost it.
   * @param {string} soundId
   */
  async toggleMute(soundId) {
    if (!soundId) return;
    const mix = normalizeMix(getPlaylistMix(this.playlist));
    // An ARRAY, rebuilt whole. A flag write is a recursive merge server-side, so removing an id
    // from a `{id: true}` map would merge the old `true` straight back in and unmute would
    // silently never persist - see PlaylistMix#muted's own comment.
    const muted = mix.muted.includes(soundId) ? mix.muted.filter((id) => id !== soundId) : [...mix.muted, soundId];
    await this.patchMix({ muted });
    this._commit();
    this.refresh();
  }

  /**
   * Solo - session-only and local to this client (see playlist-mix-apply.mjs#sessionSolo). It is
   * an audition tool, so the table goes on hearing the real mix.
   * @param {string} soundId
   */
  toggleSolo(soundId) {
    if (!soundId) return;
    toggleSolo(this.playlistId, soundId);
    applyMixToPlaylist(this.playlist, { duration: WRITE_DEBOUNCE_MS });
    this.refresh();
  }

  /**
   * Clear the whole mix back to transparent. Per-track volumes are documents and are deliberately
   * NOT touched - this resets what the mixer layered on top, not the levels the GM set on the
   * tracks themselves.
   */
  async reset() {
    const playlist = this.playlist;
    if (!playlist) return;
    clearSolo(this.playlistId);
    await playlist.unsetFlag(CONST.moduleId, 'mix');
    applyMixToPlaylist(playlist, { duration: 200 });
    this._commit();
    this.refresh();
  }

  /**
   * Write the effective volumes into the track documents and reset the gain and clamp to
   * transparent - what you hear stays the same, but the numbers on the tracks are now the real
   * ones, visible to the sidebar and to anything else that reads them.
   *
   * The **only** route that rewrites volumes in bulk, and the only destructive one, so it confirms
   * first. Mute is deliberately left in the flag rather than baked to 0: baking it would destroy
   * the level behind it, which is exactly what storing mute outside the document exists to
   * prevent.
   */
  async bake() {
    const playlist = this.playlist;
    if (!playlist) return;

    const confirmed = await foundry.applications.api.DialogV2?.confirm?.({
      window: { title: game.i18n.localize('GameOrchestra.Mixer.Bake') },
      content: `<p>${game.i18n.localize('GameOrchestra.Mixer.BakeConfirm')}</p>`
    });
    if (confirmed === false) return;

    const mix = normalizeMix(getPlaylistMix(playlist));
    const changes = Array.from(playlist.sounds)
      .filter((sound) => !mix.muted.includes(sound.id))
      .map((sound) => ({ _id: sound.id, volume: effectiveVolume(sound.volume, { ...mix, muted: [] }) }));

    try {
      if (changes.length > 0) await playlist.updateEmbeddedDocuments('PlaylistSound', changes);
      await playlist.setFlag(CONST.moduleId, 'mix', { ...mix, gain: 1, floor: 0, ceiling: 1 });
    } catch (error) {
      log(1, 'Mixer failed to bake the mix into the tracks:', error);
      ui.notifications?.error(game.i18n.localize('GameOrchestra.Mixer.SaveFailed'));
      return;
    }
    this._commit();
    this.refresh();
  }

  /**
   * Jump to the Track node that plays this sound, in an open graph editor for this playlist.
   * Silent when none is open - the badge is primarily a count, and opening a whole window off a
   * tooltip click would be a surprise.
   * @param {string} soundId
   */
  focusNode(soundId) {
    const instances = foundry.applications?.instances;
    if (!soundId || !instances) return;
    for (const app of instances.values()) {
      if (app?.constructor?.name !== 'CustomPlaylistEditor') continue;
      if (app.playlist?.id !== this.playlistId) continue;
      const node = (app.graph?.nodes ?? []).find((candidate) => candidate.type === 'track' && candidate.soundId === soundId);
      if (node) {
        app._focusNode(node.id);
        app.bringToFront?.();
      }
      return;
    }
  }
}
