#!/usr/bin/env node
/**
 * Permanent regression check for the platform-wide "merchant
 * verification re-check at transaction time" hardening pass. Real
 * script against the live dev database, mirroring
 * scripts/verify-rent-to-buy-phase5.mjs / verify-barter-execution.mjs's
 * exact conventions (safety gate, [QA] fixture markers, check()
 * fail-closed helper).
 *
 * Proves: at the moment a NEW commercial transaction is created or
 * accepted (Buy/Rent/Barter/Rent-to-Buy/Looking For), BOTH the acting
 * user's and the counterparty's CURRENT, LIVE profiles.kyc_status is
 * re-verified -- never inferred from listing-activation history, a
 * cached value, or listing visibility. Existing/historical
 * transactions must remain fully serviceable regardless of a later
 * KYC change (Step L) -- this script also proves that boundary is
 * respected, not just the new blocking behavior.
 *
 * Fails closed: every assertion is an explicit check() call; no
 * skip() of any kind exists in this script.
 *
 * The Rent-to-Buy section requires RENT_TO_BUY_ENABLED=true on the
 * running dev server (same operational precondition as
 * verify-rent-to-buy-phase5.mjs) -- run this script in that
 * configuration, then restore the safe default afterward.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<ref> node scripts/verify-transaction-verification-hardening.mjs
 * Requires the dev server running and scripts/qa-seed.mjs already run once.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

function assertSafeToRun() {
  const problems = []
  if (process.env.NODE_ENV === 'production') problems.push('NODE_ENV must not be "production"')
  if (process.env.QA_SEED_ENABLED !== 'true') problems.push('QA_SEED_ENABLED must be exactly "true"')
  if (process.env.QA_SEED_CONFIRM !== 'UNITY_DEV_ONLY') problems.push('QA_SEED_CONFIRM must be exactly "UNITY_DEV_ONLY"')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const expectedRef = process.env.QA_SEED_PROJECT_REF
  if (!url) problems.push('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!expectedRef) problems.push('QA_SEED_PROJECT_REF is not set')
  if (url && expectedRef) {
    const ref = new URL(url).hostname.split('.')[0]
    if (ref !== expectedRef) problems.push(`Supabase project ref "${ref}" does not match QA_SEED_PROJECT_REF "${expectedRef}"`)
  }
  if (problems.length > 0) {
    console.error('verify-transaction-verification-hardening aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}
assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-transaction-verification-hardening aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] VerifyHardening'
const RUN_ID = Date.now()
const SCRIPT_START_AT = new Date().toISOString()
const qaFixtureAccountIds = new Set()

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-transaction-verification-hardening aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id, client }
}
async function api(cookie, method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}
async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', sale_price: 500, quantity_available: 20, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

/** Runs fn() while userId's kyc_status is temporarily set to `status`, always restoring the original value afterward -- even on throw. */
async function withKycStatus(userId, status, fn) {
  const { data: before } = await admin.from('profiles').select('kyc_status').eq('id', userId).single()
  await admin.from('profiles').update({ kyc_status: status }).eq('id', userId)
  try {
    return await fn()
  } finally {
    await admin.from('profiles').update({ kyc_status: before.kyc_status }).eq('id', userId)
  }
}
async function ensureApproved(userId) {
  await admin.from('profiles').update({ kyc_status: 'approved' }).eq('id', userId)
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)
for (const id of [merchantA.userId, merchantB.userId, renterA.userId, adminAuth.userId]) qaFixtureAccountIds.add(id)

// Every party starts approved -- a clean, known baseline for every section below.
await ensureApproved(merchantA.userId)
await ensureApproved(merchantB.userId)
await ensureApproved(renterA.userId)

console.log('=== BUY ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Buy ${RUN_ID}` })

  const r1 = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1 })
  check('1. verified buyer + verified merchant -> order allowed', r1.status === 201, r1)

  const r2 = await withKycStatus(renterA.userId, 'none', () => api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1 }))
  check('2. unverified buyer -> order blocked', r2.status === 403, r2)

  const r3 = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1 }))
  check('3. verified buyer + merchant KYC revoked after listing activation -> order blocked', r3.status === 403, r3)

  const r4 = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1 })
  check('4. merchant re-approved -> new order allowed', r4.status === 201, r4)

  var buyOrderId = r1.json?.order_id
}

