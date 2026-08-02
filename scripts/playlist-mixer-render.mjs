/**
 * Builds the Playlist Mixer's body as an HTML string, from plain data - no DOM, no Foundry.
 * Same pure-builder pattern as custom-playlist-inspector.mjs, and
 * for the same reason: it is unit-testable without a browser.
 *
 * Unlike those two, this one is NOT dodging a re-render hazard - HR-A is a Drawflow constraint
 * and PlaylistMixerApp has no canvas. It is a plain string builder that the app hands to
 * ApplicationV2's own render cycle.
 *
 * Volume percentages arrive already computed by the caller. The slider position and the volume
 * are not the same number (Foundry applies a 1.5-order curve, AudioHelper#inputToVolume), and
 * this module deliberately does not know that curve: the caller uses AudioHelper itself, so the
 * mixer's "50%" is by construction the same sound as the sidebar's "50%" even if core ever
 * changes the exponent.
 */

import { escapeHtml } from './custom-playlist-node-render.mjs';

/**
 * @typedef {object} MixerTrackRow
 * @property {string} id
 * @property {string} uuid            Foundry document uuid - the drag payload, when graphTools.
 * @property {string} name
 * @property {number} sliderValue       Slider position in [0, 1] (curve already applied).
 * @property {number} percent           Displayed percentage of the stored volume.
 * @property {number} effectivePercent  Displayed percentage once gain + clamp apply.
 * @property {boolean} muted
 * @property {boolean} solo
 * @property {boolean} clamped          True when the ceiling is what is holding this row down -
 *   worth marking, because the row's own slider then does nothing audible above that point.
 * @property {number|null} fade         Per-track fade in ms, or null to inherit.
 * @property {number|null} usedBy       Track-node references (custom-graph playlists), else null.
 * @property {number|null} order        1-based playback position (sequential playlists), else null.
 */

/**
 * @param {object} params
 * @param {MixerTrackRow[]} params.tracks
 * @param {object} params.header
 * @param {number} params.header.gainSlider      Master gain slider position in [0, 1].
 * @param {number} params.header.gainPercent
 * @param {number} params.header.ceilingSlider
 * @param {number} params.header.ceilingPercent
 * @param {number|null} params.header.crossfadeMs   The override, or null when inheriting.
 * @param {number} params.header.worldCrossfadeMs   Shown as the inherited value.
 * @param {number|null} params.header.playlistFade  Playlist-level fade in ms, or null.
 * @param {boolean} params.header.fadeBreaksSeam    True for a custom-graph playlist with a
 *   non-zero effective fade - renders the warning the engine would otherwise only log after the
 *   fact (custom-playback-engine.mjs#_warnIfFadeBreaksTheSeam).
 * @param {string[]} [params.selection]  Selected sound ids. A non-empty selection retargets the
 *   header controls at those rows, which is the whole bulk-edit mechanism - there is no separate
 *   bulk mode to find.
 * @param {boolean} [params.graphTools]  Graph-editor extras on every row: it becomes a drag
 *   source for the canvas, gains an add-node button, and keeps its Track-node usage count even in
 *   the compact layout. This is what makes one pane both the track list and the mixer - the two
 *   answer questions about the same rows ("which of these haven't I placed?", "why is this one so
 *   loud?") and splitting them meant switching panes to compare.
 * @param {boolean} [params.compact]  Narrow layout for the graph editor's 300px panel: the fade
 *   and node/order columns are dropped from the rows, and the crossfade/fade number fields from
 *   the header. Everything dropped is still reachable in the standalone window, which the pane
 *   links to - the alternative was a horizontal scrollbar inside an accordion pane, or columns
 *   crushed to unreadable widths.
 * @param {(key: string, data?: object) => string} params.localize
 * @returns {string} HTML for the mixer body.
 */
