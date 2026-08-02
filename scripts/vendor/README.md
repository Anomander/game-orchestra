# Vendored dependencies

## Drawflow

- **Source**: https://github.com/jerosoler/Drawflow
- **Version vendored**: 0.0.60 (npm `drawflow@0.0.60`)
- **License**: MIT (see `DRAWFLOW_LICENSE.txt`, copied verbatim from the upstream package)
- **Why vendored rather than loaded from a CDN**: Foundry serves module assets locally; a
  CDN dependency would break offline/self-hosted worlds and is disallowed by this module's
  content-security posture. See `docs/custom-playlist-plan.md` Phase 0b.
- **Loaded as**: a classic (non-module) script via `module.json`'s `scripts` array, since
  `drawflow.min.js` is a UMD build that assigns `self.Drawflow` as a global - it is not an
  ES module and must not be `import`ed. `scripts/custom-playlist-editor.mjs` references the
  global `Drawflow` class directly.
- **To update**: download `dist/drawflow.min.js` and `dist/drawflow.min.css` from a newer
  `drawflow` npm release, replace the two files here, update this note's version line, and
  re-run the Phase 0b integration check (mount a throwaway editor, add nodes, export/import)
  before trusting the new version in the real editor.
- **Style load order matters**: `module.json`'s `styles` array must list
  `scripts/vendor/drawflow.min.css` *before* `styles/game-orchestra.css`. Several of game-orchestra.css's
  node-styling rules (e.g. `.game-orchestra-drawflow-canvas .drawflow-node`) have the *same* CSS
  specificity as Drawflow's own base rules (e.g. `.drawflow .drawflow-node`) - at equal
  specificity the rule that loads *last* wins, so game-orchestra.css must load second or Drawflow's
  defaults (cyan background, fixed 160px width, etc.) silently win instead. This bit us once
  already (every node rendered with the same flat cyan fill regardless of type, because the
  order was backwards) - if node styling ever looks like it's reverting to Drawflow's
  defaults, check this array's order first before suspecting the CSS rules themselves.

Maintenance note: as of this vendoring, Drawflow's upstream repository had not been updated
in roughly 21 months. It is MIT-licensed and dependency-free, so this is an acceptable risk
for a small, stable feature surface (node/connection rendering) - but any future bug in it is
ours to patch locally, not something to wait on upstream for.
