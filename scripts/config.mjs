/**
 * Configuration constants for the Game Orchestra module
 */
export const CONST = {
  moduleId: 'game-orchestra',
  settings: {
    defaultMusic: 'defaultMusic',
    suppressArea: 'suppressArea',
    suppressCombat: 'suppressCombat',
    fadeDuration: 'fadeDuration',
    graphCrossfade: 'graphCrossfade',
    activeMood: 'activeMood',
    configuredMoods: 'configuredMoods',
    activePhase: 'activePhase',
    configuredPhases: 'configuredPhases',
    resetPhaseOnCombatEnd: 'resetPhaseOnCombatEnd',
    moodWidgetPosition: 'moodWidgetPosition',
    activeDuck: 'activeDuck',
    allowInlineScripts: 'allowInlineScripts',
    scriptTimeout: 'scriptTimeout'
  },
  defaultMoods: [
    { id: 'calm', label: 'GameOrchestra.Mood.Calm', icon: 'fas fa-leaf', color: '#4caf50' },
    { id: 'tense', label: 'GameOrchestra.Mood.Tense', icon: 'fas fa-exclamation-triangle', color: '#ff9800' },
    { id: 'stealth', label: 'GameOrchestra.Mood.Stealth', icon: 'fas fa-user-ninja', color: '#9c27b0' },
    { id: 'victory', label: 'GameOrchestra.Mood.Victory', icon: 'fas fa-trophy', color: '#ffeb3b' }
  ],
  /** Phase overlays: the combat-section counterpart to area's moods (see overlayAxes below). */
  defaultPhases: [
    { id: 'p1', label: 'GameOrchestra.Phase.PhaseOne', icon: 'fas fa-shield-halved', color: '#4caf50' },
    { id: 'p2', label: 'GameOrchestra.Phase.PhaseTwo', icon: 'fas fa-droplet', color: '#ff9800' },
    { id: 'enrage', label: 'GameOrchestra.Phase.Enrage', icon: 'fas fa-fire', color: '#f44336' },
    { id: 'victory', label: 'GameOrchestra.Phase.Victory', icon: 'fas fa-trophy', color: '#ffeb3b' }
  ],
  /**
   * Per-scope, per-section baseline priorities. Resolution sorts **descending**
   * (`MusicController#sortPlaylists`), so a HIGHER number wins - the ladder below reads
   * bottom-up: world default < scene < token.
   *
   * The world default's entry is load-bearing and was missing for a long time. Without it
   * `sectionBaselinePriority` fell through to its `?? 0` "scope has no such section" default,
   * and 0 outranks the scene's -20/-15 - so a global binding beat every scene binding and the
   * whole scope hierarchy resolved backwards. It read as correct because 0 *looks* like the
   * bottom of the ladder next to a negative number. Confirmed live: a scene default lost to a
   * global mood and the tree correctly reported it as "overridden by Global Mood".
   *
   * The 20-point gaps are not decoration either. An overlay (mood/phase) binding is resolved at
   * its section's baseline **+10** (`PlaylistContext._extractSectionConfig`), so a gap smaller
   * than 10 would let one scope's mood jump over the next scope's default. At -40/-20, the
   * global mood lands at -30 and stays under the scene default's -20.
   */
  playlistSections: {
    DefaultMusic: { area: { label: 'GameOrchestra.PlaylistSection.Area', priority: -40 }, combat: { label: 'GameOrchestra.PlaylistSection.Combat', priority: -35 } },
    Scene: { area: { label: 'GameOrchestra.PlaylistSection.Area', priority: -20 }, combat: { label: 'GameOrchestra.PlaylistSection.Combat', priority: -15 } },
    Token: { combat: { label: 'GameOrchestra.PlaylistSection.Combat', priority: 20 } }
  },
  /**
   * Every hook this module fires, by name. Part of the public API
   * (`api.hooks`), so a listener need not hard-code strings.
   *
   * All of them are **fire-and-forget and non-fatal**, and that is a hard rule
   * rather than a courtesy: `Hooks.callAll()` runs listeners *synchronously*, so
   * an exception thrown by a third-party listener on a hook emitted inside the
   * token walk propagates straight into the walk and SILENTLY STOPS PLAYBACK.
   * Emit through helpers.mjs#emitHook, never `Hooks.callAll` directly, and read
   * custom-playback-engine.mjs#_emitActivity - the original instance of this
   * reasoning - before adding another.
   */
  hooks: Object.freeze({
    /** Every graph node hop: {playlistId, runId, activeNodeIds, activeTimings, enteredNodeId, traversedEdgeIds}. */
    GRAPH_ACTIVITY: 'gameOrchestraGraphActivity',
    /** The winning context changed: {from, to} as plain descriptors (api.mjs#describeContext). */
    CONTEXT_CHANGED: 'gameOrchestraContextChanged',
    /** A track the module started began playing: {playlistId, soundId, soundName}. */
    TRACK_STARTED: 'gameOrchestraTrackStarted',
    /** A track the module started was stopped by it: {playlistId, soundId, soundName}. */
    TRACK_STOPPED: 'gameOrchestraTrackStopped',
    /**
     * An overlay axis's active id changed: {axis: 'mood'|'phase', from, to}. ONE hook carrying
     * the axis, not two - config.mjs#overlayAxes models the two axes as one mechanism, and
     * docs/wiki/ux.md D4 is the record of what splitting them into two of everything cost.
     */
    OVERLAY_CHANGED: 'gameOrchestraOverlayChanged',
    /**
     * A Script node failed: {phase, playlistId, nodeId, message}. `phase` is
     * one of 'blocked' | 'compile' | 'execute' | 'timeout' | 'missing'. Emitted for every failure
     * shape so a listener never has to distinguish "did not run" from "ran and threw" by absence.
     */
    SCRIPT_ERROR: 'gameOrchestraScriptError'
  }),
  /**
   * Which overlay axis each music section resolves against: area music is
   * overlaid by mood, combat music by phase. See overlays-and-loop-modes-plan.md
   * O1. Fixed and not user-extensible - two axes bound to two sections.
   */
  sectionAxis: { area: 'mood', combat: 'phase' },
  /**
   * Axis descriptor: which world setting supplies the active overlay id, and
   * which supplies the list of definitions, for each axis.
   */
  overlayAxes: {
    mood: { activeSetting: 'activeMood', listSetting: 'configuredMoods' },
    phase: { activeSetting: 'activePhase', listSetting: 'configuredPhases' }
  }
};
