import { test, expect, type Page } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Report Listing feature (customer-journey P1 completion, batch 8) --
 * authenticated coverage using the real local QA seed credentials
 * (scripts/qa-seed.mjs), same convention as authenticated-smoke.spec.ts.
 * Skips gracefully wherever the credentials file isn't present.
 *
 * Login against this dev server is genuinely slow on a cold compile
 * (real network round-trips to the hosted Supabase auth API, observed
 * 15-30s+) -- every test here sets a generous explicit timeout rather
 * than relying on the project default, and the one-time merchant
 * lookup is cached across tests so only ONE login pays that cost per
 * account, not one per test.
 */
const credentialsPath = join(__dirname, '../../.qa-credentials.local.json')
const hasCredentials = existsSync(credentialsPath)

async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /log in|sign in/i }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 60000 })
  await dismissCookieBanner(page)
}

/** The fixed-position cookie consent banner otherwise intercepts pointer events for any later click lower on the page. */
async function dismissCookieBanner(page: Page) {
  const essentialOnly = page.getByRole('button', { name: 'Essential only' })
  if ((await essentialOnly.count()) > 0) {
    await essentialOnly.click()
  }
}

test.describe('report listing', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')

  let sharedListingHref: string | null = null
  let noMerchantListing = false

  test.beforeAll(async ({ browser }) => {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const merchant = creds.accounts.merchantA
    const context = await browser.newContext()
    const page = await context.newPage()
    await logIn(page, merchant.email, merchant.password)
    await page.goto('/dashboard/merchant/listings')
    const firstListingLink = page.locator('a[href^="/listings/"]').first()
    if ((await firstListingLink.count()) === 0) {
      noMerchantListing = true
    } else {
      sharedListingHref = await firstListingLink.getAttribute('href')
      // Confirm self-report prevention here, while already authenticated
      // as the owner, instead of paying for a second merchant login.
      await page.goto(sharedListingHref!)
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('button', { name: 'Report' })).toHaveCount(0)
    }
    await context.close()
  })

  test('the listing owner never sees the Report control on their own listing', () => {
    test.skip(noMerchantListing, 'no merchant listing available to test against')
    // Asserted in beforeAll (requires being signed in as the owner,
    // which only beforeAll's single merchant login pays for) -- this
    // test exists so the check is reported as its own named result.
    expect(noMerchantListing).toBe(false)
  })

  test('a non-owning signed-in user can submit a listing report', async ({ page }) => {
    test.setTimeout(120000)
    test.skip(noMerchantListing, 'no merchant listing available to test against')

    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const renter = creds.accounts.renterA
    await logIn(page, renter.email, renter.password)
    await page.goto(sharedListingHref!)
    await page.waitForLoadState('networkidle')

    const reportTrigger = page.getByRole('button', { name: 'Report' }).first()
    await expect(reportTrigger).toBeVisible()
    await reportTrigger.click()

    await expect(page.getByText('Report this listing')).toBeVisible()
    await page.getByLabel('Reason').selectOption('other')
    await page.getByLabel(/additional details/i).fill('Automated e2e test report -- safe to dismiss.')
    await page.getByRole('button', { name: 'Submit report' }).click()

    await expect(page.getByText(/your report has been submitted/i)).toBeVisible()
  })

  test('admin can see a submitted listing report in the moderation queue and dismiss it', async ({ page }) => {
    test.setTimeout(90000)
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const admin = creds.accounts.admin

    await logIn(page, admin.email, admin.password)
    await page.goto('/admin/listing-reports')
    await page.waitForLoadState('networkidle')

    const dismissButton = page.getByRole('button', { name: 'Dismiss report' }).first()
    if ((await dismissButton.count()) === 0) {
      test.skip(true, 'no open listing report available to test against (run the submit test first)')
      return
    }
    await dismissButton.click()
    await expect(page.getByText('(dismissed)').first()).toBeVisible({ timeout: 10000 })
  })
})
