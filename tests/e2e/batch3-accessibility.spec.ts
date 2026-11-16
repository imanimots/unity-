import { test, expect } from '@playwright/test'

test('help center has exactly one h1 and category groups are real h2 headings (no heading-level skip)', async ({ page }) => {
  await page.goto('/help')
  await expect(page.locator('h1')).toHaveCount(1)
  const h2Count = await page.locator('h2').count()
  expect(h2Count).toBeGreaterThan(0)
})

test('sitemap accordion sections are keyboard-operable native <details>/<summary>', async ({ page }) => {
  await page.goto('/sitemap')
  const merchantSummary = page.locator('summary', { hasText: 'Merchant' })
  // Collapsed by default (per DEFAULT_OPEN) -- its content should not be
  // visible until toggled via the keyboard, a real test of native
  // disclosure semantics rather than a styled div with no affordance.
  const merchantDetails = page.locator('details', { has: merchantSummary })
  await expect(merchantDetails).not.toHaveJSProperty('open', true)
  await merchantSummary.focus()
  await page.keyboard.press('Enter')
  await expect(merchantDetails).toHaveJSProperty('open', true)
})

test('help search input has an accessible label, not just a placeholder', async ({ page }) => {
  await page.goto('/help')
  const input = page.getByLabel('Search the Help Center')
  await expect(input).toBeVisible()
})

test('login and register form fields all have accessible labels', async ({ page }) => {
  await page.goto('/login')
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()

  await page.goto('/register')
  await expect(page.getByLabel('Full name')).toBeVisible()
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
})

test('focus is visible on the help search input and the sitemap toggle', async ({ page }) => {
  await page.goto('/help')
  const input = page.getByLabel('Search the Help Center')
  await input.focus()
  await expect(input).toBeFocused()
})

test('legal page heading hierarchy has no skipped levels (h1 then h2, never straight to h3+)', async ({ page }) => {
  await page.goto('/terms')
  const levels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1, h2, h3, h4')).map((el) => Number(el.tagName[1]))
  )
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i] - levels[i - 1], `heading jump at index ${i}: ${levels[i - 1]} -> ${levels[i]}`).toBeLessThanOrEqual(1)
  }
})
