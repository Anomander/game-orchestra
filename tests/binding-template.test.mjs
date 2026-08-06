import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const treeSource = read('templates/playlist-tree.hbs');
const configSource = read('templates/music-config.hbs');
const treeScript = read('scripts/playlist-tree.mjs');

/**
 * Structural guards for the two J1 (Bind) templates - docs/wiki/ux.md.
 *
 * These exist because the binding markup is being consolidated onto a shared
 * shape, and neither template has any other test coverage: the app tests drive
 * handlers directly and never render Handlebars. A refactor that silently
 * dropped a `data-change-action`, a `data-context-type`, or an overlay id
 * would produce a control that renders perfectly and does nothing - the exact
 * class of failure this codebase's comments keep warning about.
 */
describe('binding template structural invariants', () => {
  /**
   * Every context box in the tree, as its full opening tag. The trailing space in
   * `context-box ` is load-bearing: it excludes the `context-boxes` flex wrapper
   * and the `context-box-header`/`-body` children, which are not boxes.
   */
  const treeBoxes = [...treeSource.matchAll(/<div class="context-box [^"]*"[^>]*>/g)].map((m) => m[0]);

  describe('playlist-tree.hbs', () => {
    it('has a context box for every scope/section pair the window edits', () => {
      // scene mood(area), scene phase(combat), scene default area+combat,
      // global mood(area), global phase(combat), global default area+combat
      expect(treeBoxes).toHaveLength(8);
    });

    it('every context box declares its section, so _handleEntryAction can read it', () => {
      // contextType defaults to 'area' when absent, which would silently write
      // combat bindings into the area section.
      for (const box of treeBoxes) expect(box).toMatch(/data-context-type="(area|combat)"/);
    });

    it('every context box is a drop target with a scope', () => {
      for (const box of treeBoxes) expect(box).toMatch(/data-drop-scope="(scene|global)"/);
    });

    it('every playlist select carries the overlay id its own axis uses', () => {
      // An overlay-scoped select without its id writes to the section default
      // instead - the binding lands, on the wrong row.
      const overlaySelects = [...treeSource.matchAll(/<select class="playlist-select"[^>]*data-change-action="update\w*Overlay"[^>]*>/g)];
      expect(overlaySelects.length).toBeGreaterThan(0);
      for (const [tag] of overlaySelects) expect(tag).toMatch(/data-(mood|phase)-id="/);
    });

    it('offers the layer controls on every OVERLAY box, and on no section-default box', () => {
      // A section default is what a layer plays *over* - the pair would be inert there
      // (architecture.md § Layers). Four overlay boxes: scene mood, scene phase, global mood,
      // global phase.
      const layerInputs = [...treeSource.matchAll(/class="layer-input"/g)];
      const duckInputs = [...treeSource.matchAll(/class="duck-input"/g)];
      expect(layerInputs).toHaveLength(4);
      expect(duckInputs).toHaveLength(4);
    });

    it('keeps every layer control folded behind an Advanced disclosure', () => {
      // Layering is a deliberate, occasional choice, not part of the everyday "what plays here"
      // job. It replaced priority in this slot - see docs/wiki/ux.md D8 for why the number was
      // the wrong interface even when it was the only thing in here.
      const disclosures = [...treeSource.matchAll(/<details class="advanced-disclosure"/g)];
      expect(disclosures).toHaveLength(4);
      const outside = treeSource.split('<details class="advanced-disclosure"')[0];
      expect(outside).not.toContain('layer-input');
      expect(outside).not.toContain('duck-input');
    });

    it('every layer control dispatches to a real registered change action', () => {
      const declared = new Set([...treeScript.matchAll(/^\s{4}(\w+): '(\w+)',?$/gm)].map((m) => m[1]));
      const used = [...treeSource.matchAll(/class="(?:layer|duck)-input"[^>]*?data-change-action="(\w+)"/gs)].map((m) => m[1]);
      expect(used).toHaveLength(8);
      for (const action of used) expect(declared, `'${action}' is not in _CHANGE_ACTIONS`).toContain(action);
    });

    it('every layer control carries the same dataset its box dispatches with', () => {
      // The handler resolves the element via closest(), so an input missing
      // data-context-type would fall back to 'area' regardless of its box, and one missing its
      // overlay id would write to the section default instead.
      const inputs = [...treeSource.matchAll(/<input[^>]*class="(?:layer|duck)-input"[^>]*?>/gs)].map((m) => m[0]);
      expect(inputs).toHaveLength(8);
      for (const input of inputs) {
        expect(input).toMatch(/data-context-type="(area|combat)"/);
        expect(input).toMatch(/data-(mood|phase)-id="/);
      }
    });

    it('every Advanced disclosure declares a key and renders its own open state', () => {
      // A native <details> keeps `open` in the DOM alone, and every control inside it writes -
      // which re-renders the part and replaces the element. Without the key the toggle is never
      // recorded; without the `open` binding it is never restored, and the block shuts itself on
      // every click. Confirmed live with the layer checkbox. See app-mixins.mjs#openDisclosures.
      const disclosures = [...treeSource.matchAll(/<details class="advanced-disclosure"[^>]*>/g)].map((m) => m[0]);
      expect(disclosures).toHaveLength(4);
      for (const tag of disclosures) {
        expect(tag).toMatch(/data-disclosure-key="\{\{[\w.]+\}\}"/);
        expect(tag).toMatch(/\{\{#if [\w.]+\}\}open\{\{\/if\}\}/);
      }
    });

    it('hides the duck slider unless the row is actually layering', () => {
      // Ducking only means anything while something else still plays underneath, which is
      // exactly what a replacing overlay turns off - the same rule the token grid follows.
      const guards = [...treeSource.matchAll(/\{\{#if [\w.]+\.isLayer\}\}/g)];
      expect(guards).toHaveLength(4);
    });

    it('says when a layer row is the one currently playing', () => {
      // UX-7. A layering row never wins the base resolution, so `is-resolving` can never light
      // up for it and it would otherwise be the one binding the window says nothing about.
      const notes = [...treeSource.matchAll(/class="layering-now"/g)];
      expect(notes).toHaveLength(4);
      const guards = [...treeSource.matchAll(/\{\{#if [\w.]+\.isLayerActive\}\}/g)];
      expect(guards).toHaveLength(4);
    });

    it('offers a beaten-by line for every context box', () => {
      // UX-7 proper: the resolution, not an input to it.
      const notes = [...treeSource.matchAll(/class="beaten-by"/g)];
      expect(notes).toHaveLength(treeBoxes.length);
    });

    it('shows the beaten-by line only when the row actually lost', () => {
      const guards = [...treeSource.matchAll(/\{\{#if [\w.]+\.beatenBy\}\}/g)];
      expect(guards).toHaveLength(treeBoxes.length);
    });

  });

  describe('music-config.hbs', () => {
    it('keeps exclusive and duck at section level, never under a phase overlay', () => {
      // architecture.md § Layers: one flag governs whichever playlist the combat
      // section resolves to, for any phase. A per-phase control here would read
      // as configurable per phase while writing one shared value.
      const exclusiveBlock = /data-change-action="toggleExclusive"/.exec(configSource);
      const duckBlock = /data-change-action="updateDuck"/.exec(configSource);
      expect(exclusiveBlock).not.toBeNull();
      expect(duckBlock).not.toBeNull();
      // Both live in the token-exclusive-node, outside the phaseCards loop.
      const gridEnd = configSource.indexOf('token-exclusive-node');
      expect(gridEnd).toBeGreaterThan(-1);
      expect(exclusiveBlock.index).toBeGreaterThan(gridEnd);
      expect(duckBlock.index).toBeGreaterThan(gridEnd);
    });

    it('hides the duck slider when exclusive is ticked', () => {
      // Ducking only means anything while something else still plays underneath,
      // which is exactly what exclusive turns off.
      expect(configSource).toMatch(/\{\{#unless combatExclusive\}\}[\s\S]*?updateDuck/);
    });

    it('uses data-collapse-key for collapse state, never data-section', () => {
      // data-section on this template means the MUSIC section ('area'/'combat') and
      // lives on context boxes. When collapse keys shared the attribute,
      // handleToggleSection's closest('[data-section]') could walk out of a card
      // header into a binding box and return 'combat' as a collapse key.
      const toggles = [...configSource.matchAll(/data-action="toggleSection"[^>]*>/g)].map((m) => m[0]);
      expect(toggles.length).toBeGreaterThan(0);
      for (const toggle of toggles) {
        expect(toggle).toMatch(/data-collapse-key="/);
        expect(toggle).not.toMatch(/data-section="/);
      }
    });

    it('keeps data-section on the context boxes, where it names the music section', () => {
      const boxes = [...configSource.matchAll(/<div class="context-box [^"]*"[^>]*>/g)].map((m) => m[0]);
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) expect(box).toMatch(/data-section="(area|combat)"/);
    });

    it('never offers a track selector for a custom (graph) playlist', () => {
      // H2/H1: a stray initialTrack on a graph playlist bypasses the whole graph.
      const trackRows = [...configSource.matchAll(/\{\{#unless [\w.]*isCustom\}\}/g)];
      expect(trackRows.length).toBeGreaterThan(0);
    });
  });

  describe('both templates', () => {
    it('mark soundboard entries as requiring an explicit track', () => {
      // H2: an UNSEQUENCED playlist plays nothing without one.
      for (const source of [treeSource, configSource]) {
        expect(source).toContain('soundboard-required-badge');
      }
    });

    it('never expose a priority field to the user', () => {
      // docs/wiki/ux.md D8. `priority` remains a stored field that resolution honours - what is
      // gone is the expectation that a GM types the number. An absolute value nobody can set
      // correctly without knowing every other value in the world was a second, disagreeing
      // encoding of the hierarchy these windows already display in their own section ordering.
      for (const source of [treeSource, configSource]) {
        expect(source).not.toMatch(/name="music\.[^"]*priority"/);
        expect(source).not.toContain('priority-input');
        expect(source).not.toContain('GameOrchestra.Priority');
      }
    });
  });
});
