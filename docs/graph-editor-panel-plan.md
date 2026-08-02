# Plan: accordion side panel + drag-in node creation for the graph editor

> ## 📦 ARCHIVED — this feature has shipped
>
> This is the original implementation plan, kept for its **section ids** (`D2`, `D6`, `D8`,
> `HR-A`–`HR-D`), which several source comments cite by name. **Do not move, rename, or rewrite
> this file** — the citations would break.
>
> It is historically accurate but **no longer maintained**. For current documentation see
> [`docs/wiki/editor.md`](wiki/editor.md), which folds in the durable content, and
> [`docs/wiki/invariants.md`](wiki/invariants.md) for the `HR-*` house rules.

**Audience:** the implementing model. Every decision below is **locked** — implement it as
written. If something here turns out to be impossible against the real code, stop and report
rather than inventing a different design.

**Goal:** replace the graph editor's top palette strip + single properties panel with a
**three-pane accordion side panel** (Add element / Properties / Tracks), and let a Playlist or
PlaylistSound **dragged in from the Foundry sidebar** create the corresponding node on the
canvas at the drop point.

---

## 0. Read these first

- `templates/custom-playlist-editor.hbs` — the shell being restructured.
- `scripts/custom-playlist-editor.mjs` — the class doc at the top is mandatory reading.
- `scripts/custom-playlist-inspector.mjs` — the pure HTML-string builder pattern this plan
  extends to two more panes.
- `scripts/custom-playlist-node-render.mjs` — `NODE_LABELS`, `escapeHtml`, node shape rationale.
- `scripts/app-mixins.mjs`, `scripts/playlist-tree.mjs#_setupDragDrop` / `#_onDropExternal`,
  `scripts/app.mjs#onDropExternal` — the house drag/drop pattern to copy.
- `styles/game-orchestra.css` lines ~610–760 (editor chrome) and ~760–1160 (node shapes + the long
  specificity comment).

### Existing house rules this must not break

- **HR-A** — the editor **never** calls `this.render()` after the initial mount. Drawflow's
  `nodeSelected` fires synchronously inside its own mousedown, before it sets up a drag; a full
  ApplicationV2 re-render at that moment detaches the live canvas and dragging silently dies.
  Every mutation goes through `_renderInspector()` (direct `innerHTML` on a sibling container).
  **Everything in this plan obeys that**: the accordion shell is rendered once by Handlebars and
  only ever has classes toggled; the two dynamic pane bodies are `innerHTML` targets.
- **HR-B** — `[data-drawflow-mount]` must stay class-free (Drawflow reads `classList[0]`).
  Nothing here adds a class to it. Drop listeners bind to the **wrapper**,
  `.game-orchestra-drawflow-canvas`, not the mount.
- **HR-C** — node shape CSS is specificity-critical. The per-type rules are 3 classes deep on
  purpose. This plan only ever **substitutes literals for `var()`** inside those rules; no
  selector is changed, added to, or reordered.
- **HR-D** — `DragDrop#bind()` is not delegated: it queries `dropSelector` at bind time. Call
  `_setupDragDrop()` from `_onRender()` **unguarded**, matching `app-mixins.mjs`.

---

## 1. Locked design decisions

### D1 — Panel moves to the left

The properties panel is currently the **last** child of `.game-orchestra-editor-body`, i.e. it renders
on the right. The request calls it "the left properties panel", so it moves: the panel becomes
the **first** child, canvas second. Pure markup order + a `flex-direction` untouched — no CSS
side changes needed beyond what D3 specifies.

### D2 — Three panes, independently collapsible, never auto-collapsed

Panes, in this fixed order:

| id | header | body content | body is |
|---|---|---|---|
| `palette` | *Add Element* | the 8 shaped node buttons + the preset `<select>` | static (Handlebars) |
| `properties` | *Properties* | today's inspector output, **minus validation** | `innerHTML` target |
| `tracks` | *Tracks* | this playlist's sounds | `innerHTML` target |

**Multi-open, not exclusive.** Each header toggles only its own pane. Rationale: the three panes
have wildly different natural heights, and the two most-used flows — "read the properties of the
node I just wired" and "drag the next track onto the canvas" — are *concurrent*. A
one-open-at-a-time accordion would close Tracks every time a node is clicked, i.e. it would undo
the user's own choice on almost every interaction. Nothing in this design ever collapses a pane
the user opened.

