import { describe, it, expect } from 'vitest';
import { resolveGraphDrop } from '../scripts/graph-drop.mjs';

const context = { editedPlaylistId: 'pl-edited' };

describe('resolveGraphDrop', () => {
  describe('PlaylistSound', () => {
    it('creates a Track node when the sound belongs to the playlist being edited', () => {
      const result = resolveGraphDrop({ type: 'PlaylistSound', playlistId: 'pl-edited', soundId: 's1' }, context);
      expect(result).toEqual({ action: 'track', soundId: 's1' });
    });

    it('rejects a sound from a different playlist instead of silently promoting it to a Playlist node', () => {
      const result = resolveGraphDrop({ type: 'PlaylistSound', playlistId: 'pl-other', soundId: 's1' }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.ForeignSound' });
    });

    it('rejects when the sound id is missing (an unresolvable drag)', () => {
      const result = resolveGraphDrop({ type: 'PlaylistSound', playlistId: 'pl-edited', soundId: null }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
    });

    it('rejects when the parent playlist id is missing', () => {
      const result = resolveGraphDrop({ type: 'PlaylistSound', playlistId: null, soundId: 's1' }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
    });
  });

  describe('Playlist', () => {
    it('creates a Playlist node for any playlist other than the one being edited', () => {
      const result = resolveGraphDrop({ type: 'Playlist', playlistId: 'pl-other', soundId: null }, context);
      expect(result).toEqual({ action: 'playlist', playlistId: 'pl-other' });
    });

    it('rejects a playlist referencing itself', () => {
      const result = resolveGraphDrop({ type: 'Playlist', playlistId: 'pl-edited', soundId: null }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.SelfPlaylist' });
    });

    it('rejects when the playlist id is missing', () => {
      const result = resolveGraphDrop({ type: 'Playlist', playlistId: null, soundId: null }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
    });
  });

  describe('unsupported drops', () => {
    it('rejects an unrecognized document type', () => {
      const result = resolveGraphDrop({ type: 'Actor', playlistId: 'pl-edited', soundId: null }, context);
      expect(result).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
    });

    it('rejects a null/undefined dropped value (an unparseable drag)', () => {
      expect(resolveGraphDrop(null, context)).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
      expect(resolveGraphDrop(undefined, context)).toEqual({ action: 'reject', reasonKey: 'GameOrchestra.CustomEditor.Drop.Unsupported' });
    });
  });

  it('treats a null editedPlaylistId as never matching (e.g. before the playlist context is ready)', () => {
    const result = resolveGraphDrop({ type: 'Playlist', playlistId: 'pl-anything', soundId: null }, { editedPlaylistId: null });
    expect(result).toEqual({ action: 'playlist', playlistId: 'pl-anything' });
  });
});
