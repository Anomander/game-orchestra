# The graph editor

`CustomPlaylistEditor` — an ApplicationV2 window wrapping a vendored **Drawflow** canvas, for
building a playlist's `customPlayback` graph visually.

This is the most hazard-dense file in the module. Read [invariants.md](invariants.md) § *House
rules* (HR-A…HR-D, and HR-K on decorating ports and wires) before changing anything here.

Class composition:

```js
EditorSelectionMixin(EditorHighlightMixin(HandlebarsApplicationMixin(ApplicationV2)))
```

The two mixins are pure extractions — every method still runs with `this` bound to the live
editor instance and reads the same instance fields. They exist only to keep the main file's
already-large DOM/Drawflow surface from growing further. **Field ownership stays in
`CustomPlaylistEditor`'s own constructor**, not in the mixins.

---

## The one rule — HR-A

**Never call `this.render()` after the initial mount.**

Drawflow's `nodeSelected` fires synchronously inside its own mousedown handler, *before* it sets
up the drag. A full ApplicationV2 re-render at that moment detaches the live canvas and the drag
is orphaned on a detached DOM tree.

Symptom: **nodes select, but silently never move. No console error.**

Instead, three sibling containers are updated by direct `innerHTML` assignment:

| Method | Container | Built by |
|---|---|---|
| `_renderInspector()` | `.game-orchestra-editor-inspector` | `custom-playlist-inspector.mjs` |
| `_renderTracks()` | `.game-orchestra-editor-tracks` | `playlist-mixer-render.mjs`, via `MixerController` |
| `_renderValidation()` | validation region | `custom-playlist-inspector.mjs` |

All three builders are **pure functions returning HTML strings** — no DOM, no Drawflow, no
Foundry — so they are unit-testable in isolation. That is the whole reason they exist as separate
modules rather than Handlebars partials.

Node *content* on the canvas is likewise refreshed by plain DOM manipulation
(`#node-<id> .drawflow_content_node`, replace `innerHTML`) rather than Drawflow's `df-*`
live-binding attributes — that binding only writes to a bound element's `.value`, which has no
visual effect on anything but actual form controls, not the plain `<div>`/`<span>` a read-only
summary line needs.

---

## Window layout

A four-pane accordion panel on the **left**, canvas on the right, validation pinned below the
panel.

| Pane | Content | Rendered by |
|---|---|---|
| `palette` | 7 node chips + preset `<select>` | Handlebars, **static** |
| `properties` | The selected node's inspector | `_renderInspector()`, dynamic |
| `tracks` | The track list **and** the mixer: usage counts, drag-to-canvas, volume, mute/solo | `_renderTracks()`, dynamic |

The accordion is **single-open**, and the panel **stretches to the bottom of the window** with the
open pane claiming everything the collapsed headers leave. The two go together: the stretch only
has one pane to hand the leftover height to. This supersedes `docs/graph-editor-panel-plan.md` D2,
which specified independently collapsible panes.

Three CSS facts hold that up, and all three are load-bearing:

- `.game-orchestra-pane-stack` is `overflow: hidden`, **not** `auto`. If the stack could scroll, the open
  pane would grow to its content's natural height and push the collapsed headers off the bottom
  instead of scrolling inside itself.
- `.game-orchestra-pane:not(.game-orchestra-collapsed)` is `flex: 1 1 auto; min-height: 0`. Without `min-height:
  0` a flex child floors at its content height and overflows rather than shrinking.
- `.game-orchestra-pane-body` is the **only** scroll container in the stack. **Nothing inside a pane body
  may set its own `max-height` + `overflow`.** `.game-orchestra-track-list` did (220px, from when the
  pane sized to its content) and it stranded the track list at 220px inside a much taller pane
  with dead space below — reported live. Let the body do the scrolling.

Clicking the open pane's own header closes it, leaving none open. That is deliberate — it hands
the whole column to the pinned validation region when a graph has a long list of issues.

Exactly one `<section>` in the template must start without `.game-orchestra-collapsed` (`properties`
does), and its `aria-expanded` must agree; `tests/custom-playlist-editor-template.test.mjs` checks
both. `_setPaneCollapsed()` reads the sibling list from the DOM (`querySelectorAll('.game-orchestra-pane')`)
rather than a hardcoded id list, so a pane added to the template joins the accordion automatically.

`nodeSelected` still auto-opens Properties, which now collapses whatever the user had open. That's
acceptable because it is driven by an explicit **click on a node**. Adding a node never selects it
(`_addNodeOfType`), so dragging track after track out of the Tracks pane leaves that pane open.

Validation sits **outside** the accordion stack (`flex: 0 0 auto`) so errors stay pinned and
visible.

The Tracks pane's `usedBy` count answers the single most common question in this window: *which
of my tracks haven't I placed yet?*

### The palette chips are node previews, and the second drag source

Each palette entry is a **miniature of the node it adds** — the same silhouette, the same accent
icon, the same neutral chrome, with the type name captioned underneath exactly where a node wears
its own. It carries **both gestures**: click to add at the canvas centre, or drag it onto the canvas
to place it where you drop it — including onto a *wire*, which splices it in (`_insertNodeOnEdge`),
the same as dropping a Tracks row there.

**The chip shares the canvas node's CSS rules; it does not copy them.** `.game-orchestra-node-swatch` is
joined into each per-type rule's selector list (accent, `clip-path`/`border-radius`, the Playlist
ring, Start/End's outline layer). A parallel set of shape rules would drift, and a palette that no
longer matches the canvas is worse than a palette of text buttons — it would be *wrong* rather than
merely plain. **Adding a node type means naming the swatch in that type's shape rules too.**

Three things about it are measured, not reasoned — rendered in both Chromium and Firefox:

- **It is a full-size node scaled by `transform`, not a small box.** Every proportion inside a node
  is in absolute px (border widths, the Playlist ring's two bands, each type's content padding), so
  a smaller box with those unchanged is a *different shape*: at 52px, Start's 40px content padding
  alone leaves negative room for the icon.
- **The swatch restates Drawflow's `width: 160px`.** That vendor rule needs the canvas ancestor, and
  it is what sizes any node declaring no width of its own (Track, Playlist). Without it the Playlist
  chip drew 140px against the real node's 160px.
