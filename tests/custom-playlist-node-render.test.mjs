import { describe, it, expect } from 'vitest';
import {
  computeNodeDetail,
  buildNodeInnerHtml,
  computeNodeHeightPx,
  computeExitChip,
  buildExitChipHtml,
  exitWeightTotal,
  describeExitCondition,
  nodeDisplayLabel,
  nextNodeLabel,
  zoomTier,
  DRAIN_NODE_TYPES,
  EXPANDABLE_EXIT_NODE_TYPES
} from '../scripts/custom-playlist-node-render.mjs';

describe('zoomTier', () => {
  it('shows full detail at the default 100% zoom', () => {
    expect(zoomTier(1)).toBe('full');
  });

  it('shows full detail when zoomed in', () => {
    expect(zoomTier(1.6)).toBe('full');
  });

  it('drops to compact once zoomed far enough out', () => {
    expect(zoomTier(0.5)).toBe('compact');
    expect(zoomTier(0.2)).toBe('compact');
  });

  it('treats the threshold itself as still-readable', () => {
    expect(zoomTier(0.6)).toBe('full');
    expect(zoomTier(0.59)).toBe('compact');
  });

  it('falls back to full detail for an unusable zoom rather than blanking every label', () => {
    expect(zoomTier(NaN)).toBe('full');
    expect(zoomTier(undefined)).toBe('full');
    expect(zoomTier(Infinity)).toBe('full');
    // Number(null) is 0 - finite and below the threshold, so this would read as
    // "zoomed way out" without the explicit >0 guard.
    expect(zoomTier(null)).toBe('full');
    expect(zoomTier(0)).toBe('full');
  });
});

// A fake localizer in the shape computeNodeDetail/computeExitChip expect - the
// module is deliberately Foundry-free, so every user-facing string is injected
// (same convention as playlist-ref.mjs#describePlaylistRef).
const LOC = {
  'GameOrchestra.CustomEditor.Node.NoSound': '(no sound)',
  'GameOrchestra.CustomEditor.Node.NoPlaylist': '(no playlist)',
  'GameOrchestra.CustomEditor.Node.NoRepeat': 'no repeat',
  'GameOrchestra.CustomEditor.ExitChip.CombatActive': 'Combat',
  'GameOrchestra.CustomEditor.ExitChip.CombatIdle': 'No Combat',
  'GameOrchestra.CustomEditor.ExitChip.Mood': 'Mood',
  'GameOrchestra.CustomEditor.ExitChip.MoodChanged': 'Mood \u0394',
  'GameOrchestra.CustomEditor.ExitChip.Default': 'else',
  'GameOrchestra.CustomEditor.ExitChip.Unset': '(not set)'
};
const localize = (key, data) => (key === 'GameOrchestra.CustomEditor.Node.ExitCount' ? `${data.count} exits` : (LOC[key] ?? key));

