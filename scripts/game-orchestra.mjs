import { registerSettings, registerKeybindings } from './settings.mjs';
import { MusicController } from './music-controller.mjs';
import { MoodWidget } from './mood-widget.mjs';
import { MoodConfigApp, PhaseConfigApp } from './mood-config.mjs';
import { CustomPlaylistEditor } from './custom-playlist-editor.mjs';
import { PlaylistMixerApp } from './playlist-mixer.mjs';
import { log } from './helpers.mjs';
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

Hooks.once('init', async () => {
  log(3, 'Initializing Game Orchestra module');
  game.gameOrchestra = {
    musicController: new MusicController(),
    GameOrchestraConfig,
    MoodWidget,
    MoodConfigApp,
    PhaseConfigApp,
    CustomPlaylistEditor,
    PlaylistMixerApp,
    moodWidget: null
  };
  registerSettings();
  registerKeybindings();

  await loadTemplates([
    'modules/game-orchestra/templates/music-config.hbs',
    'modules/game-orchestra/templates/mood-widget.hbs',
    'modules/game-orchestra/templates/overlay-config.hbs',
    'modules/game-orchestra/templates/custom-playlist-editor.hbs'
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
