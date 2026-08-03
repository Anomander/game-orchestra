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

  await unlockAudio(page);
  return page;
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
  const status = await page.evaluate(() => window.__goProbe.status());
  expect(status.attached, `audio probe never attached: ${status.errors.join('; ') || 'no AudioContext was created'}`).toBeGreaterThan(0);
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
 * @param {import('@playwright/test').Page} page - A probed page.
 * @returns {Promise<number>} Milliseconds since the probe was last reset.
 */
export async function probeNow(page) {
  return page.evaluate(() => window.__goProbe.now());
}

/**
 * Record for a fixed wall-clock duration and return the captured timeline.
 *
 * Integration specs run in real time - there is no fake clock, because the thing under test is
 * the real audio pipeline. Keep durations tight; the suite's runtime is the sum of these.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @param {number} ms - How long to record.
 * @returns {Promise<import('./analysis.mjs').ProbeFrame[]>} Frames captured during the window.
 */
export async function record(page, ms) {
  await page.waitForTimeout(ms);
  return page.evaluate(() => window.__goProbe.frames());
}

/**
 * Run an action and record the audio it produces, from just before it starts.
 * @param {import('@playwright/test').Page} page - A probed page.
 * @param {number} ms - How long to keep recording after the action resolves.
 * @param {() => Promise<void>} action - The state change under test.
 * @returns {Promise<import('./analysis.mjs').ProbeFrame[]>} Frames from the action onward.
 */
export async function recordDuring(page, ms, action) {
  await resetProbe(page);
  await action();
  return record(page, ms);
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
