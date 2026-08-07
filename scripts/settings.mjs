import { MoodWidget } from './mood-widget.mjs';
import { PlaylistTreeApp } from './playlist-tree.mjs';
import { CONST } from './config.mjs';
import { setDebugEnabled, emitHook } from './helpers.mjs';
import { setSuppression } from './transport.mjs';
import { reassertDuck } from './playlist-mix-apply.mjs';

/**
 * The last active id seen on each overlay axis, so `gameOrchestraOverlayChanged` can report what
 * the value changed *from*.
 *
 * Foundry's `onChange` is handed only the new value, and by the time it runs the setting has
 * already been written - so there is no way to read the previous one back out. Cached here
 * instead.
 * @type {{mood: string|null, phase: string|null}}
 */
const _lastOverlayId = { mood: null, phase: null };

/**
 * Seed {@link _lastOverlayId} from the stored settings.
 *
 * Called from the `ready` hook, not from registerSettings(): registration runs during `init`,
 * where a setting's stored value is not necessarily readable yet. Priming at all is what makes
 * the **first** overlay change of a session report a correct `from` - seeding lazily inside the
 * change handler instead would silently swallow exactly that one, which is the change a listener
 * is most likely to be watching for.
 */
export function primeOverlayBaseline() {
  for (const axis of Object.keys(_lastOverlayId)) {
    try {
      _lastOverlayId[axis] = game.settings.get(CONST.moduleId, CONST.overlayAxes[axis].activeSetting) || '';
    } catch {
      _lastOverlayId[axis] = '';
    }
  }
}

/**
 * Fire `gameOrchestraOverlayChanged` for one axis, tracking the previous value.
 *
 * One hook carrying its axis rather than two hooks - see CONST.hooks.OVERLAY_CHANGED.
 * @param {'mood'|'phase'} axis
 * @param {string} to - The new active id ('' when cleared).
 */
function emitOverlayChanged(axis, to) {
  const from = _lastOverlayId[axis] ?? '';
  _lastOverlayId[axis] = to || '';
  if (from === (to || '')) return;
  emitHook(CONST.hooks.OVERLAY_CHANGED, { axis, from, to: to || '' });
}

/**
 * Register module settings and configuration menu
 */
