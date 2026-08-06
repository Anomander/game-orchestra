import { CONST } from './config.mjs';
import { log, isCustomPlaylist, getPlaylistById } from './helpers.mjs';
import { MoodWidget } from './mood-widget.mjs';
import { GameOrchestraConfig } from './app.mjs';
import { CustomPlaylistEditor } from './custom-playlist-editor.mjs';
import { PlaylistMixerApp, refreshMixerViews } from './playlist-mixer.mjs';
import { handleUpdatePlaylistMix, handleUpdatePlaylistSoundMix } from './playlist-mix-apply.mjs';
import { suppressionState, setSuppression } from './transport.mjs';
import { PlaylistTreeApp } from './playlist-tree.mjs';

const _loc = (key) => game.i18n.localize(key);

/**
 * Add scene control buttons for music suppression
 * @param {object} controls - The scene controls object
 */
export function getSceneControlButtons(controls) {
  try {
    if (!game.user.isGM) return;
    if (controls.sounds && controls.sounds.tools) {
      // Built from the shared transport definition rather than spelled out here, so
      // this bar and the Mood Widget can never disagree about which toggles exist or
      // what flipping one does (docs/wiki/ux.md UX-2, transport.mjs).
      for (const control of suppressionState()) {
        controls.sounds.tools[control.key] = {
          name: control.key,
          order: control.order,
          title: control.titleKey,
          icon: control.icon,
          toggle: true,
          visible: true,
          active: control.active,
          onChange: (_event, active) => setSuppression(control.setting, active)
        };
      }
      controls.sounds.tools['mood-widget'] = {
        name: 'mood-widget',
        order: 12,
        title: 'GameOrchestra.MoodWidget.Title',
        icon: 'fas fa-sliders-h',
        button: true,
        visible: true,
        onChange: () => {
          MoodWidget.toggle();
        }
      };
      // The hub, one click from the canvas. D6 (docs/wiki/ux.md) is about the settings tab
      // being used as an app launcher; collapsing three menu entries into one fixed the
      // launcher half but left the module's PRIMARY authoring surface four actions deep
      // (Settings -> Module Settings -> scroll -> Open Game Orchestra) while the transport
      // beside it was already one. UX-4 puts world-scoped surfaces behind ONE settings door -
      // that door still exists and is still the only one; this is the same shortcut the Mood
      // Widget has had here all along, not a second home (UX-1).
      controls.sounds.tools['game-orchestra-hub'] = {
        name: 'game-orchestra-hub',
        order: 13,
        title: 'GameOrchestra.PlaylistTree.Label',
        icon: 'fas fa-music',
        button: true,
        visible: true,
        onChange: () => {
          PlaylistTreeApp.toggle();
        }
      };
    } else {
      // A core rename/removal of the 'sounds' scene-control group would
      // otherwise fail silently here - no button, no error, nothing to go on.
      log(2, "Could not find the 'sounds' scene control group (controls.sounds.tools) to add suppression buttons to; has it been renamed in this Foundry version?");
    }
  } catch (error) {
    log(1, 'Error adding scene control buttons:', error);
  }
}

/**
 * Handle scene config render to inject music button
 * @param {object} app - The scene config application
 * @param {HTMLElement} html - The rendered HTML
 */
export function handleSceneConfigRender(app, html) {
  try {
    const playlistSoundSelect = html.querySelector('select[name="playlistSound"]');
    if (!playlistSoundSelect) return;
    const existingFormGroup = playlistSoundSelect.closest('.form-group');
    if (!existingFormGroup) return;
    const newFormGroup = document.createElement('div');
    newFormGroup.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = _loc('GameOrchestra.CombatMusic');
    const formFields = document.createElement('div');
    formFields.className = 'form-fields';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'game-orchestra-scene';
    button.innerHTML = `<i class="fas fa-music"></i> ${_loc('GameOrchestra.ConfigTitle')}`;
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = _loc('GameOrchestra.SceneConfig.Hint');
    formFields.appendChild(button);
    newFormGroup.appendChild(label);
    newFormGroup.appendChild(formFields);
    newFormGroup.appendChild(hint);
    existingFormGroup.insertAdjacentElement('afterend', newFormGroup);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      // Opens the hub narrowed to this scene rather than a second window with a
      // second layout (docs/wiki/ux.md UX-3/D1). Same cards, same immediate writes,
      // same drop targets a GM already knows from the unscoped hub.
      PlaylistTreeApp.openScoped(app.document);
    });
  } catch (error) {
    log(1, 'Error adding scene config button:', error);
  }
}