describe('computeNodeDetail', () => {
  it('shows the sound name and loop count for a Track node', () => {
    expect(computeNodeDetail({ type: 'track', loop: { mode: 'count', count: 3 } }, { soundName: 'Battle Theme', localize })).toBe('Battle Theme \u00d7 3');
  });

  it('shows a placeholder when a Track node has no sound selected yet', () => {
    expect(computeNodeDetail({ type: 'track', loop: { mode: 'count', count: 1 } }, { localize })).toBe('(no sound) \u00d7 1');
  });

  it('shows an infinity symbol instead of a loop count for an infinite Track node', () => {
    expect(computeNodeDetail({ type: 'track', loop: { mode: 'forever' } }, { soundName: 'Battle Theme', localize })).toBe('Battle Theme \u00d7 \u221e');
  });

  // REGRESSION: an 'until' loop has no `count`, so `count ?? 1` rendered it as
  // "\u00d7 1" - byte-identical to a track that plays once and stops, which is the
  // opposite of what an until-loop does. Its BOUNDS belong here; the escape
  // condition is a guard on the exit and renders as that exit's chip.
  describe("a Track node's until-loop", () => {
    it('shows the min-max bounds, never a bare count', () => {
      const node = { type: 'track', loop: { mode: 'until', minLoops: 2, maxLoops: 8, condition: { kind: 'combatIdle' } } };
      expect(computeNodeDetail(node, { soundName: 'Battle Theme', localize })).toBe('Battle Theme \u00d7 2\u20138');
    });

    it("shows an open-ended minimum when there is no maximum", () => {
      const node = { type: 'track', loop: { mode: 'until', minLoops: 2, maxLoops: null, condition: { kind: 'combatIdle' } } };
      expect(computeNodeDetail(node, { soundName: 'Battle Theme', localize })).toBe('Battle Theme \u00d7 2+');
    });

    it('is never confusable with a genuine single play', () => {
      const until = computeNodeDetail({ type: 'track', loop: { mode: 'until' } }, { soundName: 'X', localize });
      const once = computeNodeDetail({ type: 'track', loop: { mode: 'count', count: 1 } }, { soundName: 'X', localize });
      expect(until).not.toBe(once);
      expect(until).toBe('X \u00d7 1+');
    });
  });

  it('shows the min-max range for a Delay node', () => {
    expect(computeNodeDetail({ type: 'delay', delay: { min: 2, max: 5 } })).toBe('2\u20135s');
  });

  // Fork is the one branching type with no exit chips (every exit fires at
  // once, so there is no per-exit guard to state), so its count stays here.
  it('shows an exit count for a Fork node', () => {
    expect(computeNodeDetail({ type: 'fork' }, { exitCount: 3, localize })).toBe('3 exits');
  });

  // Their chips carry the per-exit guards, so a count here would be a second
  // rendering of the same fact - see the one-channel-per-fact rule.
  it('shows no exit count for Random or Condition - their chips supersede it', () => {
    expect(computeNodeDetail({ type: 'random' }, { exitCount: 3, localize })).toBe('');
    expect(computeNodeDetail({ type: 'condition' }, { exitCount: 3, localize })).toBe('');
  });

  it("surfaces a Random node's avoidRepeat, which is node-level and was invisible before", () => {
    expect(computeNodeDetail({ type: 'random', avoidRepeat: true }, { exitCount: 3, localize })).toBe('no repeat');
  });

  it('returns an empty string for Start/End nodes', () => {
    expect(computeNodeDetail({ type: 'start' })).toBe('');
    expect(computeNodeDetail({ type: 'end' })).toBe('');
  });

  it('shows the resolved reference label and pass count for a Playlist node', () => {
    expect(computeNodeDetail({ type: 'playlist', loop: { mode: 'count', count: 2 } }, { refLabel: 'Tavern Theme', localize })).toBe('Tavern Theme \u00d7 2');
  });

  it('shows a placeholder when a Playlist node has no resolvable reference yet', () => {
    expect(computeNodeDetail({ type: 'playlist', loop: { mode: 'count', count: 1 } }, { localize })).toBe('(no playlist) \u00d7 1');
  });

  it('shows an infinity symbol instead of a pass count for an infinite Playlist node', () => {
    expect(computeNodeDetail({ type: 'playlist', loop: { mode: 'forever' } }, { refLabel: 'Tavern Theme', localize })).toBe('Tavern Theme \u00d7 \u221e');
  });
});

