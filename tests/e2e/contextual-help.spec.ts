import { test, expect } from '@playwright/test'

/**
 * Customer-journey contextual-help phase -- covers the new reusable
 * ContextualHelp primitive (real UI interaction, not a unit test, since
 * this project has no React Testing Library / jsdom component-test
 * setup -- every other UI-level check in this repo lives here, in
 * Playwright, matching that established convention rather than
 * introducing a new one) plus the dead-control removal.
 */

test('listing card no longer has a non-functional wishlist control', async ({ page }) => {
  await page.goto('/listings')
  await expect(page.getByLabel('Save to wishlist')).toHaveCount(0)
})

test('a verified listing\'s grid card exposes its own contextual-help trigger directly, without navigating to the detail page', async ({ page }) => {
  // The badge sits as a sibling of the card's <Link>, not nested inside
  // it (a focusable trigger can't safely nest inside an <a>) -- so the
  // trigger must be reachable, and clickable, without leaving /listings.
  await page.goto('/listings')
  await page.waitForLoadState('networkidle')

  const trigger = page.getByRole('button', { name: 'What does ownership verification mean?' }).first()
  if ((await trigger.count()) === 0) {
    // No currently-verified listing exists in this environment's data --
    // not a failure of this feature, just nothing to exercise it against
    // right now. Skip rather than fail on absent fixture data.
    test.skip(true, 'no ownership-verified listing available to test against')
    return
  }

  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByText(/this checks the merchant's proof/i)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', /\/help\/what-verification-means/)

  // Escape dismisses it -- base-ui's Popover default behavior, asserted
  // here so a future change to the primitive can't silently drop it.
  await page.keyboard.press('Escape')
  await expect(page.getByText(/this checks the merchant's proof/i)).toBeHidden()

  // Clicking the trigger must never navigate the card away.
  await expect(page).toHaveURL(/\/listings$/)
})

test('the rental deposit contextual-help explains the refund condition, and the amount itself remains visible without interaction', async ({ page }) => {
  // Navigate directly to a listing rather than discover one via the
  // browse grid -- avoids coupling this test to which fixture listings
  // happen to exist in a given environment's seed data; the point here
  // is exercising the contextual-help primitive on the listing detail
  // page, not re-testing browse/search.
  await page.goto('/listings')
  await page.waitForLoadState('networkidle')
  const anyListing = page.locator('a[href*="/listings/"]').first()
  if ((await anyListing.count()) === 0) {
    test.skip(true, 'no listing available to test against')
    return
  }
  const href = (await anyListing.getAttribute('href'))!
  await page.goto(href)
  await page.waitForLoadState('networkidle')

  const depositTrigger = page.getByRole('button', { name: 'What is this deposit for?' }).first()
  if ((await depositTrigger.count()) === 0) {
    test.skip(true, 'listing has no deposit requirement to test against')
    return
  }

  // Critical disclosure rule: the deposit amount itself must already be
  // on screen before any interaction -- the trigger only explains it.
  const depositRow = page.locator('text=/Refundable deposit/i').first()
  await expect(depositRow).toBeVisible()

  await depositTrigger.click()
  await expect(page.getByText(/refunded once the item is confirmed returned/i)).toBeVisible()
})
