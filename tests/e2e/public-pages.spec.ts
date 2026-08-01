import { test, expect } from '@playwright/test'

const PUBLIC_PAGES = ['/', '/listings', '/login', '/register']

const LEGAL_PAGES = [
  '/terms',
  '/privacy',
  '/popia',
  '/rental-terms',
  '/payments-and-deposits',
  '/cancellations',
  '/refunds',
  '/delivery-and-handover',
  '/prohibited-items',
  '/verification-and-trust',
  '/disputes',
  '/contact',
]

for (const path of PUBLIC_PAGES) {
  test(`public page loads: ${path}`, async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    const response = await page.goto(path)
    expect(response?.status(), `${path} should return a successful status`).toBeLessThan(400)
    await expect(page.locator('h1').first()).toBeVisible()
    expect(consoleErrors, `no console errors on ${path}`).toEqual([])
  })
}

for (const path of LEGAL_PAGES) {
  test(`legal page loads: ${path}`, async ({ page }) => {
    const response = await page.goto(path)
    expect(response?.status(), `${path} should return a successful status`).toBeLessThan(400)
    await expect(page.locator('h1').first()).toBeVisible()
  })
}

test('footer legal links are all present and reachable from the homepage', async ({ page }) => {
  await page.goto('/')
  for (const path of ['/terms', '/privacy', '/popia']) {
    const link = page.locator(`footer a[href="${path}"]`)
    await expect(link).toHaveCount(1)
  }
})

test('no dead "#" links remain in the footer', async ({ page }) => {
  await page.goto('/')
  const deadLinks = page.locator('footer a[href="#"]')
  await expect(deadLinks).toHaveCount(0)
})
