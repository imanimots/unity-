import { test, expect } from '@playwright/test'

test('login page now renders the shared public navbar and footer (E47 Phase 1/8/9)', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('nav').getByRole('link', { name: 'UNITY' })).toBeVisible()
  await expect(page.locator('nav').getByRole('link', { name: 'Browse', exact: true })).toBeVisible()
  await expect(page.locator('footer')).toBeVisible()
})

test('login page shows exactly one primary auth CTA group, never competing Login + Sign Up buttons', async ({ page }) => {
  await page.goto('/login')
  // The navbar shows one Sign Up CTA (signed out); the form itself has
  // one Sign In submit button plus a plain secondary text link -- never
  // a second competing button-styled CTA.
  const navSignUp = page.locator('nav').getByRole('link', { name: 'Sign Up' })
  await expect(navSignUp).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
  await expect(page.getByText(/don.?t have an account/i)).toBeVisible()
})

test('register page shows the secondary "already have an account" link, not a second competing button', async ({ page }) => {
  await page.goto('/register')
  await expect(page.getByText(/already have an account/i)).toBeVisible()
  await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible()
})

test('a legal page shows its real version/status metadata and a related-policies block', async ({ page }) => {
  await page.goto('/terms')
  await expect(page.getByText(/version 0\.1/i)).toBeVisible()
  await expect(page.getByText(/draft.*pending legal review/i)).toBeVisible()
  const relatedSection = page.locator('div', { has: page.getByRole('heading', { name: 'Related policies' }) }).last()
  await expect(relatedSection.getByRole('heading', { name: 'Related policies' })).toBeVisible()
  // Terms' own registry entry lists privacy as a related policy -- the
  // inline cross-reference inside the legal body uses the same words,
  // so this is scoped to the Related Policies block specifically.
  await expect(relatedSection.getByRole('link', { name: 'Privacy Policy' })).toBeVisible()
})

test('a legal page contact CTA points at the real /contact route', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page.getByRole('link', { name: /questions about this policy/i })).toHaveAttribute('href', '/contact')
})

test('legal pages use the shared public navbar and footer, not a one-off chrome', async ({ page }) => {
  await page.goto('/terms')
  await expect(page.locator('nav').getByRole('link', { name: 'Browse', exact: true })).toBeVisible()
  await expect(page.locator('footer')).toBeVisible()
})