describe('buildNodeInnerHtml', () => {
  it('renders the icon class for a known type', () => {
    const html = buildNodeInnerHtml('track', '');
    expect(html).toContain('fa-music');
    expect(html).toContain('game-orchestra-node-icon');
  });

  it('puts the type label only in a title attribute, not as visible text (shape + icon carry the distinction now)', () => {
    const html = buildNodeInnerHtml('track', '');
    expect(html).toContain('title="Track"');
    expect(html).not.toContain('game-orchestra-node-title');
    expect(html).not.toContain('>Track<');
  });

  it('renders a detail line when provided', () => {
    const html = buildNodeInnerHtml('track', 'Battle Theme × 3');
    expect(html).toContain('game-orchestra-node-detail');
    expect(html).toContain('Battle Theme × 3');
  });

  it('omits the detail line entirely when detail is empty', () => {
    const html = buildNodeInnerHtml('start', '');
    expect(html).not.toContain('game-orchestra-node-detail');
  });

  it('falls back to a generic icon and the raw type string (in the title attribute) for an unknown type', () => {
    const html = buildNodeInnerHtml('mystery', '');
    expect(html).toContain('fa-circle');
    expect(html).toContain('title="mystery"');
  });

  it('HTML-escapes the detail text', () => {
    const html = buildNodeInnerHtml('track', '<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });
});

describe('computeNodeHeightPx', () => {
  it('returns null for node types that do not grow with exit count', () => {
    expect(computeNodeHeightPx('track', 5)).toBeNull();
    expect(computeNodeHeightPx('start', 0)).toBeNull();
    // Condition is NOT in this list any more - its branch exits moved from the
    // bottom edge into the right-edge stack, so it scales by height like the
    // other two. See the dedicated block below.
  });

  it('returns a base height for Fork/Random at the minimum exit count', () => {
    const forkHeight = computeNodeHeightPx('fork', 1);
    const randomHeight = computeNodeHeightPx('random', 1);
    expect(forkHeight).toBeGreaterThan(0);
    expect(forkHeight).toBe(randomHeight);
  });

  it('grows taller as exit count increases', () => {
    const twoExits = computeNodeHeightPx('fork', 2);
    const fourExits = computeNodeHeightPx('fork', 4);
    expect(fourExits).toBeGreaterThan(twoExits);
    // Growth should be linear per exit, not just "some bigger number".
    const perExitStep = computeNodeHeightPx('fork', 3) - computeNodeHeightPx('fork', 2);
    expect(fourExits - twoExits).toBe(2 * perExitStep);
  });

  it('treats a missing/zero exit count the same as one exit (never shrinks below the base)', () => {
    expect(computeNodeHeightPx('random', 0)).toBe(computeNodeHeightPx('random', 1));
    expect(computeNodeHeightPx('random', undefined)).toBe(computeNodeHeightPx('random', 1));
  });
});

describe('node names', () => {
  it('uses a node\'s own name when it has one', () => {
    expect(nodeDisplayLabel({ type: 'track', label: 'Boss Theme' })).toBe('Boss Theme');
  });

  it('falls back to the type for nodes saved before names existed', () => {
    expect(nodeDisplayLabel({ type: 'delay' })).toBe('Delay');
    expect(nodeDisplayLabel({ type: 'delay', label: '   ' })).toBe('Delay');
    expect(nodeDisplayLabel(null)).toBe('');
  });

  it('numbers a new node from the lowest free slot for its type', () => {
    expect(nextNodeLabel('track', [])).toBe('Track 1');
    expect(nextNodeLabel('track', ['Track 1', 'Track 2', 'Delay 1'])).toBe('Track 3');
    // "Track 2" renamed or deleted: its number is free again.
    expect(nextNodeLabel('track', ['Track 1', 'Track 3'])).toBe('Track 2');
  });

  it('renders the name as a caption and escapes it', () => {
    const html = buildNodeInnerHtml('track', 'Theme × 1', { label: '<b>Boss</b>' });
    expect(html).toContain('class="game-orchestra-node-name"');
    expect(html).toContain('&lt;b&gt;Boss&lt;/b&gt;');
    expect(html).not.toContain('<b>Boss</b>');
  });

  it('omits the caption entirely when there is no name', () => {
    expect(buildNodeInnerHtml('track', 'Theme × 1')).not.toContain('game-orchestra-node-name');
  });
});

describe('drain overlay', () => {
  it('renders a clipped outer element and an inner level for both timed node types', () => {
    for (const type of ['delay', 'track']) {
      expect(buildNodeInnerHtml(type, 'x')).toContain('<span class="game-orchestra-node-fill"><span class="game-orchestra-node-fill-level"></span></span>');
    }
  });

  it('renders none for a node type whose duration nothing knows in advance', () => {
    for (const type of ['start', 'end', 'fork', 'random', 'condition', 'playlist']) {
      expect(buildNodeInnerHtml(type, 'x')).not.toContain('game-orchestra-node-fill');
    }
  });

  it('agrees with the exported type set the editor paints from', () => {
    for (const type of ['start', 'end', 'track', 'fork', 'delay', 'random', 'condition', 'playlist']) {
      expect(buildNodeInnerHtml(type, 'x').includes('game-orchestra-node-fill')).toBe(DRAIN_NODE_TYPES.has(type));
    }
  });
});

// The single list of types that grow an output port on demand. Three call
// sites read it (the detail line here, _refreshNodeDisplay's port-count
// override, and the canvas "+" button), so a type added to one and not the
// others is exactly the drift this set exists to prevent.
describe('EXPANDABLE_EXIT_NODE_TYPES', () => {
  it('holds the three branching types and nothing else', () => {
    expect([...EXPANDABLE_EXIT_NODE_TYPES].sort()).toEqual(['condition', 'fork', 'random']);
  });

  it('is exactly the set whose shape grows with its exit count', () => {
    for (const type of ['start', 'end', 'track', 'fork', 'delay', 'random', 'condition', 'playlist']) {
      expect(computeNodeHeightPx(type, 3) !== null).toBe(EXPANDABLE_EXIT_NODE_TYPES.has(type));
    }
  });
});

// Condition scales by HEIGHT alongside Fork/Random since its branch exits moved
// to the right-edge stack; computeNodeWidthPx() went with the bottom edge.
describe('computeNodeHeightPx for Condition', () => {
  it('grows from its one-exit floor, which must match its CSS min-height', () => {
    expect(computeNodeHeightPx('condition', 1)).toBe(64);
    expect(computeNodeHeightPx('condition', 2)).toBe(90);
    expect(computeNodeHeightPx('condition', 4)).toBe(142);
  });

  it('is the same bar as Fork and Random at every exit count', () => {
    for (const n of [1, 2, 5]) expect(computeNodeHeightPx('condition', n)).toBe(computeNodeHeightPx('fork', n));
  });

  it('keeps the per-exit step above the port stride, or stacked ports overflow the shape', () => {
    const step = computeNodeHeightPx('condition', 2) - computeNodeHeightPx('condition', 1);
    // 16px port + the vendor's 5px margin-bottom = a 25px stride.
    expect(step).toBeGreaterThan(25);
    expect(step).toBe(computeNodeHeightPx('fork', 2) - computeNodeHeightPx('fork', 1));
  });
});

// Channel 4 of the node-anatomy framework: what guards ONE exit. Its ABSENCE is
// meaningful - an exit with no guard gets no chip, which is how Fork (every
// exit fires at once) stays visibly distinct from Random.
describe('exit chips', () => {
  const chipText = (node, exit, opts) => computeExitChip(node, exit, { localize, ...opts })?.text ?? null;

  describe('Random', () => {
    it('shows each exit as a share of the total weight, not the raw number', () => {
      const exits = [{ weight: 3 }, { weight: 1 }, { weight: 1 }];
      const weightTotal = exitWeightTotal(exits);
      expect(exits.map((e) => chipText({ type: 'random' }, e, { weightTotal }))).toEqual(['60%', '20%', '20%']);
    });

    it('counts a missing weight as 1, matching the engine default', () => {
      expect(exitWeightTotal([{ weight: 3 }, {}])).toBe(4);
    });

    it('degrades to 0% rather than dividing by zero when every weight is zero', () => {
      const exits = [{ weight: 0 }, { weight: 0 }];
      const weightTotal = exitWeightTotal(exits);
      expect(weightTotal).toBe(0);
      expect(chipText({ type: 'random' }, exits[0], { weightTotal })).toBe('0%');
    });

    it('carries a non-zero cooldown as an icon rather than more words', () => {
      const chip = computeExitChip({ type: 'random' }, { weight: 1, cooldown: 2 }, { weightTotal: 1, localize });
      expect(chip.cooldown).toBe(2);
      expect(buildExitChipHtml(chip)).toContain('fa-hourglass-half');
    });

    it('omits the cooldown entirely when it is zero', () => {
      const chip = computeExitChip({ type: 'random' }, { weight: 1, cooldown: 0 }, { weightTotal: 1, localize });
      expect(chip.cooldown).toBeNull();
      expect(buildExitChipHtml(chip)).not.toContain('fa-hourglass');
    });
  });

  describe('Condition', () => {
    it('names the predicate', () => {
      expect(chipText({ type: 'condition' }, { condition: { kind: 'combatActive' } })).toBe('Combat');
    });

    it('resolves a mood/phase id to its configured label rather than showing the raw id', () => {
      const text = chipText({ type: 'condition' }, { condition: { kind: 'mood', value: 'tense' } }, { overlayLabel: () => 'Tense' });
      expect(text).toBe('Mood = Tense');
    });

    it('falls back to the raw id when the overlay no longer exists', () => {
      expect(chipText({ type: 'condition' }, { condition: { kind: 'mood', value: 'gone' } }, { overlayLabel: () => null })).toBe('Mood = gone');
    });

    it('marks an unconfigured guard instead of rendering a blank chip', () => {
      expect(chipText({ type: 'condition' }, { condition: {} })).toBe('(not set)');
      expect(chipText({ type: 'condition' }, { condition: { kind: 'mood' } })).toBe('Mood = (not set)');
    });

    // The chip and graph-validation's ConditionExitMissingValue read emptiness
    // through the same helper. A truthiness check here would have rendered a
    // blank-looking chip for a value validation was already rejecting.
    it('agrees with validation that a whitespace-only value is unset', () => {
      expect(chipText({ type: 'condition' }, { condition: { kind: 'mood', value: '   ' } })).toBe('Mood = (not set)');
    });

    it('reads the fallback as "else"', () => {
      expect(chipText({ type: 'condition' }, { condition: { kind: 'default' } })).toBe('else');
    });
  });

  // The whole point of unifying these: an until-loop's escape condition IS a
  // guard on that node's one exit, so it must render exactly like a Condition
  // branch rather than inventing a second notation for the same idea.
  describe('until-loop Track', () => {
    it('chips its single exit with the escape condition', () => {
      const node = { type: 'track', loop: { mode: 'until', condition: { kind: 'combatIdle' } } };
      expect(chipText(node, null)).toBe('No Combat');
    });

    it('renders identically to the same condition on a Condition branch', () => {
      const viaTrack = chipText({ type: 'track', loop: { mode: 'until', condition: { kind: 'moodChanged' } } }, null);
      const viaCondition = chipText({ type: 'condition' }, { condition: { kind: 'moodChanged' } });
      expect(viaTrack).toBe(viaCondition);
    });

    it('chips nothing for any other loop mode - those exits are unconditional', () => {
      expect(chipText({ type: 'track', loop: { mode: 'count', count: 3 } }, null)).toBeNull();
      expect(chipText({ type: 'track', loop: { mode: 'forever' } }, null)).toBeNull();
    });
  });

  it('chips nothing for an unguarded exit, on any type', () => {
    for (const type of ['start', 'fork', 'delay', 'playlist', 'end']) {
      expect(computeExitChip({ type }, {}, { localize })).toBeNull();
    }
  });

  it('renders an empty string, not markup, when there is no chip', () => {
    expect(buildExitChipHtml(null)).toBe('');
  });

  it('escapes an overlay label so a sound/mood name cannot inject markup', () => {
    const chip = computeExitChip({ type: 'condition' }, { condition: { kind: 'mood', value: 'x' } }, { localize, overlayLabel: () => '<img src=x>' });
    expect(buildExitChipHtml(chip)).not.toContain('<img');
    expect(buildExitChipHtml(chip)).toContain('&lt;img');
  });

  it('derives its lang key from the kind string, so a new kind needs no lookup table', () => {
    expect(describeExitCondition({ kind: 'enemiesDefeated' }, { localize: (k) => k })).toBe('GameOrchestra.CustomEditor.ExitChip.EnemiesDefeated');
  });
});
