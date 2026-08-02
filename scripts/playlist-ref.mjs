import { CONST } from './config.mjs';

/**
 * Pure data helpers for a Playlist graph node's target reference
 * (custom-playback-schema.mjs's PlaylistRef). No `game`/`ui` globals and
 * no DOM - the Foundry-touching half that actually resolves a ref against live
 * scene/settings state lives in helpers.mjs#resolvePlaylistRef, which delegates
 * the pure logic here so it stays unit-testable in isolation (docs/playlist-node-plan.md
 * Phase 1). Importing CONST is safe: config.mjs is itself pure data.
 */

export const PLAYLIST_REF_SOURCES = ['direct', 'scene', 'default'];
export const PLAYLIST_REF_SECTIONS = ['area', 'combat'];
export const PLAYLIST_REF_OVERLAY_MODES = ['active', 'none', 'specific'];

/**
 * The reference a freshly-created Playlist node starts with: an unset direct
 * pick, so the inspector's Save-blocking validation (PlaylistNoTarget) is the
 * very first thing a user sees rather than a silently-wrong default target.
 * @returns {import('./custom-playback-schema.mjs').PlaylistRef}
 */
export function createDefaultPlaylistRef() {
  return { source: 'direct', playlistId: null };
}

/**
 * Normalize a possibly-partial or stale-shaped ref, filling in the fields each
 * source needs and dropping the ones it doesn't (e.g. switching from 'scene'
 * to 'direct' shouldn't leave a stale `section` lying around in the saved
 * data). Never returns null/undefined - an unrecognized source falls back to
 * 'direct' with no target, which validateGraph flags rather than this
 * silently guessing.
 * @param {import('./custom-playback-schema.mjs').PlaylistRef|null|undefined} ref
 * @returns {import('./custom-playback-schema.mjs').PlaylistRef}
 */
export function normalizePlaylistRef(ref) {
  const source = PLAYLIST_REF_SOURCES.includes(ref?.source) ? ref.source : 'direct';
  if (source === 'direct') {
    return { source, playlistId: ref?.playlistId || null };
  }
  const section = PLAYLIST_REF_SECTIONS.includes(ref?.section) ? ref.section : 'area';
  const overlayMode = PLAYLIST_REF_OVERLAY_MODES.includes(ref?.overlayMode) ? ref.overlayMode : 'active';
  const normalized = { source, section, overlayMode };
  if (overlayMode === 'specific') normalized.overlayId = ref?.overlayId || null;
  return normalized;
}

/**
 * Pick a playlist id out of an already-extracted music section object
 * (the same shape PlaylistContext._extractSectionConfig reads from -
 * `{ playlist, overlays: { [overlayId]: { playlist } } }`), per the ref's
 * overlay mode.
 *
 * 'active' deliberately mirrors PlaylistContext._extractSectionConfig()'s own
 * overlay-override lookup, so an indirect reference resolves to the same
 * playlist the module itself would pick for that section right now.
 * 'specific' has NO fallback to the section's base playlist - an unset
 * override for that exact overlay id resolves to nothing rather than
 * silently picking something else (validateGraph's PlaylistUnknownOverlay
 * warns about this shape at edit time).
 * @param {{playlist?: string, overlays?: Record<string, {playlist?: string}>}|null|undefined} section
 * @param {import('./custom-playback-schema.mjs').PlaylistRef} ref
 * @param {string} [activeOverlayId]
 * @returns {string|null}
 */
export function selectSectionPlaylistId(section, ref, activeOverlayId = '') {
  if (!section) return null;
  switch (ref?.overlayMode) {
    case 'none':
      return section.playlist || null;
    case 'specific':
      return (ref.overlayId && section.overlays?.[ref.overlayId]?.playlist) || null;
    case 'active':
    default:
      return (activeOverlayId && section.overlays?.[activeOverlayId]?.playlist) || section.playlist || null;
  }
}

/**
 * Resolve a ref to a playlist id given already-read state. Foundry-free: the
 * caller (helpers.mjs#resolvePlaylistRef) is responsible for reading the
 * active scene, the default-music setting, and both active overlay ids
 * (mood and phase), and handing their already-extracted section objects in
 * here. The section actually referenced (area or combat) decides which axis
 * - and therefore which of the two active ids - applies (config.mjs#sectionAxis).
 * @param {import('./custom-playback-schema.mjs').PlaylistRef} ref
 * @param {object} [state]
 * @param {{area?: object, combat?: object}} [state.sceneSections]
 * @param {{area?: object, combat?: object}} [state.defaultSections]
 * @param {{mood?: string, phase?: string}} [state.activeOverlayIds]
 * @returns {string|null}
 */
export function resolvePlaylistRefId(ref, state = {}) {
  const normalized = normalizePlaylistRef(ref);
  if (normalized.source === 'direct') return normalized.playlistId || null;
  const sections = normalized.source === 'scene' ? state.sceneSections : state.defaultSections;
  const section = sections?.[normalized.section];
  const axis = CONST.sectionAxis[normalized.section];
  const activeOverlayId = state.activeOverlayIds?.[axis] || '';
  return selectSectionPlaylistId(section, normalized, activeOverlayId);
}

/**
 * Short human-readable description of a ref, for a Playlist node's canvas
 * detail line and its inspector row. Resolvers are injected so this stays
 * Foundry-free; the caller (custom-playlist-editor.mjs) supplies ones backed
 * by live documents/settings.
 * @param {import('./custom-playback-schema.mjs').PlaylistRef} ref
 * @param {object} [lookups]
 * @param {(id: string) => string|null} [lookups.playlistName]
 * @param {(id: string) => string|null} [lookups.overlayLabel]
 * @param {(key: string, data?: object) => string} [lookups.localize]
 * @returns {string}
 */
export function describePlaylistRef(ref, lookups = {}) {
  const loc = lookups.localize || ((k) => k);
  const normalized = normalizePlaylistRef(ref);

  if (normalized.source === 'direct') {
    if (!normalized.playlistId) return loc('GameOrchestra.CustomEditor.Ref.MissingPlaylist');
    const name = lookups.playlistName?.(normalized.playlistId);
    return name || loc('GameOrchestra.CustomEditor.Ref.MissingPlaylist');
  }

  const sectionLabel = loc(`GameOrchestra.CustomEditor.Inspector.PlaylistSection.${normalized.section === 'combat' ? 'Combat' : 'Area'}`);
  const sourceKey = normalized.source === 'scene' ? 'GameOrchestra.CustomEditor.Ref.SceneSection' : 'GameOrchestra.CustomEditor.Ref.DefaultSection';
  const base = loc(sourceKey, { section: sectionLabel });

  if (normalized.overlayMode === 'none') return base;
  if (normalized.overlayMode === 'active') return `${base} (${loc('GameOrchestra.CustomEditor.Inspector.PlaylistOverlayMode.Active')})`;
  const overlayName = normalized.overlayId ? lookups.overlayLabel?.(normalized.overlayId) : null;
  return `${base} (${overlayName || normalized.overlayId || loc('GameOrchestra.CustomEditor.Inspector.PlaylistOverlayMode.Specific')})`;
}