console.log('=== RENT ===')
{
  const listingId = await insertBaseListing(merchantA.userId, {
    title: `${QA_MARKER} Rent ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, min_rental_days: 1,
  })

  const r5 = await api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: listingId, start_at: '2030-06-01T00:00:00.000Z', end_at: '2030-06-04T00:00:00.000Z',
  })
  check('5. verified renter + verified merchant -> booking request allowed', r5.status === 201, r5)

  const r6 = await withKycStatus(renterA.userId, 'none', () => api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: listingId, start_at: '2030-07-01T00:00:00.000Z', end_at: '2030-07-04T00:00:00.000Z',
  }))
  check('6. unverified renter -> blocked', r6.status === 403, r6)

  const r7 = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: listingId, start_at: '2030-08-01T00:00:00.000Z', end_at: '2030-08-04T00:00:00.000Z',
  }))
  check('7. merchant revoked before booking request -> blocked', r7.status === 403, r7)

  const listingId8 = await insertBaseListing(merchantA.userId, {
    title: `${QA_MARKER} Rent Accept ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, min_rental_days: 1,
  })
  const created8 = await api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: listingId8, start_at: '2030-09-01T00:00:00.000Z', end_at: '2030-09-04T00:00:00.000Z',
  })
  const accept8 = created8.status === 201
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(merchantA.cookie, 'POST', `/api/bookings/${created8.json.booking_id}/accept`, {}))
    : { status: 0 }
  check('8. merchant approved at request creation but revoked before acceptance -> acceptance blocked', created8.status === 201 && accept8.status === 403, { created8, accept8 })

  const listingId9 = await insertBaseListing(merchantA.userId, {
    title: `${QA_MARKER} Rent Reapproved ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, min_rental_days: 1,
  })
  const created9 = await api(renterA.cookie, 'POST', '/api/bookings', {
    listing_id: listingId9, start_at: '2030-10-01T00:00:00.000Z', end_at: '2030-10-04T00:00:00.000Z',
  })
  const accept9 = created9.status === 201 ? await api(merchantA.cookie, 'POST', `/api/bookings/${created9.json.booking_id}/accept`, {}) : { status: 0 }
  check('9. merchant re-approved -> new booking flow allowed', created9.status === 201 && accept9.status === 200, { created9, accept9 })

  var accepted8BookingId = created8.json?.booking_id
}

console.log('=== BARTER ===')
{
  async function propose(label, partyAListing, partyBListing) {
    return api(merchantB.cookie, 'POST', '/api/barter', {
      anchor_listing_id: partyAListing, party_a_listing_ids: [partyAListing], party_b_listing_ids: [partyBListing],
      delivery_method: 'meet_in_person', message: `${QA_MARKER} ${label}`, idempotency_key: `hardening-propose-${label}-${RUN_ID}`,
    })
  }

  const listingA10 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Barter A10 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const listingB10 = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Barter B10 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const r10 = await propose('verified', listingA10, listingB10)
  check('10. both verified -> proposal allowed', r10.status === 201, r10)

  const listingA11 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Barter A11 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const listingB11 = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Barter B11 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const r11 = await withKycStatus(merchantB.userId, 'none', () => propose('proposer-unverified', listingA11, listingB11))
  check('11. proposer unverified -> blocked', r11.status === 403, r11)

  const listingA12 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Barter A12 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const listingB12 = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Barter B12 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const r12 = await withKycStatus(merchantA.userId, 'rejected', () => propose('counterparty-unverified', listingA12, listingB12))
  check('12. counterparty unverified -> blocked', r12.status === 403, r12)

  const listingA13 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Barter A13 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const listingB13 = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Barter B13 ${RUN_ID}`, listing_type: 'both', sale_price: 400, daily_rate: 50, min_rental_days: 1 })
  const proposed13 = await propose('pre-accept-revoke', listingA13, listingB13)
  const agreementId13 = proposed13.json?.agreement_id
  const accept13a = agreementId13
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(merchantA.cookie, 'POST', `/api/barter/${agreementId13}/accept`, {}))
    : { status: 0 }
  const accept13b = agreementId13
    ? await withKycStatus(merchantB.userId, 'rejected', () => api(merchantA.cookie, 'POST', `/api/barter/${agreementId13}/accept`, {}))
    : { status: 0 }
  check('13. either party revoked before acceptance -> acceptance blocked', proposed13.status === 201 && accept13a.status === 403 && accept13b.status === 403, { proposed13, accept13a, accept13b })

  const accept14 = agreementId13 ? await api(merchantA.cookie, 'POST', `/api/barter/${agreementId13}/accept`, {}) : { status: 0 }
  check('14. re-approved parties -> new barter acceptance allowed', accept14.status === 200, accept14)

  var barterAgreementId = agreementId13
}

