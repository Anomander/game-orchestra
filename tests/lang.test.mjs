import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const langDir = path.join(__dirname, '../lang');

/**
 * Flattens a locale file's keys. All of this module's lang/*.json files are
 * already flat (no nested objects), but flattening defensively means this
 * guard keeps working if that ever changes.
 */
function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flatten(value, fullKey));
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

function loadLang(filename) {
  const raw = fs.readFileSync(path.join(langDir, filename), 'utf8');
  return flatten(JSON.parse(raw));
}

/**
 * Guards against exactly the regression this module shipped with once
 * already: pt-BR.json fell 73 keys behind en.json (the entire custom-playback
 * editor's strings), with no test catching it. Every locale file other than
 * en.json (the reference) must carry the exact same key set - never fewer
 * (a missing key renders the raw key to the user) and never more (a stale key
 * left behind after an en.json rename/removal).
 */
describe('locale file parity', () => {
  const en = loadLang('en.json');
  const localeFiles = fs.readdirSync(langDir).filter((f) => f.endsWith('.json') && f !== 'en.json');

  // Sanity check on the harness itself: if this ever comes back empty, every
  // test below passes vacuously without checking anything.
  it('found at least one non-English locale file to check', () => {
    expect(localeFiles.length).toBeGreaterThan(0);
  });

  for (const file of localeFiles) {
    describe(file, () => {
      const locale = loadLang(file);

      it('has no keys missing that en.json defines', () => {
        const missing = Object.keys(en).filter((k) => !(k in locale));
        expect(missing).toEqual([]);
      });

      it('has no orphan keys that en.json does not define', () => {
        const extra = Object.keys(locale).filter((k) => !(k in en));
        expect(extra).toEqual([]);
      });

      it('has no empty translation values', () => {
        const empty = Object.entries(locale)
          .filter(([, v]) => typeof v !== 'string' || v.trim().length === 0)
          .map(([k]) => k);
        expect(empty).toEqual([]);
      });
    });
  }
});

/**
 * Keys the code **derives** rather than writes out, and which the parity test above therefore
 * cannot see.
 *
 * `lang.test.mjs` guarantees en.json and pt-BR.json agree with each other. It says nothing about
 * whether either agrees with the code - so a key written to the wrong path is consistent, passes
 * parity, and renders the raw key string to the user. That shipped: the `script` condition kind's
 * label went to `CustomEditor.ConditionKind.Script` while the inspector reads
 * `CustomEditor.Inspector.ConditionKind.Script`, and the dropdown showed the bare key.
 *
 * Only the derived FAMILIES are checked here, not every literal in the codebase. These are the
 * ones with no lookup table to grep - node-anatomy.md's own "a new condition kind needs a lang
 * entry and no lookup table" is exactly the property that makes them easy to miss.
 */
describe('derived key families', () => {
  const en = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../lang/en.json'), 'utf8'));
  const cap = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

  // Mirrors custom-playlist-inspector.mjs#CONDITION_KIND_LABELS. Listed rather than imported so
  // the test fails when a kind is added there without a label, instead of silently following it.
  const CONDITION_KINDS = ['combatActive', 'combatIdle', 'mood', 'moodChanged', 'phase', 'phaseChanged', 'enemiesDefeated'];

  it.each(CONDITION_KINDS)('has an inspector label for the %s condition kind', (kind) => {
    expect(en[`GameOrchestra.CustomEditor.Inspector.ConditionKind.${cap(kind)}`]).toBeTruthy();
  });

  it.each([...CONDITION_KINDS, 'default'])('has an exit chip label for the %s condition kind', (kind) => {
    expect(en[`GameOrchestra.CustomEditor.ExitChip.${cap(kind)}`]).toBeTruthy();
  });

  // Every palette entry's label (custom-playlist-editor.mjs#NODE_PALETTE). Track is deliberately
  // absent from the palette - see that file's comment.
  it.each(['start', 'playlist', 'fork', 'delay', 'script', 'random', 'condition', 'end'])(
    'has a palette label for the %s node type',
    (type) => {
      expect(en[`GameOrchestra.CustomEditor.NodeType.${cap(type)}`]).toBeTruthy();
    }
  );
});