- **The slot is fixed-size, clips, and centres by `translate`.** A transform scales what is
  *painted*, never the layout box — so the 160px box would otherwise push the grid columns out and
  spill horizontal scroll into `.game-orchestra-pane-body`. And an over-sized grid item is aligned to
  *start*, not centre (the alignment spec's overflow fallback), which visibly pushed the Playlist
  chip right of its own caption until a `translate(-50%, -50%)` replaced it.

The icon is the one deliberate departure from node proportions: at chip scale an em-sized glyph
lands at ~8.7px, and Fork/Random/Condition share one silhouette and are told apart by icon and
accent alone. The swatch's own `font-size` puts it back at ~13px, into interior space the node
spends on a detail line, a name and exit chips — none of which a chip has.

The chip is a `<button>`, so it keeps keyboard activation, and `draggable="true"` on a `<button>`
was verified to fire `dragstart` and round-trip its payload in **both Chromium and Firefox** (the
historically doubtful case). Its payload is `game-orchestra.PaletteNode` + a node type — deliberately
not a Foundry document type, since `_onDropExternal()` has to recognise it *before* the `fromUuid()`
lookup a Playlist/PlaylistSound takes. `data-node-type` is what tells the two drag sources apart in
`_onDragStartInternal()`; only the chip carries it.

### The Tracks pane is also the mixer

One pane does both jobs: the playlist's track list (drag a row onto the canvas, or press its `+`)
and its levels — the same mixer as the standalone window, sharing one `MixerController`
implementation (see [mixer.md](mixer.md)). They were two panes briefly and are one because they
answer questions about the *same rows* — *"which of these haven't I placed?"* and *"why is this one
so loud?"* — and in a single-open accordion, two panes meant switching back and forth to compare.

`custom-playlist-tracks.mjs` and its `buildTracksHtml()` are **gone**, superseded by the renderer's
`graphTools` flag. Keeping both would have meant two builders for one pane.

Four things make it fit here:

- **It renders through `_renderMixer()`, never `this.render()`.** The controller refreshes itself
  after a mute, a row selection, a settled slider — several times a minute in use. Routed through
  a full re-render, each one would detach the live Drawflow canvas mid-interaction (HR-A). This is
  exactly why the controller takes an `onRefresh` callback instead of calling `render()` itself.
- **Compact layout.** The panel is 300px. `buildMixerHtml`'s `compact` flag drops the fade and
  node/order columns and the header's number fields, and the CSS puts each row on two lines with
  the name on its own — measured at the real width, a single line collapsed every track name to
  `"Cave Dri…"`. The expand button in the pane's own header opens the full window, which has all
  of it.
- **Its keyboard shortcuts are off** (`keyboard: false`). Arrows, `M` and `S` belong to the canvas
  in this window; a pane quietly stealing them would be worse than not having them. A focused
  slider still takes arrow keys from the browser.

- **A press on one of a row's own controls suspends that row's draggability.** Reported live:
  grabbing a volume knob dragged the track onto the canvas instead of moving the slider. With
  `draggable="true"` on the row, the browser resolves a press-and-move to the nearest draggable
  *ancestor*, so the `<input type="range">` under the pointer never sees the gesture —
  `draggable="false"` on the input does not help, because the search walks up. The controller
  clears it on `mousedown` over an `input`/`button` and restores on `document` `mouseup`.
  Dragging by the row's name is untouched.
- **Its level edits are undoable.** Every settled change calls the controller's `onCommit`, which
  is wired to `_recordHistory()` — level changes are made in the same pane as graph edits, and a
  Ctrl+Z covering only half of that is worse than one covering none. See § *Undo / redo* below.

`.game-orchestra-mixer-compact .game-orchestra-mixer-rows` explicitly clears the `max-height`/`overflow` the
standalone window sets. **The pane body is the only scroll container in the stack** — a nested one
strands the list at that height inside a taller pane, which is exactly what `.game-orchestra-track-list`
did once and was reported live (see § *Window layout* above).

### A Track node's sound is set by dragging, never by a form field

The Properties pane shows it **read-only**. A Track node is placed *per sound* — drag a row out of
the Tracks pane, or use its `+` button. The editable `<select>` that used to live here made the two
routes disagree about what a Track node is (one graph position per sound, versus a slot you
repoint), and the Tracks pane's `usedBy` counts are built around the first reading.
`handleUpdateTrackSound` and its `updateTrackSound` change-action are gone, and must not come back.

**Changing a placed node's sound is a drag, not a field.** Dropping a Tracks row onto an existing
Track node repoints it in place, keeping its wires, position and name
(`_repointTrackNode()`). That does not reopen the question the read-only field settled: it is still
the drag route, the counts still recompute, and there is still no way to *invent* a Track node
without a sound. What it removes is the cost of a misdrag, which used to be a delete, a re-drag and
two rewires — for a mistake made with the very gesture that now fixes it.

**Which is why the palette has no Track button, and must not regain one.** Every other type can be
added from the palette; Track cannot, because a palette-created Track starts with `soundId: null`
and read-only is read-only — there would be no way, anywhere in this window, to ever give it a
sound. It could only sit on the canvas failing `TrackNoSound` until deleted. `NODE_DEFAULTS.track`
stays, since both sound-carrying routes still go through `_addNodeOfType('track', { soundId })`.

### The Tracks rows (and the palette chips) are drag sources, and must be rebound

`_renderTracks()` calls `_setupDragDrop()` after writing its `innerHTML`. This is not optional and
not defensive: **confirmed live**, dragging a track onto the canvas worked exactly once and then
silently stopped, with no console error.

Foundry's `DragDrop#bind()` is not delegated — it walks `dragSelector` once, at call time, and
assigns `element.ondragstart` on the rows it finds right then. `_renderTracks()` replaces every one
of those rows, so the handlers go with them, and it reruns on every selection change, node add, and
label edit. `_onRender()`'s own `_setupDragDrop()` call fires once per window and cannot cover it.

Rebinding is safe to repeat because `bind()` **assigns** the `on*` properties rather than
`addEventListener`-ing them (checked against the installed client source), so the canvas's drop
handlers are overwritten, not stacked. A stacked drop binding would create one node per
accumulated bind.

---

## The canvas `+` — adding an exit without the Properties pane

Every node type in `EXPANDABLE_EXIT_NODE_TYPES` (`fork`, `random`, `condition`) carries a small `+`
at its **top-left** corner, appended by `_refreshExitAdder()` from inside `_refreshNodeDisplay()`.
It dispatches the same `addExit` action the inspector's own button does, so both routes run
`handleAddExit` — there is no parallel implementation.

Three things hold it up, and all three are the reason it works at all.

**It is a child of the node element, a sibling of `.drawflow_content_node` — never inside it.**
Drawflow's mousedown re-targets anything inside the content up to the node itself
(`ele_selected = e.target.closest('.drawflow_content_node').parentElement`, read out of the vendored
source) and then matches `classList[0] === 'drawflow-node'`, which fires `nodeSelected` and sets
`drag = true`. `nodeSelected` auto-opens the Properties pane — precisely what this button exists to
avoid — and the drag would move the node under a click meant for a button. Outside the content,
`ele_selected` stays the button and its class matches **none** of Drawflow's cases (`drawflow-node`,
`output`, `parent-drawflow`, `drawflow`, `main-path`), so the switch falls through. This is the same
mechanism the issue badge already relies on, and it means **`game-orchestra-node-add-exit` must be the
element's first class** — the same positional-`classList` hazard as HR-B, now on a second element.

**Top-left, not on the exit side.** Both expandable shapes grow away from their fixed top-left
origin — Fork/Random 26px taller per exit (`BAR_HEIGHT_PER_EXIT_PX`), Condition 52px wider
(`CONDITION_WIDTH_PER_BRANCH_PX`) — so a button anchored near the ports walks out from under the
cursor after one click, and a Condition's branch ports redistribute across the whole bottom edge on
every add regardless. Adding three exits is three clicks with no pointer travel only if the anchor
cannot move. Rendered and measured at three node sizes (64×64, 64×116, 202×84): the button's centre
sits at exactly (+2, +2) from the node's top-left in all three, overlapping no port and not the
issue badge, which owns the opposite corner. Left = add, right = problems.

**Tucked at rest, revealed on `.drawflow-node:hover`** (plus `:focus-visible`), like the ports —
a permanently visible glyph on every branching node fights the shape+icon canvas. `pointer-events`
moves with the opacity: unlike a port there is never a reason to aim at it while invisible, so an
idle button would only be a stray click target. Verified by hit-test — hovered, the topmost element
at its centre is the button and `closest('[data-action]')` resolves to `addExit`; idle, the point
falls through to `.game-orchestra-node-content`. Hidden entirely at `[data-zoom-tier='compact']`, where an
18px control renders as a speck.

It is **achromatic** (`#ddd` on `#2b2b2b`), not the conventional green: hue on this canvas means
state, and a coloured `+` would read as a fifth state channel competing with the four that exist.

Two consequences worth knowing. Because it lives outside the content, it **survives**
`_refreshNodeDisplay()`'s wholesale `innerHTML` replacement — unlike the drain overlay, which has to
be re-armed. And `_groupDragTarget()` has to exclude it (and the issue badge): both sit inside
`.drawflow-node`, and that check runs *before* `_isBackgroundTarget()` in `_onCanvasMouseDown`, so
without the exclusion a press on either while a marquee selection is live drags the whole selection
instead.

`EXPANDABLE_EXIT_NODE_TYPES` is exported from `custom-playlist-node-render.mjs` for the same reason
`DRAIN_NODE_TYPES` is: three call sites need that exact answer — the detail line, the port-count
override in `_refreshNodeDisplay()`, and this button — and they used to be three hardcoded lists.
A fourth expandable type is now a one-line change. If one ever needs a **cap** on its exits, the Set
becomes a Map to a predicate and the `+` gains a disabled state.

---

## Drawflow integration

