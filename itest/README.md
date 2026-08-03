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
| `npm run down` | Stop and wipe the container |
| `npm run ci` | All of the above, in order |

Separate `package.json` on purpose: Playwright plus a browser is ~400 MB, and the module's own
suite must stay a three-second `npm test` with two dev dependencies.

## The parts that are tested without a browser

`harness/tones.mjs`, `harness/goertzel.mjs`, `harness/analysis.mjs`, `harness/worklet-source.mjs`
and `fixtures/generate.mjs` are pure and are exercised by the **main** vitest suite
(`tests/itest-analysis.test.mjs`, `tests/itest-goertzel.test.mjs`) — so run `npm test` in the repo
root after touching them. Keep them free of Playwright, Foundry and browser globals.
