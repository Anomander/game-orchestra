import { describe, it, expect } from 'vitest';
import {
  createDefaultPlaylistRef,
  normalizePlaylistRef,
  selectSectionPlaylistId,
  resolvePlaylistRefId,
  describePlaylistRef
} from '../scripts/playlist-ref.mjs';

describe('createDefaultPlaylistRef', () => {
  it('starts as an unset direct reference', () => {
    expect(createDefaultPlaylistRef()).toEqual({ source: 'direct', playlistId: null });
  });
});

describe('normalizePlaylistRef', () => {
  it('normalizes a direct ref, defaulting a missing playlistId to null', () => {
    expect(normalizePlaylistRef({ source: 'direct' })).toEqual({ source: 'direct', playlistId: null });
    expect(normalizePlaylistRef({ source: 'direct', playlistId: 'pl1' })).toEqual({ source: 'direct', playlistId: 'pl1' });
  });

  it('normalizes a scene/default ref, defaulting section and overlayMode', () => {
    expect(normalizePlaylistRef({ source: 'scene' })).toEqual({ source: 'scene', section: 'area', overlayMode: 'active' });
    expect(normalizePlaylistRef({ source: 'default', section: 'combat', overlayMode: 'none' })).toEqual({
      source: 'default',
      section: 'combat',
      overlayMode: 'none'
    });
  });

  it('keeps overlayId only when overlayMode is specific', () => {
    expect(normalizePlaylistRef({ source: 'scene', section: 'area', overlayMode: 'specific', overlayId: 'boss' })).toEqual({
      source: 'scene',
      section: 'area',
      overlayMode: 'specific',
      overlayId: 'boss'
    });
    expect(normalizePlaylistRef({ source: 'scene', section: 'area', overlayMode: 'active', overlayId: 'boss' })).toEqual({
      source: 'scene',
      section: 'area',
      overlayMode: 'active'
    });
  });

  it('falls back to direct with no target for an unrecognized source', () => {
    expect(normalizePlaylistRef({ source: 'bogus' })).toEqual({ source: 'direct', playlistId: null });
  });

  it('falls back to direct with no target for a missing/null ref', () => {
    expect(normalizePlaylistRef(null)).toEqual({ source: 'direct', playlistId: null });
    expect(normalizePlaylistRef(undefined)).toEqual({ source: 'direct', playlistId: null });
  });

  it('falls back invalid section/overlayMode to defaults', () => {
    expect(normalizePlaylistRef({ source: 'scene', section: 'bogus', overlayMode: 'bogus' })).toEqual({
      source: 'scene',
      section: 'area',
      overlayMode: 'active'
    });
  });
});

describe('selectSectionPlaylistId', () => {
  const section = { playlist: 'base-pl', overlays: { calm: { playlist: 'calm-pl' }, boss: { playlist: 'boss-pl' } } };

  it('returns null for a missing section', () => {
    expect(selectSectionPlaylistId(null, { overlayMode: 'none' })).toBeNull();
  });

  it('overlayMode none: returns the section base playlist, ignoring the active overlay', () => {
    expect(selectSectionPlaylistId(section, { overlayMode: 'none' }, 'calm')).toBe('base-pl');
  });

  it('overlayMode active: mirrors PlaylistContext, falling back to the base playlist when unset', () => {
    expect(selectSectionPlaylistId(section, { overlayMode: 'active' }, 'calm')).toBe('calm-pl');
    expect(selectSectionPlaylistId(section, { overlayMode: 'active' }, 'unmapped')).toBe('base-pl');
    expect(selectSectionPlaylistId(section, { overlayMode: 'active' }, '')).toBe('base-pl');
  });

  it('overlayMode specific: resolves the named overlay only, with NO fallback to the base playlist', () => {
    expect(selectSectionPlaylistId(section, { overlayMode: 'specific', overlayId: 'boss' })).toBe('boss-pl');
    expect(selectSectionPlaylistId(section, { overlayMode: 'specific', overlayId: 'unmapped' })).toBeNull();
    expect(selectSectionPlaylistId(section, { overlayMode: 'specific', overlayId: null })).toBeNull();
  });

  it('defaults an unrecognized overlayMode to the active behavior', () => {
    expect(selectSectionPlaylistId(section, { overlayMode: 'bogus' }, 'calm')).toBe('calm-pl');
  });
});