console.log('=== RENT-TO-BUY (requires RENT_TO_BUY_ENABLED=true on the running dev server) ===')
let rtbListingId, rtbAgreementId
{
  async function saveTerms(listingId) {
    return api(merchantA.cookie, 'POST', `/api/listings/${listingId}/rent-to-buy-terms`, {
      enabled: true, total_purchase_price: 1200, installment_amount: 400, installment_count: 3, payment_frequency: 'monthly',
    })
  }

  rtbListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} RTB ${RUN_ID}` })
  await saveTerms(rtbListingId)

  const r15 = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: rtbListingId })
  const accept15 = r15.status === 201 ? await api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${r15.json.agreement_id}/accept`, {}) : { status: 0 }
  check('15. verified parties -> current RTB entry works when feature enabled', r15.status === 201 && accept15.status === 200, { r15, accept15 })
  rtbAgreementId = r15.json?.agreement_id

  const listingId16 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} RTB Unverified Customer ${RUN_ID}` })
  await saveTerms(listingId16)
  const r16 = await withKycStatus(renterA.userId, 'none', () => api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId16 }))
  check('16. unverified customer -> blocked', r16.status === 403, r16)

  const listingId17 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} RTB Unverified Merchant ${RUN_ID}` })
  await saveTerms(listingId17)
  const r17 = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId17 }))
  check('17. unverified merchant -> blocked', r17.status === 403, r17)

  const listingId18 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} RTB Revoked Before Accept ${RUN_ID}` })
  await saveTerms(listingId18)
  const created18 = await api(renterA.cookie, 'POST', '/api/rent-to-buy/agreements', { listing_id: listingId18 })
  const accept18 = created18.status === 201
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(merchantA.cookie, 'POST', `/api/rent-to-buy/agreements/${created18.json.agreement_id}/accept`, {}))
    : { status: 0 }
  check('18. merchant revoked between request and final acceptance -> blocked', created18.status === 201 && accept18.status === 403, { created18, accept18 })
}

console.log('=== LOOKING FOR ===')
{
  async function createAndPublishRequest(cookie, body, idKey) {
    const created = await api(cookie, 'POST', '/api/marketplace/requests', { ...body, idempotency_key: idKey })
    if (created.status !== 201) return { created }
    const requestId = created.json.request_id
    const published = await api(cookie, 'POST', `/api/marketplace/requests/${requestId}/publish`, {})
    return { created, requestId, published }
  }

  // 19. accepted Buy offer cannot bypass merchant verification
  const buyListing19 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} LF Buy ${RUN_ID}` })
  const buyReq19 = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} LF Buy Req ${RUN_ID}` }, `lf-buy-${RUN_ID}`)
  const offer19 = buyReq19.requestId
    ? await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${buyReq19.requestId}/offers`, { offer_type: 'link_listing', linked_listing_id: buyListing19, amount: 300, idempotency_key: `lf-buy-off-${RUN_ID}` })
    : { status: 0 }
  const accept19 = offer19.json?.offer_id
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', `/api/marketplace/offers/${offer19.json.offer_id}/accept`, {}))
    : { status: 0 }
  check('19. accepted Buy offer cannot bypass merchant verification', offer19.status === 201 && accept19.status === 403, { buyReq19, offer19, accept19 })

  // 20. accepted Rent offer cannot bypass merchant verification
  const rentListing20 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} LF Rent ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 90, min_rental_days: 1 })
  const rentReq20 = await createAndPublishRequest(renterA.cookie, { transaction_type: 'rent', title: `${QA_MARKER} LF Rent Req ${RUN_ID}`, start_date: '2030-11-01', end_date: '2030-11-05' }, `lf-rent-${RUN_ID}`)
  const offer20 = rentReq20.requestId
    ? await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${rentReq20.requestId}/offers`, { offer_type: 'link_listing', linked_listing_id: rentListing20, amount: 90, rental_start_date: '2030-11-01', rental_end_date: '2030-11-05', idempotency_key: `lf-rent-off-${RUN_ID}` })
    : { status: 0 }
  const accept20 = offer20.json?.offer_id
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', `/api/marketplace/offers/${offer20.json.offer_id}/accept`, {}))
    : { status: 0 }
  check('20. accepted Rent offer cannot bypass merchant verification', offer20.status === 201 && accept20.status === 403, { rentReq20, offer20, accept20 })

  // 21. accepted Barter offer cannot bypass counterparty verification
  const barterReq21 = await createAndPublishRequest(renterA.cookie, { transaction_type: 'barter', title: `${QA_MARKER} LF Barter Req ${RUN_ID}` }, `lf-barter-${RUN_ID}`)
  const offer21 = barterReq21.requestId
    ? await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${barterReq21.requestId}/offers`, { offer_type: 'private_offer', message: 'trade offer', idempotency_key: `lf-barter-off-${RUN_ID}` })
    : { status: 0 }
  const accept21 = offer21.json?.offer_id
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', `/api/marketplace/offers/${offer21.json.offer_id}/accept`, {}))
    : { status: 0 }
  check('21. accepted Barter offer cannot bypass counterparty verification', offer21.status === 201 && accept21.status === 403, { barterReq21, offer21, accept21 })

  // 22. accepted RTB offer cannot bypass merchant verification
  const rtbListing22 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} LF RTB ${RUN_ID}` })
  await api(merchantA.cookie, 'POST', `/api/listings/${rtbListing22}/rent-to-buy-terms`, { enabled: true, total_purchase_price: 900, installment_amount: 300, installment_count: 3, payment_frequency: 'monthly' })
  const rtbReq22 = await createAndPublishRequest(renterA.cookie, { transaction_type: 'rent_to_buy', title: `${QA_MARKER} LF RTB Req ${RUN_ID}` }, `lf-rtb-${RUN_ID}`)
  const offer22 = rtbReq22.requestId
    ? await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${rtbReq22.requestId}/offers`, { offer_type: 'link_listing', linked_listing_id: rtbListing22, idempotency_key: `lf-rtb-off-${RUN_ID}` })
    : { status: 0 }
  const accept22 = offer22.json?.offer_id
    ? await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', `/api/marketplace/offers/${offer22.json.offer_id}/accept`, {}))
    : { status: 0 }
  check('22. accepted RTB offer cannot bypass merchant verification', offer22.status === 201 && accept22.status === 403, { rtbReq22, offer22, accept22 })
}

