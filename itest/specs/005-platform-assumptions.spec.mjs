/**
 * Platform assumptions — the facts about *Foundry itself* that this module's design rests on.
 *
 * Every other spec in this tier measures **audio**. This one measures nothing of the sort: it asks
 * whether the platform behaves the way a design document claimed it does, and it exists because
 * that class of assumption has no other home.
 *
 * The unit suite cannot answer these — `tests/mocks/foundry.mjs` is a mock, so asking it whether
 * `Macro#execute` forwards a scope only reports what we wrote into the mock. Reading core's source
 * answers it for whatever version happened to be read. This tier pins
 * `module.json#compatibility.verified` and runs the real thing, which makes it the only place a
 * sentence like *"verify against v14 before building on it"* can actually be discharged.
 *
 * **Runs early on purpose.** `000-smoke` proves the environment works; this proves the platform is
 * the one the design assumed. Both are cheap, both invalidate everything after them, and with
 * `maxFailures` set in CI a wrong assumption here should stop the run rather than resurface as a
 * dozen confusing failures in specs that were built on it. Same reasoning as the smoke spec's own
 * header, one level up the stack.
 *
 * **Findings belong in the plan or the wiki, not only here.** A spec that proves something and
 * leaves the claim uncorrected somewhere else has done half the job.
 */

import { expect, test } from '../harness/session.mjs';

