import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, '../templates');

/**
 * Every .hbs file this module ships must actually COMPILE.
 *
 * This guard exists because the whole suite was green while the graph editor could not open at
 * all: a prose note inside an HTML comment in custom-playlist-editor.hbs contained a literal
 * Handlebars opening block. Handlebars parses the entire file and does NOT skip HTML comments, so
 * that read as an unclosed block and every render threw "Expecting 'OPEN_ENDBLOCK', got 'EOF'" -
 * at render time, in Foundry, with nothing failing here.
 *
 * The other template tests (custom-playlist-editor-template.test.mjs, binding-template.test.mjs)
 * assert on the template SOURCE with regexes. That catches a dropped data attribute; it cannot
 * catch a file that will not parse. Compiling is the cheapest possible check and covers every
 * syntax error at once, not just unbalanced blocks.
 *
 * Compile-only: rendering would need the full Foundry helper set (localize, eq, ...) and a real
 * context per template. Registering no-op helpers here would test this file's mocks rather than
 * the templates, and an unknown helper is not a parse error anyway - `{{localize x}}` parses fine
 * whether or not `localize` exists.
 */
describe('template compilation', () => {
  const templates = fs.readdirSync(templateDir).filter((f) => f.endsWith('.hbs'));

  // Sanity check on the harness: an empty list would pass every test below vacuously.
  it('found the shipped templates', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  for (const file of templates) {
    it(`${file} compiles`, () => {
      const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      expect(() => Handlebars.precompile(source)).not.toThrow();
    });
  }

  /**
   * The specific trap that caused the outage, called out separately so a failure names the cause
   * instead of only reporting a parse error at EOF - which points at the end of the file rather
   * than at the comment that broke it.
   */
  it('no template writes a Handlebars block expression inside an HTML comment', () => {
    const offenders = [];
    for (const file of templates) {
      const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      for (const comment of source.match(/<!--[\s\S]*?-->/g) || []) {
        if (/\{\{[#/]/.test(comment)) offenders.push(`${file}: ${comment.slice(0, 80)}...`);
      }
    }
    expect(offenders, 'use a Handlebars comment {{!-- --}} or reword; HTML comments are still parsed').toEqual([]);
  });
});
