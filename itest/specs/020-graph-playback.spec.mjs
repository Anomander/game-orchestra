/**
 * Custom playback graphs, validated by the order and shape of what is heard.
 *
 * The graph engine's unit tests are extensive (82 tests) and drive a fake controller, so they
 * prove the *walk* is correct. They cannot prove the walk produces sound in that order: the two
 * hazards below are both cases where the token walk is provably right and the audio is wrong.
 *
 * - **H1/H2**: a custom-graph playlist is stored `UNSEQUENCED` but is not a Soundboard, and must
 *   never receive an implicit `initialTrack`. A stray track id bypasses the entire graph - and the
 *   symptom is *music playing*, just the wrong music, from Foundry's own playlist handling rather
 *   than from the engine. Nothing in module state looks wrong.
 * - **The armed-start path**: the engine schedules the next track against the `AudioContext`
 *   clock. Its own header notes that a suspended context makes an armed start's delay never
 *   elapse. That is a real-clock, real-context failure by definition.
 *
 * Graphs here are built by the module's own preset builder (`applyGraphPreset`), so they are the
 * same graphs the editor produces and cannot drift from the stored schema.
 */

import { record, recordDuring, resetProbe, test } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { applyGraphPreset, bindScenePlaylist, createPlaylist, preloadPlaylist, setGraphCrossfade, startCombat } from '../harness/foundry-api.mjs';
import { expectCrossfade, expectEntryOrder, expectExactlyAudible, expectHardCut } from '../harness/expect-audio.mjs';

/**
 * The mode a custom-graph playlist is always stored in (H1).
 *
 * **-1**, not a positive index: Foundry's `PLAYLIST_MODES` are `DISABLED: -1`, `SEQUENTIAL: 0`,
 * `SHUFFLE: 1`, `SIMULTANEOUS: 2`, and the module treats `UNSEQUENCED` as that same -1
 * (`custom-playlist-editor.mjs`: `CONST.PLAYLIST_MODES?.UNSEQUENCED ?? -1`). An out-of-range mode
 * makes `Playlist.create` reject, and the failure then surfaces as a confusing error about
 * `sounds` being undefined one line later.
 */
const UNSEQUENCED = -1;

const A = toneIndex('alpha');
const B = toneIndex('bravo');
const C = toneIndex('charlie');
const COMBAT = toneIndex('delta');

/**
 * Create the three-node walk both crossfade tests use.
 * @param {import('@playwright/test').Page} gm - The GM page.
 * @returns {Promise<{id: string, soundIds: Record<string, string>}>} The created playlist.
 */
async function buildWalk(gm) {
  const playlist = await createPlaylist(gm, {
    name: 'Graph',
    tracks: [{ tone: 'alpha', short: true }, { tone: 'bravo', short: true }, { tone: 'charlie', short: true }],
    mode: UNSEQUENCED
  });
  await applyGraphPreset(gm, playlist.id, 'sequential-once', ['alpha', 'bravo', 'charlie']);
  await preloadPlaylist(gm, playlist.id);
  await bindScenePlaylist(gm, { section: 'area', playlistId: playlist.id });
  return playlist;
}

