import { CONST } from './config.mjs';
import { log, PlaylistContext, FadingTrack, isHeadGM, isCustomPlaylist, getCustomGraph, resolvePlaylistRef, readMusicSection, describePlaylistContext, emitHook } from './helpers.mjs';
import { buildNativeModeGraph } from './native-mode-graph.mjs';
import { CustomPlaybackEngine } from './custom-playback-engine.mjs';
import { getPlaylistMix, mixedVolume } from './playlist-mix-apply.mjs';
import { coerceDuckFactor, resolveCrossfadeOverride } from './playlist-mix.mjs';

/**
 * Main music controller class for Game Orchestra module
 */
export class MusicController {
  constructor() {
    this.fadingTracks = [];
    // soundId -> the token identifying the fade-out currently scheduled to stop that sound. The
    // stop only fires while its own token is still the one in here, which is what makes a fade
    // cancellable: a sound reclaimed mid-fade has its entry replaced/removed and the landing fade
    // becomes a no-op. See _fadeOutSounds / cancelPendingFadeOut.
    /** @type {Map<string, object>} */
    this._pendingFadeOuts = new Map();
    this.currentTracks = [];
    this.currentContext = null;
    this.isDebouncing = false;
    this._savedPlaylistPositions = new Map();
    this._managedSoundIds = new Set();
    this._audioUnlockRegistered = false;
    this._transitionSequenceId = 0;
    this._debounceTimer = null;
    this._customEngine = null;
    // The additive layers running alongside _customEngine, keyed by what asked for each one:
    // 'combatant' (a combatant's turn theme) and 'overlay:<section>' (a mood or phase entry
    // marked `layer`). Each runs on its OWN fully independent engine: the whole point of a layer
    // is that starting and stopping it never touches the base's playback - see _syncLayers.
    /** @type {Map<string, {engine: CustomPlaybackEngine, context: PlaylistContext}>} */
    this._layers = new Map();
    // One-shot: whether this session has cleaned up playback Foundry restored
    // from a previous one (see reconcileRestoredPlayback).
    this._restoredPlaybackReconciled = false;
  }

  /**
   * Get primary current track
   * @returns {object|null}
   */
  get currentTrack() {
    return this.currentTracks[0] || null;
  }

  /**
   * Every context currently playing as an additive layer over `currentContext`. Distinct from
   * `currentContext`, which is only ever the winner of the ordinary resolution - a layer never
   * competes in that (see _collectLayerContexts).
   *
   * More than one is normal: a combatant's turn theme and a phase overlay marked as a layer are
   * two independent answers to two different questions, and both play.
   * @returns {PlaylistContext[]}
   */
  get currentLayerContexts() {
    return [...this._layers.values()].map((run) => run.context);
  }

  /**
   * The first active layer, for callers that only need to know whether anything is layering.
   * @returns {PlaylistContext|null}
   */
  get currentLayerContext() {
    return this.currentLayerContexts[0] ?? null;
  }

  /**
   * Get active scene
   * @returns {Scene|null} Active scene document
   */
  get currentScene() {
    return game.scenes?.active || null;
  }

  /**
   * Get active combat
   * @returns {Combat|null} Active combat document
   */
  get currentCombat() {
    return game.combats?.active || null;
  }

  /**
   * Check if game audio is locked by the browser
   * @returns {boolean} True if audio is locked
   */
  isAudioLocked() {
    return game.audio?.locked ?? false;
  }

  /**
   * Play current track according to highest priority playlist context.
   * If called while debouncing, flags a pending play to ensure rapid mood changes resolve cleanly.
   */
  async playCurrentTrack() {
    if (this.isDebouncing) {
      this._pendingDebouncedPlay = true;
      return;
    }
    if (!isHeadGM()) return;

    if (this.isAudioLocked()) {
      log(3, 'Game audio is locked by browser gesture requirement. Awaiting user interaction...');
      if (!this._audioUnlockRegistered) {
        this._audioUnlockRegistered = true;
        let unlockHandled = false;
        const unlockHandler = () => {
          if (unlockHandled) return;
          unlockHandled = true;
          document.removeEventListener('pointerdown', unlockHandler);
          document.removeEventListener('keydown', unlockHandler);
          this._audioUnlockRegistered = false;
          log(3, 'User gesture detected. Triggering playCurrentTrack...');
          setTimeout(() => {
            this.playCurrentTrack();
          }, 100);
        };
        document.addEventListener('pointerdown', unlockHandler, { once: true });
        document.addEventListener('keydown', unlockHandler, { once: true });
      }
      return;
    }

    // Deliberately here rather than on 'ready': this is the first point in the
    // session where audio is known to be unlocked, so Foundry has already
    // flushed the playback it had pending behind the first-gesture requirement.
    // Reconciling any earlier would mean stopping sounds that were still only
    // queued, and watching them start anyway a moment later.
    if (!this._restoredPlaybackReconciled) {
      this._restoredPlaybackReconciled = true;
      try {
        await this.reconcileRestoredPlayback();
      } catch (error) {
        log(1, 'Error reconciling playback restored from a previous session:', error);
      }
    }

    this.isDebouncing = true;
    log(3, 'Debouncing track play calculation...');

    try {
      const contexts = this.getAllCurrentPlaylists();
      const filteredContexts = contexts.filter((ctx) => this.filterPlaylists(ctx));
      const validContexts = this.excludeAreaWhenCombatApplies(filteredContexts);
      const combat = this.currentCombat;
      validContexts.sort((a, b) => this.sortPlaylists(a, b, combat));

      const winnerContext = validContexts[0] || null;
      // Resolved BEFORE the transition, and threaded through both calls below so the two cannot
      // disagree. A binding that just flipped between replacing and layering hands the SAME
      // PlaylistSound from the base to a layer, and transitionToContext() has to know that before
      // it decides what to fade out - see its `layerSoundIds`.
      const incomingLayers = this._collectLayerContexts(winnerContext);
      const targetTracks = winnerContext?.tracks || [];
      const primaryTrackName = targetTracks[0]?.name || 'none';

      log(3, `Resolved current playlist context: ${winnerContext?.context || 'none'} (overlay: ${winnerContext?.isOverlay ?? false}) - '${winnerContext?.playlist?.name || 'none'}' (${targetTracks.length} tracks, primary: '${primaryTrackName}')`);

      const contextUnchanged =
        this.currentContext?.playlist?.id === winnerContext?.playlist?.id &&
        this.currentTracks?.length === targetTracks.length &&
        this.currentTracks.every((t, i) => t.id === targetTracks[i]?.id);

      const audioActuallyPlaying = this.currentTracks?.length > 0 &&
        this.currentTracks.some((t) => t.playing === true || t.sound?.playing === true);

      if (contextUnchanged && audioActuallyPlaying) {
        log(3, 'Current tracks already match resolved target context and audio is playing. No change.');
      } else {
        if (contextUnchanged && !audioActuallyPlaying && targetTracks.length > 0) {
          log(3, 'Context unchanged but audio is not playing — restarting tracks.');
        }
        await this.transitionToContext(winnerContext, incomingLayers);
      }

      // Always, including on the no-change path above: the base can be entirely unchanged while
      // a layer has to swap or stop, which is the normal case for a turn passing between two
      // combatants when neither is exclusive. Returning early here would strand the outgoing
      // combatant's theme playing over everyone else's turn.
      await this._syncLayers(incomingLayers);
    } catch (error) {
      log(1, 'Error in playCurrentTrack calculation:', error);
    } finally {
      setTimeout(() => {
        this.isDebouncing = false;
        if (this._pendingDebouncedPlay) {
          this._pendingDebouncedPlay = false;
          this.playCurrentTrack();
        }
      }, 150);
    }
  }

