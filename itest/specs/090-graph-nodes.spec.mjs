/**
 * The graph node types that only exist as *audio*: Fork, Random and Delay.
 *
 * `020-graph-playback.spec.mjs` covers the sequential walk - Start, Track, End. Everything there is a
 * question of order, and order is something the engine's unit tests can already answer against a
 * fake controller. These three cannot be answered that way:
 *
 * - **Fork** is the only node whose entire meaning is simultaneity. A fake controller records that
 *   three `playTrack()` calls happened; it cannot tell three layers from three tracks in a row, and
 *   neither can `expectExactlyAudible` - over a window covering a sequential walk it reports the
 *   same tone set a Fork produces. `expectConcurrent` is the assertion that separates them, and it
 *   needs real, overlapping audio to be worth anything.
 * - **Fork under interruption** is where the hazard lives. A single-track graph has one sound to
 *   stop; a forked graph has N concurrent branches, and a branch that survives the stop is an
 *   orphaned sound playing under the combat track. That is this module's most common historical
 *   failure shape, and the one thing a green unit suite is least able to rule out.
 * - **Delay** is timed against the `AudioContext` clock. The engine's own header notes that a
 *   suspended context makes a scheduled start never elapse - a real-clock failure by definition,
 *   and invisible to fake timers.
 *
 * Graphs are built by the module's own preset builder (`applyGraphPreset`), as in
 * `020-graph-playback.spec.mjs`, so they cannot drift from the stored schema.
 *
 * ## What is deliberately not asserted here
 *
 * The Random node's `avoidRepeat` rule is **not** checked against audio, and that is a limit of the
 * measurement rather than an oversight. `segments()` merges adjacent frames sharing a tone set, so
 * the same track picked twice in a row is indistinguishable from one long play of it - the only
 * signal is a doubled segment duration, which is exactly the kind of machine-dependent number this
 * tier has been burned by before (see the crossfade block comment in `020-graph-playback.spec.mjs`).
 * `avoidRepeat` is settled in `custom-playback-engine.test.mjs` with an injected rng, where it is
 * decidable. What is asserted here is the part only audio can settle: that a Random node yields
 * **one** branch at a time.
 */

import { expect, record, recordDuring, resetProbe, test } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { applyGraphPreset, bindScenePlaylist, createPlaylist, preloadPlaylist, setGraphCrossfade, startCombat } from '../harness/foundry-api.mjs';
import { expectConcurrent, expectExactlyAudible, expectNotAudible, expectNotConcurrent } from '../harness/expect-audio.mjs';
import { segments } from '../harness/analysis.mjs';

/** See 020-graph-playback.spec.mjs - a custom-graph playlist is always stored UNSEQUENCED (H1). */
const UNSEQUENCED = -1;

const A = toneIndex('alpha');
const B = toneIndex('bravo');
const C = toneIndex('charlie');
const COMBAT = toneIndex('delta');
const UNREACHED = toneIndex('foxtrot');

test.describe('fork (layered ambience)', () => {
  /**
   * A layered graph, plus one track the graph never references.
   *
   * The extra track is the same H1/H2 guard `020-graph-playback.spec.mjs` uses: if an implicit
   * `initialTrack` ever creeps back in, Foundry's own UNSEQUENCED handling picks a track and that
   * tone becomes audible. Worth repeating for the forked shape specifically - a Fork already
   * produces several concurrent sounds legitimately, which is precisely the timeline in which one
   * more would be easiest to miss.
   * @param {import('@playwright/test').Page} gm - The GM page.
   * @returns {Promise<{id: string, soundIds: Record<string, string>}>} The created playlist.
   */
  async function buildLayers(gm) {
    const playlist = await createPlaylist(gm, {
      name: 'Layers',
      tracks: [{ tone: 'alpha' }, { tone: 'bravo' }, { tone: 'charlie' }, { tone: 'foxtrot' }],
      mode: UNSEQUENCED
    });
    await applyGraphPreset(gm, playlist.id, 'layered-ambience', ['alpha', 'bravo', 'charlie']);
    await preloadPlaylist(gm, playlist.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: playlist.id });
    return playlist;
  }

  test('plays every layer at once, and only the layers the graph names', async ({ gm }) => {
    await buildLayers(gm);

    const { frames } = await recordDuring(gm, 12_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    // Together, not merely all heard: this is the whole difference between a Fork and a walk.
    // Well past any crossfade, so a hand-off cannot be mistaken for a layer.
    expectConcurrent(frames, [A, B, C], { minDurationMs: 4000 });
    expectExactlyAudible(frames, [A, B, C]);
  });

  test('keeps every layer running rather than handing over between them', async ({ gm }) => {
    // A Fork's branches are concurrent for as long as the graph is active. If one branch were
    // wired as a hand-off instead, the layers would take turns - audible over a long enough
    // capture as the tone set changing, and caught here as the three-way overlap not holding.
    await buildLayers(gm);

    const { frames, mark } = await recordDuring(gm, 16_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    expectConcurrent(frames, [A, B, C], { minDurationMs: 8000, window: { from: mark + 2000 } });
  });

  test('stops every branch when combat interrupts, leaving nothing orphaned underneath', async ({ gm }) => {
    // The hazard this file exists for. One surviving branch is an orphaned sound playing under
    // the combat track - and `expectExactlyAudible`'s "no more" half is what catches it.
    await buildLayers(gm);
    const combat = await createPlaylist(gm, { name: 'Combat', tracks: [{ tone: 'delta', repeat: true }] });
    await preloadPlaylist(gm, combat.id);
    await bindScenePlaylist(gm, { section: 'combat', playlistId: combat.id });

    await resetProbe(gm);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, 3000);
    const { frames, mark } = await recordDuring(gm, 8000, () => startCombat(gm));

    expectExactlyAudible(frames, [COMBAT], { from: mark + 4000 });
  });
});

