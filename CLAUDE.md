# CLAUDE.md — Game Orchestra

FoundryVTT v14 module (`id: game-orchestra`) that switches scene music between exploration and
combat automatically, and lets any playlist define its own playback rules as a visual node
graph.

**This file is the always-loaded summary. The detailed wiki lives in [docs/wiki/](docs/wiki/) —
read the page that matches your task before writing code.**

---

## Commands

| Command | What it does |
|---|---|
| `npm test` | Full vitest suite. Baseline: **2157 tests, 46 files, all passing.** ~9s. |
| `npm run build` | Release artifact only — writes `dist/`. Not part of the dev loop. See [packaging.md](docs/wiki/packaging.md). |
| `npm run test:watch` | Watch mode. |
| `npm run test:coverage` | Coverage report. |
| `cd itest && npm run ci` | **Audio integration tier** — real Foundry in Docker, real Web Audio, ~10 min, 19 specs. Needs a Foundry licence. Also runs as a **gate on every release**. See [integration-testing.md](docs/wiki/integration-testing.md). |

There is **no build step for development, no TypeScript, and no linter.** `scripts/*.mjs` is loaded
by Foundry as native ESM straight from the tree — edit, reload, done. `node --check <file>` is the
fastest syntax check.

`npm run build` exists only to produce the **release** artifact (`dist/`): one minified bundle
instead of 41 modules, 119 KB zipped instead of 380 KB. Nothing in the dev loop needs it, and
`dist/` is gitignored. Two things about it are load-bearing rather than cosmetic — see
[packaging.md](docs/wiki/packaging.md):

- The bundle **must** be built with `--keep-names`. The minifier renames classes, and
  `settings.mjs` gates a re-render on `app.constructor?.name` matching `'MoodWidget'` /
  `'PlaylistTreeApp'` / `'GameOrchestraConfig'`. Without it those windows silently stop
  refreshing — no throw, no console error.
- Property mangling must stay off, or it rewrites the `api.mjs` surface third parties call.

---

## The five rules that break things silently

Violating any of these produces a bug with **no console error** — it just stops working.
Each is documented at length in [docs/wiki/invariants.md](docs/wiki/invariants.md).

1. **A custom-graph playlist is stored `UNSEQUENCED` (H1) but is never a Soundboard (H2).**
   Every `isSoundboard` computation must exclude it, and it must never be given an implicit
   `initialTrack` — a stray track id bypasses the entire graph.

2. **The graph editor never calls `this.render()` after its initial mount.** Drawflow fires
   `nodeSelected` synchronously inside its own mousedown, *before* setting up the drag. A full
   ApplicationV2 re-render at that moment detaches the live canvas and dragging dies silently.
   Mutations go through `_renderInspector()` / `_renderTracks()` — direct `innerHTML` on a
   sibling container.

3. **`DragDrop#bind()` must run on every render, unguarded.** It is not delegated — it queries
   `dropSelector` once at bind time. Handlebars replaces a part's DOM wholesale, so guarding
   the call orphans drag-and-drop after the first re-render.

4. **Both `lang/en.json` and `lang/pt-BR.json` must carry the exact same key set.**
   `tests/lang.test.mjs` enforces parity in both directions — no missing keys, no orphans, no
   empty values. This shipped broken once (pt-BR fell 73 keys behind).

5. **The playback engine runs only on the head GM** (`isHeadGM()` — first active GM by id).
   Every other client observes the resulting `PlaylistSound` state via Foundry's normal sync.
   Nothing is broadcast over a socket.

   **The mixer is the exception, and it is not one you can guess.** Volume is applied per client
   from the document, so `playlist-mix-apply.mjs` must run *everywhere* — head-GM-gating it means
   the GM hears the ceiling and the players hear the raw track. Only the mixer *window* is
   GM-gated. See [mixer.md](docs/wiki/mixer.md).

---

## Read the comments

This codebase's comments are unusually load-bearing. Nearly every one records a **bug that was
confirmed live**, not a hypothesis — including the exact failure mode and why the obvious
alternative doesn't work. Phrases like *"confirmed live"*, *"this happened in practice"*, and
*"not a hypothetical"* mark hazards someone already paid for.

Do not delete or "clean up" a comment because the code looks self-evident. If you change the
code it guards, update the comment to match.

---

## Wiki map

