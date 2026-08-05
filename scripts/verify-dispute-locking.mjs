#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 2's Decision #4: once a
 * dispute is open on a booking/order/barter agreement, every other
 * mutating action on that transaction must be rejected -- without any
 * of those RPCs having been modified to know about disputes (the
 * freeze works because they already use exact-match/allow-list status
 * guards that simply don't include 'disputed').
 *
 * This is a real script against the live dev database, not a mocked
 * vitest test -- this codebase has never mocked Supabase RPC/RLS
 * behavior in a unit test (every other domain's status-transition and
 * security behavior is verified the same way, live, via scripts like
 * this one and scripts/qa-seed.mjs). Re-run this any time a future
 * phase (payments, payouts, barter financials) touches
 * accept/cancel/ship/return-style RPCs, to confirm the freeze still
 * holds.
 *
 * Safely re-runnable: each fixture transaction is created with a FIXED
 * idempotency key, so re-running replays the same booking/order/
 * agreement instead of creating duplicates. Opening a dispute
 * permanently locks a transaction (Step 11 Phase 2's own documented
 * limitation -- there is no "un-dispute" RPC), so on a second run this
 * script detects the already-open dispute and re-verifies the lock
 * rather than trying to open a second one.
 *
 * SAFETY: same gate as scripts/qa-seed.mjs -- refuses to run unless
 * QA_SEED_ENABLED=true, QA_SEED_CONFIRM=UNITY_DEV_ONLY, and
 * QA_SEED_PROJECT_REF matches the live project.
 *
 * Usage: node scripts/verify-dispute-locking.mjs
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
    console.error('verify-dispute-locking aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-dispute-locking.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-dispute-locking aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
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

async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    daily_rate: 150, min_rental_days: 1, deposit_required: false, status: 'draft',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

// No route can move calendar time backward -- same documented exception as qa-seed.mjs's own backdateToStartable.
async function backdateToStartable(bookingId, attempt = 1) {
  const slideDays = 3 * attempt
  const windowStart = Date.now() - slideDays * 24 * 60 * 60 * 1000
  const { error } = await admin.from('bookings').update({
    start_at: new Date(windowStart).toISOString(),
    end_at: new Date(windowStart + 3 * 24 * 60 * 60 * 1000).toISOString(),
  }).eq('id', bookingId)
  if (error) {
    if (error.message.includes('exclusion constraint') && attempt < 8) return backdateToStartable(bookingId, attempt + 1)
    throw new Error(`backdateToStartable failed: ${error.message}`)
  }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

async function openOrReuseDispute(cookie, body, transactionTable, transactionId, idempotencyKey) {
  const { data: existing } = await admin
    .from('disputes')
    .select('id, status')
    .eq(`${transactionTable}_id`, transactionId)
    .not('status', 'in', '(resolved,closed,cancelled)')
    .maybeSingle()
  if (existing) return existing.id

  const res = await api(cookie, 'POST', '/api/disputes', { ...body, idempotency_key: idempotencyKey })
  if (res.status !== 201) throw new Error(`open_dispute failed: ${JSON.stringify(res)}`)
  return res.json.dispute_id
}

// ── Load QA accounts (must already exist -- run scripts/qa-seed.mjs first if not) ──
// Passwords come from .qa-credentials.local.json (gitignored, written by
// qa-seed.mjs) -- never hardcoded, never printed.
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-dispute-locking aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
function findUser(email) {
  const u = authUsers.users.find((x) => x.email === email)
  if (!u) throw new Error(`QA account ${email} not found -- run scripts/qa-seed.mjs first`)
  return u
}
const merchantA = findUser(creds.accounts.merchantA.email)
const merchantB = findUser(creds.accounts.merchantB.email)
findUser(creds.accounts.renterA.email) // fail fast if the account is missing, even though only its cookie is needed below

const { cookie: renterACookie } = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: merchantACookie } = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: merchantBCookie } = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)