Initial state: `palette` **collapsed**, `properties` **open**, `tracks` **open**.

The one automatic move: when a node becomes selected on the canvas and `properties` is
collapsed, open it. That's an expand, never a collapse.

> To make it exclusive instead, `_togglePane()` becomes a single-value assignment rather than a
> `Set` operation — it is deliberately isolated to that one method so the choice is reversible in
> a few lines.

### D3 — Panel markup

Replace the current `.game-orchestra-editor-palette` block and the bare `.game-orchestra-editor-inspector`
div. The whole panel is Handlebars-rendered **once**; only pane bodies marked below are ever
rewritten.

```hbs
<aside class="game-orchestra-editor-panel">
  <section class="game-orchestra-pane" data-pane="palette">
    <button type="button" class="game-orchestra-pane-header" data-action="togglePane" data-pane="palette"
            aria-expanded="false" aria-controls="game-orchestra-pane-body-palette">
      <i class="fas fa-caret-down game-orchestra-pane-caret"></i>
      <span>{{localize "GameOrchestra.CustomEditor.Pane.Palette"}}</span>
    </button>
    <div class="game-orchestra-pane-body" id="game-orchestra-pane-body-palette">
      <div class="game-orchestra-palette-grid">
        {{#each palette}}
        <button type="button" class="game-orchestra-palette-item" data-action="addNode"
                data-node-type="{{this.type}}" title="{{localize this.label}}">
          <span class="game-orchestra-shape-swatch game-orchestra-node-{{this.type}}" aria-hidden="true">
            <i class="fas {{this.icon}}"></i>
          </span>
          <span class="game-orchestra-palette-label">{{localize this.label}}</span>
        </button>
        {{/each}}
      </div>
      <!-- unchanged: a <select>, so it dispatches through _CHANGE_ACTIONS -->
      <select class="game-orchestra-preset-select" data-change-action="applyPreset" ...>…</select>
    </div>
  </section>

  <section class="game-orchestra-pane" data-pane="properties">
    <button ... data-pane="properties" aria-expanded="true">…</button>
    <!-- Populated exclusively via _renderInspector(). Keeps its historical class so that
         method's querySelector is unchanged. -->
    <div class="game-orchestra-pane-body game-orchestra-editor-inspector" id="game-orchestra-pane-body-properties"></div>
  </section>

  <section class="game-orchestra-pane" data-pane="tracks">
    <button ... data-pane="tracks" aria-expanded="true">…</button>
    <!-- Populated exclusively via _renderTracks(). -->
    <div class="game-orchestra-pane-body game-orchestra-editor-tracks" id="game-orchestra-pane-body-tracks"></div>
  </section>

  <!-- OUTSIDE the accordion - see D4. Populated via _renderValidation(). -->
  <div class="game-orchestra-editor-validation"></div>
</aside>
```

A collapsed pane is `.game-orchestra-pane.collapsed`, whose `.game-orchestra-pane-body` is
`display: none`. `aria-expanded` is kept in sync on the header button.

`palette` entries gain an `icon` field in `NODE_PALETTE` (`fa-play`, `fa-music`, … — the same
values as `NODE_ICONS` in `custom-playlist-node-render.mjs`). **Export `NODE_ICONS` from that
module and build `NODE_PALETTE`'s `icon` from it** rather than retyping the mapping; two copies
of it would drift.

### D4 — Validation moves out of the inspector, into a pinned region

**This is required, not cosmetic.** Today `buildInspectorHtml()` appends the error/warning lists
to the inspector body. If Properties can be collapsed, a failed Save would show
"Validation failed" as a toast and put the actual reasons inside a hidden pane — and even when
open, they sit below a long form, off-screen.

- `custom-playlist-inspector.mjs` gains `buildValidationHtml({ validation, localize })`, which
  emits exactly the three existing `.game-orchestra-validation-errors` / `-warnings` / `-infos` blocks
  (move the code; `issueItem`/`issueText` stay where they are and are shared).
