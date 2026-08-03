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
 * The world's overlay dictionary: one window, two tabs - moods (the area-section
 * axis) and phases (the combat-section axis). See config.mjs#overlayAxes.
 *
 * **One window, two doors.** Moods and phases are one mechanism on two axes, so
 * they are one surface (docs/wiki/ux.md UX-1). MoodConfigApp and PhaseConfigApp
 * below still exist, but they are no longer separate windows - they only pick
 * which tab opens first, and they deliberately share this class's `id` so that
 * opening one while the other is up re-focuses the same window rather than
 * stacking a second copy.
 *
 * Foundry's ApplicationV2 deep-merges DEFAULT_OPTIONS across the prototype
 * chain, so the shared `actions` map defined here (pointing at this class's own
 * static handlers) is inherited by both subclasses automatically.
 *
 * Every handler resolves its axis through `axisUiFor(app)`, which reads the
 * *instance*'s `activeAxis` first and only falls back to the class's `static
 * axis`. That fallback is what lets a caller (or a test) drive a handler with a
 * bare `{ constructor: PhaseConfigApp }` context and still land on the right
 * setting.
 */
export class OverlayConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {'mood'|'phase'} The tab a given door opens on. */
  static axis = 'mood';

  static DEFAULT_OPTIONS = {
    // Shared by both subclasses on purpose - see the class doc. Two ids would
    // mean two independently-positioned windows editing overlapping state.
    id: 'game-orchestra-overlay-config',
    tag: 'form',
    form: {
      handler: OverlayConfigApp.formHandler,
      closeOnSubmit: false,
      submitOnChange: false
    },
    position: { width: 480, height: 'auto' },
    window: { title: 'GameOrchestra.OverlayConfig.Title', icon: 'fas fa-masks-theater', resizable: true, minimizable: true },
    classes: ['game-orchestra-overlay-config'],
    actions: {
      addItem: OverlayConfigApp.handleAddItem,
      deleteItem: OverlayConfigApp.handleDeleteItem,
      resetDefaults: OverlayConfigApp.handleResetDefaults,
      selectAxis: OverlayConfigApp.handleSelectAxis
    }
  };

  /** @override */
  static PARTS = { form: { template: 'modules/game-orchestra/templates/overlay-config.hbs' } };

  /**
   * Resolve the axis a handler should act on: the live instance's current tab
   * when there is one, otherwise the class's own axis.
   * @param {object} app - The handler's `this`
   * @returns {'mood'|'phase'}
   */
  static axisOf(app) {
    const axis = app?.activeAxis || app?.constructor?.axis;
    return AXIS_UI[axis] ? axis : 'mood';
  }

  /**
   * @param {object} app - The handler's `this`
   * @returns {typeof AXIS_UI['mood']}
   */
  static axisUiFor(app) {
    return AXIS_UI[OverlayConfigApp.axisOf(app)];
  }

  /**
   * @param {object} [options]
   * @param {'mood'|'phase'} [options.axis] - Tab to open on; defaults to the class's axis.
   */
  constructor(options = {}) {
    super(options);
    this.activeAxis = AXIS_UI[options.axis] ? options.axis : (this.constructor.axis || 'mood');
    // Both lists are loaded up front and edited in memory, so switching tabs
    // never costs unsaved work and one Save commits both (see formHandler).
    this.itemsByAxis = {
      mood: foundry.utils.deepClone(game.settings.get(CONST.moduleId, AXIS_UI.mood.listSetting) || AXIS_UI.mood.defaults),
      phase: foundry.utils.deepClone(game.settings.get(CONST.moduleId, AXIS_UI.phase.listSetting) || AXIS_UI.phase.defaults)
    };
  }

  /**
   * The active tab's rows. A getter/setter pair rather than a plain field so
   * that every handler below keeps reading and writing `this.items` exactly as
   * it did when this was two single-axis windows.
   * @returns {Array<object>}
   */
  get items() {
    return this.itemsByAxis[this.activeAxis];
  }

  set items(value) {
    this.itemsByAxis[this.activeAxis] = value;
  }

  /**
   * Read the rendered rows back into `itemsByAxis` before the active tab is
   * swapped out. Without this, typing a label and then switching tabs would
   * silently discard the edit - the DOM is the only place it lived.
   *
   * Deliberately a hand-rolled DOM read rather than FormDataExtended: it needs
   * no Foundry API surface, and it is parsing the same four inputs the form
   * handler does.
   * @private
   */
  _harvestActiveAxis() {
    const rows = this.element?.querySelectorAll?.('.mood-item[data-index]');
    if (!rows?.length) return;
    this.itemsByAxis[this.activeAxis] = Array.from(rows).map((row) => ({
      id: row.querySelector('input[name$=".id"]')?.value ?? '',
      label: row.querySelector('input[name$=".label"]')?.value ?? '',
      icon: row.querySelector('select[name$=".icon"]')?.value || 'fas fa-music',
      color: row.querySelector('input[name$=".color"]')?.value || '#3b82f6'
    }));
  }

  /** @override */
  _prepareContext(_options) {
    const axisUi = this.constructor.axisUiFor(this);
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
    const tabs = [
      { axis: 'mood', label: 'GameOrchestra.OverlayConfig.Tab.Moods', icon: 'fas fa-masks-theater', active: this.activeAxis === 'mood' },
      { axis: 'phase', label: 'GameOrchestra.OverlayConfig.Tab.Phases', icon: 'fas fa-skull', active: this.activeAxis === 'phase' }
    ];
    return { items: formattedItems, buttons, tabs, hintKey: axisUi.hintKey, addLabelKey: axisUi.addLabelKey };
  }

  /**
   * Switch tabs, preserving whatever the user has typed into the tab being left.
   */
  static handleSelectAxis(event, target) {
    event.preventDefault();
    const axis = target?.dataset?.axis;
    if (!AXIS_UI[axis] || axis === this.activeAxis) return;
    this._harvestActiveAxis?.();
    this.activeAxis = axis;
    this.render(false);
  }

  /**
   * Handle adding a new entry
   */
  static handleAddItem(event, target) {
    event.preventDefault();
    const axisUi = OverlayConfigApp.axisUiFor(this);
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
    const axisUi = OverlayConfigApp.axisUiFor(this);
    const index = parseInt(target.dataset.index);
    if (isNaN(index) || index < 0 || index >= this.items.length) return;

    const entry = this.items[index];
    const activeSetting = CONST.overlayAxes[OverlayConfigApp.axisOf(this)].activeSetting;
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
    this.items = foundry.utils.deepClone(OverlayConfigApp.axisUiFor(this).defaults);
    this.render(false);
  }

  /**
   * Normalize a set of raw rows into storable entries: canonical unique ids,
   * trimmed labels, defaults filled in, blank rows dropped.
   * @param {Array<object>} rawItems
   * @param {typeof AXIS_UI['mood']} axisUi
   * @returns {Array<object>}
   * @private
   */
  static _cleanRows(rawItems, axisUi) {
    const seenIds = new Set();
    return rawItems
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
  }

  /**
   * Handle form submission.
   *
   * Saves **both** axes, not just the visible tab: the form only ever renders
   * the active one, so the other tab's edits live in `itemsByAxis` and would be
   * dropped by a save that only wrote what the DOM contained.
   *
   * The inactive axis is written only when it actually differs from what is
   * stored - a world setting write is a database round-trip broadcast to every
   * client, and its onChange re-renders open windows, so saving an unchanged
   * phase list on every mood edit would be pure churn. It is also skipped
   * entirely when `itemsByAxis` is absent, which is what lets a caller drive
   * this handler with a bare single-axis context.
   */
  static async formHandler(event, form, formData) {
    const axis = OverlayConfigApp.axisOf(this);
    const axisUi = AXIS_UI[axis];
    const expanded = foundry.utils.expandObject(formData.object);
    const rawItems = expanded.items ? Object.values(expanded.items) : [];
    const cleanedItems = OverlayConfigApp._cleanRows(rawItems, axisUi);

    const writes = [[axisUi.listSetting, cleanedItems]];

    const otherAxis = axis === 'mood' ? 'phase' : 'mood';
    const otherRaw = this.itemsByAxis?.[otherAxis];
    if (otherRaw) {
      const otherUi = AXIS_UI[otherAxis];
      const otherCleaned = OverlayConfigApp._cleanRows(otherRaw, otherUi);
      const stored = game.settings.get(CONST.moduleId, otherUi.listSetting) || otherUi.defaults;
      if (JSON.stringify(stored) !== JSON.stringify(otherCleaned)) writes.push([otherUi.listSetting, otherCleaned]);
    }

    const axisNoun = axis === 'phase' ? 'phases' : 'moods';
    try {
      for (const [setting, value] of writes) await game.settings.set(CONST.moduleId, setting, value);
      log(3, `Successfully saved configured ${axisNoun}:`, cleanedItems);
      this.close();
    } catch (error) {
      log(1, `Failed to save configured ${axisNoun}:`, error);
      ui.notifications.error(game.i18n.localize(axisUi.saveFailedKey));
    }
  }
}

