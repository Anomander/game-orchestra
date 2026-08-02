import { CONST } from './config.mjs';
import { canonicalizeId, log } from './helpers.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const AVAILABLE_ICONS = [
  { value: 'fas fa-music', emoji: '🎵', labelKey: 'GameOrchestra.MoodConfig.Icon.MusicNote' },
  { value: 'fas fa-leaf', emoji: '🌿', labelKey: 'GameOrchestra.MoodConfig.Icon.Leaf' },
  { value: 'fas fa-exclamation-triangle', emoji: '⚠️', labelKey: 'GameOrchestra.MoodConfig.Icon.Warning' },
  { value: 'fas fa-skull', emoji: '💀', labelKey: 'GameOrchestra.MoodConfig.Icon.Skull' },
  { value: 'fas fa-user-ninja', emoji: '🥷', labelKey: 'GameOrchestra.MoodConfig.Icon.Ninja' },
  { value: 'fas fa-trophy', emoji: '🏆', labelKey: 'GameOrchestra.MoodConfig.Icon.Trophy' },
  { value: 'fas fa-fist-raised', emoji: '✊', labelKey: 'GameOrchestra.MoodConfig.Icon.Fist' },
  { value: 'fas fa-fire', emoji: '🔥', labelKey: 'GameOrchestra.MoodConfig.Icon.Fire' },
  { value: 'fas fa-ghost', emoji: '👻', labelKey: 'GameOrchestra.MoodConfig.Icon.Ghost' },
  { value: 'fas fa-bolt', emoji: '⚡', labelKey: 'GameOrchestra.MoodConfig.Icon.Bolt' },
  { value: 'fas fa-dungeon', emoji: '🏰', labelKey: 'GameOrchestra.MoodConfig.Icon.Dungeon' },
  { value: 'fas fa-glass-cheers', emoji: '🍻', labelKey: 'GameOrchestra.MoodConfig.Icon.Tavern' },
  { value: 'fas fa-magic', emoji: '🪄', labelKey: 'GameOrchestra.MoodConfig.Icon.Magic' },
  { value: 'fas fa-shield-alt', emoji: '🛡️', labelKey: 'GameOrchestra.MoodConfig.Icon.Shield' },
  { value: 'fas fa-shield-halved', emoji: '🛡️', labelKey: 'GameOrchestra.MoodConfig.Icon.Shield' },
  { value: 'fas fa-feather', emoji: '🪶', labelKey: 'GameOrchestra.MoodConfig.Icon.Feather' },
  { value: 'fas fa-water', emoji: '🌊', labelKey: 'GameOrchestra.MoodConfig.Icon.Water' },
  { value: 'fas fa-mask', emoji: '🎭', labelKey: 'GameOrchestra.MoodConfig.Icon.Mask' },
  { value: 'fas fa-droplet', emoji: '🩸', labelKey: 'GameOrchestra.MoodConfig.Icon.Droplet' }
];

/**
 * Per-axis UI descriptors for OverlayConfigApp (see config.mjs#overlayAxes).
 * Everything an axis needs to drive the shared list-editor form.
 */
const AXIS_UI = {
  mood: {
    listSetting: CONST.settings.configuredMoods,
    defaults: CONST.defaultMoods,
    idPrefix: 'mood',
    newItemLabel: 'New Mood',
    hintKey: 'GameOrchestra.MoodConfig.Hint',
    addLabelKey: 'GameOrchestra.MoodConfig.AddMood',
    deleteOrphanWarningKey: 'GameOrchestra.MoodConfig.DeleteOrphanWarning',
    deleteActiveBlockedKey: 'GameOrchestra.MoodConfig.DeleteActiveBlocked',
    saveFailedKey: 'GameOrchestra.MoodConfig.SaveFailed'
  },
  phase: {
    listSetting: CONST.settings.configuredPhases,
    defaults: CONST.defaultPhases,
    idPrefix: 'phase',
    newItemLabel: 'New Phase',
    hintKey: 'GameOrchestra.PhaseConfig.Hint',
    addLabelKey: 'GameOrchestra.PhaseConfig.AddPhase',
    deleteOrphanWarningKey: 'GameOrchestra.PhaseConfig.DeleteOrphanWarning',
    deleteActiveBlockedKey: 'GameOrchestra.PhaseConfig.DeleteActiveBlocked',
    saveFailedKey: 'GameOrchestra.PhaseConfig.SaveFailed'
  }
};

