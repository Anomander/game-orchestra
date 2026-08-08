import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import { setupFoundryMocks, createMockPlaylist } from './mocks/foundry.mjs';

setupFoundryMocks();

import { buildCombatPhaseGrid } from '../scripts/binding-cards.mjs';
import { getAvailablePlaylists } from '../scripts/helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, '../templates');

/**
 * **Rendering** tests for the shared binding markup.
 *
 * Every other template test in this repo asserts on the template SOURCE with regexes. That catches
 * a dropped data attribute and it cannot catch either of the two bugs that shipped from the hub
 * rework, both of which were invisible in source and obvious the instant a GM looked at the window:
 *
 * 1. `{{#if (eq this.id ../this.combat.playlistId)}}` inside `{{#each ../availablePlaylists}}`.
 *    Within that inner each the context is a **playlist** and `..` is the **card**, so the card's
 *    entry is `../combat` - `../this.combat` resolves to nothing, every option rendered
 *    unselected, and a row whose music was audibly playing showed "-- None --".
 * 2. A `{{#unless}}` written inside a short `{{! }}` comment. That comment ends at its FIRST
 *    `}}`, so the block expression terminated it early and the remainder - `. }}` - rendered as
 *    literal text in the window (HR-L).
 *
 * Both parse. Both compile. Both pass every source regex. Only rendering finds them, so these
 * tests render with a real view model from `binding-cards.mjs` rather than a hand-built context.
 */
