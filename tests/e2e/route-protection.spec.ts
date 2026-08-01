import { test, expect } from '@playwright/test'

const PROTECTED_PAGES = ['/dashboard/renter', '/dashboard/merchant', '/admin']

for (const path of PROTECTED_PAGES) {
  test(`unauthenticated visitor is redirected away from ${path}`, async ({ page }) => {
    await page.goto(path)
    await expect(page).not.toHaveURL(new RegExp(`${path}$`))
    await expect(page).toHaveURL(/\/login/)
  })
}

test('admin API routes reject an unauthenticated request', async ({ request }) => {
  const res = await request.get('/api/admin/overview')
  expect(res.status()).toBe(401)
})

test('admin API routes never leak data in the response body on a denied request', async ({ request }) => {
  const res = await request.get('/api/admin/users')
  expect(res.status()).toBe(401)
  const body = await res.json()
  expect(body).not.toHaveProperty('users')
})

test('internal cron route rejects a request with no secret', async ({ request }) => {
  const res = await request.post('/api/internal/expire-unpaid-bookings')
  expect(res.status()).toBe(401)
})

test('internal cron route rejects a request with the wrong secret', async ({ request }) => {
  const res = await request.post('/api/internal/expire-unpaid-bookings', {
    headers: { Authorization: 'Bearer wrong-secret' },
  })
  expect(res.status()).toBe(401)
})