- `buildInspectorHtml()` **no longer emits them** and no longer takes `validation`.
- `CustomPlaylistEditor#_renderValidation()` writes into `.game-orchestra-editor-validation`, which sits
  below the accordion, `flex: 0 0 auto`, `max-height: 34%`, `overflow-y: auto`, and is
  `display: none` when there is nothing to show.
- `_renderInspector()` calls `_renderValidation()` and `_renderTracks()` at its end, so every
  existing mutation call site stays a single `_renderInspector()` call and nothing else changes.
  `_refreshIssueBadges()` keeps being driven from there too.

### D5 — Shape swatches, without touching the canvas selectors

Each palette button carries a swatch that draws its node type's real shape at ~34px.

1. Add a `:root` block in `game-orchestra.css` defining, per type, an accent and a shape:
   `--game-orchestra-accent-start: #4caf50; --game-orchestra-clip-start: polygon(0% 0%, 86.6% 50%, 0% 100%);`
   … for `start`, `end`, `track`, `playlist`, `fork`, `delay`, `random`, `condition`. Radii for
   the non-clipped shapes go in the same block (`--game-orchestra-radius-track: 999px`, etc.).
2. In the existing canvas rules, **replace the literal values with the corresponding `var()`**.
   Selectors, order, and the comments above them are untouched (HR-C). The rendered result must
   be pixel-identical; that is the acceptance bar for this step.
3. Add a new, self-contained block for swatches — new class names, so no specificity conflict
   with anything:

```css
.game-orchestra-shape-swatch { position: relative; display: inline-flex; align-items: center;
  justify-content: center; width: 34px; height: 34px; flex: 0 0 34px; }
.game-orchestra-shape-swatch::before { content: ""; position: absolute; inset: 0;
  background: var(--color-cool-4, #2a2a2a);
  border: 2px solid var(--game-orchestra-node-accent, #888); }
.game-orchestra-shape-swatch > i { position: relative; font-size: 0.8em;
  color: var(--game-orchestra-node-accent, #888); }
```

then one small rule per type setting `--game-orchestra-node-accent` and the `clip-path` /
`border-radius` / box proportions from the `:root` vars:

| type | swatch geometry |
|---|---|
| `start` / `end` | 34×34, `clip-path: var(--game-orchestra-clip-start\|end)` |
| `track` | 34×20, `border-radius: 999px` |
| `playlist` | 34×24, `border-radius: 6px` + the inset double-ring `box-shadow` |
| `delay` | 30×30, `border-radius: 50%` |
| `condition` | 34×22, `border-radius: 3px` |
| `fork` / `random` | 14×32, `border-radius: 4px` |

Swatches sit in a `display: grid; grid-template-columns: 1fr 1fr` palette; each
`.game-orchestra-palette-item` is a `flex` row (swatch, then label, `text-overflow: ellipsis`), ~44px
tall. Eight buttons therefore occupy 4 rows.

### D6 — Where a new node lands

`handleAddNode` currently hardcodes `(60, 60)`, so repeated clicks stack nodes exactly on top of
each other. With the palette now one click away in a pane, this gets hit constantly. Replace it
with `_defaultNodePoint()`:

```js
// Canvas coordinates of the viewport centre, with a small cascade so successive
// adds don't land on one another.
_defaultNodePoint() {
  const editor = this._drawflow;
  const c = editor?.container;
  const zoom = editor?.zoom || 1;
  const x = ((c?.clientWidth || 800) / 2 - (editor?.canvas_x || 0)) / zoom - 70;
  const y = ((c?.clientHeight || 600) / 2 - (editor?.canvas_y || 0)) / zoom - 40;
  const step = (this._addCascade = ((this._addCascade ?? -1) + 1) % 6) * 26;
  return { x: x + step, y: y + step };
}
```

`_addCascade` is per-window instance state, initialized in the constructor.

### D7 — The Tracks pane

New module `scripts/custom-playlist-tracks.mjs`, exporting a **pure** `buildTracksHtml()` —
same contract and rationale as `custom-playlist-inspector.mjs` (no DOM, no Drawflow, no Foundry;
testable in isolation).

```js
/**
 * @param {object} params
 * @param {Array<{id, name, uuid, usedBy: number}>} params.sounds
 * @param {(key: string, data?: object) => string} params.localize
 * @returns {string}
 */
export function buildTracksHtml({ sounds, localize })
```

Per row:

