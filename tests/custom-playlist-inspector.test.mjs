import { describe, it, expect } from 'vitest';
import { buildInspectorHtml, buildValidationHtml, buildIssueBalloonHtml } from '../scripts/custom-playlist-inspector.mjs';

describe('buildIssueBalloonHtml', () => {
  it('numbers every message for the node', () => {
    const html = buildIssueBalloonHtml(['first problem', 'second problem'], 'warning');
    expect(html).toContain('<ol');
    expect(html).toContain('<li>first problem</li>');
    expect(html).toContain('<li>second problem</li>');
  });

  it('carries the severity through as a class, so the balloon matches its badge', () => {
    expect(buildIssueBalloonHtml(['x'], 'error')).toContain('game-orchestra-issue-balloon-error');
    expect(buildIssueBalloonHtml(['x'], 'warning')).toContain('game-orchestra-issue-balloon-warning');
  });

  it('treats an unknown severity as a warning rather than emitting a stray class', () => {
    const html = buildIssueBalloonHtml(['x'], undefined);
    expect(html).toContain('game-orchestra-issue-balloon-warning');
    expect(html).not.toContain('undefined');
  });

  it('escapes messages - they interpolate user-supplied node names', () => {
    const html = buildIssueBalloonHtml(['<img src=x onerror=alert(1)>'], 'error');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('returns nothing at all when there is nothing to show', () => {
    expect(buildIssueBalloonHtml([], 'warning')).toBe('');
    expect(buildIssueBalloonHtml(undefined, 'warning')).toBe('');
    expect(buildIssueBalloonHtml(null, 'warning')).toBe('');
  });

  it('drops blank messages instead of rendering empty numbered rows', () => {
    const html = buildIssueBalloonHtml(['', '   ', 'real problem'], 'warning');
    expect(html).toContain('<li>real problem</li>');
    expect(html.match(/<li>/g)).toHaveLength(1);
  });

  it('returns nothing when every message is blank', () => {
    expect(buildIssueBalloonHtml(['', '  '], 'warning')).toBe('');
  });
});

const loc = (k) => k;

describe('buildInspectorHtml', () => {
  it('shows the "no selection" hint when nothing is selected', () => {
    const html = buildInspectorHtml({ selectedNode: null, soundOptions: [], selectedExits: [], localize: loc });
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.NoSelection');
    expect(html).not.toContain('<h3>');
  });

  it('renders the sound as a read-only value, not an editable control, plus a loop count input for a Track node', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 3 } },
      soundOptions: [{ id: 's1', name: 'Battle Theme', selected: true }],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('<p class="game-orchestra-readonly-value">Battle Theme</p>');
    // The sound is fixed at node creation - a Track node is placed per sound by dragging one in
    // from the Tracks pane, never repointed here.
    expect(html).not.toContain('updateTrackSound');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.SoundReadOnly');
    expect(html).toContain('data-node-id="t1"');
    expect(html).toContain('data-change-action="updateTrackLoopCount"');
    expect(html).toContain('value="3"');
  });

  it('shows only the selected sound, never the other sounds in the playlist - there is nothing to pick from', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 1 } },
      soundOptions: [
        { id: 's1', name: 'Battle Theme', selected: true },
        { id: 's2', name: 'Tavern Theme', selected: false }
      ],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('Battle Theme');
    expect(html).not.toContain('Tavern Theme');
  });

  it('falls back to an emphasised "none" for a Track node with no sound assigned', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 1 } },
      soundOptions: [{ id: 's1', name: 'Battle Theme', selected: false }],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('<span class="game-orchestra-value-empty">GameOrchestra.None</span>');
    expect(html).not.toContain('Battle Theme');
  });

  it('renders the Infinite checkbox checked and hides the Until toggle for a forever-mode Track node', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'forever' } },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toMatch(/data-change-action="updateTrackInfinite"[^>]*checked/);
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.InfiniteHint');
    expect(html).not.toContain('data-change-action="updateTrackUntilToggle"');
    expect(html).not.toContain('data-change-action="updateTrackLoopCount"');
  });

  it('renders an unchecked Until toggle and the Loop Count field for a count-mode Track node', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 3 } },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('data-change-action="updateTrackUntilToggle"');
    expect(html).not.toMatch(/data-change-action="updateTrackUntilToggle"[^>]*checked/);
    expect(html).toContain('data-change-action="updateTrackLoopCount"');
    expect(html).not.toContain('data-change-action="updateTrackUntilKind"');
  });

  it('renders a checked Until toggle and the until sub-fields (not Loop Count) for an until-mode Track node', () => {
    const html = buildInspectorHtml({
      selectedNode: {
        id: 't1',
        type: 'track',
        loop: { mode: 'until', condition: { kind: 'phase', value: 'boss' }, boundary: 'loopEnd', minLoops: 2, maxLoops: 5 }
      },
      soundOptions: [],
      selectedExits: [],
      phaseOptions: [{ id: 'boss', label: 'Boss' }],
      localize: loc
    });
    expect(html).toMatch(/data-change-action="updateTrackUntilToggle"[^>]*checked/);
    expect(html).not.toContain('data-change-action="updateTrackLoopCount"');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.UntilHint');
    expect(html).toContain('data-change-action="updateTrackUntilKind"');
    // The kind select's options are human-readable labels, not raw kind strings.
    expect(html).toContain('value="phase" selected');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ConditionKind.Phase');
    expect(html).not.toContain('>phase<');
    // The value field is a dropdown of configured phases, not a free-text input.
    expect(html).toContain('data-change-action="updateTrackUntilValue"');
    expect(html).toMatch(/<select data-change-action="updateTrackUntilValue"[^>]*>[\s\S]*value="boss" selected[\s\S]*Boss[\s\S]*<\/select>/);
    expect(html).toContain('data-change-action="updateTrackUntilBoundary"');
    expect(html).toMatch(/value="loopEnd" selected/);
    expect(html).toContain('data-change-action="updateTrackUntilMinLoops"');
    expect(html).toContain('value="2"');
    expect(html).toContain('data-change-action="updateTrackUntilMaxLoops"');
    expect(html).toContain('value="5"');
  });

  it('omits the value field for an until condition kind that takes no value', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).not.toContain('data-change-action="updateTrackUntilValue"');
    expect(html).toContain('placeholder="GameOrchestra.CustomEditor.Inspector.UntilMaxLoopsUnbounded"');
  });

  it("offers 'Mood Changes'/'Phase Changes' as until-kind options and omits the value field for them", () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'until', condition: { kind: 'moodChanged' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('value="moodChanged" selected');
    expect(html).toContain('<option value="phaseChanged"');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ConditionKind.MoodChanged');
    expect(html).not.toContain('data-change-action="updateTrackUntilValue"');
  });

  it("falls back to moodOptions for kind 'mood' and does not mix in phaseOptions", () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'until', condition: { kind: 'mood', value: 'calm' }, boundary: 'immediate', minLoops: 1, maxLoops: null } },
      soundOptions: [],
      selectedExits: [],
      moodOptions: [{ id: 'calm', label: 'Calm' }],
      phaseOptions: [{ id: 'boss', label: 'Boss' }],
      localize: loc
    });
    expect(html).toMatch(/<select data-change-action="updateTrackUntilValue"[^>]*>[\s\S]*value="calm" selected[\s\S]*Calm[\s\S]*<\/select>/);
    expect(html).not.toContain('Boss');
  });

  // The empty-playlist hint moved to the Tracks pane (playlist-mixer-render.mjs), which is now
  // the only place a sound is chosen - repeating it here would point at a control that no longer
  // exists in this panel.
  it.each([[[]], [[{ id: 's1', name: 'Battle Theme', selected: false }]]])('never shows the empty-playlist hint, with soundOptions %j', (soundOptions) => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 1 } },
      soundOptions,
      selectedExits: [],
      localize: loc
    });
    expect(html).not.toContain('GameOrchestra.CustomEditor.Inspector.NoSounds');
  });

  it('renders min/max delay inputs for a Delay node', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'd1', type: 'delay', delay: { min: 2, max: 5 } },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('data-change-action="updateDelayMin"');
    expect(html).toContain('value="2"');
    expect(html).toContain('data-change-action="updateDelayMax"');
    expect(html).toContain('value="5"');
  });

  it('renders one weight/cooldown/remove row per exit for a Random node, plus an add-exit button', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'r1', type: 'random' },
      soundOptions: [],
      selectedExits: [
        { portName: 'output_1', weight: 2, cooldown: 1 },
        { portName: 'output_2', weight: 5, cooldown: 0 }
      ],
      localize: loc
    });
    expect(html).toContain('data-exit-index="0"');
    expect(html).toContain('data-exit-index="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain('value="5"');
    expect(html).toContain('data-port="output_1"');
    expect(html).toContain('data-port="output_2"');
    expect(html).toContain('data-action="addExit"');
  });

  it('renders an avoidRepeat checkbox for a Random node, checked when the node has it enabled', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'r1', type: 'random', avoidRepeat: true },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('data-change-action="updateRandomAvoidRepeat"');
    expect(html).toMatch(/data-change-action="updateRandomAvoidRepeat"[^>]*checked/);
  });

  it('renders a kind select per exit for a Condition node, with a mood-value dropdown only when kind is mood', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'c1', type: 'condition' },
      soundOptions: [],
      selectedExits: [
        { portName: 'output_1', condition: { kind: 'mood', value: 'boss' } },
        { portName: 'output_2', condition: { kind: 'default' } }
      ],
      moodOptions: [{ id: 'boss', label: 'Boss' }],
      localize: loc
    });
    expect(html).toContain('data-change-action="updateConditionExitKind"');
    expect(html).toContain('value="mood" selected');
    // The kind option text is a human-readable label, not the raw 'mood' string.
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ConditionKind.Mood');
    expect(html).not.toContain('>mood<');
    expect(html).toContain('data-change-action="updateConditionExitValue"');
    expect(html).toMatch(/<select data-change-action="updateConditionExitValue"[^>]*>[\s\S]*value="boss" selected[\s\S]*Boss[\s\S]*<\/select>/);
    // The second (default) exit must NOT get a mood-value dropdown.
    const secondRowIndex = html.indexOf('data-exit-index="1"');
    expect(html.slice(secondRowIndex, secondRowIndex + 300)).not.toContain('updateConditionExitValue');
  });

  it('renders a hint and no editable fields for a Fork node with no exits yet', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'f1', type: 'fork' },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ForkHint');
    // Every node type gets a Name field; a Fork has nothing else to configure -
    // its exits are bare ports, so no per-exit inputs either.
    expect(html).toContain('data-change-action="updateNodeLabel"');
    expect(html.match(/data-change-action="(\w+)"/g)).toEqual(['data-change-action="updateNodeLabel"']);
  });

  it('renders a Name field for every node type, defaulting its placeholder to the type', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'd1', type: 'delay', label: 'Breather' },
      soundOptions: [],
      selectedExits: [],
      localize: loc
    });
    expect(html).toContain('data-change-action="updateNodeLabel"');
    expect(html).toContain('value="Breather"');
    expect(html).toContain('placeholder="Delay"');
  });

  it('renders a remove button per exit and an add-exit button for a Fork node (no weight/condition fields - every exit fires together)', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 'f1', type: 'fork' },
      soundOptions: [],
      selectedExits: [{ portName: 'output_1' }, { portName: 'output_2' }],
      localize: loc
    });
    expect(html).toContain('data-port="output_1"');
    expect(html).toContain('data-port="output_2"');
    expect(html).toContain('data-action="removeExit"');
    expect(html).toContain('data-action="addExit"');
    expect(html).not.toContain('updateRandomExitWeight');
    expect(html).not.toContain('updateConditionExitKind');
  });

  describe('playlist node', () => {
    it('renders the source select and a playlist select for a direct reference', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl1' }, loop: { mode: 'count', count: 2 } },
        soundOptions: [],
        playlistOptions: [{ id: 'pl1', name: 'Tavern Theme', selected: true }],
        selectedExits: [],
        localize: loc
      });
      expect(html).toContain('data-change-action="updatePlaylistSource"');
      expect(html).toContain('value="direct" selected');
      expect(html).toContain('data-change-action="updatePlaylistTarget"');
      expect(html).toContain('value="pl1" selected');
      expect(html).toContain('Tavern Theme');
      expect(html).not.toContain('data-change-action="updatePlaylistSection"');
    });

    it('shows a hint when there are no playlists to reference directly, but still renders the select', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: null }, loop: { mode: 'count', count: 1 } },
        soundOptions: [],
        playlistOptions: [],
        selectedExits: [],
        localize: loc
      });
      expect(html).toContain('GameOrchestra.CustomEditor.Inspector.NoPlaylists');
      expect(html).toContain('data-change-action="updatePlaylistTarget"');
    });

    it('renders section and overlay-mode selects for an indirect (scene) reference, not a playlist select', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'combat', overlayMode: 'active' }, loop: { mode: 'count', count: 1 } },
        soundOptions: [],
        selectedExits: [],
        localize: loc
      });
      expect(html).toContain('value="scene" selected');
      expect(html).toContain('data-change-action="updatePlaylistSection"');
      expect(html).toContain('value="combat" selected');
      expect(html).toContain('data-change-action="updatePlaylistOverlayMode"');
      expect(html).toContain('value="active" selected');
      expect(html).not.toContain('data-change-action="updatePlaylistTarget"');
      expect(html).not.toContain('data-change-action="updatePlaylistOverlayId"');
    });

    it('renders an overlay select only when overlay mode is "specific"', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'specific', overlayId: 'boss' }, loop: { mode: 'count', count: 1 } },
        soundOptions: [],
        overlayOptions: [{ id: 'boss', label: 'Boss Fight', selected: true }],
        selectedExits: [],
        localize: loc
      });
      expect(html).toContain('data-change-action="updatePlaylistOverlayId"');
      expect(html).toContain('value="boss" selected');
      expect(html).toContain('Boss Fight');
    });

    it('does not render an overlay select when overlay mode is "none"', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'default', section: 'area', overlayMode: 'none' }, loop: { mode: 'count', count: 1 } },
        soundOptions: [],
        selectedExits: [],
        localize: loc
      });
      expect(html).not.toContain('data-change-action="updatePlaylistOverlayId"');
    });

    it('renders a Passes input when finite, and hides it (showing a hint) when infinite', () => {
      const finite = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl1' }, loop: { mode: 'count', count: 4 } },
        soundOptions: [],
        playlistOptions: [],
        selectedExits: [],
        localize: loc
      });
      expect(finite).toContain('data-change-action="updatePlaylistLoopCount"');
      expect(finite).toContain('value="4"');
      expect(finite).not.toContain('GameOrchestra.CustomEditor.Inspector.PlaylistInfiniteHint');

      const infinite = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl1' }, loop: { mode: 'forever' } },
        soundOptions: [],
        playlistOptions: [],
        selectedExits: [],
        localize: loc
      });
      expect(infinite).not.toContain('data-change-action="updatePlaylistLoopCount"');
      expect(infinite).toContain('GameOrchestra.CustomEditor.Inspector.PlaylistInfiniteHint');
      expect(infinite).toMatch(/data-change-action="updatePlaylistInfinite"[^>]*checked/);
    });

    it('HTML-escapes playlist and mood names', () => {
      const html = buildInspectorHtml({
        selectedNode: { id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl1' }, loop: { mode: 'count', count: 1 } },
        soundOptions: [],
        playlistOptions: [{ id: 'pl1', name: '<img src=x onerror=alert(1)>', selected: true }],
        selectedExits: [],
        localize: loc
      });
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img');
    });
  });

  // `selected: true` is load-bearing: the sound name is only interpolated for the sound this
  // node actually plays now, so an unselected one would pass this test vacuously.
  it('HTML-escapes untrusted sound names', () => {
    const html = buildInspectorHtml({
      selectedNode: { id: 't1', type: 'track', loop: { mode: 'count', count: 1 } },
      soundOptions: [{ id: 's1', name: '<img src=x onerror=alert(1)>', selected: true }],
      selectedExits: [],
      localize: loc
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('falls back to the key itself when no localize function is supplied', () => {
    const html = buildInspectorHtml({ selectedNode: null, soundOptions: [], selectedExits: [] });
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.NoSelection');
  });

  describe('fixed exits', () => {
    const build = (selectedNode, selectedExits) =>
      buildInspectorHtml({ selectedNode, selectedExits, soundOptions: [], localize: loc });

    /** The markup of one exit row, isolated from the rest of the panel. */
    const rowFor = (html, portName) => html.split('game-orchestra-exit-row').find((chunk) => chunk.includes(`data-exit-port="${portName}"`)) || '';

    it("renders a Condition's default exit read-only: no kind select, no remove button", () => {
      const html = build({ id: 'c1', type: 'condition' }, [
        { portName: 'output_1', condition: { kind: 'combatActive' } },
        { portName: 'output_2', condition: { kind: 'default' } }
      ]);
      const defaultRow = rowFor(html, 'output_2');

      expect(defaultRow).toContain('GameOrchestra.CustomEditor.Inspector.DefaultExit');
      expect(defaultRow).not.toContain('data-change-action="updateConditionExitKind"');
      expect(defaultRow).not.toContain('data-action="removeExit"');
      expect(html).toContain('GameOrchestra.CustomEditor.Inspector.DefaultExitHint');
    });

    it('never offers "default" as a selectable Condition kind, so a second fallback is impossible', () => {
      const html = build({ id: 'c1', type: 'condition' }, [
        { portName: 'output_1', condition: { kind: 'combatActive' } },
        { portName: 'output_2', condition: { kind: 'default' } }
      ]);
      const editableRow = rowFor(html, 'output_1');

      expect(editableRow).toContain('data-change-action="updateConditionExitKind"');
      expect(editableRow).toContain('<option value="combatActive"');
      expect(editableRow).not.toContain('<option value="default"');
    });

    it('offers moodChanged/phaseChanged as selectable kinds, with no value select for either', () => {
      const html = build({ id: 'c1', type: 'condition' }, [
        { portName: 'output_1', condition: { kind: 'moodChanged' } },
        { portName: 'output_2', condition: { kind: 'default' } }
      ]);
      const editableRow = rowFor(html, 'output_1');

      expect(editableRow).toContain('<option value="moodChanged"');
      expect(editableRow).toContain('<option value="phaseChanged"');
      expect(editableRow).toContain('GameOrchestra.CustomEditor.Inspector.ConditionKind.MoodChanged');
      expect(editableRow).not.toContain('data-change-action="updateConditionExitValue"');
    });

    it('still lets a legacy Condition exit that is not the fallback be edited and removed', () => {
      const html = build({ id: 'c1', type: 'condition' }, [{ portName: 'output_1', condition: { kind: 'mood', value: 'boss' } }]);
      const row = rowFor(html, 'output_1');

      expect(row).toContain('data-action="removeExit"');
      expect(row).toContain('data-change-action="updateConditionExitValue"');
    });

    it("omits the remove button on a Random's last remaining exit", () => {
      const html = build({ id: 'r1', type: 'random' }, [{ portName: 'output_1', weight: 1, cooldown: 0 }]);

      expect(html).not.toContain('data-action="removeExit"');
      expect(html).toContain('GameOrchestra.CustomEditor.Inspector.FixedExitHint');
    });

    it('offers a remove button on every Random exit once there is more than one', () => {
      const html = build({ id: 'r1', type: 'random' }, [
        { portName: 'output_1', weight: 1, cooldown: 0 },
        { portName: 'output_2', weight: 2, cooldown: 0 }
      ]);

      expect(rowFor(html, 'output_1')).toContain('data-action="removeExit"');
      expect(rowFor(html, 'output_2')).toContain('data-action="removeExit"');
    });
  });

  describe('exit rows are tied to their output port (for the hover highlight)', () => {
    const build = (selectedNode, selectedExits) =>
      buildInspectorHtml({ selectedNode, selectedExits, soundOptions: [], localize: loc });

    it.each([
      ['random', [{ portName: 'output_2', weight: 1 }, { portName: 'output_3', weight: 1 }]],
      ['condition', [{ portName: 'output_2', condition: { kind: 'mood' } }, { portName: 'output_3', condition: { kind: 'default' } }]],
      ['fork', [{ portName: 'output_2' }, { portName: 'output_3' }]]
    ])('tags every %s exit row with its node and port', (type, exits) => {
      const html = build({ id: 'n1', type }, exits);

      expect(html).toContain('data-exit-port="output_2"');
      expect(html).toContain('data-exit-port="output_3"');
      // The port comes from the row, not from its position in the list - an
      // unwired port earlier in the node would otherwise shift every label.
      expect(html).not.toContain('data-exit-port="output_1"');
      expect((html.match(/data-node-id="n1" data-exit-port=/g) || []).length).toBe(2);
    });
  });
});

describe('buildValidationHtml', () => {
  it('renders validation errors, warnings, and infos when present', () => {
    const html = buildValidationHtml({
      validation: {
        errors: [{ messageKey: 'Missing Start node' }],
        warnings: [{ messageKey: 'Orphan node' }],
        infos: [{ messageKey: 'This graph ends' }]
      },
      localize: loc
    });
    expect(html).toContain('Missing Start node');
    expect(html).toContain('Orphan node');
    expect(html).toContain('This graph ends');
  });

  it('omits validation sections entirely when there are no issues', () => {
    const html = buildValidationHtml({ validation: { errors: [], warnings: [], infos: [] }, localize: loc });
    expect(html).not.toContain('game-orchestra-validation-errors');
    expect(html).not.toContain('game-orchestra-validation-warnings');
    expect(html).not.toContain('game-orchestra-validation-infos');
    expect(html).toBe('');
  });

  it('names the offending node in each validation message', () => {
    const html = buildValidationHtml({
      validation: {
        errors: [],
        warnings: [{ nodeId: 'd1', nodeLabel: 'Breather', messageKey: 'This node is not reachable from Start.' }],
        infos: [{ nodeId: null, nodeLabel: null, messageKey: 'This graph ends.' }]
      },
      localize: loc
    });
    expect(html).toContain('<strong>Breather</strong>: This node is not reachable from Start.');
    // A graph-wide issue belongs to no node, so it stays unprefixed.
    expect(html).toContain('<p>This graph ends.</p>');
  });

  it('HTML-escapes validation messages', () => {
    const html = buildValidationHtml({
      validation: { errors: [{ messageKey: '<script>alert(2)</script>' }], warnings: [], infos: [] },
      localize: loc
    });
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('falls back to the key itself when no localize function is supplied', () => {
    const html = buildValidationHtml({ validation: { errors: [{ messageKey: 'Missing Start node' }], warnings: [], infos: [] } });
    expect(html).toContain('Missing Start node');
  });

  describe('validation issues locate their node', () => {
    const build = (validation) => buildValidationHtml({ validation, localize: loc });

    it('makes an issue that names a node clickable', () => {
      const html = build({
        errors: [],
        warnings: [{ nodeId: 'd1', nodeLabel: 'Breather', messageKey: 'This node is not reachable from Start.' }],
        infos: []
      });
      expect(html).toContain('data-action="focusNode"');
      expect(html).toContain('data-node-id="d1"');
      expect(html).toContain('class="game-orchestra-issue-locatable"');
    });

    it('leaves a graph-wide issue inert - there is no node to go to', () => {
      const html = build({ errors: [{ nodeId: null, nodeLabel: null, messageKey: 'The graph has no Start node.' }], warnings: [], infos: [] });
      expect(html).toContain('The graph has no Start node.');
      expect(html).not.toContain('data-action="focusNode"');
    });

    it('applies the same treatment to errors and infos, not just warnings', () => {
      const html = build({
        errors: [{ nodeId: 'e1', nodeLabel: 'Track 1', messageKey: 'Track has no sound selected.' }],
        warnings: [],
        infos: [{ nodeId: 'i1', nodeLabel: 'End 1', messageKey: 'Something informative.' }]
      });
      expect((html.match(/data-action="focusNode"/g) || []).length).toBe(2);
      expect(html).toContain('<p class="game-orchestra-issue-locatable" data-action="focusNode" data-node-id="i1"');
    });
  });
});

/**
 * The Script node's inspector, and in particular its two REFUSALS.
 *
 * UX-9 says a control that would not work is shown disabled with a reason, never hidden - and the
 * two reasons here are deliberately separate because their remedies are: one is a world setting a
 * GM can flip, the other is a permission or a deployment's Content-Security-Policy that nobody in
 * the room can do anything about. Collapsing them into one message would send half of the affected
 * users looking for a setting that will not help them.
 */
describe('buildInspectorHtml - Script nodes', () => {
  const scriptNode = (script) => ({ id: 'sc1', type: 'script', script });
  const build = (script, scripting, macroOptions = []) => buildInspectorHtml({
    selectedNode: scriptNode(script),
    soundOptions: [],
    macroOptions,
    scripting,
    selectedExits: [],
    localize: loc
  });

  it('offers both modes, with the stored one selected', () => {
    const html = build({ mode: 'inline', source: '' }, { inlineAllowed: true, canAuthor: true });
    expect(html).toContain('data-change-action="updateScriptMode"');
    expect(html).toContain('<option value="inline" selected>');
    expect(html).toContain('<option value="macro" >');
  });

  it('renders a macro picker in macro mode, with the referenced macro selected', () => {
    const html = build({ mode: 'macro', macroUuid: 'Macro.b' }, { inlineAllowed: true, canAuthor: true }, [
      { uuid: 'Macro.a', name: 'Thunder' },
      { uuid: 'Macro.b', name: 'Boss FX' }
    ]);
    expect(html).toContain('data-change-action="updateScriptMacro"');
    expect(html).toContain('<option value="Macro.b" selected>Boss FX</option>');
    expect(html).not.toContain('updateScriptSource');
  });

  it('offers an empty option, so a macro can be un-referenced without deleting the node', () => {
    const html = build({ mode: 'macro', macroUuid: 'Macro.a' }, { inlineAllowed: true, canAuthor: true }, [
      { uuid: 'Macro.a', name: 'Thunder' }
    ]);
    expect(html).toContain('<option value="">');
  });

  it('renders an editable textarea in inline mode when nothing blocks it', () => {
    const html = build({ mode: 'inline', source: 'await foo();' }, { inlineAllowed: true, canAuthor: true });
    expect(html).toContain('data-change-action="updateScriptSource"');
    expect(html).toContain('await foo();');
    expect(html).not.toContain('readonly');
  });

  it('makes the source READONLY when the world has inline scripts turned off, and says so', () => {
    const html = build({ mode: 'inline', source: 'await foo();' }, { inlineAllowed: false, canAuthor: true });
    expect(html).toContain('readonly');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ScriptDisabledHint');
    // Still shown, never hidden: the author has to be able to read what is already stored.
    expect(html).toContain('await foo();');
  });

  it('makes the source READONLY for a user without MACRO_SCRIPT, with the OTHER reason', () => {
    const html = build({ mode: 'inline', source: '' }, { inlineAllowed: true, canAuthor: false });
    expect(html).toContain('readonly');
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ScriptNoPermissionHint');
    expect(html).not.toContain('ScriptDisabledHint');
  });

  it('reports the PERMISSION reason first when both apply - it is the one the user cannot fix', () => {
    const html = build({ mode: 'inline', source: '' }, { inlineAllowed: false, canAuthor: false });
    expect(html).toContain('GameOrchestra.CustomEditor.Inspector.ScriptNoPermissionHint');
    expect(html).not.toContain('ScriptDisabledHint');
  });

  it('leaves the field editable when no scripting context is supplied at all', () => {
    // Absent is not the same as false: an omitted context means "unknown", and disabling on
    // unknown would lock the field for every caller that forgot to pass one.
    const html = build({ mode: 'inline', source: '' }, undefined);
    expect(html).not.toContain('readonly');
  });

  it('escapes stored source - it is user data going into a hand-built HTML string', () => {
    const html = build({ mode: 'inline', source: '</textarea><img src=x onerror=alert(1)>' }, { inlineAllowed: true, canAuthor: true });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes macro names - they are user data too', () => {
    const html = build({ mode: 'macro', macroUuid: 'Macro.a' }, { inlineAllowed: true, canAuthor: true }, [
      { uuid: 'Macro.a', name: '<img src=x onerror=alert(1)>' }
    ]);
    expect(html).not.toContain('<img');
  });
});
