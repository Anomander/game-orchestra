/**
 * Applies a playlist's mix (master gain, volume clamp, mute) to live audio.
 *
 * **This is the one part of the module that must run on EVERY client, not only the head GM.**
 * The playback *engine* is head-GM-only (CLAUDE.md rule 5) because it decides *what* plays.
 * Volume is not that kind of decision: each client builds its own `Sound` from the
 * PlaylistSound document and applies `this.volume` itself (PlaylistSound#sync). A mix applied
 * only on the head GM would mean the GM hears the ceiling and every player hears the raw track -
 * a bug the person who configured it is the least likely to notice.
 *
 * That also rules out the tempting shortcut of `sound.updateSource({volume})` before playback:
 * that is a local-only source mutation (it is what core uses for its own immediate slider
 * feedback in PlaylistDirectory#_onSoundVolume), so on the head GM it would change nothing for
 * anyone else.
 *
 * The mix itself is a world flag, so every client reads the same values. Only the mixer *window*
 * is GM-gated.
 */

import { CONST } from './config.mjs';
import { log } from './helpers.mjs';
import { coerceDuckFactor, effectiveVolume, mixIsTransparent, normalizeMix } from './playlist-mix.mjs';

/** How long a re-assert takes to glide, so a live slider drag is smooth rather than stepped. */
const REASSERT_FADE_MS = 100;
/** Retry budget while waiting for a just-started sound to exist and be playing. */
const READY_RETRY_MS = 100;
const READY_MAX_ATTEMPTS = 20;

/**
 * Solo is **session state, held per client**, never persisted and never a world flag - a solo
 * surviving a reload reads as "my playlist only plays one track now". It is an audition tool for
 * whoever opened the mixer, so it deliberately affects only that client's own audio; the table
 * goes on hearing the real mix.
 * @type {Map<string, Set<string>>} Playlist id -> soloed sound ids.
 */
const sessionSolo = new Map();

/**
 * Read a playlist's stored mix flag.
 * @param {object|null} playlist - Foundry Playlist document.
 * @returns {import('./playlist-mix.mjs').PlaylistMix|null}
 */
export function getPlaylistMix(playlist) {
  return playlist?.getFlag?.(CONST.moduleId, 'mix') ?? null;
}

/**
 * The soloed sound ids for a playlist on this client (empty when nothing is soloed).
 * @param {string} playlistId
 * @returns {Set<string>}
 */
export function getSoloIds(playlistId) {
  return sessionSolo.get(playlistId) ?? new Set();
}

/**
 * Toggle one sound's solo state on this client.
 * @param {string} playlistId
 * @param {string} soundId
 * @returns {boolean} The new solo state.
 */
export function toggleSolo(playlistId, soundId) {
  const set = sessionSolo.get(playlistId) ?? new Set();
  const next = !set.has(soundId);
  if (next) set.add(soundId);
  else set.delete(soundId);
  if (set.size === 0) sessionSolo.delete(playlistId);
  else sessionSolo.set(playlistId, set);
  return next;
}

/**
 * Drop every solo for a playlist (the mixer window closing, or a Reset).
 * @param {string} playlistId
 */
export function clearSolo(playlistId) {
  sessionSolo.delete(playlistId);
}

/**
 * The world's current duck: `{factor, exemptPlaylistIds}` while an additive layer is playing,
 * empty otherwise. A world setting, not engine state - see its registration in settings.mjs for
 * why it has to be readable on every client.
 * @returns {{factor: number, exemptPlaylistIds: string[]}}
 */
export function getActiveDuck() {
  const raw = game.settings?.get?.(CONST.moduleId, CONST.settings.activeDuck) ?? null;
  return {
    factor: coerceDuckFactor(raw?.factor),
    exemptPlaylistIds: Array.isArray(raw?.exemptPlaylistIds) ? raw.exemptPlaylistIds : []
  };
}

/**
 * The duck multiplier that applies to one playlist right now. Exemption is by playlist id and
 * covers the layer's whole engine tree, not just its root: a layer graph reaching another
 * playlist through a Playlist node is still the layer, and ducking its own nested audio would
 * make the feature fight itself.
 * @param {object|null} playlist
 * @returns {number} A number in [0, 1]; 1 when nothing is ducking.
 */
export function duckFactorFor(playlist) {
  const { factor, exemptPlaylistIds } = getActiveDuck();
  if (factor >= 1) return 1;
  return exemptPlaylistIds.includes(playlist?.id) ? 1 : factor;
}

/**
 * The volume a PlaylistSound should actually be heard at on this client: its own document
 * volume, through the playlist's mix, then through any local solo, then through any active duck.
 *
 * The duck is applied last, outside the mix, on purpose - see coerceDuckFactor's doc for why it
 * is allowed to take a track below the mix's own floor.
 * @param {object} sound - Foundry PlaylistSound document.
 * @returns {number} A volume in [0, 1].
 */
