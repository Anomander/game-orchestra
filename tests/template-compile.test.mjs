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
  // Recursive: the shared partials live in templates/parts/, and a readdir of the top level alone
  // would leave exactly the files two windows both depend on unguarded.
  const listTemplates = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory()
      ? listTemplates(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : (entry.name.endsWith('.hbs') ? [`${prefix}${entry.name}`] : [])));
  const templates = listTemplates(templateDir);

  // Sanity check on the harness: an empty list would pass every test below vacuously.
  it('found the shipped templates', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).toContain('parts/combat-grid.hbs');
  });

  for (const file of templates) {
    it(`${file} compiles`, () => {
      const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      expect(() => Handlebars.precompile(source)).not.toThrow();
    });
  }

  /**
   * A `{{> "modules/game-orchestra/..."}}` include names a partial by the path `loadTemplates`
   * registered it under. Get either half wrong - a typo in the include, or a partial missing from
   * the `loadTemplates` call in game-orchestra.mjs - and Handlebars throws "The partial ... could
   * not be found" at RENDER time, in Foundry, with the whole suite green. Both halves are checked
   * here against the files that actually exist.
   */
  it('every partial include names a shipped file that init registers', () => {
    const entryPoint = fs.readFileSync(path.join(__dirname, '../scripts/game-orchestra.mjs'), 'utf8');
    const registered = new Set(entryPoint.match(/modules\/game-orchestra\/templates\/[\w./-]+\.hbs/g) || []);
    const shipped = new Set(templates.map((f) => `modules/game-orchestra/templates/${f}`));

    const problems = [];
    for (const file of templates) {
      const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      for (const match of source.match(/\{\{>\s*"([^"]+)"/g) || []) {
        const name = match.match(/"([^"]+)"/)[1];
        if (!shipped.has(name)) problems.push(`${file} includes '${name}', which is not a shipped template`);
        else if (!registered.has(name)) problems.push(`${file} includes '${name}', which game-orchestra.mjs never loadTemplates()`);
      }
    }
    expect(problems).toEqual([]);
  });

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
    expect(offenders, 'use a Handlebars comment or reword; HTML comments are still parsed').toEqual([]);
  });

  /**
   * The same trap one level in, and the one that actually shipped.
   *
   * A Handlebars COMMENT ends at its own first closing delimiter. Writing any Handlebars syntax
   * inside one therefore terminates it early and the rest of the prose renders **as literal text
   * to the user** — no parse error, nothing for the compile check above to catch, and it looked
   * exactly like `. }}` sitting in the middle of the hub. It then shipped a *second* time in the
   * comment written to explain the first, because that one quoted the long-form delimiters.
   *
   * So the rule is flat: no Handlebars delimiter of any kind inside a comment, in either comment
   * form. Describe the syntax in words.
   */
  it('no template writes Handlebars syntax inside a Handlebars comment', () => {
    const offenders = [];
    for (const file of templates) {
      const source = fs.readFileSync(path.join(templateDir, file), 'utf8');
      // Long form first, so its body is not re-scanned as a short comment.
      const comments = [
        ...(source.match(/\{\{!--[\s\S]*?--\}\}/g) || []),
        ...(source.replace(/\{\{!--[\s\S]*?--\}\}/g, '').match(/\{\{![\s\S]*?\}\}/g) || [])
      ];
      for (const comment of comments) {
        const body = comment.replace(/^\{\{!(--)?/, '').replace(/(--)?\}\}$/, '');
        if (/\{\{|\}\}/.test(body)) offenders.push(`${file}: ...${body.slice(Math.max(0, body.search(/\{\{|\}\}/) - 40), 120)}...`);
      }
    }
    expect(offenders, 'a comment ends at its first closing delimiter; describe the syntax in words instead').toEqual([]);
  });
});
