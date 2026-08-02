# Token amplification — validation rules (draft)

Status: **proposal.** Nothing here is implemented yet. Numbering continues
`docs/playlist-node-plan.md`'s validation table (which ends at V12).

---

## The problem

`_enterFork()` is the only node that turns one token into many:

```js
await Promise.all(edges.map((edge) => this._enterNode(edge.to, depth + 1)));
```

Every outgoing edge gets its **own** `_enterNode` call. There is no dedup of any
kind on instantaneous nodes — only `track`, `delay` and `playlist` are
singleton-checked (`_activeNodes`), and `end` merely swallows a token.

So the token count at a node is:

```
tokens(n) = Σ over incoming edges e of  emit(source(e))
emit(f)   = tokens(f)                      for every node type except fork
emit(f)   = tokens(f)  on EACH of its exits, for a fork
```

Nothing caps `tokens(n)`. `MAX_SYNCHRONOUS_DEPTH` (100) caps **path length**, not
**path count** — and a fork cycle produces `fanout^depth` paths, so the depth cap
is reached only after an astronomically large number of `_enterNode` calls.

Each of those calls is not free. Every one does an O(N) `graph.nodes.find(...)`,
an `_emitActivity()` → `Hooks.callAll('gameOrchestraGraphActivity', …)` (synchronous,
into the editor's highlight code), and allocates a promise. A few thousand
freezes the tab; a few hundred thousand is unrecoverable.

### Measured

Simulating the exact `_enterNodeInner` dispatch (scratch harness, forks →
every exit, random/condition → one exit, durational → stop):

| Shape | `_enterNode` calls from one token | Caught today? |
|---|---|---|
| **The pictured graph**: Fork(4 exits) → Fork(2 exits) → back to Fork | **>5,000,000** (aborted at the harness cap; the depth guard prunes only after ~2.9 M branches have already reached depth 100) | yes — `hasInstantaneousCycle` |
| Acyclic cascade, 8 forks, each 2 exits both to the next | 512 | **no** |
| Acyclic cascade, 12 forks | 8,192 | **no** |
| Acyclic cascade, 20 forks | 2,097,152 | **no** |
| Acyclic cascade, 10 forks × 4 exits | 1,398,102 | **no** |
| Same 16-fork cascade placed **behind a Track** | 131,071 **per track end** | **no** |
| Delay → Fork(2) → {Delay, End} (durational cycle) | 2 | n/a — safe |

Two conclusions:

1. **The pictured arrangement is already rejected** — `hasInstantaneousCycle()`
   flags any cycle confined to start/fork/random/condition, and `handleSave`
   refuses to persist a graph with errors. But it is rejected *by accident of
   being a cycle*, and the runtime net behind it (`MAX_SYNCHRONOUS_DEPTH`) does
   **not** hold: if such a graph ever reaches the engine by a path that bypasses
   the editor's Save (a preset, an imported flag, a graph written by another
   module, a graph saved by an older version), the tab dies.
2. **The dangerous case is acyclic.** A fork cascade with reconvergence trips no
   existing rule at all: no cycle, every fork has ≥2 exits, every node is
   reachable from Start. It is silently savable and silently fatal.

A durational node **paces** amplification (the singleton rule caps how many
tokens are simultaneously *held*), but it does not **shrink** it — the 16-fork
cascade still fires 131 k calls every time its upstream Track ends.

---

## Rules

### V13 — error — `ForkFanoutExplosion`

> *"Fork exits multiply: N tokens will reach «node», each starting its own
> playback branch."*

Compute token multiplicity over the **instantaneous subgraph** (start / fork /
random / condition; durational nodes and `end` are sinks that reset multiplicity
to 1):

```
mult(start) = 1
mult(n)     = Σ over incoming edges e of mult(source(e))          // fan-in adds
fork emits mult(f) on every exit                                  // fan-out copies
```

