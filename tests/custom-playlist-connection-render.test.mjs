import { describe, it, expect } from 'vitest';
import { parseCurvePath, buildSelfLoopPath, uncertainEdges, buildRoutedPath, parsePathEndpoints, connectionPortSelectors } from '../scripts/custom-playlist-connection-render.mjs';

/** Pull every coordinate out of a `d` string, in order, as numbers. */
const coords = (d) => d.match(/-?\d*\.?\d+/g).map(Number);

describe('buildRoutedPath', () => {
  it('starts and ends exactly on the two ports', () => {
    const c = coords(buildRoutedPath(10, 20, 200, 90));
    expect([c[0], c[1]]).toEqual([10, 20]);
    expect([c[c.length - 2], c[c.length - 1]]).toEqual([200, 90]);
  });

  it('leaves a right-facing output horizontally, on a straight run', () => {
    const c = coords(buildRoutedPath(10, 20, 200, 90, { startDir: 'right', stub: 16 }));
    // First L point: 16px to the right, same Y - a parallel departure, not a
    // line aimed straight at the destination.
    expect([c[2], c[3]]).toEqual([26, 20]);
  });

  it('leaves a bottom-edge exit downward (a Condition branch)', () => {
    const c = coords(buildRoutedPath(100, 50, 300, 200, { startDir: 'down', stub: 16 }));
    expect([c[2], c[3]]).toEqual([100, 66]);
  });

  it('leaves a top-edge exit upward (a Condition fallback)', () => {
    const c = coords(buildRoutedPath(100, 50, 300, 200, { startDir: 'up', stub: 16 }));
    expect([c[2], c[3]]).toEqual([100, 34]);
  });

  it('enters the target port along its own normal, on a straight run', () => {
    const c = coords(buildRoutedPath(10, 20, 200, 90, { endDir: 'left', stub: 16 }));
    // Last L point before the endpoint: 16px to the LEFT of the input.
    expect([c[c.length - 4], c[c.length - 3]]).toEqual([184, 90]);
  });

  it('keeps the curve handles collinear with the stubs, so the joins are smooth', () => {
    const c = coords(buildRoutedPath(0, 0, 400, 0, { startDir: 'right', endDir: 'left', stub: 16 }));
    const [, , ax, ay, c1x, c1y] = c;
    // Control point 1 continues straight out along the same normal as the stub.
    expect(c1y).toBe(ay);
    expect(c1x).toBeGreaterThan(ax);
  });

  it('caps how far the handles reach, so a long wire stays nearly straight', () => {
    const near = coords(buildRoutedPath(0, 0, 300, 0, { maxCurve: 80 }));
    const far = coords(buildRoutedPath(0, 0, 4000, 0, { maxCurve: 80 }));
    const handleReach = (c) => c[4] - c[2]; // control point 1 minus the stub end
    expect(handleReach(near)).toBeLessThanOrEqual(80);
    expect(handleReach(far)).toBe(80);
  });

  it('still curves when two nodes are stacked vertically with no horizontal gap', () => {
    // Drawflow's own curvature is a fraction of the X distance, so this case
    // collapsed to a straight diagonal.
    const c = coords(buildRoutedPath(100, 0, 100, 300, { startDir: 'right', endDir: 'left' }));
    expect(c[4]).toBeGreaterThan(c[2]);
  });

  it('falls back to sane directions for an unknown direction name', () => {
    const c = coords(buildRoutedPath(10, 20, 200, 90, { startDir: 'sideways', endDir: 'inward', stub: 16 }));
    expect([c[2], c[3]]).toEqual([26, 20]);
    expect([c[c.length - 4], c[c.length - 3]]).toEqual([184, 90]);
  });

  /**
   * Tightest turn anywhere along the wire's cubic section, as a radius of
   * curvature in px - smaller means a harder turn, and 0 is a cusp (the curve
   * folding back through itself). This is the property "no hard turns" actually
   * means, so it is measured rather than eyeballed: several geometries used to
   * produce a literal cusp, and nothing about the emitted `d` string looks
   * wrong when they do.
   */
  const minTurnRadius = (d) => {
    const p = coords(d).slice(2, 10); // the cubic: stub end, both handles, far stub end
    const at = (fns, t) => {
      const u = 1 - t;
      return [fns(u, t, 0), fns(u, t, 1)];
    };
    const d1 = (t) => at((u, s, i) => 3 * u * u * (p[2 + i] - p[i]) + 6 * u * s * (p[4 + i] - p[2 + i]) + 3 * s * s * (p[6 + i] - p[4 + i]), t);
    const d2 = (t) => at((u, s, i) => 6 * u * (p[4 + i] - 2 * p[2 + i] + p[i]) + 6 * s * (p[6 + i] - 2 * p[4 + i] + p[2 + i]), t);
    let min = Infinity;
    for (let i = 0; i <= 400; i++) {
      const t = i / 400;
      const [xp, yp] = d1(t);
      const [xpp, ypp] = d2(t);
      const denominator = Math.abs(xp * ypp - yp * xpp);
      if (denominator > 1e-9) min = Math.min(min, (xp * xp + yp * yp) ** 1.5 / denominator);
    }
    return min;
  };

  // Every one of these had a hard turn before the handle lengths were split
  // into along/perpendicular components and the backward swing was added; the
  // three "backward" ones were outright cusps (radius 0).
  it.each([
    ['a short forward wire', [10, 20, 220, 120], {}],
    ['a long forward wire', [0, 0, 700, 320], {}],
    ['a very long forward wire', [0, 0, 1400, 100], {}],
    ['vertically stacked nodes', [100, 0, 100, 300], {}],
    ['a wire doubling back to an earlier node', [500, 0, 0, 60], {}],
    ['a wire doubling back with no vertical offset at all', [300, 0, 0, 0], {}],
    ["a Condition's downward exit", [100, 50, 420, 340], { startDir: 'down' }],
    ["a Condition's upward fallback", [100, 50, 420, -260], { startDir: 'up' }],
    ["a Condition's downward exit doubling back", [100, 50, -200, 340], { startDir: 'down' }]
  ])('turns gently, with no cusp, on %s', (_label, [x1, y1, x2, y2], options) => {
    expect(minTurnRadius(buildRoutedPath(x1, y1, x2, y2, options))).toBeGreaterThan(15);
  });

  /**
   * How far the curve bows away from the straight line between its two ends,
   * in px. This is the "curvy, not a taut string" property, and it is the one
   * the handle lengths were raised for - the turn-radius floor above only says
   * the wire has no hard corner, which a dead-straight line also satisfies.
   */
  const maxBow = (d) => {
    const p = coords(d).slice(2, 10);
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const length = Math.hypot(x3 - x0, y3 - y0) || 1;
    let max = 0;
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
      max = Math.max(max, Math.abs((x3 - x0) * (y0 - y) - (x0 - x) * (y3 - y0)) / length);
    }
    return max;
  };

  it.each([
    ['a forward wire with a slight drop', [40, 60, 360, 140], {}, 15],
    ['a forward wire with a steep drop', [40, 40, 300, 260], {}, 45],
    ["a Condition's downward exit", [100, 40, 340, 250], { startDir: 'down' }, 110]
  ])('bows well clear of a straight line on %s', (_label, [x1, y1, x2, y2], options, minBow) => {
    expect(maxBow(buildRoutedPath(x1, y1, x2, y2, options))).toBeGreaterThan(minBow);
  });

  it('emits a syntactically valid stub/curve/stub path', () => {
    expect(buildRoutedPath(0, 0, 100, 50)).toMatch(
      /^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+$/
    );
  });
});