/**
 * Shared world-list editor for an overlay axis's definitions (moods or
 * phases - see config.mjs#overlayAxes). MoodConfigApp and PhaseConfigApp
 * below are thin subclasses that fix `static axis` and override only
 * `id`/`window` in DEFAULT_OPTIONS; Foundry's ApplicationV2 deep-merges
 * DEFAULT_OPTIONS across the prototype chain, so the shared `actions` map
 * defined here (pointing at this class's own static handlers) is inherited
 * automatically.
 */
class OverlayConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {'mood'|'phase'} Overridden by each subclass. */
  static axis = 'mood';

  static DEFAULT_OPTIONS = {
    tag: 'form',
    modal: true,
    form: {
      handler: OverlayConfigApp.formHandler,
      closeOnSubmit: false,
      submitOnChange: false
    },
    position: { width: 480, height: 'auto' },
    actions: {
      addItem: OverlayConfigApp.handleAddItem,
      deleteItem: OverlayConfigApp.handleDeleteItem,
      resetDefaults: OverlayConfigApp.handleResetDefaults
    }
  };

  /** @override */
  static PARTS = { form: { template: 'modules/game-orchestra/templates/overlay-config.hbs' } };

  /**
   * @returns {typeof AXIS_UI['mood']}
   */
  static get axisUi() {
    return AXIS_UI[this.axis];
  }

  constructor(options = {}) {
    super(options);
    this.items = foundry.utils.deepClone(game.settings.get(CONST.moduleId, this.constructor.axisUi.listSetting) || this.constructor.axisUi.defaults);
  }

  /** @override */
  _prepareContext(_options) {
    const axisUi = this.constructor.axisUi;
    const formattedItems = this.items.map((m) => {
      let iconOptions = AVAILABLE_ICONS.map((opt) => ({
        value: opt.value,
        label: `${opt.emoji} ${game.i18n.localize(opt.labelKey)}`,
        selected: opt.value === m.icon
      }));

      // Preserve custom icons not in the default list
      if (m.icon && !AVAILABLE_ICONS.some((opt) => opt.value === m.icon)) {
        iconOptions.unshift({ value: m.icon, label: `✨ ${game.i18n.format('GameOrchestra.MoodConfig.Icon.CustomFallback', { icon: m.icon })}`, selected: true });
      }

      return {
        ...m,
        displayLabel: m.label?.startsWith('GameOrchestra.') ? game.i18n.localize(m.label) : m.label,
        iconOptions
      };
    });

    const buttons = [{ type: 'submit', icon: 'fas fa-save', label: 'GameOrchestra.UI.Save' }];
    return { items: formattedItems, buttons, hintKey: axisUi.hintKey, addLabelKey: axisUi.addLabelKey };
  }

  /**
   * Handle adding a new entry
   */
  static handleAddItem(event, target) {
    event.preventDefault();
    const axisUi = this.constructor.axisUi;
    this.items.push({ id: '', label: axisUi.newItemLabel, icon: 'fas fa-music', color: '#3b82f6' });
    this.render(false);
  }

  /**
   * Handle deleting an entry. Refuses to delete the axis's currently active
   * entry (the one game.settings' activeMood/activePhase currently names) -
   * every scene/token currently resolving that overlay would fall through to
   * "no override" the instant it's gone, an audible change nobody asked for
   * and one this form's Save can't even warn about the way the orphan case
   * below does (there is no music-side "override" to flag, the ACTIVE overlay
   * itself would just vanish). The GM must switch away from it first.
   */
  static handleDeleteItem(event, target) {
    event.preventDefault();
    const axisUi = this.constructor.axisUi;
    const index = parseInt(target.dataset.index);
    if (isNaN(index) || index < 0 || index >= this.items.length) return;

    const entry = this.items[index];
    const activeSetting = CONST.overlayAxes[this.constructor.axis].activeSetting;
    const activeId = game.settings.get(CONST.moduleId, activeSetting) || '';
    if (entry?.id && entry.id === activeId) {
      ui.notifications?.warn(game.i18n.localize(axisUi.deleteActiveBlockedKey));
      return;
    }

    const [removed] = this.items.splice(index, 1);
    // Saving without this entry leaves any scene/token/global overrides that reference
    // its id in place but unreachable; warn rather than silently sweep world documents.
    if (removed?.id) {
      const label = removed.label?.startsWith('GameOrchestra.') ? game.i18n.localize(removed.label) : removed.label;
      ui.notifications?.warn(`${game.i18n.localize(axisUi.deleteOrphanWarningKey)}: ${label || removed.id}`);
    }
    this.render(false);
  }

  /**
   * Handle resetting entries to the axis's built-in defaults
   */
  static handleResetDefaults(event, target) {
    event.preventDefault();
    this.items = foundry.utils.deepClone(this.constructor.axisUi.defaults);
    this.render(false);
  }

  /**
   * Handle form submission
   */
  static async formHandler(event, form, formData) {
    const axisUi = this.constructor.axisUi;
    const expanded = foundry.utils.expandObject(formData.object);
    const rawItems = expanded.items ? Object.values(expanded.items) : [];

    const seenIds = new Set();
    const cleanedItems = rawItems
      .map((m) => {
        const label = (m.label || '').trim();
        // Preserve an existing row's id across renames so scene/token/global overrides
        // keyed by that id keep resolving; only mint a fresh id for newly-added rows.
        const existingId = (m.id || '').trim();
        const baseId = existingId || canonicalizeId(label) || `${axisUi.idPrefix}-${Date.now()}`;
        let uniqueId = baseId;
        let suffix = 2;
        while (seenIds.has(uniqueId)) {
          uniqueId = `${baseId}-${suffix}`;
          suffix++;
        }
        seenIds.add(uniqueId);
        return {
          id: uniqueId,
          label: label,
          icon: m.icon || 'fas fa-music',
          color: m.color || '#3b82f6'
        };
      })
      .filter((m) => m.label.length > 0);

    const axisNoun = this.constructor.axis === 'phase' ? 'phases' : 'moods';
    try {
      await game.settings.set(CONST.moduleId, axisUi.listSetting, cleanedItems);
      log(3, `Successfully saved configured ${axisNoun}:`, cleanedItems);
      this.close();
    } catch (error) {
      log(1, `Failed to save configured ${axisNoun}:`, error);
      ui.notifications.error(game.i18n.localize(axisUi.saveFailedKey));
    }
  }
}

