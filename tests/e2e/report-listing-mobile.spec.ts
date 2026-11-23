import { test, expect } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Dedicated mobile certification for the Report Listing dialog (customer-
 * journey D-certification phase). Covers layout/reachability/focus at a
 * representative narrow viewport (390px) -- independent of whether the
 * submit RPC itself succeeds (that depends on the listing_reports
 * migration being deployed, a separate, already-documented concern) --
 * this spec only certifies the UI surface.
 */
const credentialsPath = join(__dirname, '../../.qa-credentials.local.json')
const hasCredentials = existsSync(credentialsPath)

test.describe('report listing dialog -- mobile (390px)', () => {
  test.skip(!hasCredentials, 'no local QA credentials file — run `npm run qa:seed` first')
  test.use({ viewport: { width: 390, height: 844 } })

  test('the Report control is reachable, the dialog fits the viewport, and every field/control is usable at 390px width', async ({ page }) => {
    test.setTimeout(60000)
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf-8'))
    const renter = creds.accounts.renterA

    await page.goto('/login')
    await page.getByLabel(/email/i).fill(renter.email)
    await page.getByLabel('Password', { exact: true }).fill(renter.password)
    await page.getByRole('button', { name: /log in|sign in/i }).click()
    await expect(page).not.toHaveURL(/\/login/, { timeout: 45000 })
    const essentialOnly = page.getByRole('button', { name: 'Essential only' })
    if ((await essentialOnly.count()) > 0) await essentialOnly.click()

    await page.goto('/listings')
    await page.waitForLoadState('networkidle')
    const firstCard = page.locator('a[href^="/listings/"]').first()
    if ((await firstCard.count()) === 0) {
      test.skip(true, 'no listing available to test against')
      return
    }
    const href = await firstCard.getAttribute('href')
    await page.goto(href!)
    await page.waitForLoadState('networkidle')

    // No new horizontal overflow caused by the Report control itself.
    const beforeOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(beforeOverflow.scrollWidth, 'listing detail page should not overflow at 390px before opening the dialog').toBeLessThanOrEqual(beforeOverflow.clientWidth + 2)

    const trigger = page.getByRole('button', { name: 'Report' }).first()
    await expect(trigger).toBeVisible()
    const triggerBox = await trigger.boundingBox()
    expect(triggerBox, 'Report trigger must have a real, on-screen bounding box').not.toBeNull()
    expect(triggerBox!.x, 'Report trigger must not render off-screen to the left').toBeGreaterThanOrEqual(0)
    expect(triggerBox!.x + triggerBox!.width, 'Report trigger must not render off-screen to the right').toBeLessThanOrEqual(390 + 2)

    await trigger.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByText('Report this listing')).toBeVisible()

    // The dialog's own box must fit within the 390px viewport -- no
    // action button pushed off-screen by a popup wider than the device.
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(dialogBox!.x, 'dialog must not start off-screen to the left').toBeGreaterThanOrEqual(0)
    expect(dialogBox!.x + dialogBox!.width, 'dialog must not extend past the 390px viewport').toBeLessThanOrEqual(390 + 2)

    // Reason select is usable.
    const reasonSelect = page.getByLabel('Reason')
    await expect(reasonSelect).toBeVisible()
    await reasonSelect.selectOption('other')
    await expect(reasonSelect).toHaveValue('other')

    // Description textarea is usable.
    const description = page.getByLabel(/additional details/i)
    await expect(description).toBeVisible()
    await description.fill('Mobile certification check.')
    await expect(description).toHaveValue('Mobile certification check.')

    // Submit button is on-screen and reachable (not clipped below the fold
    // in a way that makes it unreachable -- scrollIntoViewIfNeeded proves
    // it's reachable by scroll, matching how a real touch user would).
    const submitButton = page.getByRole('button', { name: 'Submit report' })
    await submitButton.scrollIntoViewIfNeeded()
    await expect(submitButton).toBeVisible()
    const submitBox = await submitButton.boundingBox()
    expect(submitBox!.x + submitBox!.width, 'submit button must not extend past the viewport').toBeLessThanOrEqual(390 + 2)
    // Practical touch target size (WCAG 2.5.5 / common mobile guidance: ~24px minimum, 44px recommended).
    expect(submitBox!.height, 'submit button should have a practical touch-target height').toBeGreaterThanOrEqual(24)

    // The close control is reachable too (cancel path).
    const closeButton = page.getByRole('button', { name: 'Close' })
    await expect(closeButton).toBeVisible()

    // Keyboard: Escape dismisses the dialog and returns focus to the trigger.
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(trigger).toBeFocused()

    // No new horizontal overflow after the whole interaction.
    const afterOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(afterOverflow.scrollWidth, 'no new overflow should remain after closing the dialog').toBeLessThanOrEqual(afterOverflow.clientWidth + 2)
  })
})