test.describe('random', () => {
  /**
   * A shuffling graph over three short tracks.
   * @param {import('@playwright/test').Page} gm - The GM page.
   * @param {string} preset - `'shuffle'` or `'shuffle-with-gaps'`.
   * @returns {Promise<{id: string, soundIds: Record<string, string>}>} The created playlist.
   */
  async function buildShuffle(gm, preset) {
    const playlist = await createPlaylist(gm, {
      name: 'Shuffle',
      tracks: [{ tone: 'alpha', short: true }, { tone: 'bravo', short: true }, { tone: 'charlie', short: true }, { tone: 'foxtrot', short: true }],
      mode: UNSEQUENCED
    });
    await applyGraphPreset(gm, playlist.id, preset, ['alpha', 'bravo', 'charlie']);
    await preloadPlaylist(gm, playlist.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: playlist.id });
    return playlist;
  }

  test('yields one branch at a time, never two at once', async ({ gm }) => {
    // A Random node picks an exit; a Fork takes them all. Getting that backwards is not an
    // ordering bug the unit tier would see as wrong - both walks are legal token walks - it is
    // simply the wrong number of sounds, which only the audio shows.
    await buildShuffle(gm, 'shuffle');
    await setGraphCrossfade(gm, 0);

    const { frames } = await recordDuring(gm, 14_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    for (const pair of [[A, B], [A, C], [B, C]]) expectNotConcurrent(frames, pair, { maxOverlapMs: 300 });
    // Nothing outside the graph's three tracks, foxtrot included (H1/H2).
    expectNotAudible(frames, UNREACHED);
  });

  test('keeps drawing from the graph rather than stopping after one pick', async ({ gm }) => {
    // A Random node that never returns to itself plays exactly one track and then goes quiet.
    // Seeing a second distinct tone enter is what proves the loop back through the node works.
    await buildShuffle(gm, 'shuffle');
    await setGraphCrossfade(gm, 0);

    const { frames } = await recordDuring(gm, 14_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    const played = segments(frames).flatMap((segment) => segment.tones);
    expect([...new Set(played)].length, 'the Random node only ever picked one track').toBeGreaterThan(1);
  });
});

test.describe('delay', () => {
  test('leaves real silence between tracks', async ({ gm }) => {
    // `shuffle-with-gaps` puts a 2-6 s Delay between every track and the return trip to the
    // Random node. The delay is counted on the AudioContext clock, so "the gap happened" is a
    // statement only a real context can make - and a delay that never elapses reads as the graph
    // having stopped, with nothing in module state looking wrong.
    const playlist = await createPlaylist(gm, {
      name: 'Gaps',
      tracks: [{ tone: 'alpha', short: true }, { tone: 'bravo', short: true }, { tone: 'charlie', short: true }],
      mode: UNSEQUENCED
    });
    await applyGraphPreset(gm, playlist.id, 'shuffle-with-gaps', ['alpha', 'bravo', 'charlie']);
    await preloadPlaylist(gm, playlist.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: playlist.id });
    await setGraphCrossfade(gm, 0);

    const { frames } = await recordDuring(gm, 20_000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));

    // The shortest configured gap is 2 s; 1 s of measured silence is unambiguous without
    // asserting on where in the 2-6 s range the roll landed.
    const quiet = segments(frames).filter((segment) => segment.tones.length === 0 && segment.durationMs >= 1000);
    expect(quiet.length, `expected a Delay gap of at least 1 s between tracks, saw none`).toBeGreaterThan(0);

    // And the graph must come back afterwards, rather than the delay being where it died.
    const played = segments(frames).flatMap((segment) => segment.tones);
    expect([...new Set(played)].length, 'nothing played after the first gap').toBeGreaterThan(1);
  });
});
