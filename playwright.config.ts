import { defineConfig, devices } from '@playwright/test'

/**
 * Narrow browser acceptance suite (Step 10) — public pages, legal links,
 * protected-route redirects, admin-route denial, and no-console-error
 * smoke checks. Deliberately not a large fragile suite: multi-account
 * workflows (merchant/renter/admin journeys) remain covered by the
 * scripted API-level live validation used throughout this project
 * instead (scripts/qa-seed.mjs and each step's own validation), per the
 * brief's own "manual/scripted testing remains required for multi-account
 * workflows if automation would be disproportionate."
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
})
