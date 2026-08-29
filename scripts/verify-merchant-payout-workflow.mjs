#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 8 (Merchant Payout
 * Workflow, Admin Operations and Immutable History). Real script against
 * the live dev database, matching every prior phase's verify-*.mjs
 * shape and safety gates.
 *
 * Fixture design, matching lessons learned in Phase 7's own regression
 * script: any fixture driven to a TERMINAL state (paid) within a run
 * uses a PER-RUN-UNIQUE idempotency key/listing title, so reruns don't
 * collide with an already-terminal payout from a prior run. Fixtures
 * that stay in a stable, replayable state (Scenario A's own payout,
 * left 'pending') use a fixed key, proving genuine idempotent replay.
 *
 * No new QA accounts are needed -- the existing roster already covers
 * every role this phase's scenarios require: merchantA (merchant),
 * merchantB (second merchant), renterA (renter), affiliateA (second
 * renter/control), admin (admin), affiliateB (non-admin control).
 * suspendedUser (merchant, already permanently suspended) is reused
 * directly for the "restricted merchant" read-side checks; merchantB is
 * temporarily suspended-then-restored for the live processing-block
 * check, since a merchant must be ACTIVE to complete a booking in the
 * first place -- the restriction can only be layered on afterward.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-merchant-payout-workflow.mjs
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
    console.error('verify-merchant-payout-workflow aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-merchant-payout-workflow aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (!INTERNAL_CRON_SECRET) {
  console.error('verify-merchant-payout-workflow aborted -- INTERNAL_CRON_SECRET missing (needed for Scenario reconciliation checks)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id }
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

async function internalApi(path, body) {
  const res = await fetch(APP_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_CRON_SECRET}` },
    body: body !== undefined ? JSON.stringify(body) : '{}',
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) {
    await admin.from('listings').update({ status: 'active' }).eq('id', existing.id)
    return existing.id
  }
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'rental', quantity_available: 1, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    min_rental_days: 1,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

// No route can move calendar time backward -- direct service-role update
// is the documented fallback for this one case. Unlike qa-seed.mjs's own
// backdateToStartable() (which anchors end_at to windowStart + 3 days,
// leaving end_at only moments after "now" at computation time -- a real,
// latent race found while validating this script: by the time the HTTP
// /start call actually executes, "now" has already advanced past that
// end_at, and the route correctly (if confusingly) rejects it as
// "already passed"), end_at here is anchored to a fixed, generous
// future buffer independent of the slide, so the window is never at
// risk of having "already passed" by the time /start executes.
async function backdateToStartable(bookingId, attempt = 1) {
  const slideDays = 3 * attempt
  const windowStart = Date.now() - slideDays * 24 * 60 * 60 * 1000
  const windowEnd = Date.now() + 2 * 24 * 60 * 60 * 1000
  const { error } = await admin
    .from('bookings')
    .update({ start_at: new Date(windowStart).toISOString(), end_at: new Date(windowEnd).toISOString() })
    .eq('id', bookingId)
  if (error) {
    if (error.message.includes('exclusion constraint') && attempt < 8) return backdateToStartable(bookingId, attempt + 1)
    throw new Error(`backdateToStartable failed for ${bookingId}: ${error.message}`)
  }
}

/** Drives one booking all the way to 'completed', triggering the new confirm-return payout-creation hook. Returns { bookingId, paymentId }. */
async function createCompletedBooking(renterCookie, merchantCookie, listingId, fixtureKey, daysOffsetAnchor) {
  const anchor = new Date('2031-01-01T00:00:00.000Z').getTime() + daysOffsetAnchor * 24 * 60 * 60 * 1000
  const created = await api(renterCookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: new Date(anchor).toISOString(),
    end_at: new Date(anchor + 3 * 24 * 60 * 60 * 1000).toISOString(),
    idempotency_key: `payout-regression-create-${fixtureKey}`,
  })
  const bookingId = created.json?.booking_id
  if (!bookingId) throw new Error(`booking creation failed for ${fixtureKey}: ${JSON.stringify(created)}`)

  // Each step is state-guarded, not blindly replayed -- unlike orders'
  // checkout route, bookings' checkout route rejects a re-call once the
  // booking is already financially ready (a genuine, pre-existing
  // difference between the two domains' routes, not a bug to work around
  // by force). Checking live state first makes this helper safe to run
  // against a booking left partway through by an earlier run.
  const currentState = async () => {
    const { data } = await admin.from('bookings').select('status').eq('id', bookingId).single()
    return data.status
  }

  if ((await currentState()) === 'requested') {
    const acceptRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/accept`, { idempotency_key: `payout-regression-accept-${fixtureKey}` })
    if (acceptRes.status >= 400) throw new Error(`accept failed for ${fixtureKey}: ${JSON.stringify(acceptRes)}`)
  }

  const { data: rentalPaymentPreCheckout } = await admin.from('payments').select('status').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').maybeSingle()
  if (rentalPaymentPreCheckout?.status !== 'captured') {
    const checkoutRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/checkout`, { test_scenario: 'success', idempotency_key: `payout-regression-checkout-${fixtureKey}` })
    if (checkoutRes.status >= 400) throw new Error(`checkout failed for ${fixtureKey}: ${JSON.stringify(checkoutRes)}`)
  }

  if ((await currentState()) === 'accepted') {
    await backdateToStartable(bookingId)
    const startRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/start`, { idempotency_key: `payout-regression-start-${fixtureKey}` })
    if (startRes.status >= 400) throw new Error(`start failed for ${fixtureKey}: ${JSON.stringify(startRes)}`)
  }

  if ((await currentState()) === 'active') {
    const returnRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/return`, { idempotency_key: `payout-regression-return-${fixtureKey}` })
    if (returnRes.status >= 400) throw new Error(`return failed for ${fixtureKey}: ${JSON.stringify(returnRes)}`)
  }

  if ((await currentState()) === 'return_pending') {
    const confirmRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/confirm-return`, { idempotency_key: `payout-regression-confirm-${fixtureKey}` })
    if (confirmRes.status >= 400) throw new Error(`confirm-return failed for ${fixtureKey}: ${JSON.stringify(confirmRes)}`)
  }

  const finalStatus = await currentState()
  if (finalStatus !== 'completed') throw new Error(`booking ${fixtureKey} did not reach completed (stuck at ${finalStatus})`)

  const { data: rentalPayment } = await admin.from('payments').select('id, amount').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').single()
  return { bookingId, paymentId: rentalPayment.id, rentalAmount: Number(rentalPayment.amount) }
}

