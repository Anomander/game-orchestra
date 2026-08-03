/**
 * Assembles the probe worklet's source from the shared detector maths plus the processor.
 *
 * Split out of `session.mjs` purely so it is importable without `@playwright/test` - which means
 * `tests/itest-goertzel.test.mjs` can compile the result in the ordinary vitest suite and prove
 * the concatenation produces valid JavaScript. The `export`-stripping below is the one piece of
 * textual manipulation in this harness, and an unguarded regex over source is exactly the kind of
 * thing that works until someone writes `export class` and then fails at runtime, inside a
 * worklet, as an unexplained absence of frames.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Build the classic-script source for the probe worklet.
 *
 * An `AudioWorkletGlobalScope` has no module loader, so the worklet cannot import `goertzel.mjs`.
 * Stripping the `export` keywords and concatenating keeps exactly one implementation of the
 * detector - the alternative is a second copy in the worklet that drifts from the tested one
 * without either half looking wrong.
 * @returns {string} Source defining `registerProcessor('go-tone-probe')`.
 * @throws {Error} If the maths file uses an export form the strip does not handle, rather than
 *   emitting source that fails silently in the worklet.
 */
export function buildWorkletSource() {
  const raw = readFileSync(join(here, 'goertzel.mjs'), 'utf8');
  const maths = raw.replace(/^export (?=function |const |let )/gm, '');

  if (/^export /m.test(maths)) {
    throw new Error(
      'goertzel.mjs uses an export form buildWorkletSource() cannot strip (only `export function|const|let` ' +
        'at the start of a line). Rewrite the declaration, or the worklet will fail to parse.'
    );
  }

  return `${maths}\n${readFileSync(join(here, 'probe-worklet.js'), 'utf8')}`;
}
