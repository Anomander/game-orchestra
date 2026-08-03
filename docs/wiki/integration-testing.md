# Integration testing (audio)

How the module is verified against a **real, pinned Foundry** by measuring **what actually comes
out of the speakers**.

Read this before changing anything in [itest/](../../itest/), and before assuming a green
`npm test` means playback works. It does not — see
[What the unit suite cannot see](#what-the-unit-suite-cannot-see).

---

## The tiers

| Tier | What runs | Where | Cost | Command |
|---|---|---|---|---|
| **L0** | The module's logic against `tests/mocks/foundry.mjs` | node, no browser | ~3 s | `npm test` |
| **L1** | The harness's own maths, against synthesised audio | node, no browser | included in L0 | `npm test` |
| **L2** | The module in real Foundry, measured by a real audio probe | Docker + Chromium | ~5 min, 13 specs | `cd itest && npm run ci` |
| **L3** | Two clients at once (GM + player) | same as L2 | included in L2 | — |

L1 is the unusual one and it is deliberate: `itest/harness/analysis.mjs`, `goertzel.mjs`,
`tones.mjs`, `worklet-source.mjs` and `fixtures/generate.mjs` are pure, and
`tests/itest-analysis.test.mjs` + `tests/itest-goertzel.test.mjs` exercise them in the ordinary
vitest run. **An integration harness that can only be tested by the thing it tests is a harness
whose own bugs get blamed on the module.** Two real defects were caught by L1 before the harness
ever saw Foundry, and the tier as a whole flushed out a dozen more — see
[Findings](#findings-from-building-this).

**Status:** all 13 L2/L3 specs pass locally against Foundry **14.364**, twice consecutively with
no retries. Three CI runs have failed; each named a distinct cause and each is fixed — see
[When CI fails](#when-ci-fails), which is the most useful section on this page. The third run's
fixes have not yet been confirmed green on a runner.

---

## What the unit suite cannot see

`docs/wiki/testing.md` lists the deliberate gaps. This tier exists to close the audio-shaped ones:

| Gap | Why only real audio catches it |
|---|---|
| **The mixer's everywhere-rule** (CLAUDE.md rule 5's exception) | Head-GM-gating `playlist-mix-apply.mjs` makes the GM hear the ceiling and players hear the raw track. Both halves are individually correct; only comparing two clients' *output* shows it. |
| **H1/H2 — a stray `initialTrack`** | Symptom is *music playing*, from Foundry's own `UNSEQUENCED` handling, bypassing the graph. Module state looks fine. |
| **Armed starts against a suspended context** | `custom-playback-engine.mjs` schedules against the `AudioContext` clock. A suspended context makes the delay never elapse. Real clock, real context, by definition. |
| **Fades, crossfades, ducking** | Modelled in unit tests, never exercised. A duck applied twice and a duck applied once differ only by a number no state inspection reveals. |
| **Foundry version compatibility** | `hooks.mjs` flags the `renderPlaylistConfig` hook name and `select[name="mode"]` anchor as unverified against a live v14 build. |

---

## The central idea: tracks that identify themselves

There is no browser API for "what is audible right now", and asking the module is circular —
`sound.playing` only proves the module *thinks* it started something, which is exactly the class
of bug worth catching.

So **every fixture track is a pure sine tone at a known frequency**, and a probe measures the
amplitude of each frequency independently:

```
"track B is audible at 0.31 from 2.1 s to 4.4 s"
```

is then an observation about the output signal, not about module state. Sequencing, crossfades,
ducking and mute all reduce to arithmetic over that.

### The tone table is solved, not chosen

`itest/harness/tones.mjs` holds six frequencies. They are spaced so that **no tone lands near any
other tone's 2nd, 3rd or 4th harmonic** — because any gain stage produces harmonic distortion, and
a detector tuned to 2f responds to the distortion of f. A harmonically related table would make
one track's distortion read as another track playing.

"Near" is in **Hz, not ratio**: the 2048-sample analysis window is ~23 Hz per bin, so a tone 9 Hz
from another's second harmonic is *the same bin*. The table clears every harmonic by 88 Hz
(≈4 bins), enforced by `tests/itest-analysis.test.mjs`.

### The probe

```
Foundry's audio graph ──connect(destination)──▶ [patched] ──▶ tap (unity gain) ──┬──▶ destination
                                                                                 └──▶ probe worklet
```

`itest/harness/probe-init.js` runs via `addInitScript` **before any page script** and patches
`AudioNode.prototype.connect`, rerouting destination connections through a tap. Everything
audible must eventually reach a destination, so this measures what the player hears no matter how
the graph above it is wired — including any path that bypasses `game.audio` entirely.

The analysis runs in an **AudioWorklet**, not an `AnalyserNode`: an analyser is sampled from the
main thread at whatever rate `requestAnimationFrame` happens to fire, which under a headless
browser is neither regular nor fine enough to measure a 500 ms crossfade. A worklet sees every
render quantum and timestamps from `currentFrame`, so the timeline is exact in audio time.

Detection is **Goertzel** (O(N) for known frequencies, no bin interpolation) with a Hann window,
scaled so a reading is directly comparable to the source amplitude — a 0.5-amplitude tone reads
~0.5. `tests/itest-goertzel.test.mjs` proves that against synthesised signals.

> The worklet cannot `import` — an `AudioWorkletGlobalScope` has no module loader. Rather than
> keep two copies of the maths, `worklet-source.mjs` strips `export` keywords from `goertzel.mjs`
> and concatenates. That textual step is itself guarded by a test that compiles the result.

---

## Layout

| Path | Purity | Role |
|---|---|---|
| `itest/harness/tones.mjs` | **pure** | The tone table, the audibility floor, the harmonic guard |
| `itest/harness/goertzel.mjs` | **pure** | The detector maths. Shared with the worklet by concatenation |
| `itest/harness/analysis.mjs` | **pure** | Sustained tones, segments, entry order, crossfade, ratios, ASCII timeline |
| `itest/harness/worklet-source.mjs` | node | Assembles worklet source; validates the export strip |
| `itest/fixtures/generate.mjs` | node | Renders the tone bank as WAV |
| `itest/harness/probe-init.js` | browser | The `connect` patch and the page-side `__goProbe` API |
| `itest/harness/probe-worklet.js` | worklet | The processor. Not standalone — see above |
| `itest/harness/session.mjs` | Playwright | `gm` / `player` fixtures, `record*`, `probeNow`, probe health, per-test world reset |
| `itest/harness/foundry-api.mjs` | Playwright | World provisioning through Foundry's **document API**; `applyGraphPreset`, `preloadPlaylist`, unit-safe fade setters |
| `itest/harness/expect-audio.mjs` | Playwright | The assertions specs actually call |
| `itest/harness/global-setup.mjs` | Playwright | Enables the module, creates the two users |
| `itest/harness/bootstrap-world.mjs` | node | Creates + launches the world over `/setup` |
| `itest/specs/*.spec.mjs` | Playwright | The scenarios |

**Keep the pure four pure.** They are what L1 can test, and that is the only reason the harness's
own correctness is knowable.

---

## House rules for specs

1. **Set state through Foundry's document API, never through the module's UI.** The editor and
   config windows already have 156 + 30 unit tests. Driving them here would make audio specs fail
   for selector reasons and would test the wrong boundary. `foundry-api.mjs` is the whole
   vocabulary.

2. **Assert on ratios and orderings, not absolute levels,** wherever possible. Absolute output
   depends on Foundry's 1.5-order volume curve, the browser's output gain, and the fixture level —
   none of which this module owns. `expectLevelRatio` needs no knowledge of the curve.

3. **`expectExactlyAudible` over `expectAudible`.** The "nothing else was playing" half is what
   catches an orphaned sound surviving a transition — historically this module's most common
   failure shape.

4. **A crossfade assertion must check `monotonic`.** A bug that starts the next track without
   stopping the previous one produces overlap of exactly the right length. Only the trend
   distinguishes a crossfade from a double-start.

5. **Never let a spec pass on an empty timeline.** Every "was silent" assertion passes vacuously
   against no frames. `assertProbeHealthy()` runs in the `gm` fixture for this reason; call it on
   the `player` page too when a spec uses one.

6. **Specs run in real time.** There is no fake clock — the real audio pipeline is the subject.
   The suite's runtime is the sum of the `record()` durations, so keep them tight.

7. **Anchor every measurement window to a mark, never to arithmetic on phase lengths.** Use the
   `mark` that `recordDuring` returns, or take one with `probeNow()`. A window written as
   `{from: 2500}` silently assumes the state change landed at time zero; it did not, and on a
   contended machine it landed eight seconds later. Three specs failed in CI on exactly this while
   the module was behaving correctly.

8. **A mark belongs to the page it was taken on.** Each client's probe has its own origin and its
   own audio clock. Applying a GM mark to a player's frames compares two different stretches of
   audio — the failure mode is a spec that passes alone and flakes in a full run.

9. **Reproduce a "finding" with the main thread free before writing it down.** This tier measures
   the module through a browser whose main thread it shares. A documented claim that the graph
   engine never crossfades its first hand-off turned out to be the arming deadline being missed
   under canvas contention — a property of the machine, not of the engine.

10. **The world is reset by the `gm` fixture, before *and* after each spec.** Before matters most:
    a run that crashed never cleaned up, and the next run's first spec would otherwise fail on a
    stray tone it never started.

---

## Running it

Foundry is licensed software and is **never** committed or redistributed here. The container
downloads it with your own credentials.

```bash
cd itest
npm install && npx playwright install --with-deps chromium

export FOUNDRY_USERNAME=… FOUNDRY_PASSWORD=…   # or FOUNDRY_RELEASE_URL=…
npm run ci        # fixtures -> container -> world -> specs
```

Piecemeal: `npm run fixtures`, `npm run up`, `npm run bootstrap`, `npm test`, `npm run down`.
`npm run test:headed` and `npm run test:ui` for debugging.

### World provisioning, as it actually works in v14

Read out of `dist/server/views/*.mjs` in the running container and confirmed by curl. None of it
was guessable:

| Step | Route | Body |
|---|---|---|
| Sign EULA | `POST /license` | `{action: 'signEULA', agree: true}` |
| Admin session | `POST /auth` | `{adminPassword}` |
| Install a system | `POST /setup` | `{action: 'installPackage', type: 'system', id, manifest}` |
| Create a world | `POST /create` | `{action: 'createWorld', id, title, system}` |
| Launch it | `POST /setup` | `{action: 'launchWorld', world}` |
| Become a user | `POST /join` | `{action: 'loginAs', userId}` |

There is **no `adminAuth` setup action** (`/auth` owns admin sessions) and **no `createWorld`
setup action** (`CreateView` is a separate view on its own route). A fresh install has **no game
system at all**, and `World.create` hard-fails without one.

### Version pinning

`itest/scripts/up.sh` reads **`module.json`'s `compatibility.verified`** and starts that Foundry
version. The manifest is the single source of truth: bumping what the module claims to support is
what moves the integration target, so the two cannot drift. Override per-run with
`FOUNDRY_VERSION`.

### Audio in CI

Chromium's `AudioContext` will not advance without an output device, and `--mute-audio` is
implemented as a null *device* — with it, the probe captures nothing and every silence assertion
passes vacuously. The workflow installs PulseAudio and creates a null sink instead, which keeps
rendering real while discarding the output.

`.github/workflows/integration.yml` runs nightly, on `workflow_dispatch`, on PRs labelled
`integration`, and — via `workflow_call` — as a **gate on every release**. It **skips cleanly**
when `secrets.FOUNDRY_USERNAME` is absent, because fork PRs cannot have it and a permanently red
required check nobody outside the repo can fix is worse than no check.

### The release gate

`release.yml` runs the tier against the tagged source **before anything is published**, and
`build` waits on it:

```yaml
audio:
  if: vars.SKIP_AUDIO_GATE != 'true'
  uses: ./.github/workflows/integration.yml
  secrets: inherit
  with:
    require_credentials: true

build:
  needs: audio
  if: always() && (needs.audio.result == 'success' || vars.SKIP_AUDIO_GATE == 'true')
```

Two deliberate choices:

- **`require_credentials: true` inverts the skip.** Everywhere else, a missing licence secret
  skips the tier; on a release it fails the run. A gate that silently passes when it could not run
  certifies nothing, and a release cannot be quietly amended — publishing pushes the version to the
  Foundry Package API, where every user's updater sees it.
- **The override is a repository variable, not a flag in the tag.** Setting `SKIP_AUDIO_GATE` to
  `'true'` ships without the tier. It exists for the case where the Foundry download is
  unavailable, and it is deliberately visible and auditable rather than a quiet fallback.

Prerequisites: `FOUNDRY_USERNAME` and `FOUNDRY_PASSWORD` repository secrets. Cost is ~6 minutes
added to a release.

**The gate tests the working tree, not the archive.** `release.yml` therefore also verifies that
every path `module.json` declares (`esmodules`, `scripts`, `styles`, `languages[].path`) is present
inside the built zip — the zip is assembled from an explicit file list, so a newly added file can be
declared, tested, and still left out of the release.

---

## When CI fails

The first release-gate run (`release-0.0.1a`) failed, and the *way* it failed is worth keeping,
because the configuration turned one problem into no information at all:

- Every spec failed identically, each burning its full 180 s timeout.
- `retries: 1` doubled that.
- The job hit `timeout-minutes: 30` mid-suite and was killed — so Playwright never printed its
  end-of-run summary, and the HTML report was never written, so the upload found nothing.

Twelve identical timeouts is one piece of evidence delivered at the highest possible price. Four
changes make the next failure legible:

| Change | Why |
|---|---|
| `['github']` reporter | Emits `::error::` annotations **as each spec fails**, so a killed run still shows the reasons |
| `maxFailures: 3` in CI | A systemic failure stops after three, leaving time to report |
| `timeout: 180_000` | Bounds a hang, with room for a slow world load on a runner (a passing spec measured 128 s) |
| `timeout-minutes: 45` | Room for a failing run to finish *and* upload its report and traces |

`itest/test-results` (traces and videos) is now uploaded alongside `itest/report`, because it
exists even when a run is cut short before the HTML report is generated.

**`specs/000-smoke.spec.mjs` is the canary.** It sorts first and checks only that the environment
works at all: head GM, audio unlocked, probe attached, one track audible. It runs in ~15 s. A
broken environment now fails there, with a message naming which part broke, instead of proving the
same point twelve more times.

### Root cause: the audio clock does not run at realtime on a CI runner

The second run — with the diagnostics above in place — named it. Every failing spec attached a
timeline whose *span* was several times the duration that had been recorded:

| Requested | Captured | Ratio |
|---|---|---|
| 3000 ms | 12214 ms | 4.07x |
| 4000 ms | 16721 ms | 4.18x |
| 7500 ms | 17276 ms | 2.30x |

**Chromium's `AudioContext` renders far faster than realtime on the runner**, because a null sink
that does not pace playback lets it produce samples as fast as it can. The ratio is not even
constant — it varies with load, so no fixed correction would help.

That alone was survivable. What made every spec fail was that the harness had frames stamped with
the **audio** clock while `record()` and `probeNow()` used the **wall** clock. Three wall seconds
captured twelve seconds of audio, so every measurement window covered a quarter of the material it
meant to — and a window opened "2 s after the change" landed before the change had even been made.
Hence the two contradictory-looking failures in the same run: `expected exactly [alpha] audible,
got []` (window past the end of the material) and `expected silence` (window before the change
took effect).

The fix is to stop mixing clocks:

- Frames, `probeNow()` and `reset()` all use the audio timeline.
- `record(page, ms)` waits for the **timeline** to advance by `ms`, via `__goProbe.advance()`,
  instead of sleeping for `ms` of wall time.
- `advance()` waits on **both** clocks, whichever is slower. The timeline governs how much audio is
  captured, but the module is not purely audio-driven — debounces, the engine's scheduler and
  Foundry's document round-trips run on wall time, so returning the moment a fast audio clock has
  caught up would hand back a long recording of a change the module had not finished making. On a
  normal machine the two are the same number and nothing changes.
- The probe raises a clear error if the timeline stops advancing, so a *suspended* context — the
  opposite failure — reports itself instead of hanging.

`status().clockRatio` reports the measured rate, and the smoke spec prints it. It is 1.0 on a
desktop. It is logged rather than asserted: a fast clock is unusual, not broken, and the harness is
now indifferent to it.

The workflow additionally exports `XDG_RUNTIME_DIR` and `PULSE_SERVER` and prints `pactl info`, so
Chrome can actually reach the PulseAudio server rather than falling back to its dummy backend. That
is belt-and-braces — the harness no longer depends on it — and the printed ratio will say whether
it worked.

### Root cause: the canvas starves the main thread, and every window slides

The third run (`release-0.0.1c`) was the informative one. The audio clock now read **1.0x** — the
PulseAudio fix worked — and the smoke canary *passed*. But three combat specs still failed, and
the trace uploaded with them showed why. These are wall-clock durations of calls into the page:

| Call | On the runner |
|---|---|
| `window.__goProbe.status()` — a no-op | **2.4 s – 7.0 s** |
| `window.__goProbe.reset()` | 2.6 s |
| `playCurrentTrack()` | 8.2 s |
| `preloadPlaylist()` | 20.3 s |

A CI runner has no GPU, so Foundry's PIXI canvas renders through SwiftShader on the CPU and
saturates the main thread. Every `page.evaluate` then queues behind the render loop.

That is fatal to *this* tier specifically. `recordDuring(page, ms, action)` starts recording, runs
the action, and the spec asserts from "1 s in" — but if the action takes eight seconds to reach the
page, "1 s in" is audio from seven seconds **before** the change. The failures read as module bugs
and were nothing of the sort:

- `expected silence` — the window covered the area track still legitimately playing, before the
  suppression landed.
- `expected entry order [alpha, charlie], got [alpha]` — the mood switch landed so late that
  charlie had barely entered by the end of the capture.

Two fixes, and both are needed:

1. **`session.mjs#quietCanvas` stops the PIXI ticker** once the world is up. Nothing this tier
   measures is drawn, so no coverage is lost and the main thread comes back.

   Foundry's own "Disable Canvas" setting is the wrong tool, and was tried first: with
   `core.noCanvas` on, `canvas` is null and `TokenDocument#_onDeleteOperation` dereferences it, so
   deleting a token throws `Cannot read properties of null (reading 'clipboard')`. Combat needs a
   token and teardown needs to delete it, so every combat spec broke in teardown instead.

2. **`recordDuring` returns a `mark` as well as frames**, and windows are computed from it. The
   mark is the timeline position at which the action actually landed, so `{from: mark + 1000}`
   means what it says no matter how long the page took to accept the call. This is house rule 7
   applied to the one place that had not adopted it.

The same conflation existed *between* clients: the multi-client specs took marks on the GM and
applied them to the player's frames. Each page's probe has its own origin and its own audio clock,
so those are different timelines — milliseconds apart on an idle machine, seconds apart otherwise.
That is what made the solo spec pass alone and flake in a full run. Both specs now mark each client
separately, and `expectClientsAgree` takes `windowA`/`windowB`.

`mainThreadLatency()` measures a no-op round trip, and the smoke spec prints it next to
`clockRatio`. Neither is asserted — there is no defensible threshold, and the number that matters
is whether it reads 5 ms or 5000 ms. Both have now caused a whole-suite failure, so both are
printed in the first fifteen seconds of every run.

## Debugging a failure

Every assertion attaches an ASCII timeline on failure:

```
alpha (383 Hz)    |@@@@@@@@@@%*=-.                        |
bravo (576 Hz)    |          .-=*%@@@@@@@@@@@@@@@@@@@@@@@@|
                   0ms                              8000ms
```

That answers "wrong track, wrong level, or wrong timing?" in one look — which a bare
`expected 0.31 to be close to 0.5` does not, and re-running a real-time suite to add logging is
expensive.

Then, in order:

1. `describeState(page)` — what the module *thought* was playing. Distinguishes a resolution bug
   from a playback bug, the one question the probe cannot answer.
2. The Playwright trace and video (`retain-on-failure`).
3. `docker compose -f itest/docker/docker-compose.yml logs`.

**Empty timeline?** The probe never attached, or audio never unlocked. `__goProbe.status()`
reports both.

---

## Findings from building this

Recorded because they are the kind of thing that gets "cleaned up" later, and because most of them
cost a full debugging round each. Everything below was **confirmed live** against 14.364.

### About the module and Foundry

- **`fadeDuration` is in seconds; `graphCrossfade` is in milliseconds.** Nothing in the names says
  so. A spec setting `fadeDuration: 500` meaning half a second gets a **500 second** fade, and the
  symptom is a track that appears never to stop, at constant full level, while the module correctly
  reports the new context as the winner. Use `setFadeDuration()` / `setGraphCrossfade()`, which
  both take ms and validate the range.
- **`UNSEQUENCED` is `-1`.** Foundry's modes are `DISABLED: -1`, `SEQUENTIAL: 0`, `SHUFFLE: 1`,
  `SIMULTANEOUS: 2`. An out-of-range mode makes `Playlist.create` reject and the failure surfaces
  as `Cannot read properties of undefined (reading 'sounds')` one line later.
- **Overlay bindings nest under `overlays`**: `music.area.overlays.tense.playlist`, not
  `music.area.tense.playlist`. The flat guess stores fine and reads back as nothing, so the mood
  never changes the music and nothing errors.
- **The mix flag's master gain key is `gain`**, not `master`. An unknown key normalizes to the
  default, so the mix is silently ignored.
- **A combat must be `active`, not merely `started`.** The module resolves through
  `game.combats.active`; a created-and-started-but-not-activated combat changes nothing while every
  piece of combat state looks right.
- **Every graph hand-off crossfades by the configured duration, including the first** — and the
  claim that the first one *never* crossfades, which this page asserted for three revisions, was a
  measurement artifact. Measured on a three-node walk with the canvas render loop stopped:

  | `graphCrossfade` | A → B (first) | B → C (later) |
  |---|---|---|
  | 0 ms | 0–310 ms | < 150 ms |
  | 1000 ms | ~1050 ms | ~1000 ms |

  The old numbers (0 ms, 0 ms, 40 ms for the first hand-off) were taken while PIXI was rendering,
  and a tidy explanation was built on them: the engine arms the next start against the
  `AudioContext` clock ahead of time, and the first node has no prior node to arm from. Plausible,
  and wrong — what was actually being measured was that arming deadline being **missed under
  main-thread contention**. With the thread free the first hand-off overlaps like any other,
  reproducibly. It does stay the loose one: it still trails up to ~310 ms with the crossfade at
  zero, where later hand-offs cut inside a single analysis frame.

  This is the most valuable thing the tier taught, and it is a warning about the tier: a plausible
  story that fits the numbers is not a finding until the numbers are reproduced with the main
  thread free. See house rule 9.
- **Ducking is exactly right.** Sound volume goes 1 → 0.4 → 1 with the document volume untouched,
  and the measured level ratios are 0.399 and 1.011. An earlier apparent failure was the harness
  measuring during the fade-in ramp.

### About the harness itself

- **Foundry runs three `AudioContext`s**, so the `connect` patch installs three taps, each on its
  own clock. Merging them by time-bucketing is the obvious approach and is **wrong**: a bucket
  often holds a frame from only one context, and when that one is idle the bucket reads zero - a
  hole punched through a tone that never stopped. `entryOrder()` then reports the same track
  entering four times. `merge()` uses sample-and-hold instead.
- **Starting or stopping a track emits a broadband transient** that lights up a neighbouring bin
  for exactly one frame, at full scale. Raw presence tests therefore report tracks that never
  played. `sustainedTones()` requires a continuous run (default 150 ms), and `crossfade()` measures
  the longest *contiguous* overlap rather than first-to-last.
- **The first tone table was broken.** 683 Hz sat 9 Hz from 337 Hz's second harmonic - the same
  analysis bin. Re-solved for maximum worst-case harmonic distance (88 Hz).
- **The audibility floor was too low.** Measured worst-case leakage is ~0.0015; the original 0.002
  floor left 1.3x margin, which would have let one playing track intermittently register as two.
  Now 0.005, asserted against measured leakage.
- **Two actors over the same sounds is a race.** The solo spec both bound its playlist to the
  scene and started it with `playAll()`, so the module's own resolution competed with the manual
  start - passing alone, failing intermittently in a full run. The mixer applies to any playing
  playlist, so the binding was simply removed.
- **Real-time windows must be anchored to marks.** Under full-suite load the same phase takes twice
  as long as it does in isolation, and windows computed from nominal phase lengths measure the
  wrong audio - passing alone, failing in the suite. On a CI runner the same effect appears as an
  eight-second gap between starting a recording and the action reaching the page, which is why
  `recordDuring` returns a mark.
- **A mark belongs to one page.** The multi-client specs took marks on the GM and applied them to
  the player's frames - two probes, two origins, two audio clocks. Milliseconds apart on an idle
  machine and seconds apart otherwise, so the solo spec passed alone and flaked in a full run for
  the second time, from a different cause than the first.
- **`assertProbeHealthy` had to wait, not sample.** Foundry creates its contexts lazily and the
  worklet attaches asynchronously on top of that, so a client that has just joined legitimately
  has zero taps for a moment. Sampling once made the *second* client intermittently fail with
  "audio probe never attached" - a real race, but in the assertion rather than in anything it was
  checking.
- **`down -v` used to throw away the 140 MB Foundry download**, because the image caches it inside
  the named volume. The cache is now a host mount (`itest/.cache/`) and survives teardown.

### About the container

- **The mounts break Foundry's own startup.** Docker creates the parents of the nested bind mounts
  (`/data/Data/modules`, `/data/Data/gameorchestra-itest`) as `root:root` before the entrypoint
  runs, and Foundry's image user then cannot create their siblings - it dies on
  `EACCES: mkdir '/data/Data/systems'` before serving anything. Chowning from the entrypoint cannot
  help; the daemon makes those directories. The image's `FOUNDRY_UID`/`FOUNDRY_GID` are
  **deprecated in v14 images and silently ignored**, so the fix is Docker-level `user: "0:0"`.
- **Until the EULA is signed every route 302s to `/license`**, so the world never becomes active and
  nothing says why.
- **A fresh install has no game system at all**, and world creation hard-fails without one.
- **Creating a world seeds a `Gamemaster` with a password** - not the admin key, not blank, stored
  salted and hashed - so the ordinary join form is closed on a fresh world. `global-setup.mjs` uses
  the admin `loginAs` route instead.

## Not covered by this tier either

- **The editor's Drawflow interop.** Still manual — see `testing.md`.
- **Foundry's provisioning routes.** Verified against 14.364 (see the table above), but still the
  piece most likely to break on a version bump. It breaks at startup with the server's own error,
  which is the failure mode to prefer.
- **The crossfade on a track cut short mid-playback.** The graph specs cover natural `onEnd`
  hand-offs; a graph that advances while a track is still sounding needs a scenario the harness
  does not build yet.
- **Perceptual quality.** The probe measures amplitude per frequency, not whether a fade *sounds*
  smooth. Equal-power versus linear crossfade is out of scope.
- **More than two clients**, and GM handoff on disconnect.
