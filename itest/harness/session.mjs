/**
 * Playwright fixtures: a logged-in Foundry client with a working audio probe.
 *
 * Exposes `test` (extended from `@playwright/test`) with two fixtures:
 *
 * - `gm`      - an authenticated Gamemaster client with the probe attached and audio unlocked.
 * - `player`  - the same for a non-GM user, created lazily so specs that do not need a second
 *               client do not pay for one.
 *
 * ## Three things here are load-bearing and non-obvious
 *
 * 1. **The probe init script must be added before `page.goto`.** It patches
 *    `AudioNode.prototype.connect`, and any node Foundry connects before the patch lands is
 *    permanently untapped. Playwright's `addInitScript` is the only hook that reliably runs
 *    before page scripts on every navigation.
 *
 * 2. **Audio must be unlocked by a real gesture.** Browsers refuse to start an `AudioContext`
 *    without one, and Foundry surfaces this as `game.audio.locked`. Playwright's synthesised
 *    clicks are trusted events, so a single click on the canvas satisfies it - but it has to
 *    happen *after* the world is ready, or Foundry has not installed its unlock listener yet.
 *    A locked context does not error; it silently renders nothing, which would make every spec
 *    fail as "silence" with no clue why. {@link assertProbeHealthy} exists to convert that into
 *    a legible failure.
 *
 * 3. **The player client must join after the GM.** Head-GM election is "first active GM by id"
 *    (CLAUDE.md rule 5), so a player joining first is harmless, but the multi-client specs need
 *    to know which client owns the engine. Joining in a fixed order makes that deterministic.
 *
 * ## The canvas render loop is stopped, and that is a timing fix, not a tidiness one
 *
 * A CI runner has no GPU, so Foundry's PIXI canvas renders through SwiftShader on the CPU and
 * saturates the main thread. Every `page.evaluate` then queues behind the render loop: measured on
 * a GitHub runner, a *no-op* `window.__goProbe.status()` took **2.4-7.0 s**, `playCurrentTrack()`
 * took 8.2 s, and `preloadPlaylist` took 20 s. That is fatal to this tier specifically, because a
 * recording started before an action and asserted from "1 s in" is really asserting on audio from
 * eight seconds *before* the action landed. All three combat specs failed that way while the module
 * was behaving perfectly.
 *
 * {@link quietCanvas} stops the PIXI ticker once the world is up. Nothing this tier measures is
 * drawn, so no coverage is lost and the main thread comes back.
 *
 * **Foundry's own "Disable Canvas" setting is the wrong tool here, and was tried first.** With
 * `core.noCanvas` on, `canvas` is null, and `TokenDocument#_onDeleteOperation` dereferences it -
 * so deleting a token throws `Cannot read properties of null (reading 'clipboard')`. Combat needs
 * a token, and teardown needs to delete it, so every combat spec broke in teardown. Stopping the
 * ticker gets the same CPU back while leaving the canvas object graph intact for code that
 * reaches into it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test as base, expect } from '@playwright/test';

import { resetWorld } from './foundry-api.mjs';
import { toneFrequencies } from './tones.mjs';
import { buildWorkletSource } from './worklet-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Default credentials the bootstrapped world is provisioned with. */
export const USERS = {
  gm: { name: 'Itest GM', password: '' },
  player: { name: 'Itest Player', password: '' }
};

/**
 * Attach the audio probe to a page and log a user in.
 * @param {import('@playwright/test').BrowserContext} context - A fresh browser context.
 * @param {string} baseURL - Foundry server root.
 * @param {{name: string, password: string}} user - The user to join as.
 * @returns {Promise<import('@playwright/test').Page>} A ready page: world loaded, probe attached,
 *   audio unlocked.
 */
