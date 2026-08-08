import { describe, it, expect, beforeEach } from 'vitest';
import { setupFoundryMocks, createMockPlaylist } from './mocks/foundry.mjs';

setupFoundryMocks();

import { buildCombatPhaseGrid } from '../scripts/binding-cards.mjs';
import { getAvailablePlaylists } from '../scripts/helpers.mjs';

/**
 * The read half of J1, shared by the hub's Actors group and GameOrchestraConfig's token grid.
 *
 * Building this shape twice is how the two binding surfaces drifted apart in the first place
 * (docs/wiki/ux.md D1), so it is worth testing on its own rather than only through its two hosts:
 * a host test that passes proves that host works, not that the two agree.
 */
describe('buildCombatPhaseGrid', () => {
  const PHASES = [
    { id: 'p1', label: 'Phase One', icon: 'fas fa-shield', color: '#4caf50' },
    { id: 'enrage', label: 'Enrage', icon: 'fas fa-fire', color: '#f44336' }
  ];

  let availablePlaylists;
  /** Collapse predicate matching app-mixins.mjs#isSectionCollapsed's default arm. */
  const collapseByDefault = (_key, hasOverride) => !hasOverride;

  const build = (overrides = {}) => buildCombatPhaseGrid({
    combatSection: null,
    configuredPhases: PHASES,
    availablePlaylists,
    activePhase: 'enrage',
    keyPrefix: 'tokenPhase',
    isCollapsed: collapseByDefault,
    ...overrides
  });

  beforeEach(() => {
    setupFoundryMocks();
    game.playlists = [
      createMockPlaylist('pl-boss', 'Boss Theme', [{ id: 'tr-1', name: 'Intro' }]),
      createMockPlaylist('pl-default', 'Default Theme', [{ id: 'tr-9', name: 'Loop' }])
    ];
    availablePlaylists = getAvailablePlaylists();
  });

  it('builds one card per configured phase, in order', () => {
    expect(build().phaseCards.map((c) => c.phaseId)).toEqual(['p1', 'enrage']);
  });

  it('survives a missing combat section rather than throwing', () => {
    // An actor dragged in has no `music` flag at all until something is bound.
    const grid = build({ combatSection: undefined });

    expect(grid.phaseCards.every((c) => c.hasOverride === false)).toBe(true);
    expect(grid.defaultEntry.combat.playlistId).toBeNull();
    expect(grid.hasAnyCombatPlaylist).toBe(false);
  });

  it('reads an overlay binding onto its own card and nowhere else', () => {
    const grid = build({ combatSection: { overlays: { enrage: { playlist: 'pl-boss', initialTrack: 'tr-1' } } } });

    const enrage = grid.phaseCards.find((c) => c.phaseId === 'enrage');
    expect(enrage.combat.playlistId).toBe('pl-boss');
    expect(enrage.combat.initialTrackId).toBe('tr-1');
    expect(enrage.hasOverride).toBe(true);
    expect(grid.phaseCards.find((c) => c.phaseId === 'p1').hasOverride).toBe(false);
  });

  it('namespaces card keys under the caller\'s prefix, so two documents never share collapse state', () => {
    const a = build({ keyPrefix: 'actorPhase:a1' });
    const b = build({ keyPrefix: 'actorPhase:a2' });

    expect(a.phaseCards[0].cardKey).toBe('actorPhase:a1:p1');
    expect(b.phaseCards[0].cardKey).toBe('actorPhase:a2:p1');
  });

  it('marks the ACTIVE phase, which is not the same thing as the resolving one', () => {
    const grid = build({ combatSection: { overlays: { enrage: { playlist: 'pl-boss' } } }, isWinner: false });

    const enrage = grid.phaseCards.find((c) => c.phaseId === 'enrage');
    expect(enrage.isActive).toBe(true);
    expect(enrage.isResolving).toBe(false);
  });

  it('resolves the active phase card only when the winner came through a phase overlay', () => {
    const section = { overlays: { enrage: { playlist: 'pl-boss' } } };

    const viaOverlay = build({ combatSection: section, isWinner: true, winnerIsPhaseOverlay: true });
    expect(viaOverlay.phaseCards.find((c) => c.phaseId === 'enrage').isResolving).toBe(true);
    expect(viaOverlay.phasesResolving).toBe(true);
    expect(viaOverlay.defaultResolving).toBe(false);

    const viaDefault = build({ combatSection: section, isWinner: true, winnerIsPhaseOverlay: false });
    expect(viaDefault.phaseCards.find((c) => c.phaseId === 'enrage').isResolving).toBe(false);
    expect(viaDefault.defaultResolving).toBe(true);
  });

  it('resolves nothing when this document is not the winner at all', () => {
    const grid = build({ combatSection: { playlist: 'pl-default' }, isWinner: false, winnerIsPhaseOverlay: true });

    expect(grid.phasesResolving).toBe(false);
    expect(grid.defaultResolving).toBe(false);
  });

  it('reports hasAnyCombatPlaylist from either the default or any overlay', () => {
    expect(build({ combatSection: { playlist: 'pl-default' } }).hasAnyCombatPlaylist).toBe(true);
    expect(build({ combatSection: { overlays: { p1: { playlist: 'pl-boss' } } } }).hasAnyCombatPlaylist).toBe(true);
    expect(build({ combatSection: { exclusive: true } }).hasAnyCombatPlaylist).toBe(false);
  });

  it('reads exclusive and duck at SECTION level, never from the active phase overlay', () => {
    // architecture.md § Layers: one flag governs whichever playlist the section resolves to.
    const grid = build({
      combatSection: { playlist: 'pl-default', exclusive: true, duck: 0.4, overlays: { enrage: { duck: 0.1 } } }
    });

    expect(grid.combatExclusive).toBe(true);
    expect(grid.combatDuck).toBe(0.4);
    expect(grid.combatDuckPercent).toBe(40);
  });

  it('treats an absent duck as 1 - "no ducking" is the absent value', () => {
    const grid = build({ combatSection: { playlist: 'pl-default' } });

    expect(grid.combatDuck).toBe(1);
    expect(grid.combatDuckPercent).toBe(100);
  });

  it('collapses an unbound card and opens a bound one, via the caller\'s predicate', () => {
    const grid = build({ combatSection: { overlays: { enrage: { playlist: 'pl-boss' } } } });

    expect(grid.phaseCards.find((c) => c.phaseId === 'enrage').isCardCollapsed).toBe(false);
    expect(grid.phaseCards.find((c) => c.phaseId === 'p1').isCardCollapsed).toBe(true);
  });

  it('returns the playlist list it was given, because the partial renders from this object', () => {
    // Not decoration. The partial is invoked with this result as its context and its two selects
    // iterate `availablePlaylists` off it, so a host that spread only the rest of the result
    // rendered both pickers empty - see tests/binding-render.test.mjs.
    expect(build().availablePlaylists).toEqual(availablePlaylists);
  });

  it('passes the host\'s dropScope and action names straight through to the template', () => {
    const actions = { overlay: 'updateActorOverlay', duck: 'updateActorDuck' };
    const grid = build({ dropScope: 'actor', actions });

    expect(grid.dropScope).toBe('actor');
    expect(grid.actions).toBe(actions);
  });

  it('is pure: it touches no application instance and mutates nothing it is given', () => {
    const section = { playlist: 'pl-default', overlays: { enrage: { playlist: 'pl-boss' } } };
    const snapshot = JSON.parse(JSON.stringify(section));

    build({ combatSection: section });

    expect(section).toEqual(snapshot);
  });
});
