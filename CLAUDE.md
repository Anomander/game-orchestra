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
| `npm test` | Full vitest suite. Baseline: **1413 tests, 33 files, all passing.** ~2s. |
| `npm run test:watch` | Watch mode. |
| `npm run test:coverage` | Coverage report. |

There is **no build step, no bundler, no TypeScript, and no linter.** `scripts/*.mjs` ships
verbatim to the browser as native ESM. `node --check <file>` is the fastest syntax check.

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
| [architecture.md](docs/wiki/architecture.md) | Anything touching playback, priority, or context resolution |
| [invariants.md](docs/wiki/invariants.md) | **Always.** H1–H16 hazards + house rules |
| [graph-engine.md](docs/wiki/graph-engine.md) | Touching the token-walk engine, node types, or concurrency |
| [editor.md](docs/wiki/editor.md) | Touching the Drawflow graph editor or any ApplicationV2 window |
| [mixer.md](docs/wiki/mixer.md) | Touching volume, mute, fades, the crossfade chain, or the `game-orchestra.mix` flag |
| [node-anatomy.md](docs/wiki/node-anatomy.md) | **Adding a node type**, or putting anything new on a node |
| [module-map.md](docs/wiki/module-map.md) | Locating code — file-by-file index with purity notes |
| [testing.md](docs/wiki/testing.md) | Writing or fixing tests |
| [playbook.md](docs/wiki/playbook.md) | Step-by-step recipes for common change types |

---

## Conventions

- **Purity boundary.** Modules with no `game`/`ui`/DOM/Drawflow dependency are deliberately
  Foundry-free so they can be unit-tested directly: `playlist-ref.mjs`, `graph-validation.mjs`,
  `graph-drawflow-bridge.mjs`, `graph-presets.mjs`, `native-mode-graph.mjs`, `graph-builder.mjs`,
  `graph-activity-highlight.mjs`, `graph-drop.mjs`, `graph-history.mjs`,
  `playlist-mix.mjs`, `playlist-mixer-render.mjs`, `custom-playlist-inspector.mjs`,
  `custom-playlist-node-render.mjs`,
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
- Drawflow is a UMD build loaded as a **classic script** (`module.json` `scripts`, not
  `esmodules`) and reaches the editor as the global `Drawflow`.
