import { CONST } from './config.mjs';
import { log } from './helpers.mjs';

/**
 * The **transport** - J5 (Perform) in docs/wiki/ux.md.
 *
 * Everything a GM reaches for mid-session with players watching: which mood or
 * phase is live, whether area/combat music is suppressed, and what is actually
 * winning right now. It has two hosts - the Mood Widget and the scene-control
 * bar - and per UX-2 they share this one definition rather than each carrying
 * their own copy of "what the suppression toggles are and what toggling does".
 *
 * The hosts still own their own markup, because a scene-control tool and a
 * widget pill are genuinely different shapes; what they must not each own is
 * the *behaviour*. `describeResolution()` below is kept pure and emits i18n
 * keys, per the house rule that the render boundary localizes.
 */

/**
 * The two suppression toggles, in the order both hosts show them.
 *
 * `order` is the scene-control sort key; the widget ignores it. Kept here rather
 * than inline in `hooks.mjs` so the widget cannot drift out of sync about which
 * toggles exist.
 * @type {Array<{key: string, setting: string, titleKey: string, icon: string, order: number}>}
 */
export const SUPPRESSION_CONTROLS = [
  {
    key: 'suppress-area-music',
    setting: CONST.settings.suppressArea,
    titleKey: 'GameOrchestra.Controls.SuppressAreaMusic',
    icon: 'fas fa-dungeon',
    order: 10
  },
  {
    key: 'suppress-combat-music',
    setting: CONST.settings.suppressCombat,
    titleKey: 'GameOrchestra.Controls.SuppressCombatMusic',
    icon: 'fas fa-fist-raised',
    order: 11
  }
];

/**
 * The suppression toggles with their live on/off state read in.
 * @returns {Array<{key: string, setting: string, titleKey: string, icon: string, order: number, active: boolean}>}
 */
export function suppressionState() {
  return SUPPRESSION_CONTROLS.map((control) => ({
    ...control,
    active: !!game.settings.get(CONST.moduleId, control.setting)
  }));
}

/**
 * Flip one suppression setting.
 *
 * `ui.controls.initialize()` is called so the scene-control bar re-reads its
 * `active` flags: the toggle can now be flipped from the widget, and without
 * this the bar keeps showing the old state until something else redraws it.
 * The setting's own `onChange` (settings.mjs) is what re-resolves playback.
 * @param {string} setting - A `CONST.settings` key from {@link SUPPRESSION_CONTROLS}
 * @param {boolean} [value] - Target state; toggles the current one when omitted
 * @returns {Promise<void>}
 */
export async function setSuppression(setting, value = undefined) {
  const target = value === undefined ? !game.settings.get(CONST.moduleId, setting) : !!value;
  try {
    await game.settings.set(CONST.moduleId, setting, target);
    log(3, `Successfully toggled '${setting}' to: ${target}`);
  } catch (error) {
    log(1, `Failed to toggle '${setting}' to ${target}:`, error);
  }
  ui.controls?.initialize?.();
}

/**
 * Describe which source is currently winning, as an i18n key plus its format
 * data - never a localized string (the render boundary localizes).
 *
 * Pure: every input is passed in. That is what makes the tree's pill and the
 * widget's pill provably the same sentence rather than two similar ones.
 * @param {object} params
 * @param {object|null} params.context - MusicController#currentContext
 * @param {object|null} params.referenceScene - The scene the caller considers "this scene"
 *   (the tree's selected scene; the widget's active scene)
 * @param {string} params.activeMood
 * @param {string} params.activePhase
 * @returns {{key: string, format: object|null, name: string|null}|null} Null when nothing is playing
 */
