# Packaging

What ships, how it is built, and the two things about it that break silently.

---

## The shape of it

Development loads `scripts/*.mjs` straight from the tree as native ESM. **Nothing in the dev loop
builds.** `npm test` runs against the source, Foundry's hot-reload watches the source, and the
integration tier mounts the source by default.

`npm run build` (`tools/build.mjs`) exists for one purpose: producing `dist/`, the tree that goes
inside `module.zip`.

| | Source tree | `dist/` |
|---|---|---|
| `module.zip` | 380 KB | **119 KB** |
| Installed on disk | 1.4 MB | 524 KB |
| Files in the archive | 62 | 12 |
| ESM requests on load | 41 | 1 |

The single biggest contributor is comments: **54% of `scripts/*.mjs` bytes**. That is not waste —
per [CLAUDE.md](../../CLAUDE.md) those comments record confirmed live bugs and are the most
valuable thing in the file. Stripping them from the *artifact* is exactly what lets them stay
verbose in the *tree*.

`dist/` is gitignored. It is never a source of truth, and a stale one that disagreed with
`scripts/` would look identical to a fresh one until a user loaded it.

---

## P1 — `--keep-names` is mandatory

The minifier renames classes. `settings.mjs` gates its window refresh on:

```js
['MoodWidget', 'PlaylistTreeApp', 'GameOrchestraConfig'].includes(app.constructor?.name)
```

Under plain `--minify` those become `class a extends …`, the comparison never matches, and every
open window silently stops refreshing when a setting changes. **No throw, no console error** — the
signature failure mode of this codebase's hazards.

`keepNames: true` makes esbuild emit a static initializer that restores the runtime name:

```js
var l = (a, e) => Object.defineProperty(a, "name", { value: e, configurable: !0 });
// …
class a extends ri(ii) { static { l(this, "MoodWidget") } … }
```

It costs about 7 KB (254.1 → 261.5 KB). Note that it restores `.name` as *data* — anything that
reconstructed a *reference* from a name string would still be broken. Nothing here does; the three
call sites are all `constructor.name` comparisons.

## P2 — property mangling must stay off

`mangleProps` would rewrite the `api.mjs` surface that third-party modules call by name. That is
the one contract this module makes to the outside world; see [api.md](api.md). Identifier
minification is safe because the API is exposed by property assignment
(`self.api = published` in `game-orchestra.mjs`), which the minifier does not touch.

---

## What the build does

1. **Bundle** — esbuild, `format: esm`, `target: es2022` (needed for the `static {}` block
   `keepNames` emits), `minify`, `keepNames`, `legalComments: none`.
   Fails if any `scripts/*.mjs` is unreachable from the entrypoint — before the bundle existed such
   a file shipped anyway, so an orphan has to be loud rather than quietly dropped.
2. **CSS** — minified. Load order versus `drawflow.min.css` is a *manifest* concern and is still
   governed by `tests/module-manifest.test.mjs`; both files keep their paths.
3. **Lang** — `JSON.parse` → `JSON.stringify`, never a regex, so the en/pt-BR key parity that
   `tests/lang.test.mjs` enforces cannot be disturbed here.
4. **Templates** — Handlebars comments stripped, per-line indentation trimmed, blank lines dropped.
   **Line structure is preserved deliberately**: the newline between two inline elements on
   separate lines is a rendered space, so collapsing it would change output. Each result is
   compiled with `Handlebars.precompile` before it is written.
5. **Verbatim copies** — `drawflow.min.js` (a UMD build loaded as a *classic script*; it must never
   enter the ESM bundle or `Drawflow` is undefined), `drawflow.min.css`, `DRAWFLOW_LICENSE.txt`
   (MIT requires the notice to travel), `LICENSE`, `module.json`, `release_notes.txt`.
6. **Verify** — every path `module.json` declares exists in `dist/`, and the bundle is plausibly
   sized (a zero-byte bundle passes an existence check and loads as a module that does nothing).

`README.md` and `scripts/vendor/README.md` do **not** ship. The manifest's `readme` field already
points users at GitHub.

---

## Sourcemaps

Built as `external` — the map is written to `dist/scripts/game-orchestra.mjs.map` and is **not**
zipped, and the bundle carries no `//# sourceMappingURL` comment. A linked map would cost every
user a 404 on every load for a file that is not in the archive.

The map is attached to the GitHub release as its own asset. When a user reports a stack trace
against minified line 1, download the map for that version and load it in devtools.

---

## The release gate runs against `dist/`

This is the part worth understanding. The audio tier is what permits a release to publish to the
Foundry Package API — a public, non-amendable action. If it certified the source tree while the zip
carried a bundle, it would be certifying code nobody downloads; the two differ by a bundler, a
minifier, and a name-preserving transform, each of which can break playback silently.

So `release.yml` passes `against_dist: true`, which sets `ITEST_AGAINST_DIST=1`, which makes
`itest/scripts/up.sh` build `dist/` and point the container's module mount at it
(`MODULE_MOUNT=../../dist`). The nightly does the same — a build regression found at 4am is a
fixable morning; the same one found mid-release is not.

On-demand and per-PR integration runs stay on the working tree, where a failure points at the code
someone just changed rather than at the bundler.

`test.yml` runs `npm run build` on every push. It is under a second and it is the only check on the
bundle outside a release.

To reproduce a release-shaped run locally:

```sh
cd itest && ITEST_AGAINST_DIST=1 npm run ci
```

---

## Order-of-operations hazard in the release workflow

`release.yml` substitutes the version and download URLs into `module.json` **before** it builds.
The build copies `module.json` into `dist/`, so reversing those two steps publishes a manifest with
an empty `download` field. The zip step then runs from inside `dist/` — a zip with a leading
`dist/` path component installs as a module Foundry cannot find.

---

## Related

- [architecture.md](architecture.md) — the execution model the bundle preserves
- [api.md](api.md) — the surface P2 protects
- [integration-testing.md](integration-testing.md) — the tier the release gate runs