Seed at `start` **and** at every durational node's exit (a Track's exit is a
fresh token). Error when any node's multiplicity exceeds **`MAX_FORK_MULTIPLICITY
= 16`**.

Rationale for 16: a Fork's legitimate use is "play these 2–4 stems together". 16
concurrent branches is already beyond anything a scene soundtrack wants, and it
is two orders of magnitude below the point where the tab stalls, so the rule bites
long before the damage does.

If the subgraph has a cycle, V14 fires instead and this computation is skipped
(multiplicity is unbounded by definition).

**Implementation note.** The propagation is a topological pass over the
instantaneous subgraph only, so it is O(V+E) and stays pure — it belongs next to
`hasInstantaneousCycle()` in `graph-validation.mjs`, sharing its
`INSTANTANEOUS_NODE_TYPES` filter. Saturate the accumulator at the threshold so a
pathological graph cannot make the *validator* itself blow up.

### V14 — error — `InstantaneousCycle` — **done**

Existing rule; detection unchanged, reporting rebuilt. `findInstantaneousCycle()`
now returns the cycle (`{ nodeIds, edgeIds }`, lead-in excluded, seeded in node
order for stability) and the issue carries it, so the editor badges every node on
the loop and paints its wires red. The message names the path and says that a
Fork on the loop multiplies tokens each lap. See
[wiki/editor.md](wiki/editor.md) § *Validation*.

Still outstanding: **a runtime net that actually holds** — see *Runtime* below.

### V15 — error — `PlaylistRefusalCycle`

`hasInstantaneousCycle()` classifies `playlist` as durational. It is not, on the
refusal path: `_enterPlaylist` → `_skipPlaylistNode` holds **no** token and
follows its exit immediately (deliberately — "a refused pass is a zero-length
pass, not a dead end"). A cycle through a Playlist node whose reference never
resolves is therefore an instantaneous cycle in practice.

It is *bounded* today — `_skipPlaylistNode` awaits `_throttleNodeEntry` (300 ms)
and the circuit breaker counts the entry — so this is the mildest of the set. But
with a fork on the cycle the 300 ms floor is per-node while the fan-out is
per-edge, so the breaker trips on a graph the user believes is fine.

Rule: a cycle whose only durational members are `playlist` nodes is an error when
a fork is on it, a **warning** otherwise.

### V16 — warning — `ForkDuplicateTarget`

Two or more exits of the **same** Fork landing on the same target node. The
second token is either dropped by the singleton rule (durational target) or
duplicates the entire downstream subtree (instantaneous target). Neither is ever
what the author meant; the first is silent, the second is V13's fuel.

This is exactly what the pictured graph does — four exits of `Fork` into one
input on `Fork 1` — and it is the cheapest of these rules to check.

### V17 — warning — `ForkExitCount`

A single Fork with more than **8** exits. Each exit is an independent branch;
if they reach Track nodes, that is 8 concurrent Foundry document updates at the
same instant. Below V13's threshold, so this catches the flat version of the same
mistake.

### V18 — error — `ConcurrentTrackSoundCollision`

Two Track nodes that reference the **same `soundId`** and are **concurrently
reachable** — i.e. reachable from two different exits of one Fork without an
intervening durational node on either path.

`_enterTrack`'s `_activeSoundOwners` check drops the second token, silently, at
level 2. The engine's own comment already states the invariant: *"Two Track nodes
should not both be reachable while referencing the same sound."* Nothing enforces
it at edit time. The user sees one of their two stems simply not play, with no
error anywhere.

Concurrent reachability is decidable statically: for each Fork, compute the
durational-frontier set of each exit (`findUpcomingTrackNodes` already computes
exactly this shape — reuse it) and error on any `soundId` appearing in two
different exits' frontiers.

### V19 — warning — `ForkBranchNeverCompletes`

A Fork branch that reaches a `loop.mode: 'forever'` Track (or a `forever`
Playlist node) holds its token for the life of the engine. That is legitimate at
top level, but it means **the engine can never go idle** — so if this graph is
ever used as a Playlist node's target, the parent's pass never completes and the
parent node holds *its* token forever too (H12).

Warning, not error: this is a real and intentional pattern for a root graph. But
it deserves to be visible, and today the only signal is the `GraphEndsInfo` info
line, which is actively misleading here — a graph containing an `end` node reports
"this graph ends" even when a parallel fork branch guarantees it never does.

### V20 — info — `RandomAfterFork`

A Random or Condition node whose multiplicity (V13's computation) is > 1. It does
not amplify — one token in, one token out — but the author almost certainly reads
"Random" as *"pick one of these"*, and with N tokens arriving it performs N
independent draws. Same for a Condition node: N tokens each take the first
matching exit, so N tokens leave. Purely informational, but it is the single most
confusing consequence of fan-in that the canvas gives no hint of.

---

## Runtime

Validation is the primary defence but it only guards the Save path. The engine
should not depend on that.

**Replace the depth cap with a token-budget cap.** `MAX_SYNCHRONOUS_DEPTH` was
designed for a cycle that spins one token; it is the wrong instrument for a cycle
that spawns many. Add a per-burst counter — reset when a token is admitted to a
durational node or when a fresh walk starts from a durational exit — and abort the
whole burst at `MAX_TOKENS_PER_BURST` (suggest 256, i.e. 16× V13's edit-time
threshold so the two never disagree in the safe range), logging at level 1 and
naming the fork.

Keep `MAX_SYNCHRONOUS_DEPTH` as-is alongside it: it still catches the
single-token instantaneous spin, which a token budget alone would not.

Two cheap companions, both worth doing regardless:

- **`_enterNodeInner`'s `graph.nodes.find()` is O(N) on every hop.** Build a
  `Map` once per engine (the graph is immutable for the life of a run). Turns a
  quadratic burst into a linear one.
- **`_emitActivity()` on every hop.** A burst of 65 k hops means 65 k synchronous
  `Hooks.callAll`. Coalesce activity emission to a microtask/animation frame —
  the payload is a snapshot of `activeNodeIds` anyway, so intermediate emissions
  during one synchronous burst carry no information the last one doesn't.

---

## Priority

| Rule | Severity | Why now |
|---|---|---|
| V13 `ForkFanoutExplosion` | error | The only rule that covers the acyclic case — currently **nothing** does |
| V18 `ConcurrentTrackSoundCollision` | error | Silent audio loss; the engine already documents the invariant it enforces at runtime |
| Runtime token budget | — | Makes the whole class survivable regardless of how the graph arrived |
| V16 `ForkDuplicateTarget` | warning | Trivial to implement, catches the pictured shape directly |
| ~~V14 localisation of the cycle~~ | error | **done** — the `nodeIds`/`edgeIds` mechanism it introduced is what V13/V18 should reuse |
| V19, V17, V20, V15 | mixed | Diagnostics for shapes that already degrade safely |

Every new key must be added to **both** `lang/en.json` and `lang/pt-BR.json` —
`tests/lang.test.mjs` enforces parity in both directions.