  /**
   * Transition to a target playlist context
   * @param {PlaylistContext|null} targetContext Target context to play
   * @param {Map<string, PlaylistContext>|null} [incomingLayers] - The layers about to start once
   *   this transition finishes ({@link MusicController#_collectLayerContexts}). Their sounds are
   *   held back from the fade-out below; see `layerSoundIds`.
   */
  async transitionToContext(targetContext, incomingLayers = null) {
    // A custom graph already driving the exact playlist the resolver just
    // picked again must be left alone. Without this, every re-evaluation
    // that still resolves to the same running graph (e.g. an unrelated mood
    // or phase change, since playCurrentTrack() re-resolves on every
    // activeMood/activePhase onChange regardless of whether this context
    // depends on either at all) falls through to the unconditional engine-retire/rebuild below and
    // restarts the graph from Start. onCustomGraphChanged() bypasses this
    // deliberately (nulls currentContext/_customEngine first) for the one
    // case a real restart IS wanted: a live edit to the running graph (H8).
    if (
      isCustomPlaylist(targetContext?.playlist) &&
      this._customEngine?.isRunning &&
      this._customEngine.playlist?.id === targetContext.playlist.id
    ) {
      log(3, `Custom graph for playlist '${targetContext.playlist.name}' is already running; leaving it uninterrupted.`);
      this._setContext(targetContext);
      // The top-level graph itself isn't restarting, but this re-resolution
      // may still have been caused by (among other things) a mood or phase
      // change - any nested Playlist node currently mid-pass whose OWN
      // reference tracks the active overlay must still react to that,
      // without the rest of this tree (in particular the root graph's own
      // position) being disturbed. See refreshOverlayReactiveTargets()'s doc comment.
      await this._customEngine.refreshOverlayReactiveTargets();
      this._refreshUI();
      return;
    }

    const transitionId = ++this._transitionSequenceId;
    const targetTracks = targetContext?.tracks || [];
    const targetTrackIds = new Set(targetTracks.map((t) => t.id));
    // The target playlist's own crossfade override (the mixer's Crossfade field) governs this
    // hand-off when it has one, otherwise the world fade setting does. Both directions of the
    // transition use the one value - it is a single crossfade, not two independent fades, and
    // taking the outgoing playlist's number for the fade-out and the incoming one's for the
    // fade-in would leave an audible dip or bulge in the middle wherever they disagreed.
    const fadeDurationMs = this._resolveFadeMs(targetContext?.playlist);

    log(3, `Transitioning music context to '${targetContext?.playlist?.name || 'none'}' (stopping ${this.fadingTracks.length} tracks, starting ${targetTracks.length} tracks, fade: ${fadeDurationMs}ms)`);

    // Anything this transition intends to KEEP playing has to be taken off a fade-out an earlier
    // transition already scheduled - re-winning a context inside the crossfade window is exactly
    // that case, and the sound would otherwise be stopped mid-playback by a fade nobody could see
    // any more. Done here, before the first await: the cancel has to beat the fade's completion
    // callback, and every await below is another chance for it to land first.
    for (const track of targetTracks) this.cancelPendingFadeOut(track, fadeDurationMs);

    // Retire any running custom-graph engine, but leave its sounds playing: they
    // stay in _managedSoundIds and (unless shared with the new target) are absent
    // from targetTrackIds, so the fade-out loop below crossfades them exactly like
    // a native transition instead of a hard cut (custom-playlist-plan.md H11).
    await this._customEngine?.stop({ stopAudio: false });
    this._customEngine = null;

    // Clear any stale fading track entries in-place from previous transitions
    this.fadingTracks.length = 0;

    // Save progress position of current tracks before stopping/fading
    if (this.currentTracks?.length && this.currentContext?.scopeEntity) {
      for (const track of this.currentTracks) {
        this.savePlaylistData(this.currentContext.scopeEntity, track);
      }
    }

    // Every layer runs its own engine and outlives base transitions entirely - that is what makes
    // it a layer. Their sounds are in _managedSoundIds like any other, so without this exclusion
    // the loop below would fade them out on every single base re-resolution and the layers would
    // die the moment anything else changed.
    //
    // The INCOMING layers count too, not just the running ones. Ticking "Play as overlay" hands
    // the same PlaylistSound straight from the base to a layer: the binding stops winning the
    // resolution, so this transition sees its track as an outgoing managed sound and fades it -
    // and then _syncLayers() starts the layer, which finds the document still marked playing and
    // ADOPTS it rather than starting it (path=adopted, no play() call). Four seconds later the
    // fade lands, the sound stops, and the layer is left holding a token on dead audio, waiting
    // for an 'end' that a 'stop' never sends. Confirmed live: the layer showed as running and was
    // simply inaudible. Leaving the sound alone here makes it a seamless hand-over instead.
    const layerSoundIds = new Set([
      ...[...this._layers.values()].flatMap((run) => (run.engine?.activeSounds ?? []).map((sound) => sound.id)),
      ...[...(incomingLayers?.values() ?? [])].flatMap((context) => (context.tracks ?? []).map((track) => track.id))
    ]);

    // Fade out current playing tracks (excluding targetTracks). Only ever touches sounds
    // this controller itself previously started — a GM's manually-started ambience or
    // jukebox playlist is left alone rather than being silently cut off.
    const soundsToFade = game.playlists.playing
      .flatMap((p) => Array.from(p.sounds.values()))
      .filter((sound) => !targetTrackIds.has(sound.id) && this._managedSoundIds.has(sound.id) && !layerSoundIds.has(sound.id));
    this._fadeOutSounds(soundsToFade, fadeDurationMs);

    if (isCustomPlaylist(targetContext?.playlist)) {
      this._setContext(targetContext);
      // Custom graphs own their own playback lifecycle and always restart from
      // Start (custom-playlist-plan.md GM-handoff decision); leaving this empty
      // stops the save-position loop above from persisting resume offsets for
      // graph sounds on the *next* transition, since graphs never resume (H9).
      this.currentTracks = [];
      this._customEngine = new CustomPlaybackEngine(targetContext, this);
      this._refreshUI();
      await this._customEngine.start();
      return;
    }

    this._setContext(targetContext);
    this.currentTracks = targetTracks;
    for (const track of targetTracks) this._managedSoundIds.add(track.id);
    this._refreshUI();

    // A track that's already audibly playing needs no action - re-triggering playback
    // here is what causes tracks to audibly restart from the beginning on every
    // unrelated config change that happens to re-resolve to the same winning context.
    const tracksToStart = targetTracks.filter((targetTrack) => {
      const alreadyPlaying = targetTrack.playing === true || targetTrack.sound?.playing === true;
      // Any fade-out scheduled on it was already cancelled above, which is what makes
      // "uninterrupted" true rather than "uninterrupted until the old fade lands".
      if (alreadyPlaying) log(3, `Track '${targetTrack.name}' is already playing; leaving it uninterrupted.`);
      return !alreadyPlaying;
    });
    if (tracksToStart.length === 0) return;

    // mixedVolume(), not the raw document volume, so a fade-in lands on the level the playlist's
    // mix asks for rather than overshooting to full and being pulled back afterwards.
    const startVolumes = new Map(tracksToStart.map((track) => [track.id, mixedVolume(track)]));
    for (const targetTrack of tracksToStart) {
      const savedPosition = this.getPlaylistData(targetContext.scopeEntity, targetTrack);
      log(3, `Preparing to play track '${targetTrack.name}' from position ${savedPosition}s (targetVolume: ${startVolumes.get(targetTrack.id)}, fadeIn: ${fadeDurationMs > 0})`);
    }

    // pausedTime is the schema field PlaylistSound/Playlist#playSound reads to resume
    // playback at a given offset; a plain 'offset' field is not persisted or honored.
    // Batched into a single updateEmbeddedDocuments() call (falling back to
    // one update() per track if that API isn't available) rather than one
    // round-trip per track, so a SIMULTANEOUS/layered-ambience playlist's
    // several tracks start together instead of staggered by one document
    // round-trip each.
    if (typeof targetContext.playlist?.updateEmbeddedDocuments === 'function') {
      const changes = tracksToStart.map((track) => ({ _id: track.id, pausedTime: this.getPlaylistData(targetContext.scopeEntity, track) }));
      await targetContext.playlist.updateEmbeddedDocuments('PlaylistSound', changes);
    } else {
      for (const track of tracksToStart) {
        await track.update({ pausedTime: this.getPlaylistData(targetContext.scopeEntity, track) });
      }
    }
    if (this._transitionSequenceId !== transitionId) return;

    await Promise.all(tracksToStart.map((track) => this.playTrack(track)));
    if (this._transitionSequenceId !== transitionId) return;

    if (fadeDurationMs > 0) {
      for (const track of tracksToStart) this._fadeInWhenReady(track, fadeDurationMs, startVolumes.get(track.id), transitionId);
    }
  }