console.log('=== HISTORICAL / SERVICING (existing transactions must remain unaffected by a later KYC change) ===')
{
  const check23 = await withKycStatus(merchantA.userId, 'rejected', async () => {
    const { data } = await admin.from('orders').select('id').eq('id', buyOrderId).maybeSingle()
    return !!data
  })
  check('23. revoking merchant does not delete existing order', check23 === true, { buyOrderId })

  const check24 = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'GET', '/api/orders', undefined))
  const stillListed = check24.status === 200 && Array.isArray(check24.json?.orders) && check24.json.orders.some((o) => o.id === buyOrderId)
  check('24. revoking merchant does not prevent legitimate existing-order read', stillListed, check24)

  const check25 = await withKycStatus(merchantA.userId, 'rejected', async () => {
    const { data } = await admin.from('bookings').select('id, status').eq('id', accepted8BookingId).maybeSingle()
    return data
  })
  check('25. existing booking remains serviceable (status untouched by merchant KYC change)', check25?.status === 'requested' || check25?.status === 'accepted', check25)

  const check26 = barterAgreementId ? await withKycStatus(merchantA.userId, 'rejected', async () => {
    const { data } = await admin.from('barter_agreements').select('id, status').eq('id', barterAgreementId).maybeSingle()
    return data
  }) : null
  check('26. existing barter agreement remains serviceable (status untouched by party KYC change)', check26?.status === 'accepted', check26)

  const check27 = rtbAgreementId ? await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', `/api/rent-to-buy/agreements/${rtbAgreementId}/pay-installment`, { sequence: 1, test_scenario: 'success' })) : { status: 0 }
  check('27. existing RTB agreement remains serviceable (installment payment unaffected by later merchant KYC change)', check27.status === 200, check27)
}

