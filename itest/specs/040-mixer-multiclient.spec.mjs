/**
 * CLAUDE.md rule 5 and its exception, measured on two real clients.
 *
 * > The playback engine runs only on the head GM. **The mixer is the exception.** Volume is
 * > applied per client from the document, so `playlist-mix-apply.mjs` must run everywhere -
 * > head-GM-gating it means the GM hears the ceiling and the players hear the raw track.
 *
 * That bug is invisible to every other layer of testing. It produces no error, the GM's own
 * client sounds perfect, and the unit suite passes because both halves are individually correct.
 * The only way to catch it is to measure two clients' outputs and compare - which is precisely
 * what this file does, and the strongest single argument for the whole integration tier.
 */

import { assertProbeHealthy, probeNow, record, recordDuring, resetProbe, test } from '../harness/session.mjs';
import { toneIndex } from '../harness/tones.mjs';
import { bindScenePlaylist, createPlaylist, preloadPlaylist } from '../harness/foundry-api.mjs';
import { expectClientsAgree, expectLevelRatio, expectNotAudible } from '../harness/expect-audio.mjs';

const BED = toneIndex('alpha');
const LAYER = toneIndex('bravo');

test.describe('mixer across clients', () => {
  test('a mix ceiling is heard identically by the GM and by a player', async ({ gm, player }) => {
    await assertProbeHealthy(player);

    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    await preloadPlaylist(gm, area.id);
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    await resetProbe(gm);
    await resetProbe(player);
    await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    await record(gm, 5000);

    // Halve the playlist's master gain mid-playback, then let both clients settle. The key is
    // `gain` - see `playlist-mix.mjs#normalizeMix`; an unknown key normalizes to the default and
    // changes nothing at all, which reads as "the mix was ignored".
    // Marked on **both** clients. Each page's probe has its own origin and its own audio clock, so
    // a mark taken on the GM is not a position on the player's timeline - the two are within a
    // round trip of each other when the machine is idle, and seconds apart when it is not. Sharing
    // one set of marks made this spec pass alone and fail intermittently in a full run.
    const changeGm = await probeNow(gm);
    const changePlayer = await probeNow(player);
    await gm.evaluate(({ playlistId }) => game.playlists.get(playlistId).setFlag('game-orchestra', 'mix', { gain: 0.5 }), { playlistId: area.id });
    await record(gm, 5000);
    const endGm = await probeNow(gm);
    const endPlayer = await probeNow(player);

    const gmFrames = await gm.evaluate(() => window.__goProbe.frames());
    const playerFrames = await player.evaluate(() => window.__goProbe.frames());

    // Anchored to marks, not to nominal phase lengths - under load these phases stretch, and a
    // fixed window then averages the wrong stretch of audio.
    const gmBefore = { from: 2000, to: changeGm - 200 };
    const gmAfter = { from: changeGm + 2000, to: endGm - 200 };
    const playerBefore = { from: 2000, to: changePlayer - 200 };
    const playerAfter = { from: changePlayer + 2000, to: endPlayer - 200 };

    // Both clients must show the drop...
    expectLevelRatio(gmFrames, { tone: BED, before: gmBefore, after: gmAfter, ratio: 0.5, tolerance: 0.15 });
    expectLevelRatio(playerFrames, { tone: BED, before: playerBefore, after: playerAfter, ratio: 0.5, tolerance: 0.15 });
    // ...and, more importantly, must agree with each other. This is the assertion that fails if
    // playlist-mix-apply.mjs is ever head-GM-gated.
    expectClientsAgree(gmFrames, playerFrames, BED, { windowA: gmAfter, windowB: playerAfter, tolerance: 0.12 });
  });

  test('solo is local to the client that soloed, and never reaches the table', async ({ gm, player }) => {
    await assertProbeHealthy(player);

    const area = await createPlaylist(gm, {
      name: 'Layered',
      tracks: [{ tone: 'alpha', repeat: true }, { tone: 'bravo', repeat: true }],
      mode: 2 // SIMULTANEOUS - both tracks audible at once, so a solo has something to mute.
    });
    // Deliberately *not* bound to the scene. The mixer applies to any playing playlist, and
    // binding it would put the module's own resolution in competition with this manual
    // `playAll()` over the same sounds - two actors starting and stopping the same tracks, which
    // made this spec pass alone and fail intermittently in a full run.

    await preloadPlaylist(gm, area.id);
    await resetProbe(gm);
    await resetProbe(player);
    await gm.evaluate(({ playlistId }) => game.playlists.get(playlistId).playAll(), { playlistId: area.id });
    await record(gm, 5000);

    // Marked on both clients - see the note in the spec above; the player's timeline is its own.
    const soloGm = await probeNow(gm);
    const soloPlayer = await probeNow(player);
    await gm.evaluate(async ({ playlistId, soundId }) => {
      const { toggleSolo, applyMixToPlaylist } = await import('/modules/game-orchestra/scripts/playlist-mix-apply.mjs');
      toggleSolo(playlistId, soundId);
      await applyMixToPlaylist(game.playlists.get(playlistId));
    }, { playlistId: area.id, soundId: area.soundIds.alpha });
    await record(gm, 5000);
    const endGm = await probeNow(gm);
    const endPlayer = await probeNow(player);

    const gmFrames = await gm.evaluate(() => window.__goProbe.frames());
    const playerFrames = await player.evaluate(() => window.__goProbe.frames());
    const gmAfter = { from: soloGm + 2000, to: endGm - 200 };
    const playerBefore = { from: 2000, to: soloPlayer - 200 };
    const playerAfter = { from: soloPlayer + 2000, to: endPlayer - 200 };

    // Soloing alpha silences bravo here...
    expectNotAudible(gmFrames, LAYER, gmAfter);
    // ...and changes nothing at the table. Solo is session state, per client, never a world flag.
    expectLevelRatio(playerFrames, { tone: LAYER, before: playerBefore, after: playerAfter, ratio: 1, tolerance: 0.15 });
  });

  test('only the head GM drives playback - a player joining does not double-start a track', async ({ gm, player }) => {
    const area = await createPlaylist(gm, { name: 'Area', tracks: [{ tone: 'alpha', repeat: true }] });
    await bindScenePlaylist(gm, { section: 'area', playlistId: area.id });

    const { frames, mark } = await recordDuring(player, 5000, async () => {
      await gm.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
      // Headship is re-evaluated on connect, and every client re-runs playCurrentTrack(). A
      // non-head client that fails to no-op starts a second copy of the same track, which is
      // audible as a level increase rather than as a new tone - so assert on level, not identity.
      await player.evaluate(() => game.gameOrchestra.musicController.playCurrentTrack());
    });

    expectLevelRatio(frames, {
      tone: BED,
      before: { from: mark + 1500, to: mark + 2500 },
      after: { from: mark + 3500, to: mark + 4500 },
      ratio: 1,
      tolerance: 0.15
    });
  });
});
