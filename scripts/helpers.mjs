import { CONST } from './config.mjs';
import { resolvePlaylistRefId } from './playlist-ref.mjs';

/**
 * Utility helper functions
 */

/**
 * Canonicalize text into a slug ID (lowercased, non-alpha replaced with dashes)
 * @param {string} text - Source text
 * @returns {string} Canonicalized ID
 */
export function canonicalizeId(text) {
  if (!text) return '';
  let str = text;
  if (str.startsWith('GameOrchestra.Mood.')) {
    str = str.replace('GameOrchestra.Mood.', '');
  } else if (str.startsWith('GameOrchestra.Phase.')) {
    str = str.replace('GameOrchestra.Phase.', '');
  } else if (str.startsWith('GameOrchestra.')) {
    str = str.replace('GameOrchestra.', '');
  }
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Get the first available GM user
 * @returns {object|null} First active GM user
 */
export function getFirstAvailableGM() {
  return game.users.filter((user) => user.isGM && user.active).sort((a, b) => a.id.localeCompare(b.id))[0] || null;
}

/**
 * Check if current user is the head GM
 * @returns {boolean} True if current user is head GM
 */
export function isHeadGM() {
  return game.user === getFirstAvailableGM();
}

/**
 * Read the currently active overlay id for a music-section axis - 'mood'
 * (area) or 'phase' (combat). See config.mjs#sectionAxis / #overlayAxes.
 * @param {'mood'|'phase'} axis
 * @returns {string}
 */
export function getActiveOverlayId(axis) {
  return game.settings.get(CONST.moduleId, CONST.overlayAxes[axis].activeSetting) || '';
}

/**
 * Get property from object using dot notation
 * @param {object} object - Source object
 * @param {string} path - Dot notation path
 * @returns {*} Property value
 */
export function getProperty(object, path) {
  return foundry.utils.getProperty(object, path);
}

/**
 * Safely fetch a playlist from game.playlists
 * @param {string} playlistId - Playlist ID to look up
 * @returns {object|null} Playlist document or null
 */
export function getPlaylistById(playlistId) {
  if (!playlistId || !game.playlists) return null;
  if (typeof game.playlists.get === 'function') return game.playlists.get(playlistId);
  const list = game.playlists.contents || Array.from(game.playlists);
  return list.find((p) => p.id === playlistId) || null;
}

/**
 * Read a playlist's custom playback graph, if any
 * @param {object|null} playlist - Foundry Playlist document
 * @returns {import('./custom-playback-schema.mjs').CustomGraph|null} Stored graph or null
 */
export function getCustomGraph(playlist) {
  return playlist?.getFlag?.(CONST.moduleId, 'customPlayback') ?? null;
}

/**
 * Check whether a playlist has a custom playback graph configured. Custom
 * playlists are stored in UNSEQUENCED mode (see custom-playlist-plan.md H1) but
 * must never be treated as a plain Soundboard elsewhere in the module (H2) -
 * every isSoundboard computation must exclude playlists this returns true for.
 * @param {object|null} playlist - Foundry Playlist document
 * @returns {boolean} True if a custom playback graph is configured
 */
export function isCustomPlaylist(playlist) {
  return !!getCustomGraph(playlist);
}

/**
 * Resolve the initial track to store alongside a playlist selection: keeps
 * the existing track if it still belongs to the selected playlist, otherwise
 * auto-assigns the first track for Soundboard (UNSEQUENCED) playlists. Custom
 * playlists are also stored in UNSEQUENCED mode but must never receive an
 * implicit initial track - a stray trackId would bypass their graph entirely
 * (see custom-playlist-plan.md H2).
 *
 * `existingTrackId` is whatever was previously stored for this slot - which,
 * when the caller is reassigning the slot to a *different* playlist, belongs
 * to the OLD playlist, not this one. Without validating it against the new
 * playlist's own sounds, a stale foreign track ID gets written back verbatim:
 * `PlaylistContext._resolveTracks()` then does `playlist.sounds.get(staleId)`,
 * finds nothing, and silently resolves to zero tracks.
 * @param {string} playlistId - Selected playlist ID
 * @param {string|null} existingTrackId - Previously configured track ID, if any
 * @returns {string|null} Resolved initial track ID
 */
export function resolveInitialTrack(playlistId, existingTrackId) {
  const playlist = getPlaylistById(playlistId);
  let initialTrackId = existingTrackId && playlist?.sounds?.get(existingTrackId) ? existingTrackId : null;
  const unsequencedMode = globalThis.CONST?.PLAYLIST_MODES?.UNSEQUENCED ?? -1;
  if (playlist?.mode === unsequencedMode && !initialTrackId && !isCustomPlaylist(playlist)) {
    const firstTrack = (playlist.sounds?.contents || Array.from(playlist.sounds?.values() || []))[0];
    if (firstTrack) initialTrackId = firstTrack.id;
  }
  return initialTrackId;
}

/**
 * Build the list of available playlists with their tracks and soundboard/custom
 * flags, for populating playlist/track select dropdowns. isSoundboard excludes
 * custom playlists even though both live in UNSEQUENCED mode (see H2) so that
 * downstream Soundboard-only behavior (initial-track auto-assign, single-track
 * picker UI) never fires for a custom playlist.
 * @returns {Array<{id: string, name: string, isSoundboard: boolean, isCustom: boolean, tracks: Array<{id: string, name: string}>}>}
 */
export function getAvailablePlaylists() {
  const unsequencedMode = globalThis.CONST?.PLAYLIST_MODES?.UNSEQUENCED ?? -1;
  return (game.playlists?.contents || Array.from(game.playlists || [])).map((p) => {
    const tracks = (p.sounds?.contents || Array.from(p.sounds?.values() || [])).map((s) => ({ id: s.id, name: s.name }));
    const isCustom = isCustomPlaylist(p);
    return { id: p.id, name: p.name, isSoundboard: p.mode === unsequencedMode && !isCustom, isCustom, tracks };
  });
}

/**
 * Extract a music section object (`{playlist, initialTrack, priority, exclusive, overlays}`)
 * from any of the three document shapes this module configures. The single
 * place that knows where each category stores its flags - PlaylistContext.fromDocument,
 * resolvePlaylistRef and MusicController's combatant resolution all read through here.
 *
 * `undefined` and `null` are NOT interchangeable in the return: `undefined`
 * means "this document category isn't one we configure at all" (the caller
 * should refuse it), `null` means "supported, but this section is unset".
 * Collapsing the two would make an unsupported document silently look like an
 * unconfigured one.
 * @param {Document|object|null} document
 * @param {'area'|'combat'} type
 * @returns {object|null|undefined}
 */
/**
 * The inherent standing of a scope's section, before any stored override.
 *
 * This is the hierarchy the module actually promises - a token's theme outranks the
 * scene it stands in, which outranks the world default - expressed as the numbers in
 * `config.mjs#playlistSections`. The world default has no entry there and sits at 0,
 * below both scene baselines, which is exactly what "fallback" means.
 *
 * Applied at resolution time by `PlaylistContext._extractSectionConfig`. Nothing
 * writes it into a flag; a stored `priority` is a deliberate *override* of this, and
 * the two must not be conflated (see that method's comment).
 * @param {Document|object} document - Source document or data model
 * @param {'area'|'combat'} type
 * @returns {number}
 */
export function sectionBaselinePriority(document, type) {
  const category = getDocumentCategory(document);
  if (category === 'DefaultMusic') return 0;
  const documentName = category === 'PrototypeToken' ? 'Token' : document?.documentName;
  // Actors speak for their prototype token, so they share the Token baseline.
  const key = documentName === 'Actor' ? 'Token' : documentName;
  return CONST.playlistSections?.[key]?.[type]?.priority ?? 0;
}

export function readMusicSection(document, type) {
  const category = getDocumentCategory(document);
  if (category === 'Document') return document.getFlag(CONST.moduleId, `music.${type}`) || null;
  if (category === 'PrototypeToken') return document.flags?.[CONST.moduleId]?.music?.[type] || null;
  if (category === 'DefaultMusic') return document.data?.[CONST.moduleId]?.music?.[type] || null;
  return undefined;
}

/**
 * Resolve a Playlist graph node's reference (custom-playback-schema.mjs's
 * PlaylistRef) against live game state - the active scene, the world default
 * music setting, and the active mood/phase (per the referenced section's own
 * axis - see config.mjs#sectionAxis) - and return the target Playlist
 * document. Delegates the actual resolution logic to playlist-ref.mjs, which
 * stays Foundry-free and unit-testable on its own.
 * @param {import('./custom-playback-schema.mjs').PlaylistRef} ref
 * @returns {object|null} Playlist document, or null if unresolvable.
 */
export function resolvePlaylistRef(ref) {
  const activeOverlayIds = { mood: getActiveOverlayId('mood'), phase: getActiveOverlayId('phase') };
  const scene = game.scenes?.active || null;
  const defaultConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || null;
  const sceneSections = { area: readMusicSection(scene, 'area') ?? null, combat: readMusicSection(scene, 'combat') ?? null };
  const defaultSections = { area: readMusicSection(defaultConfig, 'area') ?? null, combat: readMusicSection(defaultConfig, 'combat') ?? null };
  const playlistId = resolvePlaylistRefId(ref, { sceneSections, defaultSections, activeOverlayIds });
  return playlistId ? getPlaylistById(playlistId) : null;
}

/**
 * Every playlist a Playlist graph node could target, with the metadata the
 * editor and graph-validation.mjs need. Excludes nothing - callers decide what
 * is or isn't a legal target (e.g. the editor omits the playlist being edited).
 * @returns {Array<{id: string, name: string, mode: number, isCustom: boolean, soundCount: number, graph: import('./custom-playback-schema.mjs').CustomGraph|null}>}
 */
export function getGraphTargetPlaylists() {
  return (game.playlists?.contents || Array.from(game.playlists || [])).map((p) => {
    const soundCount = (p.sounds?.contents || Array.from(p.sounds?.values() || [])).length;
    return { id: p.id, name: p.name, mode: p.mode, isCustom: isCustomPlaylist(p), soundCount, graph: getCustomGraph(p) };
  });
}

/**
 * Build a playlist/track entry for template display, resolving a Soundboard
 * playlist's implicit first track when no explicit track is set
 * @param {Array} availablePlaylists - Result of getAvailablePlaylists()
 * @param {string|null} playlistId - Selected playlist ID
 * @param {string|null} trackId - Selected track ID, if any
 * @returns {{playlistId: string|null, initialTrackId: string|null, isSoundboard: boolean, isCustom: boolean, tracks: Array}}
 */
export function buildPlaylistEntry(availablePlaylists, playlistId, trackId) {
  const pl = playlistId ? availablePlaylists.find((p) => p.id === playlistId) : null;
  const isSoundboard = pl?.isSoundboard ?? false;
  const isCustom = pl?.isCustom ?? false;
  const tracks = pl?.tracks || [];
  let effectiveTrackId = trackId || null;
  if (isSoundboard && !effectiveTrackId && tracks.length > 0) effectiveTrackId = tracks[0].id;
  return { playlistId: playlistId || null, initialTrackId: effectiveTrackId, isSoundboard, isCustom, tracks };
}

/**
 * Identify the Game Orchestra document category for a given entity
 * @param {Document|object} doc - The document to identify
 * @returns {'Document'|'PrototypeToken'|'DefaultMusic'|null}
 */
export function getDocumentCategory(doc) {
  if (!doc) return null;
  if (doc instanceof foundry.abstract.Document) return 'Document';
  // instanceof first, constructor.name only as the fallback: the name check is
  // the fragile one (a system or module subclassing PrototypeToken, or any build
  // that mangles class names, silently reclassifies the document as null - which
  // routes every write into GameOrchestraConfig#updateObject's no-op branch).
  if (foundry.data?.PrototypeToken && doc instanceof foundry.data.PrototypeToken) return 'PrototypeToken';
  if (doc.constructor?.name === 'PrototypeToken') return 'PrototypeToken';
  if (doc.documentName === 'DefaultMusic') return 'DefaultMusic';
  return null;
}

/**
 * Playlist context class for managing music contexts
 */
export class PlaylistContext {
  /**
   * @param {string} context - The context type ('area' or 'combat')
   * @param {Document} contextEntity - The entity providing the context
   * @param {object} playlist - The playlist to play
   * @param {string|null} trackId - Specific track ID or null for default
   * @param {number} priority - Priority level for sorting
   * @param {Document|null} scopeEntity - Entity for progress tracking
   * @param {boolean} [isOverlay] - Whether this context resolved through a mood/phase override.
   */
  constructor(context, contextEntity, playlist, trackId, priority = 0, scopeEntity = null, isOverlay = false) {
    this.context = context;
    this.contextEntity = contextEntity;
    this.playlist = playlist;
    this.trackId = trackId;
    this.priority = priority;
    this.scopeEntity = scopeEntity;
    this.isOverlay = isOverlay;
    // Which overlay axis this context's section resolves against ('mood' for
    // area, 'phase' for combat - config.mjs#sectionAxis), so UI consumers can
    // tell which axis is currently "resolving" without re-deriving it.
    this.overlayAxis = CONST.sectionAxis[context] ?? null;
    this._resolvedTracks = null;
  }

  /**
   * Get all tracks to play from this context based on track override or playlist mode
   * @returns {Array<object>} Array of tracks to play
   */
  get tracks() {
    if (this._resolvedTracks !== null) return this._resolvedTracks;
    this._resolvedTracks = this._resolveTracks();
    return this._resolvedTracks;
  }

  /**
   * Sounds reachable from a custom graph's own Track nodes, plus - transitively -
   * from every DIRECT Playlist-node reference it contains: that target's own
   * Track-node sounds when it has a graph (recursing further), or all of its
   * sounds when it doesn't (docs/playlist-node-plan.md Phase 4.4).
   *
   * Indirect references (scene/default) are deliberately NOT followed here -
   * they depend on live scene/mood state a static resolution like this one
   * can't evaluate. That's a real but bounded gap: transitionToContext()'s
   * fade-out loop uses this list to decide which currently-playing sounds to
   * leave alone, so an indirectly-referenced sub-playlist's sound can get
   * briefly faded/re-triggered on a context re-resolution it otherwise
   * wouldn't need to be - a crossfade blip, never silently wrong playback
   * (the running CustomPlaybackEngine is still the actual source of truth for
   * what plays; this list only feeds the OUTER controller's fade bookkeeping).
   * @param {object} playlist
   * @param {Set<string>} visited - Playlist ids already walked, across the whole call tree.
   * @returns {Array<object>} Sound documents.
   * @private
   */
  static _collectCustomGraphTracks(playlist, visited) {
    if (!playlist?.id || visited.has(playlist.id)) return [];
    visited.add(playlist.id);
    const graph = getCustomGraph(playlist);
    if (!graph) return [];

    const sounds = [];
    for (const node of graph.nodes || []) {
      if (node.type === 'track') {
        const sound = playlist.sounds.get(node.soundId);
        if (sound) sounds.push(sound);
      } else if (node.type === 'playlist' && node.playlistRef?.source === 'direct' && node.playlistRef.playlistId) {
        const target = getPlaylistById(node.playlistRef.playlistId);
        if (!target) continue;
        if (getCustomGraph(target)) {
          sounds.push(...this._collectCustomGraphTracks(target, visited));
        } else {
          sounds.push(...(target.sounds?.contents || Array.from(target.sounds?.values() || [])));
        }
      }
    }
    return sounds;
  }

  /**
   * Internal method to resolve tracks for this context
   * @returns {Array<object>} Array of tracks to play
   * @private
   */
  _resolveTracks() {
    if (!this.playlist) return [];

    // Custom graphs own their own track selection and MUST be checked before
    // trackId: a stale initialTrack flag from before the custom-playlist guards
    // existed (or from any other future code path) would otherwise short-circuit
    // straight to a single track and silently bypass the whole graph
    // (custom-playlist-plan.md H2).
    if (isCustomPlaylist(this.playlist)) {
      return PlaylistContext._collectCustomGraphTracks(this.playlist, new Set());
    }

    if (this.trackId) {
      const track = this.playlist.sounds.get(this.trackId);
      return track ? [track] : [];
    }

    const mode = this.playlist.mode;
    const modes = globalThis.CONST?.PLAYLIST_MODES ?? { UNSEQUENCED: -1, SEQUENTIAL: 0, SHUFFLE: 1, SIMULTANEOUS: 2 };

    if (mode === modes.SIMULTANEOUS) {
      return Array.from(this.playlist.sounds.values());
    }

    if (mode === modes.SHUFFLE) {
      const order = this.playlist.playbackOrder || Array.from(this.playlist.sounds.keys());
      if (order.length === 0) return [];
      // Use the currently playing track from this playlist if one exists,
      // rather than picking a new random track each evaluation
      const currentlyPlaying = this.playlist.sounds.find((s) => s.playing);
      if (currentlyPlaying) return [currentlyPlaying];
      const randomIndex = Math.floor(Math.random() * order.length);
      const track = this.playlist.sounds.get(order[randomIndex]);
      return track ? [track] : [];
    }

    if (mode === modes.UNSEQUENCED) {
      return [];
    }

    const firstTrackId = this.playlist.playbackOrder?.[0] || Array.from(this.playlist.sounds.keys())[0];
    const track = firstTrackId ? this.playlist.sounds.get(firstTrackId) : null;
    return track ? [track] : [];
  }

  /**
   * Get the primary track to play from this context
   * @returns {object|null} The track or null
   */
  get track() {
    return this.tracks[0] || null;
  }

  /**
   * Extract playlist context data from a music section config object. The
   * overlay axis (mood vs phase) is the caller's responsibility - see
   * fromDocument() - this only needs the id to look up.
   * @param {object} section - The music section data (e.g., from flags or settings)
   * @param {string} overlayId - Active overlay id for this section's axis
   * @returns {{playlistId: string|null, trackId: string|null, priority: number, isOverlay: boolean}}
   * @private
   */
  static _extractSectionConfig(section, overlayId, baseline = 0) {
    if (!section) return { playlistId: null, trackId: null, priority: baseline, isOverlay: false };
    const overlay = (overlayId && section.overlays?.[overlayId]?.playlist) ? section.overlays[overlayId] : null;
    const isOverlay = !!overlay;
    const config = overlay || section;
    // `baseline` is the scope's inherent standing - scene area -20, scene combat -15,
    // token combat +20 (config.mjs#playlistSections), 0 for the world default. It is
    // applied HERE, at resolution time, rather than being written into a flag when a
    // binding happens to be created by drag-and-drop.
    //
    // It used to be the latter, and only the drop path did it: a binding made through
    // the tree's dropdown stored no priority and therefore resolved at 0, while a
    // visually identical one made by dragging stored -20. Two bindings that looked
    // the same resolved differently, and nothing on screen explained it.
    const defaultPriority = section.priority ?? baseline;
    const overlayOffset = isOverlay ? 10 : 0;
    const basePriority = defaultPriority + overlayOffset;
    const priority = config.priority ?? basePriority;
    return {
      playlistId: config.playlist || null,
      trackId: config.initialTrack || null,
      priority,
      isOverlay
    };
  }

  /**
   * Create playlist context from document
   * @param {Document|object} document - Source document or data model
   * @param {string} type - Music type ('area' or 'combat')
   * @param {Document} scopeEntity - Scope entity for progress tracking
   * @param {string} [overlayId] - Active overlay id for this section's axis (mood for area, phase
   *   for combat - config.mjs#sectionAxis); reads the matching setting when omitted.
   * @returns {PlaylistContext|null} Created context or null
   */
  static fromDocument(document, type = 'combat', scopeEntity = null, overlayId = undefined) {
    if (!document) {
      log(3, `PlaylistContext.fromDocument: Document is null or undefined for type '${type}'`);
      return null;
    }
    const axis = CONST.sectionAxis[type];
    overlayId = overlayId ?? getActiveOverlayId(axis);
    const docName = document.name || document.id || document?.constructor?.name;

    // Determine the music section based on document category. `undefined` back
    // from readMusicSection means an unsupported category, which is a different
    // outcome from a supported document with nothing configured - see its doc.
    const section = readMusicSection(document, type);
    if (section === undefined) {
      log(3, `PlaylistContext.fromDocument: Document of type '${document?.constructor?.name || typeof document}' is not supported (type: '${type}')`);
      return null;
    }

    const { playlistId, trackId, priority, isOverlay } = this._extractSectionConfig(section, overlayId, sectionBaselinePriority(document, type));
    const playlist = playlistId ? game.playlists.get(playlistId) : null;

    if (!playlist) {
      log(3, `PlaylistContext.fromDocument: No playlist override found on document '${docName}' (type: '${type}', ${axis}: '${overlayId || 'default'}')`);
      return null;
    }

    return new this(type, document, playlist, trackId, priority, scopeEntity, isOverlay);
  }
}

/**
 * Fading track handler for smooth transitions
 */
export class FadingTrack {
  /**
   * @param {object} track - The track to fade
   * @param {number} fadeDuration - Duration of fade in milliseconds
   */
  constructor(track, fadeDuration = 1000) {
    this.track = track;
    this.fadeDuration = fadeDuration;
    setTimeout(() => this.delete(), this.fadeDuration + 10);
  }

  /**
   * Remove this fading track from the controller
   */
  delete() {
    const controller = game.gameOrchestra?.musicController;
    if (!controller) return;
    const index = controller.fadingTracks.indexOf(this);
    if (index >= 0) {
      controller.fadingTracks.splice(index, 1);
      if (controller.currentTrack === this.track) controller.playCurrentTrack();
    }
  }
}

/**
 * Cached value of the 'enableDebug' setting, kept in sync by settings.mjs
 * (set once at registration time, then on every onChange) so log()'s hot
 * path - called on every node hop by custom-playback-engine.mjs - doesn't
 * re-read game.settings on every single call. `null` means not yet
 * initialized (before registerSettings() has run), in which case log() falls
 * back to a direct settings read.
 * @type {boolean|null}
 */
let _debugEnabledCache = null;

/**
 * Update the cached 'enableDebug' value. Called once by registerSettings()
 * right after registering the setting, and again on every onChange.
 * @param {boolean} value
 */
export function setDebugEnabled(value) {
  _debugEnabledCache = !!value;
}

/**
 * Portable log function for the module
 * @param {number} level - Log level (1: error, 2: warn, 3: log)
 * @param {...*} args - Arguments to log. A single function argument is treated
 *   as a thunk returning the real argument(s) and is only invoked when this
 *   call will actually print - used by custom-playback-engine.mjs's per-hop
 *   trace log so the template string itself is never built while debug
 *   logging is off.
 */
export function log(level, ...args) {
  const prefix = 'Game Orchestra |';
  if (level > 1) {
    let enabled = _debugEnabledCache;
    if (enabled === null) {
      try {
        enabled = game.settings.get(CONST.moduleId, 'enableDebug');
      } catch (e) {
        enabled = true; // settings not yet initialized/ready - fail open rather than lose early-boot logs
      }
    }
    if (!enabled) return;
  }
  const resolvedArgs = args.length === 1 && typeof args[0] === 'function' ? [args[0]()] : args;
  switch (level) {
    case 1:
      console.error(prefix, ...resolvedArgs);
      break;
    case 2:
      console.warn(prefix, ...resolvedArgs);
      break;
    case 3:
    default:
      console.log(prefix, ...resolvedArgs);
      break;
  }
}
