/**
 * Provisioning and control of a live Foundry world, from the Playwright side.
 *
 * Every function here is a thin wrapper around a `page.evaluate` that calls Foundry's **document
 * API** - `Playlist.create`, `scene.setFlag`, `combat.startCombat`. Nothing pokes at the module's
 * internals, and nothing clicks through the module's own UI.
 *
 * That is a deliberate boundary. Driving the module's windows would make these tests a UI suite
 * that happens to make noise, and every selector change would break them; the existing vitest
 * files already cover the windows' DOM. What integration testing uniquely adds is the path from
 * *game state* to *audible output*, so state is set the way Foundry itself would set it, and the
 * only thing observed is sound.
 *
 * All of it runs as the GM page - it requires an authenticated GM session, which
 * {@link import('./session.mjs')} provides.
 */

import { toneFilename } from './tones.mjs';

/** Where the fixture directory is mounted inside the container's user data folder. */
export const FIXTURE_DIR = 'gameorchestra-itest';

/**
 * The Foundry-relative path of a fixture track.
 * @param {string} toneId - Tone slug from the tone table.
 * @param {object} [options] - Options.
 * @param {boolean} [options.short=false] - Use the 3 s variant that ends on its own.
 * @returns {string} Path usable as a `PlaylistSound#path`.
 */
export function fixturePath(toneId, { short = false } = {}) {
  return `${FIXTURE_DIR}/${short ? 'short-' : ''}${toneFilename(toneId)}`;
}

/**
 * Create a playlist whose tracks are fixture tones.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {object} spec - Playlist spec.
 * @param {string} spec.name - Playlist name.
 * @param {Array<{tone: string, short?: boolean, volume?: number, repeat?: boolean}>} spec.tracks -
 *   Tracks in order; each maps to one fixture tone.
 * @param {number} [spec.mode] - A `CONST.PLAYLIST_MODES` value. Defaults to `SEQUENTIAL`.
 * @param {object} [spec.flags] - Module flags to stamp on the playlist (a graph, a mix).
 * @returns {Promise<{id: string, soundIds: Record<string, string>}>} The playlist id and a map of
 *   tone slug to `PlaylistSound` id, which is what mixer and graph specs need to address tracks.
 */
export async function createPlaylist(page, spec) {
  return page.evaluate(
    async ({ playlist, fixtureDir }) => {
      const created = await Playlist.create({
        name: playlist.name,
        mode: playlist.mode ?? CONST.PLAYLIST_MODES.SEQUENTIAL,
        sounds: playlist.tracks.map((track) => ({
          name: track.tone,
          path: `${fixtureDir}/${track.short ? 'short-' : ''}tone-${track.tone}.wav`,
          volume: track.volume ?? 1,
          repeat: track.repeat ?? false
        })),
        flags: playlist.flags ? { 'game-orchestra': playlist.flags } : {}
      });

      // A rejected create returns undefined, and the very next line then throws
      // "Cannot read properties of undefined (reading 'sounds')" - which points at the sounds and
      // not at the actual cause (an out-of-range `mode`, say). Name the real problem here.
      if (!created) throw new Error(`Playlist.create returned nothing for '${playlist.name}' - check mode (${playlist.mode ?? 'default'}) and track paths`);

      const soundIds = {};
      for (const sound of created.sounds) soundIds[sound.name] = sound.id;
      return { id: created.id, soundIds };
    },
    { playlist: spec, fixtureDir: FIXTURE_DIR }
  );
}

/**
 * Preload every track of a playlist so playback starts immediately when asked.
 *
 * Not a nicety - it is what makes crossfade assertions meaningful. On a track's *first* play the
 * browser must fetch and decode the file, and that latency lands squarely between the outgoing
 * fade and the incoming start: the old track has finished fading out before the new one makes a
 * sound, so a correctly configured 500 ms crossfade measures as a gap with no overlap at all.
 * Preloading moves the cost before the measurement, which is also what a real session looks like
 * after a track has played once.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} playlistId - Playlist whose tracks to preload.
 * @returns {Promise<void>}
 */
