/**
 * The core promise of the module: entering combat changes what the table hears, and leaving
 * combat changes it back.
 *
 * The unit suite already proves `MusicController` *decides* correctly. What it cannot prove is
 * that the decision reaches the speakers - the path from decision to audio runs through
 * `PlaylistSound#sync`, Foundry's `Sound` construction, the audio lock, and a real fade. Every
 * one of those has produced a silent failure at least once.
 */

import { test, expect, recordDuring, resetProbe, record } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { bindScenePlaylist, createPlaylist, describeState, endCombat, preloadPlaylist, setFadeDuration, setSetting, startCombat } from '../harness/foundry-api.mjs';
import { expectCrossfade, expectEntryOrder, expectExactlyAudible, expectSilence } from '../harness/expect-audio.mjs';

const AREA = toneIndex('alpha');
const COMBAT = toneIndex('bravo');

test.describe('area <-> combat', () => {
  test('area music plays, combat takes over, and area returns when combat ends', async ({ gm }) => {
    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    const combat = await createPlaylist(gm, { name: 'Combat', tracks: [{ tone: 'bravo', repeat: true }] });
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });
    await bindScenePlaylist(gm, { section: 'combat', playlistId: combat.id });
    // Preload both, so the crossfade measures the fade and not the browser's first decode.
    await preloadPlaylist(gm, area.id);
    await preloadPlaylist(gm, combat.id);
    await setFadeDuration(gm, 2000);

    // Area music, alone. `expectExactlyAudible` also proves nothing else leaked in.
    const areaPhase = await recordDuring(gm, 3000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));
    expectExactlyAudible(areaPhase.frames, [AREA], { from: areaPhase.mark + 1000 });

    // Combat takes over. Combat beats area categorically, so area must not merely be quieter.
    // The crossfade needs no anchor - it is found by searching for the overlap - but the
    // "combat alone, afterwards" window does, or it lands on the pre-roll when the page is slow.
    const combatFrames = await recordDuring(gm, 7000, () => startCombat(gm));
    expectCrossfade(combatFrames.frames, { from: AREA, to: COMBAT, durationMs: 2000 });
    expectExactlyAudible(combatFrames.frames, [COMBAT], { from: combatFrames.mark + 4500 });

    const endFrames = await recordDuring(gm, 7000, () => endCombat(gm));
    expectCrossfade(endFrames.frames, { from: COMBAT, to: AREA, durationMs: 2000 });
    expectExactlyAudible(endFrames.frames, [AREA], { from: endFrames.mark + 4500 });
  });

  test('suppressing area music silences it without ending the scene binding', async ({ gm }) => {
    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    const playing = await recordDuring(gm, 3000, () => gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack()));
    expectExactlyAudible(playing.frames, [AREA], { from: playing.mark + 1000 });

    // Anchored, and it matters most here: an unanchored `from: 2500` on a contended runner asked
    // "was it silent 2.5 s in?" of a recording whose first eight seconds predate the suppression.
    // The answer was the area track, still playing, exactly as it should have been.
    const suppressed = await recordDuring(gm, 4000, () => setSetting(gm, 'suppressArea', true));
    expectSilence(suppressed.frames, { from: suppressed.mark + 2500 });

    const restored = await recordDuring(gm, 4000, () => setSetting(gm, 'suppressArea', false));
    expect(await describeState(gm)).toMatchObject({ isHeadGM: true, audioLocked: false });
    expectExactlyAudible(restored.frames, [AREA], { from: restored.mark + 2000 });
  });

  test('a mood switch swaps the area track without touching combat', async ({ gm }) => {
    const calm = await createPlaylist(gm, { name: 'Calm', tracks: [{ tone: 'alpha', repeat: true }] });
    const tense = await createPlaylist(gm, { name: 'Tense', tracks: [{ tone: 'charlie', repeat: true }] });
    await bindScenePlaylist(gm, { section: 'area', playlistId: calm.id });
    await bindScenePlaylist(gm, { section: 'area', playlistId: tense.id, overlayId: 'tense' });

    await resetProbe(gm);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, 2500);
    await setSetting(gm, 'activeMood', 'tense');
    const frames = await record(gm, 5000);

    expectEntryOrder(frames, [AREA, toneIndex('charlie')]);
  });
});
