import { test, expect } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'

// NOTE: as of the downgrade-authority correction (migration 20260904000025),
// a NEW attribution additionally requires the listing's merchant to be
// CURRENTLY Pro/Elite, not merely accepts_affiliates=true on the listing --
// so this suite temporarily elevates merchantA's plan for its duration and
// restores the original value afterward (test.beforeAll/afterAll below),
// matching scripts/verify-affiliate-system.mjs's own save/restore pattern.

/**
 * Permanent proof that the real browser flow actually reaches
 * POST /api/affiliate/attribution end-to-end (the P1 attribution-wiring
 * remediation) -- everything here runs through the real UI: the ?ref=
 * cookie setter, a real sign-in, and the listing page's own attribution
 * runner. src/lib/affiliate/__tests__/cookie.test.ts covers the pure
 * cookie-format logic in isolation; this covers the wiring that
 * connects it to the backend, which no unit test can (browser-only
 * document.cookie + network behavior).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
const MERCHANT_A_ID = 'cc614cd4-5d5a-4b9f-a121-5768ffbfffb0'
const AFFILIATE_A_ID = 'b9a0a9b5-0321-4642-9c2e-f3017139d4b7'
const AFFILIATE_A_CODE = 'AFC-0UIO'

function admin() {
  return createClient(SUPABASE_URL, SERVICE_KEY)
}

async function disposableRenter() {
  const email = `qa-attr-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unitytest.internal`
  const password = 'AttrE2EPass123!'
  const { data } = await admin().auth.admin.createUser({ email, password, email_confirm: true })
  return { email, password, userId: data!.user!.id }
}

async function freshAffiliateEnabledListing() {
  // is_test must be false: the RLS policy "listings: public read active"
  // is `(status='active' AND is_test=false) OR auth.uid()=merchant_id` --
  // an is_test=true listing is only ever visible to its own merchant, not
  // to the anonymous/renter viewer this test needs to actually reach the
  // real listing detail page as. This fixture is disposable and deleted
  // at the end of the test regardless.
  const { data, error } = await admin().from('listings').insert({
    merchant_id: MERCHANT_A_ID, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'sale', sale_price: 500, quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    accepts_affiliates: true, affiliate_commission_rate: 10, is_test: false,
    title: `[QA] Attribution E2E ${Date.now()}`,
    description: 'Fresh disposable fixture for the real-browser affiliate attribution wiring test.',
  }).select('id').single()
  if (error) throw new Error(`fixture listing insert failed: ${error.message}`)
  return data.id as string
}

let originalMerchantAPlanId: string | null = null

test.beforeAll(async () => {
  const { data: sub } = await admin().from('merchant_subscriptions').select('current_plan_id').eq('merchant_id', MERCHANT_A_ID).maybeSingle()
  originalMerchantAPlanId = sub?.current_plan_id ?? 'starter'
  await admin().from('merchant_subscriptions').upsert(
    { merchant_id: MERCHANT_A_ID, current_plan_id: 'pro', current_plan_effective_at: new Date().toISOString(), pending_plan_id: null, pending_plan_effective_at: null },
    { onConflict: 'merchant_id' }
  )
})

test.afterAll(async () => {
  await admin().from('merchant_subscriptions').upsert(
    { merchant_id: MERCHANT_A_ID, current_plan_id: originalMerchantAPlanId, current_plan_effective_at: new Date().toISOString(), pending_plan_id: null, pending_plan_effective_at: null },
    { onConflict: 'merchant_id' }
  )
})

test('a real visitor with a valid referral cookie produces a real attribution once signed in, through the live UI', async ({ page, context }) => {
  const listingId = await freshAffiliateEnabledListing()
  const renter = await disposableRenter()

  // 1. Anonymous visit via the referral link -- the cookie setter must
  // write the canonical JSON format keyed by this listing's id.
  await page.goto(`${APP_URL}/listings/${listingId}?ref=${AFFILIATE_A_CODE}`)
  await page.waitForTimeout(500)

  const cookiesAfterVisit = await context.cookies()
  const affiliateCookie = cookiesAfterVisit.find((c) => c.name === 'unity_affiliate_ref')
  expect(affiliateCookie, 'affiliate cookie should be set after visiting with ?ref=').toBeTruthy()
  const decoded = JSON.parse(decodeURIComponent(affiliateCookie!.value))
  expect(decoded[listingId]?.code).toBe(AFFILIATE_A_CODE)

  // No attribution row yet -- anonymous visits never create one.
  const { count: beforeSignIn } = await admin().from('affiliate_attributions').select('id', { count: 'exact', head: true }).eq('listing_id', listingId)
  expect(beforeSignIn).toBe(0)

  // 2. Sign in as the disposable renter through the real login form.
  await page.goto(`${APP_URL}/login`)
  await page.locator('#login-email').fill(renter.email)
  await page.locator('#login-password').fill(renter.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 })

  // 3. Revisit the listing page -- now authenticated, with the cookie
  // entry still present. The page's own AffiliateAttributionRunner must
  // fire POST /api/affiliate/attribution without any test-side network
  // interception or manual call -- this is the actual wiring under test.
  const attributionResponse = page.waitForResponse((res) => res.url().includes('/api/affiliate/attribution'), { timeout: 10000 })
  await page.goto(`${APP_URL}/listings/${listingId}`)
  const res = await attributionResponse
  expect(res.status()).toBe(200)

  // 4. A real attribution row now exists, crediting the correct affiliate.
  await page.waitForTimeout(500)
  const { data: attributionRow } = await admin()
    .from('affiliate_attributions')
    .select('affiliate_id, referred_user_id, listing_id')
    .eq('listing_id', listingId)
    .maybeSingle()
  expect(attributionRow).toBeTruthy()
  expect(attributionRow!.affiliate_id).toBe(AFFILIATE_A_ID)
  expect(attributionRow!.referred_user_id).toBe(renter.userId)

  // 5. The cookie entry for this listing was consumed after the
  // definitive (200) response -- it should no longer be present.
  const cookiesAfterAttribution = await context.cookies()
  const cookieAfter = cookiesAfterAttribution.find((c) => c.name === 'unity_affiliate_ref')
  const decodedAfter = cookieAfter ? JSON.parse(decodeURIComponent(cookieAfter.value)) : {}
  expect(decodedAfter[listingId]).toBeUndefined()

  await admin().auth.admin.deleteUser(renter.userId)
  await admin().from('listings').delete().eq('id', listingId)
})

test('a visitor with no referral cookie never triggers an attribution call', async ({ page }) => {
  const listingId = await freshAffiliateEnabledListing()
  const renter = await disposableRenter()

  await page.goto(`${APP_URL}/login`)
  await page.locator('#login-email').fill(renter.email)
  await page.locator('#login-password').fill(renter.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 })

  let attributionCalled = false
  page.on('response', (res) => {
    if (res.url().includes('/api/affiliate/attribution')) attributionCalled = true
  })
  await page.goto(`${APP_URL}/listings/${listingId}`)
  await page.waitForTimeout(1500)
  expect(attributionCalled).toBe(false)

  await admin().auth.admin.deleteUser(renter.userId)
  await admin().from('listings').delete().eq('id', listingId)
})