/**
 * Door onto the Overlays window's **Moods** tab - the area-section axis.
 *
 * Not a window of its own: it inherits OverlayConfigApp's `id`, so it opens (or
 * re-focuses) the same single window and merely decides which tab is showing.
 * It stays a named class because `game.settings.registerMenu` and the playlist
 * tree's footer both need something constructible to point at.
 *
 * The axis-specific class on the frame is retained for CSS that ever needs to
 * target one tab's chrome. The shared 'game-orchestra-overlay-config' class
 * carries the list-editor layout and must never be dropped (confirmed live:
 * without it the CSS - written once, scoped to '.game-orchestra-mood-config' -
 * silently never applied to the phase door at all, and its rows rendered as
 * unstyled stacked blocks).
 */
export class MoodConfigApp extends OverlayConfigApp {
  static axis = 'mood';
  static DEFAULT_OPTIONS = {
    classes: ['game-orchestra-overlay-config', 'game-orchestra-mood-config']
  };
}

/**
 * Door onto the Overlays window's **Phases** tab - the combat-section axis (the
 * boss-phase counterpart to moods; see overlays-and-loop-modes-plan.md O1).
 * Same single window as MoodConfigApp above; see its doc.
 */
export class PhaseConfigApp extends OverlayConfigApp {
  static axis = 'phase';
  static DEFAULT_OPTIONS = {
    classes: ['game-orchestra-overlay-config', 'game-orchestra-phase-config']
  };
}