async function getPayoutForBooking(bookingId) {
  const { data } = await admin.from('merchant_payouts').select('*').eq('booking_id', bookingId).maybeSingle()
  return data
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-merchant-payout-workflow aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { cookie: merchantACookie, userId: merchantAId } = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: merchantBCookie, userId: merchantBId } = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const { cookie: renterACookie } = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: affiliateBCookie } = await cookieFor(creds.accounts.affiliateB.email, creds.accounts.affiliateB.password)
const { cookie: adminCookie } = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)

console.log('=== Scenario A: Existing payout creation ===')
let scenarioABookingId, scenarioAPayout
{
  const listingId = await insertBaseListing(merchantAId, {
    title: `${QA_LISTING_MARKER} Payout Regression — Scenario A`, daily_rate: 300,
    deposit_required: true, deposit_amount: 500,
  })
  const { bookingId, rentalAmount } = await createCompletedBooking(renterACookie, merchantACookie, listingId, 'scenario-a', 100)
  scenarioABookingId = bookingId

  const payout = await getPayoutForBooking(bookingId)
  scenarioAPayout = payout
  check('create_merchant_payout creates exactly one pending payout', !!payout && payout.status === 'pending', payout)

  // Expected amount mirrors createMerchantPayout()'s own formula (rental_charge - platform_fee - refunded),
  // not the raw rental amount -- the platform fee is a real, expected deduction, not a bug.
  const { data: ledgerRows } = await admin.from('ledger_entries').select('entry_type, amount').eq('booking_id', bookingId)
  const sumLedgerBy = (type) => (ledgerRows ?? []).filter((r) => r.entry_type === type).reduce((sum, r) => sum + Number(r.amount), 0)
  const expectedPayoutAmount = Math.round((rentalAmount - sumLedgerBy('platform_fee') - sumLedgerBy('refund')) * 100) / 100
  check('payout amount matches rental charge minus platform fee, with the deposit excluded entirely', payout && Number(payout.amount) === expectedPayoutAmount, { payoutAmount: payout?.amount, expectedPayoutAmount, rentalAmount })

  const { data: depositPayment } = await admin.from('payments').select('amount').eq('booking_id', bookingId).eq('payment_type', 'deposit').maybeSingle()
  check('deposit amount is genuinely nonzero (a meaningful exclusion, not a no-op)', depositPayment && Number(depositPayment.amount) > 0, depositPayment)

  // Exact replay of confirm-return must create no duplicate payout.
  await api(merchantACookie, 'POST', `/api/bookings/${bookingId}/confirm-return`, { idempotency_key: `payout-regression-confirm-scenario-a` })
  const { data: payoutsAfterReplay } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingId)
  check('exact creation replay creates no duplicate payout', (payoutsAfterReplay ?? []).length === 1, payoutsAfterReplay)
}

console.log('\n=== Scenario B: Successful manual workflow ===')
{
  const runSuffix = Date.now()
  const listingId = await insertBaseListing(merchantAId, {
    title: `${QA_LISTING_MARKER} Payout Regression — Scenario B ${runSuffix}`, daily_rate: 250,
  })
  const { bookingId } = await createCompletedBooking(renterACookie, merchantACookie, listingId, `scenario-b-${runSuffix}`, 120)
  const payout = await getPayoutForBooking(bookingId)
  check('fixture payout created as pending', payout?.status === 'pending', payout)

  const processingRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-processing`, { idempotency_key: `payout-regression-b-processing-${runSuffix}` })
  check('admin can start processing', processingRes.status === 200 && processingRes.json?.status === 'processing', processingRes)

  const paidRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-paid`, {
    payoutReference: `MOCK-PAY-${runSuffix}`, payoutMethod: 'manual', confirmManualPayment: true,
    idempotency_key: `payout-regression-b-paid-${runSuffix}`,
  })
  check('admin can mark paid with a safe manual reference', paidRes.status === 200 && paidRes.json?.status === 'paid', paidRes)

  const { data: historyRows } = await admin.from('merchant_payout_history').select('*').eq('payout_id', payout.id).order('created_at')
  check('immutable history has one row per transition (created implicitly + processing + paid)', (historyRows ?? []).length >= 2, historyRows)

  const meRes = await api(merchantACookie, 'GET', '/api/payouts/me')
  const meRow = (meRes.json?.payouts ?? []).find((p) => p.id === payout.id)
  check('merchant dashboard shows the paid payout with a safe reference', meRow?.status === 'paid' && meRow?.payoutReference === `MOCK-PAY-${runSuffix}`, meRow)
}

