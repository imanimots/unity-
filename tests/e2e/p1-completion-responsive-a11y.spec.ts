import { test, expect } from '@playwright/test'

/**
 * Customer-journey P1 completion phase -- regression coverage for the
 * pages most significantly restructured this phase: the browse grid
 * (listing-card.tsx's badge-row restructure to fix the nested-
 * interactive-element constraint, filter-bar.tsx's new contextual-help
 * triggers) and a listing detail page (merchant card + Report Listing
 * entry point). Same pattern as batch4-responsive-a11y.spec.ts.
 */
// 390px: confirmed via git stash that /listings already overflows by
// ~50px on main, before this phase's changes -- a separate, already-
// tracked, pre-existing gap. Included here (not excluded) with a
// baseline-aware assertion: this phase must not make it WORSE, even
// though fixing the pre-existing gap itself is out of scope.
const KNOWN_PRE_EXISTING_OVERFLOW_PX: Record<string, number> = { '390': 50 }
const REGRESSION_MARGIN_PX = 8

const VIEWPORTS = [
  { width: 1440, height: 900, name: '1440' },
  { width: 1024, height: 768, name: '1024' },
  { width: 768, height: 1024, name: '768' },
  { width: 390, height: 844, name: '390' },
]

for (const vp of VIEWPORTS) {
  test(`no horizontal overflow at ${vp.name}px: /listings`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    const response = await page.goto('/listings')
    if (response && response.status() >= 500) throw new Error(`/listings returned ${response.status()}`)
    await page.waitForLoadState('domcontentloaded')
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    const knownOverflow = KNOWN_PRE_EXISTING_OVERFLOW_PX[vp.name] ?? 0
    const allowance = clientWidth + 2 + knownOverflow + REGRESSION_MARGIN_PX
    expect(
      scrollWidth,
      `/listings at ${vp.name}px should not overflow beyond the known pre-existing baseline (${knownOverflow}px) by more than ${REGRESSION_MARGIN_PX}px`
    ).toBeLessThanOrEqual(allowance)
  })
}

for (const vp of [
  { width: 1440, height: 900, name: '1440' },
  { width: 768, height: 1024, name: '768' },
  { width: 390, height: 844, name: '390' },
]) {
  test(`no horizontal overflow at ${vp.name}px: listing detail page`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.goto('/listings')
    await page.waitForLoadState('networkidle')
    const firstCard = page.locator('a[href^="/listings/"]').first()
    if ((await firstCard.count()) === 0) {
      test.skip(true, 'no listing available to test against')
      return
    }
    const href = await firstCard.getAttribute('href')
    const response = await page.goto(href!)
    if (response && response.status() >= 500) throw new Error(`${href} returned ${response.status()}`)
    await page.waitForLoadState('domcontentloaded')
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth, `listing detail at ${vp.name}px should not overflow horizontally`).toBeLessThanOrEqual(clientWidth + 2)
  })
}

test('the restructured listing card still has a working href to its detail page', async ({ page }) => {
  // Deliberately checks the href attribute rather than simulating a
  // literal click-through: confirmed via git stash (reproduces
  // identically against the pre-phase listing-card.tsx) that a
  // synthetic click on a card nested inside CategoryCarousel's
  // snap-scroll row doesn't reliably navigate in this automation
  // environment -- a pre-existing automation quirk, not a regression
  // this phase introduced, and already the reason an earlier phase's
  // contextual-help.spec.ts navigates via extracted href instead of
  // click() for the same kind of card. See the phase report.
  await page.goto('/listings')
  await page.waitForLoadState('networkidle')
  const firstCard = page.locator('a[href^="/listings/"]').first()
  if ((await firstCard.count()) === 0) {
    test.skip(true, 'no listing available to test against')
    return
  }
  const href = await firstCard.getAttribute('href')
  expect(href).toMatch(/^\/listings\/[0-9a-f-]{36}$/)
  const response = await page.goto(href!)
  expect(response?.status()).toBeLessThan(400)
  await expect(page.locator('h1').first()).toBeVisible()
})

test('the grid card badges row sits outside the Link (no nested interactive elements)', async ({ page }) => {
  await page.goto('/listings')
  await page.waitForLoadState('networkidle')
  const nestedButtons = await page.locator('a[href^="/listings/"] button').count()
  expect(nestedButtons, 'no focusable <button> should be nested inside a listing card <a>').toBe(0)
})

test('the direction and kind toggle radiogroups contain exactly their radio options -- no extra nested focusable control (e.g. a contextual-help trigger) snuck in', async ({ page }) => {
  // Scoped to the two radiogroups this phase actually restructured
  // (direction-toggle-container.tsx / kind-toggle-container.tsx) --
  // MarketplaceModeSelector is a pre-existing, untouched component whose
  // own radio buttons legitimately carry their own aria-label and isn't
  // part of this check.
  await page.goto('/listings?mode=barter')
  await page.waitForLoadState('networkidle')

  const directionGroup = page.getByRole('radiogroup', { name: 'Available or Looking For' })
  await expect(directionGroup.getByRole('radio')).toHaveCount(2)
  await expect(directionGroup.locator('button')).toHaveCount(2)

  const kindGroup = page.getByRole('radiogroup', { name: 'Items, Skills, or Tasks' })
  await expect(kindGroup.getByRole('radio')).toHaveCount(3)
  await expect(kindGroup.locator('button')).toHaveCount(3)

  // The marketplaceRequest contextual-help trigger must still be present
  // and reachable, just outside the radiogroup it's adjacent to.
  await expect(page.getByRole('button', { name: 'What is a Marketplace Request?' })).toBeVisible()
})
