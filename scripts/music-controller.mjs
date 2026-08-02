import { CONST } from './config.mjs';
import { log, PlaylistContext, FadingTrack, isHeadGM, isCustomPlaylist, getCustomGraph, resolvePlaylistRef } from './helpers.mjs';
import { CustomPlaybackEngine } from './custom-playback-engine.mjs';
import { getPlaylistMix, mixedVolume } from './playlist-mix-apply.mjs';
import { resolveCrossfadeOverride } from './playlist-mix.mjs';

/**
 * Main music controller class for Game Orchestra module
 */
export class MusicController {
  constructor() {
    this.fadingTracks = [];
    this.currentTracks = [];
    this.currentContext = null;
    this.isDebouncing = false;
    this._savedPlaylistPositions = new Map();
    this._managedSoundIds = new Set();
    this._audioUnlockRegistered = false;
    this._transitionSequenceId = 0;
    this._debounceTimer = null;
    this._customEngine = null;
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
        return;
      }

      if (contextUnchanged && !audioActuallyPlaying && targetTracks.length > 0) {
        log(3, 'Context unchanged but audio is not playing — restarting tracks.');
      }

      await this.transitionToContext(winnerContext);
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
   */
  async transitionToContext(targetContext) {
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
      this.currentContext = targetContext;
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
    const playlistCrossfadeMs = resolveCrossfadeOverride(getPlaylistMix(targetContext?.playlist)?.crossfadeMs);
    const fadeDurationSec = game.settings.get(CONST.moduleId, CONST.settings.fadeDuration) ?? 3;
    const fadeDurationMs = playlistCrossfadeMs ?? fadeDurationSec * 1000;

    log(3, `Transitioning music context to '${targetContext?.playlist?.name || 'none'}' (stopping ${this.fadingTracks.length} tracks, starting ${targetTracks.length} tracks, fade: ${fadeDurationMs}ms)`);

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

    // Fade out current playing tracks (excluding targetTracks). Only ever touches sounds
    // this controller itself previously started — a GM's manually-started ambience or
    // jukebox playlist is left alone rather than being silently cut off.
    for (const activeSound of game.playlists.playing.flatMap((p) => Array.from(p.sounds.values()))) {
      if (targetTrackIds.has(activeSound.id)) continue;
      if (!this._managedSoundIds.has(activeSound.id)) continue;
      if (activeSound.playing) {
        const soundObj = activeSound.sound || activeSound;
        if (fadeDurationMs > 0 && typeof soundObj?.fade === 'function') {
          log(3, `Fading out track '${activeSound.name}' over ${fadeDurationMs}ms`);
          soundObj.fade(0, { duration: fadeDurationMs }).then(() => {
            this.stopTrack(activeSound);
          }).catch(() => {
            this.stopTrack(activeSound);
          });
          this.fadingTracks.push(new FadingTrack(activeSound, fadeDurationMs));
        } else {
          this.stopTrack(activeSound);
        }
      }
    }

    if (isCustomPlaylist(targetContext?.playlist)) {
      this.currentContext = targetContext;
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

    this.currentContext = targetContext;
    this.currentTracks = targetTracks;
    for (const track of targetTracks) this._managedSoundIds.add(track.id);
    this._refreshUI();

    // A track that's already audibly playing needs no action - re-triggering playback
    // here is what causes tracks to audibly restart from the beginning on every
    // unrelated config change that happens to re-resolve to the same winning context.
    const tracksToStart = targetTracks.filter((targetTrack) => {
      const alreadyPlaying = targetTrack.playing === true || targetTrack.sound?.playing === true;
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
    if (!playlist || !this._customEngine) return null;
    // Walks into descendants spawned by a Playlist node, not just the root
    // context's own engine - the editor can be opened on a playlist that's
    // only ever reached as some other graph's Playlist-node target.
    const engine = this._customEngine.findEngineFor?.(playlist.id);
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
    if (!isCurrent && !isNested) return;
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
    // ONLY the combatant whose turn it is. A token/actor override is a TURN theme, not a fight
    // theme: when the turn passes to someone with no override of their own, resolution has to
    // fall back through scene combat and the world default rather than staying on the previous
    // combatant. Iterating every non-defeated combatant here - which is what this used to do -
    // kept the first configured combatant's context in the pool for the entire fight, and since
    // token combat outranks scene combat (+20 vs -15) it simply won every turn. The
    // current-combatant-first rule in sortPlaylists() could never demote it, because unconfigured
    // combatants contribute nothing for it to be promoted over.
    const combatant = combat?.combatant;
    if (combatant && !combatant.isDefeated) {
      // First source that carries an override wins - see _getCombatantMusicSources(). Pushing
      // every hit instead would let one combatant contribute two competing contexts.
      for (const musicSource of this._getCombatantMusicSources(combatant.token, combatant.actor)) {
        const ctx = PlaylistContext.fromDocument(musicSource, 'combat', combat);
        if (ctx) {
          contexts.push(ctx);
          break;
        }
      }
    }
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
    }
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
