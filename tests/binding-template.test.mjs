import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

const treeSource = read('templates/playlist-tree.hbs');
const configSource = read('templates/music-config.hbs');
const gridSource = read('templates/parts/combat-grid.hbs');
const toolsSource = read('templates/parts/binding-tools.hbs');
const treeScript = read('scripts/playlist-tree.mjs');
const configScript = read('scripts/app.mjs');

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

    it('every literal action name it writes is registered on the class', () => {
      // The broadest guard in this file: a control whose data-action names nothing renders
      // perfectly and does nothing at all, which is the failure mode every other test here is a
      // special case of. Covers the tree and both partials it hosts.
      const hosted = [treeSource, gridSource, toolsSource].join('\n');
      const used = new Set([...hosted.matchAll(/data-(?:change-)?action="([a-zA-Z]\w*)"/g)].map((m) => m[1]));
      const actions = new Set([...treeScript.matchAll(/^\s{6}(\w+): PlaylistTreeApp\./gm)].map((m) => m[1]));
      const changeActions = new Set([...treeScript.matchAll(/^\s{4}(\w+): '(\w+)'/gm)].map((m) => m[1]));

      expect(used.size).toBeGreaterThan(10);
      for (const action of used) {
        expect(
          actions.has(action) || changeActions.has(action),
          `'${action}' is in neither DEFAULT_OPTIONS.actions nor _CHANGE_ACTIONS`
        ).toBe(true);
      }
    });

    it('routes every bound row through the shared binding-tools partial', () => {
      // The UX-7 notes and the two workbench buttons used to be eight hand-written copies. They
      // are one partial now, so the invariant "every box says what it is doing and offers its
      // tools" is checked as "every box includes it" plus the partial's own block below.
      const includes = [...treeSource.matchAll(/\{\{>\s*"modules\/game-orchestra\/templates\/parts\/binding-tools\.hbs"\s+entry=([\w.]+)\}\}/g)];
      expect(includes).toHaveLength(treeBoxes.length);
    });

  });

  /**
   * The combat grid both binding surfaces now render from - the hub's Actors group and
   * GameOrchestraConfig's token grid. One copy of the markup (docs/wiki/ux.md UX-2), so these
   * hold for both hosts at once.
   */
  describe('parts/combat-grid.hbs', () => {
    const gridBoxes = [...gridSource.matchAll(/<div class="context-box [^"]*"[^>]*>/g)].map((m) => m[0]);

    it('has a context box for the phase overlay and one for the section default', () => {
      expect(gridBoxes).toHaveLength(2);
    });

    it('every context box declares its section and its drop scope', () => {
      // contextType defaults to 'area' when absent, which would silently write combat bindings
      // into the area section - and an actor has no area section at all.
      for (const box of gridBoxes) {
        expect(box).toMatch(/data-context-type="combat"/);
        expect(box).toMatch(/data-drop-scope="\{\{[\w./]*dropScope\}\}"/);
      }
    });

    it('every control carries a phase id - blank on the default box, the card id on the overlay', () => {
      // An overlay-scoped control without its id writes to the section default instead: the
      // binding lands, on the wrong row.
      const controls = [...gridSource.matchAll(/<(?:select|button)[^>]*data-(?:change-)?action="\{\{[^"]+\}\}"[^>]*>/g)].map((m) => m[0]);
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) expect(control).toMatch(/data-phase-id="/);
    });

    it('keeps exclusive and duck at SECTION level, outside the phase-card loop', () => {
      // architecture.md § Layers: one flag governs whichever playlist the combat section resolves
      // to, for any phase. A per-phase control would read as configurable per phase while writing
      // one shared value.
      const loopEnd = gridSource.lastIndexOf('{{/each}}');
      const exclusive = /class="exclusive-input"/.exec(gridSource);
      expect(exclusive).not.toBeNull();
      expect(exclusive.index).toBeGreaterThan(loopEnd);
    });

    it('hides the duck slider when exclusive is ticked', () => {
      // Ducking only means anything while something else still plays underneath, which is exactly
      // what exclusive turns off.
      expect(gridSource).toMatch(/\{\{#unless combatExclusive\}\}[\s\S]*?actions\.duck/);
    });

    it('offers exclusive/duck only once something is bound', () => {
      // The one control in this markup that genuinely cannot work yet (UX-9) - the choice is
      // meaningless with no playlist set.
      expect(gridSource).toMatch(/\{\{#if hasAnyCombatPlaylist\}\}[\s\S]*?class="exclusive-input"/);
    });

    it('uses data-collapse-key for collapse state, never data-section', () => {
      const toggles = [...gridSource.matchAll(/data-action="toggleSection"[^>]*>/g)].map((m) => m[0]);
      expect(toggles.length).toBeGreaterThan(0);
      for (const toggle of toggles) {
        expect(toggle).toMatch(/data-collapse-key="/);
        expect(toggle).not.toMatch(/data-section="/);
      }
    });

    it('never offers a track selector for a custom (graph) playlist', () => {
      // H2/H1: a stray initialTrack on a graph playlist bypasses the whole graph.
      expect([...gridSource.matchAll(/\{\{#unless [\w.]*combat\.isCustom\}\}/g)]).toHaveLength(2);
    });

    it('every action name it renders is registered by BOTH hosts', () => {
      // The partial writes `{{actions.x}}` into data-action / data-change-action. A name present
      // in one host's table and absent from the other renders a perfect control that does nothing
      // in that window only - the exact half-working failure this suite exists for.
      const used = [...gridSource.matchAll(/data-(?:change-)?action="\{\{actions\.(\w+)\}\}"/g)].map((m) => m[1]);
      expect(new Set(used).size).toBeGreaterThan(0);
      for (const script of [treeScript, configScript]) {
        const table = /_(?:ACTOR|GRID)_ACTIONS = Object\.freeze\(\{([\s\S]*?)\}\)/.exec(script);
        expect(table).not.toBeNull();
        for (const key of new Set(used)) {
          expect(table[1], `'${key}' is missing from one host's action table`).toMatch(new RegExp(`\\b${key}:`));
        }
      }
    });
  });

  describe('parts/binding-tools.hbs', () => {
    it('says what a row is doing right now, both ways round (UX-7)', () => {
      // A layering row never wins the base resolution, so `is-resolving` can never light up for
      // it; a losing row needs to name what beat it. One copy each, guarded.
      expect([...toolsSource.matchAll(/class="layering-now"/g)]).toHaveLength(1);
      expect(toolsSource).toMatch(/\{\{#if entry\.isLayerActive\}\}/);
      expect([...toolsSource.matchAll(/class="beaten-by"/g)]).toHaveLength(1);
      expect(toolsSource).toMatch(/\{\{#if entry\.beatenBy\}\}/);
    });

    it('offers the graph editor on every bound row, not only a custom one', () => {
      // UX-9 as corrected: CustomPlaylistEditor is never mode-gated (handleSave forces
      // UNSEQUENCED itself, H1), so gating the button hid a control that would have worked. The
      // label changes instead of the button disappearing.
      const button = /<button[^>]*class="graph-btn"[\s\S]*?<\/button>/.exec(toolsSource);
      expect(button).not.toBeNull();
      expect(toolsSource.slice(0, button.index)).not.toMatch(/\{\{#if entry\.isCustom\}\}/);
      expect(button[0]).toMatch(/\{\{#if entry\.isCustom\}\}/); // label only
    });

    it('offers the mixer, which the hub had no route to at all', () => {
      expect(toolsSource).toMatch(/class="mixer-btn"[^>]*data-action="openMixer"/);
    });

    it('both buttons dispatch to actions the hub registers', () => {
      const used = [...toolsSource.matchAll(/data-action="(\w+)"/g)].map((m) => m[1]);
      expect(used).toEqual(expect.arrayContaining(['openCustomGraph', 'openMixer']));
      for (const action of used) expect(treeScript).toMatch(new RegExp(`\\b${action}: PlaylistTreeApp\\.`));
    });
  });

  describe('music-config.hbs', () => {
    it('renders the shared grid rather than a second copy of it', () => {
      expect(configSource).toMatch(/\{\{>\s*"modules\/game-orchestra\/templates\/parts\/combat-grid\.hbs"/);
    });

    it('no longer carries the vestigial scene form', () => {
      // The tabbed `.standard-form.playlist-section` layout was the stated blocker on sharing
      // this markup: its wrapper and the grid's boxes both matched the old dropSelector
      // (docs/wiki/ux.md § Why the markup merge stopped there). Scenes stopped routing here in
      // step 6a; the token half followed in 6b.
      // Markup only - the file's own header comment names the deleted contract on purpose.
      const markup = configSource.replace(/\{\{![\s\S]*?\}\}/g, '');
      expect(markup).not.toContain('playlist-section');
      expect(markup).not.toContain('selectOverlay');
      expect(markup).not.toContain('mood-tabs');
    });

    it('has no Save button, because every control writes immediately', () => {
      expect(configSource).not.toMatch(/type="submit"/);
      expect(configScript).not.toContain('formHandler');
    });
  });

  describe('every binding template', () => {
    const all = [treeSource, configSource, gridSource, toolsSource];

    it('marks soundboard entries as requiring an explicit track', () => {
      // H2: an UNSEQUENCED playlist plays nothing without one.
      expect(treeSource).toContain('soundboard-required-badge');
      expect(gridSource).toContain('soundboard-required-badge');
    });

    it('never exposes a priority field to the user', () => {
      // docs/wiki/ux.md D8. `priority` remains a stored field that resolution honours - what is
      // gone is the expectation that a GM types the number. An absolute value nobody can set
      // correctly without knowing every other value in the world was a second, disagreeing
      // encoding of the hierarchy these windows already display in their own section ordering.
      for (const source of all) {
        expect(source).not.toMatch(/name="music\.[^"]*priority"/);
        expect(source).not.toContain('priority-input');
        expect(source).not.toContain('GameOrchestra.Priority');
      }
    });
  });
});