  /**
   * The crossfade length governing a hand-off involving this playlist: its own mixer override
   * when it has one, otherwise the world fade setting. Both directions of a transition use the
   * one value - it is a single crossfade, not two independent fades, and taking the outgoing
   * playlist's number for the fade-out and the incoming one's for the fade-in would leave an
   * audible dip or bulge in the middle wherever they disagreed.
   * @param {object|null} playlist
   * @returns {number} Milliseconds; 0 means "cut, don't fade".
   * @private
   */
  /**
   * Assign the winning context and fire `gameOrchestraContextChanged` when it actually changed.
   *
   * The single assignment point inside transitionToContext, which has three of them (the
   * already-running-graph early return, the custom-graph branch, and the native branch). One
   * function so a listener cannot be told about two of the three.
   *
   * **Diffed by descriptor, not by identity.** Every re-resolution builds a brand-new
   * PlaylistContext object, so an identity check would fire this on every unrelated mood change
   * that happened to resolve to the same music - which is precisely the noise the early return
   * above exists to avoid causing in the engine.
   *
   * `currentContext = null` in onCustomGraphChanged() deliberately does NOT come through here: it
   * is an internal reset that forces a real transition (H8), and emitting there would report a
   * spurious stop immediately followed by a start of the same context.
   * @param {PlaylistContext|null} next
   * @private
   */
  _setContext(next) {
    const from = describePlaylistContext(this.currentContext);
    const to = describePlaylistContext(next);
    this.currentContext = next;
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    emitHook(CONST.hooks.CONTEXT_CHANGED, { from, to });
  }

  _resolveFadeMs(playlist) {
    const override = resolveCrossfadeOverride(getPlaylistMix(playlist)?.crossfadeMs);
    const fadeDurationSec = game.settings.get(CONST.moduleId, CONST.settings.fadeDuration) ?? 3;
    return override ?? fadeDurationSec * 1000;
  }

  /**
   * Fade the given sounds to silence and stop them, or stop them outright when there is no fade
   * to run. Shared by the base transition and the layer teardown so a layer ending sounds exactly
   * like any other hand-off. Callers are responsible for deciding WHICH sounds may be touched -
   * this stops everything handed to it.
   * @param {Array<object>} sounds - PlaylistSound documents.
   * @param {number} fadeDurationMs
   * @private
   */
  _fadeOutSounds(sounds, fadeDurationMs) {
    for (const activeSound of sounds) {
      if (!activeSound?.playing) continue;
      const soundObj = activeSound.sound || activeSound;
      if (fadeDurationMs > 0 && typeof soundObj?.fade === 'function') {
        log(3, `Fading out track '${activeSound.name}' over ${fadeDurationMs}ms`);
        // The stop is claimed by this token, not scheduled unconditionally. Whoever reclaims the
        // sound before the fade lands takes the claim away and the stop below simply doesn't run.
        const token = {};
        if (activeSound.id) this._pendingFadeOuts.set(activeSound.id, token);
        const settle = () => {
          if (activeSound.id && this._pendingFadeOuts.get(activeSound.id) !== token) return;
          this._pendingFadeOuts.delete(activeSound.id);
          this.stopTrack(activeSound);
        };
        Promise.resolve(soundObj.fade(0, { duration: fadeDurationMs })).then(settle).catch(settle);
        this.fadingTracks.push(new FadingTrack(activeSound, fadeDurationMs));
      } else {
        if (activeSound.id) this._pendingFadeOuts.delete(activeSound.id);
        this.stopTrack(activeSound);
      }
    }
  }

  /**
   * Whether a fade-out is currently running on this sound with a stop waiting at the end of it.
   *
   * The question `sound.playing` cannot answer: the document says `playing` for the whole of a
   * fade. Anything that levels live audio has to ask this before touching a sound, or it glides
   * the ramp back up and turns the fade into a pause followed by a hard cut (see
   * playlist-mix-apply.mjs#isFadingOut).
   * @param {string|null|undefined} soundId
   * @returns {boolean}
   */
  isFadingOut(soundId) {
    return !!soundId && this._pendingFadeOuts.has(soundId);
  }

  /**
   * Reclaim a sound that is mid-fade-out: call off the stop that fade was going to perform, and
   * bring the level back up to what this sound's mix asks for.
   *
   * Exists because "still playing" and "not on its way to silence" are different questions, and
   * every adoption path in the module asks only the first. A sound fading out is `playing === true`
   * for the whole fade, so an engine adopting it takes no action at all (`path=adopted`, no play()
   * call) - and then the fade lands, the sound stops, and the adopter is left holding a token on
   * dead audio waiting for an 'end' that a 'stop' never sends. Confirmed live: switching a mood
   * away and back inside the crossfade window left the overlay layer showing as running and
   * completely silent.
   *
   * The fade back up is not cosmetic. Adoption never sets a volume - the level is wherever the
   * outgoing fade had got to, so without this the reclaimed sound plays on at some arbitrary
   * fraction, or at zero if the reclaim landed near the end of the fade.
   * @param {object|null} sound - PlaylistSound document being reclaimed.
   * @param {number} [fadeDurationMs] - How long to ramp back up; defaults to this playlist's own
   *   crossfade, matching the fade it is cancelling.
   * @returns {boolean} Whether there was a pending fade-out to cancel.
   */
  cancelPendingFadeOut(sound, fadeDurationMs = undefined) {
    const soundId = sound?.id;
    if (!soundId || !this._pendingFadeOuts.has(soundId)) return false;
    this._pendingFadeOuts.delete(soundId);
    const index = this.fadingTracks.findIndex((fading) => fading.track?.id === soundId);
    if (index >= 0) this.fadingTracks.splice(index, 1);
    const soundObj = sound.sound || sound;
    const duration = fadeDurationMs ?? this._resolveFadeMs(sound.parent);
    log(3, `Reclaiming fading-out track '${sound.name}' - cancelling its stop and restoring volume over ${duration}ms`);
    if (typeof soundObj?.fade === 'function') {
      // Failure here is not worth propagating to the caller's start path: the sound keeps playing
      // either way, which is the part that matters. A wrong level is audible; a thrown start is fatal.
      Promise.resolve(soundObj.fade(mixedVolume(sound), { duration })).catch(() => {});
    }
    return true;
  }