/**
 * Handle combat updates to trigger music changes
 * @param {object} combat - The combat document
 * @param {object} updateData - The update data
 */
export function handleUpdateCombat(combat, updateData) {
  if ('started' in updateData || (combat.started && (updateData.turn != null || updateData.round != null))) {
    game.gameOrchestra?.musicController?.playCurrentTrack();
    // Combat starting/ending flips which overlay axis is live (moods vs
    // phases - config.mjs#sectionAxis). playCurrentTrack() only re-renders the
    // Mood Widget when the resolved context actually changes, which is not
    // guaranteed here (e.g. no combat playlist configured at all) - so the
    // widget's strip can otherwise keep showing the wrong axis after combat
    // starts. Refresh it directly, unconditionally.
    if ('started' in updateData && game.gameOrchestra?.moodWidget?.rendered) {
      game.gameOrchestra.moodWidget.render(false);
    }
  }
}

/**
 * Handle combat deletion to stop music
 */
export async function handleDeleteCombat() {
  // Reset the active phase before re-resolving, so the re-resolution (and any
  // graph condition/Playlist-node ref reading activePhase) sees the reset
  // value rather than racing it - see resetPhaseOnCombatEnd's registration
  // comment (settings.mjs) for why this exists at all. activePhase's own
  // onChange (settings.mjs) already re-runs playCurrentTrack() and refreshes
  // the Mood Widget when this actually changes the value, so both are only
  // called again here for the case where the phase was already at rest.
  let phaseChanged = false;
  if (game.settings.get(CONST.moduleId, CONST.settings.resetPhaseOnCombatEnd)) {
    const configuredPhases = game.settings.get(CONST.moduleId, CONST.settings.configuredPhases) || CONST.defaultPhases;
    const resetTo = configuredPhases[0]?.id || '';
    if ((game.settings.get(CONST.moduleId, CONST.settings.activePhase) || '') !== resetTo) {
      await game.settings.set(CONST.moduleId, CONST.settings.activePhase, resetTo);
      phaseChanged = true;
    }
  }
  if (!phaseChanged) {
    game.gameOrchestra?.musicController?.playCurrentTrack();
    if (game.gameOrchestra?.moodWidget?.rendered) game.gameOrchestra.moodWidget.render(false);
  }
}

/**
 * Handle combatant creation to refresh music
 * @param {object} combatant - The created combatant
 */
