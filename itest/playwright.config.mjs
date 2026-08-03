/**
 * Playwright configuration for the audio integration tier.
 *
 * ## Why the constraints here are unusually tight
 *
 * These specs measure real audio in real time, which makes them structurally different from a
 * normal browser suite:
 *
 * - **`workers: 1`.** Specs share one Foundry world and one audio device. Two workers would
 *   interleave playlist creation and each other's playback, and every "exactly this was audible"
 *   assertion would fail nondeterministically.
 * - **`retries: 0` locally, 1 in CI.** A retried audio test hides exactly the flakiness worth
 *   knowing about. The single CI retry buys tolerance for container startup races only; if a
 *   spec needs a second retry, the fix is a longer settle window, not a bigger retry budget.
 * - **No `--mute-audio`.** Muting is implemented by Chromium as a null output *device*, and on
 *   some platforms that stops the `AudioContext` clock from advancing - the probe then captures
 *   nothing and every silence assertion passes vacuously. The container provides a PulseAudio
 *   null sink instead, which keeps rendering real.
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.FOUNDRY_URL ?? 'http://localhost:30000';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.mjs',
  globalSetup: './harness/global-setup.mjs',

  // Real-time playback: a three-transition spec genuinely needs ~30 s.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'report', open: 'never' }], ['json', { outputFile: 'report/results.json' }]]
    : [['list']],

  use: {
    baseURL: BASE_URL,
    // Traces and video are the only forensics available for a failed audio assertion beyond the
    // ASCII timeline, and an audio suite failing in CI is hard to reproduce locally.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Foundry's audio unlock still needs a gesture, which Playwright supplies; this only
            // removes the second, stricter gate some builds apply to media elements.
            '--autoplay-policy=no-user-gesture-required',
            // A synthetic capture device, so getUserMedia-adjacent code paths do not prompt.
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            // Chromium's audio service is sandboxed separately and is the usual cause of a
            // silently dead AudioContext inside a container.
            '--disable-features=AudioServiceSandbox'
          ]
        }
      }
    }
  ]
});
