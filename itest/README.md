# itest — audio integration tier

Runs the module in a **real, pinned Foundry** and asserts on **what actually comes out of the
speakers**, by making every fixture track a sine tone at a known frequency and measuring each
frequency independently.

**The design, the house rules, and the reasoning are in
[docs/wiki/integration-testing.md](../docs/wiki/integration-testing.md). Read that before changing
anything here.** This file is only the quickstart.

---

## Quickstart

Foundry is licensed software; it is never committed here. The container downloads it with your
credentials.

```bash
npm install
npx playwright install --with-deps chromium

export FOUNDRY_USERNAME=… FOUNDRY_PASSWORD=…    # or FOUNDRY_RELEASE_URL=…
npm run ci
```

| Script | Does |
|---|---|
| `npm run fixtures` | Render the tone bank into `fixtures/out/` |
| `npm run up` | Start Foundry at `module.json`'s `compatibility.verified` |
| `npm run bootstrap` | Create and launch the test world |
| `npm test` | Run the specs |
| `npm run test:headed` / `test:ui` | Debug |
| `npm run down` | Stop the container and **destroy the data volume** — read the warning below |
| `npm run ci` | All of the above, in order |

Set `ITEST_AGAINST_DIST=1` to run the suite against the minified release build rather than the
working tree — `up.sh` runs `npm run build` and mounts `dist/`. The release gate and the nightly
both do this; see [docs/wiki/packaging.md](../docs/wiki/packaging.md). It is also the reason specs
and harness helpers may only reach the module through `game.modules.get('game-orchestra').api` and
`game.gameOrchestra`: `dist/` ships one bundled `scripts/game-orchestra.mjs`, so a deep import like
`import('/modules/game-orchestra/scripts/helpers.mjs')` 404s there.

### `npm run down` destroys your Foundry licence activation

It is `docker compose down -v`, and the `-v` takes the data volume with it. The volume holds
`/data/Config/license.json`. The host-side cache in `.cache/` preserves the 140 MB *download*, not
the *activation* — so without `FOUNDRY_USERNAME`/`FOUNDRY_PASSWORD` to hand, the next `up` lands on
`/license` and every spec fails in `globalSetup` waiting for a user list that never renders.

**This matters because the failure that tempts you to run it is not fixed by running it.** After a
container is recreated (changing the module mount does this), Foundry can die on:

```
A fatal error occurred while trying to start the Foundry Virtual Tabletop server:
Foundry VTT cannot start in this directory which is already locked by another process.
```

That is a stale lock left by the previous container, not a broken volume. Clear it in place:

```bash
docker compose -f docker/docker-compose.yml down          # no -v
docker run --rm -v docker_foundry-data:/data alpine rm -rf /data/Config/options.json.lock
npm run up
```

It is a *directory*, not a file — `rm -f` fails on it, which is its own small trap. Reserve
`npm run down` for when you actually want a clean world and have credentials available.

### The port is 30001, not 30000

Deliberately not Foundry's own default. A personal Foundry already listening on the host's 30000
**shadows** the container's port publish rather than colliding with it — `docker compose up`
reports no conflict, and everything the harness does then lands on that live server. *Confirmed
live:* `npm run bootstrap` tried to install a system and create a world on a developer's real
instance, and was stopped only by its admin key not happening to be `itest-admin`.

Nothing needs setting; 30001 is the default on both sides. If it is also taken, override **both**
halves — they are read by different processes:

```bash
export FOUNDRY_PORT=30002              # compose: which host port to publish on
export FOUNDRY_URL=http://localhost:30002   # bootstrap + the specs: where to point
```

Separate `package.json` on purpose: Playwright plus a browser is ~400 MB, and the module's own
suite must stay a three-second `npm test` with two dev dependencies.

## The parts that are tested without a browser

`harness/tones.mjs`, `harness/goertzel.mjs`, `harness/analysis.mjs`, `harness/worklet-source.mjs`
and `fixtures/generate.mjs` are pure and are exercised by the **main** vitest suite
(`tests/itest-analysis.test.mjs`, `tests/itest-goertzel.test.mjs`) — so run `npm test` in the repo
root after touching them. Keep them free of Playwright, Foundry and browser globals.
