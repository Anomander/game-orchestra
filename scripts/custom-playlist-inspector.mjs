/**
 * Builds the custom playlist editor's inspector panel as an HTML string, from
 * plain data - no Drawflow instance, DOM, or live Foundry app required. This
 * is deliberately NOT rendered through Handlebars/ApplicationV2's own render
 * cycle: this module's editor discovered (via live testing) that Drawflow's
 * own 'nodeSelected' event fires synchronously inside its mousedown handler,
 * *before* it sets up a drag - so triggering a full ApplicationV2 re-render
 * from that event tears down and rebuilds the canvas mid-mousedown, orphaning
 * the drag on a detached DOM tree (nodes select, but silently never move,
 * with no console error). Rendering the inspector as a plain string that gets
 * assigned to a *sibling* container's innerHTML never touches the canvas, so
 * Drawflow's live instance and its in-progress interactions are left alone.
 */

import { NODE_LABELS, escapeHtml } from './custom-playlist-node-render.mjs';
import { CONDITION_KINDS_WITH_VALUE, resolveScript } from './custom-playback-schema.mjs';

/**
 * Condition kinds a user can pick. 'default' is deliberately absent: every
 * Condition node carries exactly one fixed fallback exit whose kind is
 * 'default', which is rendered read-only and cannot be removed, so a second
 * one can never be created (nor the fixed one turned into something else).
 */
const CONDITION_KIND_LABELS = ['combatActive', 'combatIdle', 'mood', 'moodChanged', 'phase', 'phaseChanged', 'enemiesDefeated'];

/**
 * Condition kinds whose exit needs a value (an overlay id to match) - the axis picks moods or
 * phases. 'moodChanged'/'phaseChanged' deliberately take no value: they match against the overlay
 * value captured when the current run/loop began (custom-playback-engine.mjs#_evaluateCondition),
 * not a GM-picked id.
 */
/**
 * Human-readable `<option>` list for a condition kind `<select>`. Every kind
 * here is already camelCase (e.g. 'combatActive'), so its lang key suffix is
 * just that string capitalized - no separate lookup table to keep in sync.
 * @param {string|undefined} selectedKind
 * @param {(key: string, data?: object) => string} loc
 * @returns {string}
 */
