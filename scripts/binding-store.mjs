import { CONST } from './config.mjs';
import { resolveInitialTrack, getDocumentCategory } from './helpers.mjs';

/**
 * The write half of **J1 (Bind)** - see docs/wiki/ux.md.
 *
 * Assigning a playlist to a scope/section/overlay is one operation with three
 * storage backends, and it used to be written out three times: once against a
 * Scene's flags (`playlist-tree.mjs`), once against the `defaultMusic` world
 * setting (same file), and once against a Token/PrototypeToken through
 * `GameOrchestraConfig#updateObject` (`app.mjs`). The three copies had already
 * drifted - only one of them cleared `priority` when the playlist was removed.
 *
 * The split here is deliberate and follows the `MixerController` precedent
 * (UX-2): a **store** knows only how to get/set/unset one path in one backend
 * and has no idea what a binding is; the **operations** below know what a
 * binding is and nothing about storage. Neither touches the DOM, `ui`, or any
 * application instance, so the operations are unit-testable against a plain
 * object store.
 *
 * Every path is the full relative path under the module's flag root, e.g.
 * `music.area.playlist` or `music.combat.overlays.enrage.priority`.
 *
 * Writes go through `apply()` as a **whole plan**, never one path at a time. A
 * binding change is frequently two or three paths at once (playlist + initial
 * track, or playlist + track + priority), and for the `updateObject` backend each
 * separate write is its own document round-trip *and* its own `render()` - so a
 * per-path API silently turned one assignment into two saves and two re-renders.
 * Confirmed by test the moment the ops were first extracted.
 *
 * @typedef {object} BindingPlan
 * @property {Object<string, *>} [set] Paths to write, keyed by path.
 * @property {Array<string>} [unset] Paths to remove entirely.
 *
 * @typedef {object} BindingStore
 * @property {(path: string) => *} get Read one path; null when absent.
 * @property {(plan: BindingPlan) => Promise<*>} apply Commit a whole plan.
 */

/**
 * Turn `music.combat.playlist` into `music.combat.-=playlist`.
 *
 * Foundry removes a key from an ObjectField by writing the `-=` deletion
 * operator on the *leaf*, and it expands update keys with `expandObject` ->
 * `setProperty`, which splits on "." and has no bracket syntax (HR-J). Writing
 * `undefined` or `null` instead leaves the key in place with a null value,
 * which reads back as "configured, to nothing".
 * @param {string} path
 * @returns {string}
 */
export function toDeletionKey(path) {
  const cut = path.lastIndexOf('.');
  return cut < 0 ? `-=${path}` : `${path.slice(0, cut)}.-=${path.slice(cut + 1)}`;
}

/**
 * Store backed by a Scene's (or any Document's) module flags.
 * @param {Document} document
 * @returns {BindingStore}
 */
export function documentFlagStore(document) {
  return {
    get: (path) => document.getFlag(CONST.moduleId, path) ?? null,
    apply: async ({ set = {}, unset = [] }) => {
      // setFlag/unsetFlag are inherently one path per call, so this backend stays
      // sequential; the batching that matters is updateObjectStore's below.
      for (const [path, value] of Object.entries(set)) await document.setFlag(CONST.moduleId, path, value);
      for (const path of unset) await document.unsetFlag(CONST.moduleId, path);
    }
  };
}

/**
 * Store backed by a host exposing `updateObject(data)` and `readData()` - the
 * shape `GameOrchestraConfig` already has, covering both a live Document and a
 * PrototypeToken (whose writes have to be routed through the parent Actor).
 *
 * Deletion goes through {@link toDeletionKey} rather than a dedicated unset
 * call, because `updateObject` speaks only in update-data keys.
 * @param {{updateObject: (data: object) => Promise<*>, readData: () => object}} host
 * @returns {BindingStore}
 */
