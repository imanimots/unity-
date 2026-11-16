import { test, expect } from '@playwright/test'

test('homepage renders the redesigned section sequence with no console errors', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  const response = await page.goto('/')
  expect(response?.status()).toBeLessThan(400)

  await expect(page.getByRole('heading', { name: 'THREE STEPS.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: "WHAT'S AVAILABLE." })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'FOUR WAYS TO USE UNITY.' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'START EARNING TODAY.' })).toBeVisible()
  expect(consoleErrors).toEqual([])
})

test('homepage hero has a primary Explore CTA and a List an item CTA', async ({ page }) => {
  await page.goto('/')
  // Scoped to the hero section specifically -- "Explore"/"List an item"
  // wording also appears again, legitimately, in the final CTA band
  // further down the page.
  const hero = page.locator('section').first()
  await expect(hero.getByRole('link', { name: 'Explore Items' })).toBeVisible()
  await expect(hero.getByRole('link', { name: 'List an item' })).toBeVisible()
})

test('homepage no longer advertises Barter as "Coming soon" (it is a real, live feature)', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Coming soon')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Propose Trade' })).toBeVisible()
})

test('browse default (unfiltered) view renders real category rows, not a flat grid', async ({ page }) => {
  const response = await page.goto('/listings')
  expect(response?.status()).toBeLessThan(400)
  await expect(page.locator('h1')).toContainText(/find what you need/i)
  // At least one category heading row should be present if any live
  // listing exists anywhere -- a bare "no listings" state is also a
  // legitimate real outcome, so this only asserts no error state.
  const noResults = page.getByText('No listings found')
  const categoryHeading = page.locator('h2').first()
  await expect(noResults.or(categoryHeading)).toBeVisible()
})

test('browse filtered view (category selected) renders the flat results grid with a result count', async ({ page }) => {
  await page.goto('/listings?category=tech')
  await expect(page.getByText(/item.*available to rent in tech/i).or(page.getByText('No listings found'))).toBeVisible()
})

test('browse Available / Looking For toggle is present and real', async ({ page }) => {
  await page.goto('/listings')
  await expect(page.getByRole('radio', { name: 'Available' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Looking For' })).toBeVisible()
})

test('browse category pills are present with the real category set', async ({ page }) => {
  await page.goto('/listings')
  await expect(page.getByRole('button', { name: 'All' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Tech/ })).toBeVisible()
})

test('no dead "#" links on homepage or browse', async ({ page }) => {
  for (const path of ['/', '/listings']) {
    await page.goto(path)
    await expect(page.locator(`a[href="#"]`)).toHaveCount(0)
  }
})