describe('parsePathEndpoints', () => {
  it("reads Drawflow's own curve format", () => {
    expect(parsePathEndpoints(' M 10 20 C 15 20 95 80 100  80')).toEqual({ startX: 10, startY: 20, endX: 100, endY: 80 });
  });

  it('reads its own routed format back, so re-routing an already-routed wire is stable', () => {
    const d = buildRoutedPath(10, 20, 200, 90, { startDir: 'down' });
    expect(parsePathEndpoints(d)).toEqual({ startX: 10, startY: 20, endX: 200, endY: 90 });
  });

  it('reads a self-loop arc back', () => {
    const d = buildSelfLoopPath(10, 50, 90, 50, 40);
    expect(parsePathEndpoints(d)).toEqual({ startX: 10, startY: 50, endX: 90, endY: 50 });
  });

  it('handles negative and decimal coordinates', () => {
    expect(parsePathEndpoints('M -27 -5.5 C -10 -5 60 40 90.25 40')).toEqual({ startX: -27, startY: -5.5, endX: 90.25, endY: 40 });
  });

  it('returns null for anything it cannot read four coordinates out of', () => {
    expect(parsePathEndpoints('not a path')).toBeNull();
    expect(parsePathEndpoints('M 10 20')).toBeNull();
    expect(parsePathEndpoints('')).toBeNull();
    expect(parsePathEndpoints(undefined)).toBeNull();
    expect(parsePathEndpoints(null)).toBeNull();
  });
});

