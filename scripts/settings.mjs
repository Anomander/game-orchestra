import { MoodConfigApp, PhaseConfigApp } from './mood-config.mjs';
import { MoodWidget } from './mood-widget.mjs';
import { PlaylistTreeApp } from './playlist-tree.mjs';
import { CONST } from './config.mjs';
import { log, setDebugEnabled } from './helpers.mjs';

/**
 * Register module settings and configuration menu
 */
export function registerSettings() {
  game.settings.registerMenu(CONST.moduleId, 'playlistTreeMenu', {
    name: 'GameOrchestra.PlaylistTree.Name',
    label: 'GameOrchestra.PlaylistTree.Label',
    hint: 'GameOrchestra.PlaylistTree.Hint',
    icon: 'fas fa-sitemap',
    type: PlaylistTreeApp,
    restricted: true
  });

  game.settings.registerMenu(CONST.moduleId, 'moodConfigMenu', {
    name: 'GameOrchestra.Settings.MoodConfig.Name',
    label: 'GameOrchestra.Settings.MoodConfig.Label',
    hint: 'GameOrchestra.Settings.MoodConfig.Hint',
    icon: 'fas fa-sliders-h',
    type: MoodConfigApp,
    restricted: true
  });

  game.settings.registerMenu(CONST.moduleId, 'phaseConfigMenu', {
    name: 'GameOrchestra.Settings.PhaseConfig.Name',
    label: 'GameOrchestra.Settings.PhaseConfig.Label',
    hint: 'GameOrchestra.Settings.PhaseConfig.Hint',
    icon: 'fas fa-skull',
    type: PhaseConfigApp,
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
  game.keybindings.register(CONST.moduleId, 'toggleAreaMusic', {
    name: 'GameOrchestra.Keybindings.ToggleAreaMusic',
    restricted: true,
    onDown: () => toggleAreaMusic()
  });

  game.keybindings.register(CONST.moduleId, 'toggleCombatMusic', {
    name: 'GameOrchestra.Keybindings.ToggleCombatMusic',
    restricted: true,
    onDown: () => toggleCombatMusic()
  });

  game.keybindings.register(CONST.moduleId, 'toggleMoodWidget', {
    name: 'GameOrchestra.Keybindings.ToggleMoodWidget',
    restricted: true,
    onDown: () => MoodWidget.toggle()
  });

  game.keybindings.register(CONST.moduleId, 'togglePlaylistTree', {
    name: 'GameOrchestra.Keybindings.TogglePlaylistTree',
    restricted: true,
    onDown: () => PlaylistTreeApp.toggle()
  });
}

/**
 * Toggle area music suppression
 */
async function toggleAreaMusic() {
  const current = game.settings.get(CONST.moduleId, CONST.settings.suppressArea);
  const target = !current;
  try {
    await game.settings.set(CONST.moduleId, CONST.settings.suppressArea, target);
    log(3, `Successfully toggled area music suppression to: ${target}`);
  } catch (error) {
    log(1, `Failed to toggle area music suppression to ${target}:`, error);
  }
  ui.controls.initialize();
}

/**
 * Toggle combat music suppression
 */
async function toggleCombatMusic() {
  const current = game.settings.get(CONST.moduleId, CONST.settings.suppressCombat);
  const target = !current;
  try {
    await game.settings.set(CONST.moduleId, CONST.settings.suppressCombat, target);
    log(3, `Successfully toggled combat music suppression to: ${target}`);
  } catch (error) {
    log(1, `Failed to toggle combat music suppression to ${target}:`, error);
  }
  ui.controls.initialize();
}