export function handleCreateCombatant(combatant) {
  if (combatant.parent?.started) game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle combatant deletion to refresh music
 * @param {object} combatant - The deleted combatant
 */
export function handleDeleteCombatant(combatant) {
  if (combatant.parent?.started) game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle combatant updates to refresh music when defeated status changes,
 * since a defeated combatant's theme should stop competing for priority
 * @param {object} combatant - The updated combatant
 * @param {object} updateData - The update data
 */
export function handleUpdateCombatant(combatant, updateData) {
  if ('defeated' in updateData && combatant.parent?.started) game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle canvas ready to start music
 */
export function handleCanvasReady() {
  game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle GM connect/disconnect to hand off playback control. isHeadGM() picks the
 * first active GM by id, so headship can change on either a connect or a disconnect;
 * re-running playCurrentTrack on every client is safe since it internally no-ops for
 * anyone who isn't the current head GM.
 */
export function handleUserConnected() {
  game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle Playlist config sheet render to inject a "Custom Playback" button
 * opening the visual graph editor for that playlist.
 *
 * A graph requires UNSEQUENCED (Soundboard) mode - the one Foundry mode that
 * neither auto-advances a finished sound nor stops one to start another, both
 * of which the graph engine requires (H1). This button used to be DISABLED
 * until the GM set that mode by hand, which was a false unavailability: the
 * editor's own save path already forces the mode itself
 * (CustomPlaylistEditor.handleSave), so the gate only ever taught the GM an
 * unrelated concept ("Soundboard") and charged them a click to get past it.
 * UX-9's disable-with-a-reason rule is about things that genuinely cannot
 * work; this always could.
 *
 * The hint still says what saving will do when the mode is about to change, so
 * the mode switch is announced rather than silent.
 *
 * NOTE: anchored on the mode <select> since Playlist#mode is a stable,
 * version-spanning field every config sheet renders - unlike the scene/token
 * config anchors elsewhere in this file, this specific selector and the
 * 'renderPlaylistConfig' hook name have not been verified against a live
 * Foundry v14 build (docs/custom-playlist-plan.md flags this as a required
 * manual verification step before release).
 * @param {object} app - The playlist config application
 * @param {HTMLElement} html - The rendered HTML
 */
export function handlePlaylistConfigRender(app, html) {
  try {
    if (!game.user.isGM) return;
    const modeSelect = html.querySelector('select[name="mode"]');
    const existingFormGroup = modeSelect?.closest('.form-group');
    if (!existingFormGroup) return;
    const newFormGroup = document.createElement('div');
    newFormGroup.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = _loc('GameOrchestra.CustomEditor.FieldLabel');
    const formFields = document.createElement('div');
    formFields.className = 'form-fields';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'game-orchestra-custom-playback';
    button.innerHTML = `<i class="fas fa-project-diagram"></i> ${_loc('GameOrchestra.CustomEditor.OpenButton')}`;
    const hint = document.createElement('p');
    hint.className = 'hint';
    formFields.appendChild(button);
    newFormGroup.appendChild(label);
    newFormGroup.appendChild(formFields);
    newFormGroup.appendChild(hint);
    existingFormGroup.insertAdjacentElement('afterend', newFormGroup);

    const unsequencedMode = globalThis.CONST?.PLAYLIST_MODES?.UNSEQUENCED ?? -1;
    // A playlist that already HAS a graph is already in the right mode for
    // practical purposes, and saying "saving will switch the mode" about it
    // would be a lie - the mode is only re-forced if something changed it.
    const hasGraph = isCustomPlaylist(app.document);
    const applyHint = (rawMode) => {
      const mode = rawMode === '' || rawMode == null ? app.document.mode : rawMode;
      const modeAlreadyRight = Number(mode) === unsequencedMode || hasGraph;
      hint.textContent = _loc(modeAlreadyRight ? 'GameOrchestra.CustomEditor.PlaylistConfigHint' : 'GameOrchestra.CustomEditor.WillSwitchModeHint');
    };

    applyHint(modeSelect.value);
    // The <select> is unsaved UI state, so document.mode alone would leave the
    // hint stale until the sheet is saved and reopened - re-evaluate as the
    // user changes it.
    modeSelect.addEventListener('change', () => applyHint(modeSelect.value));

    button.addEventListener('click', (event) => {
      event.preventDefault();
      new CustomPlaylistEditor(app.document).render(true);
    });

    // The mixer's own row, immediately below. Unlike the graph button above it is NEVER
    // disabled by mode: every playlist type has per-track volumes, a fade, and a crossfade to
    // set, which is the whole reason the mixer exists as a separate window rather than another
    // pane of the graph editor (which only ever opens for an UNSEQUENCED playlist).
    const mixerGroup = document.createElement('div');
    mixerGroup.className = 'form-group';
    const mixerLabel = document.createElement('label');
    mixerLabel.textContent = _loc('GameOrchestra.Mixer.FieldLabel');
    const mixerFields = document.createElement('div');
    mixerFields.className = 'form-fields';
    const mixerButton = document.createElement('button');
    mixerButton.type = 'button';
    mixerButton.dataset.action = 'game-orchestra-mixer';
    mixerButton.innerHTML = `<i class="fas fa-sliders"></i> ${_loc('GameOrchestra.Mixer.OpenButton')}`;
    const mixerHint = document.createElement('p');
    mixerHint.className = 'hint';
    mixerHint.textContent = _loc('GameOrchestra.Mixer.PlaylistConfigHint');
    mixerFields.appendChild(mixerButton);
    mixerGroup.appendChild(mixerLabel);
    mixerGroup.appendChild(mixerFields);
    mixerGroup.appendChild(mixerHint);
    newFormGroup.insertAdjacentElement('afterend', mixerGroup);
    mixerButton.addEventListener('click', (event) => {
      event.preventDefault();
      PlaylistMixerApp.open(app.document);
    });
  } catch (error) {
    log(1, 'Error adding custom playback button to playlist config:', error);
  }
}

/**
 * Handle playlist updates to rebuild a running custom playback engine when its
 * graph is edited or removed via the editor while it's actively playing (H8)
 * @param {object} playlist - The playlist document
 * @param {object} updateData - The update data
 */
export function handleUpdatePlaylist(playlist, updateData) {
  const flags = updateData.flags?.[CONST.moduleId];
  const changed = flags && ('customPlayback' in flags || '-=customPlayback' in flags);
  if (changed) game.gameOrchestra?.musicController?.onCustomGraphChanged(playlist);
  // Deliberately NOT part of the branch above: a mix change re-levels what is already playing
  // in place, on every client, with no engine rebuild and no restart from Start (H9). That
  // separation is the entire reason the mix lives in its own flag - see playlist-mix-apply.mjs.
  handleUpdatePlaylistMix(playlist, updateData);
  refreshMixerViews(playlist);
}

/**
 * Handle PlaylistSound updates - runs on every client, not just the head GM, because volume is
 * applied per client from the document (see playlist-mix-apply.mjs).
 * @param {object} sound - The playlist sound document
 * @param {object} updateData - The update data
 */
export function handleUpdatePlaylistSound(sound, updateData) {
  handleUpdatePlaylistSoundMix(sound, updateData);
  refreshMixerViews(sound?.parent);
}

/**
 * Add "Playback Graph" and "Mixer" entries to each playlist's sidebar context menu. The fastest
 * route to either window - no sheet to open first - and the entry points that work identically
 * for every playlist type.
 *
 * Both of this module's playlist-scoped workbenches are reachable here, in the same order the
 * Playlist config sheet injects them (graph, then mixer - handlePlaylistConfigRender). The mixer
 * had this shortcut on its own for a while and the graph editor did not, which left the more
 * frequently edited of the two costing three extra actions (open the sheet, find the row, click).
 *
 * Entry shape and hook signature are v13+/v14 ApplicationV2: `{label, icon, onClick(event,
 * target)}`, and the menu is anchored on `.playlist > header`, so the playlist id has to be read
 * off the enclosing `[data-entry-id]` rather than the clicked element itself.
 * @param {object} _application - The PlaylistDirectory dispatching the hook
 * @param {Array<object>} entries - The context menu entry list, mutated in place
 */
export function handlePlaylistContextMenu(_application, entries) {
  try {
    if (!game.user.isGM || !Array.isArray(entries)) return;
    /**
     * Resolve the playlist a context-menu click landed on, from the enclosing [data-entry-id].
     * @param {HTMLElement} target
     * @returns {object|null}
     */
    const playlistFor = (target) => {
      const element = target?.closest?.('[data-entry-id]') ?? target;
      return getPlaylistById(element?.dataset?.entryId);
    };
    entries.push({
      // Never mode-gated: the editor's save path forces UNSEQUENCED itself, exactly as the
      // config sheet's button does since the gate came off (handlePlaylistConfigRender).
      label: 'GameOrchestra.CustomEditor.MenuEntry',
      icon: '<i class="fas fa-project-diagram"></i>',
      condition: () => game.user.isGM,
      onClick: (event, target) => {
        const playlist = playlistFor(target);
        if (playlist) new CustomPlaylistEditor(playlist).render(true);
      }
    });
    entries.push({
      label: 'GameOrchestra.Mixer.MenuEntry',
      icon: '<i class="fas fa-sliders"></i>',
      condition: () => game.user.isGM,
      onClick: (event, target) => {
        const playlist = playlistFor(target);
        if (playlist) PlaylistMixerApp.open(playlist);
      }
    });
  } catch (error) {
    log(1, 'Error adding the Game Orchestra entries to the playlist context menu:', error);
  }
}

/**
 * Handle scene updates for music flag changes
 * @param {object} scene - The scene document
 * @param {object} updateData - The update data
 */
export function handleUpdateScene(scene, updateData) {
  const flags = updateData.flags?.[CONST.moduleId];
  const hasMusicFlagChange = flags && ('music' in flags || 'useTokenMusic' in flags);
  const hasActiveChange = 'active' in updateData;

  if (hasMusicFlagChange || hasActiveChange) {
    game.gameOrchestra?.musicController?.playCurrentTrack();
  }
}

/**
 * Handle actor updates for music flag changes
 * @param {object} _actor - The actor document
 * @param {object} updateData - The update data
 */
export function handleUpdateActor(_actor, updateData) {
  const flags = updateData.flags?.[CONST.moduleId];
  if (flags && ('music' in flags || 'useTokenMusic' in flags)) game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle token updates for music flag changes
 * @param {Document} _token - The token document
 * @param {object} updateData - The update data
 */
export function handleUpdateToken(_token, updateData) {
  const flags = updateData.flags?.[CONST.moduleId];
  if (flags && ('music' in flags || 'useTokenMusic' in flags)) game.gameOrchestra?.musicController?.playCurrentTrack();
}

/**
 * Handle TokenConfig render to inject music configuration
 * @param {object} app - The application
 * @param {HTMLElement} html - The rendered HTML
 * @param {object} _context - Render context
 * @param {object} _options - Render options
 */
export function handleTokenConfigRender(app, html, _context, _options) {
  try {
    if (!game.user.isGM) return;
    const identityTab = html.querySelector('[data-application-part="identity"]') || html.querySelector('[data-tab="identity"].tab') || html.querySelector('.tab[data-tab="identity"]');
    if (!identityTab) return;
    const nameField = identityTab.querySelector('.form-group');
    if (!nameField) return;
    // NEVER use `app.token` here. Both token sheets define it as
    // `this._preview ?? <the real thing>` (TokenConfig extends PlaceableConfig,
    // which builds `_preview` on first render; PrototypeTokenConfig clones the
    // PrototypeToken in _prepareContext), so from the very first render it hands
    // back a DETACHED CLONE meant only for live canvas preview - and this
    // happened in practice: every playlist assignment (dropdown AND drag-drop)
    // looked dead, because GameOrchestraConfig wrote to the clone and then
    // re-rendered from that same stale clone.
    //
    // Writing to that clone is not merely cosmetic. PlaceableConfig#_createPreview
    // only calls `object.clone()` (which keeps the id) when the token is actually
    // drawn on the canvas; otherwise it does `this.document.clone(data)`, which
    // DROPS `_id` - and `Document#update()` on that clone posts an update for an
    // `_id` that exists nowhere, so the flag is silently never written.
    //
    // `app.document` (TokenConfig) and `app.actor.prototypeToken`
    // (PrototypeTokenConfig, which is not a DocumentSheet and has no `document`)
    // are the real, collection-backed documents.
    const isPrototype = app.isPrototype ?? app.constructor.name.includes('Prototype');
    const token = isPrototype ? app.actor?.prototypeToken : app.document;
    if (!token) return;
    const formGroup = document.createElement('div');
    formGroup.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = _loc('GameOrchestra.CombatMusic');
    const formFields = document.createElement('div');
    formFields.className = 'form-fields';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-orchestra-token-config';
    button.innerHTML = `<i class="fas fa-music"></i> ${_loc('GameOrchestra.ConfigTitle')}`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      new GameOrchestraConfig(token).render(true);
    });
    formFields.appendChild(button);
    formGroup.appendChild(label);
    formGroup.appendChild(formFields);
    nameField.insertAdjacentElement('afterend', formGroup);
    const isLinked = token.actorLink ?? false;
    if (isLinked && !isPrototype) {
      const useTokenMusic = token.getFlag?.(CONST.moduleId, 'useTokenMusic') ?? false;
      const checkboxGroup = document.createElement('div');
      checkboxGroup.className = 'form-group';
      const checkLabel = document.createElement('label');
      checkLabel.textContent = _loc('GameOrchestra.UseTokenMusic.Label');
      const checkFields = document.createElement('div');
      checkFields.className = 'form-fields';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'flags.game-orchestra.useTokenMusic';
      checkbox.checked = useTokenMusic;
      checkFields.appendChild(checkbox);
      checkboxGroup.appendChild(checkLabel);
      checkboxGroup.appendChild(checkFields);
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = _loc('GameOrchestra.UseTokenMusic.Hint');
      checkboxGroup.appendChild(hint);
      formGroup.insertAdjacentElement('afterend', checkboxGroup);
    }
  } catch (error) {
    log(1, 'Error adding token config button:', error);
  }
}

/**
 * Handle game ready to start music after delay
 */
export async function handleReady() {
  setTimeout(() => {
    game.gameOrchestra?.musicController?.playCurrentTrack();
  }, 1000);

  // Restore mood widget open state from the previous session
  try {
    const pos = game.settings.get(CONST.moduleId, CONST.settings.moodWidgetPosition) || {};
    if (pos.isOpen && game.gameOrchestra) {
      MoodWidget.open();
    }
  } catch (e) { /* settings not yet available */ }
}