function buildConditionKindOptions(selectedKind, loc) {
  return CONDITION_KIND_LABELS.map((kind) => {
    const labelKey = `GameOrchestra.CustomEditor.Inspector.ConditionKind.${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    return `<option value="${kind}" ${kind === selectedKind ? 'selected' : ''}>${escapeHtml(loc(labelKey))}</option>`;
  }).join('');
}

/**
 * Value selector for a 'mood'/'phase' condition - a dropdown of that axis's
 * configured overlay ids (config.mjs#sectionAxis) rather than a free-text
 * input a GM would have to already know the exact id to fill in correctly.
 * Shared by the Condition node's own exits and a Track's until-loop escape
 * condition, which reuse the identical GraphCondition vocabulary.
 * @param {string|undefined} kind
 * @param {string|undefined} value
 * @param {string} dataAttrs - Pre-built data-change-action/data-node-id(/data-exit-index) attributes.
 * @param {Array<{id: string, label: string}>} moodOptions
 * @param {Array<{id: string, label: string}>} phaseOptions
 * @param {(key: string, data?: object) => string} loc
 * @returns {string}
 */
function buildConditionValueSelect(kind, value, dataAttrs, moodOptions, phaseOptions, loc) {
  const options = kind === 'phase' ? phaseOptions : moodOptions;
  const optionsHtml = [`<option value="">-- ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.OverlayId'))} --</option>`]
    .concat((options || []).map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`))
    .join('');
  return `<select ${dataAttrs}>${optionsHtml}</select>`;
}

/**
 * One validation issue as HTML, prefixed with the offending node's name when it
 * has one - "This node is not reachable from Start" is useless on a canvas full
 * of nodes without saying which. graph-validation.mjs has no dependency on
 * Foundry/game.i18n, so an issue carries a messageKey (+ optional messageData
 * for interpolation) rather than a localized string - this is where that key
 * is finally resolved.
 * @param {{nodeLabel?: string|null, messageKey: string, messageData?: object}} issue
 * @param {(key: string, data?: object) => string} loc
 * @returns {string}
 */
function issueText(issue, loc) {
  const label = issue?.nodeLabel;
  const message = loc(issue?.messageKey, issue?.messageData);
  return label ? `<strong>${escapeHtml(label)}</strong>: ${escapeHtml(message)}` : escapeHtml(message);
}

/**
 * One validation issue as a list item. Issues that name a node are clickable
 * and pan the canvas to it (CustomPlaylistEditor#handleFocusNode) - on a graph
 * larger than the viewport, being told a node has a problem is not much use
 * without a way to get to it. Graph-wide issues belong to no node and stay
 * inert.
 * @param {object} issue
 * @param {string} tag - Wrapper element name.
 * @param {(key: string, data?: object) => string} loc
 * @returns {string}
 */
function issueItem(issue, tag, loc) {
  const text = issueText(issue, loc);
  if (!issue?.nodeId) return `<${tag}>${text}</${tag}>`;
  return `<${tag} class="game-orchestra-issue-locatable" data-action="focusNode" data-node-id="${escapeHtml(issue.nodeId)}" title="${escapeHtml(loc('GameOrchestra.CustomEditor.Validation.ShowOnCanvas'))}">${text}</${tag}>`;
}

/** True for the fixed fallback exit of a Condition node. */
function isDefaultExit(exit) {
  return exit?.condition?.kind === 'default';
}

/**
 * Attributes that tie an exit row back to the output port it configures, so
 * hovering the row can highlight that port (and the wire leaving it) on the
 * canvas - see CustomPlaylistEditor#_onExitHover.
 * @param {string} nodeId
 * @param {{portName: string}} exit
 * @returns {string}
 */
function exitRowAttributes(nodeId, exit) {
  return `data-node-id="${escapeHtml(nodeId)}" data-exit-port="${escapeHtml(exit.portName)}"`;
}

/**
 * Fields for a Track node's `loop.mode === 'until'` sub-panel: the escape
 * condition (reusing the same kind vocabulary and value input as a Condition
 * node's exits), which boundary to act on, and the minLoops/maxLoops floor
 * and cap. Split out from buildInspectorHtml() purely to keep that function's
 * per-type branch readable - this has no independent purpose.
 * @param {object} selectedNode - A Track GraphNode with loop.mode === 'until'.
 * @param {(key: string, data?: object) => string} loc
 * @param {Array<{id: string, label: string}>} moodOptions
 * @param {Array<{id: string, label: string}>} phaseOptions
 * @returns {string}
 * @private
 */
function buildUntilLoopFieldsHtml(selectedNode, loc, moodOptions, phaseOptions) {
  const loop = selectedNode.loop || {};
  const kindOptions = buildConditionKindOptions(loop.condition?.kind, loc);
  const untilAttrs = `data-change-action="updateTrackUntilValue" data-node-id="${escapeHtml(selectedNode.id)}"`;
  const valueInput = CONDITION_KINDS_WITH_VALUE.has(loop.condition?.kind)
    ? buildConditionValueSelect(loop.condition?.kind, loop.condition?.value ?? '', untilAttrs, moodOptions, phaseOptions, loc)
    : '';
  const boundary = loop.boundary === 'loopEnd' ? 'loopEnd' : 'immediate';
  const boundaryOptions = [
    ['immediate', 'Immediate'],
    ['loopEnd', 'LoopEnd']
  ]
    .map(
      ([value, key]) =>
        `<option value="${value}" ${value === boundary ? 'selected' : ''}>${escapeHtml(loc(`GameOrchestra.CustomEditor.Inspector.UntilBoundary.${key}`))}</option>`
    )
    .join('');

  return `
    <p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilHint'))}</p>
    <div class="form-group">
      <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilConditionLabel'))}</label>
      <select data-change-action="updateTrackUntilKind" data-node-id="${escapeHtml(selectedNode.id)}">${kindOptions}</select>
      ${valueInput}
    </div>
    <div class="form-group">
      <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilBoundaryLabel'))}</label>
      <select data-change-action="updateTrackUntilBoundary" data-node-id="${escapeHtml(selectedNode.id)}">${boundaryOptions}</select>
    </div>
    <div class="form-group">
      <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilMinLoops'))}</label>
      <input type="number" min="1" step="1" value="${escapeHtml(loop.minLoops ?? 1)}" data-change-action="updateTrackUntilMinLoops" data-node-id="${escapeHtml(selectedNode.id)}" />
    </div>
    <div class="form-group">
      <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilMaxLoops'))}</label>
      <input type="number" min="1" step="1" value="${escapeHtml(loop.maxLoops ?? '')}" placeholder="${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilMaxLoopsUnbounded'))}"
             data-change-action="updateTrackUntilMaxLoops" data-node-id="${escapeHtml(selectedNode.id)}" />
    </div>
  `;
}

/**
 * @param {object} params
 * @param {object|null} params.selectedNode - The currently-selected GraphNode, or null.
 * @param {Array<{id: string, name: string, selected: boolean}>} params.soundOptions - Track nodes
 *   only, and read ONLY to resolve the selected sound's display name - the sound is not editable
 *   here (see the track branch below).
 * @param {Array<{id: string, name: string, selected: boolean}>} [params.playlistOptions] -
 *   Playlist nodes only: every playlist a direct reference could target (the playlist being
 *   edited already excluded by the caller - see custom-playlist-editor.mjs).
 * @param {Array<{id: string, label: string, selected: boolean}>} [params.overlayOptions] -
 *   Playlist nodes only: configured moods or phases (whichever the ref's own section implies -
 *   see config.mjs#sectionAxis), for a 'specific' overlay-mode reference.
 * @param {Array<{id: string, label: string}>} [params.moodOptions] - Every configured mood, for a
 *   'mood'-kind condition's value dropdown (Condition node exits, a Track's until-loop condition).
 * @param {Array<{id: string, label: string}>} [params.phaseOptions] - Same, for 'phase'-kind conditions.
 * @param {Array<{uuid: string, name: string}>} [params.macroOptions] - Script macros this world
 *   has, for a Script node's macro picker. Resolved by the caller so this module stays Foundry-free.
 * @param {{inlineAllowed: boolean, canAuthor: boolean}} [params.scripting] - Whether inline source
 *   may run in this world, and whether this user may author it. Both are live environment state,
 *   passed in for the same reason macroOptions is.
 * @param {Array<object>} params.selectedExits - Edges from selectedNode, each with a portName
 *   and (for random/condition) weight/cooldown/condition already attached.
 * @param {(key: string, data?: object) => string} params.localize - Resolves a plain key via
 *   game.i18n.localize(), or interpolates via game.i18n.format() when data is given (only
 *   validation issue messages currently carry data - see graph-validation.mjs).
 * @returns {string} HTML for the inspector panel's contents. Validation is NOT included here -
 *   see buildValidationHtml() below. It moved out so it stays visible (in a pinned region
 *   outside the accordion panel) even while the Properties pane containing this HTML is
 *   collapsed - see docs/graph-editor-panel-plan.md D4.
 */
export function buildInspectorHtml({ selectedNode, soundOptions, playlistOptions, overlayOptions, moodOptions, phaseOptions, macroOptions, scripting, selectedExits, localize }) {
  const loc = localize || ((k) => k);
  const parts = [];

  if (selectedNode) {
    parts.push(`<h3>${escapeHtml(selectedNode.type)}</h3>`);
    // Every node type gets a name, so validation messages and the canvas
    // caption can refer to it as something other than "a Track node".
    parts.push(`
      <div class="form-group">
        <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Name'))}</label>
        <input type="text" value="${escapeHtml(selectedNode.label ?? '')}" placeholder="${escapeHtml(NODE_LABELS[selectedNode.type] || selectedNode.type)}"
               data-change-action="updateNodeLabel" data-node-id="${escapeHtml(selectedNode.id)}" />
      </div>
    `);

    if (selectedNode.type === 'track') {
      // Read-only, deliberately: a Track node's sound is chosen when the node is created (drag a
      // row out of the Tracks pane, or use its "+" button) and never reassigned afterwards. The
      // editable <select> that used to live here made the two routes disagree about what a Track
      // node IS - one graph position per sound, or a slot you repoint - and the drag route is the
      // one the Tracks pane's usage counts ("x2" per sound) are built around.
      const soundName = (soundOptions || []).find((s) => s.selected)?.name || null;
      const soundHtml = soundName
        ? escapeHtml(soundName)
        : `<span class="game-orchestra-value-empty">${escapeHtml(loc('GameOrchestra.None'))}</span>`;
      parts.push(`
        <div class="form-group">
          <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Sound'))}</label>
          <p class="game-orchestra-readonly-value">${soundHtml}</p>
        </div>
        <p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.SoundReadOnly'))}</p>
        <div class="form-group">
          <label>
            <input type="checkbox" data-change-action="updateTrackInfinite" data-node-id="${escapeHtml(selectedNode.id)}" ${selectedNode.loop?.mode === 'forever' ? 'checked' : ''} />
            ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Infinite'))}
          </label>
        </div>
      `);
      if (selectedNode.loop?.mode === 'forever') {
        parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.InfiniteHint'))}</p>`);
      } else {
        const isUntil = selectedNode.loop?.mode === 'until';
        parts.push(`
          <div class="form-group">
            <label>
              <input type="checkbox" data-change-action="updateTrackUntilToggle" data-node-id="${escapeHtml(selectedNode.id)}" ${isUntil ? 'checked' : ''} />
              ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.UntilToggle'))}
            </label>
          </div>
        `);
        if (isUntil) {
          parts.push(buildUntilLoopFieldsHtml(selectedNode, loc, moodOptions, phaseOptions));
        } else {
          parts.push(`
            <div class="form-group">
              <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.LoopCount'))}</label>
              <input type="number" min="1" step="1" value="${escapeHtml(selectedNode.loop?.count ?? 1)}" data-change-action="updateTrackLoopCount" data-node-id="${escapeHtml(selectedNode.id)}" />
            </div>
          `);
        }
      }
    } else if (selectedNode.type === 'script') {
      const script = resolveScript(selectedNode);
      const modeOptions = ['macro', 'inline']
        .map((m) => `<option value="${m}" ${m === script.mode ? 'selected' : ''}>${escapeHtml(loc(`GameOrchestra.CustomEditor.Inspector.ScriptMode.${m === 'macro' ? 'Macro' : 'Inline'}`))}</option>`)
        .join('');
      parts.push(`
        <div class="form-group">
          <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ScriptModeLabel'))}</label>
          <select data-change-action="updateScriptMode" data-node-id="${escapeHtml(selectedNode.id)}">${modeOptions}</select>
        </div>
      `);
      if (script.mode === 'macro') {
        const macroSelectOptions = [`<option value="">-- ${escapeHtml(loc('GameOrchestra.None'))} --</option>`]
          .concat((macroOptions || []).map((m) => `<option value="${escapeHtml(m.uuid)}" ${m.uuid === script.macroUuid ? 'selected' : ''}>${escapeHtml(m.name)}</option>`))
          .join('');
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ScriptMacro'))}</label>
            <select data-change-action="updateScriptMacro" data-node-id="${escapeHtml(selectedNode.id)}">${macroSelectOptions}</select>
          </div>
          <p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ScriptMacroHint'))}</p>
        `);
      } else {
        // UX-9: disabled WITH A REASON, never hidden, and only when it genuinely would not work.
        // Two independent reasons, reported separately because they have different remedies - one
        // is a world setting a GM can flip, the other is a permission or a deployment's CSP.
        const blockedKey = scripting?.canAuthor === false
          ? 'GameOrchestra.CustomEditor.Inspector.ScriptNoPermissionHint'
          : scripting?.inlineAllowed === false
            ? 'GameOrchestra.CustomEditor.Inspector.ScriptDisabledHint'
            : null;
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ScriptSource'))}</label>
            <textarea rows="8" class="game-orchestra-script-source" spellcheck="false"
                      data-change-action="updateScriptSource" data-node-id="${escapeHtml(selectedNode.id)}"
                      ${blockedKey ? 'readonly' : ''}>${escapeHtml(script.source ?? '')}</textarea>
          </div>
          ${blockedKey ? `<p class="hint game-orchestra-issue-error">${escapeHtml(loc(blockedKey))}</p>` : ''}
          <p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ScriptSourceHint'))}</p>
        `);
      }
    } else if (selectedNode.type === 'delay') {
      parts.push(`
        <div class="form-group">
          <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.DelayMin'))}</label>
          <input type="number" min="0" step="0.5" value="${escapeHtml(selectedNode.delay?.min ?? 0)}" data-change-action="updateDelayMin" data-node-id="${escapeHtml(selectedNode.id)}" />
        </div>
        <div class="form-group">
          <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.DelayMax'))}</label>
          <input type="number" min="0" step="0.5" value="${escapeHtml(selectedNode.delay?.max ?? 0)}" data-change-action="updateDelayMax" data-node-id="${escapeHtml(selectedNode.id)}" />
        </div>
      `);
    } else if (selectedNode.type === 'random') {
      parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.RandomHint'))}</p>`);
      parts.push(`
        <div class="form-group">
          <label>
            <input type="checkbox" data-change-action="updateRandomAvoidRepeat" data-node-id="${escapeHtml(selectedNode.id)}" ${selectedNode.avoidRepeat ? 'checked' : ''} />
            ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.AvoidRepeat'))}
          </label>
        </div>
      `);
      const randomExits = selectedExits || [];
      // A header row, because both fields are bare number inputs whose only
      // labelling was a placeholder - and a placeholder vanishes the moment the
      // field has a value, which for these two is always (they default to 1 and
      // 0). Reported from a live screenshot as two unexplained boxes. The prose
      // hint above says what they MEAN; this says which is which.
      if (randomExits.length > 0) {
        parts.push(`
          <div class="game-orchestra-exit-row game-orchestra-exit-columns" aria-hidden="true">
            <label></label>
            <span>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Weight'))}</span>
            <span>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Cooldown'))}</span>
            <span class="game-orchestra-exit-row-spacer"></span>
          </div>
        `);
      }
      randomExits.forEach((exit, i) => {
        // A Random with no exits is a dead end (and a validation error), so the
        // last remaining one is fixed - there is always at least one exit.
        const removable = randomExits.length > 1;
        parts.push(`
          <div class="form-group game-orchestra-exit-row" ${exitRowAttributes(selectedNode.id, exit)}>
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ExitN'))} ${i}</label>
            <input type="number" min="0" step="1" value="${escapeHtml(exit.weight ?? 1)}" placeholder="${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Weight'))}"
                   data-change-action="updateRandomExitWeight" data-node-id="${escapeHtml(selectedNode.id)}" data-exit-index="${i}" />
            <input type="number" min="0" step="1" value="${escapeHtml(exit.cooldown ?? 0)}" placeholder="${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.Cooldown'))}"
                   data-change-action="updateRandomExitCooldown" data-node-id="${escapeHtml(selectedNode.id)}" data-exit-index="${i}" />
            ${
              removable
                ? `<button type="button" class="clear-btn" data-action="removeExit" data-node-id="${escapeHtml(selectedNode.id)}" data-port="${escapeHtml(exit.portName)}" title="${escapeHtml(loc('GameOrchestra.UI.Delete'))}">
              <i class="fas fa-trash"></i>
            </button>`
                : `<span class="game-orchestra-fixed-exit" title="${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.FixedExitHint'))}"><i class="fas fa-lock"></i></span>`
            }
          </div>
        `);
      });
      parts.push(`<button type="button" data-action="addExit" data-node-id="${escapeHtml(selectedNode.id)}"><i class="fas fa-plus"></i> ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.AddExit'))}</button>`);
    } else if (selectedNode.type === 'condition') {
      parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ConditionHint'))}</p>`);
      (selectedExits || []).forEach((exit, i) => {
        // The fallback exit is fixed: read-only kind, no remove button. It's what
        // guarantees a Condition node always has somewhere to send a token.
        if (isDefaultExit(exit)) {
          parts.push(`
            <div class="form-group game-orchestra-exit-row game-orchestra-exit-row-fixed" ${exitRowAttributes(selectedNode.id, exit)}>
              <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.DefaultExit'))}</label>
              <span class="game-orchestra-fixed-exit"><i class="fas fa-lock"></i> ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.DefaultExitValue'))}</span>
            </div>
          `);
          return;
        }
        const kindOptions = buildConditionKindOptions(exit.condition?.kind, loc);
        const exitAttrs = `data-change-action="updateConditionExitValue" data-node-id="${escapeHtml(selectedNode.id)}" data-exit-index="${i}"`;
        const valueInput = CONDITION_KINDS_WITH_VALUE.has(exit.condition?.kind)
          ? buildConditionValueSelect(exit.condition?.kind, exit.condition?.value ?? '', exitAttrs, moodOptions, phaseOptions, loc)
          : '';
        parts.push(`
          <div class="form-group game-orchestra-exit-row" ${exitRowAttributes(selectedNode.id, exit)}>
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ExitN'))} ${i}</label>
            <select data-change-action="updateConditionExitKind" data-node-id="${escapeHtml(selectedNode.id)}" data-exit-index="${i}">${kindOptions}</select>
            ${valueInput}
            <button type="button" class="clear-btn" data-action="removeExit" data-node-id="${escapeHtml(selectedNode.id)}" data-port="${escapeHtml(exit.portName)}" title="${escapeHtml(loc('GameOrchestra.UI.Delete'))}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        `);
      });
      parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.DefaultExitHint'))}</p>`);
      parts.push(`<button type="button" data-action="addExit" data-node-id="${escapeHtml(selectedNode.id)}"><i class="fas fa-plus"></i> ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.AddExit'))}</button>`);
    } else if (selectedNode.type === 'fork') {
      parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ForkHint'))}</p>`);
      (selectedExits || []).forEach((exit, i) => {
        parts.push(`
          <div class="form-group game-orchestra-exit-row" ${exitRowAttributes(selectedNode.id, exit)}>
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.ExitN'))} ${i}</label>
            <button type="button" class="clear-btn" data-action="removeExit" data-node-id="${escapeHtml(selectedNode.id)}" data-port="${escapeHtml(exit.portName)}" title="${escapeHtml(loc('GameOrchestra.UI.Delete'))}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        `);
      });
      parts.push(`<button type="button" data-action="addExit" data-node-id="${escapeHtml(selectedNode.id)}"><i class="fas fa-plus"></i> ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.AddExit'))}</button>`);
    } else if (selectedNode.type === 'playlist') {
      const ref = selectedNode.playlistRef || {};
      const source = ref.source === 'scene' || ref.source === 'default' ? ref.source : 'direct';
      const sourceLabelKey = { direct: 'Direct', scene: 'Scene', default: 'Default' };
      const sourceOptions = ['direct', 'scene', 'default']
        .map((s) => `<option value="${s}" ${s === source ? 'selected' : ''}>${escapeHtml(loc(`GameOrchestra.CustomEditor.Inspector.PlaylistSource.${sourceLabelKey[s]}`))}</option>`)
        .join('');
      parts.push(`
        <div class="form-group">
          <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistSourceLabel'))}</label>
          <select data-change-action="updatePlaylistSource" data-node-id="${escapeHtml(selectedNode.id)}">${sourceOptions}</select>
        </div>
      `);

      if (source === 'direct') {
        if (!playlistOptions || playlistOptions.length === 0) {
          parts.push(`<p class="hint game-orchestra-empty-playlist-hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.NoPlaylists'))}</p>`);
        }
        const targetOptions = [`<option value="">-- ${escapeHtml(loc('GameOrchestra.None'))} --</option>`]
          .concat((playlistOptions || []).map((p) => `<option value="${escapeHtml(p.id)}" ${p.selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`))
          .join('');
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistTarget'))}</label>
            <select data-change-action="updatePlaylistTarget" data-node-id="${escapeHtml(selectedNode.id)}">${targetOptions}</select>
          </div>
        `);
      } else {
        const section = ref.section === 'combat' ? 'combat' : 'area';
        const sectionLabelKey = { area: 'Area', combat: 'Combat' };
        const sectionOptions = ['area', 'combat']
          .map((s) => `<option value="${s}" ${s === section ? 'selected' : ''}>${escapeHtml(loc(`GameOrchestra.CustomEditor.Inspector.PlaylistSection.${sectionLabelKey[s]}`))}</option>`)
          .join('');
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistSectionLabel'))}</label>
            <select data-change-action="updatePlaylistSection" data-node-id="${escapeHtml(selectedNode.id)}">${sectionOptions}</select>
          </div>
        `);

        const overlayMode = ['active', 'none', 'specific'].includes(ref.overlayMode) ? ref.overlayMode : 'active';
        const overlayModeLabelKey = { active: 'Active', none: 'None', specific: 'Specific' };
        const overlayModeOptions = ['active', 'none', 'specific']
          .map((m) => `<option value="${m}" ${m === overlayMode ? 'selected' : ''}>${escapeHtml(loc(`GameOrchestra.CustomEditor.Inspector.PlaylistOverlayMode.${overlayModeLabelKey[m]}`))}</option>`)
          .join('');
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistOverlayModeLabel'))}</label>
            <select data-change-action="updatePlaylistOverlayMode" data-node-id="${escapeHtml(selectedNode.id)}">${overlayModeOptions}</select>
          </div>
        `);

        if (overlayMode === 'specific') {
          const overlaySelectOptions = [`<option value="">-- ${escapeHtml(loc('GameOrchestra.None'))} --</option>`]
            .concat((overlayOptions || []).map((m) => `<option value="${escapeHtml(m.id)}" ${m.selected ? 'selected' : ''}>${escapeHtml(m.label)}</option>`))
            .join('');
          parts.push(`
            <div class="form-group">
              <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistOverlayId'))}</label>
              <select data-change-action="updatePlaylistOverlayId" data-node-id="${escapeHtml(selectedNode.id)}">${overlaySelectOptions}</select>
            </div>
          `);
        }
      }

      parts.push(`
        <div class="form-group">
          <label>
            <input type="checkbox" data-change-action="updatePlaylistInfinite" data-node-id="${escapeHtml(selectedNode.id)}" ${selectedNode.loop?.mode === 'forever' ? 'checked' : ''} />
            ${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistInfinite'))}
          </label>
        </div>
      `);
      if (selectedNode.loop?.mode === 'forever') {
        parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistInfiniteHint'))}</p>`);
      } else {
        parts.push(`
          <div class="form-group">
            <label>${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistPasses'))}</label>
            <input type="number" min="1" step="1" value="${escapeHtml(selectedNode.loop?.count ?? 1)}" data-change-action="updatePlaylistLoopCount" data-node-id="${escapeHtml(selectedNode.id)}" />
          </div>
        `);
      }
      parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.PlaylistHint'))}</p>`);
    }
  } else {
    parts.push(`<p class="hint">${escapeHtml(loc('GameOrchestra.CustomEditor.Inspector.NoSelection'))}</p>`);
  }

  return parts.join('\n');
}

