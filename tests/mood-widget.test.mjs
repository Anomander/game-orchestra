import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting } from './mocks/foundry.mjs';

setupFoundryMocks();

import { MoodWidget } from '../scripts/mood-widget.mjs';
import { PlaylistTreeApp } from '../scripts/playlist-tree.mjs';
import { CONST } from '../scripts/config.mjs';

/**
 * A queryable element stub.
 *
 * There is no jsdom here (see docs/wiki/testing.md), and the widget is unusual among this
 * module's applications in that most of its behaviour *is* DOM manipulation - header button
 * injection, class toggling, title rewriting. So the stub models the four things the widget
 * actually uses: `querySelector` against an explicit selector map, a real Set-backed `classList`
 * (including `toggle`, which returns the resulting state and which `handleToggleCompact` reads),
 * `insertAdjacentHTML` recorded rather than parsed, and `closest` against an explicit map.
 * @param {object} [overrides] - Fields to assign onto the stub after construction.
 * @returns {object} The element stub.
 */
function makeEl(overrides = {}) {
  const classes = new Set(overrides._classes ?? []);
  const el = {
    className: '',
    textContent: '',
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    previousElementSibling: null,
    /** Every `insertAdjacentHTML` call, as `{position, html}` - assertions read the markup back. */
    inserted: [],
    /** Selector -> element, consulted by `querySelector`. */
    query: {},
    /** Selector -> element, consulted by `closest`. */
    ancestors: {},
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c) => {
        if (classes.has(c)) {
          classes.delete(c);
          return false;
        }
        classes.add(c);
        return true;
      }
    },
    querySelector: (sel) => el.query[sel] ?? null,
    closest: (sel) => el.ancestors[sel] ?? null,
    insertAdjacentHTML: (position, html) => el.inserted.push({ position, html }),
    appendChild: (child) => {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    after: vi.fn(),
    contains: (node) => el.children.includes(node)
  };
  return Object.assign(el, overrides);
}

/** @returns {string} The concatenated markup of every `insertAdjacentHTML` call on `el`. */
function insertedHtml(el) {
  return el.inserted.map((entry) => entry.html).join('');
}