  /**
   * Every context that should currently be playing as an additive layer, keyed by what asked for
   * it. The key is what makes a layer replaceable in place: a combatant's theme swapping as the
   * turn passes must not disturb a phase overlay layering over the same fight, and vice versa.
   *
   * Two sources, deliberately independent:
   *
   * - `combatant` - the current combatant's non-exclusive theme (getCombatantLayerContext).
   * - `overlay:<section>` - a mood or phase entry marked `layer` (getOverlayLayerContexts).
   * @param {PlaylistContext|null} [baseContext] - The base this layer set will play over. Callers
   *   resolving layers BEFORE the transition pass the incoming winner, so the area-vs-combat rule
   *   is decided against the music that is about to play rather than the music leaving.
   * @returns {Map<string, PlaylistContext>}
   * @private
   */
  _collectLayerContexts(baseContext = this.currentContext) {
    const layers = new Map();
    const combatant = this.getCombatantLayerContext();
    if (combatant) layers.set('combatant', combatant);
    for (const context of this.getOverlayLayerContexts(baseContext)) layers.set(`overlay:${context.context}`, context);
    return layers;
  }

  /**
   * Bring the additive layers into line with what the current combatant and the active
   * mood/phase overlays ask for, without disturbing the base context in any way. Called on EVERY
   * playCurrentTrack(), including the ones where the base is unchanged - a turn passing changes a
   * layer and nothing else.
   *
   * Each layer is its own independent CustomPlaybackEngine. None is a context in the winner pool,
   * none has a priority, and none is ever crossfaded against the base: the base simply keeps
   * playing underneath, which is the entire feature - no stop, no restart, and therefore nothing
   * to resume (position memory can't help a graph anyway, H9).
   * @param {Map<string, PlaylistContext>} [desired] - Pre-resolved by playCurrentTrack() before
   *   the base transition, so this and transitionToContext() act on the identical set. Resolved
   *   here when called on its own.
   * @returns {Promise<void>}
   * @private
   */
  async _syncLayers(desired = this._collectLayerContexts()) {

    // Every retirement first, before any start. A playlist moving from one layer key to another
    // (a phase overlay naming what the outgoing combatant was already playing) would otherwise be
    // refused by the H15 collision check below, against a layer that was on its way out anyway.
    for (const [key, run] of [...this._layers]) {
      const next = desired.get(key);
      // Same reasoning as transitionToContext()'s already-running guard: a re-resolution that
      // lands on the playlist already layering (an unrelated mood/phase change, a combatant
      // update) must not restart it from Start.
      if (next && run.engine?.isRunning && run.engine.playlist?.id === next.playlist?.id) continue;
      await this._retireLayer(key);
    }

    for (const [key, context] of desired) {
      const run = this._layers.get(key);
      if (run) {
        run.context = context;
        await run.engine.refreshOverlayReactiveTargets();
        continue;
      }
      const playlist = context.playlist;
      if (this._layerWouldCollide(playlist, key)) continue;

      // An explicit graph, unlike the base's custom-playlist branch: a layer may target a plain
      // NATIVE playlist, and the engine constructor's own fallback for a playlist with no stored
      // graph is an EMPTY graph - which starts, finds nothing to do, and goes idle in silence.
      // Synthesizing one from the playlist's native mode is exactly what a Playlist node does for
      // its target (_runPlaylistPass), so native and custom layers behave identically.
      //
      // `trackId` is threaded in so a layer bound to ONE track of a Soundboard playlist plays that
      // track, matching what the same binding does when it wins the base resolution instead
      // (PlaylistContext._resolveTracks checks trackId before mode). It is deliberately not passed
      // for a custom playlist: getCustomGraph() wins first, and a stray initialTrack must never
      // bypass a graph (H2).
      const graph = getCustomGraph(playlist) || buildNativeModeGraph(playlist, { trackId: context.trackId });
      const engine = new CustomPlaybackEngine(context, this, { graph });
      this._layers.set(key, { engine, context });
      log(3, `Starting music layer '${playlist.name}' (${key}) over '${this.currentContext?.playlist?.name || 'nothing'}'`);
      this._refreshUI();
      // Before start(), so the base has already dipped by the time the layer's first track is
      // audible rather than a beat after it.
      await this._applyDuck();
      await engine.start();
    }

    // Re-published, not skipped when nothing changed: a running layer's engine registry may have
    // grown since it started (a Playlist node entering a nested target), and those playlists need
    // exempting too. _applyDuck() no-ops when the resulting value is identical.
    await this._applyDuck();
  }

  /**
   * Whether starting `playlist` as the layer under `key` would put two engines on one playlist
   * (H15). CustomPlaybackEngine's `_activeSoundOwners` map makes two Track nodes sharing a
   * soundId safe, but it is PER-ENGINE - across two engine trees there is nothing stopping each
   * from adopting, re-starting and stealing the other's AudioEndWatcher listener on the same
   * physical PlaylistSound.
   *
   * Refusing is the only safe outcome, and costs nothing musically: a playlist layered over
   * itself was never going to sound like anything but a stuttering doubling.
   * @param {object} playlist
   * @param {string} key - The layer key being started; its own (already retired) entry is skipped.
   * @returns {boolean}
   * @private
   */
  _layerWouldCollide(playlist, key) {
    const basePlaylistId = this.currentContext?.playlist?.id ?? null;
    if (playlist.id === basePlaylistId || this._customEngine?.isPlayingPlaylist(playlist.id)) {
      log(2, `Refusing to layer playlist '${playlist.name}': it is already being played by the base context. Give the layer a different playlist, or have it replace the base instead ('Play exclusively' for a combatant, unticking 'Play as overlay' for a mood or phase).`);
      return true;
    }
    for (const [otherKey, run] of this._layers) {
      if (otherKey === key) continue;
      if (run.engine?.isPlayingPlaylist?.(playlist.id)) {
        log(2, `Refusing to layer playlist '${playlist.name}' (${key}): it is already playing as the '${otherKey}' layer.`);
        return true;
      }
    }
    return false;
  }

  /**
   * Publish the layers' duck to the world, or clear it. The value is a WORLD SETTING, not engine
   * state: the engine runs on the head GM alone, but volume is applied per client from the
   * document (CLAUDE.md rule 5), so a duck held in memory here would duck the GM and nobody else.
   * Every client's own mix application reads it back - see playlist-mix-apply.mjs#duckFactorFor.
   *
   * With several layers running, the DEEPEST duck wins and EVERY layer's tree is exempt. Taking
   * the shallowest would let one layer quietly undo the dip another asked for, and a layer ducking
   * another layer would make the feature fight itself.
   *
   * Each layer's whole engine tree is exempt, not just its root playlist, so a layer graph that
   * reaches another playlist through a Playlist node doesn't duck its own nested audio. The
   * registry is shared by reference with child engines (plan D6), so this snapshot keeps growing
   * correctly for the nodes entered so far; a nested target entered later is picked up by the
   * next re-publish rather than immediately, which is the one rough edge here.
   * @returns {Promise<void>}
   * @private
   */
  async _applyDuck() {
    if (!isHeadGM()) return;
    const current = game.settings.get(CONST.moduleId, CONST.settings.activeDuck) || {};
    let factor = 1;
    let deepest = null;
    const exempt = new Set();
    for (const run of this._layers.values()) {
      const asked = coerceDuckFactor(this._resolveDuckFactor(run.context));
      if (asked < factor) {
        factor = asked;
        deepest = run;
      }
      for (const id of run.engine?._registry ?? [run.context.playlist?.id]) if (id) exempt.add(id);
    }
    // Empty when nothing is ducking, so it matches the `{}` actually stored below - otherwise the
    // unchanged check compares a populated list against a value that never carried one, and every
    // sync would rewrite an identical setting.
    const exemptPlaylistIds = factor >= 1 ? [] : [...exempt];
    const fadeMs = this._resolveFadeMs(deepest?.context?.playlist ?? this.currentContext?.playlist);
    // Writing an unchanged value would still fire onChange on every client and re-glide audio
    // that is already at the right level, on every single turn change.
    const unchanged = coerceDuckFactor(current.factor) === factor &&
      JSON.stringify(current.exemptPlaylistIds ?? []) === JSON.stringify(exemptPlaylistIds);
    if (unchanged) return;
    await game.settings.set(CONST.moduleId, CONST.settings.activeDuck, factor >= 1 ? {} : { factor, exemptPlaylistIds, fadeMs });
  }

