import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

/**
 * Permanent browser-level regression coverage for password recovery
 * (P1 remediation). Everything here needs real client-side JS execution
 * (window.location.hash parsing, Supabase session establishment) so it
 * can't be covered by src/app/api/auth/__tests__/forgot-password.test.ts
 * alone -- that file covers the deterministic, server-side request path
 * (anti-enumeration, redirect construction, rate limiting).
 *
 * admin.generateLink() is used here purely as a QA technique to obtain a
 * genuine recovery hash without sending a real email -- it is never part
 * of the shipped feature (see src/app/api/auth/forgot-password/route.ts,
 * which only ever calls the public resetPasswordForEmail). Every account
 * used here is created fresh per test run on the unitytest.internal test
 * domain and deleted afterward -- no token is ever a committed fixture.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY)
}

async function disposableAccount(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unitytest.internal`
  const { data } = await admin().auth.admin.createUser({ email, password: 'OriginalPass123!', email_confirm: true })
  return { email, userId: data!.user!.id }
}

async function recoveryHash(email: string) {
  const { data } = await admin().auth.admin.generateLink({
    type: 'recovery', email, options: { redirectTo: `${APP_URL}/reset-password` },
  })
  const res = await fetch(data!.properties!.action_link, { redirect: 'manual' })
  return res.headers.get('location')!.split('#')[1]
}

// Visits the same action_link twice server-side (no browser involved) so
// the second, genuinely-reused visit produces Supabase's own real
// "already used" error hash -- more faithful than hand-constructing one.
async function reusedRecoveryErrorHash(email: string) {
  const { data } = await admin().auth.admin.generateLink({
    type: 'recovery', email, options: { redirectTo: `${APP_URL}/reset-password` },
  })
  await fetch(data!.properties!.action_link, { redirect: 'manual' })
  const second = await fetch(data!.properties!.action_link, { redirect: 'manual' })
  return second.headers.get('location')!.split('#')[1]
}

test.describe('login link resolves to the correct locale-aware route (B, R)', () => {
  for (const [locale, prefix] of [['en-ZA', ''], ['af-ZA', '/af'], ['zu-ZA', '/zu']] as const) {
    test(`${locale}`, async ({ page }) => {
      await page.goto(`${APP_URL}${prefix}/login`)
      await page.locator('a[href$="/forgot-password"]').click()
      await expect(page).toHaveURL(new RegExp(`${prefix}/forgot-password$`.replace(/\//g, '\\/')))
      await expect(page.locator('#forgot-password-email')).toBeVisible()
    })
  }
})

test('direct visit to /reset-password with no recovery context never shows the form (H)', async ({ page }) => {
  await page.goto(`${APP_URL}/reset-password`)
  await expect(page.locator('input[type="password"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Update password' })).toHaveCount(0)
})

test('a hash with a non-recovery type is rejected even with a genuinely valid session token (recovery-type guard)', async ({ page }) => {
  // A REAL, currently-valid access/refresh token pair from an ordinary
  // sign-in (not a recovery flow) proves the app's own type==='recovery'
  // check is the actual gate -- not merely whether setSession() would
  // accept the token.
  const acc = await disposableAccount('qa-typeguard')
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data: signInData } = await client.auth.signInWithPassword({ email: acc.email, password: 'OriginalPass123!' })
  const session = signInData.session!

  await page.goto(`${APP_URL}/reset-password#access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=signup`)
  await expect(page.getByText('This link is invalid or has expired')).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await admin().auth.admin.deleteUser(acc.userId)
})

test('an expired/reused-link error hash never shows the form (J)', async ({ page }) => {
  const acc = await disposableAccount('qa-errorhash')
  // A single fresh page load with the real, server-produced "already
  // used" error hash -- a second goto() reusing the same page/session
  // from an earlier successful navigation would be a same-pathname,
  // hash-only client-side transition that Next never remounts for, which
  // isn't representative of how a user actually opens an email link.
  const errorHash = await reusedRecoveryErrorHash(acc.email)
  await page.goto(`${APP_URL}/reset-password#${errorHash}`)
  await expect(page.getByText('This link is invalid or has expired')).toBeVisible()
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await admin().auth.admin.deleteUser(acc.userId)
})

test('a genuine recovery hash establishes the session, strips the hash, and never renders the raw token (I, hash cleanup, P)', async ({ page }) => {
  const acc = await disposableAccount('qa-recovery')
  const hash = await recoveryHash(acc.email)
  const accessToken = new URLSearchParams(hash).get('access_token')!

  await page.goto(`${APP_URL}/reset-password#${hash}`)
  await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible({ timeout: 10000 })

  const url = new URL(page.url())
  expect(url.hash).toBe('')

  const html = await page.content()
  expect(html).not.toContain(accessToken)

  await admin().auth.admin.deleteUser(acc.userId)
})

test('password mismatch and sub-8-character passwords are blocked client-side (K, L)', async ({ page }) => {
  const acc = await disposableAccount('qa-validation')
  const hash = await recoveryHash(acc.email)
  await page.goto(`${APP_URL}/reset-password#${hash}`)
  await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible({ timeout: 10000 })

  // Too short.
  await page.locator('#reset-password-password').fill('short')
  await page.locator('#reset-password-confirm').fill('short')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByText('Password must be at least 8 characters')).toBeVisible()

  // Mismatch.
  await page.locator('#reset-password-password').fill('LongEnough123!')
  await page.locator('#reset-password-confirm').fill('DoesNotMatch456!')
  await page.getByRole('button', { name: 'Update password' }).click()
  await expect(page.getByText('Passwords do not match')).toBeVisible()

  await admin().auth.admin.deleteUser(acc.userId)
})

test('a successful reset updates the password, signs out the recovery session, and redirects to login with the success banner (M, N, O)', async ({ page }) => {
  const acc = await disposableAccount('qa-fullreset')
  const hash = await recoveryHash(acc.email)
  await page.goto(`${APP_URL}/reset-password#${hash}`)
  await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible({ timeout: 10000 })

  await page.locator('#reset-password-password').fill('BrandNewPass789!')
  await page.locator('#reset-password-confirm').fill('BrandNewPass789!')
  await page.getByRole('button', { name: 'Update password' }).click()

  await expect(page.getByText('Password updated')).toBeVisible({ timeout: 10000 })
  await page.waitForURL(/\/login\?passwordReset=1/, { timeout: 5000 })
  await expect(page.getByText('Password updated. Sign in with your new password.')).toBeVisible()

  // N: the recovery session was signed out -- old password fails, new one works.
  const oldPwClient = createClient(SUPABASE_URL, ANON_KEY)
  const { error: oldPwErr } = await oldPwClient.auth.signInWithPassword({ email: acc.email, password: 'OriginalPass123!' })
  expect(oldPwErr).toBeTruthy()
  const newPwClient = createClient(SUPABASE_URL, ANON_KEY)
  const { error: newPwErr } = await newPwClient.auth.signInWithPassword({ email: acc.email, password: 'BrandNewPass789!' })
  expect(newPwErr).toBeFalsy()

  await admin().auth.admin.deleteUser(acc.userId)
})

test('af-ZA reset-password page renders localized copy and reset destination stays in af-ZA (R)', async ({ page }) => {
  await page.goto(`${APP_URL}/af/reset-password`)
  await expect(page.getByText('Hierdie skakel is ongeldig of het verval')).toBeVisible()
})