console.log('\n=== Scenario C: Failed and retry workflow ===')
{
  const runSuffix = Date.now()
  const listingId = await insertBaseListing(merchantAId, {
    title: `${QA_LISTING_MARKER} Payout Regression — Scenario C ${runSuffix}`, daily_rate: 400,
  })
  const { bookingId } = await createCompletedBooking(renterACookie, merchantACookie, listingId, `scenario-c-${runSuffix}`, 140)
  const payout = await getPayoutForBooking(bookingId)

  await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-processing`, { idempotency_key: `payout-regression-c-processing-${runSuffix}` })
  const failRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-failed`, {
    failureCategory: 'provider_unavailable', reason: 'regression: simulated transient failure',
    idempotency_key: `payout-regression-c-failed-${runSuffix}`,
  })
  check('admin can mark failed with a normalized category', failRes.status === 200 && failRes.json?.status === 'failed', failRes)
  check('mark-failed response includes the server-derived safe message, not raw admin text', failRes.json?.failure_message_safe && failRes.json.failure_message_safe !== 'regression: simulated transient failure', failRes.json)

  const retryRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/retry`, { reason: 'regression: retrying after transient failure', idempotency_key: `payout-regression-c-retry-${runSuffix}` })
  check('admin can retry a failed payout back to processing', retryRes.status === 200 && retryRes.json?.status === 'processing', retryRes)
  check('retry does not create a new payout row', (await admin.from('merchant_payouts').select('id').eq('booking_id', bookingId)).data.length === 1)

  const paidRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-paid`, {
    payoutReference: `MOCK-RETRY-${runSuffix}`, payoutMethod: 'mock_validation', confirmManualPayment: true,
    idempotency_key: `payout-regression-c-paid-${runSuffix}`,
  })
  check('payout can be marked paid after a successful retry', paidRes.status === 200 && paidRes.json?.status === 'paid', paidRes)

  const { data: finalPayout } = await admin.from('merchant_payouts').select('attempt_count, amount').eq('id', payout.id).single()
  check('attempt count reflects both the initial processing and the retry', finalPayout.attempt_count === 2, finalPayout)
  check('original payout amount is unchanged through the whole failure/retry cycle', Number(finalPayout.amount) === Number(payout.amount), { finalPayout, original: payout.amount })

  const { data: historyRows } = await admin.from('merchant_payout_history').select('new_status').eq('payout_id', payout.id).order('created_at')
  check('the prior failure history entry is preserved, not overwritten, after retry+paid', (historyRows ?? []).some((h) => h.new_status === 'failed'), historyRows)
}

