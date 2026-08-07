# Node anatomy — what a node says, and where

**Read this before adding a node type, or before putting anything new on the canvas.**

A graph is only useful if it can be read without clicking every node. This page is the contract
that keeps that true as types are added: five channels, each owning one question, with one rule for
deciding which channel a new fact belongs to.

For *how* these are rendered (the DOM, the Drawflow constraints) see [editor.md](editor.md). This
page is about what goes where and why.

---

## The five channels

| # | Channel | Question it answers | Where | Varies with |
|---|---|---|---|---|
| 1 | Shape + icon | *What kind of node is this?* | the shape itself | node **type** only |
| 2 | Caption | *Which node is this?* | below the shape | the user's own name |
| 3 | Detail line | *What does it do while it holds the token?* | inside the shape, one line | node-level config |
| 4 | Exit chip | *When or why does the token leave by* **this** *exit?* | on each output port | per-exit config |
| 5 | State | *Is it broken? Is it running?* | badge + hue; cyan + drain | validation, runtime |

Channels 1, 2 and 5 predate this page and are documented in [editor.md](editor.md) § *Styling*.
Channels 3 and 4 are what this page governs.

---

## The rules

### R1 — One channel per fact

If a fact is **indexed by exit**, it belongs to channel 4. If it is a property of the **node**, it
belongs to channel 3. Never both.

This is what removed `"3 exits"` from Random's and Condition's detail lines: it was a count of
channel-4 items rendered in channel 3, and once the chips exist it is the same fact told twice.

> **R1a** — a node with **no** chips may summarize its exits in channel 3, since nothing is
> duplicated. Fork is the only such type today (see R3), and that is why it alone still shows a
> count.

### R2 — Channel 3 must fit the node's own width

One line, no wrap. Measured capacity: **~26 characters** on a 160px node (Track, Playlist), **~10**
on the 64px bar (Fork, Random, Condition). Beyond that it ellipsizes.

Order the line **most-identifying first**, because truncation eats the tail. If a fact cannot fit,
it is not canvas information — it belongs to the inspector.

### R3 — Chips exist only for *guarded* exits

No guard → no chip, and that absence is itself information. Three guards exist today:

- a **Random** exit's weight,
- a **Condition** exit's predicate,
- an **until Track**'s escape condition.

Fork therefore never gets chips — every exit fires at once, so there is nothing per-exit to say —
and that is precisely what distinguishes it at a glance from the other two branching types, which
share its 64px bar and differ otherwise only by icon and accent (see R7).

### R4 — Shared notation, not per-type invention

| Notation | Means | Used by |
|---|---|---|
| `× 3` | exactly three, then advance | Track/Playlist `loop.mode: 'count'` |
| `× ∞` | never advances | `loop.mode: 'forever'` |
| `× 2–8` | at least 2, at most 8 | `loop.mode: 'until'` with `maxLoops` |
| `× 2+` | at least 2, no maximum | `loop.mode: 'until'`, `maxLoops: null` |
| `1–5s` | a time range | Delay |
| `=` | equality | `Mood = Tense` |
| `Δ` | "changed" | `Mood Δ`, `Phase Δ` |
| `else` | the fallback branch | a Condition's `default` exit |

The en dash is the same one Delay's range already used; `× a–b` was chosen over inventing a loop
glyph so the vocabulary stays small.

### R5 — Channels 1–4 are achromatic

Hue on this canvas means **state** and nothing else (validation amber/red, selection blue, playback
cyan). A coloured detail line or chip would read as a sixth state. Chips use `#cfcfcf` on `#202020`;
the exit-adder `+` uses the port's own `#ddd`.

### R6 — Channels 2, 3 and 4 hide at compact zoom

Below `zoomTier()`'s 0.6 threshold they stop being information and become a smear alongside the
wires. Channels 1 and 5 survive — at a distance, shape and "is anything broken/playing" are exactly
what you are still trying to read.

### R7 — Guarded exits leave from the right edge, stacked

A chip's length must not be bounded by how many exits the node has. Stacked, chips pair
unambiguously with their ports, evaluation order reads top-to-bottom, and the footprint grows
downward — which is free, since graphs flow left-to-right.

This rule is why **Condition's branch exits moved off its bottom edge.** Measured on the rendered
page, with realistic equal-width labels:

| Layout | chip↔chip collisions | caption collision | footprint at 6 exits |
|---|---|---|---|
| Bottom edge (old) | 2 at 4 exits, 2 at 6 | **yes** — caption buried under the chip row | 358px wide |
| Right-edge stack | **0** at any count | no | 64px wide × 194px tall |

Beyond the numbers, the bottom-edge fan put the **fallback exit at the top**, reading first while
`ConditionDefaultMustBeLast` requires it to be evaluated last. Stacked, `else` sits at the bottom
where the rule says it belongs.

Condition's **150px box** went with the bottom edge too. That width existed to hold the fan; with
the exits stacked and its detail line empty by design (R1), it had nothing left to fill and rendered
as a large empty square. It is the same 64px bar as Fork and Random now.

> **All three branching types therefore share one silhouette.** Channel 1 no longer separates them
> on its own — they are told apart by icon, by accent, and most usefully by their chips: Random
> shows shares, Condition shows predicates, Fork shows none at all (R3). That is a deliberate
> trade: shape stopped being informative for these three the moment their only distinguishing
> feature was how much empty space they had.

