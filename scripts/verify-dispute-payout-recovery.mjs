#!/usr/bin/env node
/**
 * Permanent regression check for the resolved-dispute booking.status ->
 * merchant payout recovery corrective fix.
 *
 * Root cause fixed: open_dispute() set booking.status = 'disputed' but
 * never recorded what it was before, and neither resolve_dispute() nor
 * cancel_dispute() ever restored it -- so a booking that was ever
 * disputed had its merchant payout permanently blocked (Phase 8's
 * mark_payout_processing requires booking.status = 'completed'), even
 * after a clean, merchant-favorable resolution with zero refund.
 *
 * Fix (two migrations, same session): disputes.pre_dispute_status
 * (captured at open_dispute() time) + resolve_dispute()/cancel_dispute()
 * restore bookings.status from it. resolve_dispute() restores ONLY on
 * outcome = 'favor_respondent' (proven live: unconditional restoration
 * incorrectly unlocked payout after a favor_raiser/customer-favorable
 * resolution with no refund -- fixed forward in a second migration).
 * cancel_dispute() restores unconditionally (a cancelled dispute has no
 * outcome/adjudication at all).
 *
 * This script covers what scripts/verify-dispute-locking.mjs
 * deliberately does not: that scripts verifies disputes FREEZE other
 * actions; this one verifies that RESOLUTION correctly UNFREEZES a
 * booking's payout path -- and only when it legitimately should.
 *
 * Fails closed: every assertion is an explicit check() call; any
 * unexpected RPC/route error throws and aborts the run rather than
 * being silently treated as a pass.
 *
 * SAFETY: same gate as every other verify-*.mjs script in this repo.
 * Usage: node scripts/verify-dispute-payout-recovery.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL.
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
    console.error('verify-dispute-payout-recovery aborted -- safety checks failed:')
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
  console.error('verify-dispute-payout-recovery aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const RUN_ID = Date.now()
const QA_LISTING_MARKER = '[QA] Dispute-Payout Recovery'

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { client, cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id }
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

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

async function insertRentalListing(merchantId, title) {
  const { data, error } = await admin.from('listings').insert({
    merchant_id: merchantId, title, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'rental', quantity_available: 1, status: 'active', risk_tier: 'low',
    ownership_verified: false, condition_confirmed: true, min_rental_days: 1, is_test: true, daily_rate: 300,
  }).select('id').single()
  if (error) throw new Error(`insertRentalListing failed: ${error.message}`)
  return data.id
}

async function backdateToStartable(bookingId, attempt = 1) {
  const slideDays = 3 * attempt
  const windowStart = Date.now() - slideDays * 24 * 60 * 60 * 1000
  const windowEnd = Date.now() + 2 * 24 * 60 * 60 * 1000
  const { error } = await admin.from('bookings').update({ start_at: new Date(windowStart).toISOString(), end_at: new Date(windowEnd).toISOString() }).eq('id', bookingId)
  if (error) {
    if (error.message.includes('exclusion constraint') && attempt < 8) return backdateToStartable(bookingId, attempt + 1)
    throw new Error(`backdateToStartable failed: ${error.message}`)
  }
}

/** Books, charges, and drives a booking to 'completed' (auto-creating the merchant payout via the confirm-return hook). Returns { bookingId, paymentId, payoutId }. */
async function createCompletedBookingWithPayout(renterCookie, merchantCookie, listingId, fixtureKey) {
  const anchor = Date.now() + 30 * 24 * 60 * 60 * 1000
  const created = await api(renterCookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: new Date(anchor).toISOString(),
    end_at: new Date(anchor + 3 * 24 * 60 * 60 * 1000).toISOString(),
    idempotency_key: `dispute-payout-create-${fixtureKey}`,
  })
  const bookingId = created.json?.booking_id
  if (!bookingId) throw new Error(`booking creation failed for ${fixtureKey}: ${JSON.stringify(created)}`)

  const acceptRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/accept`, { idempotency_key: `dispute-payout-accept-${fixtureKey}` })
  if (acceptRes.status >= 400) throw new Error(`accept failed for ${fixtureKey}: ${JSON.stringify(acceptRes)}`)

  const checkoutRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/checkout`, { test_scenario: 'success', idempotency_key: `dispute-payout-checkout-${fixtureKey}` })
  if (checkoutRes.status >= 400) throw new Error(`checkout failed for ${fixtureKey}: ${JSON.stringify(checkoutRes)}`)

  await backdateToStartable(bookingId)
  const startRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/start`, { idempotency_key: `dispute-payout-start-${fixtureKey}` })
  if (startRes.status >= 400) throw new Error(`start failed for ${fixtureKey}: ${JSON.stringify(startRes)}`)

  const returnRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/return`, { idempotency_key: `dispute-payout-return-${fixtureKey}` })
  if (returnRes.status >= 400) throw new Error(`return failed for ${fixtureKey}: ${JSON.stringify(returnRes)}`)

  const confirmRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/confirm-return`, { idempotency_key: `dispute-payout-confirm-${fixtureKey}` })
  if (confirmRes.status >= 400) throw new Error(`confirm-return failed for ${fixtureKey}: ${JSON.stringify(confirmRes)}`)

  const { data: rentalPayment } = await admin.from('payments').select('id').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').single()
  const { data: payout } = await admin.from('merchant_payouts').select('id').eq('booking_id', bookingId).single()

  return { bookingId, paymentId: rentalPayment.id, payoutId: payout.id }
}

async function openDispute(renterCookie, bookingId, fixtureKey) {
  const res = await api(renterCookie, 'POST', '/api/disputes', {
    booking_id: bookingId, title: 'Regression dispute', description: 'Dispute-payout-recovery regression fixture', requested_resolution: 'N/A',
    idempotency_key: `dispute-payout-open-${fixtureKey}`,
  })
  return res
}

async function startReviewAndResolve(adminCookie, disputeId, outcome, fixtureKey) {
  const reviewRes = await api(adminCookie, 'POST', `/api/admin/disputes/${disputeId}/start-review`, { idempotency_key: `dispute-payout-review-${fixtureKey}` })
  const resolveRes = await api(adminCookie, 'POST', `/api/admin/disputes/${disputeId}/resolve`, { outcome, resolution_notes: 'regression', idempotency_key: `dispute-payout-resolve-${fixtureKey}` })
  return { reviewRes, resolveRes }
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-dispute-payout-recovery aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { cookie: merchantACookie, userId: merchantAId } = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: renterACookie, client: renterAClient } = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: adminCookie } = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)

console.log('=== Scenario A: unresolved dispute keeps payout blocked ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — A`)
  const { bookingId, payoutId } = await createCompletedBookingWithPayout(renterACookie, merchantACookie, listingId, `a-${RUN_ID}`)
  const opened = await openDispute(renterACookie, bookingId, `a-${RUN_ID}`)
  check('A1. dispute opens successfully', opened.status === 201, opened)

  const { data: bookingAfterOpen } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('A2. booking.status flips to disputed', bookingAfterOpen.status === 'disputed', bookingAfterOpen)

  const processRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutId}/mark-processing`, { reason: 'regression A', idempotency_key: `dispute-payout-markproc-a-${RUN_ID}` })
  check('A3. mark-processing is blocked while the dispute is unresolved', processRes.status === 422, processRes)
}

console.log('=== Scenario B: favor_respondent resolution restores booking status and unlocks payout ===')
let scenarioBBookingId, scenarioBDisputeId
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — B`)
  const { bookingId, payoutId } = await createCompletedBookingWithPayout(renterACookie, merchantACookie, listingId, `b-${RUN_ID}`)
  scenarioBBookingId = bookingId
  const opened = await openDispute(renterACookie, bookingId, `b-${RUN_ID}`)
  scenarioBDisputeId = opened.json.dispute_id

  const { reviewRes, resolveRes } = await startReviewAndResolve(adminCookie, scenarioBDisputeId, 'favor_respondent', `b-${RUN_ID}`)
  check('B1. start-review succeeds', reviewRes.status === 200, reviewRes)
  check('B2. resolve succeeds and reports booking_status_restored=true', resolveRes.status === 200 && resolveRes.json?.booking_status_restored === true, resolveRes)

  const { data: bookingAfterResolve } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('B3. booking.status is restored to completed', bookingAfterResolve.status === 'completed', bookingAfterResolve)

  const { data: historyRows } = await admin.from('booking_history').select('event_type, previous_status, new_status').eq('booking_id', bookingId).eq('event_type', 'dispute_resolution_restored_status')
  check('B4. exactly one booking_history row records the restoration', historyRows?.length === 1 && historyRows[0].previous_status === 'disputed' && historyRows[0].new_status === 'completed', historyRows)

  const processRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutId}/mark-processing`, { reason: 'regression B', idempotency_key: `dispute-payout-markproc-b-${RUN_ID}` })
  check('B5. mark-processing now succeeds -- payout eligibility correctly unlocked', processRes.status === 200 && processRes.json?.status === 'processing', processRes)
}

console.log('=== Scenario C: repeated/idempotent resolve does not duplicate anything ===')
{
  const { resolveRes: replay } = await startReviewAndResolve(adminCookie, scenarioBDisputeId, 'favor_respondent', `b-${RUN_ID}`)
  check('C1. exact idempotency-key replay of resolve returns the cached result, no error', replay.status === 200 && replay.json?.dispute_id === scenarioBDisputeId, replay)

  const { data: historyRowsAfterReplay } = await admin.from('booking_history').select('id').eq('booking_id', scenarioBBookingId).eq('event_type', 'dispute_resolution_restored_status')
  check('C2. no duplicate booking_history row was created on replay', historyRowsAfterReplay?.length === 1, historyRowsAfterReplay)

  const { data: bookingStillCompleted } = await admin.from('bookings').select('status').eq('id', scenarioBBookingId).single()
  check('C3. booking.status is still completed after the replay (not double-transitioned)', bookingStillCompleted.status === 'completed', bookingStillCompleted)
}

console.log('=== Scenario D: favor_raiser resolution does NOT restore booking status -- payout stays blocked ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — D`)
  const { bookingId, payoutId } = await createCompletedBookingWithPayout(renterACookie, merchantACookie, listingId, `d-${RUN_ID}`)
  const opened = await openDispute(renterACookie, bookingId, `d-${RUN_ID}`)
  const disputeId = opened.json.dispute_id

  const { resolveRes } = await startReviewAndResolve(adminCookie, disputeId, 'favor_raiser', `d-${RUN_ID}`)
  check('D1. resolve succeeds and reports booking_status_restored=false', resolveRes.status === 200 && resolveRes.json?.booking_status_restored === false, resolveRes)

  const { data: bookingAfterResolve } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('D2. booking.status remains disputed -- never fabricated into a payout-eligible state', bookingAfterResolve.status === 'disputed', bookingAfterResolve)

  const processRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutId}/mark-processing`, { reason: 'regression D', idempotency_key: `dispute-payout-markproc-d-${RUN_ID}` })
  check('D3. mark-processing stays blocked -- customer-favorable resolution never incorrectly unlocks payout', processRes.status === 422, processRes)
}

console.log('=== Scenario E: dispute cancellation (no adjudication) restores booking status unconditionally ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — E`)
  const { bookingId, payoutId } = await createCompletedBookingWithPayout(renterACookie, merchantACookie, listingId, `e-${RUN_ID}`)
  const opened = await openDispute(renterACookie, bookingId, `e-${RUN_ID}`)
  const disputeId = opened.json.dispute_id

  const cancelRes = await api(adminCookie, 'POST', `/api/admin/disputes/${disputeId}/cancel`, { cancellation_reason: 'withdrawn, regression E', idempotency_key: `dispute-payout-cancel-e-${RUN_ID}` })
  check('E1. cancel succeeds and reports booking_status_restored=true', cancelRes.status === 200 && cancelRes.json?.booking_status_restored === true, cancelRes)

  const { data: bookingAfterCancel } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('E2. booking.status is restored to completed after cancellation', bookingAfterCancel.status === 'completed', bookingAfterCancel)

  const processRes = await api(adminCookie, 'POST', `/api/admin/payouts/${payoutId}/mark-processing`, { reason: 'regression E', idempotency_key: `dispute-payout-markproc-e-${RUN_ID}` })
  check('E3. mark-processing succeeds after a cancelled (non-adjudicated) dispute', processRes.status === 200 && processRes.json?.status === 'processing', processRes)
}

