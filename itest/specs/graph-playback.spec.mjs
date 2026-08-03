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
   * `graphCrossfade` governs how long consecutive nodes overlap, on **every** hand-off including
   * the first.
   *
   * Measured on a three-node `sequential-once` walk of 3 s tracks, with the canvas render loop
   * stopped:
   *
   * | `graphCrossfade` | A -> B (first) | B -> C (later) |
   * |---|---|---|
   * | 0 ms | 0 ms | 0 ms |
   * | 1000 ms | ~1050 ms | ~1000 ms |
   *
   * ## This table used to say the first hand-off never crossfades. That was a measurement artifact
   *
   * The earlier numbers - 0 ms, 0 ms, 40 ms for the first hand-off at 0/500/1000 ms - were taken
   * while Foundry's PIXI canvas was rendering, and a theory was built on top of them: that the
   * engine arms the next start against the `AudioContext` clock ahead of time, and the first node
   * has no prior node to arm from. Plausible, and wrong.
   *
   * With the render loop stopped (see `session.mjs#quietCanvas`) the first hand-off overlaps by
   * the configured duration like any other, reproducibly, across repeated runs. What the old
   * numbers actually measured was the *arming deadline being missed under main-thread contention*
   * - a real degradation, but a property of the machine, not of the engine.
   *
   * The lesson is worth more than the table: this tier measures the module through a browser whose
   * main thread it shares, so a finding that looks like module behaviour has to be reproduced with
   * that thread free before it is written down as design.
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
    // The first hand-off is the loose one, in both directions: it overlaps by the configured
    // crossfade when there is one (see the next test), and it still trails ~0-310 ms with the
    // crossfade at zero, where later hand-offs cut inside a single analysis frame. Measured over
    // four runs: <=150, <=150, 181, 309 ms. That is inaudible as a fade and nowhere near the
    // ~1000 ms a configured crossfade produces, so it is bounded here rather than asserted away -
    // if it ever grows into a real fade, this still catches it.
    expectHardCut(frames, A, B, 400);
    expectHardCut(frames, B, C);
  });

  test('every hand-off overlaps by the configured crossfade, including the first', async ({ gm }) => {
    await buildWalk(gm);
    await setGraphCrossfade(gm, 1000);

    const { frames } = await recordDuring(gm, 13_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));
    expectEntryOrder(frames, [A, B, C]);
    // `monotonic` is off on both: the outgoing track plays out to its natural end rather than
    // fading, so only the incoming side ramps. A real overlap, just not a symmetrical one.
    expectCrossfade(frames, { from: A, to: B, durationMs: 1000, monotonic: false });
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