```html
<li class="game-orchestra-track-row" draggable="true" data-vg-drag
    data-drag-type="PlaylistSound" data-uuid="…" data-sound-id="…">
  <i class="fas fa-music"></i>
  <span class="game-orchestra-track-name" title="…">{name}</span>
  <span class="game-orchestra-track-used" title="…">×{usedBy}</span>   <!-- only when usedBy > 0 -->
  <button type="button" class="clear-btn" data-action="addTrackNode" data-sound-id="…"
          title="…"><i class="fas fa-plus"></i></button>
</li>
```

- `usedBy` = how many `track` nodes in the working graph reference that sound. Computed in
  `_prepareContext()`/`_renderTracks()` from `this.graph.nodes`. It answers "which of my tracks
  haven't I placed yet?", which is the single most common question in this window.
- Empty playlist → the existing `GameOrchestra.CustomEditor.Inspector.NoSounds` hint, reused verbatim.
- A one-line drag hint (`GameOrchestra.CustomEditor.Tracks.DragHint`) above the list.
- The `<ul>` gets `max-height: 220px; overflow-y: auto` so a 40-sound playlist can't push
  Properties off-screen.
- `addTrackNode` adds a `track` node at `_defaultNodePoint()` with `soundId` preset.
- Names are user data — `escapeHtml` everything (import it from `custom-playlist-node-render.mjs`,
  as the inspector does).

`_renderTracks()` mirrors `_renderInspector()` exactly: `querySelector('.game-orchestra-editor-tracks')`,
assign `innerHTML`, return early if absent.

### D8 — Drag-in from the sidebar

**Payload interpretation is a pure function.** New module `scripts/graph-drop.mjs`:

```js
/**
 * @param {{type: string, playlistId: string|null, soundId: string|null}} dropped -
 *   the resolved document, flattened by the caller (which does the async fromUuid()).
 * @param {{editedPlaylistId: string|null, soundIds: string[]}} context
 * @returns {{action: 'track', soundId: string}
 *          |{action: 'playlist', playlistId: string}
 *          |{action: 'reject', reasonKey: string}}
 */
export function resolveGraphDrop(dropped, context)
```

Locked rules:

| dropped | condition | result |
|---|---|---|
| `PlaylistSound` | its parent playlist **is** the one being edited | `track` node, `soundId` set |
| `PlaylistSound` | parent is a **different** playlist | `reject`, `…Drop.ForeignSound` |
| `Playlist` | id ≠ the playlist being edited | `playlist` node, `playlistRef {source:'direct', playlistId}` |
| `Playlist` | id **is** the playlist being edited | `reject`, `…Drop.SelfPlaylist` |
| anything else / unparseable | — | `reject`, `…Drop.Unsupported` |

A foreign sound is **rejected, not substituted**. A Playlist node plays a whole playlist by its
own rules; silently turning "this one song" into "that entire playlist" would be a different
thing than the user asked for. `Track` nodes can only reference sounds inside the edited playlist
(`Validation.TrackMissingSound` exists for exactly that reason). The rejection toast says why.

Editor side:

```js
static DEFAULT_OPTIONS = { …, dragDrop: [{
  dragSelector: '[data-vg-drag]',
  dropSelector: '.game-orchestra-drawflow-canvas',
  permissions: { dragstart: true, drop: true },
  callbacks: {}
}] };
```

- `_setupDragDrop()` — copy `playlist-tree.mjs`'s verbatim (fresh config object per call; never
  mutate the shared `DEFAULT_OPTIONS.dragDrop`), called from `_onRender()` **outside** the
  `_changeListenerBound` guard (HR-D).
- `_onDragStartInternal(event)` — for Tracks-pane rows: writes
  `event.dataTransfer.setData('text/plain', JSON.stringify({type: 'PlaylistSound', uuid}))`, i.e.
  **the exact shape Foundry's sidebar produces**, so internal and external drags collapse onto
  one drop path.
- `_onDragOverExternal(event)` — `event.preventDefault()` (without it the drop never fires) and
  add `.drop-hover` to the canvas wrapper.