/**
 * Builds the graph's validation errors/warnings/infos as an HTML string, for the pinned
 * validation region below the accordion panel (see docs/graph-editor-panel-plan.md D4) - kept
 * out of buildInspectorHtml() so a failed Save's reasons stay visible even while the Properties
 * pane is collapsed.
 * @param {object} params
 * @param {{errors: Array, warnings: Array, infos: Array}} params.validation
 * @param {(key: string, data?: object) => string} params.localize
 * @returns {string} HTML, or '' if there is nothing to show.
 */
export function buildValidationHtml({ validation, localize }) {
  const loc = localize || ((k) => k);
  const parts = [];

  if (validation?.errors?.length) {
    parts.push(
      `<div class="game-orchestra-validation-errors"><strong>${escapeHtml(loc('GameOrchestra.CustomEditor.Validation.Errors'))}</strong><ul>${validation.errors
        .map((e) => issueItem(e, 'li', loc))
        .join('')}</ul></div>`
    );
  }
  if (validation?.warnings?.length) {
    parts.push(
      `<div class="game-orchestra-validation-warnings"><strong>${escapeHtml(loc('GameOrchestra.CustomEditor.Validation.Warnings'))}</strong><ul>${validation.warnings
        .map((w) => issueItem(w, 'li', loc))
        .join('')}</ul></div>`
    );
  }
  if (validation?.infos?.length) {
    parts.push(`<div class="game-orchestra-validation-infos">${validation.infos.map((i) => issueItem(i, 'p', loc)).join('')}</div>`);
  }

  return parts.join('\n');
}

