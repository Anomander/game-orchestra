/**
 * The canary. Runs first (its filename sorts first), and checks only that the environment is
 * capable of the thing every other spec assumes: a joined client, a live probe, unlocked audio,
 * and one track that is actually audible.
 *
 * It exists because of how the tier first failed in CI. Something environmental went wrong, and
 * because every spec depends on the same fixture, *all twelve* failed the same way - each burning
 * its full test timeout, doubled by retries, until the job was killed at 30 minutes without
 * Playwright printing a single reason. Twelve identical timeouts is not twelve pieces of evidence;
 * it is one, delivered at the highest possible price.
 *
 * So this spec answers the question the expensive ones cannot: *is the environment sound?* Each
 * step has a short, individually-named assertion, so a failure says which of join, unlock, probe
 * or playback is broken - and with `maxFailures` set in CI, a broken environment stops the run
 * here rather than proving the same point eleven more times.
 *
 * Keep it fast and keep it first. If it needs a `record()` longer than a couple of seconds, it has
 * stopped being a smoke test.
 */

import { expect, mainThreadLatency, record, resetProbe, test } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { bindScenePlaylist, createPlaylist, describeState, preloadPlaylist } from '../harness/foundry-api.mjs';
import { expectAudible } from '../harness/expect-audio.mjs';
import { renderTimeline } from '../harness/analysis.mjs';

const ALPHA = toneIndex('alpha');

test.describe('smoke', () => {
  test('the environment can play a track and the probe can hear it', async ({ gm }) => {
    // 1. The world is up and the module initialised. `gm` already waited for both, so a failure
    //    here means the fixture's own waits are wrong rather than the world being slow.
    const state = await describeState(gm);
    expect(state, 'the module did not initialise, or this client is not the head GM').toMatchObject({
      isHeadGM: true,
      audioLocked: false
    });

    // 2. The probe attached to at least one AudioContext. Without this every "was silent"
    //    assertion in the suite passes vacuously.
    const probe = await gm.evaluate(() => window.__goProbe.status());
    expect(probe.attached, `audio probe never attached: ${probe.errors.join('; ') || 'no AudioContext was created'}`).toBeGreaterThan(0);

    // 3. A track plays and is measurable. This is the whole tier in miniature: if the fixtures are
    //    missing, the mount is wrong, the audio device is dead, or the worklet is not receiving
    //    samples, it fails here in seconds with the timeline attached.
    const area = await createPlaylist(gm, { name: 'Smoke', tracks: [{ tone: 'alpha', repeat: true }] });
    await preloadPlaylist(gm, area.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    await resetProbe(gm);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    const frames = await record(gm, 4000);

    expect(frames.length, 'the probe captured no frames at all - the AudioContext is not rendering').toBeGreaterThan(10);
    expectAudible(frames, ALPHA, { from: 1500 });

    // Two environment numbers, logged rather than asserted, because both have already been the
    // hidden cause of a whole suite failing and neither has a defensible threshold.
    //
    // `clockRatio` is how fast the AudioContext renders relative to wall time - 4x on a runner
    // whose null sink does not pace playback. `latency` is a no-op round trip into the page; a
    // few milliseconds when the main thread is free, and seconds when Foundry's canvas is
    // rendering through SwiftShader, which delays every state change relative to the recording
    // meant to capture it. If a later run of this suite fails in a way that looks like the module
    // reacting late, read these two lines first.
    const status = await gm.evaluate(() => window.__goProbe.status());
    const latency = await mainThreadLatency(gm);
    console.log(
      `smoke: ${status.contexts} audio context(s), ${frames.length} frames, ` +
        `audio clock running at ${status.clockRatio}x wall time, ` +
        `main-thread round trip ${latency}ms\n${renderTimeline(frames)}`
    );
  });
});