console.log('=== BOOKING: open dispute -> attempt cancel -> attempt return -> both rejected ===')
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Dispute-Lock Regression — Booking`,
    description: 'Permanent regression fixture for verify-dispute-locking.mjs — do not delete.',
    daily_rate: 100, status: 'active',
  })

  // Fixed absolute dates, not Date.now()-relative -- paired with a fixed
  // idempotency key, the request body must be byte-identical on every
  // re-run or the idempotency hash check itself will reject the replay
  // with a 409 (a mistake caught while first re-running this script).
  const created = await api(renterACookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: '2030-06-01T00:00:00.000Z',
    end_at: '2030-06-04T00:00:00.000Z',
    idempotency_key: 'dispute-lock-regression-booking-create-v2',
  })
  const bookingId = created.json?.booking_id
  check('booking fixture created/replayed', !!bookingId, created)
  if (!bookingId) throw new Error(`cannot continue without a booking id: ${JSON.stringify(created)}`)

  await api(merchantACookie, 'POST', `/api/bookings/${bookingId}/accept`, { idempotency_key: 'dispute-lock-regression-booking-accept-v2' })
  await api(renterACookie, 'POST', `/api/bookings/${bookingId}/checkout`, { test_scenario: 'success', idempotency_key: 'dispute-lock-regression-booking-checkout-v2' })
  const { data: bookingBeforeStart } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  if (bookingBeforeStart.status === 'accepted') {
    await backdateToStartable(bookingId)
    await api(renterACookie, 'POST', `/api/bookings/${bookingId}/start`, { idempotency_key: 'dispute-lock-regression-booking-start-v2' })
  }

  const disputeId = await openOrReuseDispute(
    renterACookie,
    { booking_id: bookingId, title: 'Regression fixture dispute', description: 'Permanent regression fixture.', requested_resolution: 'n/a' },
    'booking', bookingId, 'dispute-lock-regression-booking-dispute-v2'
  )
  check('dispute exists for the booking fixture', !!disputeId)

  const { data: booking } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('booking.status = disputed', booking.status === 'disputed', booking)

  const cancelRes = await api(renterACookie, 'POST', `/api/bookings/${bookingId}/cancel`, { idempotency_key: `dispute-lock-regression-booking-cancel-${Date.now()}` })
  check('cancel rejected while disputed', cancelRes.status >= 400, cancelRes)

  const returnRes = await api(renterACookie, 'POST', `/api/bookings/${bookingId}/return`, { idempotency_key: `dispute-lock-regression-booking-return-${Date.now()}` })
  check('return (the "complete" analog) rejected while disputed', returnRes.status >= 400, returnRes)
}

console.log('\n=== ORDER: open dispute -> attempt cancel -> attempt ship -> both rejected ===')
{
  const listingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Dispute-Lock Regression — Order`,
    description: 'Permanent regression fixture for verify-dispute-locking.mjs — do not delete.',
    category: 'tools', listing_type: 'sale', daily_rate: null, sale_price: 500, quantity_available: 99, status: 'active',
  })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: 'dispute-lock-regression-order-create' })
  const orderId = created.json?.order_id
  check('order fixture created/replayed', !!orderId, created)

  await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: 'dispute-lock-regression-order-checkout' })

  const disputeId = await openOrReuseDispute(
    renterACookie,
    { order_id: orderId, title: 'Regression fixture dispute', description: 'Permanent regression fixture.', requested_resolution: 'n/a' },
    'order', orderId, 'dispute-lock-regression-order-dispute'
  )
  check('dispute exists for the order fixture', !!disputeId)

  const { data: order } = await admin.from('orders').select('status').eq('id', orderId).single()
  check('order.status = disputed', order.status === 'disputed', order)

  const cancelRes = await api(renterACookie, 'POST', `/api/orders/${orderId}/cancel`, { idempotency_key: `dispute-lock-regression-order-cancel-${Date.now()}` })
  check('cancel rejected while disputed', cancelRes.status >= 400, cancelRes)

  const shipRes = await api(merchantACookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: `dispute-lock-regression-order-ship-${Date.now()}` })
  check('ship (the "complete" analog) rejected while disputed', shipRes.status >= 400, shipRes)
}

console.log('\n=== BARTER: open dispute -> attempt cancel -> attempt reject -> both rejected ===')
{
  const listingAId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Dispute-Lock Regression — Barter A`,
    description: 'Permanent regression fixture for verify-dispute-locking.mjs — do not delete.',
    category: 'music', daily_rate: 80, status: 'active',
  })
  const listingBId = await insertBaseListing(merchantB.id, {
    title: `${QA_LISTING_MARKER} Dispute-Lock Regression — Barter B`,
    description: 'Permanent regression fixture for verify-dispute-locking.mjs — do not delete.',
    category: 'outdoor', daily_rate: 60, status: 'active',
  })

  const proposed = await api(merchantBCookie, 'POST', '/api/barter', {
    anchor_listing_id: listingAId,
    party_a_listing_ids: [listingAId],
    party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person',
    message: 'Dispute-lock regression fixture',
    idempotency_key: 'dispute-lock-regression-barter-propose',
  })
  let agreementId = proposed.json?.agreement_id

  if (!agreementId) {
    // Already accepted/disputed from a prior run -- find it directly.
    const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', listingAId).maybeSingle()
    agreementId = existing?.id
  }
  check('barter fixture agreement exists', !!agreementId, proposed)

  await api(merchantACookie, 'POST', `/api/barter/${agreementId}/accept`, { idempotency_key: 'dispute-lock-regression-barter-accept' })

  const disputeId = await openOrReuseDispute(
    merchantACookie,
    { barter_agreement_id: agreementId, title: 'Regression fixture dispute', description: 'Permanent regression fixture.', requested_resolution: 'n/a' },
    'barter_agreement', agreementId, 'dispute-lock-regression-barter-dispute'
  )
  check('dispute exists for the barter fixture', !!disputeId)

  const { data: agreement } = await admin.from('barter_agreements').select('status').eq('id', agreementId).single()
  check('barter_agreements.status = disputed', agreement.status === 'disputed', agreement)

  const cancelRes = await api(merchantACookie, 'POST', `/api/barter/${agreementId}/cancel`, { idempotency_key: `dispute-lock-regression-barter-cancel-${Date.now()}` })
  check('cancel rejected while disputed', cancelRes.status >= 400, cancelRes)

  const rejectRes = await api(merchantACookie, 'POST', `/api/barter/${agreementId}/reject`, { idempotency_key: `dispute-lock-regression-barter-reject-${Date.now()}` })
  check('reject (the "complete" analog -- already accepted, no longer rejectable) rejected while disputed', rejectRes.status >= 400, rejectRes)
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