export async function join(context, baseURL, user) {
  const workletSource = buildWorkletSource();
  const probeSource = readFileSync(joinPath(here, 'probe-init.js'), 'utf8');

  await context.addInitScript(
    ({ frequencies, worklet }) => {
      window.__GO_PROBE_FREQUENCIES__ = frequencies;
      window.__GO_PROBE_WORKLET_SOURCE__ = worklet;
    },
    { frequencies: toneFrequencies(), worklet: workletSource }
  );
  await context.addInitScript(probeSource);

  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`[${user.name}] page error:`, error.message));

  await page.goto(`${baseURL}/join`);
  // The join screen is rendered client-side from socket data, so waiting for the <select> alone
  // races an empty one - the options arrive after it. It must be a DOM-state wait, not
  // waitForSelector: that waits for visibility, and an <option> in a closed <select> is never
  // visible to Playwright, so it times out with the options present in the DOM the whole time.
  await page.waitForFunction(
    (name) => [...document.querySelectorAll('select[name="userid"] option')].some((o) => o.textContent?.trim() === name),
    user.name,
    { timeout: 60_000 }
  );
  await page.selectOption('select[name="userid"]', { label: user.name });
  if (user.password) await page.fill('input[name="password"]', user.password);
  await page.click('button[name="join"]');

  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 120_000 });
  await page.waitForFunction(() => !!window.game?.gameOrchestra?.musicController, null, { timeout: 30_000 });

  await quietCanvas(page);
  await unlockAudio(page);
  return page;
}

/**
 * Stop the PIXI render loop, giving the main thread back to the module and to `page.evaluate`.
 *
 * See this file's header for why: on a GPU-less runner the software rasteriser makes every round
 * trip into the page take seconds, which silently shifts every measurement window in this tier.
 * The canvas object graph is left intact - only the ticker stops - so code that reaches into
 * `canvas` still works.
 * @param {import('@playwright/test').Page} page - A page with the world loaded.
 * @returns {Promise<void>}
 */
export async function quietCanvas(page) {
  const stopped = await page.evaluate(() => {
    const ticker = globalThis.canvas?.app?.ticker;
    if (!ticker) return false;
    ticker.stop();
    return true;
  });
  if (!stopped) {
    // Not fatal - a world with no active scene has no canvas to quieten - but if it happens on a
    // runner it is the first thing to suspect when timings look wrong, so say so.
    console.warn('no PIXI ticker to stop; if the main-thread round trip is slow, this is why.');
  }
}

/**
 * How long a round trip into the page currently takes.
 *
 * A trivial `page.evaluate` should return in a few milliseconds. When it does not, the page's main
 * thread is contended, and *every* timing in this tier is wrong in the same direction: the module's
 * state change lands late relative to the recording that is supposed to capture it. Reported rather
 * than asserted, because the number that matters is whether it is 5 ms or 5000 ms, and a threshold
 * would only invent a boundary between them.
 * @param {import('@playwright/test').Page} page - Any live page.
 * @returns {Promise<number>} Round-trip milliseconds, averaged over a few calls.
 */
export async function mainThreadLatency(page) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    await page.evaluate(() => 1);
    samples.push(Date.now() - start);
  }
  return Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
}

/**
 * Satisfy the browser's autoplay gate and wait for Foundry to report audio unlocked.
 * @param {import('@playwright/test').Page} page - A page with the world loaded.
 * @returns {Promise<void>}
 */
export async function unlockAudio(page) {
  await page.mouse.click(10, 10);
  await page.waitForFunction(() => window.game?.audio?.locked === false, null, { timeout: 15_000 });
}

/**
 * Fail loudly if the probe is not actually capturing.
 *
 * Every "was silent" assertion passes vacuously against an empty timeline, so this runs once per
 * spec before any measurement. A harness that can report green while measuring nothing is worse
 * than no harness.
 * @param {import('@playwright/test').Page} page - A page with the probe installed.
 * @returns {Promise<void>}
 */
export async function assertProbeHealthy(page) {
  // Waits, rather than sampling once. Foundry creates its `AudioContext`s lazily and the worklet
  // attaches asynchronously on top of that (`addModule` returns a promise), so a client that has
  // only just joined can legitimately have zero taps for a moment. Sampling immediately turned
  // that into an intermittent "audio probe never attached" on the second client - a real race,
  // but in the assertion rather than in anything it was checking.
  try {
    await page.waitForFunction(() => window.__goProbe.status().attached > 0, null, { timeout: 15_000 });
  } catch {
    // Re-read so the failure carries the probe's own explanation rather than a timeout message.
    const status = await page.evaluate(() => window.__goProbe.status());
    expect(status.attached, `audio probe never attached: ${status.errors.join('; ') || 'no AudioContext was created'}`).toBeGreaterThan(0);
  }
}

/**
 * Clear the probe timeline so a scenario's clock starts at zero.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @returns {Promise<void>}
 */
