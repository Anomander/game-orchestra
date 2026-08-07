/**
 * Compilation, gating and execution bookkeeping for user-supplied script code — the Script node's
 * inline mode.
 *
 * Split out from both the engine and the editor because three separate consumers need the same
 * answers and none of them should each invent one: the engine (does this compile, may it run, how
 * long may it take), the validator (does this compile, may it run), and the inspector (may this
 * user even edit it).
 *
 * ## What this module is NOT
 *
 * It is **not** a sandbox. Compiled source runs with the head GM's full privileges, exactly like a
 * Foundry macro, and nothing here pretends otherwise. The security boundary is
 * {@link inlineScriptsAllowed} — one world setting, GM-only, default off — and it is documented in
 * docs/api-and-script-node-plan.md § B5 rather than implied by this file's existence.
 *
 * ## One shape
 *
 * Inline Script-node source, compiled as an `AsyncFunction` so it may `await`; its return value is
 * ignored. A macro-mode node does not come through here at all - core compiles those, which is why
 * a blocked Content-Security-Policy leaves macro mode working.
 */

import { CONST } from './config.mjs';
import { log, emitHook } from './helpers.mjs';

/**
 * Cached answer to "can this deployment construct a function at all?".
 * `null` = not probed yet. See {@link canCompileScripts}.
 * @type {boolean|null}
 */
let _canCompile = null;

/** Compiled-source cache, keyed by `${kind}:${source}`. Holds failures as well as successes. */
const _compiled = new Map();

/**
 * Registries of playlist ids whose engine is currently executing a script.
 *
 * A **Set of Sets**: each entry is a running engine tree's own in-flight registry, which child
 * engines already share *by reference* (see CustomPlaybackEngine's `_registry`). Holding the
 * registry rather than a single playlist id is what makes the re-entrancy guard cover the whole
 * tree — a script inside a nested Playlist node's child engine must not be able to restart the
 * root.
 * @type {Set<Set<string>>}
 */
const _executing = new Set();

/**
 * Whether this deployment permits runtime function construction.
 *
 * **Probed once and cached**, rather than verified once and assumed (docs/api-and-script-node-plan.md
 * D-B6). An integration test can only ever prove that *stock* Foundry at the pinned version allows
 * this; a hosted Foundry behind a hardening reverse proxy can add a Content-Security-Policy the
 * test container never sees. Asking the deployment itself is correct everywhere.
 *
 * A `false` here makes inline script source inert **with a visible reason** rather than silently
 * broken - the editor renders the field disabled and validation raises a warning.
 * Macro-mode Script nodes are unaffected: core compiled those, not us.
 * @returns {boolean}
 */
export function canCompileScripts() {
  if (_canCompile !== null) return _canCompile;
  try {
    // eslint-disable-next-line no-new-func
    _canCompile = new Function('return 1;')() === 1;
  } catch (error) {
    _canCompile = false;
    log(1, 'Game Orchestra: this deployment blocks runtime function construction (Content-Security-Policy). Inline Script nodes are disabled; macro-based ones still work.', error);
  }
  return _canCompile;
}

/**
 * Reset the cached CSP probe. Tests only - production probes once per page load.
 * @param {boolean|null} [value] - Force a value, or null to re-probe on next call.
 */
export function setCanCompileScripts(value = null) {
  _canCompile = value;
  _compiled.clear();
}

/**
 * Whether stored inline script source may execute in this world.
 *
 * The **entire** enforcement boundary for inline code, and deliberately a world setting rather than
 * a per-user check: the engine only ever runs on the head GM, so a `game.user.can('MACRO_SCRIPT')`
 * test at execution time would always pass and defend nothing (that mistake is recorded in
 * docs/api-and-script-node-plan.md § B5).
 *
 * Anyone who can edit a playlist can *store* code; only a GM can let any of it *run*.
 * @returns {boolean}
 */
export function inlineScriptsAllowed() {
  if (!canCompileScripts()) return false;
  try {
    return !!game.settings.get(CONST.moduleId, CONST.settings.allowInlineScripts);
  } catch {
    return false; // settings not registered yet - fail closed, never open
  }
}

/**
 * Whether this user may author inline script source.
 *
 * **An editor affordance, not a boundary**, and deliberately not enforced on `api.graph.set()`.
 * Gating the API would look like a security control while being trivially bypassed by a raw
 * `playlist.setFlag()`, which this module cannot intercept at all - so the only honest place for
 * the real decision is {@link inlineScriptsAllowed}, which is checked at *execution* time and
 * therefore covers every write path including the ones we do not own.
 *
 * What it does gate: the inspector's source field (rendered disabled) and a validation warning.
 * Both tell an author "this will not run for you" before they invest in writing it.
 * @returns {boolean}
 */