  /**
   * The duck factor one layer asks for, or undefined when it asks for none.
   *
   * Read off whichever document the layer resolved from, at the level the flag actually lives at:
   * SECTION level (`music.combat.duck`) for a combatant, since one flag there governs whichever
   * playlist the section resolves to for any phase; ENTRY level
   * (`music.<section>.overlays.<id>.duck`) for a mood/phase overlay layer, since each overlay
   * decides independently whether it layers at all.
   * @param {PlaylistContext} layerContext
   * @returns {number|undefined}
   * @private
   */
  _resolveDuckFactor(layerContext) {
    const section = readMusicSection(layerContext?.contextEntity, layerContext?.context);
    if (!section) return undefined;
    return layerContext.overlayId && layerContext.isLayer
      ? section.overlays?.[layerContext.overlayId]?.duck
      : section.duck;
  }

  /**
   * Every sound id currently being played by something other than the layer under `key` - the
   * base context (its own tracks for a native playlist, its engine's for a graph) and every other
   * layer.
   *
   * Exists because "this engine was playing it" stopped being the same question as "this engine
   * still owns it" once a binding could move between layering and replacing. Stopping a sound
   * another owner is mid-way through is silent and looks exactly like the feature being broken.
   * @param {string} key - The layer being retired; its own sounds are what the caller is asking about.
   * @returns {Set<string>}
   * @private
   */
  _soundIdsOwnedOutside(key) {
    const ids = new Set();
    for (const track of this.currentTracks ?? []) if (track?.id) ids.add(track.id);
    for (const sound of this._customEngine?.activeSounds ?? []) if (sound?.id) ids.add(sound.id);
    for (const [otherKey, run] of this._layers) {
      if (otherKey === key) continue;
      for (const sound of run.engine?.activeSounds ?? []) if (sound?.id) ids.add(sound.id);
    }
    return ids;
  }

  /**
   * Tear down one running layer, fading its sounds out over that layer playlist's own crossfade
   * value. Its active sounds have to be captured BEFORE stop(): once the engine has stopped, its
   * nodes have released them and activeSounds is empty, so there would be nothing left to fade.
   * Stopped with `stopAudio: false` for the same reason transitionToContext does - it hands the
   * sounds to the fade instead of hard-cutting them (H11).
   * @param {string} key - A key from {@link MusicController#_collectLayerContexts}.
   * @returns {Promise<void>}
   * @private
   */
  async _retireLayer(key) {
    const run = this._layers.get(key);
    if (!run) return;
    const engine = run.engine;
    const fadeDurationMs = this._resolveFadeMs(engine.playlist);
    // Only the sounds nothing ELSE is now playing. A layer and the base can legitimately end up
    // on the same PlaylistSound - unticking "Play as overlay" is exactly that: the same binding
    // stops layering and starts winning the resolution instead, so transitionToContext() adopts
    // the already-playing sound ("leaving it uninterrupted") and _syncLayers() then retires the
    // layer that had been playing it. Fading the whole activeSounds list there takes the BASE's
    // own track to silence a beat after it was handed over - confirmed live as "everything stops
    // playing" the moment the overlay was switched back to replacing.
    const ownedElsewhere = this._soundIdsOwnedOutside(key);
    const sounds = engine.activeSounds.filter((sound) => !ownedElsewhere.has(sound?.id));
    this._layers.delete(key);
    log(3, `Retiring music layer '${engine.playlist?.name || 'unknown'}' (${key}, fading ${sounds.length} track(s) over ${fadeDurationMs}ms)`);
    await engine.stop({ stopAudio: false });
    this._fadeOutSounds(sounds, fadeDurationMs);
    // Released here rather than in _syncLayers so that EVERY teardown path lifts this layer's
    // share of the duck - a stale duck is silent and invisible, and would leave the table's music
    // quietly attenuated with nothing playing over it.
    await this._applyDuck();
    this._refreshUI();
  }

  /**
   * Stop any custom-playlist sound Foundry resurrected from persisted document
   * state, before the first playCurrentTrack() of this session.
   *
   * A PlaylistSound's `playing` field lives in the world database, and Foundry
   * restores playback for every sound still marked playing when a client loads.
   * A hard refresh gives this module no teardown path at all - the page is gone
   * before CustomPlaybackEngine.stop() can run - so whatever a graph had in
   * flight (with a Fork, legitimately several tracks) stays marked playing and
   * comes back on the next load. The engine then starts a fresh run from Start
   * on top of it, and the resurrected sounds play forever: they belong to no
   * node, so no watcher, scheduled stop, or later transition ever touches them.
   *
   * transitionToContext()'s fade-out loop cannot clean them up either - they're
   * skipped twice over, once as members of the target playlist and once for not
   * being in the (empty after a reload) _managedSoundIds set.
   *
   * Only custom playlists are reconciled. A graph always restarts from Start
   * (the locked GM-handoff decision), so nothing of its previous run should
   * survive; native playlists keep resuming across a refresh as they always have.
   * @returns {Promise<void>}
   */
  async reconcileRestoredPlayback() {
    // Document updates, so exactly one client must do this - the same one that
    // will be running the engine.
    if (!isHeadGM()) return;
    // A duck is a world setting, so a hard refresh mid-layer leaves it applied with nothing
    // layering over it - and unlike a stuck sound it makes no noise to give itself away, it just
    // makes everything quieter forever. Same class of stale state this whole method exists for.
    // No layer can be running yet at this point in the session, so this always clears.
    await this._applyDuck();
    const playlists = game.playlists?.contents || Array.from(game.playlists || []);
    const visited = new Set();
    // A Map, not an array: a playlist reachable both directly (it has its own
    // graph) and as some other graph's Playlist-node target must only be
    // scanned for resurrected sounds once.
    const toCheck = new Map();
    for (const playlist of playlists) {
      if (!isCustomPlaylist(playlist)) continue;
      toCheck.set(playlist.id, playlist);
      // Playlist nodes commonly target a plain NATIVE playlist (no graph of
      // its own) - the loop above would never otherwise look at it, so its
      // sounds would stay resurrected-and-orphaned forever, exactly like the
      // class doc above describes for a graph's own tracks. Both direct and
      // indirect references are followed here (unlike _resolveTracks, this
      // runs on the head GM with a ready game, so live scene/mood state is
      // actually available to resolve an indirect reference correctly).
      for (const target of this._collectReferencedPlaylists(playlist, visited)) {
        toCheck.set(target.id, target);
      }
    }
    // Layer playlists are engine-driven whether or not they have a graph of their own, so a
    // NATIVE one used as a layer leaves exactly the same orphaned-and-resurrected sounds the
    // class doc above describes - and the loops above would never look at it, since nothing
    // references it and it isn't custom. Bounded by the combatant count, and safe for a playlist
    // that also turns out to be the base: this runs once, before any playback this session, and
    // a reload has no saved positions to lose anyway.
    for (const playlist of this._collectLayerPlaylists()) toCheck.set(playlist.id, playlist);
    const stopped = [];
    for (const playlist of toCheck.values()) {
      const sounds = playlist.sounds?.contents || Array.from(playlist.sounds?.values() || []);
      for (const sound of sounds) {
        if (!sound.playing) continue;
        stopped.push(`${playlist.name}/${sound.name}`);
        await Promise.resolve(this.stopTrack(sound));
      }
    }
    if (stopped.length > 0) {
      log(3, `Stopped ${stopped.length} custom-playlist sound(s) left marked as playing by a previous session: ${stopped.join(', ')}`);
    }
  }