console.log('=== SECURITY ===')
{
  const spoofListing = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Spoof ${RUN_ID}` })
  const spoofAttempt = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/orders', {
    listing_id: spoofListing, quantity: 1, kyc_status: 'approved', merchant_kyc_status: 'approved', verified: true,
  }))
  check('28. client cannot spoof merchant KYC via extraneous request fields', spoofAttempt.status === 403, spoofAttempt)

  const freshKeyAttempt = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/orders', {
    listing_id: spoofListing, quantity: 1, idempotency_key: `hardening-fresh-${RUN_ID}-${Math.random()}`,
  }))
  check('29. client cannot bypass the guard through a fresh direct API payload/idempotency key', freshKeyAttempt.status === 403, freshKeyAttempt)

  const directRpc = await withKycStatus(merchantA.userId, 'rejected', () => admin.rpc('create_order', {
    p_buyer_id: renterA.userId, p_listing_id: spoofListing, p_quantity: 1,
  }))
  check('30. direct trusted RPC path (bypassing the HTTP route entirely) still enforces current merchant KYC', !!directRpc.error && /verification_required/.test(directRpc.error.message), directRpc.error)

  const lfListing31 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} LF Direct RPC ${RUN_ID}` })
  const lfReq31 = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} LF Direct RPC Req ${RUN_ID}`, idempotency_key: `lf-direct-${RUN_ID}` })
  const lfPub31 = lfReq31.status === 201 ? await api(renterA.cookie, 'POST', `/api/marketplace/requests/${lfReq31.json.request_id}/publish`, {}) : { status: 0 }
  const lfOffer31 = lfPub31.status === 200
    ? await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${lfReq31.json.request_id}/offers`, { offer_type: 'link_listing', linked_listing_id: lfListing31, amount: 250, idempotency_key: `lf-direct-off-${RUN_ID}` })
    : { status: 0 }
  const directMarketplaceAccept = lfOffer31.json?.offer_id
    ? await withKycStatus(merchantA.userId, 'rejected', () => admin.rpc('accept_marketplace_offer', {
        p_actor_user_id: renterA.userId, p_offer_id: lfOffer31.json.offer_id,
      }))
    : { error: null, data: 'no-offer' }
  check('31. service-role marketplace acceptance RPC cannot bypass the final transaction guard', !!directMarketplaceAccept.error && /verification_required/.test(directMarketplaceAccept.error.message), directMarketplaceAccept.error)

  const errorText = JSON.stringify(spoofAttempt.json ?? {}) + JSON.stringify(freshKeyAttempt.json ?? {})
  const leaksPrivateDetail = /AML|document|rejected|identity_verification|kyc_status|pending review/i.test(errorText)
  check('32. no KYC-private details exposed in the customer-facing error', !leaksPrivateDetail, { errorText })
}

console.log('=== RESTORATION ===')
{
  const listing33 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Restoration ${RUN_ID}` })
  const blocked33 = await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/orders', { listing_id: listing33, quantity: 1 }))
  const restored33 = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listing33, quantity: 1 })
  check('33. rejected -> approved restores new-transaction eligibility', blocked33.status === 403 && restored33.status === 201, { blocked33, restored33 })

  const listing34 = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Restoration Inventory ${RUN_ID}`, quantity_available: 1 })
  await withKycStatus(merchantA.userId, 'rejected', () => api(renterA.cookie, 'POST', '/api/orders', { listing_id: listing34, quantity: 1 })) // blocked attempt consumes no stock
  const overStock34 = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listing34, quantity: 5 })
  check('34. unrelated listing/inventory rules (stock) still apply after reapproval -- not bypassed by the KYC fix', overStock34.status === 409, overStock34)
}

console.log('=== CLEANUP: no real active listing fixture left behind ===')
{
  const fixtureOwnerIds = [...qaFixtureAccountIds]
  const { data: toClean } = await admin.from('listings').select('id').in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  check('35. cleanup succeeds (no real active listing fixture left behind after this run)', (stillLeaked ?? 0) === 0, { cleanedCount: toClean?.length ?? 0, stillLeaked })
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