| Page | Read it when |
|---|---|
| [api.md](docs/wiki/api.md) | **Touching `scripts/api.mjs`, or adding/changing a hook.** The one surface third parties depend on |
| [architecture.md](docs/wiki/architecture.md) | Anything touching playback, priority, or context resolution |
| [invariants.md](docs/wiki/invariants.md) | **Always.** H1–H17 hazards + house rules |
| [graph-engine.md](docs/wiki/graph-engine.md) | Touching the token-walk engine, node types, or concurrency |
| [editor.md](docs/wiki/editor.md) | Touching the Drawflow graph editor or any ApplicationV2 window |
| [mixer.md](docs/wiki/mixer.md) | Touching volume, mute, fades, the crossfade chain, or the `game-orchestra.mix` flag |
| [ux.md](docs/wiki/ux.md) | **Adding, moving, or renaming any UI surface** — the five jobs + UX-1–UX-9 principles |
| [node-anatomy.md](docs/wiki/node-anatomy.md) | **Adding a node type**, or putting anything new on a node |
| [module-map.md](docs/wiki/module-map.md) | Locating code — file-by-file index with purity notes |
| [packaging.md](docs/wiki/packaging.md) | **Touching `tools/build.mjs`, the release workflow, or anything about what ships** |
| [testing.md](docs/wiki/testing.md) | Writing or fixing tests |
| [integration-testing.md](docs/wiki/integration-testing.md) | **Touching anything under `itest/`**, or before trusting a green suite about playback |
| [playbook.md](docs/wiki/playbook.md) | Step-by-step recipes for common change types |

---

## Conventions

- **Purity boundary.** Modules with no `game`/`ui`/DOM/Drawflow dependency are deliberately
  Foundry-free so they can be unit-tested directly: `playlist-ref.mjs`, `graph-validation.mjs`,
  `graph-drawflow-bridge.mjs`, `graph-presets.mjs`, `native-mode-graph.mjs`, `graph-builder.mjs`,
  `graph-activity-highlight.mjs`, `graph-drop.mjs`, `graph-splice.mjs`, `graph-history.mjs`,
  `playlist-mix.mjs`, `playlist-mixer-render.mjs`, `custom-playlist-inspector.mjs`,
  `custom-playlist-node-render.mjs`, `binding-cards.mjs`,
  `custom-playlist-connection-render.mjs`, `custom-playback-schema.mjs`.
  **Keep them pure.** If one needs live state, the caller reads it and passes it in — that is
  why `helpers.mjs#resolvePlaylistRef` exists as a thin Foundry-touching wrapper around
  `playlist-ref.mjs#resolvePlaylistRefId`.
- **Validation emits i18n keys, never localized strings** (`graph-validation.mjs` has no Foundry
  dependency). The render boundary localizes.
- **Escape user data.** Sound names, mood names, and node labels are interpolated into
  hand-built HTML strings — always through `escapeHtml()` from `custom-playlist-node-render.mjs`.
- **Logging:** `log(1, …)` error, `log(2, …)` warn, `log(3, …)` debug. Levels 2 and 3 are gated
  behind the `enableDebug` setting via a module-level cache. On hot paths (every node hop), pass
  a **thunk** — `log(3, () => \`…\`)` — so the template string is never built when debug is off.
- **JSDoc every export**, matching the existing density.

---

## Gotchas that cost time

- `docs/custom-playlist-plan.md` **does not exist** — it was lost. ~16 comments across 8 files
  still cite its hazard IDs (H1–H11). Those IDs are reconstructed in
  [docs/wiki/invariants.md](docs/wiki/invariants.md); the stale paths in the source were left
  untouched on purpose.
- `docs/playlist-node-plan.md` and `docs/graph-editor-panel-plan.md` **do** exist and are cited
  by code using section IDs (`D3`, `D6`, `Phase 4.4`). They are **archived implementation plans**
  — historically accurate, not maintained. Their durable content is folded into the wiki. Do not
  move or rename them; the citations would break.
- Style load order is load-bearing: `drawflow.min.css` **must** load before `game-orchestra.css`
  (equal specificity, last wins). `tests/module-manifest.test.mjs` guards it.
- `templates/parts/` holds **partials**, included by full path (`{{> "modules/game-orchestra/…"}}`)
  and registered in `game-orchestra.mjs`'s `loadTemplates` call. Adding one means touching three
  places — the file, that call, and nothing else — but missing the `loadTemplates` entry throws
  only at render time, and `tools/build.mjs` must stay **recursive** or the partial never reaches
  `dist/`. Both halves are test-guarded (`template-compile`, `dist-bundle`).
- Drawflow is a UMD build loaded as a **classic script** (`module.json` `scripts`, not
  `esmodules`) and reaches the editor as the global `Drawflow`.
