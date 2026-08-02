/**
 * PlaylistMixerApp - the standalone mixer window: one per playlist, for every playlist type.
 *
 * Everything it *does* lives in MixerController (playlist-mixer-controller.mjs), which the graph
 * editor's Mixer pane shares. This file is only the window: an ApplicationV2 shell that hands the
 * controller a container to render into and listen on.
 *
 * Opens for **any** playlist type. Nothing here assumes UNSEQUENCED, a graph, or a soundboard -
 * a graph playlist just gets one extra column (its Track-node usage count). That is the point:
 * before this window, per-track volume was reachable only from each sound's own sheet (Foundry's
 * sidebar slider renders solely for a *playing* sound, see its sound-partial.hbs), and the
 * per-playlist crossfade existed only inside the graph editor, which never opens for a
 * sequential or shuffle playlist.
 *
 * Two storage layers, deliberately:
 *
 * - **Per-track volume and fade are the document's own fields**, written straight to the
 *   PlaylistSound exactly as core's sidebar slider does. One source of truth - a module-side
 *   shadow value would disagree with that slider the moment either was touched.
 * - **Everything playlist-wide is the `game-orchestra.mix` flag** (playlist-mix.mjs), applied at
 *   playback time and never written back into a document.
 *
 * This is a plain ApplicationV2 and re-renders freely: HR-A is a Drawflow constraint, and there is
 * no canvas here. (The editor's pane, sharing the same controller, cannot - which is exactly why
 * refreshing goes through the controller's `onRefresh` callback rather than a `render()` call.)
 */

import { getPlaylistById } from './helpers.mjs';
import { MixerController } from './playlist-mixer-controller.mjs';

const { ApplicationV2 } = foundry.applications.api;

export class PlaylistMixerApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ['game-orchestra-mixer'],
    position: { width: 620, height: 'auto' },
    window: { title: 'GameOrchestra.Mixer.Title', icon: 'fas fa-sliders', resizable: true, minimizable: true }
  };

  /**
   * @param {object} playlist - Foundry Playlist document.
   * @param {object} [options]
   */
  constructor(playlist, options = {}) {
    super({ ...options, id: `game-orchestra-mixer-${playlist?.id}` });
    this.playlistId = playlist?.id;
    this.controller = new MixerController({
      playlistId: this.playlistId,
      // A full ApplicationV2 render is fine here and keeps the window's own lifecycle in charge.
      onRefresh: () => this.render(),
      keyboard: true
    });
  }

  /** @returns {object|null} The live playlist document (never cached - it can be deleted). */
  get playlist() {
    return getPlaylistById(this.playlistId);
  }

  /** @override */
  get title() {
    return game.i18n.format('GameOrchestra.Mixer.TitleFor', { name: this.playlist?.name ?? '' });
  }

  /** @override */
  async _renderHTML(_context, _options) {
    return this.controller.buildHtml();
  }

  /** @override */
  _replaceHTML(result, content, _options) {
    content.innerHTML = result;
    // Re-attach after every render: the listeners are delegated on this container, which
    // ApplicationV2 keeps across renders, so attach() no-ops when it is already bound here.
    this.controller.attach(content);
  }

  /** @override */
  _onClose(options) {
    this.controller.teardown();
    super._onClose(options);
  }

  /**
   * Open (or bring forward) the mixer for a playlist. The single entry point every button,
   * context-menu item, and macro should use, so only one window per playlist ever exists.
   * @param {object} playlist - Foundry Playlist document.
   * @returns {PlaylistMixerApp|null}
   */
  static open(playlist) {
    if (!playlist) return null;
    const existing = foundry.applications?.instances?.get(`game-orchestra-mixer-${playlist.id}`);
    if (existing) {
      existing.bringToFront?.();
      return existing;
    }
    const app = new PlaylistMixerApp(playlist);
    app.render(true);
    return app;
  }
}

export { refreshMixerViews } from './playlist-mixer-controller.mjs';
