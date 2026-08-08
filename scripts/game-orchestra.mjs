import { registerSettings, registerKeybindings } from './settings.mjs';
import { MusicController } from './music-controller.mjs';
import { MoodWidget } from './mood-widget.mjs';
import { MoodConfigApp, PhaseConfigApp } from './mood-config.mjs';
import { CustomPlaylistEditor } from './custom-playlist-editor.mjs';
import { PlaylistMixerApp } from './playlist-mixer.mjs';
import { log } from './helpers.mjs';
import { CONST } from './config.mjs';
import { createApi } from './api.mjs';
import { GameOrchestraConfig } from './app.mjs';
import {
  getSceneControlButtons,
  handleCanvasReady,
  handleCreateCombatant,
  handleDeleteCombat,
  handleDeleteCombatant,
  handlePlaylistConfigRender,
  handlePlaylistContextMenu,
  handleReady,
  handleSceneConfigRender,
  handleTokenConfigRender,
  handleUpdateActor,
  handleUpdateCombat,
  handleUpdateCombatant,
  handleUpdatePlaylist,
  handleUpdatePlaylistSound,
  handleUpdateScene,
  handleUpdateToken,
  handleUserConnected
} from './hooks.mjs';

/**
 * The window classes that were reachable on `game.gameOrchestra` before the API existed, mapped
 * to what a caller should use instead.
 *
 * They stay reachable and keep working - someone with a macro that opens one did nothing wrong.
 * Each logs a **one-time** deprecation on first access: a macro in a loop would otherwise flood
 * the console, and a warning nobody can read is not a warning.
 *
 * `musicController` is deliberately NOT in here. `settings.mjs`'s own onChange handlers reach
 * through `game.gameOrchestra?.musicController` on every mood/phase change, so warning on it
 * would fire the module's deprecation at itself.
 */
const LEGACY_APP_KEYS = {
  GameOrchestraConfig: [GameOrchestraConfig, "PlaylistTreeApp.openScopedDocument(doc) - the hub scoped to one document - or api.bind.* headless"],
  MoodWidget: [MoodWidget, 'no replacement yet'],
  MoodConfigApp: [MoodConfigApp, 'no replacement yet'],
  PhaseConfigApp: [PhaseConfigApp, 'no replacement yet'],
  CustomPlaylistEditor: [CustomPlaylistEditor, 'api.graph.* for reading and writing graphs'],
  PlaylistMixerApp: [PlaylistMixerApp, 'api.mix.* for reading and writing levels']
};

/**
 * Build the object published at both `game.gameOrchestra` and
 * `game.modules.get('game-orchestra').api`.
 *
 * One object under two names, not two objects: the canonical name is the Foundry convention and
 * the only one another module author will guess, while the legacy one already has consumers in
 * the wild. Splitting them would let the two drift.
 * @returns {object}
 */
function buildPublicObject() {
  const published = {
    ...createApi(),
    musicController: new MusicController(),
    moodWidget: null
  };
  for (const [key, [value, replacement]] of Object.entries(LEGACY_APP_KEYS)) {
    let warned = false;
    Object.defineProperty(published, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (!warned) {
          warned = true;
          const message = `game.gameOrchestra.${key} is legacy and not part of the supported API. Use ${replacement}. See docs/wiki/api.md.`;
          // NOT log(2, …): levels 2 and 3 are gated behind the `enableDebug` setting, so a
          // deprecation routed through them is invisible to precisely the people who need to
          // read it. Foundry's own mechanism is the right one here - it respects the user's
          // compatibility-warning preference and is what every other module's deprecations use -
          // with a plain console.warn fallback so this still says something on a client where it
          // is missing.
          if (typeof foundry?.utils?.logCompatibilityWarning === 'function') {
            // No `since`/`until`: those are version numbers, and there is no removal version to
            // promise yet - the API contract is still 0.x. Claiming one would be a commitment
            // this plan has not made.
            foundry.utils.logCompatibilityWarning(message);
          } else {
            console.warn('Game Orchestra |', message);
          }
        }
        return value;
      }
    });
  }
  return published;
}

Hooks.once('init', async () => {
  log(3, 'Initializing Game Orchestra module');
  const published = buildPublicObject();
  game.gameOrchestra = published;
  const self = game.modules?.get?.(CONST.moduleId);
  if (self) self.api = published;
  registerSettings();
  registerKeybindings();

  // The `parts/` entries are PARTIALS, included by both the hub and GameOrchestraConfig rather
  // than rendered on their own (docs/wiki/ux.md UX-2). loadTemplates registers each under its
  // full path, which is the name the {{> "modules/game-orchestra/..."}} includes use.
  await loadTemplates([
    'modules/game-orchestra/templates/music-config.hbs',
    'modules/game-orchestra/templates/mood-widget.hbs',
    'modules/game-orchestra/templates/overlay-config.hbs',
    'modules/game-orchestra/templates/custom-playlist-editor.hbs',
    'modules/game-orchestra/templates/parts/combat-grid.hbs',
    'modules/game-orchestra/templates/parts/binding-tools.hbs'
  ]);
});
Hooks.once('ready', handleReady);
Hooks.on('getSceneControlButtons', getSceneControlButtons);
Hooks.on('renderSceneConfig', handleSceneConfigRender);
Hooks.on('renderPlaylistConfig', handlePlaylistConfigRender);
Hooks.on('updateCombat', handleUpdateCombat);
Hooks.on('deleteCombat', handleDeleteCombat);
Hooks.on('canvasReady', handleCanvasReady);
Hooks.on('updateScene', handleUpdateScene);
Hooks.on('updatePlaylist', handleUpdatePlaylist);
// Runs on EVERY client, not just the head GM: each client applies volume itself from the
// document, so a mix applied only where the engine runs would be inaudible to the players
// (playlist-mix-apply.mjs).
Hooks.on('updatePlaylistSound', handleUpdatePlaylistSound);
Hooks.on('getPlaylistContextOptions', handlePlaylistContextMenu);
Hooks.on('updateActor', handleUpdateActor);
Hooks.on('updateToken', handleUpdateToken);
Hooks.on('createCombatant', handleCreateCombatant);
Hooks.on('deleteCombatant', handleDeleteCombatant);
Hooks.on('updateCombatant', handleUpdateCombatant);
Hooks.on('renderTokenApplication', handleTokenConfigRender);
Hooks.on('userConnected', handleUserConnected);
