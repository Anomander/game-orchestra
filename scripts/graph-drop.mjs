/**
 * Interprets a document dragged into the graph editor's canvas from the Foundry sidebar (or from
 * this window's own Tracks pane, which emits the identical payload shape) into what node, if
 * any, should be created. Pure - no DOM, Drawflow, or Foundry dependency - so the drop rules are
 * testable without a live editor instance; see docs/graph-editor-panel-plan.md D8 for the locked
 * rule matrix this implements.
 */

/**
 * @param {object} dropped - The resolved document, already flattened by the caller (which does
 *   the async fromUuid() lookup) into a plain type/id pair.
 * @param {'Playlist'|'PlaylistSound'|string} dropped.type
 * @param {string|null} dropped.playlistId - The dropped Playlist's id, or (for a PlaylistSound)
 *   its parent playlist's id.
 * @param {string|null} dropped.soundId - Set only when `type` is 'PlaylistSound'.
 * @param {object} context
 * @param {string|null} context.editedPlaylistId - The playlist this editor window is for.
 * @returns {{action: 'track', soundId: string}
 *          |{action: 'playlist', playlistId: string}
 *          |{action: 'reject', reasonKey: string}}
 */
export function resolveGraphDrop(dropped, context) {
  const editedPlaylistId = context?.editedPlaylistId ?? null;

  if (dropped?.type === 'PlaylistSound') {
    if (!dropped.soundId || !dropped.playlistId) return { action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' };
    // A Track node can only reference a sound inside the playlist being edited
    // (graph-validation.mjs's TrackMissingSound exists for exactly this reason) - a sound from a
    // different playlist is rejected rather than silently promoted to a Playlist node, which
    // would play that whole other playlist instead of the one track the user actually dragged.
    if (dropped.playlistId !== editedPlaylistId) return { action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.ForeignSound' };
    return { action: 'track', soundId: dropped.soundId };
  }

  if (dropped?.type === 'Playlist') {
    if (!dropped.playlistId) return { action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' };
    if (dropped.playlistId === editedPlaylistId) return { action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.SelfPlaylist' };
    return { action: 'playlist', playlistId: dropped.playlistId };
  }

  return { action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' };
}