describe('parseCurvePath', () => {
  it("parses start/end points out of Drawflow's own createCurvature() format", () => {
    // Exact format confirmed from the vendored drawflow.min.js source:
    // ' M ' + startX + ' ' + startY + ' C ' + c1x + ' ' + startY + ' ' + c2x + ' ' + endY + ' ' + endX + '  ' + endY
    const d = ' M 10 20 C 15 20 95 80 100 80';
    expect(parseCurvePath(d)).toEqual({ startX: 10, startY: 20, endX: 100, endY: 80 });
  });

  it('tolerates the double space before the final Y that Drawflow actually emits', () => {
    const d = ' M 10 20 C 15 20 95 80 100  80';
    expect(parseCurvePath(d)).toEqual({ startX: 10, startY: 20, endX: 100, endY: 80 });
  });

  it('handles negative coordinates', () => {
    const d = 'M -27 -5 C -10 -5 60 40 90 40';
    expect(parseCurvePath(d)).toEqual({ startX: -27, startY: -5, endX: 90, endY: 40 });
  });

  it('handles decimal coordinates', () => {
    const d = 'M 10.5 20.25 C 15.1 20.25 95.9 80.75 100.2 80.75';
    expect(parseCurvePath(d)).toEqual({ startX: 10.5, startY: 20.25, endX: 100.2, endY: 80.75 });
  });

  it('returns null for an unrecognized or missing path string', () => {
    expect(parseCurvePath('not a path')).toBeNull();
    expect(parseCurvePath('')).toBeNull();
    expect(parseCurvePath(undefined)).toBeNull();
    expect(parseCurvePath(null)).toBeNull();
  });
});

describe('buildSelfLoopPath', () => {
  it('starts and ends at the exact given endpoints', () => {
    const d = buildSelfLoopPath(10, 50, 90, 50, 40);
    expect(d.startsWith('M 10 50')).toBe(true);
    expect(d.endsWith('90 50')).toBe(true);
  });

  it('pulls both control points to a peak above the higher of the two endpoints', () => {
    const d = buildSelfLoopPath(10, 60, 90, 50, 40);
    // Peak should clear the HIGHER endpoint (smaller Y = visually higher), i.e. min(60,50) - 40 = 10.
    expect(d).toContain(' 10 ');
    const match = /C ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/.exec(d);
    expect(match).not.toBeNull();
    const [, , c1y, , c2y] = match;
    expect(Number(c1y)).toBe(10);
    expect(Number(c2y)).toBe(10);
  });

  it('never produces a negative clearance below zero even if given one', () => {
    const d = buildSelfLoopPath(10, 50, 90, 50, -20);
    // Should clamp to 0 clearance (peak == the endpoint height), not overshoot downward.
    const match = /C [\d.-]+ ([\d.-]+)/.exec(d);
    expect(Number(match[1])).toBe(50);
  });

  it('produces a syntactically valid single-segment SVG cubic bezier path', () => {
    const d = buildSelfLoopPath(0, 0, 100, 0, 50);
    expect(d).toMatch(/^M [\d.-]+ [\d.-]+ C [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);
  });
});

describe('uncertainEdges', () => {
  const graph = {
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'r1', type: 'random' },
      { id: 'c1', type: 'condition' },
      { id: 'f1', type: 'fork' },
      { id: 't1', type: 'track' },
      { id: 't2', type: 'track' }
    ],
    edges: [
      { id: 'start:output_1->r1', from: 'start', to: 'r1' },
      { id: 'r1:output_1->t1', from: 'r1', to: 't1' },
      { id: 'r1:output_2->t2', from: 'r1', to: 't2' },
      { id: 'c1:output_1->t1', from: 'c1', to: 't1' },
      { id: 'f1:output_1->t1', from: 'f1', to: 't1' },
      { id: 't1:output_1->t2', from: 't1', to: 't2' }
    ]
  };

  it('includes every edge leaving a Random node', () => {
    const froms = uncertainEdges(graph).map((e) => e.from);
    expect(froms.filter((f) => f === 'r1')).toHaveLength(2);
  });

  it('includes edges leaving a Condition node', () => {
    expect(uncertainEdges(graph).some((e) => e.from === 'c1')).toBe(true);
  });

  it('excludes Fork edges - a Fork takes every one of its exits at once', () => {
    expect(uncertainEdges(graph).some((e) => e.from === 'f1')).toBe(false);
  });

  it('excludes edges leaving nodes with a single always-followed exit', () => {
    const froms = uncertainEdges(graph).map((e) => e.from);
    expect(froms).not.toContain('start');
    expect(froms).not.toContain('t1');
  });

  it('carries the output port through, so the caller can target one specific wire', () => {
    const edge = uncertainEdges(graph).find((e) => e.to === 't2' && e.from === 'r1');
    expect(edge).toEqual({ from: 'r1', to: 't2', port: 'output_2' });
  });

  it('leaves port null for an edge id that carries no parseable port', () => {
    const legacy = { nodes: [{ id: 'r1', type: 'random' }], edges: [{ id: 'legacy-edge', from: 'r1', to: 't1' }] };
    expect(uncertainEdges(legacy)).toEqual([{ from: 'r1', to: 't1', port: null }]);
  });

  it('tolerates an empty, missing or malformed graph', () => {
    expect(uncertainEdges({ nodes: [], edges: [] })).toEqual([]);
    expect(uncertainEdges(null)).toEqual([]);
    expect(uncertainEdges(undefined)).toEqual([]);
    expect(uncertainEdges({})).toEqual([]);
  });

  it('ignores an edge whose source node is not in the graph', () => {
    const orphan = { nodes: [{ id: 'r1', type: 'random' }], edges: [{ id: 'ghost:output_1->t1', from: 'ghost', to: 't1' }] };
    expect(uncertainEdges(orphan)).toEqual([]);
  });
});