export function describeResolution({ context, referenceScene, activeMood, activePhase }) {
  if (!context) return null;
  const entity = context.contextEntity;
  const isOverlay = context.isOverlay ?? false;
  const axis = context.overlayAxis ?? null;
  const overlayValue = axis === 'phase' ? activePhase : activeMood;

  if (entity && referenceScene && entity === referenceScene) {
    if (!isOverlay) return { key: 'GameOrchestra.PlaylistTree.ActiveAudioSceneDefault', format: null, name: null };
    const key = axis === 'phase' ? 'ActiveAudioScenePhase' : 'ActiveAudioSceneMood';
    return { key: `GameOrchestra.PlaylistTree.${key}`, format: { mood: overlayValue }, name: null };
  }

  if (entity?.documentName === 'DefaultMusic') {
    if (!isOverlay) return { key: 'GameOrchestra.PlaylistTree.ActiveAudioGlobalDefault', format: null, name: null };
    const key = axis === 'phase' ? 'ActiveAudioGlobalPhase' : 'ActiveAudioGlobalMood';
    return { key: `GameOrchestra.PlaylistTree.${key}`, format: { mood: overlayValue }, name: null };
  }

  // A token or actor: its own name is the most useful thing to show, so it is
  // returned verbatim rather than through a key.
  if (entity) return { key: 'GameOrchestra.PlaylistTree.ActiveAudioTokenActor', format: null, name: entity.name || null };

  return { key: 'GameOrchestra.None', format: null, name: null };
}

/**
 * Localize a {@link describeResolution} result to just the source phrase, with no
 * "Active Audio:" prefix - what the "beaten by X" note on a losing row needs.
 * @param {{key: string, format: object|null, name: string|null}|null} described
 * @returns {string|null}
 */
export function localizeResolutionSource(described) {
  if (!described) return null;
  if (described.name) return described.name;
  return described.format ? game.i18n.format(described.key, described.format) : game.i18n.localize(described.key);
}

/**
 * Localize a {@link describeResolution} result into the pill's display string.
 * @param {{key: string, format: object|null, name: string|null}|null} described
 * @returns {string|null}
 */
export function localizeResolution(described) {
  const source = localizeResolutionSource(described);
  return source === null ? null : `${game.i18n.localize('GameOrchestra.PlaylistTree.ActiveAudioPrefix')} ${source}`;
}

/**
 * Whether a configured binding is in the running *right now* - the precondition for
 * saying anything about why it is or isn't playing.
 *
 * Mirrors the two rules that run before priority is ever consulted
 * (architecture.md § Selection): combat categorically drops area and vice versa, and
 * an overlay row only counts when its own id is the live one for its axis. A section
 * default is live only while the live overlay has nothing configured, because an
 * overlay with a playlist *replaces* the section's own config
 * (`_extractSectionConfig`: `config = overlay || section`).
 *
 * Pure, and the reason a losing row can be labelled honestly: a row that was never
 * eligible was not "beaten", it simply does not apply, and saying otherwise would
 * teach the wrong model.
 * @param {object} params
 * @param {'area'|'combat'} params.section
 * @param {string|null} params.overlayId - This row's overlay, or null for a section default
 * @param {string} params.activeOverlayId - The live overlay id on this row's axis
 * @param {boolean} params.inCombat
 * @param {boolean} [params.activeOverlayConfigured] - Whether this same scope's live
 *   overlay has a playlist; only consulted for a section default
 * @returns {boolean}
 */
export function isBindingEligible({ section, overlayId, activeOverlayId, inCombat, activeOverlayConfigured = false }) {
  if (inCombat ? section !== 'combat' : section !== 'area') return false;
  if (overlayId) return overlayId === activeOverlayId;
  return !activeOverlayConfigured;
}

/**
 * Both status pills for a host: the winning context, and the additive layer.
 *
 * The layer gets its own pill rather than being folded into the first, because
 * it plays *alongside* the winner rather than competing with it - see
 * MusicController#getCurrentLayerContext and architecture.md § Layers.
 * @param {object|null} referenceScene
 * @returns {{active: {label: string}|null, layer: {label: string}|null}}
 */
export function resolutionPills(referenceScene) {
  const controller = game.gameOrchestra?.musicController;
  const label = localizeResolution(describeResolution({
    context: controller?.currentContext || null,
    referenceScene,
    activeMood: game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '',
    activePhase: game.settings.get(CONST.moduleId, CONST.settings.activePhase) || ''
  }));

  const layerContext = controller?.currentLayerContext || null;
  const layer = layerContext
    ? {
      label: game.i18n.format('GameOrchestra.PlaylistTree.LayerAudio', {
        playlist: layerContext.playlist?.name || game.i18n.localize('GameOrchestra.None'),
        source: layerContext.contextEntity?.name || game.i18n.localize('GameOrchestra.PlaylistTree.ActiveAudioTokenActor')
      })
    }
    : null;

  return { active: label ? { label } : null, layer };
}