describe('MoodWidget', () => {
  beforeEach(() => {
    setupFoundryMocks();
    // The widget reaches for real document-level containers when docking. Absent in the mock,
    // and a bare vi.fn() returning undefined is exactly the "no such container" case.
    globalThis.document.querySelector = vi.fn(() => null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* -------------------------------------------- */
  /*  _prepareContext                             */
  /* -------------------------------------------- */

  describe('_prepareContext', () => {
    it('shows moods out of combat and phases in combat, and never both', () => {
      const widget = new MoodWidget();

      const peace = widget._prepareContext({});
      expect(peace.inCombat).toBe(false);

      game.combats.active = { started: true };
      const war = widget._prepareContext({});
      expect(war.inCombat).toBe(true);

      // Both strips are always *computed* - `inCombat` is what the template switches on, and
      // the widget renders only the live axis (see the method's own comment). What matters is
      // that the flag tracks combat, and that each strip carries its own axis's entries.
      expect(peace.moods.map((m) => m.id)).toEqual(CONST.defaultMoods.map((m) => m.id));
      expect(war.phases.map((p) => p.id)).toEqual(CONST.defaultPhases.map((p) => p.id));
    });

    it('falls back to the shipped defaults when neither axis has been configured', () => {
      const context = new MoodWidget()._prepareContext({});
      expect(context.moods).toHaveLength(CONST.defaultMoods.length);
      expect(context.phases).toHaveLength(CONST.defaultPhases.length);
    });

    it('marks exactly the active entry on each axis', () => {
      setMockSetting(CONST.moduleId, CONST.settings.activeMood, 'stealth');
      setMockSetting(CONST.moduleId, CONST.settings.activePhase, 'enrage');

      const context = new MoodWidget()._prepareContext({});

      expect(context.moods.filter((m) => m.isActive).map((m) => m.id)).toEqual(['stealth']);
      expect(context.phases.filter((p) => p.isActive).map((p) => p.id)).toEqual(['enrage']);
      expect(context.activeMoodObj.id).toBe('stealth');
      expect(context.activePhaseObj.id).toBe('enrage');
    });

    it('reports a null active object when the stored id matches nothing configured', () => {
      // A mood deleted from the config while still selected. The header falls back to the
      // default icon/title rather than rendering an entry that no longer exists.
      setMockSetting(CONST.moduleId, CONST.settings.activeMood, 'deleted-mood');

      const context = new MoodWidget()._prepareContext({});

      expect(context.activeMood).toBe('deleted-mood');
      expect(context.activeMoodObj).toBeNull();
      expect(context.moods.some((m) => m.isActive)).toBe(false);
    });

    it('carries the transport suppression toggles with their live state, localized', () => {
      setMockSetting(CONST.moduleId, CONST.settings.suppressArea, true);

      const context = new MoodWidget()._prepareContext({});

      const area = context.suppression.find((c) => c.setting === CONST.settings.suppressArea);
      const combat = context.suppression.find((c) => c.setting === CONST.settings.suppressCombat);
      expect(area.active).toBe(true);
      expect(combat.active).toBe(false);
      // The widget localizes at the render boundary; transport.mjs only ever emits the key.
      expect(area.title).toBe('GameOrchestra.Controls.SuppressAreaMusic');
    });

    it('reports no resolution pill when nothing is playing', () => {
      const context = new MoodWidget()._prepareContext({});
      expect(context.activeResolution).toBeNull();
      expect(context.layerResolutions).toEqual([]);
    });

    it('resolves its pill against the active scene, so it agrees with the tree', () => {
      const scene = { documentName: 'Scene', name: 'Cavern' };
      game.scenes.active = scene;
      game.gameOrchestra.musicController = {
        currentContext: { contextEntity: scene, isOverlay: false },
        currentLayerContexts: []
      };

      const context = new MoodWidget()._prepareContext({});

      expect(context.activeResolution.label).toContain('ActiveAudioSceneDefault');
    });

    it('reports the docked flag from persisted position', () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      expect(new MoodWidget()._prepareContext({}).isDocked).toBe(true);
    });
  });

  /* -------------------------------------------- */
  /*  _renderFrame                                */
  /* -------------------------------------------- */

  describe('_renderFrame', () => {
    /** @returns {{widget: MoodWidget, frame: object, closeBtn: object}} A frame with a close button. */
    function frameWithCloseButton() {
      const widget = new MoodWidget();
      const closeBtn = makeEl();
      const frame = makeEl();
      frame.query['.window-header [data-action="close"]'] = closeBtn;
      widget._mockFrame = frame;
      widget.hasFrame = true;
      return { widget, frame, closeBtn };
    }

    it('injects its four header controls before the close button', async () => {
      const { widget, closeBtn } = frameWithCloseButton();

      await widget._renderFrame({});

      const html = insertedHtml(closeBtn);
      for (const action of ['openPlaylistTree', 'refreshMood', 'toggleCompact', 'toggleDock']) {
        expect(html).toContain(`data-action="${action}"`);
      }
      expect(closeBtn.inserted.every((entry) => entry.position === 'beforebegin')).toBe(true);
    });

    it('does not inject a second copy when the controls already exist', async () => {
      const { widget, frame, closeBtn } = frameWithCloseButton();
      const dockBtn = makeEl();
      frame.query['[data-action="openPlaylistTree"]'] = makeEl();
      frame.query['[data-action="refreshMood"]'] = makeEl();
      frame.query['[data-action="toggleCompact"]'] = makeEl();
      frame.query['[data-action="toggleDock"]'] = dockBtn;

      await widget._renderFrame({});

      expect(closeBtn.inserted).toHaveLength(0);
    });

    it('re-syncs the existing dock button icon to the persisted state', async () => {
      // The frame survives re-renders, so a dock toggle that only ever ran on first mount
      // would leave the anchor icon showing while the widget is docked.
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      const { widget, frame } = frameWithCloseButton();
      const dockBtn = makeEl({ className: 'header-control fa-solid fa-anchor icon' });
      frame.query['[data-action="toggleDock"]'] = dockBtn;

      await widget._renderFrame({});

      expect(dockBtn.className).toContain('fa-window-maximize');
      expect(dockBtn.className).not.toContain('fa-anchor');
    });

    it('injects the dock button already showing the docked icon when docked', async () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      const { widget, closeBtn } = frameWithCloseButton();

      await widget._renderFrame({});

      const dockHtml = closeBtn.inserted.find((entry) => entry.html.includes('toggleDock')).html;
      expect(dockHtml).toContain('fa-window-maximize');
    });

    it('returns a frameless frame untouched', async () => {
      const widget = new MoodWidget();
      const frame = makeEl();
      widget._mockFrame = frame;
      widget.hasFrame = false;

      expect(await widget._renderFrame({})).toBe(frame);
    });

    it('tolerates a frame with no close button rather than throwing', async () => {
      const widget = new MoodWidget();
      widget._mockFrame = makeEl();
      widget.hasFrame = true;

      await expect(widget._renderFrame({})).resolves.toBeDefined();
    });
  });

  /* -------------------------------------------- */
  /*  _onRender                                   */
  /* -------------------------------------------- */

  describe('_onRender', () => {
    /** @returns {{widget: MoodWidget, icon: object, title: object}} A widget with a queryable header. */
    function renderedWidget() {
      const widget = new MoodWidget();
      const icon = makeEl();
      const title = makeEl();
      const element = makeEl();
      element.query['.window-header .window-icon'] = icon;
      element.query['.window-header .window-title'] = title;
      widget.element = element;
      widget.position = { top: 10, left: 10 };
      widget.setPosition = vi.fn();
      return { widget, icon, title, element };
    }

    it('titles the header with the live axis entry - phase in combat, mood otherwise', () => {
      const { widget, icon, title } = renderedWidget();

      widget._onRender({ inCombat: false, activeMoodObj: { label: 'Sneaky', icon: 'fas fa-user-ninja' }, activePhaseObj: { label: 'Enrage', icon: 'fas fa-fire' } }, {});
      expect(title.textContent).toBe('Sneaky');
      expect(icon.className).toContain('fas fa-user-ninja');

      widget._onRender({ inCombat: true, activeMoodObj: { label: 'Sneaky', icon: 'fas fa-user-ninja' }, activePhaseObj: { label: 'Enrage', icon: 'fas fa-fire' } }, {});
      expect(title.textContent).toBe('Enrage');
      expect(icon.className).toContain('fas fa-fire');
    });

    it('localizes a built-in label but passes a GM-authored one through verbatim', () => {
      const { widget, title } = renderedWidget();

      widget._onRender({ inCombat: false, activeMoodObj: { label: 'GameOrchestra.Mood.Calm', icon: 'fas fa-leaf' }, activePhaseObj: null }, {});
      expect(title.textContent).toBe('GameOrchestra.Mood.Calm'); // localize() is identity in the mock
      expect(game.i18n.localize).toHaveBeenCalledWith('GameOrchestra.Mood.Calm');

      game.i18n.localize.mockClear();
      widget._onRender({ inCombat: false, activeMoodObj: { label: 'Skulking About', icon: 'fas fa-leaf' }, activePhaseObj: null }, {});
      expect(title.textContent).toBe('Skulking About');
      expect(game.i18n.localize).not.toHaveBeenCalledWith('Skulking About');
    });

    it('falls back to the default title and note icon when no overlay is active', () => {
      const { widget, icon, title } = renderedWidget();

      widget._onRender({ inCombat: false, activeMoodObj: null, activePhaseObj: null }, {});

      expect(title.textContent).toBe('GameOrchestra.Default');
      expect(icon.className).toBe('window-icon fa-fw fas fa-music');
    });

    it('wires the title to toggle compact on a double click only', () => {
      const { widget, title, element } = renderedWidget();
      const compactBtn = makeEl();
      element.query['[data-action="toggleCompact"]'] = compactBtn;
      game.gameOrchestra.moodWidget = widget;

      widget._onRender({ inCombat: false, activeMoodObj: null, activePhaseObj: null }, {});

      const singleClick = { detail: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      title.onclick(singleClick);
      expect(element.classList.contains('compact')).toBe(false);

      const doubleClick = { detail: 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      title.onclick(doubleClick);
      expect(doubleClick.preventDefault).toHaveBeenCalled();
      expect(element.classList.contains('compact')).toBe(true);
    });

    it('restores persisted compact state and its expand icon', () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isCompact: true });
      const { widget, element } = renderedWidget();
      const compactBtn = makeEl();
      element.query['[data-action="toggleCompact"]'] = compactBtn;

      widget._onRender({ inCombat: false, activeMoodObj: null, activePhaseObj: null }, {});

      expect(element.classList.contains('compact')).toBe(true);
      expect(compactBtn.className).toBe('header-control fa-solid fa-expand icon');
    });

    it('adds the docked class and parks itself after the players list when docked', () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      const { widget, element } = renderedWidget();
      const players = makeEl();
      players.parentNode = makeEl();
      const container = makeEl();
      container.query['#players'] = players;
      globalThis.document.querySelector = vi.fn((sel) => (sel === '#ui-left-column-1' ? container : null));

      widget._onRender({ inCombat: false, activeMoodObj: null, activePhaseObj: null }, {});

      expect(element.classList.contains('docked')).toBe(true);
      expect(players.after).toHaveBeenCalledWith(element);
    });

    it('drops the docked class and restores the saved floating position when undocked', () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: false, top: 300, left: 400 });
      const { widget, element } = renderedWidget();
      element._classes = undefined;
      widget.position = { top: null, left: null };
      const leftColumn = makeEl();
      globalThis.document.querySelector = vi.fn((sel) => (sel === '#ui-left-column-1' ? leftColumn : null));

      widget._onRender({ inCombat: false, activeMoodObj: null, activePhaseObj: null }, {});

      expect(element.classList.contains('docked')).toBe(false);
      expect(widget.setPosition).toHaveBeenCalledWith({ top: 300, left: 400, width: 260 });
    });
  });

  /* -------------------------------------------- */
  /*  _onPosition                                 */
  /* -------------------------------------------- */

  describe('_onPosition', () => {
    it('persists a moved floating widget, debounced', () => {
      vi.useFakeTimers();
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { top: 10, left: 10 });
      const widget = new MoodWidget();

      widget._onPosition({ top: 50, left: 60 });
      expect(game.settings.set).not.toHaveBeenCalled(); // still inside the debounce

      vi.advanceTimersByTime(500);
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ top: 50, left: 60 }));
    });

    it('collapses a drag into a single write', () => {
      vi.useFakeTimers();
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { top: 10, left: 10 });
      const widget = new MoodWidget();

      widget._onPosition({ top: 20, left: 20 });
      widget._onPosition({ top: 30, left: 30 });
      widget._onPosition({ top: 40, left: 40 });
      vi.advanceTimersByTime(500);

      expect(game.settings.set).toHaveBeenCalledTimes(1);
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ top: 40, left: 40 }));
    });

    it('never persists position while docked - docked placement is CSS-driven', () => {
      vi.useFakeTimers();
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      const widget = new MoodWidget();

      widget._onPosition({ top: 50, left: 60 });
      vi.advanceTimersByTime(1000);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('ignores a reposition that did not actually move', () => {
      vi.useFakeTimers();
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { top: 50, left: 60 });
      const widget = new MoodWidget();

      widget._onPosition({ top: 50, left: 60 });
      vi.advanceTimersByTime(1000);

      expect(game.settings.set).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------- */
  /*  handleSetMood / handleSetPhase              */
  /* -------------------------------------------- */

  describe('handleSetMood', () => {
    it('stores the clicked mood id', async () => {
      const event = { preventDefault: vi.fn() };
      const target = makeEl();
      target.ancestors['[data-mood-id]'] = makeEl({ dataset: { moodId: 'tense' } });

      await MoodWidget.handleSetMood(event, target);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activeMood, 'tense');
    });

    it('treats a click on the already-active mood as a no-op, not a toggle-off', async () => {
      // Deliberate: moods have no "none" state a GM picks on purpose, so re-clicking the live
      // one must not clear it. Same rule as handleSetPhase - see the source comment.
      setMockSetting(CONST.moduleId, CONST.settings.activeMood, 'tense');
      const target = makeEl();
      target.ancestors['[data-mood-id]'] = makeEl({ dataset: { moodId: 'tense' } });

      await MoodWidget.handleSetMood({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('does nothing for a non-GM', async () => {
      game.user.isGM = false;
      const target = makeEl();
      target.ancestors['[data-mood-id]'] = makeEl({ dataset: { moodId: 'tense' } });

      await MoodWidget.handleSetMood({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('falls back to the click target itself when no [data-mood-id] ancestor matches', async () => {
      const target = makeEl({ dataset: { moodId: 'victory' } });

      await MoodWidget.handleSetMood({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activeMood, 'victory');
    });

    it('swallows a settings write failure rather than surfacing an unhandled rejection', async () => {
      game.settings.set.mockRejectedValueOnce(new Error('Permission denied'));
      const target = makeEl();
      target.ancestors['[data-mood-id]'] = makeEl({ dataset: { moodId: 'calm' } });

      await expect(MoodWidget.handleSetMood({ preventDefault: vi.fn() }, target)).resolves.toBeUndefined();
    });
  });

  describe('handleSetPhase', () => {
    it('stores the clicked phase id', async () => {
      const target = makeEl();
      target.ancestors['[data-phase-id]'] = makeEl({ dataset: { phaseId: 'enrage' } });

      await MoodWidget.handleSetPhase({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.activePhase, 'enrage');
    });

    it('treats a click on the already-active phase as a no-op', async () => {
      setMockSetting(CONST.moduleId, CONST.settings.activePhase, 'enrage');
      const target = makeEl();
      target.ancestors['[data-phase-id]'] = makeEl({ dataset: { phaseId: 'enrage' } });

      await MoodWidget.handleSetPhase({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('does nothing for a non-GM', async () => {
      game.user.isGM = false;
      const target = makeEl();
      target.ancestors['[data-phase-id]'] = makeEl({ dataset: { phaseId: 'p2' } });

      await MoodWidget.handleSetPhase({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('swallows a settings write failure', async () => {
      game.settings.set.mockRejectedValueOnce(new Error('nope'));
      const target = makeEl();
      target.ancestors['[data-phase-id]'] = makeEl({ dataset: { phaseId: 'p1' } });

      await expect(MoodWidget.handleSetPhase({ preventDefault: vi.fn() }, target)).resolves.toBeUndefined();
    });
  });

  /* -------------------------------------------- */
  /*  Remaining actions                           */
  /* -------------------------------------------- */

  describe('handleToggleSuppression', () => {
    it('flips the named setting through the shared transport action and re-renders', async () => {
      const widget = new MoodWidget();
      widget.render = vi.fn();
      game.gameOrchestra.moodWidget = widget;
      const target = makeEl();
      target.ancestors['[data-setting]'] = makeEl({ dataset: { setting: CONST.settings.suppressArea } });

      await MoodWidget.handleToggleSuppression({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressArea, true);
      expect(widget.render).toHaveBeenCalledWith(false);
    });

    it('toggles back off on a second press', async () => {
      setMockSetting(CONST.moduleId, CONST.settings.suppressCombat, true);
      const target = makeEl();
      target.ancestors['[data-setting]'] = makeEl({ dataset: { setting: CONST.settings.suppressCombat } });

      await MoodWidget.handleToggleSuppression({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.suppressCombat, false);
    });

    it('does nothing when the button carries no setting', async () => {
      await MoodWidget.handleToggleSuppression({ preventDefault: vi.fn() }, makeEl());
      expect(game.settings.set).not.toHaveBeenCalled();
    });

    it('does nothing for a non-GM', async () => {
      game.user.isGM = false;
      const target = makeEl();
      target.ancestors['[data-setting]'] = makeEl({ dataset: { setting: CONST.settings.suppressArea } });

      await MoodWidget.handleToggleSuppression({ preventDefault: vi.fn() }, target);

      expect(game.settings.set).not.toHaveBeenCalled();
    });
  });

  describe('handleRefreshMood', () => {
    it('re-triggers the current resolution through the controller', async () => {
      const playCurrentTrack = vi.fn().mockResolvedValue(undefined);
      game.gameOrchestra.musicController = { playCurrentTrack };

      await MoodWidget.handleRefreshMood({ preventDefault: vi.fn() }, makeEl());

      expect(playCurrentTrack).toHaveBeenCalled();
    });

    it('is a no-op before the controller exists', async () => {
      game.gameOrchestra.musicController = null;
      await expect(MoodWidget.handleRefreshMood({ preventDefault: vi.fn() }, makeEl())).resolves.toBeUndefined();
    });
  });

  describe('handleOpenPlaylistTree', () => {
    it('opens the hub', () => {
      const open = vi.spyOn(PlaylistTreeApp, 'open').mockImplementation(() => {});
      const event = { preventDefault: vi.fn() };

      MoodWidget.handleOpenPlaylistTree(event, makeEl());

      expect(event.preventDefault).toHaveBeenCalled();
      expect(open).toHaveBeenCalled();
      open.mockRestore();
    });
  });

  describe('handleToggleCompact', () => {
    it('toggles the class, swaps the icon, and persists the new state', () => {
      const widget = new MoodWidget();
      const element = makeEl();
      const compactBtn = makeEl();
      element.query['[data-action="toggleCompact"]'] = compactBtn;
      widget.element = element;
      game.gameOrchestra.moodWidget = widget;

      MoodWidget.handleToggleCompact({ preventDefault: vi.fn() }, makeEl());
      expect(element.classList.contains('compact')).toBe(true);
      expect(compactBtn.className).toContain('fa-expand');
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isCompact: true }));

      MoodWidget.handleToggleCompact({ preventDefault: vi.fn() }, makeEl());
      expect(element.classList.contains('compact')).toBe(false);
      expect(compactBtn.className).toContain('fa-compress');
      expect(game.settings.set).toHaveBeenLastCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isCompact: false }));
    });

    it('preserves the rest of the stored position when persisting compact state', () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { top: 42, left: 99, isOpen: true });
      const widget = new MoodWidget();
      widget.element = makeEl();
      game.gameOrchestra.moodWidget = widget;

      MoodWidget.handleToggleCompact({ preventDefault: vi.fn() }, makeEl());

      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, { top: 42, left: 99, isOpen: true, isCompact: true });
    });

    it('does nothing when the widget is not rendered', () => {
      game.gameOrchestra.moodWidget = null;
      MoodWidget.handleToggleCompact({ preventDefault: vi.fn() }, makeEl());
      expect(game.settings.set).not.toHaveBeenCalled();
    });
  });

  describe('handleToggleDock', () => {
    it('flips the docked flag, swaps the icon, and re-renders a live widget', async () => {
      const widget = new MoodWidget();
      widget.rendered = true;
      widget.render = vi.fn();
      game.gameOrchestra.moodWidget = widget;
      const dockBtn = makeEl({ className: 'header-control fa-solid fa-anchor icon' });
      const target = makeEl();
      target.ancestors['[data-action="toggleDock"]'] = dockBtn;

      await MoodWidget.handleToggleDock({ preventDefault: vi.fn() }, target);

      expect(dockBtn.className).toContain('fa-window-maximize');
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isDocked: true }));
      // A full re-render, not a content refresh: docking re-parents the element (see _onRender).
      expect(widget.render).toHaveBeenCalledWith(true);
    });

    it('undocks again on a second press', async () => {
      setMockSetting(CONST.moduleId, CONST.settings.moodWidgetPosition, { isDocked: true });
      const dockBtn = makeEl();
      const target = makeEl();
      target.ancestors['[data-action="toggleDock"]'] = dockBtn;

      await MoodWidget.handleToggleDock({ preventDefault: vi.fn() }, target);

      expect(dockBtn.className).toContain('fa-anchor');
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isDocked: false }));
    });

    it('does not re-render a widget that is not rendered', async () => {
      const widget = new MoodWidget();
      widget.rendered = false;
      widget.render = vi.fn();
      game.gameOrchestra.moodWidget = widget;

      await MoodWidget.handleToggleDock({ preventDefault: vi.fn() }, makeEl());

      expect(widget.render).not.toHaveBeenCalled();
    });
  });

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  describe('open / toggle / _onClose', () => {
    it('opens a widget, registers it, and persists the open state', () => {
      const renderSpy = vi.spyOn(MoodWidget.prototype, 'render').mockImplementation(() => {});

      MoodWidget.open();

      expect(game.gameOrchestra.moodWidget).toBeInstanceOf(MoodWidget);
      expect(renderSpy).toHaveBeenCalledWith(true);
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isOpen: true }));
      renderSpy.mockRestore();
    });

    it('does not replace an already-open widget', () => {
      const existing = new MoodWidget();
      existing.rendered = true;
      game.gameOrchestra.moodWidget = existing;

      MoodWidget.open();

      expect(game.gameOrchestra.moodWidget).toBe(existing);
    });

    it('refuses to open for a non-GM', () => {
      game.user.isGM = false;
      MoodWidget.open();
      expect(game.gameOrchestra.moodWidget).toBeNull();
    });

    it('is inert before the module has initialized', () => {
      game.gameOrchestra = undefined;
      expect(() => MoodWidget.toggle()).not.toThrow();
    });

    it('toggle closes a rendered widget and clears the reference', () => {
      const existing = new MoodWidget();
      existing.rendered = true;
      existing.close = vi.fn();
      game.gameOrchestra.moodWidget = existing;

      MoodWidget.toggle();

      expect(existing.close).toHaveBeenCalled();
      expect(game.gameOrchestra.moodWidget).toBeNull();
    });

    it('toggle opens when nothing is rendered', () => {
      const renderSpy = vi.spyOn(MoodWidget.prototype, 'render').mockImplementation(() => {});

      MoodWidget.toggle();

      expect(game.gameOrchestra.moodWidget).toBeInstanceOf(MoodWidget);
      renderSpy.mockRestore();
    });

    it('_onClose clears the reference and persists the closed state', () => {
      const widget = new MoodWidget();
      game.gameOrchestra.moodWidget = widget;

      widget._onClose({});

      expect(game.gameOrchestra.moodWidget).toBeNull();
      expect(game.settings.set).toHaveBeenCalledWith(CONST.moduleId, CONST.settings.moodWidgetPosition, expect.objectContaining({ isOpen: false }));
    });

    it('_onClose leaves a different registered widget alone', () => {
      const other = new MoodWidget();
      game.gameOrchestra.moodWidget = other;

      new MoodWidget()._onClose({});

      expect(game.gameOrchestra.moodWidget).toBe(other);
    });
  });
});