What else went with it: `computeNodeWidthPx()`, the `--game-orchestra-exit-i/-n` even-spread CSS,
`_layoutConditionPorts()`, `_outputPortDirection()`, and the Condition-specific 26px caption offset.
`buildRoutedPath()` keeps its `'up'`/`'down'` support — the per-end handle lengths and the
backward-facing swing are general, and `custom-playlist-connection-render.test.mjs` still measures
them directly — but **no current node type asks for a vertical port.** A future one only has to pass
the direction at `_routeConnections()`'s single call site.

---

## What each type says today

| Type | Channel 3 (detail line) | Channel 4 (exit chips) |
|---|---|---|
| Track | `Sound × 3` · `Sound × ∞` · `Sound × 2–8` · `Sound × 2+` | until only: the escape condition |
| Delay | `1–5s` | — |
| Playlist | `Ref × 2` | — |
| Script | the macro's **live** name · `⟨inline⟩` | — |
| Fork | `3 exits` (R1a) | — |
| Random | `no repeat` when `avoidRepeat` | `40%`, normalized; `⧗2` appended when cooldown > 0 |
| Condition | *(none)* | `Combat` · `No Combat` · `Mood = Tense` · `Mood Δ` · `Defeated` · `else` |
| Start / End | *(none)* | — |

### `(not set)` is an error, not a placeholder

A chip reading `Mood = (not set)` means the exit can never be taken — the engine matches the active
overlay id against `undefined`. `ConditionExitMissingValue` / `UntilMissingValue` therefore **block
saving**, and both they and the chip read emptiness through the same
`conditionMissingValue()` helper, so the canvas and the validation list can never disagree.

The general rule for a future guard: **if a chip can render a "not configured" state, that state
needs a validation rule to match.** A chip that quietly says something is missing, on a graph that
saves happily, is worse than no chip.

### Script, as a worked example of R3 and R1

The Script node is the cleanest illustration of both rules, because both of them said *no* to
something that looked reasonable.

**R3 said no chips.** A Script node has exactly one exit and nothing guards it, so the absence of a
chip is correct and is itself information: the token always leaves this way. It is not in
`EXPANDABLE_EXIT_NODE_TYPES` or `EXIT_STACK_METRICS`.

**R1 rejected routing by return value.** The obvious feature — `return 'combat'` selects the exit
labelled `combat` — is exactly what R1 forbids: a fact **indexed by exit**, guarded, needing chips,
on a node type whose whole point is that it is opaque. It would also be a second, weaker Condition
node that no validation rule could check, since the routing lives inside code the validator cannot
read. A script that wants to route writes to state and lets a **Condition node** read it.

**Its detail line resolves the macro's name live** (channel 3), which is why a deleted macro renders
unresolved on the canvas *and* raises `ScriptMacroNotFound` in validation — the same fact in the two
channels that own it, per the `(not set)` rule below.

**It gets no drain overlay.** `DRAIN_NODE_TYPES` covers the two types whose token-holding time the
engine knows in advance; a script's duration is unknowable, and a drain that guessed would be worse
than none.

### The until-loop, as a worked example of R1

An `until` Track has three facts. R1 splits them without a special case:

- **its bounds** (`minLoops`/`maxLoops`) are node-level → channel 3, `× 2–8`;
- **its escape condition** is a guard on the node's one exit → channel 4, rendering *identically* to
  a Condition branch, because it is one;
- **its boundary** (`immediate`/`loopEnd`) fits nowhere in 26 characters → inspector only (R2).

> This replaced a real bug. `until` has no `loop.count`, so `count ?? 1` rendered it as **`× 1`** —
> byte-identical to a track that plays once and stops, which is the opposite of what an until-loop
> does. `formatLoopQuantifier()` routes through `resolveLoop()` now, so a missing or malformed loop
> coerces here exactly as it does in the engine instead of being guessed at twice.

---

## Adding a node type: the checklist

1. **Shape + icon** in `NODE_ICONS`/`NODE_LABELS` and a per-type CSS rule. Never encode config here.
   The per-type rule must name **`.game-orchestra-node-swatch` alongside the canvas selector** — the
   editor's palette chip is the same node drawn outside the canvas and shares those rules by name
   (see [editor.md](editor.md) § *The palette chips are node previews*). Skip it and the new type's
   chip renders as a grey default box.
2. **Detail line** — add a case to `computeNodeDetail()`. Node-level facts only (R1); must fit (R2);
   reuse the notation table (R4); localize through the injected `localize` (the module is
   deliberately Foundry-free).
3. **Guarded exits?** If yes, add the type to `EXPANDABLE_EXIT_NODE_TYPES` and to
   `EXIT_STACK_METRICS` (R7), and extend `computeExitChip()`. If no, do nothing — the absence is
   correct and meaningful (R3).
4. **Lang keys in both locales** (HR-E). Chip keys derive from the kind string
   (`ExitChip.${Capitalized}`), so a new *condition kind* needs a lang entry and no lookup table.
5. **Render it.** Chrome is installed; see the harness note in [editor.md](editor.md). Chip
   collisions, caption overlap and detail truncation are all measurable in about a minute, and every
   number on this page came from doing that rather than reasoning about it.
