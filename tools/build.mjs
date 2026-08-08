#!/usr/bin/env node
/**
 * Release build - produces `dist/`, the exact tree that ships inside module.zip.
 *
 * **This is not part of development.** `npm test` runs against `scripts/` directly, Foundry's
 * hot-reload watches `scripts/` directly, and the itest tier can mount either. The bundle exists
 * only so that what users download is 119 KB of one file instead of 380 KB of sixty-two, and so
 * that opening the graph editor costs one module request instead of forty-one.
 *
 * The source stays canonical and stays commented. Roughly 54% of `scripts/*.mjs` bytes are
 * comments, and per CLAUDE.md those comments are load-bearing - stripping them from the shipped
 * artifact is precisely what lets them stay verbose in the tree.
 *
 * Run: `npm run build`. Output: `dist/`, plus `dist/scripts/game-orchestra.mjs.map`, which is
 * deliberately NOT zipped (see `--sourcemap=external` below).
 */

import * as esbuild from 'esbuild';
import Handlebars from 'handlebars';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Resolve a repo-relative path. @param {...string} p @returns {string} */
const src = (...p) => path.join(ROOT, ...p);
/** Resolve a dist-relative path. @param {...string} p @returns {string} */
const out = (...p) => path.join(DIST, ...p);

/**
 * Files copied byte-for-byte into `dist/`.
 *
 * `drawflow.min.js` is already minified and is loaded as a **classic script** (module.json
 * `scripts`, not `esmodules`) because it is a UMD build assigning a global - it must never be
 * pulled into the ESM bundle or `Drawflow` is undefined for the editor.
 *
 * `DRAWFLOW_LICENSE.txt` ships because Drawflow is MIT and MIT requires the notice to travel with
 * the redistribution. `scripts/vendor/README.md` does not: it documents the vendoring decision for
 * maintainers, and the manifest's `readme` field already points users at GitHub.
 */
const VERBATIM = [
  'scripts/vendor/drawflow.min.js',
  'scripts/vendor/drawflow.min.css',
  'scripts/vendor/DRAWFLOW_LICENSE.txt',
  'LICENSE',
  'module.json',
  'release_notes.txt'
];

/** @param {string} file @returns {number} size in bytes */
const size = (file) => fs.statSync(file).size;

/** @param {number} n @returns {string} */
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

/**
 * Write a file, creating its parent directories.
 * @param {string} file
 * @param {string|Buffer} data
 */
function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/**
 * Bundle every ES module reachable from the manifest entrypoint into one minified file.
 *
 * `--keep-names` is **mandatory, not a size/safety preference.** The minifier renames classes, and
 * `settings.mjs` gates its re-render on
 * `['MoodWidget','PlaylistTreeApp','GameOrchestraConfig'].includes(app.constructor?.name)`.
 * Without keep-names those classes minify to single letters, the comparison never matches, and the
 * open windows silently stop refreshing on a settings change - no throw, no console error. Exactly
 * the failure class CLAUDE.md's five rules describe. It costs ~7 KB and emits a
 * `static { __name(this, "MoodWidget") }` block per class.
 *
 * Property mangling is deliberately absent. `mangleProps` would rewrite the `api.mjs` surface that
 * third-party modules call by name - the one contract this module makes to the outside.
 *
 * @returns {Promise<void>}
 */