  /**
   * Every playlist that could currently run as a layer:
   *
   * - the non-exclusive combat override of each combatant in the active combat, defeated ones
   *   included (a combatant can be revived, and this is only ever used to look for stale sounds);
   * - every overlay entry marked `layer` on the active scene and the world default, on both
   *   sections and every overlay id.
   *
   * Every combatant and every overlay id is walked here, not just the current/live ones, because
   * reconcileRestoredPlayback() is cleaning up after a PREVIOUS session whose turn order and
   * active mood/phase are unknowable from here.
   * @returns {Array<object>} Playlist documents.
   * @private
   */
  _collectLayerPlaylists() {
    const found = new Map();
    const remember = (id) => {
      const playlist = id ? game.playlists?.get(id) : null;
      if (playlist) found.set(playlist.id, playlist);
    };

    for (const combatant of this.currentCombat?.combatants || []) {
      for (const source of this._getCombatantMusicSources(combatant.token, combatant.actor)) {
        const section = readMusicSection(source, 'combat');
        if (!section) continue;
        if (section.exclusive === true) break;
        // Every phase override too, not just the base pick: which one was live last session is
        // as unknowable from here as the turn order was.
        remember(section.playlist);
        for (const overlay of Object.values(section.overlays || {})) remember(overlay?.playlist);
        break;
      }
    }

    const defaultConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic);
    for (const document of [this.currentScene, defaultConfig]) {
      for (const type of ['area', 'combat']) {
        const section = readMusicSection(document, type);
        if (!section) continue;
        for (const overlay of Object.values(section.overlays || {})) {
          if (overlay?.layer === true) remember(overlay.playlist);
        }
      }
    }
    return [...found.values()];
  }

  /**
   * Every playlist a custom graph's Playlist nodes reference (direct or
   * indirect), followed transitively through any target that itself has a
   * graph. See reconcileRestoredPlayback() for why this needs to look further
   * than the graph's own Track nodes.
   * @param {object} playlist - A custom playlist (has its own graph).
   * @param {Set<string>} visited - Playlist ids already walked, across the whole call tree.
   * @returns {Array<object>} Playlist documents.
   * @private
   */
  _collectReferencedPlaylists(playlist, visited) {
    if (!playlist?.id || visited.has(playlist.id)) return [];
    visited.add(playlist.id);
    const graph = getCustomGraph(playlist);
    if (!graph) return [];

    const targets = [];
    for (const node of graph.nodes || []) {
      if (node.type !== 'playlist') continue;
      const target = resolvePlaylistRef(node.playlistRef);
      if (!target || visited.has(target.id)) continue;
      targets.push(target);
      targets.push(...this._collectReferencedPlaylists(target, visited));
    }
    return targets;
  }

  /**
   * The running custom-playback engine's current graph-activity snapshot for a
   * playlist, for priming the graph editor's live highlight when its window
   * opens mid-playback. Returns null whenever no engine is running for that
   * playlist - which includes every client that isn't the head GM, since the
   * engine only ever runs there.
   * @param {object} playlist - The playlist the caller is displaying.
   * @returns {object|null}
   */
  getGraphActivity(playlist) {
    if (!playlist) return null;
    // Walks into descendants spawned by a Playlist node, not just the root
    // context's own engine - the editor can be opened on a playlist that's
    // only ever reached as some other graph's Playlist-node target. Each layer
    // is a separate root of its own, so each needs its own walk.
    let engine = this._customEngine?.findEngineFor?.(playlist.id) ?? null;
    for (const run of this._layers.values()) {
      if (engine) break;
      engine = run.engine?.findEngineFor?.(playlist.id) ?? null;
    }
    return engine ? engine.activityState : null;
  }

  /**
   * Force a clean rebuild of the currently-playing context after a custom
   * playback graph is saved or removed via the editor. Without this, saving
   * an edit to a graph that's actively playing leaves the running engine on
   * its stale copy of the graph (custom-playlist-plan.md H8) - and because
   * the playlist itself didn't change, playCurrentTrack()'s normal
   * context-unchanged check would otherwise skip re-transitioning entirely.
   * Dropping currentContext first forces a real transition, tearing down the
   * stale engine and starting a fresh one against the saved graph.
   * @param {object} playlist - The playlist whose customPlayback flag changed.
   */
  async onCustomGraphChanged(playlist) {
    // A playlist can be "current" as the root context's own playlist, or
    // "nested" as some Playlist node's target running as a child engine -
    // either way, a live edit to ITS graph needs the same rebuild.
    const isCurrent = this.currentContext?.playlist?.id === playlist?.id;
    const isNested = this._customEngine?.isPlayingPlaylist?.(playlist?.id) ?? false;
    // Each layer is a separate engine tree and rebuilds on its own: retiring it here is enough,
    // because the _syncLayers() at the end of the playCurrentTrack() below starts a fresh one
    // over the saved graph. Deliberately NOT folded into the base rebuild - an edit to a layer's
    // graph must not restart the base music underneath it.
    const layerKeys = [...this._layers]
      .filter(([, run]) => run.engine?.isPlayingPlaylist?.(playlist?.id))
      .map(([key]) => key);
    for (const key of layerKeys) await this._retireLayer(key);
    if (!isCurrent && !isNested) {
      if (layerKeys.length > 0) this.playCurrentTrack();
      return;
    }
    // Must await the stop before starting the replacement engine below - see
    // CustomPlaybackEngine.stop()'s doc comment for the race this closes
    // (confirmed live: a Track node in the new graph sharing a soundId with a
    // just-stopped node could "adopt" it before the stop actually landed,
    // then wait forever for an 'end' event that would never come).
    await this._customEngine?.stop();
    this._customEngine = null;
    this.currentContext = null;
    this.playCurrentTrack();
  }

  /**
   * Refresh rendered UI applications when music state or context changes
   * @private
   */
  _refreshUI() {
    if (game.gameOrchestra?.playlistTree?.rendered) {
      game.gameOrchestra.playlistTree.render(false);
    }
    if (game.gameOrchestra?.moodWidget?.rendered) {
      game.gameOrchestra.moodWidget.render(false);
    }
  }

  /**
   * Get all current playlist contexts
   * @returns {PlaylistContext[]} Array of playlist contexts
   */
  getAllCurrentPlaylists() {
    const contexts = [];
    const scene = this.currentScene;
    const combat = this.currentCombat;

    // No overlay id is passed here - fromDocument() reads the setting matching
    // each call's own section axis (area -> mood, combat -> phase) itself.
    if (scene) {
      const areaCtx = PlaylistContext.fromDocument(scene, 'area', scene);
      if (areaCtx) contexts.push(areaCtx);
      const combatCtx = PlaylistContext.fromDocument(scene, 'combat', scene);
      if (combatCtx) contexts.push(combatCtx);
    }
    // Only an EXCLUSIVE combatant theme competes here. A layering one (the default) is
    // deliberately absent from this pool - it plays alongside the winner instead of against it,
    // and is fetched separately by getCombatantLayerContext(). The same is true of a mood or
    // phase overlay marked `layer`: PlaylistContext.fromDocument skips it and resolves the
    // section's own base, which is what the layer then plays over (getOverlayLayerContexts).
    const combatantResolution = this._resolveCombatantContext(combat);
    if (combatantResolution?.exclusive) contexts.push(combatantResolution.context);
    const defaultConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic);
    if (defaultConfig) {
      if (combat) {
        const ctx = PlaylistContext.fromDocument(defaultConfig, 'combat', combat);
        if (ctx) contexts.push(ctx);
      }
      const areaCtx = PlaylistContext.fromDocument(defaultConfig, 'area', scene);
      if (areaCtx) contexts.push(areaCtx);
    }
    return contexts;
  }

  /**
   * Filter playlist contexts based on current state
   * @param {PlaylistContext} context - Context to filter
   * @returns {boolean} True if context should be included
   */
  filterPlaylists(context) {
    const combat = this.currentCombat;
    if (context.context === 'combat' && !combat?.started) return false;
    if (context.context === 'combat' && game.settings.get(CONST.moduleId, CONST.settings.suppressCombat)) return false;
    if (context.context === 'area' && game.settings.get(CONST.moduleId, CONST.settings.suppressArea)) return false;
    return true;
  }

  /**
   * Combat categorically overrides area rather than competing with it by priority: once any
   * combat context has passed filterPlaylists (meaning combat is started, unsuppressed, and
   * configured somewhere), area contexts are dropped entirely instead of being ranked against it.
   * When no combat context is available, area contexts pass through unchanged.
   * @param {PlaylistContext[]} contexts - Contexts that already passed filterPlaylists
   * @returns {PlaylistContext[]} Contexts with area entries removed if a combat context is present
   */
  excludeAreaWhenCombatApplies(contexts) {
    const hasCombatContext = contexts.some((ctx) => ctx.context === 'combat');
    return hasCombatContext ? contexts.filter((ctx) => ctx.context !== 'area') : contexts;
  }

  /**
   * Sort playlist contexts by priority
   * @param {PlaylistContext} a - First context
   * @param {PlaylistContext} b - Second context
   * @param {Combat|null} combat - Active combat document
   * @returns {number} Sort comparison result
   */
  sortPlaylists(a, b, combat = null) {
    combat = combat ?? this.currentCombat;
    const currentCombatant = combat?.combatant;
    const currentToken = currentCombatant?.token;
    const currentActor = currentCombatant?.actor;
    const currentPrototype = currentActor?.prototypeToken;
    const isCurrentA = a.contextEntity === currentToken || a.contextEntity === currentActor || a.contextEntity === currentPrototype;
    const isCurrentB = b.contextEntity === currentToken || b.contextEntity === currentActor || b.contextEntity === currentPrototype;
    if (isCurrentA && !isCurrentB) return -1;
    if (!isCurrentA && isCurrentB) return 1;

    return b.priority - a.priority;
  }

  /**
   * Every document that may speak for a combatant, most specific first. The caller takes the
   * FIRST one that actually carries an override - these are fallbacks, not competitors, so a
   * combatant contributes at most one context no matter how many of them are configured.
   *
   * The prototype token has to be in this chain even when the combatant has a placed token,
   * and that is not a hypothetical: it is where the token sheet's own config window writes
   * whenever it was opened from an Actor's prototype token (app.isPrototype), and a placed
   * token only ever gets a COPY of the prototype's flags at creation time. Returning the
   * placed token unconditionally - which is what this used to do - meant a prototype-level
   * assignment saved correctly, re-read correctly in its own window, and then was never once
   * consulted during combat. Confirmed live: assigning to prototype token 'B' left combat
   * falling through to the world-default playlist with
   * "No playlist override found on document 'B'".
   *
   * For a LINKED token the actor still outranks it (that is the whole point of the
   * `useTokenMusic` flag), but the prototype is a legitimate actor-level source in its own
   * right - no UI in this module writes actor flags directly, so without it a linked
   * combatant has no configurable actor-level music at all.
   * @param {TokenDocument} token Token document
   * @param {Actor} actor Actor document
   * @returns {Document[]} Ordered, de-duplicated candidate documents (may be empty)
   * @private
   */
  _getCombatantMusicSources(token, actor) {
    if (!token && !actor) return [];
    const isLinked = token?.actorLink ?? false;
    const useTokenMusic = token?.getFlag?.(CONST.moduleId, 'useTokenMusic') ?? false;
    const proto = actor?.prototypeToken ?? null;

    // A linked token's own flags are deliberately skipped unless it opts in - a linked token
    // inherits the prototype's flags at creation, so honouring them would make every linked
    // token silently override its actor.
    const ordered = (isLinked && !useTokenMusic)
      ? (actor ? [actor, proto] : [token])
      : [token, proto, actor];
    return [...new Set(ordered.filter(Boolean))];
  }

  /**
   * The combat context contributed by the combatant whose turn it is, plus whether that
   * combatant asked to play EXCLUSIVELY (replacing the winning context, the pre-layering
   * behaviour) rather than as a layer over it.
   *
   * ONLY the current combatant is consulted. A token/actor override is a TURN theme, not a fight
   * theme: when the turn passes to someone with no override of their own, resolution has to fall
   * back through scene combat and the world default rather than staying on the previous
   * combatant. Iterating every non-defeated combatant - which this used to do - kept the first
   * configured combatant's context in the pool for the entire fight, and since token combat
   * outranks scene combat (+20 vs -15) it simply won every turn; the current-combatant-first rule
   * in sortPlaylists() could never demote it, because unconfigured combatants contribute nothing
   * for it to be promoted over.
   *
   * `exclusive` is read off the SAME source document the context resolved from, at section level
   * (`music.combat.exclusive`) - never per phase overlay. Absent means false, so an override
   * configured before layering existed layers by default.
   * @param {Combat|null} [combat] - Defaults to the active combat.
   * @returns {{context: PlaylistContext, exclusive: boolean, source: Document}|null}
   * @private
   */
  _resolveCombatantContext(combat = this.currentCombat) {
    const combatant = combat?.combatant;
    if (!combatant || combatant.isDefeated) return null;
    // First source that carries an override wins - see _getCombatantMusicSources(). Taking every
    // hit instead would let one combatant contribute two competing contexts.
    for (const source of this._getCombatantMusicSources(combatant.token, combatant.actor)) {
      const context = PlaylistContext.fromDocument(source, 'combat', combat);
      if (!context) continue;
      return { context, exclusive: readMusicSection(source, 'combat')?.exclusive === true, source };
    }
    return null;
  }

  /**
   * The context that should play as an additive LAYER over whatever won the ordinary resolution -
   * the current combatant's theme, unless it opted into playing exclusively (in which case it is
   * in the winner pool instead and there is no layer).
   *
   * A layer is filtered by the same rules as any combat context (`combat.started`, the
   * suppressCombat setting - filterPlaylists()), but it never goes through
   * excludeAreaWhenCombatApplies() or sortPlaylists(): it does not compete, so it has no
   * priority and cannot be beaten. It plays over whatever the base happens to be, area music
   * included - a boss theme joining the ambient track is preferable to it silently not playing
   * because no combat music was configured anywhere.
   * @returns {PlaylistContext|null}
   */
  getCombatantLayerContext() {
    const resolution = this._resolveCombatantContext();
    if (!resolution || resolution.exclusive) return null;
    return this.filterPlaylists(resolution.context) ? resolution.context : null;
  }

  /**
   * Every mood/phase overlay entry currently asking to play as an additive LAYER over its own
   * section's base music - at most one per section, since one base can only be layered once from
   * the same axis.
   *
   * **Scope is a fallback chain, not a contest**, exactly like _getCombatantMusicSources(): the
   * active scene first, then the world default, and the first one whose active overlay is marked
   * `layer` supplies that section's layer. Letting both layer at once would put two audio streams
   * over one base for one mood, which is not what "the scene's mood overlay" means - and the
   * world default is the fallback by definition.
   *
   * Only those two scopes are consulted. A token/actor's combat section already has its own
   * layering mechanism at section level (`exclusive`/`duck` - getCombatantLayerContext), and no
   * surface writes `layer` on a token overlay.
   *
   * Filtered by filterPlaylists() like any context of the same section, and an AREA layer is
   * additionally dropped once combat music has won the base resolution: moods are the area axis
   * (config.mjs#sectionAxis), and leaving an ambience layer running over a boss fight is not what
   * "an overlay over the base area music" means. Nothing here goes through sortPlaylists() - a
   * layer does not compete.
   * @param {PlaylistContext|null} [baseContext] - The base these layers will play over; defaults
   *   to the one currently playing.
   * @returns {PlaylistContext[]}
   */
  getOverlayLayerContexts(baseContext = this.currentContext) {
    const scene = this.currentScene;
    const defaultConfig = game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || null;
    const contexts = [];
    for (const type of ['area', 'combat']) {
      let context = null;
      for (const document of [scene, defaultConfig]) {
        context = PlaylistContext.layerFromDocument(document, type, scene);
        if (context) break;
      }
      if (!context || !this.filterPlaylists(context)) continue;
      if (type === 'area' && baseContext?.context === 'combat') continue;
      contexts.push(context);
    }
    return contexts;
  }

  /**
   * Play a track sound object safely
   * @param {object} sound Sound object to play
   */
  async playTrack(sound) {
    if (!sound) return;
    try {
      if (sound.parent?.playSound) {
        await sound.parent.playSound(sound).catch((error) => {
          if (error?.name === 'AbortError' || error?.message?.includes('interrupted')) return;
          throw error;
        });
      } else if (typeof sound.play === 'function') {
        await sound.play().catch((error) => {
          if (error?.name === 'AbortError' || error?.message?.includes('interrupted')) return;
          throw error;
        });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message?.includes('interrupted')) {
        return;
      }
      log(1, `Error playing track '${sound.name}':`, error);
      return;
    }
    // After the await, and only on the paths that did not bail: a listener told a track started
    // that never did would be worse than no hook at all. Note this fires on the head GM only -
    // it reports what the module DECIDED to play, not what any given client is hearing.
    emitHook(CONST.hooks.TRACK_STARTED, { playlistId: sound.parent?.id ?? null, soundId: sound.id, soundName: sound.name });
  }

  /**
   * Stop a track sound object safely. Returns the underlying stop promise
   * (when there is one) so a caller that needs the stop to have actually
   * landed before doing anything else - CustomPlaybackEngine.stop(), notably -
   * can await it instead of racing it.
   *
   * Releases the sound from _managedSoundIds: that set exists so a later
   * transition's fade-out loop only ever touches sounds this controller itself
   * started (never a GM's manually-started ambience), but without releasing it
   * here a sound stays "managed" forever after its first play - so if the GM
   * later starts that same sound by hand from the sidebar, the next transition
   * would silently fade it out again, mistaking it for one of its own.
   * @param {object} sound Track sound object to stop
   * @returns {Promise<void>|undefined}
   */
  stopTrack(sound) {
    if (!sound) return;
    this._managedSoundIds.delete(sound.id);
    // Emitted before the stop rather than after it: this method deliberately returns the stop
    // promise instead of awaiting it (see the doc comment), so there is no "after" to hook on
    // that would not change that contract. The decision to stop has already been made here.
    emitHook(CONST.hooks.TRACK_STOPPED, { playlistId: sound.parent?.id ?? null, soundId: sound.id, soundName: sound.name });
    try {
      if (sound.parent?.stopSound) {
        const res = sound.parent.stopSound(sound);
        if (res && typeof res.catch === 'function') {
          return res.catch((error) => {
            if (error?.name === 'AbortError' || error?.message?.includes('interrupted')) return;
          });
        }
        return res;
      } else if (sound.sound?.stop) {
        sound.sound.stop();
      } else if (typeof sound.stop === 'function') {
        sound.stop();
      }
    } catch (error) {
      // Ignore abort errors from rapid playback transitions
    }
  }

  /**
   * Save track playback offset position onto entity flags / memory
   * @param {Document} entity Entity to save progress onto
   * @param {object} sound Track sound object
   */
  savePlaylistData(entity, sound) {
    if (!entity || !sound) {
      log(3, 'Skipping savePlaylistData: no current tracks or invalid entity.');
      return;
    }

    const soundId = sound.id;
    const currentOffset = sound.sound?.currentTime || 0;

    const entityKey = `${entity.documentName || 'Entity'}_${entity.id}`;
    const entityPositions = this._touchPlaylistPositionsEntry(entityKey);
    entityPositions[soundId] = currentOffset;

    log(3, `Successfully saved playlist position for track '${sound.name}' on entity '${entity.name || entity.id}': start=${currentOffset}`);
  }

  /**
   * Get saved track playback offset position from entity flags / memory
   * @param {Document} entity Entity to retrieve progress from
   * @param {object} sound Track sound object
   * @returns {number} Saved offset in seconds
   */
  getPlaylistData(entity, sound) {
    if (!entity || !sound) return 0;

    const soundId = sound.id;
    const entityKey = `${entity.documentName || 'Entity'}_${entity.id}`;
    if (!this._savedPlaylistPositions.has(entityKey)) return 0;
    const entityPositions = this._touchPlaylistPositionsEntry(entityKey);

    return entityPositions[soundId] ?? 0;
  }

  /**
   * Fetch (or create) an entity's position-cache entry and mark it
   * most-recently-used, evicting the actual least-recently-used entry first
   * if the cache is full. Map iteration order is insertion order, so
   * deleting and re-setting an existing key moves it to the end - both a save
   * and a read count as a "use" here, or an entity whose music is merely
   * being checked (not updated) could still be evicted while it's the one
   * actively playing.
   * @param {string} entityKey
   * @returns {Record<string, number>}
   * @private
   */
  _touchPlaylistPositionsEntry(entityKey) {
    const existing = this._savedPlaylistPositions.get(entityKey);
    if (existing) {
      this._savedPlaylistPositions.delete(entityKey);
      this._savedPlaylistPositions.set(entityKey, existing);
      return existing;
    }
    if (this._savedPlaylistPositions.size >= 50) {
      const lruKey = this._savedPlaylistPositions.keys().next().value;
      this._savedPlaylistPositions.delete(lruKey);
    }
    const fresh = {};
    this._savedPlaylistPositions.set(entityKey, fresh);
    return fresh;
  }

  /**
   * Fade in track volume safely after unlock
   * @param {object} track Track sound object
   * @param {number} fadeDurationMs Fade duration in milliseconds
   * @param {number} targetVolume Desired final volume level
   * @param {number} transitionId The transitionToContext() call this fade-in belongs to;
   *   re-checked on every retry so a superseded transition's fade-in cannot land on top
   *   of a track a newer transition has already faded out or stopped.
   * @private
   */
  _fadeInWhenReady(track, fadeDurationMs, targetVolume = 1.0, transitionId) {
    const finalVolume = targetVolume ?? mixedVolume(track);
    log(3, `Fading in track '${track.name}' to volume ${finalVolume} over ${fadeDurationMs}ms`);

    let attempts = 0;
    const maxAttempts = 20; // 2 seconds max retry

    const waitForAudio = () => {
      if (this._transitionSequenceId !== transitionId) return; // superseded by a newer transition
      attempts++;
      const soundObj = track.sound || track;
      const isReady = track.sound ? (track.sound.loaded || track.sound.playing || track.playing || attempts >= maxAttempts) : true;

      if (isReady) {
        log(3, `Track '${track.name}' audio ready. Applying in-memory volume fade to ${finalVolume} over ${fadeDurationMs}ms.`);
        if (typeof soundObj?.fade === 'function') {
          soundObj.fade(finalVolume, { duration: fadeDurationMs, from: 0 });
        } else if (typeof soundObj?.volume !== 'undefined') {
          soundObj.volume = finalVolume;
        }
      } else {
        setTimeout(waitForAudio, 100);
      }
    };

    waitForAudio();
  }
}
