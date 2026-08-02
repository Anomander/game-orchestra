import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../module.json'), 'utf8'));

describe('module.json manifest invariants', () => {
  it('loads scripts/vendor/drawflow.min.css before styles/game-orchestra.css', () => {
    // Regression guard: several game-orchestra.css node-styling rules (e.g.
    // .game-orchestra-drawflow-canvas .drawflow-node) have the SAME CSS specificity
    // as Drawflow's own base rules (e.g. .drawflow .drawflow-node). At equal
    // specificity, whichever rule loads LAST wins - if game-orchestra.css loaded
    // first, Drawflow's defaults (cyan background, fixed width, etc.) would
    // silently win instead, which is exactly what happened once already
    // (every node rendered with a flat cyan fill regardless of type). See
    // scripts/vendor/README.md.
    const styles = manifest.styles || [];
    const drawflowIndex = styles.indexOf('scripts/vendor/drawflow.min.css');
    const gameOrchestraIndex = styles.indexOf('styles/game-orchestra.css');
    expect(drawflowIndex).toBeGreaterThanOrEqual(0);
    expect(gameOrchestraIndex).toBeGreaterThanOrEqual(0);
    expect(drawflowIndex).toBeLessThan(gameOrchestraIndex);
  });

  it('loads the vendored Drawflow script as a classic (non-module) script, not an ES module', () => {
    // drawflow.min.js is a UMD build assigning a global - importing it as an
    // ES module would leave `Drawflow` undefined for custom-playlist-editor.mjs.
    expect(manifest.scripts || []).toContain('scripts/vendor/drawflow.min.js');
    expect(manifest.esmodules || []).not.toContain('scripts/vendor/drawflow.min.js');
  });
});