export function updateObjectStore(host) {
  return {
    get: (path) => foundry.utils.getProperty(host.readData() || {}, path) ?? null,
    apply: ({ set = {}, unset = [] }) => {
      // One updateObject call for the whole plan: one document round-trip, one
      // re-render. See the BindingStore typedef.
      const data = { ...set };
      for (const path of unset) data[toDeletionKey(path)] = null;
      return host.updateObject(data);
    }
  };
}

/**
 * Store backed by the `defaultMusic` world setting - the synthetic
 * `DefaultMusic` pseudo-document (see architecture.md § Storage).
 *
 * Reads and writes clone the whole setting object and write it back whole,
 * because a setting has no per-path update the way a Document flag does.
 * @returns {BindingStore}
 */
export function globalSettingStore() {
  const root = 'data.game-orchestra';
  const read = () => game.settings.get(CONST.moduleId, CONST.settings.defaultMusic) || {};
  return {
    get: (path) => foundry.utils.getProperty(read(), `${root}.${path}`) ?? null,
    apply: ({ set = {}, unset = [] }) => {
      // One clone and one settings.set for the whole plan. A world setting write is
      // a database round-trip broadcast to every client, and its onChange re-resolves
      // playback - doing that once per field was three of each for one assignment.
      const updated = foundry.utils.deepClone(read());
      for (const [path, value] of Object.entries(set)) foundry.utils.setProperty(updated, `${root}.${path}`, value);
      for (const path of unset) {
        const cut = path.lastIndexOf('.');
        const parent = cut < 0 ? updated : foundry.utils.getProperty(updated, `${root}.${path.slice(0, cut)}`);
        if (parent) delete parent[cut < 0 ? path : path.slice(cut + 1)];
      }
      return game.settings.set(CONST.moduleId, CONST.settings.defaultMusic, updated);
    }
  };
}

/**
 * Build the path for a music section, optionally scoped to an overlay (a mood id
 * for 'area', a phase id for 'combat' - config.mjs#sectionAxis).
 * @param {'area'|'combat'} section
 * @param {string|null} [overlayId]
 * @returns {string}
 */
export function bindingPath(section, overlayId = null) {
  return overlayId ? `music.${section}.overlays.${overlayId}` : `music.${section}`;
}

/**
 * Assign a playlist to a binding, or clear the binding when `playlistId` is null.
 *
 * Clearing removes `priority` alongside `playlist` and `initialTrack`. Leaving a
 * stale priority behind on an emptied section is invisible until the section is
 * reassigned, at which point it silently outranks (or is outranked by) everything
 * for a reason nothing on screen explains.
 * @param {BindingStore} store
 * @param {string} path - From {@link bindingPath}
 * @param {string|null} playlistId
 * @param {string} [trackIdOverride] - Used verbatim when provided (e.g. a specific
 *   track dragged onto the entry) instead of resolving from the existing value.
 * @returns {Promise<void>}
 */
export async function applyBindingPlaylist(store, path, playlistId, trackIdOverride = undefined) {
  if (!playlistId) {
    return store.apply({ unset: [`${path}.playlist`, `${path}.initialTrack`, `${path}.priority`] });
  }
  const existingTrackId = store.get(`${path}.initialTrack`) || null;
  const initialTrackId = trackIdOverride !== undefined ? trackIdOverride : resolveInitialTrack(playlistId, existingTrackId);
  const set = { [`${path}.playlist`]: playlistId };
  if (initialTrackId) set[`${path}.initialTrack`] = initialTrackId;
  return store.apply({ set });
}

/**
 * Remove an overlay entry outright - the whole `overlays.<id>` object, not just its
 * fields.
 *
 * Deliberately different from `applyBindingPlaylist(store, path, null)`, which is
 * what a *section*-level clear uses: a section also carries `exclusive` and `duck`
 * (architecture.md § Layers), and those must survive having the playlist cleared.
 *
 * An overlay entry carries `layer` and `duck` of its own, and those must **not** survive:
 * a cleared entry that kept `layer: true` would silently start layering again the next time
 * a playlist was picked for it, for a reason nothing on screen explains - exactly the failure
 * mode that made `applyBindingPlaylist` clear `priority`. Removing the whole entry also avoids
 * leaving an empty `{}` behind for every overlay ever assigned.
 * @param {BindingStore} store
 * @param {'area'|'combat'} section
 * @param {string} overlayId
 * @returns {Promise<void>}
 */