export async function preloadPlaylist(page, playlistId) {
  await page.evaluate(async (id) => {
    const playlist = game.playlists.get(id);
    await Promise.all(playlist.sounds.contents.map((sound) => foundry.audio.AudioHelper.preloadSound(sound.path)));
  }, playlistId);
}

/**
 * Point a scene's area or combat section at a playlist, the way the config window would.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {object} spec - Assignment spec.
 * @param {string} [spec.sceneId] - Scene to configure; defaults to the active scene.
 * @param {'area'|'combat'} spec.section - Which section to set.
 * @param {string} spec.playlistId - Playlist to bind.
 * @param {number} [spec.priority] - Optional priority override.
 * @param {string} [spec.overlayId] - Mood (area) or phase (combat) this binding is scoped to.
 * @returns {Promise<void>}
 */
export async function bindScenePlaylist(page, spec) {
  await page.evaluate(async (binding) => {
    const scene = binding.sceneId ? game.scenes.get(binding.sceneId) : game.scenes.active;
    // Overlay bindings nest under an `overlays` map - `music.area.overlays.tense.playlist`, not
    // `music.area.tense.playlist`. The flatter guess stores perfectly happily and reads back as
    // nothing, so the mood simply never changes the music and no error is raised anywhere.
    // See `app.mjs`'s `overlayPath` and `playlist-ref.mjs`'s `section.overlays?.[id]`.
    const base = binding.overlayId
      ? `music.${binding.section}.overlays.${binding.overlayId}`
      : `music.${binding.section}`;
    await scene.setFlag('game-orchestra', `${base}.playlist`, binding.playlistId);
    if (binding.priority !== undefined) {
      await scene.setFlag('game-orchestra', `${base}.priority`, binding.priority);
    }
  }, spec);
}

/**
 * Stamp a custom playback graph onto a playlist, built by the **module's own preset builder**.
 *
 * Hand-writing the graph JSON in a spec was the original approach and it was wrong twice over: the
 * stored schema is `{version, nodes, edges}` with explicit `start`/`end` nodes and a separate edge
 * list, not the `{nodes: [{exits}], entry}` shape it is tempting to assume. A hand-rolled graph
 * that misses this stores without complaint and simply never plays.
 *
 * Building through `graph-presets.mjs` means these specs exercise the same graphs the editor
 * produces, and cannot drift from the schema - if the schema changes, the preset changes with it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} playlistId - Playlist to stamp.
 * @param {string} presetId - A `GRAPH_PRESETS` id, e.g. `'sequential-once'`.
 * @param {string[]} toneOrder - Tone slugs naming which of the playlist's tracks to use, in order.
 * @returns {Promise<object>} The stored graph, so a spec can assert on its shape if it wants to.
 */
export async function applyGraphPreset(page, playlistId, presetId, toneOrder) {
  return page.evaluate(
    async ({ id, preset, order }) => {
      const playlist = game.playlists.get(id);
      const sounds = order.map((name) => {
        const sound = playlist.sounds.contents.find((s) => s.name === name);
        if (!sound) throw new Error(`No track named '${name}' on playlist '${playlist.name}'`);
        return sound;
      });
      // `api.graph.presets` rather than a deep import of graph-presets.mjs: the release build
      // bundles every module into one file, so `scripts/graph-presets.mjs` does not exist in the
      // shipped tree and the import would 404. This tier gates that artifact, so it may only reach
      // the module through surfaces the bundle exposes. Same array, same builders, so the point of
      // the comment above - that these specs cannot drift from the schema - still holds.
      const builder = game.modules.get('game-orchestra').api.graph.presets.find((p) => p.id === preset);
      if (!builder) throw new Error(`Unknown graph preset '${preset}'`);
      const graph = builder.build(sounds);
      await playlist.setFlag('game-orchestra', 'customPlayback', graph);
      return graph;
    },
    { id: playlistId, preset: presetId, order: toneOrder }
  );
}

/**
 * Set a module world setting.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} key - Setting key from `CONST.settings`.
 * @param {*} value - Value to store.
 * @returns {Promise<void>}
 */