console.log('=== Scenario F: commission hold/release is keyed on disputes.status, unaffected by the booking.status fix ===')
{
  // reconcileCommissionDisputes() previously scanned only a single
  // unordered .limit(100) page, so a freshly created commission was not
  // guaranteed to be reached once the live candidate pool exceeded 100
  // rows (confirmed live, 154-164+ across this project's history). Fixed
  // by the commission-reconciliation batching/pagination corrective
  // maintenance pass (deterministic keyset pagination walking every
  // candidate exactly once per run, regardless of pool size) -- this
  // check no longer needs to tolerate or detect that condition.
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — F`)
  const anchor = Date.now() + 30 * 24 * 60 * 60 * 1000
  const created = await api(renterACookie, 'POST', '/api/bookings', { listing_id: listingId, start_at: new Date(anchor).toISOString(), end_at: new Date(anchor + 3 * 24 * 60 * 60 * 1000).toISOString(), idempotency_key: `dispute-payout-f-create-${RUN_ID}` })
  const bookingId = created.json.booking_id
  await api(merchantACookie, 'POST', `/api/bookings/${bookingId}/accept`, { idempotency_key: `dispute-payout-f-accept-${RUN_ID}` })
  await api(renterACookie, 'POST', `/api/bookings/${bookingId}/checkout`, { test_scenario: 'success', idempotency_key: `dispute-payout-f-checkout-${RUN_ID}` })
  const { data: rentalPayment } = await admin.from('payments').select('id').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').single()

  const opened = await openDispute(renterACookie, bookingId, `f-${RUN_ID}`)
  const disputeId = opened.json.dispute_id

  const sweepHeld = await fetch(APP_URL + '/api/internal/commissions/reconcile-refunds', { method: 'POST', headers: { Authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` } })
  const { data: commissionHeld } = await admin.from('unity_commissions').select('status').eq('payment_id', rentalPayment.id).single()

  check('F1. unresolved dispute holds the Unity commission (keyed on disputes.status)', sweepHeld.status === 200 && commissionHeld?.status === 'held', { sweepStatus: sweepHeld.status, commissionHeld })

  await startReviewAndResolve(adminCookie, disputeId, 'favor_respondent', `f-${RUN_ID}`)
  const sweepReleased = await fetch(APP_URL + '/api/internal/commissions/reconcile-refunds', { method: 'POST', headers: { Authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` } })
  const { data: commissionReleased } = await admin.from('unity_commissions').select('status').eq('payment_id', rentalPayment.id).single()
  check('F2. the commission is never left held after dispute resolution', sweepReleased.status === 200 && commissionReleased?.status !== 'held', { sweepStatus: sweepReleased.status, commissionReleased })

  // Cleanup: void this scenario's own commission so repeated runs of
  // this script don't keep compounding the shared sweep's candidate
  // pool for future runs.
  if (commissionHeld) {
    const { data: commissionRow } = await admin.from('unity_commissions').select('id').eq('payment_id', rentalPayment.id).single()
    await api(adminCookie, 'POST', `/api/admin/commissions/${commissionRow.id}/void`, { reason: 'verify-dispute-payout-recovery.mjs Scenario F cleanup', idempotency_key: `dispute-payout-f-cleanup-${RUN_ID}` })
  }
}

console.log('=== Scenario G: unauthorized access ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — G`)
  const { bookingId } = await createCompletedBookingWithPayout(renterACookie, merchantACookie, listingId, `g-${RUN_ID}`)
  const opened = await openDispute(renterACookie, bookingId, `g-${RUN_ID}`)
  const disputeId = opened.json.dispute_id
  await api(adminCookie, 'POST', `/api/admin/disputes/${disputeId}/start-review`, { idempotency_key: `dispute-payout-g-review-${RUN_ID}` })

  const nonAdminResolve = await api(renterACookie, 'POST', `/api/admin/disputes/${disputeId}/resolve`, { outcome: 'favor_respondent', idempotency_key: `dispute-payout-g-resolve-${RUN_ID}` })
  check('G1. a non-admin cannot resolve a dispute via the admin route', nonAdminResolve.status === 401 || nonAdminResolve.status === 403, nonAdminResolve)

  const { data: bookingUnchanged } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('G2. the unauthorized attempt did not touch booking.status', bookingUnchanged.status === 'disputed', bookingUnchanged)

  const { error: directRpcError } = await renterAClient.rpc('resolve_dispute', { p_admin_id: null, p_dispute_id: disputeId, p_outcome: 'favor_respondent' })
  check('G3. calling resolve_dispute directly (not via service role) is rejected', !!directRpcError, directRpcError)
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