async function buildScripts() {
  const result = await esbuild.build({
    entryPoints: [src('scripts/game-orchestra.mjs')],
    outfile: out('scripts/game-orchestra.mjs'),
    bundle: true,
    format: 'esm',
    // Foundry v14 ships on a current Chromium. es2022 is what makes the `static {}` initializer
    // that keepNames emits legal without a downlevel shim.
    target: 'es2022',
    minify: true,
    keepNames: true,
    legalComments: 'none',
    // `external`, not `linked`: an inline `//# sourceMappingURL=` comment would make every browser
    // request a .map that is not in the zip, and a 404 per load is worse than no map at all. The
    // map is published as a separate release asset instead, for pasting into devtools when a user
    // reports a stack trace against minified line 1.
    sourcemap: 'external',
    metafile: true
  });

  // A file added to scripts/ but imported by nothing is not in the bundle, and would have shipped
  // before this build existed (module.json lists one entrypoint, but the old zip copied the whole
  // directory). Flag it rather than silently dropping code someone believed was live.
  const bundled = new Set(Object.keys(result.metafile.inputs));
  const orphans = fs
    .readdirSync(src('scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `scripts/${f}`)
    .filter((f) => !bundled.has(f));
  if (orphans.length) {
    throw new Error(
      `these modules are not reachable from scripts/game-orchestra.mjs and would not ship:\n  ${orphans.join('\n  ')}`
    );
  }
}

/**
 * Minify the stylesheet.
 *
 * Load order against `drawflow.min.css` is a manifest concern, not a build one - both files keep
 * their paths, so the ordering guard in `tests/module-manifest.test.mjs` still governs. Minifying
 * does not reorder or merge rules across files.
 *
 * @returns {Promise<void>}
 */
async function buildStyles() {
  await esbuild.build({
    entryPoints: [src('styles/game-orchestra.css')],
    outfile: out('styles/game-orchestra.css'),
    minify: true,
    legalComments: 'none'
  });
}

/**
 * Re-emit each language file without indentation.
 *
 * Parse-and-restringify, never a regex: it preserves the key set exactly, so the pt-BR/en parity
 * that `tests/lang.test.mjs` enforces cannot be disturbed here. Escapes and non-ASCII round-trip
 * through `JSON.parse`/`JSON.stringify` unchanged.
 *
 * @returns {void}
 */
function buildLang() {
  for (const file of fs.readdirSync(src('lang'))) {
    if (!file.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(src('lang', file), 'utf8'));
    write(out('lang', file), JSON.stringify(parsed));
  }
}

/**
 * Strip Handlebars comments and leading indentation from the templates.
 *
 * Deliberately conservative: **line structure is preserved.** Only leading/trailing whitespace per
 * line and wholly blank lines go. Collapsing the newlines between tags too would save another few
 * KB and would change rendered output wherever two inline elements sit on separate lines - the
 * newline between them is a rendered space. No template here has a `<pre>` or `<textarea>`, but
 * that is a reason the current rule is safe, not a licence to go further.
 *
 * Each result is compiled before it is written. A template that no longer parses must fail the
 * build, not Foundry.
 *
 * @returns {void}
 */
function buildTemplates() {
  for (const file of fs.readdirSync(src('templates'))) {
    if (!file.endsWith('.hbs')) continue;
    const minified = fs
      .readFileSync(src('templates', file), 'utf8')
      .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
      .replace(/\{\{![^}]*\}\}/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');

    try {
      Handlebars.precompile(minified);
    } catch (error) {
      throw new Error(`templates/${file} does not compile after minification: ${error.message}`);
    }

    write(out('templates', file), minified);
  }
}

/**
 * Assert that every path `module.json` declares exists in `dist/`.
 *
 * The release workflow runs the same check against the built zip. Both are worth having: this one
 * fails in a second on a laptop, that one covers the archiving step itself. A manifest path with
 * no file behind it is a module that 404s on load while every test stays green.
 *
 * @returns {void}
 */
function verifyManifest() {
  const manifest = JSON.parse(fs.readFileSync(src('module.json'), 'utf8'));
  const declared = [
    ...(manifest.esmodules || []),
    ...(manifest.scripts || []),
    ...(manifest.styles || []),
    ...(manifest.languages || []).map((l) => l.path)
  ];

  const missing = declared.filter((p) => !fs.existsSync(out(p)));
  if (missing.length) {
    throw new Error(`module.json declares paths that the build did not produce:\n  ${missing.join('\n  ')}`);
  }

  // A zero-byte bundle satisfies an existence check and loads as a module that does nothing.
  const bundle = out(manifest.esmodules[0]);
  if (size(bundle) < 50_000) {
    throw new Error(`${manifest.esmodules[0]} is only ${size(bundle)} bytes - the bundle is not plausibly complete`);
  }
}

/**
 * Print what shipped, and what it replaced.
 * @returns {void}
 */
function report() {
  /** @param {string} dir @returns {number} */
  const treeSize = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .reduce((sum, e) => sum + (e.isDirectory() ? treeSize(path.join(dir, e.name)) : size(path.join(dir, e.name))), 0);

  const sourceSize =
    treeSize(src('scripts')) + treeSize(src('styles')) + treeSize(src('templates')) + treeSize(src('lang'));
  // The map is written into dist/ but excluded from the zip; don't count it as shipped weight.
  const mapSize = size(out('scripts/game-orchestra.mjs.map'));
  const distSize = treeSize(DIST) - mapSize;

  console.log(`  scripts   ${kb(size(out('scripts/game-orchestra.mjs')))}  (bundle, ${kb(mapSize)} map alongside)`);
  console.log(`  styles    ${kb(size(out('styles/game-orchestra.css')))}`);
  console.log(`  shipped   ${kb(distSize)}  from ${kb(sourceSize)} of source  (-${Math.round(100 - (100 * distSize) / sourceSize)}%)`);
}

/** @returns {Promise<void>} */
async function main() {
  fs.rmSync(DIST, { recursive: true, force: true });

  await buildScripts();
  await buildStyles();
  buildLang();
  buildTemplates();
  for (const file of VERBATIM) write(out(file), fs.readFileSync(src(file)));

  verifyManifest();
  console.log('Built dist/');
  report();
}

main().catch((error) => {
  console.error(`build failed: ${error.message}`);
  process.exit(1);
});
