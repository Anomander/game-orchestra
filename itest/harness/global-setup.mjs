/**
 * Playwright global setup: bring the *world* to the state every spec assumes.
 *
 * `bootstrap-world.mjs` gets the server to a running world; this gets the world to a usable one.
 * Three jobs, in order, because each depends on the last:
 *
 * 1. Get into the world as a Gamemaster.
 * 2. Create the `Itest GM` / `Itest Player` users the session fixtures join as.
 * 3. Enable `game-orchestra` and reload - a module that is installed but not enabled produces a
 *    world that loads perfectly and does nothing, which is the most confusing possible failure
 *    for a suite whose assertions are all about silence.
 *
 * ## Step 1 is not the obvious one
 *
 * Creating a world seeds a `Gamemaster` user that **has a password** - not the admin key, not
 * blank, and not recoverable (it is stored salted and hashed). The ordinary join form is
 * therefore closed to us on a fresh world.
 *
 * The way in is `POST /join {action: 'loginAs', userId}`, which Foundry provides for exactly this
 * situation: an admin session, or an existing GM, may assume any user's identity without their
 * password. So this authenticates as admin against `/auth` first, then assumes the seeded GM.
 * Verified against a live 14.364 server.
 *
 * The users this then creates are given **empty passwords**, which is what lets `session.mjs` use
 * the plain join form for every spec afterwards.
 *
 * `page.request` shares the browser context's cookie jar, so the admin session established over
 * HTTP is the same session the page then navigates with.
 */

import { chromium, expect } from '@playwright/test';

const MODULE_ID = 'game-orchestra';
const ADMIN_KEY = process.env.FOUNDRY_ADMIN_KEY ?? 'itest-admin';

/** The users the specs join as. Empty passwords, so the join form needs no secrets. */
export const REQUIRED_USERS = [
  { name: 'Itest GM', role: 4 },
  { name: 'Itest Player', role: 1 }
];

/**
 * @param {import('@playwright/test').FullConfig} config - Playwright's resolved config.
 * @returns {Promise<void>}
 */
export default async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  try {
    await enterWorldAsGamemaster(page, baseURL);
    await ensureUsers(page);
    await enableModule(page);
  } finally {
    await browser.close();
  }
}

/**
 * Get the page into the running world with Gamemaster privileges.
 * @param {import('@playwright/test').Page} page - A blank page.
 * @param {string} baseURL - Foundry server root.
 * @returns {Promise<void>}
 * @throws {Error} If no Gamemaster is offered on the join screen.
 */
async function enterWorldAsGamemaster(page, baseURL) {
  // Check the world is actually running before touching the UI. Without this, a server sitting on
  // the setup or licence screen - the normal state after a container restart, when nobody has run
  // `npm run bootstrap` - fails sixty seconds later as "no user option appeared", which describes
  // the symptom and hides the cause.
  const status = await page.request.get(`${baseURL}/api/status`).then((r) => r.json()).catch(() => ({}));
  expect(
    status.active === true && !!status.world,
    `no world is running at ${baseURL} (status: ${JSON.stringify(status)}). Run 'npm run bootstrap' first.`
  ).toBe(true);

  const auth = await page.request.post(`${baseURL}/auth`, { data: { adminPassword: ADMIN_KEY }, maxRedirects: 0 });
  expect(auth.status(), 'admin authentication was rejected - check FOUNDRY_ADMIN_KEY').toBe(302);

  // The join screen is rendered client-side from socket data, so the user list has to be read
  // from the live DOM rather than from the served HTML.
  await page.goto(`${baseURL}/join`);
  // waitForSelector is wrong here: it waits for *visibility*, and an <option> inside a closed
  // <select> is never "visible" to Playwright, so it times out while the options are sitting
  // right there in the DOM. Wait on the DOM state instead.
  await page.waitForFunction(
    () => document.querySelectorAll('select[name="userid"] option[value]:not([value=""])').length > 0,
    null,
    { timeout: 60_000 }
  );

  const gamemaster = await page.evaluate(() => {
    const options = [...document.querySelectorAll('select[name="userid"] option')].filter((option) => option.value);
    const gm = options.find((option) => /gamemaster/i.test(option.textContent ?? '')) ?? options[0];
    return gm ? { id: gm.value, name: gm.textContent?.trim() } : null;
  });
  expect(gamemaster, 'the world offers no users to join as').not.toBeNull();

  // Assume that user's identity as admin. The seeded Gamemaster's password is unknowable, so the
  // ordinary join form cannot be used here - see this file's header.
  const login = await page.request.post(`${baseURL}/join`, { data: { action: 'loginAs', userId: gamemaster.id } });
  expect(login.ok(), `loginAs ${gamemaster.name} failed: ${await login.text()}`).toBe(true);

  await page.goto(`${baseURL}/game`);
  await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 120_000 });
}

/**
 * Create the spec users if they are missing.
 * @param {import('@playwright/test').Page} page - A page inside the world, as a GM.
 * @returns {Promise<void>}
 */
async function ensureUsers(page) {
  const users = await page.evaluate(async (wanted) => {
    for (const spec of wanted) {
      if (!game.users.getName(spec.name)) await User.create({ name: spec.name, role: spec.role, password: '' });
    }
    return game.users.contents.map((user) => user.name);
  }, REQUIRED_USERS);

  expect(users, 'integration users were not created').toEqual(expect.arrayContaining(REQUIRED_USERS.map((u) => u.name)));
}

/**
 * Enable the module and confirm it actually initialises.
 * @param {import('@playwright/test').Page} page - A page inside the world, as a GM.
 * @returns {Promise<void>}
 */
async function enableModule(page) {
  const alreadyEnabled = await page.evaluate(async (moduleId) => {
    const configuration = foundry.utils.deepClone(game.settings.get('core', 'moduleConfiguration'));
    if (configuration[moduleId]) return true;
    configuration[moduleId] = true;
    await game.settings.set('core', 'moduleConfiguration', configuration);
    return false;
  }, MODULE_ID);

  if (!alreadyEnabled) {
    await page.reload();
    await page.waitForFunction(() => window.game?.ready === true, null, { timeout: 120_000 });
  }

  // Catching this here, once, is worth a great deal: if the module fails to initialise, every
  // spec instead fails as "silence" and the real cause is one line in a console nobody reads.
  await page.waitForFunction(
    (moduleId) => !!window.game?.modules?.get(moduleId)?.active && !!window.game?.gameOrchestra?.musicController,
    MODULE_ID,
    { timeout: 30_000 }
  );
}
