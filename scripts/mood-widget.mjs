import { CONST } from './config.mjs';
import { log } from './helpers.mjs';
import { PlaylistTreeApp } from './playlist-tree.mjs';
import { suppressionState, setSuppression, resolutionPills } from './transport.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Dockable / Floating Mood Widget application for GMs
 */
export class MoodWidget extends HandlebarsApplicationMixin(ApplicationV2) {
  _positionSaveTimer = null;

  static DEFAULT_OPTIONS = {
    id: 'game-orchestra-mood-widget',
    tag: 'div',
    window: {
      title: 'GameOrchestra.MoodWidget.Title',
      icon: 'fas fa-sliders-h',
      resizable: false,
      minimizable: false
    },
    classes: ['game-orchestra-mood-widget'],
    position: { width: 260, height: 'auto' },
    actions: {
      setMood: MoodWidget.handleSetMood,
      setPhase: MoodWidget.handleSetPhase,
      toggleSuppression: MoodWidget.handleToggleSuppression,
      refreshMood: MoodWidget.handleRefreshMood,
      toggleDock: MoodWidget.handleToggleDock,
      toggleCompact: MoodWidget.handleToggleCompact,
      openPlaylistTree: MoodWidget.handleOpenPlaylistTree
    }
  };

  /** @override */
  static PARTS = { main: { template: 'modules/game-orchestra/templates/mood-widget.hbs' } };

  /** @override */
  async _renderFrame(options) {
    const frame = await super._renderFrame(options);
    if (!this.hasFrame) return frame;

    const pos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
    const isDocked = !!pos.isDocked;
    const dockedIcon = isDocked ? 'fa-window-maximize' : 'fa-anchor';

    const closeBtn = frame.querySelector('.window-header [data-action="close"]');
    if (closeBtn) {
      let treeBtn = frame.querySelector('[data-action="openPlaylistTree"]');
      if (!treeBtn) {
        const treeBtnHtml = `<button type="button" class="header-control fa-solid fa-sitemap icon" data-action="openPlaylistTree" data-tooltip="${game.i18n.localize('GameOrchestra.PlaylistTree.Title')}" aria-label="Open Playlist Tree"></button>`;
        closeBtn.insertAdjacentHTML('beforebegin', treeBtnHtml);
      }

      let refreshBtn = frame.querySelector('[data-action="refreshMood"]');
      if (!refreshBtn) {
        const refreshBtnHtml = `<button type="button" class="header-control fa-solid fa-sync-alt icon" data-action="refreshMood" data-tooltip="${game.i18n.localize('GameOrchestra.MoodWidget.Refresh')}" aria-label="Refresh Mood"></button>`;
        closeBtn.insertAdjacentHTML('beforebegin', refreshBtnHtml);
      }

      let compactBtn = frame.querySelector('[data-action="toggleCompact"]');
      if (!compactBtn) {
        const compactBtnHtml = `<button type="button" class="header-control fa-solid fa-compress icon" data-action="toggleCompact" data-tooltip="${game.i18n.localize('GameOrchestra.MoodWidget.ToggleCompact')}" aria-label="Toggle Compact Mode"></button>`;
        closeBtn.insertAdjacentHTML('beforebegin', compactBtnHtml);
      }

      let dockBtn = frame.querySelector('[data-action="toggleDock"]');
      if (!dockBtn) {
        const dockBtnHtml = `<button type="button" class="header-control fa-solid ${dockedIcon} icon" data-action="toggleDock" data-tooltip="${game.i18n.localize('GameOrchestra.MoodWidget.Dock')}" aria-label="Toggle Dock"></button>`;
        closeBtn.insertAdjacentHTML('beforebegin', dockBtnHtml);
      } else {
        dockBtn.className = `header-control fa-solid ${dockedIcon} icon`;
      }
    }
    return frame;
  }

  /** @override */
  _prepareContext(_options) {
    // Moods apply to area music, phases to combat (config.mjs#sectionAxis) - the
    // widget shows ONLY whichever axis is actually live right now: phases while
    // combat is active, moods otherwise. The inactive axis is not rendered at
    // all (not even dimmed) - a strip a GM can't currently act on has no reason
    // to take up space in a small dockable widget.
    const inCombat = !!game.combats?.active?.started;
    const activeMood = game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    const activePhase = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    const configuredMoods = game.settings.get(CONST.moduleId, CONST.settings.configuredMoods) || CONST.defaultMoods;
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const pos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};

    const moods = configuredMoods.map((m) => ({
      ...m,
      isActive: m.id === activeMood
    }));
    const phases = configuredPhases.map((p) => ({
      ...p,
      isActive: p.id === activePhase
    }));

    const activeMoodObj = configuredMoods.find((m) => m.id === activeMood) || null;
    const activePhaseObj = configuredPhases.find((p) => p.id === activePhase) || null;

