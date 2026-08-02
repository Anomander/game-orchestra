import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateSource = fs.readFileSync(path.join(__dirname, '../templates/custom-playlist-editor.hbs'), 'utf8');

describe('custom-playlist-editor.hbs structural invariants', () => {
  it('the Drawflow mount point has no class attribute of its own', () => {
    // Regression guard: Drawflow's click-dispatch logic checks
    // element.classList[0] (the FIRST class only) to decide what was
    // clicked, and calls classList.add("parent-drawflow") on whatever
    // element it's constructed with. If that element already carried one of
    // our own CSS classes, classList[0] would stay ours instead of
    // "parent-drawflow", silently breaking background-drag-to-pan for any
    // click landing directly on it - which only becomes reachable/visible
    // after zooming out, once Drawflow's scaled-down inner canvas no longer
    // covers the whole container. See custom-playlist-editor.mjs's
    // _mountDrawflow() and this template's own comment on this element.
    const mountTagMatch = /<div\s+data-drawflow-mount\s*>/.exec(templateSource);
    expect(mountTagMatch, 'expected a bare <div data-drawflow-mount> with no other attributes').not.toBeNull();
  });

  it('the mount point is queried by data attribute, not a CSS class, elsewhere in the codebase', () => {
    const editorSource = fs.readFileSync(path.join(__dirname, '../scripts/custom-playlist-editor.mjs'), 'utf8');
    expect(editorSource).toContain("querySelector('[data-drawflow-mount]')");
  });

  describe('accordion panel (docs/graph-editor-panel-plan.md)', () => {
    /** Every `data-pane="X"` in source order, as they appear in the markup. */
    function paneOrder() {
      return [...templateSource.matchAll(/data-pane="(\w+)"/g)].map((m) => m[1]);
    }

    it('has exactly the three panes, in the locked order: palette, properties, tracks', () => {
      // Each pane's data-pane appears twice (header button + its own attribute isn't duplicated,
      // but the header button and the <section> both carry it) - dedupe while preserving order.
      const seen = new Set();
      const order = paneOrder().filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
      expect(order).toEqual(['palette', 'properties', 'tracks']);
    });

    it('the properties pane body keeps its historical class, so _renderInspector() still finds it', () => {
      expect(templateSource).toMatch(/class="game-orchestra-pane-body game-orchestra-editor-inspector"/);
    });

    it('the tracks pane has its own innerHTML target, distinct from the inspector', () => {
      expect(templateSource).toMatch(/class="game-orchestra-pane-body game-orchestra-editor-tracks[^"]*"/);
    });

    it('validation has its own pinned region, outside every .game-orchestra-pane', () => {
      const validationMatch = /<div class="game-orchestra-editor-validation">/.exec(templateSource);
      expect(validationMatch).not.toBeNull();
      // Everything between the last </section> and the validation div (i.e. the validation div
      // itself) must not be nested inside an unclosed <section class="game-orchestra-pane" - a crude but
      // effective check: no data-pane="tracks" section is still open at that point, i.e. the
      // pane stack's closing </div> appears before the validation div.
      const paneStackCloseIndex = templateSource.indexOf('</div>', templateSource.indexOf('game-orchestra-pane-stack'));
      expect(paneStackCloseIndex).toBeGreaterThan(-1);
      expect(paneStackCloseIndex).toBeLessThan(validationMatch.index);
    });

    it('the panel (aside) precedes the canvas wrapper in source order - the panel is on the left', () => {
      const panelIndex = templateSource.indexOf('game-orchestra-editor-panel');
      const canvasIndex = templateSource.indexOf('game-orchestra-canvas-wrapper');
      expect(panelIndex).toBeGreaterThan(-1);
      expect(canvasIndex).toBeGreaterThan(-1);
      expect(panelIndex).toBeLessThan(canvasIndex);
    });

    it('starts with exactly one pane expanded - the accordion is single-open, and an all-collapsed start would be a column of bare headers', () => {
      const sections = [...templateSource.matchAll(/<section class="(game-orchestra-pane[^"]*)" data-pane="(\w+)">/g)];
      const expanded = sections.filter(([, classes]) => !classes.includes('game-orchestra-collapsed')).map(([, , id]) => id);
      expect(expanded).toEqual(['properties']);
      // aria-expanded must agree with the class, or a screen reader reads the wrong state
      // until the first toggle rewrites it (_applyPaneCollapsed).
      expect(templateSource).toMatch(/data-pane="properties"\s+aria-expanded="true"/);
      for (const id of ['palette', 'tracks']) {
        expect(templateSource).toMatch(new RegExp(`data-pane="${id}"\\s+aria-expanded="false"`));
      }
    });

    it('the preset select sits at the TOP of the palette pane, above the per-node buttons', () => {
      const presetIndex = templateSource.indexOf('data-change-action="applyPreset"');
      const buttonsIndex = templateSource.indexOf('game-orchestra-palette-list');
      expect(presetIndex).toBeGreaterThan(-1);
      expect(buttonsIndex).toBeGreaterThan(-1);
      // A preset builds a whole working graph in one go - the fastest route out of an empty
      // canvas - whereas the buttons below assemble one node at a time.
      expect(presetIndex).toBeLessThan(buttonsIndex);
    });

    it('every palette button is a plain fa-plus + label button, matching the old top palette strip', () => {
      expect(templateSource).toMatch(/<button type="button" data-action="addNode" data-node-type="\{\{this\.type\}\}"[^>]*>\s*<i class="fas fa-plus"><\/i> \{\{localize this\.label\}\}/);
    });

    it('the tracks pane IS the mixer - one pane doing both jobs, in its compact layout', () => {
      // Populated by CustomPlaylistEditor#_renderTracks() through MixerController, never by
      // Handlebars - the controller refreshes itself, and a this.render() on every mute would
      // detach the live Drawflow canvas (HR-A).
      const paneBody = /class="game-orchestra-pane-body game-orchestra-editor-tracks[^"]*"/.exec(templateSource);
      expect(paneBody).not.toBeNull();
      // The compact class is what drops the columns that cannot fit a 300px panel.
      expect(paneBody[0]).toContain('game-orchestra-mixer-compact');
      // There is no second, separate levels pane to switch to.
      expect(templateSource).not.toContain('data-pane="mixer"');
    });

    it('no longer edits the graph crossfade itself - that moved into the mix', () => {
      // The graph's stored value is still READ as a legacy fallback, just never written here.
      expect(templateSource).not.toContain('game-orchestra-graph-crossfade-input');
      expect(templateSource).not.toContain('updateGraphCrossfade');
    });
  });

  describe('undo/redo toolbar buttons', () => {
    it('both exist in the canvas toolbar, before the zoom controls', () => {
      const toolbarStart = templateSource.indexOf('game-orchestra-canvas-toolbar');
      const undoIndex = templateSource.indexOf('data-action="undo"');
      const redoIndex = templateSource.indexOf('data-action="redo"');
      const zoomIndex = templateSource.indexOf('data-action="zoomIn"');

      expect(undoIndex).toBeGreaterThan(toolbarStart);
      expect(redoIndex).toBeGreaterThan(undoIndex);
      expect(zoomIndex).toBeGreaterThan(redoIndex);
    });

    it('both start disabled - at mount there is nothing to undo, and _updateHistoryButtons() enables them', () => {
      const undoButton = /<button[^>]*data-action="undo"[^>]*>/.exec(templateSource);
      const redoButton = /<button[^>]*data-action="redo"[^>]*>/.exec(templateSource);

      expect(undoButton[0]).toContain('disabled');
      expect(redoButton[0]).toContain('disabled');

      const editorSource = fs.readFileSync(path.join(__dirname, '../scripts/custom-playlist-editor.mjs'), 'utf8');
      expect(editorSource).toContain('[data-action="undo"]');
      expect(editorSource).toContain('[data-action="redo"]');
    });
  });
});