export async function clearBindingOverlay(store, section, overlayId) {
  return store.apply({ unset: [`music.${section}.overlays.${overlayId}`] });
}

/**
 * Set (or clear) a binding's initial track.
 * @param {BindingStore} store
 * @param {string} path
 * @param {string|null} trackId
 * @returns {Promise<void>}
 */
export async function applyBindingTrack(store, path, trackId) {
  return trackId
    ? store.apply({ set: { [`${path}.initialTrack`]: trackId } })
    : store.apply({ unset: [`${path}.initialTrack`] });
}

/**
 * Set (or clear) whether an overlay binding plays as an additive **layer** over its own
 * section's base music, instead of replacing it (architecture.md § Layers).
 *
 * `false` UNSETS rather than storing `false`: replacing is the default and the absent value, so
 * writing the negative would leave every overlay anyone ever toggled carrying a field that means
 * exactly what its absence already meant. Clearing `duck` alongside it keeps a stale attenuation
 * from being silently re-applied if the entry is later made a layer again - the same reasoning
 * that has `applyBindingPlaylist` clear `priority`.
 * @param {BindingStore} store
 * @param {string} path - From {@link bindingPath}, overlay-scoped
 * @param {boolean} layer
 * @returns {Promise<void>}
 */
export async function applyBindingLayer(store, path, layer) {
  return layer
    ? store.apply({ set: { [`${path}.layer`]: true } })
    : store.apply({ unset: [`${path}.layer`, `${path}.duck`] });
}

/**
 * Set (or clear) how far a layer binding attenuates everything that is not itself while it plays.
 *
 * Stored as the resulting MULTIPLIER in [0, 1] (1 = untouched), matching the mixer's `gain` field.
 * A factor of 1 removes the key rather than storing it, so "no ducking" stays the absent-value
 * default - the same shape `GameOrchestraConfig` uses for a token's section-level duck.
 * @param {BindingStore} store
 * @param {string} path - From {@link bindingPath}
 * @param {number} duck
 * @returns {Promise<void>}
 */
export async function applyBindingDuck(store, path, duck) {
  return duck < 1
    ? store.apply({ set: { [`${path}.duck`]: duck } })
    : store.apply({ unset: [`${path}.duck`] });
}

/**
 * Set (or clear) whether a combatant's own combat music **replaces** the winning context instead
 * of playing as an additive layer over it (architecture.md § Layers).
 *
 * Stored once per **section** (`music.combat.exclusive`), never per phase overlay: one flag
 * governs whichever playlist the section resolves to for any phase.
 *
 * `false` UNSETS, exactly as {@link applyBindingLayer} does and for the same reason - absent
 * means "layers", so writing the negative stores a field that means what its absence already
 * meant. Note the two opt-in directions are *opposite*: a combatant layers unless it opts out
 * here, while a mood/phase overlay replaces unless it opts in via `layer`. That asymmetry is
 * deliberate and predates both flags; flipping either would silently change every configured
 * world.
 * @param {BindingStore} store
 * @param {string} path - From {@link bindingPath}, section-scoped (no overlay id)
 * @param {boolean} exclusive
 * @returns {Promise<void>}
 */
export async function applyBindingExclusive(store, path, exclusive) {
  return exclusive
    ? store.apply({ set: { [`${path}.exclusive`]: true } })
    : store.apply({ unset: [`${path}.exclusive`] });
}