test.describe('platform assumptions', () => {
  /**
   * docs/api-and-script-node-plan.md § B5 — the Script node's `mode: 'macro'`.
   *
   * The design routes a Script node's execution through `macro.execute({ gameOrchestra: ctx })`
   * specifically so it inherits core's permission model rather than a parallel one. That is only
   * viable if an arbitrary scope actually reaches the compiled script - if it does not, the
   * fallback is compiling `macro.command` ourselves, which keeps the permission check and loses
   * core's execution semantics.
   *
   * ANSWERED: the scope arrives, the return value comes back, and **both** access shapes work -
   * core passes `scope` itself and spreads its keys as named parameters. The fallback is not
   * needed. `this` is the Macro document, which nothing in the design reads.
   *
   * Only `scope.gameOrchestra` is asserted, and the asymmetry is deliberate: that is the shape the
   * inspector hint documents, so it is the one whose loss would break authored macros. The bare
   * named parameter is logged rather than asserted - a future core that stopped spreading scope
   * keys would cost us nothing, and pinning it here would turn a harmless change into a red run.
   */
  test('Macro#execute forwards an arbitrary scope into a script macro, and returns its value', async ({ gm }) => {
    const result = await gm.evaluate(async () => {
      const macro = await Macro.create({
        name: 'GO itest — scope probe',
        type: 'script',
        command: `return {
          viaScopeObject: typeof scope !== 'undefined' ? (scope?.gameOrchestra?.marker ?? null) : '<no scope binding>',
          viaNamedParam: typeof gameOrchestra !== 'undefined' ? (gameOrchestra?.marker ?? null) : '<not a named param>',
          sawThis: this?.name ?? null
        };`
      });
      let returned;
      let threw = null;
      try {
        returned = await macro.execute({ gameOrchestra: { marker: 'forwarded' } });
      } catch (error) {
        threw = String(error?.message ?? error);
      }
      await macro.delete();
      return { returned: returned ?? null, threw, returnedType: typeof returned };
    });

    // Logged in full before asserting: if any of this is not what the plan assumed, the exact
    // shape is what decides the fallback, and a bare "expected X to be Y" would hide it.
    console.log('[platform] Macro#execute →', JSON.stringify(result, null, 2));

    expect(result.threw, 'Macro#execute threw').toBeNull();
    expect(result.returned, 'Macro#execute did not return the script\'s value').not.toBeNull();
    expect(
      result.returned?.viaScopeObject,
      'scope.gameOrchestra did not reach the script - this is the shape the inspector hint promises'
    ).toBe('forwarded');
  });

  /**
   * docs/api-and-script-node-plan.md § B5 — "Compilation".
   *
   * Inline Script-node source is compiled by this module rather than by core, so it dies if a
   * deployment's Content-Security-Policy forbids function construction. Macro mode does not come
   * through here at all - core compiled those - which is what lets a blocked CSP cost one mode
   * rather than the feature.
   *
   * Two constructors, because the module uses both: `new Function` for the probe in
   * script-runtime.mjs#canCompileScripts, and `AsyncFunction` for the source body itself. A host
   * that allowed one and not the other would make the probe answer the wrong question.
   *
   * Note what this can and cannot establish. It proves **stock Foundry at the pinned version**
   * permits it. It cannot prove a *hosted* Foundry does - The Forge, Molten, or any self-host
   * behind a hardening reverse proxy can add CSP headers this container never sees. That gap is
   * why the plan should not treat a green run here as the whole answer; see the runtime probe
   * note in the plan's step 4.
   */
  test('the module can construct functions at runtime (CSP permits inline compilation)', async ({ gm }) => {
    const result = await gm.evaluate(() => {
      const probe = (label, build) => {
        try {
          return { label, ok: true, value: build() };
        } catch (error) {
          return { label, ok: false, error: `${error?.name}: ${error?.message}` };
        }
      };
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return {
        csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
        // The exact call script-runtime.mjs#canCompileScripts makes.
        sync: probe('Function', () => new Function('return 2 + 2;')()),
        // The exact constructor compileScriptBody uses for a Script node's inline source.
        async: probe('AsyncFunction', () => typeof new AsyncFunction('return 1;'))
      };
    });

    console.log('[platform] function construction →', JSON.stringify(result, null, 2));

    expect(result.sync.ok, `new Function is blocked: ${result.sync.error}`).toBe(true);
    expect(result.sync.value).toBe(4);
    expect(result.async.ok, `AsyncFunction construction is blocked: ${result.async.error}`).toBe(true);
  });

  /**
   * docs/api-and-script-node-plan.md § B9 — dragging a macro onto the graph.
   *
   * The drop rule matrix rejects a **chat** macro, on the stated grounds that it carries no JS to
   * run. That is an assumption about what `type` values exist and what a chat macro's `command`
   * holds; if a chat macro were executable the rejection would be wrong rather than merely
   * cautious.
   */
  test('a chat macro is a distinct type with no script to execute', async ({ gm }) => {
    const result = await gm.evaluate(async () => {
      const macro = await Macro.create({ name: 'GO itest — chat probe', type: 'chat', command: '/roll 1d20' });
      const shape = { type: macro.type, command: macro.command, types: CONST.MACRO_TYPES ?? null };
      await macro.delete();
      return shape;
    });

    console.log('[platform] chat macro →', JSON.stringify(result, null, 2));

    expect(result.type).toBe('chat');
    expect(result.type, 'a chat macro must be distinguishable from a script macro at drop time').not.toBe('script');
  });

  /**
   * `scripts/hooks.mjs#handlePlaylistConfigRender` — two assumptions carried in a source comment
   * as *unverified* since the feature shipped, and listed as an open gap in
   * docs/wiki/integration-testing.md § "What the unit suite cannot see".
   *
   * The unit suite calls the handler directly with a fabricated `html`, so it can only prove the
   * handler works *given* that Foundry fires `renderPlaylistConfig` and that the sheet contains a
   * `select[name="mode"]` to anchor against. Neither is checkable anywhere but here.
   *
   * UX-9 means the failure mode is a missing button and a logged warning rather than a thrown
   * error — which is correct behaviour and also precisely why this would go unnoticed. That is the
   * argument for asserting it rather than trusting it.
   */
  test('the Playlist config sheet fires renderPlaylistConfig and offers the mode-select anchor', async ({ gm }) => {
    const result = await gm.evaluate(async () => {
      const playlist = await Playlist.create({ name: 'GO itest — sheet probe' });
      let hookName = null;
      const hookId = Hooks.on('renderPlaylistConfig', () => { hookName = 'renderPlaylistConfig'; });
      await playlist.sheet.render(true);
      // The sheet renders asynchronously; give it a moment rather than racing it.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const root = playlist.sheet.element;
      const shape = {
        hookFired: hookName,
        sheetClass: playlist.sheet.constructor.name,
        hasModeSelect: !!root?.querySelector('select[name="mode"]'),
        hasFormGroupAncestor: !!root?.querySelector('select[name="mode"]')?.closest('.form-group'),
        // What the module actually injects, end to end.
        injectedButton: !!root?.querySelector('[data-action="game-orchestra-custom-playback"]')
      };
      Hooks.off('renderPlaylistConfig', hookId);
      await playlist.sheet.close();
      await playlist.delete();
      return shape;
    });

    console.log('[platform] playlist config sheet →', JSON.stringify(result, null, 2));

    expect(result.hookFired, 'Foundry did not fire a hook named renderPlaylistConfig').toBe('renderPlaylistConfig');
    expect(result.hasModeSelect, 'the sheet has no select[name="mode"] to anchor the button on').toBe(true);
    expect(result.hasFormGroupAncestor, 'the mode select is not inside a .form-group').toBe(true);
    expect(result.injectedButton, 'the module rendered no Playback Graph button into the sheet').toBe(true);
  });
});