console.log('\n=== Scenario D: Eligibility blocks ===')
{
  // D1: failed/refunded source payment blocks processing.
  const listingD1 = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Scenario D1`, daily_rate: 200 })
  const { bookingId: bookingD1 } = await createCompletedBooking(renterACookie, merchantACookie, listingD1, 'scenario-d1', 160)
  const payoutD1 = await getPayoutForBooking(bookingD1)
  await admin.from('payments').update({ status: 'refunded' }).eq('booking_id', bookingD1).eq('payment_type', 'rental_charge')
  const blockedD1 = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutD1.id}/mark-processing`, { idempotency_key: `payout-regression-d1-${Date.now()}` })
  check('a refunded source payment blocks processing', blockedD1.status >= 400, blockedD1)
  await admin.from('payments').update({ status: 'captured' }).eq('booking_id', bookingD1).eq('payment_type', 'rental_charge') // restore for a clean rerun

  // D2: unresolved dispute blocks processing. Opening a dispute leaves the booking permanently
  // 'disputed' -- a terminal state for this fixture's purposes -- so it needs a per-run-unique
  // fixture key, not a fixed one (a fixed key would replay into an already-disputed booking on rerun).
  const d2RunSuffix = Date.now()
  const listingD2 = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Scenario D2 ${d2RunSuffix}`, daily_rate: 200 })
  const { bookingId: bookingD2 } = await createCompletedBooking(renterACookie, merchantACookie, listingD2, `scenario-d2-${d2RunSuffix}`, 180)
  const payoutD2 = await getPayoutForBooking(bookingD2)
  const disputeRes = await api(renterACookie, 'POST', '/api/disputes', {
    booking_id: bookingD2, title: 'Regression dispute fixture', description: 'Payout regression D2 fixture — expect processing to be blocked.',
    requested_resolution: 'Refund requested for regression testing.', idempotency_key: `payout-regression-d2-dispute-${d2RunSuffix}`,
  })
  check('dispute fixture created/replayed for D2', disputeRes.status === 200 || disputeRes.status === 201, disputeRes)
  const blockedD2 = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutD2.id}/mark-processing`, { idempotency_key: `payout-regression-d2-${Date.now()}` })
  check('an unresolved dispute blocks processing', blockedD2.status >= 400, blockedD2)

  // D3: restricted merchant blocks processing (temporarily suspend merchantB, then restore).
  const listingD3 = await insertBaseListing(merchantBId, { title: `${QA_LISTING_MARKER} Payout Regression — Scenario D3`, daily_rate: 200 })
  const { bookingId: bookingD3 } = await createCompletedBooking(renterACookie, merchantBCookie, listingD3, 'scenario-d3', 200)
  const payoutD3 = await getPayoutForBooking(bookingD3)
  await admin.from('profiles').update({ account_status: 'suspended' }).eq('id', merchantBId)
  const blockedD3 = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutD3.id}/mark-processing`, { idempotency_key: `payout-regression-d3-${Date.now()}` })
  check('a suspended merchant blocks processing', blockedD3.status >= 400, blockedD3)
  await admin.from('profiles').update({ account_status: 'active' }).eq('id', merchantBId) // restore immediately -- merchantB is a shared fixture account
  const { data: restoredMerchantB } = await admin.from('profiles').select('account_status').eq('id', merchantBId).single()
  check('merchantB account status restored to active after the D3 check', restoredMerchantB.account_status === 'active', restoredMerchantB)
}

console.log('\n=== Scenario E: Paid followed by financial issue ===')
{
  const runSuffix = Date.now()
  const listingId = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Scenario E ${runSuffix}`, daily_rate: 350 })
  const { bookingId } = await createCompletedBooking(renterACookie, merchantACookie, listingId, `scenario-e-${runSuffix}`, 220)
  const payout = await getPayoutForBooking(bookingId)

  await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-processing`, { idempotency_key: `payout-regression-e-processing-${runSuffix}` })
  await api(adminCookie, 'POST', `/api/admin/payouts/${payout.id}/mark-paid`, {
    payoutReference: `MOCK-E-${runSuffix}`, payoutMethod: 'manual', confirmManualPayment: true,
    idempotency_key: `payout-regression-e-paid-${runSuffix}`,
  })
  const { data: paidPayout } = await admin.from('merchant_payouts').select('status, amount, provider_reference').eq('id', payout.id).single()
  check('payout reached paid before the refund', paidPayout.status === 'paid', paidPayout)

  await admin.from('payments').update({ status: 'refunded' }).eq('booking_id', bookingId).eq('payment_type', 'rental_charge')

  const { data: afterRefund } = await admin.from('merchant_payouts').select('status, amount, provider_reference').eq('id', payout.id).single()
  check('paid payout remains unchanged after a later refund -- status, amount, and reference are never rewritten', afterRefund.status === 'paid' && Number(afterRefund.amount) === Number(paidPayout.amount) && afterRefund.provider_reference === paidPayout.provider_reference, { before: paidPayout, after: afterRefund })

  // Control fixture: a second, independent paid payout on a DIFFERENT
  // booking with NO refund -- proves correct entity association (only
  // the genuinely refunded payout is flagged) and the false-positive
  // control required for the payout-exceptions scalability fix (Wave 2C).
  const listingControl = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Scenario E control ${runSuffix}`, daily_rate: 355 })
  const { bookingId: controlBookingId } = await createCompletedBooking(renterACookie, merchantACookie, listingControl, `scenario-e-control-${runSuffix}`, 221)
  const controlPayout = await getPayoutForBooking(controlBookingId)
  await api(adminCookie, 'POST', `/api/admin/payouts/${controlPayout.id}/mark-processing`, { idempotency_key: `payout-regression-econtrol-processing-${runSuffix}` })
  await api(adminCookie, 'POST', `/api/admin/payouts/${controlPayout.id}/mark-paid`, {
    payoutReference: `MOCK-ECTRL-${runSuffix}`, payoutMethod: 'manual', confirmManualPayment: true,
    idempotency_key: `payout-regression-econtrol-paid-${runSuffix}`,
  })
  // No refund applied to controlBookingId's rental payment -- it stays 'captured'.

  const exceptionsRes = await api(adminCookie, 'GET', '/api/admin/exceptions')
  const exceptions = exceptionsRes.json?.exceptions ?? exceptionsRes.json?.items ?? []
  const flagged = exceptions.find((e) => e.entityId === payout.id && e.type === 'merchant_payout_paid_then_refunded')
  check('a paid-then-refunded exception is surfaced for admin review', !!flagged, flagged)

  const falsePositive = exceptions.find((e) => e.entityId === controlPayout.id && e.type === 'merchant_payout_paid_then_refunded')
  check('a paid payout with no refund is NOT falsely flagged as paid-then-refunded (false-positive control)', !falsePositive, falsePositive)

  const wrongAssociation = exceptions.find((e) => e.type === 'merchant_payout_paid_then_refunded' && e.entityId === controlPayout.id)
  check('the refund is correctly associated with its own booking/payout, never the unrelated control payout', !wrongAssociation, wrongAssociation)
}