/**
 * World mood definitions - the area-section overlay axis.
 */
export class MoodConfigApp extends OverlayConfigApp {
  static axis = 'mood';
  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-mood-config',
    window: { title: 'GameOrchestra.MoodConfig.Title', icon: 'fas fa-sliders-h', resizable: true, minimizable: true },
    // 'game-orchestra-overlay-config' carries the shared list-editor layout CSS - the
    // axis-specific class stays too, for anything that ever needs to target
    // just one of the two (confirmed live: without the shared class, this app
    // and PhaseConfigApp each only matched their own class name, so the CSS -
    // written once, scoped to '.game-orchestra-mood-config' - silently never applied
    // to PhaseConfigApp at all and its rows rendered as unstyled stacked blocks).
    classes: ['game-orchestra-overlay-config', 'game-orchestra-mood-config']
  };
}

/**
 * World phase definitions - the combat-section overlay axis (the boss-phase
 * counterpart to moods; see overlays-and-loop-modes-plan.md O1).
 */
export class PhaseConfigApp extends OverlayConfigApp {
  static axis = 'phase';
  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-phase-config',
    window: { title: 'GameOrchestra.PhaseConfig.Title', icon: 'fas fa-skull', resizable: true, minimizable: true },
    classes: ['game-orchestra-overlay-config', 'game-orchestra-phase-config']
  };
}
