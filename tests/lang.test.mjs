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