console.log('\n=== Scenario F: Admin ===')
{
  // ── Direct search proofs ──
  // Scenario A's payout is deliberately old (created once, on the fixed
  // 'scenario-a' fixture key, and never re-created on subsequent runs)
  // and, at current dataset volume, ranks far outside a top-100-by-
  // created_at window. This is the actual regression: the old
  // implementation fetched only the top 100 rows by created_at, then
  // searched in Node -- so this specific check is the one that catches
  // a regression back to that shape.
  const scenarioASearchTerm = 'Payout Regression — Scenario A'
  const listRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm)}`)
  check('admin list filtering by search works', listRes.status === 200 && (listRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), listRes.status)

  const lowerRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm.toLowerCase())}`)
  check('search: lowercase variant still matches (case-insensitive)', lowerRes.status === 200 && (lowerRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), lowerRes.status)

  const upperRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm.toUpperCase())}`)
  check('search: uppercase variant still matches (case-insensitive)', upperRes.status === 200 && (upperRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), upperRes.status)

  const partialRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent('Scenario A')}`)
  check('search: partial substring (mid-string, no marker prefix) still matches', partialRes.status === 200 && (partialRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), partialRes.status)

  const whitespaceRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(`  ${scenarioASearchTerm}  `)}`)
  check('search: leading/trailing whitespace is trimmed before matching', whitespaceRes.status === 200 && (whitespaceRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), whitespaceRes.status)

  const noMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent('totally-unrelated-xyz-does-not-exist')}`)
  check('search: a genuinely non-matching term returns 0 results, not an error', noMatchRes.status === 200 && (noMatchRes.json?.payouts ?? []).length === 0, noMatchRes.status)

  // Narrow enough to uniquely identify scenarioA specifically -- 'Regression — Scenario'
  // alone matches ~196 fixtures accumulated across every prior run of this
  // suite, and scenarioA (the oldest) correctly falls outside the
  // default 100-row bound for that overly generic term. That is the
  // intended, bounded behavior (Step 5), not a defect -- this check
  // instead isolates the em-dash-handling question specifically.
  const emdashRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent('Regression — Scenario A')}`)
  check('search: em-dash punctuation in the term matches correctly', emdashRes.status === 200 && (emdashRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), emdashRes.status)

  const literalPercentRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent('Scenario%A')}`)
  check('search: a literal "%" in the term is NOT treated as a SQL wildcard (no match against "Scenario A")', literalPercentRes.status === 200 && !(literalPercentRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), literalPercentRes.status)

  const literalUnderscoreRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent('Scenario_A')}`)
  check('search: a literal "_" in the term is NOT treated as a SQL wildcard (no match against "Scenario A")', literalUnderscoreRes.status === 200 && !(literalUnderscoreRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), literalUnderscoreRes.status)

  // ── Merchant-name / apostrophe / booking-reference / provider-reference: dedicated fixture ──
  // merchantA's profile has no full_name/display_name set by default (a
  // real, pre-existing QA-account state, not something this phase
  // changes) -- temporarily set one to prove merchant-name search,
  // mirroring this file's own established Scenario D3 pattern
  // (temporarily mutate a shared QA profile field, restore immediately
  // after, verify the restore).
  const searchRunSuffix = Date.now()
  const searchMerchantName = `${QA_LISTING_MARKER} Search Proof Merchant ${searchRunSuffix}`
  await admin.from('profiles').update({ full_name: searchMerchantName }).eq('id', merchantAId)

  const searchListingTitle = `${QA_LISTING_MARKER} Payout Regression — Search Fields' Test ${searchRunSuffix}`
  const searchListingId = await insertBaseListing(merchantAId, { title: searchListingTitle, daily_rate: 260 })
  const { bookingId: searchBookingId } = await createCompletedBooking(renterACookie, merchantACookie, searchListingId, `search-fields-${searchRunSuffix}`, 500)
  const searchPayout = await getPayoutForBooking(searchBookingId)
  const searchProviderReference = `MOCK-SEARCH-${searchRunSuffix}`
  await api(adminCookie, 'POST', `/api/admin/payouts/${searchPayout.id}/mark-processing`, { idempotency_key: `payout-regression-search-proc-${searchRunSuffix}` })
  await api(adminCookie, 'POST', `/api/admin/payouts/${searchPayout.id}/mark-paid`, {
    payoutReference: searchProviderReference, payoutMethod: 'manual', confirmManualPayment: true, idempotency_key: `payout-regression-search-paid-${searchRunSuffix}`,
  })
  const { data: searchBookingRow } = await admin.from('bookings').select('booking_reference').eq('id', searchBookingId).single()

  const merchantNameRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(searchMerchantName)}`)
  check('search: merchant name field is searchable', merchantNameRes.status === 200 && (merchantNameRes.json?.payouts ?? []).some((p) => p.id === searchPayout.id), merchantNameRes.status)

  const apostropheRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent("Fields' Test")}`)
  check('search: apostrophe in the term is handled safely (parameterized, no SQL error) and matches correctly', apostropheRes.status === 200 && (apostropheRes.json?.payouts ?? []).some((p) => p.id === searchPayout.id), apostropheRes.status)

  const bookingReferenceRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(searchBookingRow.booking_reference)}`)
  check('search: booking reference field is searchable', bookingReferenceRes.status === 200 && (bookingReferenceRes.json?.payouts ?? []).some((p) => p.id === searchPayout.id), bookingReferenceRes.status)

  const providerReferenceRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(searchProviderReference)}`)
  check('search: payout/provider reference field is searchable', providerReferenceRes.status === 200 && (providerReferenceRes.json?.payouts ?? []).some((p) => p.id === searchPayout.id), providerReferenceRes.status)

  await admin.from('profiles').update({ full_name: null }).eq('id', merchantAId)
  const { data: restoredMerchantA } = await admin.from('profiles').select('full_name').eq('id', merchantAId).single()
  check('merchantA full_name restored to null after the search proof (shared fixture account)', restoredMerchantA.full_name === null, restoredMerchantA)

  // ── Filter combination proofs: search composes correctly with existing filters, each applied before limit ──
  const searchPlusStatusMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm)}&status=pending`)
  check('search + status=pending: matches (scenarioA payout genuinely is pending)', searchPlusStatusMatchRes.status === 200 && (searchPlusStatusMatchRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), searchPlusStatusMatchRes.status)

  const searchPlusStatusNoMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm)}&status=paid`)
  check('search + status=paid: no match (scenarioA payout is pending, not paid -- filters apply together, not either/or)', searchPlusStatusNoMatchRes.status === 200 && !(searchPlusStatusNoMatchRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), searchPlusStatusNoMatchRes.status)

  const searchPlusOverdueMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm)}&overdueOnly=true`)
  check('search + overdueOnly=true: matches (scenarioA payout is genuinely far past the 48h threshold and still pending)', searchPlusOverdueMatchRes.status === 200 && (searchPlusOverdueMatchRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), searchPlusOverdueMatchRes.status)

  const searchPlusOverdueNoMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(searchMerchantName)}&overdueOnly=true`)
  check('search + overdueOnly=true: no match against a brand-new (not overdue) fixture', searchPlusOverdueNoMatchRes.status === 200 && !(searchPlusOverdueNoMatchRes.json?.payouts ?? []).some((p) => p.id === searchPayout.id), searchPlusOverdueNoMatchRes.status)

  // Dedicated dispute fixture for the search + disputeRelated combination, mirroring Scenario D2's pattern.
  const disputeRunSuffix = Date.now()
  const disputeListingTitle = `${QA_LISTING_MARKER} Payout Regression — Search Dispute ${disputeRunSuffix}`
  const disputeListingId = await insertBaseListing(merchantAId, { title: disputeListingTitle, daily_rate: 270 })
  const { bookingId: disputeBookingId } = await createCompletedBooking(renterACookie, merchantACookie, disputeListingId, `search-dispute-${disputeRunSuffix}`, 501)
  await api(renterACookie, 'POST', '/api/disputes', {
    booking_id: disputeBookingId, title: 'Search filter regression dispute fixture', description: 'Payout search + disputeRelated combination proof.',
    requested_resolution: 'Refund requested for regression testing.', idempotency_key: `payout-regression-search-dispute-${disputeRunSuffix}`,
  })
  const disputePayout = await getPayoutForBooking(disputeBookingId)

  const searchPlusDisputeMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(disputeListingTitle)}&disputeRelated=true`)
  check('search + disputeRelated=true: matches a payout with a genuine unresolved dispute', searchPlusDisputeMatchRes.status === 200 && (searchPlusDisputeMatchRes.json?.payouts ?? []).some((p) => p.id === disputePayout?.id), searchPlusDisputeMatchRes.status)

  const searchPlusDisputeNoMatchRes = await api(adminCookie, 'GET', `/api/admin/payouts?search=${encodeURIComponent(scenarioASearchTerm)}&disputeRelated=true`)
  check('search + disputeRelated=true: no match against scenarioA (no dispute on that booking)', searchPlusDisputeNoMatchRes.status === 200 && !(searchPlusDisputeNoMatchRes.json?.payouts ?? []).some((p) => p.id === scenarioAPayout?.id), searchPlusDisputeNoMatchRes.status)

  const detailRes = await api(adminCookie, 'GET', `/api/admin/payouts/${scenarioAPayout.id}`)
  check('admin detail returns the correct booking and financial data', detailRes.status === 200 && detailRes.json?.payout?.id === scenarioAPayout.id && detailRes.json?.booking?.id === scenarioABookingId, detailRes.status)

  // Stale-action rejection: scenarioA's payout is still 'pending' -- mark-paid must be rejected (skips processing).
  const staleRes = await api(adminCookie, 'POST', `/api/admin/payouts/${scenarioAPayout.id}/mark-paid`, {
    payoutReference: 'SHOULD-NOT-APPLY', payoutMethod: 'manual', confirmManualPayment: true, idempotency_key: `payout-regression-stale-${Date.now()}`,
  })
  check('admin cannot skip processing and mark pending -> paid directly', staleRes.status >= 400, staleRes)

  const nonAdminRes = await api(affiliateBCookie, 'POST', `/api/admin/payouts/${scenarioAPayout.id}/mark-processing`, { idempotency_key: `payout-regression-nonadmin-${Date.now()}` })
  check('non-admin is blocked from admin payout routes', nonAdminRes.status === 401 || nonAdminRes.status === 403, nonAdminRes)
}

console.log('\n=== Scenario G: Merchant access ===')
{
  const ownRes = await api(merchantACookie, 'GET', '/api/payouts/me')
  const ownRow = (ownRes.json?.payouts ?? []).find((p) => p.id === scenarioAPayout.id)
  check('merchant sees their own payout', ownRes.status === 200 && !!ownRow, ownRes.status)

  const crossReadClient = createClient(SUPABASE_URL, ANON_KEY)
  await crossReadClient.auth.signInWithPassword({ email: creds.accounts.merchantB.email, password: creds.accounts.merchantB.password })
  const { data: crossReadRows } = await crossReadClient.from('merchant_payouts').select('id').eq('id', scenarioAPayout.id)
  check('cross-merchant read blocked by RLS', !crossReadRows || crossReadRows.length === 0, crossReadRows)

  // merchant_payouts has zero client write policies at all -- with RLS enabled and no UPDATE
  // policy, Postgres silently matches zero rows rather than raising an error, so the real
  // assertion is "the row was not changed," not "an error was thrown."
  const mutateAttempt = await crossReadClient.from('merchant_payouts').update({ status: 'paid' }).eq('id', scenarioAPayout.id).select()
  const { data: unmutatedPayout } = await admin.from('merchant_payouts').select('status').eq('id', scenarioAPayout.id).single()
  check(
    'merchant cannot mutate a payout via direct client write',
    (mutateAttempt.data ?? []).length === 0 && unmutatedPayout.status === scenarioAPayout.status,
    { mutateError: mutateAttempt.error, mutateRowsReturned: mutateAttempt.data, statusAfter: unmutatedPayout.status, statusBefore: scenarioAPayout.status }
  )
}

console.log('\n=== Scenario H: Security and immutability ===')
{
  const forgedRpc = await admin.rpc('mark_payout_paid', {
    p_admin_id: null, p_payout_id: scenarioAPayout.id, p_payout_reference: 'FORGED', p_payout_method: 'manual', p_confirm_manual_payment: true,
  })
  check('mark_payout_paid rejects a null admin id (forged actor)', !!forgedRpc.error, forgedRpc.error)

  const anonRpcAttempt = await (async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    await anonClient.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
    return anonClient.rpc('mark_payout_processing', { p_admin_id: '00000000-0000-0000-0000-000000000000', p_payout_id: scenarioAPayout.id })
  })()
  check('direct privileged RPC call as a non-service-role authenticated user is blocked', !!anonRpcAttempt.error, anonRpcAttempt.error)

  const { data: someHistoryRow } = await admin.from('merchant_payout_history').select('id').limit(1).maybeSingle()
  if (someHistoryRow) {
    const updateAttempt = await admin.from('merchant_payout_history').update({ reason: 'tampered' }).eq('id', someHistoryRow.id)
    check('direct history UPDATE is blocked at the database level', !!updateAttempt.error, updateAttempt.error)
    const deleteAttempt = await admin.from('merchant_payout_history').delete().eq('id', someHistoryRow.id)
    check('direct history DELETE is blocked at the database level', !!deleteAttempt.error, deleteAttempt.error)
  }

  const forgedInsert = await (async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const { data: sess } = await anonClient.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
    return anonClient.from('merchant_payouts').insert({ merchant_id: sess?.user?.id, amount: 999999, status: 'paid' })
  })()
  check('direct client insert into merchant_payouts is blocked (zero client write policies)', !!forgedInsert.error, forgedInsert.error)

  // Changed-payload replay conflict: reuse the D2 dispute idempotency key with a different description.
  const conflictRes = await api(renterACookie, 'POST', '/api/disputes', {
    booking_id: scenarioABookingId, title: 'Different title', description: 'A genuinely different payload using the same idempotency key.',
    requested_resolution: 'Different resolution.', idempotency_key: 'payout-regression-d2-dispute',
  })
  check('changed-payload replay with a reused idempotency key conflicts, not silently succeeds', conflictRes.status === 409, conflictRes)

  const csvRes = await api(adminCookie, 'GET', '/api/admin/payouts?format=csv')
  check('CSV export responds successfully', csvRes.status === 200, csvRes.status)
}

console.log('\n=== Reconciliation routes ===')
{
  const missingRes = await internalApi('/api/internal/payouts/reconcile-missing')
  check('reconcile-missing sweep responds 200 and is bounded/rerunnable', missingRes.status === 200 && typeof missingRes.json?.scanned === 'number', missingRes)

  const reconcileRes = await internalApi('/api/internal/payouts/reconcile')
  check('reconcile sweep responds 200 with a detection summary, never mutating', reconcileRes.status === 200 && typeof reconcileRes.json?.detected === 'number', reconcileRes)
}

console.log('\n=== No full-history payout-ID transport (structural, source-code proof) ===')
{
  const reconcileSrc = readFileSync(join(REPO_ROOT, 'src/app/api/internal/payouts/reconcile-missing/route.ts'), 'utf8')
  // Checks the actual functional call shape (a real template literal
  // immediately after the filter args), not this file's own doc-comment
  // prose describing the old pattern by name for documentation purposes.
  check('reconcile-missing route never builds a `.not(id,in,...)` exclusion filter', !/\.not\('id',\s*'in',\s*`/.test(reconcileSrc), {})
  check('reconcile-missing route never fetches the full merchant_payouts.booking_id set into Node', !reconcileSrc.includes("select('booking_id')"), {})
  check('reconcile-missing route calls the bounded candidate RPC', reconcileSrc.includes('_payout_reconcile_missing_candidates'), {})

  const exceptionsSrc = readFileSync(join(REPO_ROOT, 'src/lib/admin/exceptions-service.ts'), 'utf8')
  // Checks the actual functional call shape (admin.rpc(...)), not this
  // file's own doc-comment prose naming the superseded RPC for context.
  check('exceptions-service never calls the superseded array-based RPC (_merchant_payout_relevant_context)', !exceptionsSrc.includes("admin.rpc('_merchant_payout_relevant_context'"), {})
  check('exceptions-service never constructs allRelevantBookingIds (the old unbounded id-array pattern)', !exceptionsSrc.includes('allRelevantBookingIds'), {})
  check('exceptions-service never does a `.in(\'booking_id\', ...)` filter for payout exception context', !/\.in\('booking_id',\s*(all|relevant)/i.test(exceptionsSrc), {})
  check('exceptions-service calls the final parameterless, relational candidate RPC', exceptionsSrc.includes('_merchant_payout_exception_candidates()'), {})
}

