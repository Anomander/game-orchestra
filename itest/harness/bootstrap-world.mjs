#!/usr/bin/env node
/**
 * One-time server provisioning: sign the licence, install a system, create the world, launch it.
 *
 * Run once per fresh container, before Playwright. Idempotent - re-running against an already
 * bootstrapped instance is a no-op, so a local developer keeps their world (and its warm LevelDB)
 * across runs while CI always starts empty.
 *
 * ## Why this drives HTTP rather than the database
 *
 * Foundry's world data is a LevelDB directory. Committing one would mean committing a binary blob
 * that is version-locked to a specific Foundry build and unreadable in review - and it would
 * silently rot the first time the pinned version moved. Foundry's setup routes take the same JSON
 * actions its own Setup UI posts, so the world is built by asking the server to build it, in a
 * form that is diffable and that fails loudly if the API shape changes.
 *
 * ## The v14 route map, verified against a live 14.364 server
 *
 * This was **not** guessable, and an earlier draft of this file got every one of these wrong.
 * They were read out of `dist/server/views/*.mjs` in the running container and confirmed by
 * curling them:
 *
 * | Step | Route | Body |
 * |---|---|---|
 * | Sign EULA | `POST /license` | `{action: 'signEULA', agree: true}` |
 * | Admin session | `POST /auth` | `{adminPassword}` - **not** a `/setup` action |
 * | Install a system | `POST /setup` | `{action: 'installPackage', type: 'system', ...}` |
 * | Create a world | `POST /create` | `{action: 'createWorld', id, title, system}` |
 * | Launch it | `POST /setup` | `{action: 'launchWorld', world}` |
 *
 * Things that do **not** exist in v14 and cost time to discover: there is no `adminAuth` setup
 * action (`/auth` owns admin sessions), and no `createWorld` setup action (it lives on its own
 * `/create` route, because `CreateView` is a separate view class).
 *
 * Two more facts that shape the flow:
 *
 * - **A fresh install has no game system at all,** and `World.create` hard-fails with
 *   "The requested system does not seem to exist". So a system must be installed first. The
 *   module is system-agnostic, so this uses Simple Worldbuilding - the smallest official system.
 * - **Creating a world seeds a `Gamemaster` user with a *password*.** Not the admin key, and not
 *   recoverable. That is why `global-setup.mjs` gets into the world with the admin `loginAs`
 *   route instead of the ordinary join form.
 */

import { setTimeout as sleep } from 'node:timers/promises';

// 30001 by default - the harness deliberately does not sit on Foundry's own 30000, because a
// personal Foundry already listening there shadows the container's port publish instead of
// colliding with it, and this script would then provision a world on that live server. See
// scripts/up.sh.
const BASE_URL = process.env.FOUNDRY_URL ?? 'http://localhost:30001';
const ADMIN_KEY = process.env.FOUNDRY_ADMIN_KEY ?? 'itest-admin';
const WORLD_ID = process.env.FOUNDRY_WORLD ?? 'game-orchestra-itest';

/** The system installed to host the test world. Any system works; this is the smallest official one. */
const SYSTEM_ID = process.env.FOUNDRY_SYSTEM ?? 'worldbuilding';
const SYSTEM_MANIFEST =
  process.env.FOUNDRY_SYSTEM_MANIFEST ?? 'https://raw.githubusercontent.com/foundryvtt/worldbuilding/master/system.json';

/** Session cookie, captured from the first response that sets one and sent with every request. */
let cookie = '';

/**
 * POST JSON to a Foundry route, carrying and capturing the session cookie.
 * @param {string} path - Route path, e.g. `/setup`.
 * @param {object} body - JSON payload.
 * @returns {Promise<{status: number, body: object, redirect: string|null}>} The parsed response.
 *   Foundry answers some actions with a 302 and some with JSON, so both are returned rather than
 *   throwing on either.
 */
async function post(path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual'
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];

  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  // Foundry reports action failures as a 200 with an `error` key, so status alone is not enough.
  if (parsed.error) throw new Error(`${path} [${body.action ?? 'post'}] failed: ${parsed.error}`);

  return { status: response.status, body: parsed, redirect: response.headers.get('location') };
}

