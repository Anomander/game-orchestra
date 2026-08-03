/**
 * Volume ducking - the newest subsystem, and the one whose correctness is least visible from
 * anywhere but the output.
 *
 * Ducking multiplies a level that is *already* the product of the track volume, the playlist mix,
 * and Foundry's 1.5-order curve. Every one of those is applied by a different layer, and "applied
 * twice" and "applied once" differ only by a number that no state inspection reveals. Measuring
 * the same tone against itself before and after is the whole test.
 *
 * ## Timing here is deliberate, not padding
 *
 * Each phase records for 5 s and every window starts 2 s in. A track does not reach its steady
 * level the instant it starts - there is a fade-in, and the mix re-assert glides over 100 ms - so
 * a window opened immediately after a change averages the ramp together with the level and reports
 * a ratio that is simply wrong. An earlier draft measured from 1.2 s and saw a release ratio of
 * 0.76 where the true value is 1.01; the module was correct all along.
 *
 * Windows are anchored to **marks** taken with `probeNow()`, never to arithmetic on `PHASE_MS`.
 * Under a full-suite load these tests take twice as long as they do alone, so a window computed
 * from the nominal phase length measures the wrong stretch of audio and the test fails on a busy
 * machine while passing in isolation - the least useful kind of flake.
 */

import { probeNow, record, resetProbe, test } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { bindScenePlaylist, createPlaylist, preloadPlaylist, setSetting } from '../harness/foundry-api.mjs';
import { expectAudible, expectLevelRatio } from '../harness/expect-audio.mjs';

const BED = toneIndex('alpha');
const LAYER = toneIndex('echo');

/** How long each phase of a duck scenario is recorded for. */
const PHASE_MS = 5000;

/** Settling time skipped at the start of every measurement window. */
const SETTLE_MS = 2000;

/**
 * A measurement window between two marks, skipping the settling time after the first.
 * @param {number} start - Timeline mark where the phase began.
 * @param {number} end - Timeline mark where it ended.
 * @returns {{from: number, to: number}}
 */
function between(start, end) {
  return { from: start + SETTLE_MS, to: end - 200 };
}

test.describe('ducking', () => {
  test('an active duck lowers the bed by exactly its factor, and releasing restores it', async ({ gm }) => {
    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    await preloadPlaylist(gm, area.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    await resetProbe(gm);
    const baseFrom = await probeNow(gm);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, PHASE_MS);

    const duckAt = await probeNow(gm);
    await setSetting(gm, 'activeDuck', { factor: 0.4, exemptPlaylistIds: [] });
    await record(gm, PHASE_MS);

    const releaseAt = await probeNow(gm);
    await setSetting(gm, 'activeDuck', { factor: 1, exemptPlaylistIds: [] });
    const frames = await record(gm, PHASE_MS);
    const endAt = await probeNow(gm);

    const base = between(baseFrom, duckAt);
    const ducked = between(duckAt, releaseAt);
    const released = between(releaseAt, endAt);

    expectLevelRatio(frames, { tone: BED, before: base, after: ducked, ratio: 0.4, tolerance: 0.1 });
    // Releasing must restore the original level exactly. A duck applied to the stored volume
    // rather than to a separate gain stage does not come back - it multiplies down again on the
    // next assert, and this ratio drifts below 1 with every cycle.
    expectLevelRatio(frames, { tone: BED, before: base, after: released, ratio: 1, tolerance: 0.1 });
  });

  test('an exempt playlist is not ducked while everything else is', async ({ gm }) => {
    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    const layer = await createPlaylist(gm, { name: 'Layer', tracks: [{ tone: 'echo', repeat: true }] });
    await preloadPlaylist(gm, area.id);
    await preloadPlaylist(gm, layer.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    await resetProbe(gm);
    const baseFrom = await probeNow(gm);
    await gm.evaluate(({ id }) => game.playlists.get(id).playAll(), { id: layer.id });
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, PHASE_MS);

    const duckAt = await probeNow(gm);
    await setSetting(gm, 'activeDuck', { factor: 0.4, exemptPlaylistIds: [layer.id] });
    const frames = await record(gm, PHASE_MS);
    const endAt = await probeNow(gm);

    const base = between(baseFrom, duckAt);
    const ducked = between(duckAt, endAt);

    expectLevelRatio(frames, { tone: BED, before: base, after: ducked, ratio: 0.4, tolerance: 0.1 });
    expectLevelRatio(frames, { tone: LAYER, before: base, after: ducked, ratio: 1, tolerance: 0.1 });
    expectAudible(frames, LAYER, ducked);
  });
});
