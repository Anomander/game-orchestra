# Game Orchestra wiki

Developer documentation for the Game Orchestra FoundryVTT module, written for agents and humans doing
non-trivial work in this codebase.

[`CLAUDE.md`](../../CLAUDE.md) at the repo root is the short, always-loaded summary. These pages
are the detail behind it.

---

## Pages

| Page | Contents |
|---|---|
| **[invariants.md](invariants.md)** | **Start here.** The H1–H16 hazards and house rules HR-A–HR-J. The rules that break things silently. |
| [architecture.md](architecture.md) | How game state becomes audio: the playback pipeline, context resolution, priority, transitions, storage, hook wiring. |
| [graph-engine.md](graph-engine.md) | The token-walk playback engine: node semantics, singleton rule, safety nets, Playlist nodes, the stop-before-start race. |
| [editor.md](editor.md) | The Drawflow graph editor: the no-re-render rule, Drawflow's limits and their workarounds, validation, drag-in, styling constraints. |
| [mixer.md](mixer.md) | The Playlist Mixer: the two storage layers, the crossfade chain, and the one place rule 5 does not apply. |
| [ux.md](ux.md) | Which surface serves which job, why the current set doesn't cohere, and the UX-1–UX-9 principles for adding or moving any UI. |
| [module-map.md](module-map.md) | File-by-file index with purity annotations and a dependency diagram. |
| [testing.md](testing.md) | The Foundry mock, test conventions, structural guard tests, and what is deliberately not covered. |
| [integration-testing.md](integration-testing.md) | The audio tier: real Foundry at a pinned version, driven by Playwright, asserted on what the speakers actually output. |
| [playbook.md](playbook.md) | Step-by-step recipes for common changes, plus known quirks not to "fix". |

---

## Reading order

**Making any change:** `CLAUDE.md` → [invariants.md](invariants.md) → the page matching your area.

**New to the codebase:** [architecture.md](architecture.md) → [invariants.md](invariants.md) →
[module-map.md](module-map.md).

**Debugging playback:** [architecture.md](architecture.md) § *The playback pipeline* →
[graph-engine.md](graph-engine.md) → [playbook.md](playbook.md) § *fix a "playback stops silently"
bug*.

**"The tests pass but it doesn't play":** [integration-testing.md](integration-testing.md) §
*What the unit suite cannot see* — a green `npm test` says nothing about audio reaching the
speakers.

---

## About the source comments

The single most valuable documentation in this project is **in the source files**. Nearly every
comment records a bug that was confirmed live — including the failure mode and why the obvious
alternative doesn't work.

This wiki organizes and cross-references that knowledge. It does not replace it. When a wiki page
and a code comment disagree, **the code comment is more likely to be right**, and the wiki should
be corrected.

---

## Archived plan documents

`docs/playlist-node-plan.md`, `docs/graph-editor-panel-plan.md`,
[`docs/overlays-and-loop-modes-plan.md`](../overlays-and-loop-modes-plan.md) and
[`docs/playlist-mixer-plan.md`](../playlist-mixer-plan.md) are **implementation
plans for features that have already shipped.** They are historically accurate but no longer
maintained, and their durable content is folded into this wiki — the overlay-axes/loop-modes plan
specifically into [architecture.md](architecture.md) § *Overlay axes*,
[graph-engine.md](graph-engine.md) § *`loop`* and § *Per-node behavior*, and
[invariants.md](invariants.md) H12.

They stay at their current paths because source comments cite them by section id (`D3`, `D6`,
`Phase 4.4`, `HR-A`, `O1`–`O10`, `L1`–`L7`). **Do not move or rename them.**

`docs/custom-playlist-plan.md` — the original source of the H1–H11 hazard IDs — **is missing from
this repository**, though ~16 comments across 8 files still cite it. The hazards are reconstructed
from those citations and the code they guard in [invariants.md](invariants.md), with per-entry
confidence levels. The stale paths in the source were deliberately left untouched.

---

## Maintaining this wiki

- A newly discovered hazard belongs in [invariants.md](invariants.md), with a note on how it was
  confirmed.
- A new window, panel, or injected control needs a row in [ux.md](ux.md) § *The surfaces today*, and
  must name which of the five jobs it serves.
- A new subsystem gets a row in [module-map.md](module-map.md); a new *file* gets one too.
- A recurring class of mistake becomes a recipe in [playbook.md](playbook.md).
- Prefer linking to the source over duplicating it. Line counts and structure drift; the reason a
  rule exists doesn't.
