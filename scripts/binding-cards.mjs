import { buildPlaylistEntry } from './helpers.mjs';
import { coerceDuckFactor } from './playlist-mix.mjs';

/**
 * The **read** half of J1 (Bind), shared by every host that renders binding cards - see
 * docs/wiki/ux.md step 6.
 *
 * `binding-store.mjs` unified the write half; this is its counterpart. The hub's Actors group and
 * `GameOrchestraConfig`'s token grid render structurally identical card objects, and building them
 * twice is how the two surfaces drift into disagreeing about the same data (D1). One builder, two
 * hosts.
 *
 * **Pure**: no `game`, no `ui`, no DOM, no Foundry globals. The caller reads live state - the
 * configured phases, the winning context, the collapse predicate - and passes it in. That is the
 * same discipline `playlist-ref.mjs` and `graph-validation.mjs` keep, and it is what makes this
 * unit-testable against plain objects.
 */

/**
 * One combat card grid plus its section default, for a document that has only a combat section.
 *
 * That is Actors and Tokens: `CONST.playlistSections.Token` has no `area` entry, and combat
 * resolves against the **phase** axis, never mood (`config.mjs#sectionAxis`) - so this grid is
 * always phase-based. A scene, which has both sections and both axes, is not built here.
 *
 * @param {object} options
 * @param {object|null} options.combatSection - The document's `music.combat`, or null/undefined
 * @param {Array<{id: string, label: string, icon: string, color: string}>} options.configuredPhases
 * @param {Array<object>} options.availablePlaylists - From `helpers.mjs#getAvailablePlaylists`
 * @param {string} options.activePhase - The world's live phase id
 * @param {string} options.keyPrefix - Namespace for collapse keys, e.g. `'tokenPhase'` or
 *   `'actorPhase:<actorId>'`. Hosts that show several documents at once must make this unique per
 *   document, or two rows share one collapse state.
 * @param {(key: string, hasOverride: boolean) => boolean} options.isCollapsed - Usually
 *   `app-mixins.mjs#isSectionCollapsed`, bound to the host app
 * @param {boolean} [options.isWinner] - Whether the winning context came from this document
 * @param {boolean} [options.winnerIsPhaseOverlay] - Whether that winner came through a phase
 *   overlay rather than the section default
 * @param {string} [options.dropScope] - Value for `data-drop-scope` on this grid's boxes
 * @param {object} [options.actions] - The host's action names, carried in the view model rather
 *   than passed as partial hash params: the shared markup is identical between hosts and only
 *   the handler names differ, and eight `{{> partial a=… b=…}}` arguments is a worse seam than
 *   one object built where the rest of the row is.
 * @returns {object} `{availablePlaylists, phaseCards, defaultEntry, phasesResolving,
 *   defaultResolving, hasPhasesOverride, hasDefaultOverride, combatExclusive,
 *   hasAnyCombatPlaylist, combatDuck, combatDuckPercent, dropScope, actions}`
 */
export function buildCombatPhaseGrid({
  combatSection,
  configuredPhases,
  availablePlaylists,
  activePhase,
  keyPrefix,
  isCollapsed,
  isWinner = false,
  winnerIsPhaseOverlay = false,
  dropScope = 'token',
  actions = {}
}) {
  const section = combatSection || {};

  const phaseCards = (configuredPhases || []).map((p) => {
    const overlay = section.overlays?.[p.id] || null;
    const playlistId = overlay?.playlist || null;
    const trackId = overlay?.initialTrack || null;
    const hasOverride = !!playlistId;
    const cardKey = `${keyPrefix}:${p.id}`;

    return {
      phaseId: p.id,
      label: p.label,
      icon: p.icon,
      color: p.color,
      combat: buildPlaylistEntry(availablePlaylists, playlistId, trackId),
      isActive: activePhase === p.id,
      isResolving: isWinner && winnerIsPhaseOverlay && activePhase === p.id,
      hasOverride,
      isCardCollapsed: isCollapsed(cardKey, hasOverride),
      cardKey
    };
  });

  const defaultEntry = {
    combat: buildPlaylistEntry(availablePlaylists, section.playlist || null, section.initialTrack || null)
  };

  const hasPhasesOverride = phaseCards.some((p) => p.hasOverride);
  const hasDefaultOverride = !!defaultEntry.combat.playlistId;

  // Section level, deliberately read off the section rather than the active phase's overlay: one
  // flag governs whichever playlist this section resolves to for any phase. Only offered once
  // something is actually configured - the choice is meaningless with no playlist set.
  const combatDuck = coerceDuckFactor(section.duck);

  return {
    // Returned, not just consumed. The partial is rendered with THIS object as its context, so
    // the two `<select>`s iterate `availablePlaylists` off it - a host that only spread the rest
    // of this result rendered both pickers with nothing in them but the blank option, on a row
    // whose music was audibly playing. Confirmed live. Keeping it here means no host can forget.
    availablePlaylists,
    phaseCards,
    defaultEntry,
    phasesResolving: isWinner && winnerIsPhaseOverlay,
    defaultResolving: isWinner && !winnerIsPhaseOverlay,
    hasPhasesOverride,
    hasDefaultOverride,
    combatExclusive: section.exclusive === true,
    hasAnyCombatPlaylist: hasDefaultOverride || hasPhasesOverride,
    // Stored as the multiplier the rest of the music is taken to, so 1 is "no ducking" and the
    // slider reads the same way round as the mixer's gain.
    combatDuck,
    combatDuckPercent: Math.round(combatDuck * 100),
    dropScope,
    actions
  };
}