describe('connectionPortSelectors', () => {
  it('resolves both endpoints from the classes Drawflow writes on a connection', () => {
    expect(connectionPortSelectors(['connection', 'node_in_node-7', 'node_out_node-3', 'output_2', 'input_1'])).toEqual({
      output: '#node-3 .outputs .output.output_2',
      input: '#node-7 .inputs .input.input_1'
    });
  });

  it('ignores the editor\'s own classes and does not depend on class order', () => {
    // The vendor reads these positionally (classList[3]/[4]); this editor adds
    // classes of its own to the same element, so position is not reliable.
    expect(
      connectionPortSelectors(['game-orchestra-edge-uncertain', 'input_3', 'connection', 'node_out_node-a', 'game-orchestra-edge-hover', 'output_1', 'node_in_node-b'])
    ).toEqual({
      output: '#node-a .outputs .output.output_1',
      input: '#node-b .inputs .input.input_3'
    });
  });

  it('returns null for the in-progress wire Drawflow draws mid-drag, which has no endpoints yet', () => {
    expect(connectionPortSelectors(['connection'])).toBeNull();
  });

  it.each([
    ['no output node', ['connection', 'node_in_node-2', 'output_1', 'input_1']],
    ['no input node', ['connection', 'node_out_node-1', 'output_1', 'input_1']],
    ['no output port', ['connection', 'node_out_node-1', 'node_in_node-2', 'input_1']],
    ['no input port', ['connection', 'node_out_node-1', 'node_in_node-2', 'output_1']]
  ])('returns null when a partial connection has %s', (_label, classes) => {
    expect(connectionPortSelectors(classes)).toBeNull();
  });

  it('tolerates a missing or non-string class list rather than throwing on a stale element', () => {
    expect(connectionPortSelectors(undefined)).toBeNull();
    expect(connectionPortSelectors([])).toBeNull();
    expect(connectionPortSelectors([null, 5, 'connection'])).toBeNull();
  });

  it('accepts any iterable, since the caller passes a live DOMTokenList rather than an array', () => {
    const tokens = new Set(['connection', 'node_out_node-1', 'node_in_node-2', 'output_1', 'input_1']);
    expect(connectionPortSelectors(tokens)?.output).toBe('#node-1 .outputs .output.output_1');
  });
});
