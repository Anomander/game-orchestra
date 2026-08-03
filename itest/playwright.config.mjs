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
 * - **`--mute-audio` is Playwright's own default and cannot simply be omitted here** - it is on the
 *   headless-shell command line whatever this file says. It has not been a problem: the probe taps
 *   the graph *before* the destination, and the context keeps rendering with it set (verified by
 *   `status().clockRatio` reading 1.0 both locally and on a runner). What does matter is that the
 *   machine still has a sink the context can pace against, which is why CI installs a PulseAudio
 *   null sink and exports `PULSE_SERVER` - without a reachable server Chrome falls back to a dummy
 *   backend that renders as fast as it can, measured at 2.3x-5.6x realtime.
 */

import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.FOUNDRY_URL ?? 'http://localhost:30000';

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.mjs',
  globalSetup: './harness/global-setup.mjs',

  // Real-time playback: the longest passing spec measured ~45 s. 120 s leaves generous headroom
  // while halving what a *hung* spec costs - and in a 12-spec suite with retries, the cost of a
  // hang is what decides whether the run finishes and reports at all. It did not, once: every spec
  // timed out at the old 180 s, retries doubled it, and the job was killed at 30 minutes before
  // Playwright printed a single reason. The timeout budget is a diagnostics feature.
  // 180 s. Every spec joins its own client, and a world load on a runner is far slower than
  // locally - the longest *passing* run measured 128 s end to end, which the previous 120 s budget
  // failed by eight seconds while the assertions inside it were all green. A timeout that fails
  // work which actually succeeded teaches nothing; `maxFailures` below is what bounds a bad run.
  timeout: 180_000,
  expect: { timeout: 15_000 },

  // Stop after a handful of failures in CI. When something environmental is broken every spec
  // fails the same way, and grinding through all 24 attempts to learn one fact wastes the run and
  // usually exceeds the job timeout - which throws away the report as well as the time.
  maxFailures: process.env.CI ? 3 : 0,

  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  // `github` is the important one in CI: it emits ::error:: annotations *as each spec fails*,
  // rather than only in the end-of-run summary. A run that is killed before it finishes therefore
  // still shows why each spec failed, which is exactly what was missing when this first ran for
  // real.
  reporter: process.env.CI
    ? [
        ['github'],
        ['list'],
        ['html', { outputFolder: 'report', open: 'never' }],
        ['json', { outputFile: 'report/results.json' }]
      ]
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
            '--disable-features=AudioServiceSandbox',
            // /dev/shm is 64 MB in a default container and Chromium will thrash or crash on it.
            '--disable-dev-shm-usage'
          ]
        }
      }
    }
  ]
});
