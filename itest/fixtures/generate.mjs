#!/usr/bin/env node
/**
 * Renders the fixture tone bank as 16-bit PCM WAV files.
 *
 * Run by `npm run fixtures` in `itest/`, and by the integration workflow before the container
 * starts. The output directory is mounted into the Foundry container as a user data folder, so
 * the tracks are addressable by playlists as ordinary audio paths.
 *
 * ## Why generate rather than commit
 *
 * Binary audio in git is the usual objection, but the real reason is that the tone table is the
 * contract: a fixture whose frequency drifts out of sync with `tones.mjs` would be detected by
 * the probe as the wrong track, and every sequencing assertion would then be confidently wrong.
 * Generating from the same module that the detector is configured from makes that class of skew
 * impossible.
 *
 * ## Loop cleanliness
 *
 * Each file is trimmed to a whole number of cycles. A tone cut mid-cycle produces a step
 * discontinuity at the loop point, which is broadband - it lands energy in every Goertzel bin at
 * once and shows up as every other track briefly becoming audible. Rounding the length to the
 * nearest complete cycle keeps a looping fixture spectrally pure indefinitely.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_AMPLITUDE, FIXTURE_SAMPLE_RATE, TONES, toneFilename } from '../harness/tones.mjs';

/** Nominal fixture length. Long enough that a track does not loop mid-assertion, short enough
 * that a full suite of real-time playback stays inside a CI budget. */
const NOMINAL_SECONDS = 30;

/**
 * Render one steady sine tone to a mono WAV buffer.
 * @param {number} freq - Frequency in Hz.
 * @param {number} seconds - Approximate length; rounded down to a whole number of cycles.
 * @param {number} [sampleRate] - Output sample rate.
 * @returns {Buffer} A complete `.wav` file.
 */
export function renderTone(freq, seconds, sampleRate = FIXTURE_SAMPLE_RATE) {
  const cycles = Math.floor((seconds * freq));
  const sampleCount = Math.round((cycles / freq) * sampleRate);

  const data = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const value = Math.sin((2 * Math.PI * freq * i) / sampleRate) * FIXTURE_AMPLITUDE;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), i * 2);
  }
  return wrapWav(data, sampleRate);
}

/**
 * Render silence - used by tests that need a track which is present and playing but inaudible,
 * so "the engine advanced" and "something was audible" can be told apart.
 * @param {number} seconds - Length in seconds.
 * @param {number} [sampleRate] - Output sample rate.
 * @returns {Buffer}
 */
export function renderSilence(seconds, sampleRate = FIXTURE_SAMPLE_RATE) {
  return wrapWav(Buffer.alloc(Math.round(seconds * sampleRate) * 2), sampleRate);
}

/**
 * Wrap raw mono 16-bit PCM in a canonical 44-byte WAV header.
 * @param {Buffer} data - Raw little-endian PCM samples.
 * @param {number} sampleRate - Sample rate in Hz.
 * @returns {Buffer}
 */
function wrapWav(data, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels: mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Write the whole fixture bank to disk.
 * @param {string} outDir - Destination directory; created if missing.
 * @returns {string[]} Written file paths.
 */
export function generateAll(outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const tone of TONES) {
    const path = join(outDir, toneFilename(tone.id));
    writeFileSync(path, renderTone(tone.freq, NOMINAL_SECONDS));
    written.push(path);
  }

  // A short variant of every tone, for graph tests that need tracks to end on their own so the
  // engine follows an `onEnd` exit. Three seconds is above the engine's 300 ms clean-start floor
  // by a wide enough margin that the walk is never rate-limited into looking stuck.
  for (const tone of TONES) {
    const path = join(outDir, `short-${toneFilename(tone.id)}`);
    writeFileSync(path, renderTone(tone.freq, 3));
    written.push(path);
  }

  const silence = join(outDir, 'silence.wav');
  writeFileSync(silence, renderSilence(30));
  written.push(silence);

  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), 'out');
  const written = generateAll(outDir);
  console.log(`Wrote ${written.length} fixtures to ${outDir}`);
}
