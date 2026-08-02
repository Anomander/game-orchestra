import { describe, it, expect } from 'vitest';
import { buildMixerHtml } from '../scripts/playlist-mixer-render.mjs';

// Deliberately quote-free: every string this builder emits goes through escapeHtml(), so a
// JSON-shaped stub would come back as &quot; and every assertion would be about the escaping
// rather than about the markup.
const loc = (key, data) => (data ? `${key}(${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(',')})` : key);

const header = {
  gainSlider: '1.00',
  gainPercent: 100,
  ceilingSlider: '1.00',
  ceilingPercent: 100,
  crossfadeMs: null,
  worldCrossfadeMs: 0,
  playlistFade: null,
  fadeBreaksSeam: false
};

const track = (overrides = {}) => ({
  id: 's1',
  name: 'Cave Drips',
  sliderValue: '0.63',
  percent: 63,
  effectivePercent: 63,
  muted: false,
  solo: false,
  clamped: false,
  fade: null,
  usedBy: null,
  order: null,
  ...overrides
});

const build = (params) => buildMixerHtml({ header, localize: loc, ...params });

describe('buildMixerHtml', () => {
  it('renders one row per track, carrying the sound id', () => {
    const html = build({ tracks: [track(), track({ id: 's2', name: 'Water Rush' })] });
    expect((html.match(/game-orchestra-mixer-row/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-sound-id="s1"');
    expect(html).toContain('data-sound-id="s2"');
  });

  describe('the column header', () => {
    it('names every column, so two side-by-side percentages and a bare number are not a guess', () => {
      const html = build({ tracks: [track({ percent: 63, effectivePercent: 48, usedBy: 1 })] });
      expect(html).toContain('game-orchestra-mixer-column-header');
      expect(html).toContain('GameOrchestra.Mixer.Column.Track');
      expect(html).toContain('GameOrchestra.Mixer.Column.Volume');
      expect(html).toContain('GameOrchestra.Mixer.Column.Fade');
    });

    it('labels the last column for what it actually holds', () => {
      expect(build({ tracks: [track({ usedBy: 1 })] })).toContain('GameOrchestra.Mixer.Column.UsedBy');
      expect(build({ tracks: [track({ usedBy: null, order: 1 })] })).toContain('GameOrchestra.Mixer.Column.Order');
    });

    it('drops the effective heading when no row has that column - it would label an empty gap', () => {
      expect(build({ tracks: [track({ percent: 50, effectivePercent: 50 })] })).not.toContain('GameOrchestra.Mixer.Column.Effective');
      expect(build({ tracks: [track({ percent: 50, effectivePercent: 40 })] })).toContain('GameOrchestra.Mixer.Column.Effective');
    });

    it('is not announced as a row - it is a heading, and the rows are the listbox options', () => {
      const html = build({ tracks: [track()] });
      const headerChunk = html.split('game-orchestra-mixer-rows')[0];
      expect(headerChunk).toContain('aria-hidden="true"');
    });
  });

  it('shows the empty hint but still renders the header, so a playlist with no tracks is not a dead window', () => {
    const html = build({ tracks: [] });
    expect(html).toContain('GameOrchestra.Mixer.NoTracks');
    expect(html).toContain('game-orchestra-mixer-header');
  });

  it('escapes sound names', () => {
    const html = build({ tracks: [track({ name: '<img src=x onerror=alert(1)>' })] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  describe('the effective readout', () => {
    it('is absent when the mix changes nothing - an unchanged "50% -> 50%" is noise on every row', () => {
      const html = build({ tracks: [track({ percent: 50, effectivePercent: 50 })] });
      expect(html).not.toContain('game-orchestra-mixer-effective');
    });

    it('appears as soon as the stored and effective values differ', () => {
      const html = build({ tracks: [track({ percent: 63, effectivePercent: 48 })] });
      expect(html).toContain('game-orchestra-mixer-effective');
      expect(html).toContain('48%');
    });

    it('marks a row the ceiling is holding down, so its own slider is not silently inert', () => {
      const html = build({ tracks: [track({ percent: 100, effectivePercent: 85, clamped: true })] });
      expect(html).toContain('game-orchestra-mixer-clamped');
      expect(html).toContain('GameOrchestra.Mixer.ClampedHint');
    });
  });

  describe('mute and solo', () => {
    it('renders both toggles per row with their pressed state', () => {
      const html = build({ tracks: [track({ muted: true })] });
      expect(html).toContain('data-action="toggleMute"');
      expect(html).toContain('data-action="toggleSolo"');
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain('game-orchestra-mixer-muted');
    });

    it('marks the rows a solo elsewhere is silencing, not just the soloed one', () => {
      // Otherwise a soloing GM sees a mixer that disagrees with what they hear.
      const html = build({ tracks: [track({ id: 's1', solo: true }), track({ id: 's2', name: 'Other' })] });
      const rows = html.split('<li').filter((chunk) => chunk.includes('game-orchestra-mixer-row'));
      expect(rows.find((r) => r.includes('data-sound-id="s2"'))).toContain('game-orchestra-mixer-silenced');
      expect(rows.find((r) => r.includes('data-sound-id="s1"'))).not.toContain('game-orchestra-mixer-silenced');
    });

    it('silences nothing when no row is soloed', () => {
      const html = build({ tracks: [track(), track({ id: 's2' })] });
      expect(html).not.toContain('game-orchestra-mixer-silenced');
    });

    it('does not mark a muted row as solo-silenced as well - one row, one reason', () => {
      const html = build({ tracks: [track({ id: 's1', solo: true }), track({ id: 's2', muted: true })] });
      const row = html.split('<li').find((chunk) => chunk.includes('data-sound-id="s2"'));
      expect(row).toContain('game-orchestra-mixer-muted');
      expect(row).not.toContain('game-orchestra-mixer-silenced');
    });
  });

  describe('the header retargets the selection', () => {
    it('addresses the playlist when nothing is selected', () => {
      const html = build({ tracks: [track()] });
      expect(html).toContain('data-scope="playlist"');
      expect(html).toContain('GameOrchestra.Mixer.Gain');
      expect(html).toContain('GameOrchestra.Mixer.PlaylistFade');
    });

    it('addresses the selected rows when there is one - the same controls, a different scope', () => {
      const html = build({ tracks: [track(), track({ id: 's2' })], selection: ['s1', 's2'] });
      expect(html).toContain('data-scope="selection"');
      expect(html).toContain('GameOrchestra.Mixer.GroupVolume');
      expect(html).toContain('GameOrchestra.Mixer.TrackFade');
      expect(html).toContain('GameOrchestra.Mixer.ScopeSelection(count=2)');
    });

    it('marks the selected rows and only those', () => {
      const html = build({ tracks: [track(), track({ id: 's2' })], selection: ['s2'] });
      const rows = html.split('<li').filter((chunk) => chunk.includes('game-orchestra-mixer-row'));
      expect(rows.find((r) => r.includes('data-sound-id="s2"'))).toContain('game-orchestra-mixer-selected');
      expect(rows.find((r) => r.includes('data-sound-id="s1"'))).not.toContain('game-orchestra-mixer-selected');
    });

    it('leaves the group fade field blank rather than claiming the selection shares one value', () => {
      const html = build({ tracks: [track({ fade: 250 })], selection: ['s1'], header: { ...header, playlistFade: 500 } });
      expect(html).toContain('GameOrchestra.Mixer.FadeMixed');
    });
  });

  describe('the crossfade field', () => {
    it('is blank with the inherited value as its placeholder when there is no override', () => {
      const html = build({ tracks: [track()], header: { ...header, worldCrossfadeMs: 150 } });
      expect(html).toContain('GameOrchestra.Mixer.CrossfadeInherit(ms=150)');
      expect(html).toMatch(/id="game-orchestra-mixer-crossfade"[^>]*value=""/);
    });

    it('renders an explicit 0 as a value, not as blank', () => {
      // 0 means "never crossfade this playlist" - showing it as blank would read as inheriting.
      const html = build({ tracks: [track()], header: { ...header, crossfadeMs: 0 } });
      expect(html).toMatch(/id="game-orchestra-mixer-crossfade"[^>]*value="0"/);
    });
  });

  describe('the seam warning', () => {
    it('is absent by default', () => {
      expect(build({ tracks: [track()] })).not.toContain('GameOrchestra.Mixer.FadeBreaksSeam');
    });

    it('appears for a graph playlist with a fade, where the engine would otherwise only log it afterwards', () => {
      const html = build({ tracks: [track()], header: { ...header, playlistFade: 500, fadeBreaksSeam: true } });
      expect(html).toContain('GameOrchestra.Mixer.FadeBreaksSeam');
    });
  });

  describe('the type-specific column', () => {
    it('shows a graph playlist\'s Track-node usage count', () => {
      const html = build({ tracks: [track({ usedBy: 2 })] });
      expect(html).toContain('×2');
      expect(html).toContain('data-action="focusNode"');
    });

    it('marks a sound no Track node plays, which is the question this column exists to answer', () => {
      const html = build({ tracks: [track({ usedBy: 0 })] });
      expect(html).toContain('game-orchestra-mixer-unplaced');
      expect(html).toContain('GameOrchestra.Mixer.UnplacedCount(count=1)');
    });

    it('shows a playback position instead for a native playlist, and no usage badge at all', () => {
      const html = build({ tracks: [track({ usedBy: null, order: 3 })] });
      expect(html).toContain('game-orchestra-mixer-order');
      expect(html).not.toContain('game-orchestra-mixer-usedby');
      expect(html).not.toContain('GameOrchestra.Mixer.UnplacedCount');
    });
  });

  it('counts tracks in the footer, and switches to the selection count when there is one', () => {
    expect(build({ tracks: [track(), track({ id: 's2' })] })).toContain('GameOrchestra.Mixer.TrackCount(count=2)');
    expect(build({ tracks: [track(), track({ id: 's2' })], selection: ['s1'] })).toContain('GameOrchestra.Mixer.SelectedCount(count=1)');
  });
});
