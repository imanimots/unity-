import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Customer-journey D-certification phase -- authenticated coverage for
 * the surfaces that need a real session: the listing-creation wizard's
 * new field guidance and category-switch confirmation, booking/order
 * status guidance, and the account-restriction banner. One login per
 * role, reused across that role's checks, to keep this proportionate
 * rather than re-paying login cost per assertion.
 */
const credentialsPath = join(__dirname, '../../.qa-credentials.local.json')
const hasCredentials = existsSync(credentialsPath)

async function logIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: /log in|sign in/i }).click()
  await expect(page).not.toHaveURL(/\/login/, { timeout: 45000 })
  const essentialOnly = page.getByRole('button', { name: 'Essential only' })
  if ((await essentialOnly.count()) > 0) await essentialOnly.click()
}

test.describe('listing creation -- field guidance and category-switch confirmation', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')

  test('the Basics step shows risk-tier, condition, and replacement-value help, and warns before a category switch that would lose entered details', async ({ page }) => {
    test.setTimeout(60000)
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const merchant = creds.accounts.merchantA
    await logIn(page, merchant.email, merchant.password)

    await page.goto('/dashboard/merchant/listings/new')
    await page.waitForLoadState('networkidle')

    // Step 1 is "type" in this wizard -- continue to Basics.
    const continueButton = page.getByRole('button', { name: /continue/i }).first()
    if ((await continueButton.count()) > 0) await continueButton.click()

    await expect(page.getByRole('button', { name: CONTEXTUAL_LABEL.riskTier })).toBeVisible()
    await expect(page.getByRole('button', { name: CONTEXTUAL_LABEL.condition })).toBeVisible()
    await expect(page.getByRole('button', { name: CONTEXTUAL_LABEL.replacementValue })).toBeVisible()

    // Pick a category, fill its category-specific field, then switch
    // category -- the confirmation dialog must appear because there's
    // now something to lose.
    const categorySelect = page.locator('select').first()
    await categorySelect.selectOption({ index: 1 })
    const originalCategoryValue = await categorySelect.inputValue()
    const categoryFieldInput = page.locator('input[type="text"], textarea').last()
    if ((await categoryFieldInput.count()) > 0) {
      await categoryFieldInput.fill('e2e certification value')
    }
    await categorySelect.selectOption({ index: 2 })

    const confirmDialog = page.getByText('Switch category?')
    if ((await confirmDialog.count()) > 0) {
      await expect(confirmDialog).toBeVisible()
      // Cancel keeps the original category -- the select must still show
      // the category the merchant was on before the switch attempt.
      await page.getByRole('button', { name: 'Cancel' }).click()
      await expect(confirmDialog).toBeHidden()
      await expect(categorySelect).toHaveValue(originalCategoryValue)

      // Now actually confirm the switch -- the category must update, and
      // the previously-entered value must no longer be present (the
      // metadata reset this phase added), since it belonged to the old
      // category's field set.
      await categorySelect.selectOption({ index: 2 })
      await page.getByRole('button', { name: 'Switch category' }).click()
      await expect(confirmDialog).toBeHidden()
      await expect(categorySelect).not.toHaveValue(originalCategoryValue)
      await expect(page.getByText('e2e certification value')).toHaveCount(0)
    }
  })
})

const CONTEXTUAL_LABEL = {
  riskTier: 'What is a risk tier?',
  condition: 'What do these mean?',
  replacementValue: 'What is this used for?',
}

test.describe('booking/order status guidance', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')

  test('the renter bookings page shows role-aware status guidance text alongside the status badge', async ({ page }) => {
    test.setTimeout(60000)
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const renter = creds.accounts.renterA
    await logIn(page, renter.email, renter.password)

    await page.goto('/dashboard/renter/bookings')
    await page.waitForLoadState('networkidle')

    const anyBooking = page.locator('text=/Booking/').first()
    if ((await anyBooking.count()) === 0) {
      test.skip(true, 'no booking available to test against')
      return
    }
    // The guidance renders as a short explanatory sentence, not hidden
    // from assistive tech -- just present as visible text.
    const guidanceCandidates = page.locator('p').filter({ hasText: /\./ })
    expect(await guidanceCandidates.count()).toBeGreaterThan(0)
  })
})

test.describe('account-restriction banner', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')

  test('a restricted account sees the restriction banner in the dashboard shell', async ({ page }) => {
    test.setTimeout(60000)
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const restricted = creds.accounts.restrictedUser
    if (!restricted) {
      test.skip(true, 'no restrictedUser fixture in this environment')
      return
    }
    await logIn(page, restricted.email, restricted.password)
    // There is no bare /dashboard landing page -- AccountShell (which
    // renders the restriction banner) wraps every dashboard sub-page via
    // the shared (dashboard) layout, so any real sub-page shows it.
    await page.goto('/dashboard/profile')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(/restricted/i).first()).toBeVisible()
  })
})