- `_onDragLeaveExternal` / drop — remove `.drop-hover`.
- `_onDropExternal(event)`:
  1. `preventDefault()`, clear `.drop-hover`.
  2. **Capture `event.clientX/clientY` and the drop point synchronously, before any `await`** —
     the event object is not reliable after one.
  3. Parse `text/plain` as JSON inside `try/catch`; a non-Foundry drag (an OS file) is a silent
     no-op, not an error toast.
  4. `await fromUuid(data.uuid)`; flatten to `{type, playlistId, soundId}`.
  5. **`if (!this._drawflow) return;`** — the window may have closed during the await.
  6. `resolveGraphDrop(...)`; on `reject`, `ui.notifications.warn(localize(reasonKey))` and stop.
  7. Otherwise create the node at the drop point via the same code path `handleAddNode` uses
     (extract a shared `_addNodeOfType(type, dataOverrides, point)` — do not duplicate the
     `NODE_DEFAULTS` + label + `addNode` + sync + refresh sequence).
  8. `_renderInspector()` (which now also refreshes tracks and validation). Do **not**
     auto-select the new node: selection would expand Properties (D2) and pull the panel away
     from Tracks mid-flow when dropping several sounds in a row.

**Drop point → canvas coordinates.** Measure against Drawflow's `precanvas`, whose bounding rect
already includes both the pan translate and the zoom scale, so only the scale has to be divided
out:

```js
_pointFromEvent(event) {
  const rect = this._drawflow?.precanvas?.getBoundingClientRect?.();
  const zoom = this._drawflow?.zoom || 1;
  if (!rect) return this._defaultNodePoint();
  return { x: (event.clientX - rect.left) / zoom - 70,   // ~half a default node
           y: (event.clientY - rect.top) / zoom - 40 };
}
```

### D9 — CSS additions (summary)

