import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting } from './mocks/foundry.mjs';

setupFoundryMocks();

import {
  beginScriptExecution,
  canAuthorInlineScripts,
  canCompileScripts,
  compileScriptBody,
  endScriptExecution,
  inlineScriptsAllowed,
  isExecutingScriptFor,
  isScriptExecuting,
  reportScriptError,
  resetScriptExecution,
  scriptCompiles,
  scriptTimeoutMs,
  setCanCompileScripts
} from '../scripts/script-runtime.mjs';
import { CONST } from '../scripts/config.mjs';

describe('script-runtime.mjs', () => {
  beforeEach(() => {
    setupFoundryMocks();
    setCanCompileScripts(null);
    resetScriptExecution();
    game.user.can = vi.fn(() => true);
  });

  describe('the CSP probe', () => {
    it('reports true in an environment that permits function construction', () => {
      expect(canCompileScripts()).toBe(true);
    });

    it('caches its answer rather than re-probing', () => {
      canCompileScripts();
      setCanCompileScripts(false);
      expect(canCompileScripts()).toBe(false);
    });

    /**
     * The reason this is a runtime probe and not a one-off verification (D-B6): an integration test
     * can only prove that STOCK Foundry at the pinned version allows compilation. A hosted Foundry
     * behind a hardening proxy can add a CSP the test container never sees. Asking the deployment
     * itself is correct everywhere - and the required behaviour is to go inert, not to throw.
     */
    it('makes inline scripts inert - not broken - when compilation is blocked', () => {
      setCanCompileScripts(false);
      setMockSetting(CONST.moduleId, CONST.settings.allowInlineScripts, true);

      expect(inlineScriptsAllowed()).toBe(false);
      expect(compileScriptBody('return 1;')).toEqual({ ok: false, error: 'csp' });
      // NOT reported as a syntax error: on a locked-down host every script would otherwise be
      // flagged as malformed, which is both wrong and unactionable.
      expect(scriptCompiles('return 1;')).toBe(true);
    });
  });

  describe('the inline gate', () => {
    it('is closed by default - a world must opt in', () => {
      expect(inlineScriptsAllowed()).toBe(false);
    });

    it('opens only when the world setting is on', () => {
      setMockSetting(CONST.moduleId, CONST.settings.allowInlineScripts, true);
      expect(inlineScriptsAllowed()).toBe(true);
    });

    it('fails CLOSED when settings are not registered yet, never open', () => {
      game.settings.get = vi.fn(() => { throw new Error('not registered'); });
      expect(inlineScriptsAllowed()).toBe(false);
    });

    it('reads authorship permission from Foundry rather than re-deriving it', () => {
      game.user.can = vi.fn((permission) => permission === 'MACRO_SCRIPT');
      expect(canAuthorInlineScripts()).toBe(true);
      game.user.can = vi.fn(() => false);
      expect(canAuthorInlineScripts()).toBe(false);
    });
  });

  describe('compilation', () => {
    it('compiles a script body into something awaitable', async () => {
      const result = compileScriptBody('return playlist;');
      expect(result.ok).toBe(true);
      await expect(result.fn({}, 'the-playlist')).resolves.toBe('the-playlist');
    });

    it('reports a syntax error rather than throwing', () => {
      const result = compileScriptBody('return (;');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/SyntaxError/);
    });

    it('caches FAILURES as well as successes, so a looping graph does not recompile bad source', () => {
      const first = compileScriptBody('return (;');
      const second = compileScriptBody('return (;');
      expect(first.ok).toBe(false);
      expect(second).toBe(first); // the same object back: not recompiled
    });

    it('treats empty source as empty, not as a syntax error', () => {
      expect(compileScriptBody('   ')).toEqual({ ok: false, error: 'empty' });
    });
  });

  describe('the timeout setting', () => {
    it('defaults to 5s', () => {
      expect(scriptTimeoutMs()).toBe(5000);
    });

    it('honours the world setting', () => {
      setMockSetting(CONST.moduleId, CONST.settings.scriptTimeout, 12000);
      expect(scriptTimeoutMs()).toBe(12000);
    });

    it('falls back to 5s for a malformed or non-positive value, never to zero', () => {
      // A zero timeout would make every Script node give up before running, which looks exactly
      // like the node doing nothing.
      setMockSetting(CONST.moduleId, CONST.settings.scriptTimeout, 0);
      expect(scriptTimeoutMs()).toBe(5000);
      setMockSetting(CONST.moduleId, CONST.settings.scriptTimeout, 'soon');
      expect(scriptTimeoutMs()).toBe(5000);
    });
  });

  describe('the re-entrancy registry (D-B1)', () => {
    it('reports a playlist as busy only while its own tree is executing', () => {
      const registry = new Set(['pl1', 'pl2']);
      expect(isExecutingScriptFor('pl1')).toBe(false);

      beginScriptExecution(registry);
      expect(isScriptExecuting()).toBe(true);
      // Covers the WHOLE tree, not just the root: child engines share the registry by reference,
      // so a script in a nested Playlist node's target must not be able to restart the root.
      expect(isExecutingScriptFor('pl1')).toBe(true);
      expect(isExecutingScriptFor('pl2')).toBe(true);
      // Scoped, never global - rewriting a DIFFERENT playlist is a legitimate thing to do.
      expect(isExecutingScriptFor('other')).toBe(false);

      endScriptExecution(registry);
      expect(isScriptExecuting()).toBe(false);
      expect(isExecutingScriptFor('pl1')).toBe(false);
    });

    it('tracks two engine trees independently', () => {
      const a = new Set(['a']);
      const b = new Set(['b']);
      beginScriptExecution(a);
      beginScriptExecution(b);
      endScriptExecution(a);
      expect(isExecutingScriptFor('a')).toBe(false);
      expect(isExecutingScriptFor('b')).toBe(true);
    });
  });

  describe('reportScriptError', () => {
    it('logs at level 1 and fires the public hook with the phase', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const seen = [];
      Hooks.on('gameOrchestraScriptError', (payload) => seen.push(payload));

      reportScriptError({ phase: 'timeout', playlistId: 'pl1', nodeId: 'n3', message: 'took too long' });

      expect(seen).toEqual([{ phase: 'timeout', playlistId: 'pl1', nodeId: 'n3', message: 'took too long' }]);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