/**
 * Builds the balloon shown when a node's canvas issue badge is clicked: every
 * message for that one node, numbered. Modelled on Grasshopper's warning
 * balloon, which lists a component's messages next to the component itself
 * rather than only in a panel elsewhere.
 *
 * Complements (does not replace) buildValidationHtml() above - that one stays
 * the whole graph's list, this one answers "what is wrong with THIS node"
 * without making the user find it in a list that may name several nodes.
 *
 * Messages arrive already localized: the caller resolved them via
 * localizeIssue() when it built its per-node message map, so unlike every
 * other builder here this one takes strings rather than issue records and
 * needs no `localize`. They are still escaped - a message can interpolate a
 * user-supplied node name (graph-validation.mjs emits messageData).
 * @param {string[]} messages - Localized message strings for one node.
 * @param {'warning'|'error'} severity - The node's highest severity, for styling.
 * @returns {string} HTML, or '' when there is nothing to show.
 */
export function buildIssueBalloonHtml(messages, severity) {
  const items = (messages || []).filter((message) => String(message ?? '').trim() !== '');
  if (!items.length) return '';
  const severityClass = severity === 'error' ? 'error' : 'warning';
  return `<ol class="game-orchestra-issue-balloon-list game-orchestra-issue-balloon-${severityClass}">${items
    .map((message) => `<li>${escapeHtml(message)}</li>`)
    .join('')}</ol>`;
}