export function buildMixerHtml({ tracks, header, selection = [], compact = false, graphTools = false, localize }) {
  const loc = localize || ((k) => k);
  const selected = new Set(selection);
  const scoped = selected.size > 0;

  if (!tracks?.length) {
    return `
      ${buildHeaderHtml({ header, scopedCount: 0, compact, loc })}
      <p class="hint game-orchestra-mixer-empty">${escapeHtml(loc('GameOrchestra.Mixer.NoTracks'))}</p>
    `;
  }

  // Any solo at all mutes everything unselected - so the rows that are NOT soloed are the ones
  // that need marking, otherwise a soloing GM sees a mixer that disagrees with what they hear.
  const soloActive = tracks.some((track) => track.solo);
  // The effective column only exists on rows where the mix moves the number, so its heading has
  // to come and go with it or it would label an empty gap.
  const anyEffective = tracks.some((track) => track.effectivePercent !== track.percent);
  // A graph playlist's last column counts Track nodes; a native one numbers playback order.
  const anyUsage = tracks.some((track) => track.usedBy !== null && track.usedBy !== undefined);

  const rows = tracks.map((track) => buildRowHtml({ track, selected: selected.has(track.id), soloActive, compact, graphTools, loc })).join('');

  const unplaced = tracks.filter((track) => track.usedBy === 0).length;
  const footerCount = scoped
    ? loc('GameOrchestra.Mixer.SelectedCount', { count: selected.size })
    : loc('GameOrchestra.Mixer.TrackCount', { count: tracks.length });
  const unplacedNote = unplaced > 0 ? ` · ${escapeHtml(loc('GameOrchestra.Mixer.UnplacedCount', { count: unplaced }))}` : '';

  // Which column is which is not guessable from the values alone: two percentages side by side
  // and a bare "250" read as arbitrary numbers until they are named. The header carries the same
  // column classes as a row so the two stay aligned from one set of widths.
  const columnHeader = `
    <div class="game-orchestra-mixer-row game-orchestra-mixer-column-header" aria-hidden="true">
      <span class="game-orchestra-mixer-col-toggles" title="${escapeHtml(loc('GameOrchestra.Mixer.Column.TogglesHint'))}">${escapeHtml(loc('GameOrchestra.Mixer.Column.Toggles'))}</span>
      <span class="game-orchestra-mixer-name">${escapeHtml(loc('GameOrchestra.Mixer.Column.Track'))}</span>
      <span class="game-orchestra-mixer-col-volume">${escapeHtml(loc('GameOrchestra.Mixer.Column.Volume'))}</span>
      <span class="game-orchestra-mixer-readout"></span>
      ${anyEffective ? `<span class="game-orchestra-mixer-effective" title="${escapeHtml(loc('GameOrchestra.Mixer.EffectiveHint'))}">${escapeHtml(loc('GameOrchestra.Mixer.Column.Effective'))}</span>` : ''}
      ${compact ? '' : `<span class="game-orchestra-mixer-col-fade">${escapeHtml(loc('GameOrchestra.Mixer.Column.Fade'))}</span>`}
      ${
        compact && !graphTools
          ? ''
          : `<span class="game-orchestra-mixer-col-badge" title="${escapeHtml(loc(anyUsage ? 'GameOrchestra.Mixer.Column.UsedByHint' : 'GameOrchestra.Mixer.Column.OrderHint'))}">${escapeHtml(loc(anyUsage ? 'GameOrchestra.Mixer.Column.UsedBy' : 'GameOrchestra.Mixer.Column.Order'))}</span>`
      }
      ${graphTools ? `<span class="game-orchestra-mixer-col-add"></span>` : ''}
    </div>
  `;

  return `
    ${buildHeaderHtml({ header, scopedCount: selected.size, compact, loc })}
    ${columnHeader}
    <ol class="game-orchestra-mixer-rows" role="listbox" aria-multiselectable="true"
        aria-label="${escapeHtml(loc('GameOrchestra.Mixer.RowsLabel'))}">${rows}</ol>
    <footer class="game-orchestra-mixer-footer">
      <span class="game-orchestra-mixer-count">${escapeHtml(footerCount)}${unplacedNote}</span>
      <span class="game-orchestra-mixer-footer-buttons">
        <button type="button" data-action="bakeMix" title="${escapeHtml(loc('GameOrchestra.Mixer.BakeHint'))}">${escapeHtml(loc('GameOrchestra.Mixer.Bake'))}</button>
        <button type="button" data-action="resetMix">${escapeHtml(loc('GameOrchestra.Mixer.Reset'))}</button>
      </span>
    </footer>
  `;
}

/**
 * The playlist-wide strip. Its controls retarget the current selection when there is one, which
 * is why the whole block gets a `data-scope` and a different title rather than a second set of
 * controls appearing somewhere else.
 * @param {object} params
 * @param {object} params.header
 * @param {number} params.scopedCount - Selected row count; 0 means the controls address the playlist.
 * @param {boolean} [params.compact] - Drop the number fields, which need two labelled columns.
 * @param {(key: string, data?: object) => string} params.loc
 * @returns {string}
 */