Drawflow is **vendored**, not an npm dependency at runtime: `scripts/vendor/drawflow.min.js` is a
UMD build loaded as a **classic script** via `module.json` `scripts`. Importing it as an ES module
would leave the global `Drawflow` undefined. `tests/module-manifest.test.mjs` guards this, and the
CSS load order (HR-C).

### Things Drawflow will not let you do

| Limitation | Workaround |
|---|---|
| Connections carry no data (H5) | Exit metadata on the node in `data.exits[]`, parallel to output ports |
| Ports renumber contiguously on removal | Splice `data.exits[]` in lockstep — always |
| Reads `classList[0]` off its mount | `[data-drawflow-mount]` stays class-free (HR-B); bind to the wrapper |
| No self-loop concept | Parse Drawflow's own `d` attribute, replace only the curve shape |
| Curves are horizontal at both ends, at any port | Re-route every path along the port's own normal (`buildRoutedPath`) |
| `nodeSelected` fires mid-mousedown | Never re-render (HR-A) |
| Recomputes `nodeId` as max **numeric** id + 1 | Builder-generated graphs use numeric string ids |

**Self-loops.** Drawflow's default bezier for a node connected to itself cuts straight through the
node's own body, and there is no supported way to influence it — its reroute-point feature is only
reachable via a live double-click gesture, not a programmatic API. `custom-playlist-connection-render.mjs`
lets Drawflow compute the connection normally (so endpoints stay correct across zoom/pan, which
apply as a CSS transform on the whole canvas), then parses the **known-correct** endpoints back
out of the `d` attribute and replaces only the curve's *shape* with a wide clearing arc. Drawflow's
endpoint math is never touched.

**Wire routing.** `createCurvature()` always places both bezier handles horizontally, whatever edge
the port sits on, with an uncapped handle length of 0.5 × the *horizontal* gap. Two consequences:
a Condition's exits (bottom edge) and fallback (top edge) sent their wires off sideways — that was
the original motivation, and Condition has since moved to the right-edge stack — and two
vertically-stacked nodes — near-zero horizontal gap — got a straight diagonal while distant nodes
bowed enormously. `buildRoutedPath()` replaces the curve with **stub → cubic → stub**: a short
straight run along each port's outward normal, joined by a bezier whose handles continue along
those same normals (so the joins are smooth).

Handle length is what controls how *tight* the turns are, and the relationship is inverted from
what it looks like — a **short** handle produces a hard turn, because the whole direction change
gets crammed into a small radius near the port. Length is computed per end from that end's own
normal, splitting the span into an along-normal component (×0.65) and a perpendicular one (×0.45);
plain straight-line distance over-reaches when the target is off to one side.

Those two ratios (plus the 36px floor and 280px cap) are a **look**, and they were raised from
0.5/0.35/28/240 to make wires visibly rounder. Two things fall out of that and are easy to get
wrong. Longer handles alone make the tightest turn on the canvas *worse*: past roughly these values
the two control points reach past each other and the curve folds into an S with a hard middle, a
forward wire with a slight drop going first. And the backward swing below has to rise with them —
at the old 0.45 the tightest turn across the measured geometries fell from 21px to 11px; at 0.6 it
is back to 18px while every wire bows about a quarter more. **Raise one, re-check the other**, and
re-run both measures in the test file (minimum turn radius *and* maximum bow — the radius floor
alone is satisfied by a dead-straight line).

Per end matters: the two ends can disagree about which way the wire is going. A Condition's
downward exit reaching a node below-but-left is forward to the exit and backward to the
left-facing input. When an end faces *backward*, no handle length avoids a cusp — the wire has to
reverse — so both control points also get a perpendicular **swing** that separates the lobes into a
smooth U. `tests/custom-playlist-connection-render.test.mjs` measures the minimum radius of
curvature across nine geometries rather than eyeballing the `d` string; three of them used to be
literal cusps (radius 0).

> **Condition no longer has vertical ports.** Its branch exits moved to the right-edge stack (see
> [node-anatomy.md](node-anatomy.md) § R7), taking `_outputPortDirection()` and
> `_layoutConditionPorts()` with them — `_routeConnections()` now passes `startDir: 'right'` for
> every edge, and inputs are on the left edge for every node type as they always were. The `'up'`/
> `'down'` machinery below is still implemented and still directly tested; nothing currently asks
> for it. A future node type that wants a vertical port only has to pass the direction at that one
> call site.

Routing must be reapplied after **anything** that makes Drawflow redraw a path — that is what
`_restyleNodeWires()` exists for, pairing the routing with the self-loop arc so neither is
forgotten. The call sites: `updateConnectionNodes()` in `_refreshNodeDisplay`, `nodeMoved`, every
frame of a Drawflow drag (via its `mouseMove` event), every frame of a group drag
(`editor-selection-mixin.mjs`), and **both endpoints** of a created/removed connection.

That last one is the subtle case. Completing a connection makes Drawflow call
`updateConnectionNodes()` for the source **and** the target, and each of those redraws every wire
touching that node in *either* direction — not just the wire that changed. Restyling only
`info.output_id` therefore left the target's other wires on Drawflow's default curve, which showed
up as connecting one wire silently re-orienting an unrelated one, fixed only by dragging the node.
Miss any of these and wires flip back to Drawflow's own shape until the next refresh. `parsePathEndpoints()` is format-agnostic — it takes the
first and last coordinate pair — precisely so a second routing pass over an already-routed path is
stable rather than silently failing to parse.

**Numeric ids.** Drawflow's `load()` recomputes its `nodeId` counter as (max numeric node id + 1)
after an import. A graph with non-numeric ids — like `createEmptyGraph()`'s `'start'` — leaves the
counter at 1, so a node added right after an import can be handed an id that **already exists**.
`graph-builder.mjs` enforces numeric ids for every programmatically-built graph.

**Edge order is port assignment.** `graphToDrawflowExport()` maps a node's i-th edge to
`output_${i+1}` and folds exit metadata into `data.exits[]` by that same index. The order edges
are declared in *is* the port assignment.

> The Drawflow export shape (`id`/`name`/`data`/`class`/`html`/`typenode`/`inputs`/`outputs`/
> `pos_x`/`pos_y`, with `outputs.output_N.connections[].{node,output}` and the mirrored inputs
> side) was confirmed by **running the vendored library against a headless DOM and inspecting a
> real `export()` result** — not from documentation.

---

## Event binding

`_onRender` binds a deliberately mixed set of listeners. Each placement is a decision:

| Listener | Bound on | Why there |
|---|---|---|
| `change` | `this.element` | Delegated; once |
| `keydown` | **`document`** | Clicking a Drawflow node doesn't move focus into this window (nothing in it is focusable), so an element-scoped listener would never fire. `_onKeyDown` checks focus isn't in a text field before acting. |
| `mousedown` | `this.element`, **capture** | Must run and `stopPropagation()` *before* Drawflow's own bubble-phase handler (bound directly on the canvas container) sees a left-button background click |
| `mouseover` / `mouseleave` | `this.element` | `mouseover`, not `mouseenter`, so one delegated listener covers rows re-rendered later |
| `dragleave` | `this.element` | `DragDrop` only wires `dragover`/`drop`/`dragstart` — it has no dragleave concept |
| `gameOrchestraGraphActivity` | Foundry hook | Live playback highlight |
| DragDrop | `_setupDragDrop()` | **Unguarded, every render** (HR-D) |

The activity hook is **primed immediately** from
`musicController.getGraphActivity(this.playlist)`, so a window opened mid-playback isn't blank
until the next transition — which, for a long track, could be minutes away.

`_onClose` tears down every one of these, plus any in-progress rect-select or group drag (the
window can close mid-drag).

---

## Selection and dragging — `editor-selection-mixin.mjs`

- **Left-drag on empty canvas** → marquee rect-select. Drawflow's own left-drag pan is preempted
  via the capture-phase mousedown above.
- **Right-drag** → left alone, so Drawflow's native pan still works unmodified.
- `_multiSelectedNodeIds` (marquee) is **distinct** from `selectedNodeId` / Drawflow's own
  single-node selection. The two never mix.
- Group drag moves every marquee-selected node together.
- `_isBackgroundTarget()` mirrors the classification Drawflow's own `click()` does internally to
  decide "background click" — node, port (`.input`/`.output`), and connection (`.main-path`)
  targets are all excluded.