export function mixedVolume(sound) {
  if (!sound) return 0;
  const playlist = sound.parent;
  const solo = getSoloIds(playlist?.id);
  if (solo.size > 0 && !solo.has(sound.id)) return 0;
  return effectiveVolume(sound.volume, getPlaylistMix(playlist), sound.id) * duckFactorFor(playlist);
}

/**
 * Whether this playlist needs any mix work at all - false for the overwhelming majority of
 * playlists, which nobody has ever opened the mixer for.
 * @param {object|null} playlist
 * @returns {boolean}
 */
export function playlistNeedsMix(playlist) {
  if (!playlist) return false;
  if (getSoloIds(playlist.id).size > 0) return true;
  // A ducked playlist needs the work even with a completely transparent mix of its own -
  // otherwise a base track STARTING mid-layer (a graph advancing to its next node) would come in
  // at full volume and stay there, since handleUpdatePlaylistSoundMix gates on this.
  if (duckFactorFor(playlist) < 1) return true;
  return !mixIsTransparent(getPlaylistMix(playlist));
}

/**
 * Whether this sound is currently being faded out to a stop by the controller.
 *
 * A fade-out leaves the document saying `playing` for its whole duration, so `sound.playing` -
 * which is otherwise the right "is there anything to level" test - cannot see it. Re-asserting a
 * mix onto a sound mid-fade-out overwrites the ramp with a glide back up to full: the track then
 * plays on at full volume for the rest of the fade and stops dead at the end of it. Confirmed
 * live: suppressing Area/Combat music while a layer was ducking cut out after a pause instead of
 * fading, because dropping the layer republished `activeDuck`, whose onChange re-levelled every
 * playing sound in the world - the ones on their way out included.
 *
 * Only the head GM runs fades, so this reads false everywhere else and those clients simply stop
 * when the document does, exactly as before.
 * @param {object|null} sound - Foundry PlaylistSound document.
 * @returns {boolean}
 */
function isFadingOut(sound) {
  return game.gameOrchestra?.musicController?.isFadingOut?.(sound?.id) === true;
}

/**
 * Push the mixed volume onto a sound's live audio, waiting for the audio to exist first.
 *
 * The wait is not defensive: `PlaylistSound#sync()` starts playback with an async
 * `Sound#load({autoplay})`, so on the update that begins a track there is a window where the
 * document says playing and there is nothing to set a volume on yet. Same retry shape as
 * MusicController#_fadeInWhenReady, for the same reason.
 *
 * @param {object} sound - Foundry PlaylistSound document.
 * @param {object} [options]
 * @param {number} [options.duration] - Glide time in ms.
 * @returns {void}
 */
export function applyMixToSound(sound, { duration = REASSERT_FADE_MS } = {}) {
  if (!sound?.playing || isFadingOut(sound)) return;
  const target = mixedVolume(sound);
  let attempts = 0;

  const attempt = () => {
    // The document stopped while we were waiting - sync() owns the stop, and forcing a volume
    // onto a sound mid-stop would fight its fade-out. Re-checked on every retry, not just at
    // entry: a fade-out can begin at any point during the wait.
    if (!sound.playing || isFadingOut(sound)) return;
    const raw = sound.sound;
    if (raw?.playing) {
      try {
        if (typeof raw.fade === 'function') raw.fade(target, { duration });
        else raw.volume = target;
      } catch (error) {
        log(1, `Failed to apply mix volume to '${sound.name}':`, error);
      }
      return;
    }
    if (++attempts >= READY_MAX_ATTEMPTS) return;
    setTimeout(attempt, READY_RETRY_MS);
  };

  attempt();
}

/**
 * Re-assert the mix across every currently-playing sound of a playlist. This is the soft-apply
 * path: no stop, no restart, no engine rebuild - which is the entire reason the mix lives in its
 * own `game-orchestra.mix` flag rather than inside `game-orchestra.customPlayback`. A change to that other flag
 * is what hooks.mjs#handleUpdatePlaylist rebuilds a running engine on (H8), and since a graph
 * always restarts from Start (H9), sharing the flag would mean nudging a volume slider restarted
 * the music.
 * @param {object|null} playlist - Foundry Playlist document.
 * @param {object} [options]
 * @param {number} [options.duration]
 */
export function applyMixToPlaylist(playlist, { duration = REASSERT_FADE_MS } = {}) {
  if (!playlist?.sounds) return;
  for (const sound of playlist.sounds) {
    if (sound.playing) applyMixToSound(sound, { duration });
  }
}