    // The transport carries suppression and "what is winning" as well as the axis
    // strip - these are the three things a GM needs mid-session, and they used to be
    // spread across this widget, the scene-control bar and the 820px tree
    // (docs/wiki/ux.md D5/UX-6). Both come from transport.mjs so the bar and this
    // widget cannot disagree.
    const suppression = suppressionState().map((control) => ({
      ...control,
      title: game.i18n.localize(control.titleKey)
    }));
    const pills = resolutionPills(game.scenes?.active || null);

    return {
      inCombat,
      activeMood,
      moods,
      activeMoodObj,
      activePhase,
      phases,
      activePhaseObj,
      suppression,
      activeResolution: pills.active,
      layerResolutions: pills.layers,
      isDocked: !!pos.isDocked
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    const pos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
    const isDocked = !!pos.isDocked;

    // Update window header icon and title with whichever axis is currently
    // live - phase during combat, mood otherwise (see _prepareContext).
    const iconEl = this.element.querySelector('.window-header .window-icon');
    const titleEl = this.element.querySelector('.window-header .window-title');
    const activeObj = context.inCombat ? context.activePhaseObj : context.activeMoodObj;

    if (activeObj) {
      const moodLabel = activeObj.label?.startsWith('GameOrchestra.') ? game.i18n.localize(activeObj.label) : activeObj.label;
      if (titleEl) titleEl.textContent = moodLabel;
      if (iconEl) iconEl.className = `window-icon fa-fw ${activeObj.icon}`;
    } else {
      const defaultLabel = game.i18n.localize('GameOrchestra.Default');
      if (titleEl) titleEl.textContent = defaultLabel;
      if (iconEl) iconEl.className = 'window-icon fa-fw fas fa-music';
    }

    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.style.pointerEvents = 'auto';

      // Double-click listener on title text checking e.detail === 2
      titleEl.onclick = (e) => {
        if (e.detail === 2) {
          e.preventDefault();
          e.stopPropagation();
          MoodWidget.handleToggleCompact(e, titleEl);
        }
      };
    }

    // Restore compact state from saved position
    if (pos.isCompact) {
      this.element.classList.add('compact');
      const compactBtn = this.element.querySelector('[data-action="toggleCompact"]');
      if (compactBtn) compactBtn.className = 'header-control fa-solid fa-expand icon';
    }