Copy/paste (`_copySelection` / `_pasteClipboard`) round-trips through the same Drawflow data
shape, recomputing output counts per pasted entry.

A paste ends by selecting what it just created, via `_selectNodes()` — one node goes through
`_selectSingleNode()` (so it behaves exactly like clicking it, inspector included), several become
a marquee selection. This respects the same never-mix rule as everything else here: a one-node
paste is a single selection, never a one-element marquee. The clipboard is untouched, so pasting
twice pastes the *originals* twice, each paste further offset and leaving only the newest
selected.

### Delete has to be split between Drawflow and us

Drawflow's own key handler removes **only `this.node_selected`** — the single node it considers
selected. A marquee selection is entirely this module's concept and deliberately leaves
`node_selected` null, so Delete with several nodes rect-selected removed nothing at all (reported
live). `_onKeyDown` now handles Delete/Backspace, but **only when `_multiSelectedNodeIds` is
non-empty** — a single Drawflow selection stays Drawflow's job, and the two never overlap because
selecting a single node clears the marquee.

`_deleteMultiSelection()` calls `removeNodeId('node-<n>')` — the **DOM id, not the bare numeric
id**, the same form Drawflow passes itself from `node_selected.id`. Passing the number removes
nothing, silently. Start is skipped with a notification rather than deleted, matching
`_copySelection`.

---

## Undo / redo — `graph-history.mjs`

Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y), plus two toolbar buttons left of the zoom controls. The
history is **per window**: seeded at the end of `_mountDrawflow()`, unbounded, and discarded when
the window closes. It is deliberately **independent of Save** — Save writes the flag and leaves the
history alone, so you can undo past a save and save again.

### Levels are part of a snapshot, and undoing them writes to the world

`snapshotKey()` includes `levels` — the pane's mixer half: each sound's `volume` and `fade`, the
playlist's own `fade`, and the `game-orchestra.mix` flag.

This is the **one part of an undo that touches the database.** Everything else a snapshot holds is
unsaved working state that only reaches the playlist on Save; levels are persisted the moment they
change, so putting them back means writing them back (`_restoreLevels()`, which diffs first — an
undo of a pure graph edit costs no round-trips). It is asynchronous and deliberately not awaited:
the canvas half of a restore is synchronous, and the pane re-renders from the resulting
document-update hooks, the same path an external change takes.

Two consequences worth knowing. `_captureLevels()` reads the **live documents**, which is safe even
mid-debounce because the mixer applies every change locally through `updateSource` before
scheduling the write — the value is already there when the commit fires. And the mix flag is
restored by `unsetFlag` **then** `setFlag`, never `setFlag` alone: a flag write is a recursive
merge, so writing a smaller object over a larger one leaves the extra keys behind (the same hazard
[mixer.md](mixer.md) documents for `muted`).

A snapshot history has one honest limitation here: a level changed in the *standalone* window
while the editor is open is captured into the editor's next snapshot, so undoing far enough
reverts it too. That is inherent to snapshots, not specific to levels.

### Snapshots, not commands

Each entry is a full `editor.export()` plus the graph-level `crossfadeMs` and the selection.
Inverse operations were rejected because Drawflow owns the authoritative state and does things to
it an inverse op would have to reimplement by hand: renumbering output ports contiguously on
removal (H5), dropping every connection touching a removed node, recomputing its `nodeId` counter.
`import()` restores all of that exactly. A graph is tens of nodes; a snapshot is cheap.

`_restoreSnapshot()` is mechanically **the same import path as `handleApplyPreset`**, for the same
reasons — `import()` calls `clear()`, which wipes the canvas element's entire `innerHTML`, so every
node element and connection SVG is destroyed and rebuilt, every dangling reference has to be
dropped, and none of the events this editor resyncs on are dispatched. It leaves `canvas_x`/
`canvas_y`/zoom alone (`import()` never touches them), so an undo doesn't also throw away where you
were looking.

### One recording site: `_syncFromDrawflow()`

Every mutation route in this window already ends there — `_addNodeOfType`, `_patchNodeData`
(so every inspector field), paste, group drag, and Drawflow's own `nodeMoved` / `nodeRemoved` /
`connectionCreated` / `connectionRemoved`. Recording at that one choke point rather than at each
site is what stops a mutation path added later from silently not being undoable.

