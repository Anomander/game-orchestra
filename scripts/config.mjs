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
    activeDuck: 'activeDuck'
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
  playlistSections: {
    Scene: { area: { label: 'GameOrchestra.PlaylistSection.Area', priority: -20 }, combat: { label: 'GameOrchestra.PlaylistSection.Combat', priority: -15 } },
    Token: { combat: { label: 'GameOrchestra.PlaylistSection.Combat', priority: 20 } }
  },
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