export async function setSetting(page, key, value) {
  await page.evaluate(async ({ k, v }) => game.settings.set('game-orchestra', k, v), { k: key, v: value });
}

/**
 * Set the area/combat crossfade length, **in milliseconds**.
 *
 * Exists because the two fade settings do not share a unit, and nothing in their names says so:
 *
 * | Setting | Unit | Range |
 * |---|---|---|
 * | `fadeDuration` | **seconds** (`music-controller.mjs` reads it as `fadeDurationSec`) | 0-10 |
 * | `graphCrossfade` | **milliseconds** (`worldMs`) | 0-1000 |
 *
 * A spec that sets `fadeDuration` to `500` meaning half a second gets a **500 second** fade. The
 * symptom is not an error or an obviously wrong number - it is a track that appears never to stop,
 * at a constant full level, while the module's own state correctly reports the new context as the
 * winner. That cost a full debugging round; it should cost nobody another one.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {number} ms - Fade length in milliseconds.
 * @returns {Promise<void>}
 * @throws {Error} If the value is outside the setting's own 0-10 s range, which Foundry would
 *   otherwise clamp silently.
 */
export async function setFadeDuration(page, ms) {
  if (ms < 0 || ms > 10_000) throw new Error(`fadeDuration must be 0-10000 ms (the setting's range is 0-10 s); got ${ms}`);
  await setSetting(page, 'fadeDuration', ms / 1000);
}

/**
 * Set the custom-graph crossfade length, in milliseconds.
 *
 * This one really is milliseconds - see {@link setFadeDuration} for why that is worth saying.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {number} ms - Crossfade length in milliseconds.
 * @returns {Promise<void>}
 * @throws {Error} If outside the setting's 0-1000 ms range.
 */
export async function setGraphCrossfade(page, ms) {
  if (ms < 0 || ms > 1000) throw new Error(`graphCrossfade must be 0-1000 ms; got ${ms}`);
  await setSetting(page, 'graphCrossfade', ms);
}

/**
 * Start combat with a single combatant, and advance to the first turn.
 *
 * Combat start is the single most important state transition in this module, and it is also the
 * one with the most moving parts: a combat that is created but never started does not count as
 * combat for context resolution, and a spec that forgets `startCombat` gets area music and a
 * confusing failure.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {object} [options] - Options.
 * @param {string} [options.actorName] - Actor to add as the combatant; a token is created if the
 *   scene has none.
 * @returns {Promise<string>} The combat id.
 */
export async function startCombat(page, { actorName } = {}) {
  return page.evaluate(async ({ name }) => {
    const scene = game.scenes.active;
    let token = scene.tokens.contents[0];
    if (!token) {
      // Actor types come from the system's declared document types. `CONFIG.Actor.dataModels` is
      // empty under Simple Worldbuilding, so guessing from it produced an invalid type and a
      // failed create.
      const type = game.documentTypes.Actor.find((t) => t !== 'base') ?? 'base';
      const actor = game.actors.getName(name ?? 'Itest Dummy') ?? (await Actor.create({ name: name ?? 'Itest Dummy', type }));
      const [created] = await scene.createEmbeddedDocuments('Token', [{ name: actor.name, actorId: actor.id, x: 1000, y: 1000 }]);
      token = created;
    }

    // `active: true` is load-bearing and easy to miss. The module resolves combat through
    // `game.combats.active`, so a combat that is created and even `started` but never *activated*
    // changes nothing: area music keeps playing and the spec fails with "combat never took over"
    // while every piece of combat state looks correct. Confirmed live.
    const combat = await Combat.create({ scene: scene.id, active: true });
    await combat.createEmbeddedDocuments('Combatant', [{ tokenId: token.id, actorId: token.actorId }]);
    if (!combat.active) await combat.activate();
    await combat.startCombat();
    return combat.id;
  }, { name: actorName });
}

/**
 * End every active combat.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>}
 */
export async function endCombat(page) {
  await page.evaluate(async () => {
    for (const combat of [...game.combats]) await combat.delete();
  });
}