function buildHeaderHtml({ header, scopedCount, compact = false, loc }) {
  const scoped = scopedCount > 0;
  const title = scoped ? loc('GameOrchestra.Mixer.ScopeSelection', { count: scopedCount }) : loc('GameOrchestra.Mixer.ScopePlaylist');
  const gainLabel = scoped ? loc('GameOrchestra.Mixer.GroupVolume') : loc('GameOrchestra.Mixer.Gain');
  const gainHint = scoped ? loc('GameOrchestra.Mixer.GroupVolumeHint') : loc('GameOrchestra.Mixer.GainHint');

  const crossfadeValue = header.crossfadeMs === null || header.crossfadeMs === undefined ? '' : String(header.crossfadeMs);
  const fadeValue = header.playlistFade === null || header.playlistFade === undefined ? '' : String(header.playlistFade);

  // The full explanation is four lines at 300px - a third of the editor pane, for a field that
  // pane does not even show. The short form says the same thing actionably; the long one is one
  // click away in the standalone window, where there is room for it.
  const seamWarning = header.fadeBreaksSeam
    ? `<p class="notification warning game-orchestra-mixer-seam-warning">${escapeHtml(loc(compact ? 'GameOrchestra.Mixer.FadeBreaksSeamShort' : 'GameOrchestra.Mixer.FadeBreaksSeam'))}</p>`
    : '';

  return `
    <header class="game-orchestra-mixer-header" data-scope="${scoped ? 'selection' : 'playlist'}">
      <div class="game-orchestra-mixer-scope">
        ${escapeHtml(title)}
        ${
          // Compact drops whole columns, so it owes the reader a route to the full set. The
          // action is deliberately NOT one MixerController handles - it falls through to the
          // host application's own dispatcher, which is what knows how to open a window.
          compact
            ? `<button type="button" class="game-orchestra-mixer-expand" data-action="openMixer"
                       title="${escapeHtml(loc('GameOrchestra.Mixer.OpenButton'))}"><i class="fas fa-up-right-and-down-left-from-center"></i></button>`
            : ''
        }
      </div>

      <div class="game-orchestra-mixer-slider-group">
        <label for="game-orchestra-mixer-gain">${escapeHtml(gainLabel)}</label>
        <input type="range" id="game-orchestra-mixer-gain" min="0" max="1" step="0.01"
               value="${header.gainSlider}" data-mix-action="gain"
               aria-valuetext="${escapeHtml(loc('GameOrchestra.Mixer.VolumeValue', { percent: header.gainPercent }))}">
        <output class="game-orchestra-mixer-readout">${header.gainPercent}%</output>
      </div>
      <p class="hint">${escapeHtml(gainHint)}</p>

      <div class="game-orchestra-mixer-slider-group">
        <label for="game-orchestra-mixer-ceiling">${escapeHtml(loc('GameOrchestra.Mixer.Ceiling'))}</label>
        <input type="range" id="game-orchestra-mixer-ceiling" min="0" max="1" step="0.01"
               value="${header.ceilingSlider}" data-mix-action="ceiling"
               aria-valuetext="${escapeHtml(loc('GameOrchestra.Mixer.VolumeValue', { percent: header.ceilingPercent }))}">
        <output class="game-orchestra-mixer-readout">${header.ceilingPercent}%</output>
      </div>
      <p class="hint">${escapeHtml(loc('GameOrchestra.Mixer.CeilingHint'))}</p>

      ${compact ? '' : `<div class="game-orchestra-mixer-number-row">
        <div class="form-group">
          <label for="game-orchestra-mixer-crossfade">${escapeHtml(loc('GameOrchestra.Mixer.Crossfade'))}</label>
          <input type="number" id="game-orchestra-mixer-crossfade" min="0" max="1000" step="25"
                 value="${escapeHtml(crossfadeValue)}" data-mix-action="crossfade"
                 placeholder="${escapeHtml(loc('GameOrchestra.Mixer.CrossfadeInherit', { ms: header.worldCrossfadeMs }))}">
        </div>
        <div class="form-group">
          <label for="game-orchestra-mixer-fade">${escapeHtml(scoped ? loc('GameOrchestra.Mixer.TrackFade') : loc('GameOrchestra.Mixer.PlaylistFade'))}</label>
          <input type="number" id="game-orchestra-mixer-fade" min="0" step="50"
                 value="${escapeHtml(scoped ? '' : fadeValue)}" data-mix-action="fade"
                 placeholder="${escapeHtml(loc(scoped ? 'GameOrchestra.Mixer.FadeMixed' : 'GameOrchestra.Mixer.FadeNone'))}">
        </div>
      </div>`}
      ${seamWarning}
    </header>
  `;
}

/**
 * One track row.
 * @param {object} params
 * @param {MixerTrackRow} params.track
 * @param {boolean} params.selected
 * @param {boolean} params.soloActive - Whether any row in the playlist is soloed.
 * @param {boolean} [params.compact] - Drop the fade and node/order columns.
 * @param {boolean} [params.graphTools] - Make the row a canvas drag source with an add button.
 * @param {(key: string, data?: object) => string} params.loc
 * @returns {string}
 */
