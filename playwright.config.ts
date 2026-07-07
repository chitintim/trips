import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright smoke config (WSH QA gate, plan §16 "Playwright smoke" CI
 * step). Deliberately narrow in scope: this suite only exercises
 * UNAUTHENTICATED, public-by-design screens (login, redirects, manifest) --
 * it never signs in and never writes to the live database. See
 * e2e/smoke.spec.ts for the actual assertions.
 *
 * Runs against `npm run dev` (the Vite dev server), started automatically by
 * the `webServer` block below, at the app's real base path (/trips/) so
 * routing/redirect behavior matches production.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Single worker: this is a small, fast smoke suite (plan: "<60s"), and a
  // single shared dev-server instance keeps things simple/deterministic.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173/trips/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