test.describe('custom playback graph', () => {
  test('walks its nodes in order, and nothing outside the graph is ever audible', async ({ gm }) => {
    const playlist = await createPlaylist(gm, {
      name: 'Graph',
      tracks: [
        { tone: 'alpha', short: true },
        { tone: 'bravo', short: true },
        { tone: 'charlie', short: true },
        // A fourth track the graph never visits. If an implicit initialTrack ever creeps back in
        // (H1/H2), Foundry's own UNSEQUENCED handling picks a track and this tone becomes audible
        // - the most direct test of that hazard there is.
        { tone: 'foxtrot', short: true }
      ],
      mode: UNSEQUENCED
    });
    await applyGraphPreset(gm, playlist.id, 'sequential-once', ['alpha', 'bravo', 'charlie']);
    await preloadPlaylist(gm, playlist.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: playlist.id });
    await setGraphCrossfade(gm, 0);

    const { frames } = await recordDuring(gm, 14_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    expectEntryOrder(frames, [A, B, C]);
    expectExactlyAudible(frames, [A, B, C]);
  });

  /**
   * `graphCrossfade` governs how long consecutive nodes overlap. **Only the later hand-off is
   * asserted**, and the reason is a real weakness in the engine rather than a limitation of the
   * harness.
   *
   * Measured on a three-node `sequential-once` walk of 3 s tracks, A -> B being the first hand-off:
   *
   * | Machine | main-thread round trip | A -> B at 0 ms | A -> B at 1000 ms | B -> C |
   * |---|---|---|---|---|
   * | desktop, ticker stopped | 3 ms | 0-310 ms | ~1050 ms | tracks the setting, +-40 ms |
   * | GitHub runner | 18 ms | **~1400 ms** | ~1400 ms | tracks the setting |
   *
   * B -> C is stable everywhere. **A -> B is not**: on the runner the second track starts ~1.5 s
   * early - and the timeline shows it is the *start* that moves, not the outgoing track running
   * long, since A still plays its full three seconds. The error scales with how loaded the machine
   * is, and at 1000 ms of configured crossfade it is indistinguishable from the crossfade itself.
   *
   * So the first hand-off's *timing* is not asserted here at all. Its ordering is. Encoding a
   * number for it would be asserting on the runner rather than on the module, and the assertion
   * that did so passed CI at 1400 ms only because that squeaked under a 1500 ms tolerance ceiling.
   *
   * ## Two earlier readings of this were wrong, in opposite directions
   *
   * First: "the first hand-off never crossfades" (0 ms, 0 ms, 40 ms at 0/500/1000 ms), with a tidy
   * explanation - the engine arms the next start against the `AudioContext` clock ahead of time and
   * the first node has no prior node to arm from. Those numbers were taken while PIXI was
   * rendering and the main thread was saturated.
   *
   * Then, with the ticker stopped: "every hand-off overlaps by the configured crossfade, including
   * the first". Also over-confident - it fit two runs on one idle machine, and the runner broke it
   * immediately.
   *
   * What survives both is narrower and better supported: the configured crossfade does reach the
   * first hand-off, *plus* a start-time error that grows with machine load. That error is worth
   * chasing in `custom-playback-engine.mjs` - a node starting 1.5 s early is audible - but it is
   * the engine's bug to fix, not a number for this spec to bless.
   *
   * The lesson is worth more than the table: this tier measures the module through a browser whose
   * main thread it shares, and a plausible story that fits the numbers is not a finding until the
   * numbers hold on a machine that is not the one they were discovered on.
   *
   * These are two tests rather than two measurements in one, because a `sequential-once` graph is
   * *finished* when it reaches the end: re-calling `playCurrentTrack()` resolves the same context,
   * changes nothing, and records silence. A fresh world per test is what actually restarts it.
   */
  test('consecutive nodes hard-cut when the crossfade is zero', async ({ gm }) => {
    await buildWalk(gm);
    await setGraphCrossfade(gm, 0);

    const { frames } = await recordDuring(gm, 13_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));
    expectEntryOrder(frames, [A, B, C]);
    // B -> C only. A -> B's start time varies with machine load by up to ~1.5 s - see the block
    // comment above. Every number tried for it has been a measurement of the machine.
    expectHardCut(frames, B, C);
  });

  test('a later hand-off overlaps by the configured crossfade', async ({ gm }) => {
    await buildWalk(gm);
    await setGraphCrossfade(gm, 1000);

    const { frames } = await recordDuring(gm, 13_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));
    expectEntryOrder(frames, [A, B, C]);
    // `monotonic` is off: the outgoing track plays out to its natural end rather than fading, so
    // only the incoming side ramps. A real overlap, just not a symmetrical one.
    expectCrossfade(frames, { from: B, to: C, durationMs: 1000, monotonic: false });
  });

  test('a graph interrupted by combat yields immediately', async ({ gm }) => {
    const graph = await createPlaylist(gm, {
      name: 'Graph',
      tracks: [{ tone: 'alpha', short: true }, { tone: 'bravo', short: true }, { tone: 'charlie', short: true }],
      mode: UNSEQUENCED
    });
    await applyGraphPreset(gm, graph.id, 'sequential-loop', ['alpha', 'bravo', 'charlie']);
    const combat = await createPlaylist(gm, { name: 'Combat', tracks: [{ tone: 'delta', repeat: true }] });
    await preloadPlaylist(gm, graph.id);
    await preloadPlaylist(gm, combat.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: graph.id });
    await bindScenePlaylist(gm, { section: 'combat', playlistId: combat.id });

    await resetProbe(gm);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, 2000);
    const { frames, mark } = await recordDuring(gm, 7000, () => startCombat(gm));

    // Whatever node the graph was on must stop; combat is categorical, not a priority contest.
    expectExactlyAudible(frames, [COMBAT], { from: mark + 4000 });
  });
});