export async function resetProbe(page) {
  await page.evaluate(() => window.__goProbe.reset());
}

/**
 * The probe's current timeline position, for anchoring measurement windows.
 *
 * Prefer `const mark = await probeNow(page)` over arithmetic on nominal phase lengths. A spec that
 * assumes "the duck starts at 5000 ms because I recorded 5 s first" is correct only while nothing
 * else competes for the machine; in a full suite run the same phase can take twice as long, and
 * every window then lands on the wrong audio. Marking is immune to that.
 *
 * This reads the **same clock the frames are stamped with** - the audio clock, which does not
 * necessarily run at realtime. Mixing it with `performance.now()` is precisely the bug that made
 * every spec fail on a CI runner.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @returns {Promise<number>} Milliseconds since the probe was last reset.
 */
export async function probeNow(page) {
  return page.evaluate(() => window.__goProbe.now());
}

/**
 * Record until the capture timeline has advanced by `ms`, and return it.
 *
 * **Timeline milliseconds, not wall-clock milliseconds** - and the difference is not academic. On
 * a CI runner whose null audio sink does not pace playback, the `AudioContext` renders several
 * times faster than realtime (measured 2.3x-5.6x, varying with load). Sleeping three wall seconds
 * there captured twelve seconds of audio, so every window a spec computed covered a quarter of the
 * material it meant to, and all twelve specs failed at once. Waiting on the clock the frames are
 * stamped with makes the suite indifferent to how fast that clock runs.
 *
 * The probe raises a clear error if the timeline stops advancing, so a suspended context fails
 * legibly instead of hanging until the test timeout.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @param {number} ms - Timeline milliseconds to record.
 * @returns {Promise<import('./analysis.mjs').ProbeFrame[]>} Frames captured since the last reset.
 */
export async function record(page, ms) {
  await page.evaluate((target) => window.__goProbe.advance(target), ms);
  return page.evaluate(() => window.__goProbe.frames());
}

/**
 * Run an action and record the audio around it.
 *
 * Returns a **mark** as well as the frames, and every window a caller computes must be relative to
 * that mark rather than to zero. The two are not the same instant: recording starts before the
 * action so the transition itself is captured, and the gap between them is however long the page
 * took to accept the call. Locally that is a few milliseconds and the distinction looks academic.
 * On a contended CI runner it was measured at **eight to ten seconds** - so `{from: 1000}` was
 * asserting on audio from seven seconds *before* the change it was meant to be testing, and three
 * specs failed while the module did exactly the right thing. Anchoring to the mark makes the
 * assertion mean what it says at any speed.
 *
 * Assertions about the transition itself - crossfades, entry order - need no anchor: they search
 * the whole capture for the overlap, and the pre-roll cannot contain one.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @param {number} ms - Timeline milliseconds to keep recording after the action resolves.
 * @param {() => Promise<void>} action - The state change under test.
 * @returns {Promise<{frames: import('./analysis.mjs').ProbeFrame[], mark: number}>} The capture,
 *   and the timeline position at which the action had landed.
 */
export async function recordDuring(page, ms, action) {
  await resetProbe(page);
  await action();
  const mark = await probeNow(page);
  const frames = await record(page, ms);
  return { frames, mark };
}

export const test = base.extend({
  /**
   * The Gamemaster client. One per test, so a failed test cannot leak a half-broken session.
   */
  gm: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext();
    const page = await join(context, baseURL, USERS.gm);
    await assertProbeHealthy(page);

    // Reset **before** the test, not only after. Specs share one world, so an afterEach alone
    // leaves every spec at the mercy of whatever the previous run left behind - and a run that
    // crashed, or was interrupted, never got to clean up at all. Then the first spec of the next
    // run fails on a stray tone it never started, which reads as a module bug. Resetting on the
    // way in makes each spec independent of history.
    await resetWorld(page);
    await use(page);
    await resetWorld(page);
    await context.close();
  },

  /**
   * A non-GM client, joined after the GM. Only instantiated by specs that request it.
   */
  player: async ({ browser, baseURL, gm }, use) => {
    void gm; // Ordering dependency: the GM must hold headship before the player joins.
    const context = await browser.newContext();
    const page = await join(context, baseURL, USERS.player);
    await use(page);
    await context.close();
  }
});

export { expect };