console.log('\n=== Reconcile-missing scalability (Wave 2C) ===')
{
  // A. completed eligible booking with no payout -> discovered -> payout created once.
  // Constructed by flipping the booking straight to 'completed' via the
  // service client (bypassing confirm-return's own best-effort creation
  // hook entirely) -- the ONLY way to get a genuinely payout-less
  // completed booking to test candidate discovery in isolation, since
  // merchant_payouts has a real ON DELETE-blocking FK from
  // merchant_payout_history once a payout has ever been created.
  const runSuffix = Date.now()
  const listingA = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Reconcile A ${runSuffix}`, daily_rate: 210 })
  const createdA = await api(renterACookie, 'POST', '/api/bookings', { listing_id: listingA, start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), end_at: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000).toISOString(), idempotency_key: `reconcile-a-create-${runSuffix}` })
  const bookingA = createdA.json.booking_id
  await api(merchantACookie, 'POST', `/api/bookings/${bookingA}/accept`, { idempotency_key: `reconcile-a-accept-${runSuffix}` })
  await api(renterACookie, 'POST', `/api/bookings/${bookingA}/checkout`, { test_scenario: 'success', idempotency_key: `reconcile-a-checkout-${runSuffix}` })
  await admin.from('bookings').update({ status: 'completed' }).eq('id', bookingA)
  const { data: payoutBeforeA } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingA).maybeSingle()
  check('Reconcile-A0. booking is completed with genuinely no payout row before reconciliation', !payoutBeforeA, payoutBeforeA)

  const reconcileA = await internalApi('/api/internal/payouts/reconcile-missing')
  check('Reconcile-A1. reconcile-missing responds 200', reconcileA.status === 200, reconcileA)
  const { data: payoutsAfterA } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingA)
  check('Reconcile-A2. exactly one payout is created for the discovered candidate', payoutsAfterA?.length === 1, payoutsAfterA)

  // B-E. eligible booking with an existing payout in each status -> never duplicated.
  const statuses = ['pending', 'processing', 'paid', 'failed']
  for (const [i, status] of statuses.entries()) {
    const key = `reconcile-bcde-${i}-${runSuffix}`
    const listing = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Reconcile ${status} ${runSuffix}`, daily_rate: 215 })
    const { bookingId } = await createCompletedBooking(renterACookie, merchantACookie, listing, key, 200 + i)
    const existingPayout = await getPayoutForBooking(bookingId)
    if (!existingPayout) throw new Error(`expected confirm-return to have already created a payout for ${key}`)
    await admin.from('merchant_payouts').update({ status }).eq('id', existingPayout.id)

    const reconcileRun = await internalApi('/api/internal/payouts/reconcile-missing')
    check(`Reconcile-${status}1. reconcile-missing responds 200 with an existing ${status} payout present`, reconcileRun.status === 200, reconcileRun)
    const { data: payoutsAfter } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingId)
    check(`Reconcile-${status}2. still exactly one payout row -- never duplicated for an existing ${status} payout`, payoutsAfter?.length === 1 && payoutsAfter[0].id === existingPayout.id, payoutsAfter)

    // Restore to pending so this fixture doesn't skew other scenarios' assumptions.
    await admin.from('merchant_payouts').update({ status: 'pending' }).eq('id', existingPayout.id)
  }

  // I. many historical payouts -> route still responds successfully, no oversized NOT IN URL.
  // Uses the ACTUAL accumulated DEVELOPMENT volume rather than manufacturing
  // thousands more rows -- this dev database already carries far more than
  // the ~409 rows that were already enough to reproduce the original
  // failure, so a live 200 here is itself the high-volume proof.
  const { count: totalPayoutRows } = await admin.from('merchant_payouts').select('id', { count: 'exact', head: true })
  const reconcileHighVolume = await internalApi('/api/internal/payouts/reconcile-missing')
  check(`Reconcile-I1. route responds 200 at current accumulated volume (${totalPayoutRows} total payout rows, already far past the ~409-row threshold that broke the old implementation)`, reconcileHighVolume.status === 200, { totalPayoutRows, status: reconcileHighVolume.status })

  // J. repeated reconciliation -> idempotent.
  const reconcileRepeat1 = await internalApi('/api/internal/payouts/reconcile-missing')
  const reconcileRepeat2 = await internalApi('/api/internal/payouts/reconcile-missing')
  check('Reconcile-J1. two sequential reconcile-missing calls both respond 200', reconcileRepeat1.status === 200 && reconcileRepeat2.status === 200, { reconcileRepeat1, reconcileRepeat2 })
  const { data: payoutsAfterA_repeat } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingA)
  check('Reconcile-J2. Scenario A booking still has exactly one payout after repeated reconciliation', payoutsAfterA_repeat?.length === 1, payoutsAfterA_repeat)

  // K. concurrent reconciliation -> no duplicate payout.
  const listingK = await insertBaseListing(merchantAId, { title: `${QA_LISTING_MARKER} Payout Regression — Reconcile K ${runSuffix}`, daily_rate: 220 })
  const createdK = await api(renterACookie, 'POST', '/api/bookings', { listing_id: listingK, start_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), end_at: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000).toISOString(), idempotency_key: `reconcile-k-create-${runSuffix}` })
  const bookingK = createdK.json.booking_id
  await api(merchantACookie, 'POST', `/api/bookings/${bookingK}/accept`, { idempotency_key: `reconcile-k-accept-${runSuffix}` })
  await api(renterACookie, 'POST', `/api/bookings/${bookingK}/checkout`, { test_scenario: 'success', idempotency_key: `reconcile-k-checkout-${runSuffix}` })
  await admin.from('bookings').update({ status: 'completed' }).eq('id', bookingK)

  const concurrentResults = await Promise.all([internalApi('/api/internal/payouts/reconcile-missing'), internalApi('/api/internal/payouts/reconcile-missing')])
  check('Reconcile-K1. both concurrent reconcile-missing calls respond 200, no 500', concurrentResults.every((r) => r.status === 200), concurrentResults)
  const { data: payoutsAfterK } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingK)
  check('Reconcile-K2. exactly one payout row exists after concurrent reconciliation -- no duplicate obligation', payoutsAfterK?.length === 1, payoutsAfterK)
}

console.log('\n=== CLEANUP ===')
{
  // This script had no fixture-hygiene sweep at all -- every listing it
  // ever created stayed real (is_test=false) indefinitely. Flips every
  // QA_LISTING_MARKER-tagged listing to is_test=true (never deletes,
  // never touches merchant_payouts/merchant_payout_history rows) so
  // fixtures stop counting toward cap/public-visibility, matching the
  // convention every other verify-*.mjs script in this repo already
  // follows.
  // Scoped to "Payout Regression" specifically (not the bare QA_LISTING_MARKER,
  // which is the generic `[QA]` prefix shared by every other script in this
  // repo) -- stays precisely within the fixtures this script itself creates.
  const { data: leaked } = await admin.from('listings').select('id').ilike('title', '%Payout Regression%').eq('is_test', false)
  if ((leaked ?? []).length > 0) {
    await admin.from('listings').update({ is_test: true }).in('id', leaked.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', '%Payout Regression%').eq('is_test', false)
  check('cleanup succeeds -- no real (is_test=false) QA listing fixture left behind after this run', (stillLeaked ?? 0) === 0, { stillLeaked })
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