/**
 * Delete every playlist, combat and module flag this run created, and stop all audio.
 *
 * Called between specs. A world is expensive to build, so specs share one - which means leaked
 * state from a previous spec is the most likely cause of a mysterious failure. Resetting through
 * the document API (rather than restoring a database snapshot) keeps teardown fast enough to run
 * after every test.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>}
 */
export async function resetWorld(page) {
  await page.evaluate(async () => {
    for (const combat of [...game.combats]) await combat.delete();

    // Clear the bindings *before* asking the module to re-resolve. With no scene flags and no
    // suppression, `playCurrentTrack()` resolves to no context and stops its own audio through
    // the same path production uses - which is far more trustworthy than reaching in and stopping
    // sounds behind the controller's back and leaving it believing they still play.
    const scene = game.scenes.active;
    if (scene?.flags?.['game-orchestra']) await scene.unsetFlag('game-orchestra', 'music');
    await game.settings.set('game-orchestra', 'suppressArea', false);
    await game.settings.set('game-orchestra', 'suppressCombat', false);
    await game.settings.set('game-orchestra', 'activeMood', '');
    await game.settings.set('game-orchestra', 'activePhase', '');
    await game.settings.set('game-orchestra', 'activeDuck', { factor: 1, exemptPlaylistIds: [] });
    await game.settings.set('game-orchestra', 'fadeDuration', 0);
    await game.settings.set('game-orchestra', 'graphCrossfade', 0);
    await game.gameOrchestra?.musicController?.playCurrentTrack?.();

    // Then stop anything still sounding, belt and braces. `stopAll()` alone is not enough: a
    // deleted playlist's `Sound` keeps rendering, so a spec that deletes while audio plays leaves
    // a tone audible with no document left to explain it - and the *next* spec fails on a stray
    // tone it never started. Stopping the Sound object directly is what actually silences it.
    for (const playlist of [...game.playlists]) {
      for (const sound of playlist.sounds.contents) {
        try {
          sound.sound?.stop?.();
        } catch {
          // A sound that was never loaded has no Sound instance; nothing to stop.
        }
      }
      await playlist.stopAll?.();
      await playlist.delete();
    }

    // Tokens and actors too. Leaving them behind is not merely untidy: `startCombat()` reuses the
    // first token on the scene, so a token left by a previous spec silently changes which actor a
    // later spec's combat is about - and per-token combat themes are a feature of this module.
    const stale = scene?.tokens?.contents ?? [];
    if (stale.length) await scene.deleteEmbeddedDocuments('Token', stale.map((t) => t.id));
    for (const actor of [...game.actors]) await actor.delete();
  });
}

/**
 * Read the module's own view of what is currently winning.
 *
 * Used only to enrich failure messages - never as the assertion itself. When an audio assertion
 * fails it matters enormously whether the module thought it was playing the right thing (a
 * playback bug) or the wrong thing (a resolution bug), and that is the one question the probe
 * cannot answer.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<object>} Diagnostic snapshot.
 */
export async function describeState(page) {
  return page.evaluate(async () => {
    const controller = game.gameOrchestra?.musicController;
    // `isHeadGM` is a module-level export in helpers.mjs, **not** a method on the controller.
    // Reading it as `controller.isHeadGM?.()` yields undefined and therefore a confident,
    // permanent `false` - which reads as "the engine is not running here" and sends you looking
    // for a headship bug that does not exist.
    //
    // Reached through `api.isHeadGM` rather than a deep import of helpers.mjs, which the release
    // build does not ship as its own file - see docs/wiki/packaging.md. It is the same helper.
    return {
      isHeadGM: game.modules.get('game-orchestra').api.isHeadGM(),
      audioLocked: !!game.audio?.locked,
      currentContext: controller?.currentContext?.playlist?.name ?? null,
      playing: game.playlists.contents.flatMap((playlist) =>
        playlist.sounds.contents.filter((sound) => sound.playing).map((sound) => `${playlist.name}/${sound.name}@${sound.volume}`)
      )
    };
  });
}