/**
 * Pick the {@link BindingStore} backing one binding target.
 *
 * Three of the four targets need no code of their own; the **prototype token is the exception**
 * and is the reason this function exists rather than being inlined at each call site. It lives
 * here rather than in `api.mjs` because three callers now need it - the public API, the hub's
 * actor scope, and the hub's scoped popout - and the prototype-token branch is precisely the one
 * that fails *silently* when it is copied slightly wrong (HR-J).
 *
 * The error is supplied by the caller rather than thrown as a fixed type, so `api.mjs` keeps
 * raising its own `GameOrchestraApiError` with an `INVALID_ARGUMENT` code while a UI caller gets
 * a plain `Error` - without this module having to know either type exists.
 * @param {'default'|object} target - `'default'`, or a Scene / TokenDocument / Actor /
 *   PrototypeToken document.
 * @param {(message: string) => Error} [makeError] - Builds the error thrown on a bad target.
 * @returns {BindingStore}
 * @throws {Error} Whatever `makeError` returns, when the target cannot back a binding.
 */
export function storeForTarget(target, makeError = (message) => new Error(message)) {
  if (target === 'default') return globalSettingStore();
  if (!target || typeof target !== 'object') {
    throw makeError("Expected 'default' or a Scene / TokenDocument / Actor / PrototypeToken document.");
  }
  if (getDocumentCategory(target) === 'PrototypeToken') {
    const actor = target.parent;
    if (!actor) {
      throw makeError('That PrototypeToken has no parent Actor, so there is nothing to write to.');
    }
    // Mirrors GameOrchestraConfig#updateObject's PrototypeToken branch, and must keep mirroring
    // it. Plain DOT NOTATION, never `flags['game-orchestra']`: Foundry expands update keys with
    // expandObject -> setProperty, which splits on "." and has no bracket syntax (HR-J). The
    // bracketed form produced a literal key the Actor schema dropped while cleaning - the update
    // resolved successfully and wrote NOTHING, confirmed live.
    //
    // Headless on purpose (HR-I): there is no sheet here, so there is no `app.token` preview
    // clone to be caught by. That immunity is an argument for this host over reusing the window's.
    return updateObjectStore({
      readData: () => target.flags?.[CONST.moduleId] ?? {},
      updateObject: (data) => actor.update(Object.entries(data).reduce((acc, [key, value]) => {
        acc[`prototypeToken.flags.${CONST.moduleId}.${key}`] = value;
        return acc;
      }, {}))
    });
  }
  if (typeof target.setFlag !== 'function') {
    throw makeError(`Cannot bind against a ${target.constructor?.name ?? 'value'} - it is not a Document.`);
  }
  return documentFlagStore(target);
}

/**
 * Set (or clear) a binding's priority override.
 *
 * **No UI writes this any more.** Priority is resolution-internal (docs/wiki/ux.md D8): the field
 * is still stored, still read by `_extractSectionConfig`, still offset `+10` for an overlay, and
 * still cleared alongside its binding by {@link applyBindingPlaylist} - the GM just never types
 * the number. This stays the canonical write-op for it, for a macro or for future code that needs
 * to set one; do not delete it as "unused" without also deciding the field itself is going.
 *
 * A null value UNSETS rather than writing 0 - those are different states to
 * resolution. `helpers.mjs#_extractSectionConfig` reads
 * `config.priority ?? basePriority`, so an explicit 0 pins the entry at zero
 * while an absent one inherits the section baseline plus any overlay offset.
 * @param {BindingStore} store
 * @param {string} path
 * @param {number|null} priority
 * @returns {Promise<void>}
 */
export async function applyBindingPriority(store, path, priority) {
  return priority === null
    ? store.apply({ unset: [`${path}.priority`] })
    : store.apply({ set: { [`${path}.priority`]: priority } });
}

/**
 * Coerce a raw form value into a priority: a finite number, or null for blank.
 *
 * The string '0' must survive as 0 rather than being coerced to null the way a
 * blank is - see {@link applyBindingPriority} for why those differ.
 * @param {string|number|null} raw
 * @returns {number|null}
 */
export function coercePriority(raw) {
  if (raw === null || raw === undefined || `${raw}`.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
