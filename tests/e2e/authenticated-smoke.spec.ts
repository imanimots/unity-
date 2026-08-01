import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Authenticated smoke coverage — logs in through the real UI form (no
 * API shortcut) using the local QA seed credentials
 * (scripts/qa-seed.mjs). Skips gracefully wherever the credentials file
 * isn't present (CI, a fresh checkout that hasn't run the seed script) —
 * this suite is a smoke check on top of the seed data, not a
 * replacement for it.
 */
const credentialsPath = join(__dirname, '../../.qa-credentials.local.json')
const hasCredentials = existsSync(credentialsPath)

test.describe('authenticated smoke', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')

  test('renter can log in and see their bookings, checkout summary renders for a real booking', async ({ page }) => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const renter = creds.accounts.renterA

    await page.goto('/login')
    await page.getByLabel(/email/i).fill(renter.email)
    await page.getByLabel('Password', { exact: true }).fill(renter.password)
    await page.getByRole('button', { name: /log in|sign in/i }).click()

    // Login with no redirectTo param lands on the homepage by design
    // (renter dashboard is reached via nav, not an automatic redirect) —
    // wait for navigation away from /login, then go to the target page.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 })

    await page.goto('/dashboard/renter/bookings')
    await expect(page.locator('h1').first()).toBeVisible()

    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    await page.waitForLoadState('networkidle')
    expect(consoleErrors).toEqual([])
  })

  test('admin can log in and reach the overview with real data', async ({ page }) => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const admin = creds.accounts.admin

    await page.goto('/login')
    await page.getByLabel(/email/i).fill(admin.email)
    await page.getByLabel('Password', { exact: true }).fill(admin.password)
    await page.getByRole('button', { name: /log in|sign in/i }).click()
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15000 })

    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: /overview/i })).toBeVisible({ timeout: 15000 })
  })
})
