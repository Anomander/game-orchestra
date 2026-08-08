import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Deliberately no explicit setupFoundryMocks() call - importing the mocks runs it once as a side
// effect, and it must happen before the bundle evaluates. Same reasoning as game-orchestra.test.mjs.
import './mocks/foundry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(__dirname, '../dist/scripts/game-orchestra.mjs');

// `npm run build` is not part of the dev loop and a clean checkout has no dist/, so this file
// skips rather than fails when the bundle is absent. CI builds before it tests, so the guard is
// live where it matters. See docs/wiki/packaging.md.
const built = fs.existsSync(BUNDLE);

describe.skipIf(!built)('the built dist/ bundle', () => {
  it('evaluates and registers the same hooks the source entrypoint does', async () => {
    // Evaluating at all is most of the value: a bundle that throws on load leaves Foundry with a
    // module that silently does nothing, and neither `node --check` nor the manifest verification
    // in tools/build.mjs would notice.
    await import(BUNDLE);

    const registered = Hooks.on.mock.calls.map(([event]) => event);
    expect(registered).toContain('canvasReady');
    expect(registered).toContain('updateCombat');
    expect(Hooks.once.mock.calls.map(([event]) => event)).toContain('init');
  });

  it('preserves the class names settings.mjs matches on (--keep-names)', () => {
    // P1 in docs/wiki/packaging.md, and the whole reason the build passes --keep-names.
    //
    // settings.mjs gates its window refresh on
    // `['MoodWidget','PlaylistTreeApp','GameOrchestraConfig'].includes(app.constructor?.name)`.
    // Plain --minify renames those classes to single letters, the comparison stops matching, and
    // every open window silently stops refreshing on a settings change - no throw, no console
    // error, nothing in any other test. Asserting on the emitted text is crude but it is the only
    // thing standing between a dropped build flag and that bug shipping.
    const bundle = fs.readFileSync(BUNDLE, 'utf8');
    for (const className of ['MoodWidget', 'PlaylistTreeApp', 'GameOrchestraConfig']) {
      expect(bundle, `${className} lost its runtime name - was --keep-names dropped?`).toMatch(
        new RegExp(`this,\\s*["']${className}["']`)
      );
    }
  });

  it('does not mangle the public api.mjs surface', () => {
    // P2: mangleProps would rewrite the property names third-party modules call. Spot-check that
    // recognisable API members survive as literal text.
    const bundle = fs.readFileSync(BUNDLE, 'utf8');
    expect(bundle).toContain('musicController');
  });
});