export function registerSettings() {
  // ONE menu entry, deliberately (docs/wiki/ux.md UX-4): Foundry's settings tab
  // holds settings, not an app launcher. The mood and phase list editors used to
  // own two more entries here; they are now the two tabs of a single Overlays
  // window reached from the hub, which is where a GM is already looking at the
  // moods and phases those definitions feed.
  game.settings.registerMenu(CONST.moduleId, 'playlistTreeMenu', {
    name: 'GameOrchestra.PlaylistTree.Name',
    label: 'GameOrchestra.PlaylistTree.Label',
    hint: 'GameOrchestra.PlaylistTree.Hint',
    icon: 'fas fa-music',
    type: PlaylistTreeApp,
    restricted: true
  });

  game.settings.register(CONST.moduleId, CONST.settings.defaultMusic, {
    scope: 'world',
    config: false,
    type: Object,
    default: { documentName: 'DefaultMusic', data: { 'game-orchestra': { music: {} } } }
  });

  game.settings.register(CONST.moduleId, CONST.settings.activeMood, {
    name: 'GameOrchestra.Settings.ActiveMood.Name',
    scope: 'world',
    config: false,
    type: String,
    default: '',
    onChange: (newMood) => {
      emitOverlayChanged('mood', newMood);
      game.gameOrchestra?.musicController?.playCurrentTrack();

      const refreshApp = (app) => {
        if (!app || !app.rendered) return;
        const name = app.constructor?.name;
        if (name === 'MoodWidget' || name === 'PlaylistTreeApp') {
          app.render(false);
        } else if (name === 'GameOrchestraConfig') {
          app.selectedMood = newMood || '';
          app.render(false);
        }
      };

      if (typeof ui !== 'undefined' && ui.windows) {
        for (const app of Object.values(ui.windows)) refreshApp(app);
      }
      if (foundry?.applications?.instances) {
        for (const app of foundry.applications.instances.values()) refreshApp(app);
      }
    }
  });

  game.settings.register(CONST.moduleId, CONST.settings.configuredMoods, {
    name: 'GameOrchestra.Settings.ConfiguredMoods.Name',
    scope: 'world',
    config: false,
    type: Array,
    default: CONST.defaultMoods,
    onChange: () => {
      const refreshApp = (app) => {
        if (app && app.rendered && ['MoodWidget', 'PlaylistTreeApp', 'GameOrchestraConfig'].includes(app.constructor?.name)) {
          app.render(false);
        }
      };

      if (typeof ui !== 'undefined' && ui.windows) {
        for (const app of Object.values(ui.windows)) refreshApp(app);
      }
      if (foundry?.applications?.instances) {
        for (const app of foundry.applications.instances.values()) refreshApp(app);
      }
    }
  });

  // activePhase/configuredPhases mirror activeMood/configuredMoods exactly -
  // the combat-section counterpart overlay axis (config.mjs#overlayAxes).
  game.settings.register(CONST.moduleId, CONST.settings.activePhase, {
    name: 'GameOrchestra.Settings.ActivePhase.Name',
    scope: 'world',
    config: false,
    type: String,
    default: '',
    onChange: (newPhase) => {
      emitOverlayChanged('phase', newPhase);
      game.gameOrchestra?.musicController?.playCurrentTrack();

      const refreshApp = (app) => {
        if (!app || !app.rendered) return;
        const name = app.constructor?.name;
        if (name === 'MoodWidget' || name === 'PlaylistTreeApp') {
          app.render(false);
        } else if (name === 'GameOrchestraConfig') {
          app.selectedPhase = newPhase || '';
          app.render(false);
        }
      };

      if (typeof ui !== 'undefined' && ui.windows) {
        for (const app of Object.values(ui.windows)) refreshApp(app);
      }
      if (foundry?.applications?.instances) {
        for (const app of foundry.applications.instances.values()) refreshApp(app);
      }
    }
  });

  game.settings.register(CONST.moduleId, CONST.settings.configuredPhases, {
    name: 'GameOrchestra.Settings.ConfiguredPhases.Name',
    scope: 'world',
    config: false,
    type: Array,
    default: CONST.defaultPhases,
    onChange: () => {
      const refreshApp = (app) => {
        if (app && app.rendered && ['MoodWidget', 'PlaylistTreeApp', 'GameOrchestraConfig'].includes(app.constructor?.name)) {
          app.render(false);
        }
      };

      if (typeof ui !== 'undefined' && ui.windows) {
        for (const app of Object.values(ui.windows)) refreshApp(app);
      }
      if (foundry?.applications?.instances) {
        for (const app of foundry.applications.instances.values()) refreshApp(app);
      }
    }
  });

  // Resets activePhase back to the world's first configured phase when combat
  // ends (hooks.mjs#handleDeleteCombat), so the next fight doesn't inherit the
  // previous one's phase (e.g. starting in "Enrage"). Default on: the surprise
  // is a fight starting in the wrong phase, not this setting existing.
  game.settings.register(CONST.moduleId, CONST.settings.resetPhaseOnCombatEnd, {
    name: 'GameOrchestra.Settings.ResetPhaseOnCombatEnd.Name',
    hint: 'GameOrchestra.Settings.ResetPhaseOnCombatEnd.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(CONST.moduleId, CONST.settings.moodWidgetPosition, {
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  // Transient duck state, written by the head GM whenever an additive layer starts or stops
  // (MusicController#_syncLayers) and read by every client's mix application. A WORLD setting
  // rather than engine state precisely because it has to reach every client: the engine is
  // head-GM-only, but volume is applied per client from the document (CLAUDE.md rule 5), so a
  // duck known only to the GM would duck only the GM. Same shape of solution as activeMood /
  // activePhase, and the onChange below is what re-levels audio already playing.
  game.settings.register(CONST.moduleId, CONST.settings.activeDuck, {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
    onChange: () => reassertDuck()
  });

  game.settings.register(CONST.moduleId, CONST.settings.fadeDuration, {
    name: 'GameOrchestra.Settings.FadeDuration.Name',
    hint: 'GameOrchestra.Settings.FadeDuration.Hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0, max: 10, step: 0.5 },
    default: 0
  });

  game.settings.register(CONST.moduleId, CONST.settings.graphCrossfade, {
    name: 'GameOrchestra.Settings.GraphCrossfade.Name',
    hint: 'GameOrchestra.Settings.GraphCrossfade.Hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0, max: 1000, step: 25 },
    default: 0
  });

  game.settings.register(CONST.moduleId, CONST.settings.suppressArea, {
    name: 'GameOrchestra.Settings.SuppressArea.Name',
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
    onChange: () => {
      game.gameOrchestra?.musicController?.playCurrentTrack();
    }
  });

  game.settings.register(CONST.moduleId, CONST.settings.suppressCombat, {
    name: 'GameOrchestra.Settings.SuppressCombat.Name',
    scope: 'world',
    config: false,
    type: Boolean,
    default: false,
    onChange: () => {
      game.gameOrchestra?.musicController?.playCurrentTrack();
    }
  });

  // The whole enforcement boundary for user-supplied inline code (Script nodes in inline mode).
  // Default OFF, and it must stay that way: the graph is a flag on a
  // Playlist document, so anyone with OWNER on that playlist can *store* code, and the engine runs
  // it on the head GM's client with GM privileges. Turning this on is the GM saying they trust
  // whoever can edit their playlists.
  //
  // Deliberately NOT paired with a per-user `MACRO_SCRIPT` check at execution time: the engine only
  // ever runs on the head GM, who always has that permission, so such a gate would defend nothing.
  // See docs/api-and-script-node-plan.md B5 - that mistake was in the plan before it was in code.
  //
  // Macro-mode Script nodes are unaffected: those go through core's own Macro#canExecute, which
  // includes core's gating of script-macro *authorship*.
  game.settings.register(CONST.moduleId, CONST.settings.allowInlineScripts, {
    name: 'GameOrchestra.Settings.AllowInlineScripts.Name',
    hint: 'GameOrchestra.Settings.AllowInlineScripts.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

  // How long a Script node may hold its token before the engine gives up, follows the exit, and
  // logs. A hanging promise (an un-awaited dialog, a fetch to a dead host) would otherwise strand
  // the token silently and permanently - the same class of failure as the stop-before-start race.
  //
  // Configurable rather than a hard constant because a legitimately slow script would otherwise
  // have no recourse but a fork; 5 s is long enough for a chat message and a document update.
  game.settings.register(CONST.moduleId, CONST.settings.scriptTimeout, {
    name: 'GameOrchestra.Settings.ScriptTimeout.Name',
    hint: 'GameOrchestra.Settings.ScriptTimeout.Hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 500, max: 60000, step: 500 },
    default: 5000
  });

  game.settings.register(CONST.moduleId, 'enableDebug', {
    name: 'GameOrchestra.Settings.EnableDebug.Name',
    hint: 'GameOrchestra.Settings.EnableDebug.Hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange: (value) => setDebugEnabled(value)
  });
  // log()'s hot path (called on every graph node hop by
  // custom-playback-engine.mjs) reads this cached value instead of
  // game.settings.get() on every single call; onChange above keeps it in
  // sync after registration.
  setDebugEnabled(game.settings.get(CONST.moduleId, 'enableDebug'));
}

/**
 * Register keybindings
 */
export function registerKeybindings() {
  // All four actions either mutate world-scoped settings or open GM-only management
  // apps, so every binding is restricted - a player pressing one should see nothing
  // happen, not a swallowed permission error.
  //
  // All four also ship BOUND. They previously registered with no `editable` default,
  // which meant every keybinding route the docs advertise was dead on arrival: the
  // binding existed in the Configure Controls list and did nothing until the GM
  // assigned a key by hand. A play-time shortcut nobody has bound is not a shortcut.
  //
  // Alt+<letter> throughout: Foundry core reserves plain letters (canvas tools) and
  // Ctrl+<letter> (undo, copy, paste, save), but leaves Alt+<letter> combinations
  // alone - core's only Alt use is the bare Alt held down to highlight objects, which
  // takes no letter with it. These are defaults, not decrees; Foundry flags any
  // collision with another module in Configure Controls and the GM can rebind.
  const alt = (key) => [{ key, modifiers: ['Alt'] }];

  game.keybindings.register(CONST.moduleId, 'toggleAreaMusic', {
    name: 'GameOrchestra.Keybindings.ToggleAreaMusic',
    restricted: true,
    editable: alt('KeyA'),
    onDown: () => toggleAreaMusic()
  });

  game.keybindings.register(CONST.moduleId, 'toggleCombatMusic', {
    name: 'GameOrchestra.Keybindings.ToggleCombatMusic',
    restricted: true,
    editable: alt('KeyC'),
    onDown: () => toggleCombatMusic()
  });

  game.keybindings.register(CONST.moduleId, 'toggleMoodWidget', {
    name: 'GameOrchestra.Keybindings.ToggleMoodWidget',
    restricted: true,
    editable: alt('KeyM'),
    onDown: () => MoodWidget.toggle()
  });

  game.keybindings.register(CONST.moduleId, 'togglePlaylistTree', {
    name: 'GameOrchestra.Keybindings.TogglePlaylistTree',
    restricted: true,
    editable: alt('KeyO'),
    onDown: () => PlaylistTreeApp.toggle()
  });
}

/**
 * Toggle area music suppression - the keybinding's route into the shared
 * transport action every other host also dispatches through (transport.mjs).
 */
async function toggleAreaMusic() {
  return setSuppression(CONST.settings.suppressArea);
}

/**
 * Toggle combat music suppression
 */
async function toggleCombatMusic() {
  return setSuppression(CONST.settings.suppressCombat);
}
