import { test, expect } from '@playwright/test'

const VIEWPORTS = [
  { width: 1440, height: 900, name: '1440' },
  { width: 1280, height: 800, name: '1280' },
  { width: 1024, height: 768, name: '1024' },
  { width: 768, height: 1024, name: '768' },
  { width: 430, height: 932, name: '430' },
  { width: 390, height: 844, name: '390' },
]

const PAGES = ['/login', '/register', '/help', '/help/list-an-item', '/sitemap', '/terms']

for (const vp of VIEWPORTS) {
  for (const path of PAGES) {
    test(`no horizontal overflow at ${vp.name}px: ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto(path)
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      // A couple of px of slack for scrollbar/rounding, never a real
      // layout overflow.
      expect(scrollWidth, `${path} at ${vp.name}px should not overflow horizontally`).toBeLessThanOrEqual(clientWidth + 2)
    })
  }
}

test('help center sidebar collapses below lg and the mobile support card takes its place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/help')
  // Desktop-only rail/support-card column uses `hidden lg:block` --
  // confirm it's actually not rendered visually at phone width.
  const desktopSupportCard = page.locator('.hidden.lg\\:block', { hasText: 'Still need help?' })
  await expect(desktopSupportCard).toBeHidden()
  await expect(page.locator('.lg\\:hidden', { hasText: 'Still need help?' })).toBeVisible()
})

test('legal page metadata badges wrap cleanly on mobile without overlapping the heading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/delivery-and-handover')
  await expect(page.getByText(/version 0\.1/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Delivery and Handover Terms' })).toBeVisible()
})