The read-only callers (`handleSave`, `handleApplyPreset`'s destructive-change check) cost nothing:
`snapshotKey()` excludes the selection, so an unchanged state dedups against the present one and
creates no step. A future **graph-level** field — one that never touches Drawflow, as the crossfade
did before it moved to the mixer — would have to call `_recordHistory()` itself, and be carried by
hand in `_syncFromDrawflow()`.

> **The crossfade field is gone from this window.** It moved to the mixer, which owns every
> level-shaping setting and — unlike this one — opens for every playlist type. With it went
> `handleUpdateGraphCrossfade`'s manual `_recordHistory()` call and `_syncCrossfadeInput()`, both
> of which existed only because that one field never touched Drawflow.
>
> `_syncFromDrawflow()` still carries `graph.crossfadeMs` across, and snapshots still record it:
> a graph saved before the move still holds the value, the engine still reads it as the middle
> link of its chain (see [mixer.md](mixer.md)), and dropping it on a resync or an undo would be a
> silent data loss with no field left in this window to type it back into.

### One gesture is one step

`_recordHistory()` defers its capture to a **microtask**, because one gesture routinely produces
several mutations that each resync: a marquee delete removes N nodes one at a time (each firing
`nodeRemoved`), a paste adds N, and adding a Condition exit is remove + add + patch. Captured
inline, a single Delete would need N presses of Ctrl+Z to come back. Everything synchronous shares
one microtask, which also means the recording is insensitive to where in a handler it sits.

`_historySuspended` guards the restore itself, so the resyncs it performs don't record as new edits.

### Selection rides along but is not part of the state

Selecting a node is not an edit and must never cost a step, so `snapshotKey()` ignores the
selection. A snapshot still carries one, so stepping back restores what was selected — and
`updatePresentSelection()`, called just before every push, refreshes the *outgoing* state's
selection from the live one. Without it, clicking a node between two edits (which records nothing)
would leave an undo stepping back into a snapshot that deselects for reasons the user can't see.
`_restoreSnapshotSelection()` drops ids the restored graph no longer contains and respects the
never-mix rule: one node is a single selection, several are a marquee.

### Ctrl+Z has to be `stopPropagation`'d

Foundry's `KeyboardManager` listens on **window** and ignores `defaultPrevented` entirely, and core
registers Ctrl+Z as an uneditable `undo` binding that calls `canvas.activeLayer.undoHistory()` —
quietly reverting the GM's last placeable edit on the scene behind this window. `_onKeyDown` is
bound on `document`, below window, so `event.stopPropagation()` is what keeps an undo in here from
also being an undo out there. `preventDefault()` alone does nothing about it.

> The same is true of this window's Ctrl+C / Ctrl+V, which currently only `preventDefault()` and so
> still reach core's `copy`/`paste` bindings. Pre-existing, and left alone here.

---

## Live playback highlight — `editor-highlight-mixin.mjs`

Driven by the `gameOrchestraGraphActivity` hook. `graph-activity-highlight.mjs` turns a payload into
node/edge sets (pure, testable). Two categories, because durational and instantaneous nodes behave
very differently in time:

- **Active** — Track/Delay/Playlist nodes actually holding a token, plus (when unambiguous) the
  single exit they will leave by. Held until the engine says otherwise.
- **Pulse** — Start/Fork/Random/Condition/End nodes and just-followed edges, flashed for
  `ACTIVITY_PULSE_MS` (700 ms). A token crosses these in well under a millisecond, so without a
  short-lived highlight the traversal would be invisible and the highlight would appear to
  teleport between tracks.

### Drain overlays — the two nodes whose duration is known

Delay **and** Track nodes carry a drain: an overlay that starts full and empties over the time the
engine says that node holds its token for. A Delay empties downward over its wait; a Track sweeps
left to right over **one pass** of its sound, restarting on every loop.

`buildNodeInnerHtml()` emits the two-element overlay for exactly the types in `DRAIN_NODE_TYPES`
(outer clips to the node's shape, inner is the animated level). Everything below it is driven by
`activeTimings`, and three details in that payload are load-bearing:

| Field | Why |
|---|---|
| `startedAt` | Not a remaining duration — that is what lets a window opened mid-wait, or three loops into a track, pick the drain up where it actually is instead of restarting it from full. |
| `durationMs` | **One** pass, never the total. The editor restarts the sweep per iteration; a total would drain N times too slowly. |
| `iterations` | `null` = repeat indefinitely (a `forever`/`until` Track), a number = stop after that many, **absent** = one run (every Delay). `??` is wrong here — null and undefined mean different things. |

A drain also has to be **re-armed whenever the node's content is rebuilt**. `_refreshNodeDisplay()`
replaces `.drawflow_content_node` wholesale, overlay included, so without this any inspector edit
on a playing node blanks its fill until the engine's next broadcast — a whole track away.
It re-applies from the timing already held in `_activityHighlight`, which carries `startedAt`, so
the drain resumes where it is rather than restarting.

`computeHighlight()` tags each timing with its node's **type**, and `_setNodeDrain()` writes the
matching keyframes name inline. Leaving the name to a per-type CSS rule and toggling only the
inline duration does not work: the CSS-named animation would sit on the element already finished
at 0s, with a start time fixed at the moment the node was drawn, so re-arming it later resumes
that stale timeline and the negative delay lands somewhere meaningless.

On the engine side, `_recordTrackTiming()` runs its **own** duration probe under its own clock key
— see [graph-engine.md](graph-engine.md). Two of the three loop modes never probe otherwise, and
`EngineClock` keys replace rather than stack.

Payloads for other playlists are filtered out on `payload.playlistId`. This is also why child
engines emit with their **own** playlist id: an editor open on a nested playlist lights up for
free, with no extra plumbing.

**The highlight only appears on the head GM's client** — the engine runs nowhere else and nothing
crosses a socket. The editor says so in its own UI.

---

## Validation — `graph-validation.mjs`

Pure, Foundry-free, and emits **i18n keys plus optional `messageData`**, never localized strings.
The render boundary localizes.

An issue carries `{ nodeId, nodeLabel, messageKey, messageData? }`. The `nodeLabel` matters:
*"This node is not reachable from Start"* is useless on a crowded canvas without saying **which**
node. Issues that name a node are **clickable and pan the canvas to it** (`handleFocusNode`) —
being told a node has a problem isn't much help if it's off-screen.

An issue about a **relationship between nodes** rather than one node's own settings carries two
more fields: `nodeIds[]` and `edgeIds[]`. `InstantaneousCycle` is the only one today.

- `nodeId` is the first of `nodeIds`, so click-to-focus still has one place to jump to.
- `_refreshIssueBadges()` badges **every** node in `nodeIds` — marking only the anchor would leave
  the rest of the loop looking innocent.
- `_refreshIssueEdges()` paints every connection in `edgeIds` with `[data-go-edge-issue]` (red,
  thicker and dashed — width survives being zoomed out past where hue resolves). It repaints from
  scratch each pass rather than diffing like the activity highlight, because validation is a
  whole-graph property: one rewire can move the cycle somewhere else entirely.
- `nodeLabel` is suppressed for these — the message already names every node in its `{path}`, so
  prefixing would print the first label twice.

42 rules, in families:

- **Structure** — `NoStartNode`, `MultipleStartNodes`, `NodeUnreachable`, `InstantaneousCycle`,
  `UnknownNodeType`, `GraphEndsInfo`
- **Exit arity** — `{Start,Track,Delay,Playlist}MustHaveOneExit`, `EndMustHaveNoExits`,
  `Infinite{Track,Playlist}MustHaveNoExit`, `UntilTrackMustHaveOneExit`,
  `{Fork,Random,Condition}MinExits`
- **Track** — a switch on `loop.mode` (see [graph-engine.md](graph-engine.md) § *`loop`*):
  `TrackNoSound`, `TrackMissingSound`, `TrackSelfLoopWarning` apply regardless of mode;
  `count` adds `TrackLoopCountMin`; `until` adds `UntilMissingCondition`, `UntilMissingValue`, `LoopMinLoopsMin`,
  `LoopMaxLoopsBelowMin` (`maxLoops` null or `>= minLoops`)
- **Delay** — `DelayInvalidRange`, `DelaySelfLoopZeroWarning`
- **Random** — `RandomExitMissingWeight`, `RandomAllZeroWeight`
- **Condition** — `ConditionExitMissingCondition`, `ConditionExitMissingValue`,
  `ConditionExitDuplicate`, `ConditionDefaultMustBeLast`
- **Playlist** — `PlaylistNoReference`, `PlaylistNoTarget`, `PlaylistMissingTarget`,
  `PlaylistSelfReference`, `PlaylistInvalidSection`, `PlaylistLoopCountMin`,
  `PlaylistSoundboardTarget`, `PlaylistEmptyTarget`, `PlaylistUnknownOverlay`,
  `PlaylistReferenceCycle`

Several checks are **conditional on their lookup being supplied** — `PlaylistMissingTarget` only
fires when `options.playlists` is provided, `PlaylistUnknownOverlay` only when `options.moodIds`
(area refs) or `options.phaseIds` (combat refs) is, picked by `CONST.sectionAxis[ref.section]`.
That keeps the module usable without a live world.

**The instantaneous cycle is reported as a place, not a fact.** `findInstantaneousCycle()` returns
the cycle itself — `{ nodeIds, edgeIds }` in traversal order, the last edge closing the loop — and
`hasInstantaneousCycle()` is a thin wrapper for callers that only need the yes/no. The lead-in is
excluded: a Start feeding the loop is not *on* it, and pointing the reader at a node they can't fix
is worse than not pointing at all. The message interpolates `{path}` (`A → B → A`), the nodes are
badged, and the wires are painted red. It used to be a `nodeId: null` graph-wide error reading
*"the graph contains a cycle"* — true, unclickable, and in a graph of any size impossible to act on.

Seeding is in **node order**, not `Set` order, so the reported path is stable across renders — one
that reshuffled between two identical validations would read as a different problem.

This rejects at edit time what `MAX_SYNCHRONOUS_DEPTH` would only catch at runtime, and the safety
net is weaker than it looks: the depth cap bounds path *length*, not path *count*, so a Fork on the
cycle multiplies tokens every lap and the cap is reached only after a combinatorial number of hops
(measured: >5 M `_enterNode` calls for a Fork(4)↔Fork(2) pair). See
[../token-amplification-plan.md](../token-amplification-plan.md).

**Two exits that test the same thing.** `_enterCondition` returns on the first matching edge, so a
repeat of an earlier condition is unreachable however the game state falls — the same dead branch a
non-last `default` produces. `ConditionExitDuplicate` reports it with `{index, first}`, naming the
exit that shadows it. Comparison is by `conditionSignature()`, so it accounts for the value on
`mood`/`phase` (two different moods are two conditions) and ignores one on kinds that don't carry
it. `default` exits and already-incomplete exits are excluded on purpose — both are covered by
their own rule, and flagging them twice would put two errors on one node for one mistake.

**A condition needs a value, not just a kind.** `{kind: 'mood'}` with no `value` used to pass —
only a missing *kind* was checked — so a graph could save with exits the engine can never take
(`_evaluateCondition` compares the active overlay id against `undefined`). `ConditionExitMissingValue`
and `UntilMissingValue` make that an error. Both go through
`custom-playback-schema.mjs#conditionMissingValue()`, which is also what
[node-anatomy.md](node-anatomy.md)'s `(not set)` chip renders from — so the chip on the canvas and
the badge on the node always agree about what "unset" means, whitespace included.

---

## Saving

`handleSave()`:

1. Validate; block on errors.
2. **Force `mode: UNSEQUENCED`** (H1) — required, along with the properties Fork's simultaneous
   playback depends on.
3. Write the `game-orchestra.customPlayback` flag.
4. `hooks.mjs#handleUpdatePlaylist` observes the flag change and triggers the H8 engine rebuild.
   That hook is the **single designed trigger** — do not call `onCustomGraphChanged()` directly
   from the editor.
5. **Leave the window open.**

`handleRemoveCustomPlayback()` unsets the flag (`-=customPlayback`), which the same hook catches.
That one *does* close — there is nothing left to edit.

### Save does not close the window

It used to, and that quietly made the live activity highlight unreachable. Step 4 is the only way
to *hear* a graph, and the highlight only paints while this window is open — so closing on save put
the whole feature (`editor-highlight-mixin.mjs`: drains, pulses, active-edge markers) behind the one
action that dismissed it. Every edit→listen→edit turn cost a full reopen through the playlist sheet.

The footer's **Remove** button is the one wrinkle. It is gated on `hasExistingGraph`, which is
computed once at mount, and HR-A forbids re-rendering to update it — so it is **always in the
markup**, `disabled` when there is no graph, and `_enableRemoveButton()` flips that one property
after the first successful save. A `{{#if}}` there would strand a freshly-saved graph with no way
to remove it until the window was closed and reopened.

---

## Node placement

`_defaultNodePoint()` computes the canvas coordinates of the **viewport centre**, accounting for
`canvas_x`/`canvas_y` pan offset and zoom, then applies a 6-step cascade of 26 px so successive
adds don't stack exactly on top of one another. `_addCascade` is per-window instance state.

A node created by **drop** uses `_pointFromEvent()` instead.

### Auto-chaining — `_chainAnchor()`

A new node **wires itself onto the chain anchor** and lands one `COLUMN_WIDTH_PX` (220 px, the same
pitch the presets use) to its right. Building a five-track sequence by hand was ten gestures — place,
wire, place, wire — and is now five.

`_chainAnchorId` is **not** `selectedNodeId`, and the distinction is load-bearing: `_addNodeOfType()`
deliberately does not select what it creates (that would collapse the Tracks pane mid-flow), so
anchoring on the Drawflow selection would wire every node in a run onto the same source. The anchor
**advances to each new node** instead, which is what makes add-add-add build a chain. Clicking a node
re-points it, clicking empty canvas (`nodeUnselected`) clears it, and a node with no output — `end` —
terminates it.

Anchoring is deliberately conservative, because a wrong guess is worse than no guess. The anchor must
have **exactly one output port**, and that port must be **unconnected**. That excludes precisely the
ambiguous cases — a Fork, a Random or Condition with extra exits, and any node whose single exit is
already spoken for — and leaves the linear spine where there is only one thing "connect this" could
mean. A node with no input (`start`) is never chained *into*.

Adding and wiring happen in the same synchronous task, so `_recordHistory()`'s end-of-task capture
makes them **one undo step**, which is what Ctrl+Z is expected to undo.

### Splicing onto an edge — `planEdgeInsertion()`

Dropping onto a **wire** inserts the new node into it: `A -> B` becomes `A -> N -> B`. While a drag
is over the canvas, `_onDragOverExternal()` marks the wire under the pointer with
`INSERT_EDGE_ATTR` (`_setInsertTargetEdge`) — a wire is a thin target and "which one am I over" is
not answerable from the cursor alone.

The incoming half is unconditional. The outgoing half needs the node to have **exactly one exit**,
the same reasoning the chain anchor uses: a Fork would need us to pick a branch. Both halves keep
the *original* ports — splicing into a Random's second exit must not quietly move the wire onto its
first.

Auto-chaining is **suppressed** for this path (`_addNodeOfType(..., { chain: false })`): the edge
already says where the node belongs, and the chain anchor would wire it a second time from
somewhere else entirely.

Nodes win ties over wires in the hit test (`_edgeUnderPointer`). A drop aimed at a node — which
repoints a Track — is the more specific gesture, and a wire passing beneath a node is still
hit-testable at its edges.

### Deleting heals the chain — `planNodeBypass()`

Removing a node with **exactly one incoming and one outgoing connection** re-links its neighbours,
so deleting the Delay out of `A -> Delay -> B` leaves `A -> B` rather than two loose ends. Anything
else — a junction several nodes feed into, a branch point — is left as loose ends, which is honest
about what was lost.

This **wraps `removeNodeId()`** (`_installRemovalHealing`) rather than listening for `nodeRemoved`,
for two reasons:

- By the time `nodeRemoved` fires the connections are **already gone**. The neighbours have to be
  read while the node still knows about them.
- Wrapping is the only place that catches every removal path. Drawflow's own Delete/Backspace
  handler calls `this.removeNodeId()` internally and we never see that keypress — `_onKeyDown`
  deliberately stays out of its way for a single selection — while `_deleteMultiSelection()` calls
  the same public method. Changing our own call site would have missed the first.

Deleting a contiguous run composes, one healing per removal: with `A->B->C->D` and both B and C
selected, removing B gives `A->C` and removing C then gives `A->D`.

Guarded on `_historySuspended`, so an undo/redo restore never heals its way into a shape the
snapshot did not have. (`_restoreSnapshot()` goes through `editor.import()` and not `removeNodeId()`,
so this is belt-and-braces rather than load-bearing.)

---

## Drag-in from the sidebar

`graph-drop.mjs#resolveGraphDrop()` is a **pure function** implementing the rule matrix. The
caller does the async `fromUuid()` lookup and hands in a flattened `{type, playlistId, soundId}`.

| Dropped | Outcome |
|---|---|
| `PlaylistSound` from **this** playlist, onto open canvas | Create a `track` node |
| `PlaylistSound` from **this** playlist, onto an existing **Track node** | Repoint that node's sound |
| Either, onto an **edge** | Create the node and splice it into that edge |
| `PlaylistSound` from **another** playlist | **Reject** (`ForeignSound`) |
| `Playlist`, not the one being edited | Create a `playlist` node |
| `Playlist`, the one being edited | **Reject** (`SelfPlaylist`) |
| Anything else | **Reject** (`Unsupported`) |

A foreign sound is rejected rather than silently promoted to a Playlist node — that would play
that whole other playlist instead of the one track the user actually dragged. (`TrackMissingSound`
exists for exactly this reason: a Track node can only reference a sound inside the playlist being
edited.)

The Tracks pane's own rows emit an **identical payload shape**, so internal drag and sidebar drag
share one code path.

`_trackNodeUnderDrop()` decides between the first two rows, and like the drop point it must read
`event.target` **synchronously**, before the `fromUuid()` await — the event is not reliable to read
from once a handler has yielded. `resolveGraphDrop()` runs first either way, so a foreign sound
dropped onto a Track node is still rejected rather than used to repoint it.

---

## Inspector fields — Track `loop.mode` and Playlist overlay refs

`custom-playlist-inspector.mjs` builds the Track node's loop fields as three layers, each gating
the next, so the checkboxes below only ever affect fields visible right below them:

1. **Loop Forever** checkbox → `loop.mode: 'forever'`. The only sub-mode that touches the live
   Drawflow node's **port count** (`handleUpdateTrackInfinite` adds/removes `output_1`) — every
   other transition below keeps exactly one exit, so nothing else needs to.
2. When not forever, a separate **Loop Until Condition** checkbox toggles between `count` and
   `until` (`handleUpdateTrackUntilToggle`) — additive, deliberately kept apart from the Forever
   checkbox rather than folded into one three-way `<select>`, so the well-tested Forever handler
   and its port-mutation logic stay untouched.
3. When until, `buildUntilLoopFieldsHtml()` renders the escape condition (reusing the same
   `GraphCondition` kind/value markup a Condition node's exits use — see below), a Boundary
   `<select>` (`immediate`/`loopEnd`), and `minLoops`/`maxLoops` number inputs — each wired to its
   own `handleUpdateTrackUntil*` handler, all guarded by `node.data.loop?.mode !== 'until'` so a
   stray event after a mode switch is a no-op rather than corrupting the new mode's data.

All of it renders through `_renderInspector()` only — never `this.render()` (HR-A).

### `GraphCondition` fields — shared by Condition node exits and a Track's until-loop condition

Both `buildInspectorHtml()`'s Condition-node exit rows and `buildUntilLoopFieldsHtml()` render a
`GraphCondition` through the same two helpers:

- `buildConditionKindOptions()` — the kind `<select>`'s options are localized
  (`GameOrchestra.CustomEditor.Inspector.ConditionKind.*`), not the raw `kind` string (`combatActive`,
  `mood`, ...). Every kind is already camelCase, so the lang key suffix is just that string
  capitalized — no separate kind→key lookup table to keep in sync when a kind is added. The `mood`/
  `phase` labels read "Mood Is"/"Phase Is" (not just "Mood"/"Phase") to read naturally alongside
  their `moodChanged`/`phaseChanged` counterparts, labeled "Mood Changes"/"Phase Changes" — the
  `kind` string itself is unchanged, only the lang value moved.
- `buildConditionValueSelect()` — for `kind === 'mood'`/`'phase'`, the value field is a `<select>`
  populated from that axis's *configured* moods/phases (`moodOptions`/`phaseOptions`, threaded
  through from `custom-playlist-editor.mjs#_prepareContext`), not a free-text input the GM would
  have to already know the exact id to fill in correctly. Unlike a Playlist node's ref (which
  picks its axis from its own `section` field), a condition's axis is just its own `kind` — both
  option lists are always available and the helper picks between them per-condition, since a
  Condition node's several exits can mix `mood` and `phase` kinds freely. `moodChanged`/
  `phaseChanged` render no value field at all — `CONDITION_KINDS_WITH_VALUE` only contains `mood`/
  `phase` — since they match against a captured baseline, not a GM-picked id (see
  [graph-engine.md](graph-engine.md) § *Edges* and `_evaluateCondition()`'s own doc comment).

A Playlist node's reference inspector similarly re-populates its mood/phase `<select>` (via the
*other* overlay list, `overlayOptions`) from whichever axis the ref's own **Section** field
currently selects (O7, [graph-engine.md](graph-engine.md) § *References*) — switching Section
clears a now-invalid `overlayId` rather than leaving it pointing at an id from the other axis's
list.

---

## Presets — `graph-presets.mjs`

Starter graphs so a playlist doesn't have to be wired node by node: `sequential-loop`,
`sequential-once`, `shuffle`, `shuffle-with-gaps`, `single-loop`, `layered-ambience`,
`combat-aware`, `loop-until-combat-ends`.

All pure data transforms built on `graph-builder.mjs`, so each is testable by running its output
straight through `validateGraph()` and the Drawflow bridge.

Two design notes worth carrying forward:

- A **one-track** sequential loop becomes a single seamlessly-looping infinite track, *not* a
  track wired back to itself. The latter is legal but restarts audibly on every pass — and
  `validateGraph` warns about exactly that shape (`TrackSelfLoopWarning`).
- `combat-aware` loops *back through* its Condition node deliberately. Since conditions are only
  evaluated on token arrival (H7), looping through one is what makes a graph react to combat at
  all.
- `loop-until-combat-ends` is what makes `loop.mode: 'until'` discoverable at all: Start →
  Track(`until combatIdle`, `boundary: loopEnd`) → End. `loopEnd` specifically, not `immediate` —
  so the demonstrated behavior is "finishes the loop it's on, then stops," not a track that could
  visibly cut off mid-phrase the instant combat ends.

---

## Styling

`styles/game-orchestra.css`. Nodes are distinguished by **shape + icon**, not visible text: triangle,
octagon, pill, hexagon, parallelogram, diamond. The type name lives in the content's `title`
attribute so it isn't lost for mouse users or screen readers — just not taking up shape-interior
space.

### Colour means state, not identity

Borrowed from Grasshopper. Because shape + icon already carry type, **hue is reserved for state**:

| Channel | Meaning |
|---|---|
| `--game-orchestra-node-neutral` (gray) | Node border — every type, always |
| `--game-orchestra-node-accent` (per-type) | **Icon only.** Still declared per type; no longer on the border |
| amber / red | Validation warning / error — `.game-orchestra-node-warning` / `.game-orchestra-node-error` |
| blue | Selected — a 4px border on `::before`, nothing else |
| amber (dashed) | Multi-selected |
| cyan | Live playback |

The per-type accents are still declared by each type's rule, so putting one back on the border is
a one-line change per property. Severity is never hue-only — the badge carries `fa-exclamation`
for a warning and `fa-xmark` for an error.

**Selection is a border colour change, not a glow.** It used to add a two-layer `drop-shadow` on
`::before` plus a blurred `::after` halo behind the node; both are gone. That keeps `drop-shadow`
as the live-playback channel's alone.

### Start and End are outlined by a scaled `::after`, not a border

They're the sole clip-path *triangles*, and a border is measured perpendicular to the **box** edge,
not to whatever angle the clip cuts through it — so a diagonal clip exposes barely a sliver of it.
For those two, `::before`'s border is removed entirely and a solid copy of the same polygon sits
behind it (`z-index: -2` vs `-1`), grown just enough that a band shows past `::before`'s opaque
edge. That band is the outline, and it carries no blur.

**How much it is grown is the whole trick, and getting it wrong was reported live as a skewed
selection border.** The old rule used `inset: -4px`, which grows the *box* and lets the clip-path
percentages re-resolve against the bigger one. For a rectangle that outsets every edge by 4px; for
a triangle it scales the polygon about the box's **centre**, and a centre-scaled polygon's edges
move by an amount that depends on how far each sits from that centre. Measured on the 96×96 Start
node: the flat vertical edge gained the full 4px while both diagonals gained ~1.46px. The old
`::before` border made it worse, surviving only on that same flat edge — ~8px against ~1.5px.

A uniform outset of a polygon is a scale about its **incentre**, the one point equidistant from
all three edges. For an equilateral triangle of side `s` the inradius is `r = s/(2√3)`; these are
`s = 96` (the box height, which is the flat edge's length), so `r = 27.7128px` and the incentre
sits `27.7128/96 = 28.8675%` across. An outline of `w` px is then `scale((r + w)/r)` about that
point — `1.0722` for 2px, `1.1443` for 4px. **If the 96px box size changes, both scales must be
recomputed**; they are ratios against that specific inradius, not free constants. Verified by
rendering: `outlinePx` comes back as `3.999` on every edge.

Because this layer draws the whole outline, it is present at rest too, not only when selected — so
a Start/End triangle finally has a visible edge all the way round, where before it had one on the
flat side alone.

Everything else is outlined by its border directly: Track/Fork/Random/Playlist are `border-radius`
rectangles, Condition is a rounded rectangle (it was a diamond once, which is why older comments
spoke of "four clip-path shapes"), and Delay's `clip-path: circle(50%)` lands exactly on its own
`border-radius: 50%` edge. `content` is what gates the layer — every other node has no `::after`
box, so the state background rules find nothing to paint.

The `border: none` rule for these two types doubles its **type** class
(`.game-orchestra-node-start.game-orchestra-node-start`) to reach five classes. Four would only beat the
`::before` rules above it; `.game-orchestra-multi-selected::before` further down is also four and would
win the tie on order, handing the flat edge a dashed 3px border back — the exact doubling the rule
exists to remove.

A `drop-shadow` on `::before` was tried for the triangles first and rejected from live testing: it
reads only at the vertices, where two edges' shadows reinforce, and vanishes along a flat diagonal.

### The condition caption sits further down than every other node's

`.game-orchestra-node-name` is a caption absolutely positioned below the node, 4px clear of it. Condition
is the one type whose exits leave from its **bottom** edge, and 4px put the caption on top of the
branch ports and the first stretch of every wire leaving them — reported live, with a port dot
showing through the middle of the text. `.game-orchestra-node-condition .game-orchestra-node-name` uses 26px
instead, which clears the port (10px), the wire anchor's own offset (`--game-orchestra-port-out-y`, 14px)
and the wire's straight downward stub (`CONNECTION_STUB_PX`, 10px). Pushed down rather than moved
aside: the caption is centred and the branch exits spread across the whole bottom edge, so no
horizontal position clears them all.

### Drawflow's right-click delete bubble is hidden

`.game-orchestra-drawflow-canvas .drawflow-delete { display: none }`. Drawflow builds a black "x" bubble
on every right-click of a node or wire; it lands over the node's own corner, ignores this module's
styling entirely, and duplicates a route that already exists — Delete removes the selection, both
Drawflow's own single node/connection and this editor's marquee (see above).

Hidden rather than suppressed at the event level: Drawflow binds its `contextmenu` handler to the
canvas container itself, so blocking it means a capture-phase listener on an ancestor swallowing
every right-click inside the canvas — and right-drag on empty canvas is the pan gesture.
`display: none` also removes the bubble from hit-testing, so Drawflow's own click handler (which
matches on the click target being that element) can never fire for it either.

Two further state channels avoid hue entirely, because it was already spoken for:

- **Uncertain wires** (`[data-go-edge-uncertain]`, from `uncertainEdges()`): edges leaving a Random
  or Condition node render thinner and faded. Width + opacity, *not* dash — the dash pattern
  belongs to the playback highlight and multi-select — so an uncertain wire that is also being
  followed still reads as both. The `[data-go-edge-uncertain]` rule must stay **above**
  `[data-go-edge-active]` and `[data-go-edge-hover]`: same specificity, so document order decides,
  and hover's thicker stroke has to win.

  Every one of those markers is an **attribute, never a class** — see HR-K in
  [invariants.md](invariants.md) for the delete-an-exit bug that rule comes from.
- **Zoom tiers** (`data-zoom-tier`, from `zoomTier()`): below ~0.6 zoom the detail line and name
  caption are hidden, leaving shape + icon. Stamped on the canvas element from Drawflow's own
  `zoom` event — subscribe to that, never patch `handleZoomIn/Out/Reset`, or ctrl+wheel is missed.

### Tucked-in ports

Another Grasshopper borrow: at rest a port's dot sits centred on the node's own edge, so the body
covers its inner half and only the outer sliver shows; it steps out clear of that edge — full size,
drawn on top — only when the pointer is doing something with it. An idle graph then reads as shapes
and wires rather than a field of dots. Three properties move together, all set on the port and
consumed by its `::after`: `--game-orchestra-port-reveal` (the 0/1 switch, multiplied by each port's own
`--game-orchestra-port-out-x/-y` outward vector), `--game-orchestra-port-scale`, `--game-orchestra-port-z`. Two triggers:

- **The port itself is hovered** — plain CSS `:hover`, no JS. This covers dragging a wire onto a
  port too: Drawflow's wire drag runs off document listeners with no pointer capture, so the port
  under the cursor still matches `:hover` mid-drag.
- **A wire touching it is highlighted** — `[data-go-port-revealed]`, applied by
  `_setWirePortsRevealed()` to *both* ports of the wire under the pointer, and to the far end of an
  exit the inspector is pointing out. CSS cannot do this: the wire is an `<svg>` sibling of the
  nodes, and there is no selector from a hovered element into two arbitrary descendants elsewhere.
  `connectionPortSelectors()` (pure, in `custom-playlist-connection-render.mjs`) reads the
  endpoint classes Drawflow writes on every connection — `node_out_node-<id>` / `node_in_node-<id>`
  / `output_N` / `input_N` — matching them **by shape, not by index**. The vendor reads them
  positionally as `classList[3]`/`[4]` *and* reorders them when a port is renumbered, so those
  positions are not ours to rely on — and nothing of ours may sit in that class list at all (HR-K).

**The dot is a `::after`, and that is not cosmetic.** Three reasons:

1. **Wire endpoints.** Drawflow computes each as `port.offsetWidth / 2 +
   (port.getBoundingClientRect().x - canvasRect.x) / zoom` — one *layout* measure plus one *visual*
   one. A `transform` on the port moves the second while leaving the first alone, so a tucked port
   would drag its wire's endpoint along and the wire would jump on every hover. Transforming a
   **child** leaves the port's border box untouched.
2. **Stacking.** A `transform` on the port creates a stacking context, trapping its `::after`
   inside so the dot paints *over* the node body instead of tucked under it — the same trap as a
   numeric z-index. Condition used to centre its ports with `translateX/Y(-50%)` and was the one
   node type whose ports never tucked; those are negative margins now. **Never put a `transform`
   on a port element.**
3. **Hit area.** The port keeps its full 12px box and stays above the node body — only the *dot*
   goes behind, so you can still aim at a port whose dot is mostly hidden.

**`z-index: auto` on the port is required**, overriding the vendor's `z-index: 1`. The node's shape
is `.drawflow-node::before` at `z-index: -1`, so the dot must sit below that to look tucked. A
positioned port with `z-index: 1` becomes a stacking context and traps its `::after` inside it,
painting the dot above the shape whatever z-index the dot asks for. With `auto` the port forms no
stacking context, so the `::after` competes directly in `.drawflow-node`'s context and can drop to
`-2` (under the shape) or rise to `1` (over everything) — while the port element itself, still
positioned, paints above the node content and stays hit-testable across its whole box.

**The canvas class is doubled on every port rule** (HR-C). Drawflow's own
`.drawflow .drawflow-node .input` is three classes — exactly what an undoubled selector here would
be — and it was winning the tie: ports kept their vendor 20px size and opaque fill (`#fff`, `#ff0`
for inputs), so each rendered as the vendor's big circle *plus* this file's small `::after` beside
it, two dots per port with only one of them moving. `module.json` does load `drawflow.min.css`
first, so the tie should resolve our way; it does not in practice. Confirmed live from a
screenshot, not deduced. The Condition placement rules are doubled for the matching reason — they
must outrank the base block's own left/right anchoring.

**Ports are re-anchored so each centre lands on its node edge.** Drawflow leaves outputs 3px past
the right edge but inputs a full 27px off the left, which is visibly lopsided once the dot is meant
to straddle the edge. `right: 10px` / `left: -10px` fixes both — 10px being half a port's 20px
border box — and the Condition rules use the same figure. It also puts the wire endpoint (the port
centre, which is what Drawflow measures) right where the nub is, instead of leaving a bare stretch
of wire between them.

**`box-sizing` is pinned to `border-box` on the port, and must stay pinned.** Foundry ships a
global border-box reset. Under it, a content-box `16px` port with `2px` borders measures **16px**,
not 20px — so every 10px offset over-shoots by 2px *in the same screen direction*, pushing the left
nub 2px further out and pulling the right one 2px in. That is a 4px asymmetry produced by a pair of
rules that look perfectly symmetric, and it shipped: reported from a live screenshot measuring 13px
against 9px. Pinning `box-sizing` makes the geometry identical whatever the host page's reset says
— verified by rendering the same markup under both regimes (10px protrusion on both sides in each).

**Both ports share one dot colour (`#ddd`).** Outputs used to take `--game-orchestra-node-neutral`
instead, so that a port wouldn't compete with a state colour while wiring. That value is the node
*border's* own — which is exactly what a tucked dot is half-buried in, so the output nub fused with
the border and read as a smaller, flatter bump than the input opposite it, even though both centres
measure within 0px of their node edge. `#ddd` is achromatic, so it still cedes hue entirely to
state.

The 16px port size is roughly Drawflow's original, and is deliberate: at 12px the dot read as a
speck rather than something worth tucking. With the vendor's 5px `margin-bottom` that gives a 25px
stride for stacked Fork/Random exits, just inside the **26px** `BAR_HEIGHT_PER_EXIT_PX` the bar
grows by per exit (`custom-playlist-node-render.mjs`). Ports cannot grow further without raising
that constant first, or they overflow the bar.

The hovered wire is tracked in `this._hoveredWire`, and cleanup always re-derives its ports from
**that element's own class list** — deleting a wire mid-hover detaches its `<svg>`, but a detached
element still knows which ports it used to join, and those ports are still in the document.

Specificity is load-bearing (HR-C). Several per-type rules sit at the same specificity as
Drawflow's own base rules, so `drawflow.min.css` must load first. Do not reorder or restructure
those selectors.

Other constraints:

- `.game-orchestra-editor-panel` needs `min-height: 0` — without it the flex child refuses to shrink and
  the panel's scroll never engages.
- Drop-hover feedback must use `outline`/`box-shadow`, **never `border`** — a border changes the
  container's client box and with it Drawflow's drag math (HR-B).
- `300px` panel + `400px` min canvas + gap fits inside the `960px` default window width, so
  nothing is squeezed at the default size.