describe('resolvePlaylistRefId', () => {
  const sceneSections = { area: { playlist: 'scene-area' }, combat: { playlist: 'scene-combat', overlays: { boss: { playlist: 'scene-combat-boss' } } } };
  const defaultSections = { area: { playlist: 'default-area' }, combat: { playlist: 'default-combat' } };

  it('direct: returns playlistId as-is', () => {
    expect(resolvePlaylistRefId({ source: 'direct', playlistId: 'pl1' }, {})).toBe('pl1');
    expect(resolvePlaylistRefId({ source: 'direct' }, {})).toBeNull();
  });

  it('scene: reads from sceneSections by section', () => {
    expect(resolvePlaylistRefId({ source: 'scene', section: 'area', overlayMode: 'none' }, { sceneSections, defaultSections })).toBe('scene-area');
    expect(
      resolvePlaylistRefId({ source: 'scene', section: 'combat', overlayMode: 'specific', overlayId: 'boss' }, { sceneSections, defaultSections })
    ).toBe('scene-combat-boss');
  });

  it('scene: picks the active overlay id by the referenced section\'s own axis (area -> mood, combat -> phase)', () => {
    const withOverlays = {
      area: { playlist: 'scene-area', overlays: { calm: { playlist: 'scene-area-calm' } } },
      combat: { playlist: 'scene-combat', overlays: { p2: { playlist: 'scene-combat-p2' } } }
    };
    expect(
      resolvePlaylistRefId(
        { source: 'scene', section: 'area', overlayMode: 'active' },
        { sceneSections: withOverlays, defaultSections, activeOverlayIds: { mood: 'calm', phase: 'p2' } }
      )
    ).toBe('scene-area-calm');
    expect(
      resolvePlaylistRefId(
        { source: 'scene', section: 'combat', overlayMode: 'active' },
        { sceneSections: withOverlays, defaultSections, activeOverlayIds: { mood: 'calm', phase: 'p2' } }
      )
    ).toBe('scene-combat-p2');
  });

  it('default: reads from defaultSections by section', () => {
    expect(resolvePlaylistRefId({ source: 'default', section: 'combat', overlayMode: 'none' }, { sceneSections, defaultSections })).toBe(
      'default-combat'
    );
  });

  it('returns null when the referenced section is missing entirely', () => {
    expect(resolvePlaylistRefId({ source: 'scene', section: 'area', overlayMode: 'none' }, {})).toBeNull();
  });
});

describe('describePlaylistRef', () => {
  const localize = (key, data) => (data ? `${key}(${JSON.stringify(data)})` : key);

  it('direct with no target: missing-playlist message', () => {
    expect(describePlaylistRef({ source: 'direct', playlistId: null }, { localize })).toBe('GameOrchestra.CustomEditor.Ref.MissingPlaylist');
  });

  it('direct with an unresolvable id: missing-playlist message, not the raw id', () => {
    const result = describePlaylistRef({ source: 'direct', playlistId: 'gone' }, { localize, playlistName: () => null });
    expect(result).toBe('GameOrchestra.CustomEditor.Ref.MissingPlaylist');
    expect(result).not.toContain('gone');
  });

  it('direct with a resolvable id: the playlist name', () => {
    const result = describePlaylistRef({ source: 'direct', playlistId: 'pl1' }, { localize, playlistName: (id) => (id === 'pl1' ? 'Tavern Theme' : null) });
    expect(result).toBe('Tavern Theme');
  });

  it('indirect, overlayMode none: source + section only', () => {
    const result = describePlaylistRef({ source: 'scene', section: 'area', overlayMode: 'none' }, { localize });
    expect(result).toContain('GameOrchestra.CustomEditor.Ref.SceneSection');
    expect(result).not.toContain('Active');
  });

  it('indirect, overlayMode active: appends the active-overlay label', () => {
    const result = describePlaylistRef({ source: 'default', section: 'combat', overlayMode: 'active' }, { localize });
    expect(result).toContain('GameOrchestra.CustomEditor.Ref.DefaultSection');
    expect(result).toContain('GameOrchestra.CustomEditor.Inspector.PlaylistOverlayMode.Active');
  });

  it('indirect, overlayMode specific with a resolvable overlay: the overlay label', () => {
    const result = describePlaylistRef(
      { source: 'scene', section: 'combat', overlayMode: 'specific', overlayId: 'boss' },
      { localize, overlayLabel: (id) => (id === 'boss' ? 'Boss Fight' : null) }
    );
    expect(result).toContain('Boss Fight');
  });

  it('indirect, overlayMode specific with no resolvable overlay label: falls back to the raw id', () => {
    const result = describePlaylistRef({ source: 'scene', section: 'area', overlayMode: 'specific', overlayId: 'ghost-mood' }, { localize });
    expect(result).toContain('ghost-mood');
  });
});