/**
 * Merge a patch into a playlist's `game-orchestra.mix` flag.
 *
 * The single writer for that flag. `MixerController#patchMix` and the public API
 * (scripts/api.mjs) both route through here rather than each doing their own
 * read-normalize-merge-write - a second copy of this is exactly how the `muted`
 * bug (docs/wiki/mixer.md) got in, and the normalize step is not optional: merging
 * a patch onto a raw stored mix lets a legacy or malformed field survive into the
 * written value.
 *
 * `mix` is deliberately its own flag and not part of `game-orchestra.customPlayback`
 * (HR-H): a customPlayback change rebuilds a running engine (H8), which restarts the
 * graph from Start (H9), so sharing the flag would mean nudging a volume slider
 * audibly restarted the music.
 * @param {object|null} playlist - Foundry Playlist document.
 * @param {object} patch - Fields to merge over the current normalized mix.
 * @returns {Promise<void>}
 */
export async function patchPlaylistMix(playlist, patch) {
  if (!playlist) return;
  const current = normalizeMix(getPlaylistMix(playlist));
  await playlist.setFlag(CONST.moduleId, 'mix', { ...current, ...patch });
}

/**
 * Set one sound's muted state in a playlist's mix.
 *
 * The `muted` list is an **array, rebuilt whole**, and that is the whole reason this
 * function exists rather than each caller assembling a patch. A flag write is a
 * recursive merge server-side, so removing an id from a `{id: true}` map would merge
 * the old `true` straight back in and unmuting would silently never persist. Shipped
 * broken once; see PlaylistMix#muted's own comment.
 * @param {object|null} playlist - Foundry Playlist document.
 * @param {string} soundId
 * @param {boolean} muted
 * @returns {Promise<boolean>} The resulting muted state.
 */
export async function setPlaylistMuted(playlist, soundId, muted) {
  if (!playlist || !soundId) return false;
  const mix = normalizeMix(getPlaylistMix(playlist));
  const isMuted = mix.muted.includes(soundId);
  if (isMuted === !!muted) return isMuted;
  const next = muted ? [...mix.muted, soundId] : mix.muted.filter((id) => id !== soundId);
  await patchPlaylistMix(playlist, { muted: next });
  return !!muted;
}

/**
 * Re-level every playing sound in the world after the duck changed, gliding over the duck's own
 * `fadeMs` so the base dips as the layer arrives and recovers as it leaves.
 *
 * Everything playing is walked, not just the base context's playlist: the duck applies to
 * everything that isn't the layer, which includes any playlist a base graph reached through a
 * Playlist node - and this client has no idea which those are (the engine is head-GM-only).
 * Walking `game.playlists.playing` is the only view of "currently audible" every client shares.
 * @param {object} [options]
 * @param {number} [options.duration] - Glide time in ms; defaults to the stored duck's fadeMs.
 */
export function reassertDuck({ duration } = {}) {
  const fadeMs = Number(game.settings?.get?.(CONST.moduleId, CONST.settings.activeDuck)?.fadeMs);
  const glide = duration ?? (Number.isFinite(fadeMs) ? fadeMs : REASSERT_FADE_MS);
  for (const playlist of game.playlists?.playing ?? []) {
    for (const sound of playlist.sounds ?? []) {
      if (sound.playing) applyMixToSound(sound, { duration: glide });
    }
  }
}

/**
 * `updatePlaylistSound` hook - runs on every client. Re-asserts the mix whenever the sound
 * starts, or whenever its own volume changes underneath us (the sidebar slider, another GM's
 * mixer, a macro).
 * @param {object} sound - The updated PlaylistSound.
 * @param {object} changed - The update delta.
 */
export function handleUpdatePlaylistSoundMix(sound, changed) {
  if (!('playing' in changed) && !('volume' in changed)) return;
  if (!playlistNeedsMix(sound?.parent)) return;
  // Starting a track: no glide, or the first tenth of a second plays at the unmixed volume.
  applyMixToSound(sound, { duration: 'playing' in changed ? 0 : REASSERT_FADE_MS });
}

/**
 * `updatePlaylist` hook - runs on every client. A change to the `game-orchestra.mix` flag re-levels
 * whatever is already playing, in place.
 * @param {object} playlist - The updated Playlist.
 * @param {object} changed - The update delta.
 */
export function handleUpdatePlaylistMix(playlist, changed) {
  const mixChanged = changed?.flags?.[CONST.moduleId] ?? {};
  if (!('mix' in mixChanged) && !('-=mix' in mixChanged)) return;
  log(3, () => `Mix changed on playlist '${playlist?.name}': ${JSON.stringify(normalizeMix(getPlaylistMix(playlist)))}`);
  applyMixToPlaylist(playlist);
}