export function canAuthorInlineScripts() {
  return !!game.user?.can?.('MACRO_SCRIPT');
}

/** How long a Script node may hold its token before the engine gives up on it. */
export function scriptTimeoutMs() {
  try {
    const ms = Number(game.settings.get(CONST.moduleId, CONST.settings.scriptTimeout));
    return Number.isFinite(ms) && ms > 0 ? ms : 5000;
  } catch {
    return 5000;
  }
}

/**
 * Compile inline Script-node source into an async function.
 *
 * Context values arrive as **named parameters**, matching how a Foundry script macro receives its
 * scope - so the same script body reads the same way whichever mode it is stored in. `ctx` is
 * passed alongside them so a future field can be added without changing this signature.
 * @param {string} source
 * @returns {{ok: true, fn: Function}|{ok: false, error: string}}
 */
export function compileScriptBody(source) {
  return _compile('body', source, (body) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('ctx', 'playlist', 'node', 'graph', 'run', 'api', 'log', body);
  });
}

/**
 * Compile-and-cache. Caches **failures too**, so a graph that loops back through a broken Script
 * node does not recompile the same bad source on every pass.
 * @param {string} kind
 * @param {string} source
 * @param {(body: string) => Function} build
 * @returns {{ok: true, fn: Function}|{ok: false, error: string}}
 * @private
 */
function _compile(kind, source, build) {
  const body = String(source ?? '');
  if (!body.trim()) return { ok: false, error: 'empty' };
  if (!canCompileScripts()) return { ok: false, error: 'csp' };
  const key = `${kind}:${body}`;
  if (_compiled.has(key)) return _compiled.get(key);
  let result;
  try {
    result = { ok: true, fn: build(body) };
  } catch (error) {
    result = { ok: false, error: `${error?.name ?? 'Error'}: ${error?.message ?? error}` };
  }
  _compiled.set(key, result);
  return result;
}

/**
 * Whether a source string compiles, for validation. Never executes it.
 *
 * `graph-validation.mjs` is **pure** and must stay that way, so it cannot call this - the caller
 * runs the check and passes the result in through `validateGraph`'s options object, exactly as it
 * already does for `playlists` and `moodIds`.
 * @param {string} source
 * @returns {boolean}
 */
export function scriptCompiles(source) {
  const result = compileScriptBody(source);
  // 'csp' is not a syntax problem - on a deployment that blocks compilation entirely, every script
  // would otherwise be reported as a syntax error, which is both wrong and unactionable.
  return result.ok || result.error === 'csp';
}

/**
 * Mark an engine tree as executing a script, for the re-entrancy guard (D-B1).
 * @param {Set<string>} registry - The engine tree's shared in-flight playlist registry.
 */
export function beginScriptExecution(registry) {
  if (registry) _executing.add(registry);
}

/**
 * Release the mark. **Must run on every exit path** - timeout and throw included. A leaked entry
 * makes that playlist permanently unwritable through the API for the rest of the session, the same
 * failure mode as a leaked `_registry` entry.
 * @param {Set<string>} registry
 */
export function endScriptExecution(registry) {
  if (registry) _executing.delete(registry);
}

/** @returns {boolean} Whether any engine is currently executing a script. */
export function isScriptExecuting() {
  return _executing.size > 0;
}

/**
 * Whether a playlist belongs to an engine tree that is currently executing a script - i.e. whether
 * rewriting or stopping it right now would tear down the engine running the caller.
 * @param {string} playlistId
 * @returns {boolean}
 */
export function isExecutingScriptFor(playlistId) {
  if (!playlistId) return false;
  for (const registry of _executing) if (registry.has(playlistId)) return true;
  return false;
}

/** Clear all execution marks. Tests only. */
export function resetScriptExecution() {
  _executing.clear();
}

/**
 * Report a script failure: level-1 log plus the public `gameOrchestraScriptError` hook.
 *
 * Every failure path routes through here so a listener sees the same payload whether the script
 * was blocked, failed to compile, threw, or timed out - and so the token-follows-the-exit rule has
 * exactly one place that records why.
 * @param {object} detail
 * @param {'blocked'|'compile'|'execute'|'timeout'|'missing'} detail.phase
 * @param {string|null} detail.playlistId
 * @param {string|null} detail.nodeId
 * @param {string} detail.message
 * @param {*} [detail.error]
 */
export function reportScriptError({ phase, playlistId = null, nodeId = null, message, error = null }) {
  log(1, `Game Orchestra: script ${phase} failure on node '${nodeId}' of playlist '${playlistId}': ${message}`, error ?? '');
  emitHook(CONST.hooks.SCRIPT_ERROR, { phase, playlistId, nodeId, message });
}