function buildRowHtml({ track, selected, soloActive, compact = false, graphTools = false, loc }) {
  // A row is silent for either of two independent reasons, and the GM needs to be able to tell
  // them apart: it is muted, or something else is soloed. Same visual weight, different tooltip.
  const silencedBySolo = soloActive && !track.solo && !track.muted;
  const classes = ['game-orchestra-mixer-row'];
  if (selected) classes.push('game-orchestra-mixer-selected');
  if (track.muted) classes.push('game-orchestra-mixer-muted');
  if (silencedBySolo) classes.push('game-orchestra-mixer-silenced');

  // Shown only when gain or clamp actually move the number - an unchanged "50% -> 50%" is noise
  // on every row of an untouched playlist.
  const effective =
    track.effectivePercent !== track.percent
      ? `<span class="game-orchestra-mixer-effective${track.clamped ? ' game-orchestra-mixer-clamped' : ''}"
               title="${escapeHtml(loc(track.clamped ? 'GameOrchestra.Mixer.ClampedHint' : 'GameOrchestra.Mixer.EffectiveHint'))}">
           → ${track.effectivePercent}%${track.clamped ? ' <i class="fas fa-exclamation-triangle"></i>' : ''}
         </span>`
      : '';

  const badge =
    track.usedBy !== null && track.usedBy !== undefined
      ? `<span class="game-orchestra-mixer-usedby${track.usedBy === 0 ? ' game-orchestra-mixer-unplaced' : ''}"
               data-action="focusNode" data-sound-id="${escapeHtml(track.id)}"
               title="${escapeHtml(loc(track.usedBy === 0 ? 'GameOrchestra.Mixer.Unplaced' : 'GameOrchestra.Mixer.UsedBy', { count: track.usedBy }))}"
          >${track.usedBy === 0 ? '—' : `×${track.usedBy}`}</span>`
      : `<span class="game-orchestra-mixer-order">${track.order === null || track.order === undefined ? '' : track.order}</span>`;

  const fadeValue = track.fade === null || track.fade === undefined ? '' : String(track.fade);

  // The drag payload is identical to what the sidebar produces for the same sound, so
  // graph-drop.mjs handles an internal drag and an external one through one code path.
  const dragAttrs = graphTools ? ` draggable="true" data-vg-drag data-drag-type="PlaylistSound" data-uuid="${escapeHtml(track.uuid ?? '')}"` : '';

  return `
    <li class="${classes.join(' ')}" data-sound-id="${escapeHtml(track.id)}" role="option"
        aria-selected="${selected ? 'true' : 'false'}" tabindex="-1"${dragAttrs}>
      <button type="button" class="game-orchestra-mixer-toggle game-orchestra-mixer-mute${track.muted ? ' game-orchestra-mixer-on' : ''}"
              data-action="toggleMute" data-sound-id="${escapeHtml(track.id)}"
              aria-pressed="${track.muted ? 'true' : 'false'}"
              title="${escapeHtml(loc('GameOrchestra.Mixer.Mute'))}">M</button>
      <button type="button" class="game-orchestra-mixer-toggle game-orchestra-mixer-solo${track.solo ? ' game-orchestra-mixer-on' : ''}"
              data-action="toggleSolo" data-sound-id="${escapeHtml(track.id)}"
              aria-pressed="${track.solo ? 'true' : 'false'}"
              title="${escapeHtml(loc('GameOrchestra.Mixer.Solo'))}">S</button>
      <span class="game-orchestra-mixer-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</span>
      <input type="range" class="game-orchestra-mixer-volume" min="0" max="1" step="0.01"
             value="${track.sliderValue}" data-mix-action="trackVolume" data-sound-id="${escapeHtml(track.id)}"
             aria-label="${escapeHtml(track.name)}"
             aria-valuetext="${escapeHtml(loc('GameOrchestra.Mixer.VolumeValue', { percent: track.percent }))}">
      <span class="game-orchestra-mixer-readout">${track.percent}%</span>
      ${effective}
      ${
        compact
          ? ''
          : `<input type="number" class="game-orchestra-mixer-fade" min="0" step="50" value="${escapeHtml(fadeValue)}"
             data-mix-action="trackFade" data-sound-id="${escapeHtml(track.id)}"
             placeholder="—" title="${escapeHtml(loc('GameOrchestra.Mixer.TrackFadeHint'))}">`
      }
      ${compact && !graphTools ? '' : badge}
      ${
        graphTools
          ? `<button type="button" class="clear-btn game-orchestra-mixer-add" data-action="addTrackNode"
                     data-sound-id="${escapeHtml(track.id)}"
                     title="${escapeHtml(loc('GameOrchestra.CustomEditor.Tracks.AddNode'))}"><i class="fas fa-plus"></i></button>`
          : ''
      }
    </li>
  `;
}