/**
 * Read the server's status endpoint.
 * @returns {Promise<{active?: boolean, world?: string, version?: string}>} Empty when unreachable.
 */
async function status() {
  return fetch(`${BASE_URL}/api/status`)
    .then((r) => r.json())
    .catch(() => ({}));
}

/**
 * Wait until the server answers at all.
 * @returns {Promise<void>}
 * @throws {Error} If it never comes up.
 */
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await status();
    if (state.version) return;
    await sleep(2000);
  }
  throw new Error(`Foundry never became reachable at ${BASE_URL}`);
}

/**
 * Sign the software licence agreement.
 *
 * Until this is done every route redirects to `/license` and nothing else can proceed - the
 * failure mode is a world that "never becomes active" with no other explanation, which is
 * precisely how this was first hit.
 * @returns {Promise<void>}
 */
async function signEula() {
  await post('/license', { action: 'signEULA', agree: true });
}

/**
 * Establish an admin session. Required by `/create` and by the package actions on `/setup`.
 * @returns {Promise<void>}
 * @throws {Error} If the admin key is rejected.
 */
async function authenticate() {
  const { redirect } = await post('/auth', { adminPassword: ADMIN_KEY });
  // A successful admin auth redirects to /setup; a failed one bounces back to /auth.
  if (redirect?.includes('/auth')) {
    throw new Error(
      `Admin authentication was rejected. The container's admin key must match FOUNDRY_ADMIN_KEY ('${ADMIN_KEY}') - ` +
        'if the data volume was created by an earlier run with a different key, `npm run down` and start again.'
    );
  }
}

/**
 * Install the game system the test world runs on, if it is not already present.
 *
 * `installPackage` returns `{}` immediately and does the work in the background, so this polls
 * until the system actually shows up rather than assuming the response means "done".
 * @returns {Promise<void>}
 * @throws {Error} If the system never appears.
 */
async function ensureSystem() {
  if (await hasSystem()) return;

  await post('/setup', { action: 'installPackage', type: 'system', id: SYSTEM_ID, manifest: SYSTEM_MANIFEST });

  for (let attempt = 0; attempt < 30; attempt++) {
    if (await hasSystem()) return;
    await sleep(1000);
  }
  throw new Error(`System '${SYSTEM_ID}' did not install from ${SYSTEM_MANIFEST}`);
}

/**
 * Whether the system is installed, tested by asking for its manifest as a static file.
 *
 * Foundry serves installed packages' files directly, so a 200 here means the system is on disk and
 * addressable. Scraping the `/setup` page instead does **not** work and cost a debugging round:
 * that page is rendered client-side from socket data, so the served HTML contains no package list
 * at all and the check reports "not installed" forever - even though the install had succeeded.
 * @returns {Promise<boolean>}
 */
async function hasSystem() {
  return fetch(`${BASE_URL}/systems/${SYSTEM_ID}/system.json`)
    .then((response) => response.ok)
    .catch(() => false);
}

/**
 * Create the world if it does not exist, then make sure it is the running one.
 * @returns {Promise<void>}
 */
async function ensureWorld() {
  const current = await status();
  if (current.active && current.world === WORLD_ID) return;

  if (!current.world) {
    try {
      await post('/create', {
        action: 'createWorld',
        id: WORLD_ID,
        title: 'Game Orchestra Integration',
        system: SYSTEM_ID
      });
    } catch (error) {
      // An existing world directory is the expected idempotent path on a warm volume.
      if (!/already exists/i.test(String(error.message))) throw error;
    }
  }

  await post('/setup', { action: 'launchWorld', world: WORLD_ID });

  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await status();
    if (state.active && state.world === WORLD_ID) return;
    await sleep(1000);
  }
  throw new Error(`World '${WORLD_ID}' never became active`);
}

await waitForServer();
await signEula();
await authenticate();
await ensureSystem();
await ensureWorld();

const final = await status();
console.log(`World '${final.world}' (${final.system} ${final.systemVersion}) running on Foundry ${final.version} at ${BASE_URL}`);
