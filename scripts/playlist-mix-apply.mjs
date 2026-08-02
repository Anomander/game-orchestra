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
import { effectiveVolume, mixIsTransparent, normalizeMix } from './playlist-mix.mjs';

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
 * The volume a PlaylistSound should actually be heard at on this client: its own document
 * volume, through the playlist's mix, then through any local solo.
 * @param {object} sound - Foundry PlaylistSound document.
 * @returns {number} A volume in [0, 1].
 */
export function mixedVolume(sound) {
  if (!sound) return 0;
  const playlist = sound.parent;
  const solo = getSoloIds(playlist?.id);
  if (solo.size > 0 && !solo.has(sound.id)) return 0;
  return effectiveVolume(sound.volume, getPlaylistMix(playlist), sound.id);
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
  return !mixIsTransparent(getPlaylistMix(playlist));
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
  if (!sound?.playing) return;
  const target = mixedVolume(sound);
  let attempts = 0;

  const attempt = () => {
    // The document stopped while we were waiting - sync() owns the stop, and forcing a volume
    // onto a sound mid-stop would fight its fade-out.
    if (!sound.playing) return;
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