- `.game-orchestra-editor-panel`: `flex: 0 0 300px; display: flex; flex-direction: column; gap: 6px;
  min-height: 0;` (the `min-height: 0` matters — without it the flex child refuses to shrink and
  the panel's scroll never engages).
- `.game-orchestra-pane`: bordered, radius 4. `.game-orchestra-pane-header`: full-width button, left-aligned,
  `background: none`, caret rotates 90° when `.collapsed`. `.game-orchestra-pane-body`: `padding: 8px`.
- The accordion stack scrolls (`overflow-y: auto; flex: 1 1 auto`); the validation region below
  it does not (`flex: 0 0 auto`) so errors stay pinned.
- `.game-orchestra-editor-body` keeps its `min-height: 420px`; `.game-orchestra-canvas-wrapper` keeps
  `min-width: 400px`. `300 + 400 + gap < 960` (the window's default width), so nothing is
  squeezed at the default size.
- `.game-orchestra-drawflow-canvas.drop-hover`: 2px dashed accent inset outline + a faint tint. Must be
  `outline`/`box-shadow`, **not** `border` — a border would change the container's client box
  and with it Drawflow's drag math.
- Delete `.game-orchestra-editor-palette`; `.game-orchestra-editor-inspector`'s `flex/border/padding` move to
  `.game-orchestra-pane-body`, and the class keeps only what `_renderInspector()` needs to find it.

### D10 — New i18n keys (add to **both** `lang/en.json` and `lang/pt-BR.json`)

`tests/lang.test.mjs` enforces exact key parity; a missing pt-BR key fails the suite.

```
GameOrchestra.CustomEditor.Pane.Palette          "Add Element"
GameOrchestra.CustomEditor.Pane.Properties       "Properties"
GameOrchestra.CustomEditor.Pane.Tracks           "Tracks"
GameOrchestra.CustomEditor.Tracks.DragHint       "Drag a track onto the canvas to add it, or use +."
GameOrchestra.CustomEditor.Tracks.Used           "Used by {count} node(s) in this graph"
GameOrchestra.CustomEditor.Tracks.AddNode        "Add a Track node for this sound"
GameOrchestra.CustomEditor.Drop.ForeignSound     "A Track node can only play a sound from this playlist. Drag the other playlist itself to add a Playlist node instead."
GameOrchestra.CustomEditor.Drop.SelfPlaylist     "A playlist can't reference itself."
GameOrchestra.CustomEditor.Drop.Unsupported      "Only playlists and playlist tracks can be dropped here."
```

---

## 2. Files touched

| file | change |
|---|---|
| `templates/custom-playlist-editor.hbs` | palette strip → accordion panel; panel before canvas |
| `scripts/custom-playlist-editor.mjs` | `togglePane`/`addTrackNode` actions, `_renderTracks`, `_renderValidation`, `_addNodeOfType`, `_defaultNodePoint`, `_pointFromEvent`, drag/drop block, `NODE_PALETTE` icons |
| `scripts/custom-playlist-inspector.mjs` | split out `buildValidationHtml`; drop `validation` from `buildInspectorHtml` |
| `scripts/custom-playlist-node-render.mjs` | export `NODE_ICONS` |
| `scripts/custom-playlist-tracks.mjs` | **new** — `buildTracksHtml` |
| `scripts/graph-drop.mjs` | **new** — `resolveGraphDrop` |
| `styles/game-orchestra.css` | `:root` shape vars, canvas literals → `var()`, panel/pane/swatch/track/drop-hover blocks |
| `lang/en.json`, `lang/pt-BR.json` | D10 keys |

## 3. Tests

- **update** `tests/custom-playlist-editor-template.test.mjs` — three `[data-pane]` sections in
  order; `.game-orchestra-editor-inspector` still present as an `innerHTML` target; `.game-orchestra-editor-tracks`
  and `.game-orchestra-editor-validation` present, validation **outside** every `.game-orchestra-pane`; the
  existing bare-`[data-drawflow-mount]` guard still passes; panel precedes canvas in source order.
- **update** `tests/custom-playlist-inspector.test.mjs` — `buildInspectorHtml` no longer emits
  `.game-orchestra-validation-errors`; new cases for `buildValidationHtml` (moved from the old ones).
- **new** `tests/custom-playlist-tracks.test.mjs` — empty state; row per sound; `usedBy` badge
  shown only when > 0; HTML-escaping of a sound named `<img src=x onerror=…>`; drag attributes
  present.
- **new** `tests/graph-drop.test.mjs` — the full D8 rule matrix, including unparseable/unknown
  types and both self-reference cases.
- **new** `tests/custom-playlist-panel.test.mjs` — `_togglePane` flips `.collapsed` and
  `aria-expanded` on that pane only; selecting a node expands `properties` but never collapses
  anything; `resolveGraphDrop` → node creation calls `addNode` with the drop point (mock
  Drawflow, as `tests/custom-playlist-editor.test.mjs` already does).
- Run the whole suite — `tests/lang.test.mjs` and `tests/module-manifest.test.mjs` are the two
  that fail loudest on an incomplete job.

## 4. Manual verification (Foundry, GM client)

1. Open a playlist's graph editor: panel on the left, Properties + Tracks open, Add Element
   collapsed; canvas unchanged in look.
2. Expand Add Element — 8 buttons, each showing its type's real silhouette; click each, one at a
   time: nodes appear near the viewport centre, cascaded, not stacked.
3. Drag a node around. **This is the regression that matters** — if dragging is dead, something
   is calling `this.render()` (HR-A).
4. Select a node → Properties expands if collapsed; Tracks stays open.
5. Make a graph invalid (Track with no sound) → the error is visible in the pinned region with
   Properties **collapsed**, and the canvas badge is still on the node.
6. Drag a sound from this playlist out of the sidebar onto the canvas → a Track node appears
   under the cursor with that sound already selected; zoom out, pan, drop again → still lands
   under the cursor.
7. Drag a *different* playlist in → Playlist node, direct reference set. Drag **this** playlist
   in → warning toast, nothing created. Drag a sound from another playlist → warning toast.
8. Drag a row out of the Tracks pane onto the canvas → same as (6). Its `×n` badge increments.
9. Drop something onto the canvas and immediately close the window mid-drop → no console error.
10. Save, reopen, confirm the graph round-trips.

---

## 5. Deliberately **not** in scope

Listed so they aren't quietly added, and so they're easy to ask for later:

- Dragging node types **out of the palette** onto the canvas (as opposed to clicking them). The
  drop plumbing above would support it in a few lines — `data-vg-drag` on the palette buttons and
  a `{'game-orchestra': 'node', type}` payload branch — but it is beyond the stated request.
- Reordering / resizing panes, or persisting pane state across sessions.
- Any change to node behaviour, the engine, validation rules, or the graph schema.
