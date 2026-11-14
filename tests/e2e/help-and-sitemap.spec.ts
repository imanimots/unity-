import { test, expect } from '@playwright/test'

test('sitemap page loads and lists all four sections with no dead "#" links', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const response = await page.goto('/sitemap')
  expect(response?.status()).toBeLessThan(400)
  await expect(page.locator('h1').first()).toBeVisible()
  for (const heading of ['Public', 'User / Member', 'Merchant', 'Admin']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await expect(page.locator('a[href="#"]')).toHaveCount(0)
  expect(consoleErrors).toEqual([])
})

test('sitemap links to the Help Center', async ({ page }) => {
  await page.goto('/sitemap')
  await expect(page.locator('a[href="/help"]').first()).toBeVisible()
})

test('help center page loads with search and filters', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const response = await page.goto('/help')
  expect(response?.status()).toBeLessThan(400)
  await expect(page.locator('h1').first()).toBeVisible()
  await expect(page.getByPlaceholder(/what do you want to do/i)).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('help center links to the sitemap', async ({ page }) => {
  await page.goto('/help')
  await expect(page.locator('a[href="/sitemap"]').first()).toBeVisible()
})

test('help center search narrows results', async ({ page }) => {
  await page.goto('/help')
  const cardLinks = page.locator('a[href^="/help/"]')
  const initialCount = await cardLinks.count()
  expect(initialCount).toBeGreaterThan(1)

  await page.getByPlaceholder(/what do you want to do/i).fill('list an item')
  await expect(page.getByRole('link', { name: /I want to list an item/i })).toBeVisible()
  const filteredCount = await cardLinks.count()
  expect(filteredCount).toBeLessThan(initialCount)
})

test('help center role filter narrows results to Admin-only tasks', async ({ page }) => {
  await page.goto('/help')
  const cardLinks = page.locator('a[href^="/help/"]')
  const allCount = await cardLinks.count()

  await page.getByRole('button', { name: 'Admin', exact: true }).click()
  const adminCount = await cardLinks.count()
  expect(adminCount).toBeGreaterThan(0)
  expect(adminCount).toBeLessThan(allCount)
})

test('help center shows a "no results" state for a nonsense query', async ({ page }) => {
  await page.goto('/help')
  await page.getByPlaceholder(/what do you want to do/i).fill('zzzznonexistenttaskzzzz')
  await expect(page.getByText(/no tasks match your search/i)).toBeVisible()
})

test('a real help article renders the full structure and its related tasks link correctly', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const response = await page.goto('/help/list-an-item')
  expect(response?.status()).toBeLessThan(400)
  await expect(page.getByRole('heading', { name: 'I want to list an item' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Steps' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Where to go' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What happens next' })).toBeVisible()

  const relatedSection = page.locator('section', { has: page.getByRole('heading', { name: 'Related tasks' }) })
  const relatedLinks = relatedSection.locator('a[href^="/help/"]')
  const relatedCount = await relatedLinks.count()
  expect(relatedCount).toBeGreaterThan(0)

  const firstRelatedHref = await relatedLinks.first().getAttribute('href')
  expect(firstRelatedHref).toBeTruthy()
  const relatedResponse = await page.goto(firstRelatedHref!)
  expect(relatedResponse?.status()).toBeLessThan(400)
  expect(consoleErrors).toEqual([])
})

test('an unknown help task slug 404s instead of rendering a blank/fake page', async ({ page }) => {
  const response = await page.goto('/help/this-task-does-not-exist')
  expect(response?.status()).toBe(404)
})

test('footer links to both the Help Center and the Sitemap', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('footer a[href="/help"]')).toHaveCount(1)
  await expect(page.locator('footer a[href="/sitemap"]')).toHaveCount(1)
})