    if (isDocked) {
      const container = document.querySelector('#ui-left-column-1') || document.querySelector('#ui-left');
      if (container) {
        // Appearance (position, size, opacity/hover fade) is fully handled by
        // the .game-orchestra-mood-widget.docked CSS rule - toggling the class is
        // all that's needed here.
        this.element.classList.add('docked');

        const players = container.querySelector('#players') || document.querySelector('#players');

        if (players && players.parentNode) {
          if (this.element.previousElementSibling !== players) {
            players.after(this.element);
          }
        } else if (!container.contains(this.element)) {
          container.appendChild(this.element);
        }
      }
    } else {
      this.element.classList.remove('docked');

      const uiTop = document.querySelector('#ui-top') || document.body;
      const leftColumn = document.querySelector('#ui-left-column-1') || document.querySelector('#ui-left');

      if (leftColumn && leftColumn.contains(this.element)) {
        uiTop.appendChild(this.element);
        const top = pos.top ?? 120;
        const left = pos.left ?? 120;
        this.setPosition({ top, left, width: 260 });
      } else if (this.position.top == null || this.position.left == null) {
        const top = pos.top ?? 120;
        const left = pos.left ?? 120;
        this.setPosition({ top, left, width: 260 });
      }
    }
  }

  /** @override */
  _onPosition(position) {
    super._onPosition(position);
    const currentPos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
    if (currentPos.isDocked) {
      // Docked appearance is CSS-driven (see .game-orchestra-mood-widget.docked);
      // docked position isn't user-draggable, so it's never persisted.
      return;
    }
    if (!currentPos.isDocked && position.top != null && position.left != null) {
      if (currentPos.top !== position.top || currentPos.left !== position.left) {
        clearTimeout(this._positionSaveTimer);
        this._positionSaveTimer = setTimeout(() => {
          game.settings.set(CONST.moduleId, CONST.settings.moodWidgetPosition, {
            ...currentPos,
            top: position.top,
            left: position.left
          });
        }, 500);
      }
    }
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    if (game.gameOrchestra?.moodWidget === this) {
      game.gameOrchestra.moodWidget = null;
    }
    // Persist closed state so it is not re-opened on next page load
    try {
      const currentPos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
      game.settings.set(CONST.moduleId, CONST.settings.moodWidgetPosition, { ...currentPos, isOpen: false });
    } catch (e) { /* settings not available */ }
  }

  static async handleSetMood(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const button = target.closest('[data-mood-id]') || target;
    const moodId = button.dataset?.moodId ?? '';
    const currentActive = game.settings.get(CONST.moduleId, CONST.settings.activeMood) || '';
    // Clicking the already-active mood is a no-op, not a toggle-off - moods (like
    // phases) have no "none" state a GM picks deliberately; there must always be
    // an active one once any has been set, exactly like handleSetPhase below.
    if (moodId === currentActive) return;
    try {
      await game.settings.set(CONST.moduleId, CONST.settings.activeMood, moodId);
      log(3, `Active mood set to: '${moodId || 'none'}'`);
    } catch (error) {
      log(1, 'Error setting active mood:', error);
    }
  }

  /**
   * The combat-section counterpart to handleSetMood - sets the world's active
   * phase (config.mjs#sectionAxis), the mechanism a GM uses to advance a boss
   * fight or any other combat-only overlay.
   */
  static async handleSetPhase(event, target) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const button = target.closest('[data-phase-id]') || target;
    const phaseId = button.dataset?.phaseId ?? '';
    const currentActive = game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '';
    // Clicking the already-active phase is a no-op, not a toggle-off - see
    // handleSetMood's comment above for why.
    if (phaseId === currentActive) return;
    try {
      await game.settings.set(CONST.moduleId, CONST.settings.activePhase, phaseId);
      log(3, `Active phase set to: '${phaseId || 'none'}'`);
    } catch (error) {
      log(1, 'Error setting active phase:', error);
    }
  }

  /**
   * Toggle one suppression setting from the widget. Dispatches into the same
   * transport action the scene-control bar and the keybindings use, which is also
   * what keeps the bar's own toggle state in step (transport.mjs#setSuppression).
   */
  static async handleToggleSuppression(event, target) {
    event?.preventDefault?.();
    if (!game.user.isGM) return;
    const button = target.closest('[data-setting]') || target;
    const setting = button.dataset?.setting;
    if (!setting) return;
    await setSuppression(setting);
    const widget = game.gameOrchestra?.moodWidget || (this instanceof MoodWidget ? this : null);
    widget?.render(false);
  }

  /**
   * Handle re-triggering the current mood selection
   */
  static async handleRefreshMood(event, target) {
    event?.preventDefault?.();
    if (game.gameOrchestra?.musicController) {
      await game.gameOrchestra.musicController.playCurrentTrack();
    }
  }

  /**
   * Handle opening the playlist hierarchy tree manager window
   */
  static handleOpenPlaylistTree(event, target) {
    event?.preventDefault?.();
    PlaylistTreeApp.open();
  }

  /**
   * Toggle compact mode for the widget
   */
  static handleToggleCompact(event, target) {
    event?.preventDefault?.();
    const widget = game.gameOrchestra?.moodWidget || (this instanceof MoodWidget ? this : null);
    if (!widget?.element) return;
    const isCompact = widget.element.classList.toggle('compact');
    const compactBtn = widget.element.querySelector('[data-action="toggleCompact"]');
    if (compactBtn) {
      compactBtn.className = `header-control fa-solid ${isCompact ? 'fa-expand' : 'fa-compress'} icon`;
    }
    // Persist compact state
    try {
      const currentPos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
      game.settings.set(CONST.moduleId, CONST.settings.moodWidgetPosition, { ...currentPos, isCompact });
    } catch (e) { /* settings not available */ }
  }

  /**
   * Toggle docked mode for the widget
   */
  static async handleToggleDock(event, target) {
    event?.preventDefault?.();
    const currentPos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
    const newDocked = !currentPos.isDocked;

    const dockBtn = target?.closest?.('[data-action="toggleDock"]') || target;
    if (dockBtn) {
      dockBtn.className = `header-control fa-solid ${newDocked ? 'fa-window-maximize' : 'fa-anchor'} icon`;
    }

    await game.settings.set(CONST.moduleId, CONST.settings.moodWidgetPosition, {
      ...currentPos,
      isDocked: newDocked
    });
    const widget = game.gameOrchestra?.moodWidget || (this instanceof MoodWidget ? this : null);
    if (widget?.rendered) widget.render(true);
  }

  /**
   * Toggle window visibility
   */
  static toggle() {
    if (!game.gameOrchestra) return;
    if (game.gameOrchestra.moodWidget && game.gameOrchestra.moodWidget.rendered) {
      game.gameOrchestra.moodWidget.close();
      game.gameOrchestra.moodWidget = null;
      return;
    }
    MoodWidget.open();
  }

  /**
   * Open the widget and persist the open state
   */
  static open() {
    if (!game.gameOrchestra || !game.user.isGM) return;
    if (game.gameOrchestra.moodWidget?.rendered) return;
    game.gameOrchestra.moodWidget = new MoodWidget();
    game.gameOrchestra.moodWidget.render(true);
    // Persist open state
    try {
      const currentPos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
      game.settings.set(CONST.moduleId, CONST.settings.moodWidgetPosition, { ...currentPos, isOpen: true });
    } catch (e) { /* settings not available */ }
  }
}
