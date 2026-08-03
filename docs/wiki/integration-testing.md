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
| **L2** | The module in real Foundry, measured by a real audio probe | Docker + Chromium | ~6 min, 12 specs | `cd itest && npm run ci` |
| **L3** | Two clients at once (GM + player) | same as L2 | included in L2 | — |

L1 is the unusual one and it is deliberate: `itest/harness/analysis.mjs`, `goertzel.mjs`,
`tones.mjs`, `worklet-source.mjs` and `fixtures/generate.mjs` are pure, and
`tests/itest-analysis.test.mjs` + `tests/itest-goertzel.test.mjs` exercise them in the ordinary
vitest run. **An integration harness that can only be tested by the thing it tests is a harness
whose own bugs get blamed on the module.** Two real defects were caught by L1 before the harness
ever saw Foundry, and the tier as a whole flushed out a dozen more — see
[Findings](#findings-from-building-this).

**Status:** all 12 L2/L3 specs pass against Foundry **14.364**.

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
- **The first hand-off in a graph never crossfades.** Measured on a three-node walk:

  | `graphCrossfade` | A → B (first) | B → C (later) |
  |---|---|---|
  | 0 ms | 0 ms | 0 ms |
  | 500 ms | 0 ms | 320 ms |
  | 1000 ms | 40 ms | 760 ms |

  Later hand-offs scale with the setting; the first does not overlap at all. That fits the engine's
  armed-start design - there is no prior node to arm from - and is now asserted both ways so a
  change has to be deliberate.
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
  wrong audio - passing alone, failing in the suite.
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