describe('binding markup, rendered', () => {
  const PHASES = [
    { id: 'p1', label: 'Phase One', icon: 'fas fa-shield', color: '#4caf50' },
    { id: 'enrage', label: 'Enrage', icon: 'fas fa-fire', color: '#f44336' }
  ];

  let render;
  let availablePlaylists;

  beforeEach(() => {
    setupFoundryMocks();
    game.playlists = [
      createMockPlaylist('pl-boss', 'Boss Theme', [{ id: 'tr-1', name: 'Intro' }, { id: 'tr-2', name: 'Loop' }]),
      createMockPlaylist('pl-calm', 'Calm Theme', [{ id: 'tr-9', name: 'Drift' }])
    ];
    availablePlaylists = getAvailablePlaylists();

    // The four core helpers this markup uses. Minimal on purpose: enough to render, not a
    // reimplementation of Foundry - `localize` echoes its key so a missing string is visible.
    const hb = Handlebars.create();
    hb.registerHelper('eq', (a, b) => a === b);
    hb.registerHelper('localize', (key) => String(key));
    hb.registerHelper('checked', (value) => (value ? 'checked' : ''));
    for (const file of ['parts/combat-grid.hbs', 'parts/binding-tools.hbs']) {
      hb.registerPartial(`modules/game-orchestra/templates/${file}`, fs.readFileSync(path.join(templateDir, file), 'utf8'));
    }
    const grid = hb.compile(fs.readFileSync(path.join(templateDir, 'parts/combat-grid.hbs'), 'utf8'));

    render = (combatSection) => grid(buildActorRow(combatSection));
  });

  /**
   * The context the hub actually hands the partial for one actor row - built the way
   * `PlaylistTreeApp._prepareContext` builds it, by spreading the grid result and adding only the
   * row's own keys.
   *
   * **Deliberately not hand-assembled.** An earlier version of this file passed
   * `availablePlaylists` into the render context itself, which the hub does not do - so it
   * rendered a populated picker in the test while the real window rendered two empty ones. A
   * fixture that supplies what the code under test forgot proves nothing.
   * @param {object|null} combatSection
   * @returns {object}
   */
  function buildActorRow(combatSection) {
    const grid = buildCombatPhaseGrid({
      combatSection,
      configuredPhases: PHASES,
      availablePlaylists,
      activePhase: 'enrage',
      keyPrefix: 'actorPhase:a1',
      isCollapsed: () => false, // render everything, so nothing hides behind a collapsed node
      dropScope: 'actor',
      actions: {
        overlay: 'updateActorOverlay',
        overlayTrack: 'updateActorOverlayTrack',
        clearOverlay: 'clearActorOverlay',
        default: 'updateActorDefault',
        defaultTrack: 'updateActorDefaultTrack',
        clearDefault: 'clearActorDefault',
        exclusive: 'updateActorExclusive',
        duck: 'updateActorDuck'
      }
    });
    return {
      ...grid,
      phasesKey: 'actor:a1:phases',
      defaultKey: 'actor:a1:default',
      phasesCollapsed: false,
      defaultCollapsed: false
    };
  }

  /**
   * The `<option>` tags of the select carrying `dataAction` for one phase.
   *
   * The phase id is not optional padding: two cards render the same action, so matching the first
   * select alone reports on whichever card happens to come first - which passes on an empty card
   * and never looks at the bound one.
   * @param {string} html
   * @param {string} dataAction
   * @param {string} [phaseId] - '' for the section-default row
   */
  const optionsOf = (html, dataAction, phaseId = '') => {
    const select = new RegExp(
      `<select[^>]*data-change-action="${dataAction}"[^>]*data-phase-id="${phaseId}"[^>]*>([\\s\\S]*?)</select>`
    ).exec(html);
    return select ? [...select[1].matchAll(/<option[^>]*>[^<]*<\/option>/g)].map((m) => m[0]) : null;
  };
  const selectedIn = (options) => options.filter((o) => o.includes('selected'));

  describe('the picker offers every playlist in the world', () => {
    // The bug this section exists for: `buildCombatPhaseGrid` took `availablePlaylists` and did
    // not return it. GameOrchestraConfig re-added its own copy and rendered fine; the hub's actor
    // rows spread only the grid, so BOTH selects rendered with nothing but the blank option - on
    // a row whose music was playing, with the delete button and the exclusive/duck block visible
    // right beside it saying something was clearly bound.
    it('lists every playlist, not just the blank option', () => {
      const html = render(null);

      for (const action of ['updateActorDefault', 'updateActorOverlay']) {
        const options = optionsOf(html, action, action === 'updateActorOverlay' ? 'enrage' : '');
        expect(options, `${action} rendered no select at all`).not.toBeNull();
        expect(options.length, `${action} offered no playlists`).toBe(availablePlaylists.length + 1);
        expect(options.some((o) => o.includes('value="pl-boss"'))).toBe(true);
      }
    });

    it('carries the list on the grid result itself, so no host has to remember to add it', () => {
      expect(buildActorRow(null).availablePlaylists).toEqual(availablePlaylists);
    });
  });

  describe('the selected option reflects what is actually bound', () => {
    it('marks the bound playlist selected on a PHASE OVERLAY row', () => {
      // The regression. `../this.combat.playlistId` rendered every option unselected, so a row
      // that was audibly playing showed "-- None --".
      const html = render({ overlays: { enrage: { playlist: 'pl-boss' } } });
      const options = optionsOf(html, 'updateActorOverlay', 'enrage');

      expect(options).not.toBeNull();
      expect(selectedIn(options)).toHaveLength(1);
      expect(selectedIn(options)[0]).toContain('value="pl-boss"');
    });

    it('marks the bound track selected on a phase overlay row', () => {
      const html = render({ overlays: { enrage: { playlist: 'pl-boss', initialTrack: 'tr-2' } } });
      const options = optionsOf(html, 'updateActorOverlayTrack', 'enrage');

      expect(selectedIn(options)).toHaveLength(1);
      expect(selectedIn(options)[0]).toContain('value="tr-2"');
    });

    it('marks the bound playlist selected on the SECTION DEFAULT row', () => {
      const html = render({ playlist: 'pl-calm' });
      const options = optionsOf(html, 'updateActorDefault');

      expect(selectedIn(options)).toHaveLength(1);
      expect(selectedIn(options)[0]).toContain('value="pl-calm"');
    });

    it('marks the bound track selected on the section default row', () => {
      const html = render({ playlist: 'pl-boss', initialTrack: 'tr-1' });

      expect(selectedIn(optionsOf(html, 'updateActorDefaultTrack'))[0]).toContain('value="tr-1"');
    });

    it('selects nothing when nothing is bound', () => {
      const html = render(null);

      expect(selectedIn(optionsOf(html, 'updateActorDefault'))).toHaveLength(0);
    });

    it('does not leak one card\'s selection onto another', () => {
      // The two cards render from the same loop; a parent-path mistake in either direction shows
      // up here rather than as a plausible-looking single row.
      const html = render({ overlays: { enrage: { playlist: 'pl-boss' } } });
      const selects = [...html.matchAll(/<select[^>]*data-change-action="updateActorOverlay"[^>]*>([\s\S]*?)<\/select>/g)];

      expect(selects).toHaveLength(2);
      const selectedCounts = selects.map(([, body]) => (body.match(/selected/g) || []).length);
      expect(selectedCounts.sort()).toEqual([0, 1]);
    });
  });

  describe('nothing leaks to the user as literal text', () => {
    const cases = {
      'nothing bound': null,
      'a section default': { playlist: 'pl-calm', initialTrack: 'tr-9' },
      'a phase override': { overlays: { enrage: { playlist: 'pl-boss' } } },
      'exclusive ticked': { playlist: 'pl-calm', exclusive: true },
      'a duck set': { playlist: 'pl-calm', duck: 0.4 }
    };

    for (const [name, section] of Object.entries(cases)) {
      it(`renders no stray braces with ${name}`, () => {
        // `. }}` in the window was a {{#unless}} written inside a short {{! }} comment: the
        // comment ended at that block's `}}` and the rest became text (HR-L).
        const html = render(section);

        expect(html).not.toContain('}}');
        expect(html).not.toContain('{{');
      });
    }
  });

  describe('the structural contract every write depends on', () => {
    it('gives each box its section, drop scope and phase id', () => {
      const html = render({ playlist: 'pl-calm', overlays: { enrage: { playlist: 'pl-boss' } } });
      const boxes = [...html.matchAll(/<div class="context-box [^"]*"[^>]*>/g)].map((m) => m[0]);

      expect(boxes).toHaveLength(3); // two phase cards + the section default
      for (const box of boxes) {
        expect(box).toContain('data-context-type="combat"');
        expect(box).toContain('data-drop-scope="actor"');
        expect(box).toMatch(/data-phase-id="[^"]*"/);
      }
      expect(boxes.filter((b) => b.includes('data-phase-id="enrage"'))).toHaveLength(1);
      expect(boxes.filter((b) => b.includes('data-phase-id=""'))).toHaveLength(1);
    });

    it('renders the host\'s action names, not a hard-coded window\'s', () => {
      const html = render({ playlist: 'pl-calm' });

      expect(html).toContain('data-change-action="updateActorDefault"');
      expect(html).not.toContain('updateDefaultEntry'); // GameOrchestraConfig's name
    });

    it('offers exclusive and duck only once something is bound', () => {
      expect(render(null)).not.toContain('updateActorExclusive');
      expect(render({ playlist: 'pl-calm' })).toContain('updateActorExclusive');
    });

    it('hides the duck slider when exclusive is ticked', () => {
      expect(render({ playlist: 'pl-calm', exclusive: true })).not.toContain('updateActorDuck');
      expect(render({ playlist: 'pl-calm' })).toContain('updateActorDuck');
    });

    it('offers both workbench buttons on a bound row and neither on an empty one', () => {
      const bound = render({ playlist: 'pl-calm' });
      expect(bound).toContain('data-action="openCustomGraph"');
      expect(bound).toContain('data-action="openMixer"');
      expect(render(null)).not.toContain('data-action="openMixer"');
    });

    it('never offers a track selector for a custom (graph) playlist (H2)', () => {
      // A stray initialTrack on a graph playlist short-circuits past the whole graph.
      game.playlists = [createMockPlaylist('pl-graph', 'Graph Playlist', [{ id: 'tr-1', name: 'A' }])];
      game.playlists[0].setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      availablePlaylists = getAvailablePlaylists();

      // Rebuild against the new playlist list.
      const html = render({ playlist: 'pl-graph' });

      expect(html).not.toContain('data-change-action="updateActorDefaultTrack"');
    });
  });
});
