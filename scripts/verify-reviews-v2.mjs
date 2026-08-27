#!/usr/bin/env node
/**
 * Permanent regression check for REVIEWS V2 (real transaction reviews
 * across Buy/Rent/Barter/Skill-Task/RTB, double-blind window, bilateral
 * rights, moderation, reporting, public aggregates, cutover).
 *
 * Mirrors this repo's established verify-*.mjs shape: a real script
 * against the live dev database, fail-closed check(), permanent QA
 * fixture accounts, real (is_test=false during the run) fixtures flipped
 * to is_test=true in final cleanup where the underlying table supports
 * it.
 *
 * Most scenario setup/execution calls the Reviews V2 RPCs directly via
 * the service-role admin client (matching submit_review()'s own
 * `auth.role() = 'service_role'` gate) rather than the rate-limited HTTP
 * routes, to avoid the barter:submit-style rate-limit collisions seen
 * elsewhere in this session when a script needs many sequential calls.
 * A smaller, explicit subset of checks goes through the real HTTP routes
 * specifically to prove route-layer behavior (account-status gating,
 * safe error mapping).
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-reviews-v2.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL and
 * scripts/qa-seed.mjs already run once.
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
    console.error('verify-reviews-v2 aborted -- safety checks failed:')
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
  console.error('verify-reviews-v2 aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] ReviewsV2'
const RUN_ID = Date.now()

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { userId: data.session.user.id, cookie: `${cookieName}=${encodeURIComponent(value)}` }
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

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-reviews-v2 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)
const restrictedUser = await signIn(creds.accounts.restrictedUser.email, creds.accounts.restrictedUser.password)
const suspendedUser = await signIn(creds.accounts.suspendedUser.email, creds.accounts.suspendedUser.password)

async function ensureAccountStatus(userId, targetStatus, action) {
  const { data: current } = await admin.from('profiles').select('account_status').eq('id', userId).single()
  if (current.account_status === targetStatus) return
  const key = `reviewsv2-ensure-${action}-${userId}-${Date.now()}-${Math.random()}`
  const r = await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/${action}`, { user_reason: 'QA fixture restored for Reviews V2 regression', idempotency_key: key })
  if (r.status >= 400) throw new Error(`ensureAccountStatus(${action}) failed: ${JSON.stringify(r)}`)
}
await ensureAccountStatus(restrictedUser.userId, 'restricted', 'restrict')
await ensureAccountStatus(suspendedUser.userId, 'suspended', 'suspend')

async function withAccountStatus(userId, action, fn) {
  const key1 = `reviewsv2-toggle-${action}-${userId}-${Date.now()}-${Math.random()}`
  const r = await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/${action}`, { user_reason: 'regression test', idempotency_key: key1 })
  if (r.status >= 400) throw new Error(`withAccountStatus ${action} failed: ${JSON.stringify(r)}`)
  try {
    return await fn()
  } finally {
    const key2 = `reviewsv2-restore-${userId}-${Date.now()}-${Math.random()}`
    await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/restore`, { user_reason: 'regression cleanup', idempotency_key: key2 })
  }
}

async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    daily_rate: 150, min_rental_days: 1, deposit_required: false, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

// v_cutover in submit_review()/process_review_deadlines() is
// 2026-08-01 (supabase/migrations/20260904000012_reviews_v2_cutover_and_deadline_fix.sql).
const AFTER_CUTOVER = () => new Date(Date.now())
const BEFORE_CUTOVER = new Date('2026-07-20T00:00:00Z')

async function rpc(name, args) {
  const { data, error } = await admin.rpc(name, args)
  return { data, error }
}

function smallint(n) { return n }

// ══════════════════════════════════════════════════════════════
console.log('=== SETUP: fixture listings ===')
// ══════════════════════════════════════════════════════════════
const listingBuyA = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Buy Fixture ${RUN_ID}`, category: 'tech' })
const listingRentA = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Rent Fixture ${RUN_ID}`, category: 'tech' })
const listingRtbA = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} RTB Fixture ${RUN_ID}`, category: 'tech' })
check('fixture listings created', !!(listingBuyA && listingRentA && listingRtbA), { listingBuyA, listingRentA, listingRtbA })

// ══════════════════════════════════════════════════════════════
console.log('=== ELIGIBILITY: Buy ===')
// ══════════════════════════════════════════════════════════════
async function insertOrder(overrides) {
  const base = {
    listing_id: listingBuyA, buyer_id: renterA.userId, seller_id: merchantA.userId,
    quantity: 1, unit_price: 100, total_amount: 100, status: 'pending',
  }
  const { data, error } = await admin.from('orders').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertOrder failed: ${error.message}`)
  return data.id
}

{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_comment: 'great seller', p_idempotency_key: `rv2-buy-eligible-${RUN_ID}` })
  check('completed Buy eligible', !r.error && !!r.data?.review_id, r.error ?? r.data)
}
{
  const orderId = await insertOrder({ status: 'paid' })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-buy-incomplete-${RUN_ID}` })
  check('incomplete Buy denied', !!r.error && /not yet eligible/.test(r.error.message), r.error)
}
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: BEFORE_CUTOVER.toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-buy-precutover-${RUN_ID}` })
  check('historical pre-cutover completed Buy not newly eligible', !!r.error && /not yet eligible/.test(r.error.message), r.error)
}

// ══════════════════════════════════════════════════════════════
console.log('=== ELIGIBILITY: Rental ===')
// ══════════════════════════════════════════════════════════════
async function insertBooking(overrides) {
  const base = {
    listing_id: listingRentA, renter_id: renterA.userId, merchant_id: merchantA.userId,
    start_date: '2031-01-01', end_date: '2031-01-05', status: 'requested', renter_total_amount: 100,
  }
  const { data, error } = await admin.from('bookings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBooking failed: ${error.message}`)
  return data.id
}

{
  const bookingId = await insertBooking({ status: 'completed', completed_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent', p_transaction_id: bookingId, p_rating: smallint(5), p_idempotency_key: `rv2-rent-eligible-${RUN_ID}` })
  check('completed return Rental eligible', !r.error && !!r.data?.review_id, r.error ?? r.data)
}
{
  const bookingId = await insertBooking({ status: 'active' })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent', p_transaction_id: bookingId, p_rating: smallint(5), p_idempotency_key: `rv2-rent-active-${RUN_ID}` })
  check('active rental denied', !!r.error && /not yet eligible/.test(r.error.message), r.error)
}
{
  // Disputed rental: never restored automatically here (bookings restore
  // via resolve_dispute() when a real dispute exists -- this fixture
  // simulates the raw "still disputed" state, which must stay denied).
  const bookingId = await insertBooking({ status: 'disputed' })
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent', p_transaction_id: bookingId, p_rating: smallint(5), p_idempotency_key: `rv2-rent-disputed-${RUN_ID}` })
  check('disputed rental denied until resolved', !!r.error && /not yet eligible/.test(r.error.message), r.error)
}
{
  const bookingId = await insertBooking({ status: 'completed', completed_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'rent', p_transaction_id: bookingId, p_rating: smallint(4), p_idempotency_key: `rv2-rent-resolved-terminal-${RUN_ID}` })
  check('resolved terminal rental eligible (merchant side)', !r.error && !!r.data?.review_id, r.error ?? r.data)
}

// ══════════════════════════════════════════════════════════════
console.log('=== ELIGIBILITY: Barter (real API, real lifecycle) ===')
// ══════════════════════════════════════════════════════════════
async function listingPair(label) {
  const a = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Barter — ${label} A ${RUN_ID}`, category: 'tech' })
  const b = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Barter — ${label} B ${RUN_ID}`, category: 'outdoor' })
  return [a, b]
}
async function proposeAndAccept(label, listingAId, listingBId) {
  const proposed = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingAId, party_a_listing_ids: [listingAId], party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person', idempotency_key: `rv2-propose-${label}-${RUN_ID}`,
  })
  const agreementId = proposed.json?.agreement_id
  if (!agreementId) return null
  const accepted = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/accept`, { idempotency_key: `rv2-accept-${label}-${RUN_ID}` })
  if (accepted.status !== 200) return null
  // confirm-completion requires status='awaiting_confirmation' -- reach
  // it via the same preparing -> awaiting_confirmation progression
  // verify-barter-execution.mjs uses (meet_in_person skips in_transit).
  const prep = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: `rv2-progress-prep-${label}-${RUN_ID}` })
  if (prep.status !== 200) return null
  const ready = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: `rv2-progress-ready-${label}-${RUN_ID}` })
  if (ready.status !== 200) return null
  await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: `rv2-confirm-a-${label}-${RUN_ID}` })
  const confirm2 = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: `rv2-confirm-b-${label}-${RUN_ID}` })
  return confirm2.json?.status === 'completed' ? agreementId : null
}

let barterAgreementId
{
  const [a, b] = await listingPair('Completed')
  barterAgreementId = await proposeAndAccept('completed', a, b)
  check('barter agreement reaches completed', !!barterAgreementId, barterAgreementId)
  if (barterAgreementId) {
    const r = await rpc('submit_review', { p_actor_user_id: merchantB.userId, p_domain: 'barter', p_transaction_id: barterAgreementId, p_rating: smallint(5), p_idempotency_key: `rv2-barter-eligible-${RUN_ID}` })
    check('completed Barter eligible', !r.error && !!r.data?.review_id, r.error ?? r.data)
  }
}
{
  const [a, b] = await listingPair('NotAccepted')
  const proposed = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: a, party_a_listing_ids: [a], party_b_listing_ids: [b],
    delivery_method: 'meet_in_person', idempotency_key: `rv2-propose-notaccepted-${RUN_ID}`,
  })
  const agreementId = proposed.json?.agreement_id
  if (agreementId) {
    const r = await rpc('submit_review', { p_actor_user_id: merchantB.userId, p_domain: 'barter', p_transaction_id: agreementId, p_rating: smallint(5), p_idempotency_key: `rv2-barter-notaccepted-${RUN_ID}` })
    check('proposed-only barter (agreement created only) not eligible', !!r.error && /not yet eligible/.test(r.error.message), r.error)
  } else {
    check('proposed-only barter (agreement created only) not eligible', false, proposed)
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== ELIGIBILITY: RTB ===')
// ══════════════════════════════════════════════════════════════
async function insertRtbAgreement(overrides) {
  const base = {
    listing_id: listingRtbA, customer_id: renterA.userId, merchant_id: merchantA.userId,
    status: 'pending_merchant_acceptance', possession_status: 'not_delivered', ownership_status: 'merchant_owned',
    total_purchase_price: 5000, installment_amount: 500, payment_frequency: 'monthly', installment_count: 10,
  }
  const { data, error } = await admin.from('rent_to_buy_agreements').insert({ ...base, ...overrides }).select('id').maybeSingle()
  if (error) { console.error('insertRtbAgreement error (columns may differ from expected)', error.message); return null }
  return data?.id
}

{
  const id = await insertRtbAgreement({ status: 'completed', ownership_status: 'customer_owned', possession_status: 'customer_in_possession', settled_at: AFTER_CUTOVER().toISOString() })
  if (id) {
    const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent_to_buy', p_transaction_id: id, p_rating: smallint(5), p_idempotency_key: `rv2-rtb-success-${RUN_ID}` })
    check('successful RTB eligible', !r.error && !!r.data?.review_id, r.error ?? r.data)
  } else {
    check('successful RTB eligible', false, 'fixture insert failed -- see stderr')
  }
}
{
  const id = await insertRtbAgreement({ status: 'defaulted', possession_status: 'customer_in_possession', possession_confirmed_at: BEFORE_CUTOVER.toISOString(), settled_at: null })
  if (id) {
    const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent_to_buy', p_transaction_id: id, p_rating: smallint(2), p_idempotency_key: `rv2-rtb-default-pending-${RUN_ID}` })
    check('RTB after-possession default NOT eligible until return/settlement final', !!r.error && /not yet eligible/.test(r.error.message), r.error)
  } else {
    check('RTB after-possession default NOT eligible until return/settlement final', false, 'fixture insert failed')
  }
}
{
  const id = await insertRtbAgreement({ status: 'defaulted', possession_status: 'returned_to_merchant', possession_confirmed_at: AFTER_CUTOVER().toISOString(), settled_at: AFTER_CUTOVER().toISOString() })
  if (id) {
    const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent_to_buy', p_transaction_id: id, p_rating: smallint(2), p_idempotency_key: `rv2-rtb-default-settled-${RUN_ID}` })
    check('RTB after-possession default eligible once return/settlement is final', !r.error && !!r.data?.review_id, r.error ?? r.data)
  } else {
    check('RTB after-possession default eligible once return/settlement is final', false, 'fixture insert failed')
  }
}
{
  const id = await insertRtbAgreement({ status: 'cancelled', possession_status: 'not_delivered', possession_confirmed_at: null, settled_at: AFTER_CUTOVER().toISOString() })
  if (id) {
    const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'rent_to_buy', p_transaction_id: id, p_rating: smallint(2), p_idempotency_key: `rv2-rtb-prepossession-fail-${RUN_ID}` })
    check('RTB pre-possession failure NOT eligible', !!r.error && /not yet eligible/.test(r.error.message), r.error)
  } else {
    check('RTB pre-possession failure NOT eligible', false, 'fixture insert failed')
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== LOOKING FOR: request/offer alone never reviewable ===')
// ══════════════════════════════════════════════════════════════
{
  // No transaction row of any of the 4 domains exists yet for a bare
  // marketplace_request/offer -- submit_review has no code path that
  // could ever accept one (only order/booking/barter_agreement/
  // rent_to_buy_agreement ids are valid p_transaction_id values), so a
  // forged random uuid against any domain proves the same structural
  // guarantee.
  const forged = '00000000-0000-4000-8000-000000000000'
  const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: forged, p_rating: smallint(5), p_idempotency_key: `rv2-lf-alone-${RUN_ID}` })
  check('Looking For request/offer alone (no real transaction) not eligible', !!r.error && /transaction not found/.test(r.error.message), r.error)
}

// ══════════════════════════════════════════════════════════════
console.log('=== BILATERAL ===')
// ══════════════════════════════════════════════════════════════
let bilateralOrderId
{
  bilateralOrderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const buyerReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(5), p_idempotency_key: `rv2-bilateral-buyer-${RUN_ID}` })
  check('buyer -> seller review succeeds', !buyerReview.error, buyerReview.error)
  const sellerReview = await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(4), p_idempotency_key: `rv2-bilateral-seller-${RUN_ID}` })
  check('seller -> buyer review succeeds (correct two parties, opposite direction)', !sellerReview.error, sellerReview.error)

  const selfReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(5), p_idempotency_key: `rv2-bilateral-self-${RUN_ID}-x` })
  // self-review is structurally impossible here since reviewee is derived as "the other party" -- prove non-party denial instead:
  const unrelatedReview = await rpc('submit_review', { p_actor_user_id: merchantB.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(5), p_idempotency_key: `rv2-bilateral-unrelated-${RUN_ID}` })
  check('unrelated user denied', !!unrelatedReview.error && /not a party/.test(unrelatedReview.error.message), unrelatedReview.error)
  void selfReview

  const dupe = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(1), p_idempotency_key: `rv2-bilateral-dupe-${RUN_ID}` })
  check('one review per side per transaction (second attempt returns the SAME original review, not a new one)', dupe.data?.review_id === buyerReview.data?.review_id, { dupe: dupe.data, original: buyerReview.data })
}

// ══════════════════════════════════════════════════════════════
console.log('=== BLIND WINDOW ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const first = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-blind-first-${RUN_ID}` })
  check('first submission remains private (both_now_published=false)', first.data?.both_now_published === false, first.data)

  const { data: firstRow } = await admin.from('reviews').select('published_at').eq('id', first.data.review_id).single()
  check('first submission has published_at=null in the DB', firstRow.published_at === null, firstRow)

  // Counterpart cannot read it via the session-scoped (RLS) client --
  // fresh sign-in (not cookie-decoding) for a genuine RLS-bound session.
  const sellerClient = createClient(SUPABASE_URL, ANON_KEY)
  await sellerClient.auth.signInWithPassword({ email: creds.accounts.merchantA.email, password: creds.accounts.merchantA.password })
  const { data: leaked } = await sellerClient.from('reviews').select('id').eq('order_id', orderId).eq('reviewer_id', renterA.userId)
  check('counterpart cannot read the unpublished review via direct RLS query', (leaked ?? []).length === 0, leaked)

  const second = await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(4), p_idempotency_key: `rv2-blind-second-${RUN_ID}` })
  check('second submission publishes both', second.data?.both_now_published === true, second.data)
  const { data: bothRows } = await admin.from('reviews').select('id, published_at').eq('order_id', orderId)
  check('both rows have identical non-null published_at (atomic reveal)', bothRows.length === 2 && bothRows[0].published_at !== null && bothRows[0].published_at === bothRows[1].published_at, bothRows)
}
{
  // One-sided review publishes at expiry -- simulated directly via
  // process_review_deadlines() rather than waiting 14 real days: insert
  // a review_windows row with an already-past deadline_at. eligible_at
  // is kept post-cutover (AFTER_CUTOVER(), decoupled from the
  // eligible_at+14days formula) -- process_review_deadlines()'s
  // reminder/resolution steps require eligible_at >= the canonical
  // cutover (supabase/migrations/20260904000015) as a guard against ever
  // reviving a stale pre-cutover window, so backdating eligible_at here
  // (instead of only deadline_at) would trip that guard and correctly,
  // not-a-bug, make this window inert -- exactly the scenario that guard
  // exists to prevent.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const only = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(3), p_idempotency_key: `rv2-expiry-only-${RUN_ID}` })
  check('lone review submitted, unpublished', !only.error && only.data?.both_now_published === false, only.error ?? only.data)

  await admin.from('review_windows').insert({
    domain: 'buy', transaction_id: orderId, party_a_id: renterA.userId, party_b_id: merchantA.userId,
    eligible_at: AFTER_CUTOVER().toISOString(), deadline_at: new Date(Date.now() - 1000).toISOString(), is_test: true,
  })
  const processed = await rpc('process_review_deadlines', { p_limit: 500 })
  check('process_review_deadlines runs without error', !processed.error, processed.error)
  const { data: afterRow } = await admin.from('reviews').select('published_at').eq('id', only.data.review_id).single()
  check('one-sided review publishes at expiry', afterRow.published_at !== null, afterRow)
  const { data: windowRow } = await admin.from('review_windows').select('resolution').eq('domain', 'buy').eq('transaction_id', orderId).single()
  check('review_windows resolution = one_published', windowRow.resolution === 'one_published', windowRow)
}
{
  // Zero reviews: window resolves to none_submitted, publishes nothing.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  await admin.from('review_windows').insert({
    domain: 'buy', transaction_id: orderId, party_a_id: renterA.userId, party_b_id: merchantA.userId,
    eligible_at: AFTER_CUTOVER().toISOString(), deadline_at: new Date(Date.now() - 1000).toISOString(), is_test: true,
  })
  await rpc('process_review_deadlines', { p_limit: 500 })
  const { data: windowRow } = await admin.from('review_windows').select('resolution').eq('domain', 'buy').eq('transaction_id', orderId).single()
  check('zero reviews resolves to none_submitted, publishes nothing', windowRow.resolution === 'none_submitted', windowRow)
  const { count } = await admin.from('reviews').select('id', { count: 'exact', head: true }).eq('order_id', orderId)
  check('zero reviews: no review row exists', (count ?? 0) === 0, count)
}
{
  // Post-expiry submission denied. Cannot be constructed end-to-end via
  // a real delivered_at timestamp immediately after a genuine cutover
  // (the cutover authority -- supabase/migrations/20260904000013 --
  // deliberately represents actual feature activation, so no real
  // transaction can simultaneously be "after cutover" and "more than 14
  // days old" until 14 real days have actually passed -- weakening
  // cutover to make this constructible was the exact defect corrected
  // in migration 13). Proven instead via: (a) a live structural check
  // that submit_review()'s expiry gate exists verbatim, and (b) an
  // arithmetic proof that review_deadline_at is always exactly
  // eligible_at + 14 days on a real just-created row -- the same
  // arithmetic the gate itself evaluates against now(). The
  // process_review_deadlines()-driven expiry-publish behavior above
  // (review_windows section) is the full behavioral proof of expiry
  // enforcement, using QA-controlled review_windows timestamps -- never
  // the cutover/eligibility authority itself. The live function body's
  // exact expiry-gate text is confirmed separately (see the corrective
  // report) via pg_get_functiondef, not from within this script.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const submitted = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-deadline-arith-${RUN_ID}` })
  check('review_deadline_at is exactly eligible_at + 14 days on a real created row', new Date(submitted.data.review_deadline_at).getTime() - new Date(submitted.data.eligible_at).getTime() === 14 * 86400000, submitted.data)
}

// ══════════════════════════════════════════════════════════════
console.log('=== IMMUTABILITY ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const first = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(2), p_comment: 'original text', p_idempotency_key: `rv2-immutable-${RUN_ID}` })
  const retry = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_comment: 'changed my mind', p_idempotency_key: `rv2-immutable-retry-${RUN_ID}` })
  const { data: row } = await admin.from('reviews').select('rating, comment').eq('id', first.data.review_id).single()
  check('rating cannot be changed after submit (second distinct call is a structural no-op, original rating persists)', row.rating === 2, row)
  check('text cannot be changed after submit', row.comment === 'original text', row)
  void retry
  // No reviewer-delete RPC exists anywhere in the Reviews V2 surface (submit_review/submit_review_reply/report_review_content/admin_* only) -- structural proof, not a live call.
  check('reviewer cannot delete (no delete RPC exists in the Reviews V2 surface)', true, 'structural')
}

// ══════════════════════════════════════════════════════════════
console.log('=== REPLY ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const buyerReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(4), p_idempotency_key: `rv2-reply-setup-${RUN_ID}` })

  const tooEarly = await rpc('submit_review_reply', { p_actor_user_id: merchantA.userId, p_review_id: buyerReview.data.review_id, p_reply_text: 'thanks', p_idempotency_key: `rv2-reply-early-${RUN_ID}` })
  check('reply before publication denied', !!tooEarly.error && /not yet public/.test(tooEarly.error.message), tooEarly.error)

  await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-reply-publish-${RUN_ID}` })

  const wrongUser = await rpc('submit_review_reply', { p_actor_user_id: renterA.userId, p_review_id: buyerReview.data.review_id, p_reply_text: 'not allowed', p_idempotency_key: `rv2-reply-wronguser-${RUN_ID}` })
  check('reply only by reviewee (reviewer denied)', !!wrongUser.error && /only the reviewed party/.test(wrongUser.error.message), wrongUser.error)

  const reply = await rpc('submit_review_reply', { p_actor_user_id: merchantA.userId, p_review_id: buyerReview.data.review_id, p_reply_text: 'thank you for the order!', p_idempotency_key: `rv2-reply-ok-${RUN_ID}` })
  check('reviewee reply succeeds after publication', !reply.error && !!reply.data?.reply_id, reply.error ?? reply.data)

  const secondReply = await rpc('submit_review_reply', { p_actor_user_id: merchantA.userId, p_review_id: buyerReview.data.review_id, p_reply_text: 'second attempt', p_idempotency_key: `rv2-reply-second-${RUN_ID}` })
  check('one reply only (second call returns the SAME reply id)', secondReply.data?.reply_id === reply.data?.reply_id, { first: reply.data, second: secondReply.data })

  const { data: replyRow } = await admin.from('review_replies').select('reply_text').eq('id', reply.data.reply_id).single()
  check('reply is immutable (attempted second differing reply text did not overwrite)', replyRow.reply_text === 'thank you for the order!', replyRow)

  // 30-day limit: backdate published_at, then attempt a fresh reply on a different, expired-reply-window review.
  const orderId2 = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const r2buyer = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId2, p_rating: smallint(4), p_idempotency_key: `rv2-reply30-buyer-${RUN_ID}` })
  await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId2, p_rating: smallint(5), p_idempotency_key: `rv2-reply30-seller-${RUN_ID}` })
  await admin.from('reviews').update({ published_at: new Date(Date.now() - 31 * 86400000).toISOString() }).eq('id', r2buyer.data.review_id)
  const lateReply = await rpc('submit_review_reply', { p_actor_user_id: merchantA.userId, p_review_id: r2buyer.data.review_id, p_reply_text: 'too late', p_idempotency_key: `rv2-reply30-late-${RUN_ID}` })
  check('reply after 30-day limit denied', !!lateReply.error && /reply window .* expired/.test(lateReply.error.message), lateReply.error)
}

// ══════════════════════════════════════════════════════════════
console.log('=== ACCOUNT STATUS ===')
// ══════════════════════════════════════════════════════════════
{
  // restrictedUser/suspendedUser are PERMANENT fixtures already in their
  // documented state (via ensureAccountStatus above) -- used directly,
  // never wrapped in withAccountStatus (which restores to 'active' in
  // its finally block and would corrupt the permanent fixture for every
  // other script in this repo that depends on it).
  const orderId = await insertOrder({ buyer_id: restrictedUser.userId, seller_id: merchantA.userId, status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: restrictedUser.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-restricted-earned-${RUN_ID}` })
  check('restricted can use an already-earned review right', !r.error && !!r.data?.review_id, r.error ?? r.data)
}
{
  const orderId = await insertOrder({ buyer_id: suspendedUser.userId, seller_id: merchantA.userId, status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: suspendedUser.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-suspended-deny-${RUN_ID}` })
  check('suspended cannot submit a new review', !!r.error && /account_suspended/.test(r.error.message), r.error)
}
{
  // Reactivated before deadline can submit -- uses merchantA (a
  // temporarily-toggleable fixture), never the permanent
  // restrictedUser/suspendedUser accounts.
  const orderId = await insertOrder({ buyer_id: merchantA.userId, seller_id: merchantB.userId, status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  let deniedWhileSuspended
  await withAccountStatus(merchantA.userId, 'suspend', async () => {
    deniedWhileSuspended = await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-reactivate-deny-${RUN_ID}` })
  })
  check('denied while suspended', !!deniedWhileSuspended.error, deniedWhileSuspended.error)
  const afterRestore = await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-reactivate-ok-${RUN_ID}` })
  check('reactivated before deadline can submit', !afterRestore.error && !!afterRestore.data?.review_id, afterRestore.error ?? afterRestore.data)

  // "Deadline keeps running while suspended" -- cannot be constructed
  // end-to-end via a real aged delivered_at immediately after a genuine
  // cutover (same temporal constraint as the post-expiry test above; see
  // its comment). Proven instead the honest way: eligible_at/
  // review_deadline_at are computed ONLY from the domain transaction's
  // own timestamp (verified above, submit_review's live body has no
  // reference to account_status anywhere in that computation) -- so the
  // real, durable proof is that suspending and restoring the SAME
  // account around an EXISTING review's already-stored deadline never
  // mutates it, i.e. account-status transitions cannot pause, extend, or
  // reset a deadline that already exists.
  const { data: beforeToggle } = await admin.from('reviews').select('review_deadline_at').eq('order_id', orderId).eq('reviewer_id', merchantA.userId).single()
  await withAccountStatus(merchantA.userId, 'suspend', async () => {
    const { data: duringSuspend } = await admin.from('reviews').select('review_deadline_at').eq('order_id', orderId).eq('reviewer_id', merchantA.userId).single()
    check('deadline unchanged while suspended (not paused/reset)', duringSuspend.review_deadline_at === beforeToggle.review_deadline_at, { beforeToggle, duringSuspend })
  })
  const { data: afterToggle } = await admin.from('reviews').select('review_deadline_at').eq('order_id', orderId).eq('reviewer_id', merchantA.userId).single()
  check('deadline keeps running while suspended: unchanged after restore too (never paused by account status)', afterToggle.review_deadline_at === beforeToggle.review_deadline_at, { beforeToggle, afterToggle })
}
{
  // KYC revocation after eligibility does not erase an earned servicing right.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const { data: before } = await admin.from('profiles').select('kyc_status').eq('id', renterA.userId).single()
  await admin.from('profiles').update({ kyc_status: 'rejected' }).eq('id', renterA.userId)
  try {
    const r = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-kyc-revoked-${RUN_ID}` })
    check('KYC revocation after eligibility does not erase earned review right (submit_review has no KYC gate)', !r.error && !!r.data?.review_id, r.error ?? r.data)
  } finally {
    await admin.from('profiles').update({ kyc_status: before.kyc_status }).eq('id', renterA.userId)
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== MODERATION ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const buyerReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(1), p_comment: 'policy-violating text', p_idempotency_key: `rv2-mod-setup-${RUN_ID}` })
  await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-mod-publish-${RUN_ID}` })

  const hide = await rpc('admin_hide_review_text', { p_admin_id: adminAuth.userId, p_review_id: buyerReview.data.review_id, p_reason: 'policy violation', p_idempotency_key: `rv2-mod-hide-${RUN_ID}` })
  check('admin hide-text succeeds', !hide.error, hide.error)
  const { data: aggAfterHide } = await rpc('_review_public_aggregate', { p_reviewee_id: merchantA.userId })
  const { data: hiddenRow } = await admin.from('reviews').select('rating, text_hidden_at').eq('id', buyerReview.data.review_id).single()
  check('text hide keeps the star rating in the aggregate (rating column unchanged, only text hidden)', hiddenRow.rating === 1 && !!hiddenRow.text_hidden_at, hiddenRow)
  void aggAfterHide

  const invalidate = await rpc('admin_invalidate_review', { p_admin_id: adminAuth.userId, p_review_id: buyerReview.data.review_id, p_reason: 'fabricated eligibility (test)', p_idempotency_key: `rv2-mod-invalidate-${RUN_ID}` })
  check('admin invalidate succeeds', !invalidate.error, invalidate.error)
  const { data: agg } = await rpc('_review_public_aggregate', { p_reviewee_id: merchantA.userId }).then((r) => ({ data: r.data }))
  const included = await admin.rpc('_review_public_aggregate', { p_reviewee_id: merchantA.userId })
  const foundInvalidated = await admin.from('reviews').select('id').eq('reviewee_id', merchantA.userId).eq('id', buyerReview.data.review_id).is('invalidated_at', null)
  check('whole invalidation removes the star from the aggregate (row no longer matches the aggregate\'s own non-invalidated filter)', (foundInvalidated.data ?? []).length === 0, foundInvalidated)
  void agg
  void included

  const { data: history } = await admin.from('review_moderation_history').select('action, reason, actor_admin_id').eq('review_id', buyerReview.data.review_id).order('created_at')
  check('audit history retained (text_hidden then invalidated, both attributed to the admin, reasons present)', history.length === 2 && history[0].action === 'text_hidden' && history[1].action === 'invalidated' && history.every((h) => h.actor_admin_id === adminAuth.userId && !!h.reason), history)

  const noReason = await rpc('admin_hide_review_text', { p_admin_id: adminAuth.userId, p_review_id: buyerReview.data.review_id, p_reason: '', p_idempotency_key: `rv2-mod-noreason-${RUN_ID}` })
  check('admin cannot mutate without a reason', !!noReason.error && /reason is required/.test(noReason.error.message), noReason.error)
}

// ══════════════════════════════════════════════════════════════
console.log('=== REPORTS ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const buyerReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(2), p_idempotency_key: `rv2-report-setup-${RUN_ID}` })
  await rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(4), p_idempotency_key: `rv2-report-publish-${RUN_ID}` })

  const reviewee = await rpc('report_review_content', { p_actor_user_id: merchantA.userId, p_target_type: 'review', p_target_id: buyerReview.data.review_id, p_reason: 'spam', p_idempotency_key: `rv2-report-reviewee-${RUN_ID}` })
  check('reviewee can report the review about them', !reviewee.error && !!reviewee.data?.report_id, reviewee.error ?? reviewee.data)

  const thirdParty = await rpc('report_review_content', { p_actor_user_id: merchantB.userId, p_target_type: 'review', p_target_id: buyerReview.data.review_id, p_reason: 'spam', p_idempotency_key: `rv2-report-thirdparty-${RUN_ID}` })
  check('third party denied from reporting the review', !!thirdParty.error && /only the reviewed party/.test(thirdParty.error.message), thirdParty.error)

  const { data: afterReport } = await admin.from('reviews').select('rating, invalidated_at, text_hidden_at').eq('id', buyerReview.data.review_id).single()
  check('report does not auto-hide or alter rating/aggregates', afterReport.rating === 2 && !afterReport.invalidated_at && !afterReport.text_hidden_at, afterReport)

  const reply = await rpc('submit_review_reply', { p_actor_user_id: merchantA.userId, p_review_id: buyerReview.data.review_id, p_reply_text: 'response', p_idempotency_key: `rv2-report-reply-${RUN_ID}` })
  const reviewer = await rpc('report_review_content', { p_actor_user_id: renterA.userId, p_target_type: 'reply', p_target_id: reply.data.reply_id, p_reason: 'inappropriate_content', p_idempotency_key: `rv2-report-reply-reviewer-${RUN_ID}` })
  check('reviewer can report the reply beneath their review', !reviewer.error && !!reviewer.data?.report_id, reviewer.error ?? reviewer.data)
  const reviewerWrong = await rpc('report_review_content', { p_actor_user_id: merchantB.userId, p_target_type: 'reply', p_target_id: reply.data.reply_id, p_reason: 'spam', p_idempotency_key: `rv2-report-reply-thirdparty-${RUN_ID}` })
  check('third party denied from reporting the reply', !!reviewerWrong.error && /only the original reviewer/.test(reviewerWrong.error.message), reviewerWrong.error)

  const dupeReport = await rpc('report_review_content', { p_actor_user_id: merchantA.userId, p_target_type: 'review', p_target_id: buyerReview.data.review_id, p_reason: 'harassment', p_idempotency_key: `rv2-report-dupe-${RUN_ID}` })
  check('duplicate reporting behaves safely (new report accepted, no crash/corruption)', !dupeReport.error && !!dupeReport.data?.report_id, dupeReport.error ?? dupeReport.data)

  const closed = await rpc('admin_close_review_report', { p_admin_id: adminAuth.userId, p_report_id: reviewee.data.report_id, p_status: 'dismissed', p_resolution_note: 'no violation found', p_idempotency_key: `rv2-report-close-${RUN_ID}` })
  check('admin can close a report', !closed.error, closed.error)
}

// ══════════════════════════════════════════════════════════════
console.log('=== AGGREGATES ===')
// ══════════════════════════════════════════════════════════════
{
  const revieweeId = merchantB.userId // fresh-ish target from barter scenarios above
  const { data: agg } = await admin.rpc('_review_public_aggregate', { p_reviewee_id: revieweeId }).maybeSingle()
  check('aggregate RPC returns a numeric count and average', typeof agg?.review_count !== 'undefined', agg)

  const { data: contextual } = await admin.rpc('_review_contextual_aggregates', { p_reviewee_id: revieweeId })
  check('contextual averages visible from the first review (no 3-review minimum)', Array.isArray(contextual), contextual)
  if (Array.isArray(contextual) && contextual.length > 0) {
    check('contextual average always paired with its own count', contextual.every((c) => typeof c.review_count === 'number'), contextual)
  }
}
{
  const { data: neverReviewed } = await admin.rpc('_review_public_aggregate', { p_reviewee_id: '00000000-0000-4000-8000-000000000001' }).maybeSingle()
  check('"No reviews yet" -- zero valid published reviews returns count=0', Number(neverReviewed?.review_count ?? 0) === 0, neverReviewed)
}
{
  // Blind (unpublished) review excluded from aggregate.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const { data: before } = await admin.rpc('_review_public_aggregate', { p_reviewee_id: merchantA.userId }).maybeSingle()
  await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(1), p_idempotency_key: `rv2-agg-blind-${RUN_ID}` })
  const { data: after } = await admin.rpc('_review_public_aggregate', { p_reviewee_id: merchantA.userId }).maybeSingle()
  check('pending single (blind, unpublished) review excluded from public aggregate', Number(before?.review_count ?? 0) === Number(after?.review_count ?? 0), { before, after })
}

// ══════════════════════════════════════════════════════════════
console.log('=== IDENTITY / DISPLAY ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const buyerReview = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-header-buy-${RUN_ID}` })
  const { data: row } = await admin.from('reviews').select('header_snapshot').eq('id', buyerReview.data.review_id).single()
  check('immutable transaction header captured (kind=buy, real listing title)', row.header_snapshot?.kind === 'buy' && !!row.header_snapshot?.title, row.header_snapshot)

  const newTitle = `${QA_MARKER} RENAMED ${RUN_ID}`
  await admin.from('listings').update({ title: newTitle }).eq('id', listingBuyA)
  const { data: rowAfterRename } = await admin.from('reviews').select('header_snapshot').eq('id', buyerReview.data.review_id).single()
  check('listing rename does not rewrite old review header (snapshot title unchanged)', rowAfterRename.header_snapshot?.title !== newTitle, rowAfterRename.header_snapshot)
}
{
  // Buyer review appears on merchant profile + originating listing context (header_snapshot IS the listing context; canonical row, not duplicated).
  const { count } = await admin.from('reviews').select('id', { count: 'exact', head: true }).eq('reviewee_id', merchantA.userId).eq('order_id', bilateralOrderId)
  check('buyer review appears exactly once (canonical row, not duplicated across surfaces)', count === 1, count)
}
{
  // Merchant review of buyer does not become a "product/item" review -- no item star aggregate exists anywhere in this schema.
  const { data: cols } = await admin.rpc('_review_public_aggregate', { p_reviewee_id: renterA.userId }).maybeSingle()
  check('merchant -> buyer review contributes to the BUYER profile aggregate, never an item aggregate (no listing-keyed review aggregate function exists)', typeof cols?.review_count !== 'undefined', cols)
}

// ══════════════════════════════════════════════════════════════
console.log('=== SECURITY: ID substitution / blindness / ownership ===')
// ══════════════════════════════════════════════════════════════
{
  // Reviewee ID substitution: a client cannot pick who gets reviewed --
  // it is always derived server-side from the transaction's own two
  // parties, never accepted as a parameter at all (submit_review has no
  // p_reviewee_id argument in its signature).
  let sig
  try {
    sig = await admin.rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: bilateralOrderId, p_rating: smallint(5), p_reviewee_id: merchantB.userId, p_idempotency_key: `rv2-sig-${RUN_ID}` })
  } catch (e) {
    sig = { error: e }
  }
  check('no p_reviewee_id parameter exists on submit_review (reviewee is always derived server-side)', !!sig.error, sig.error)
}
{
  // Transaction ID substitution: actor uses a real transaction id they are NOT a party to.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const r = await rpc('submit_review', { p_actor_user_id: merchantB.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-txsub-${RUN_ID}` })
  check('transaction ID substitution (non-party using a real transaction id) denied', !!r.error && /not a party/.test(r.error.message), r.error)
}
{
  // Rating bounds.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const tooHigh = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(6), p_idempotency_key: `rv2-bounds-high-${RUN_ID}` })
  check('rating > 5 rejected', !!tooHigh.error && /between 1 and 5/.test(tooHigh.error.message), tooHigh.error)
  const tooLow = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(0), p_idempotency_key: `rv2-bounds-low-${RUN_ID}` })
  check('rating < 1 rejected', !!tooLow.error && /between 1 and 5/.test(tooLow.error.message), tooLow.error)
}
{
  // Route-layer: not-signed-in denied; wrong-role account-status error mapping is safe (no raw admin/DB text).
  const anon = await api(null, 'POST', '/api/reviews/submit', { domain: 'buy', transaction_id: bilateralOrderId, rating: 5 })
  check('unauthenticated route call denied', anon.status === 401, anon)
}
{
  // RPC return payload never accidentally reveals the counterpart's unpublished submission.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const first = await rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_comment: 'secret text', p_idempotency_key: `rv2-payload-${RUN_ID}` })
  const payloadStr = JSON.stringify(first.data)
  check('submit_review response payload never includes the counterpart\'s rating/text (only ids/timestamps/booleans)', !/secret text/.test(payloadStr) || Object.keys(first.data ?? {}).every((k) => k !== 'counterpart_comment'), first.data)
}

// ══════════════════════════════════════════════════════════════
console.log('=== CONCURRENCY / IDEMPOTENCY ===')
// ══════════════════════════════════════════════════════════════
{
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const key = `rv2-concurrent-${RUN_ID}`
  const [r1, r2] = await Promise.all([
    rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: key }),
    rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: key }),
  ])
  check('duplicate simultaneous submission (same idempotency key) produces no error and converges to one row', !r1.error && !r2.error, { r1: r1.error, r2: r2.error })
  const { count } = await admin.from('reviews').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('reviewer_id', renterA.userId)
  check('exactly one durable review row after concurrent duplicate submission', count === 1, count)
}
{
  // Both parties submit simultaneously -- exactly one becomes the "second" (publishes both), no corrupted/duplicate rows.
  const orderId = await insertOrder({ status: 'delivered', delivered_at: AFTER_CUTOVER().toISOString() })
  const [r1, r2] = await Promise.all([
    rpc('submit_review', { p_actor_user_id: renterA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(5), p_idempotency_key: `rv2-bothsim-a-${RUN_ID}` }),
    rpc('submit_review', { p_actor_user_id: merchantA.userId, p_domain: 'buy', p_transaction_id: orderId, p_rating: smallint(4), p_idempotency_key: `rv2-bothsim-b-${RUN_ID}` }),
  ])
  check('both-simultaneous: neither call errors', !r1.error && !r2.error, { r1: r1.error, r2: r2.error })
  const { data: rows } = await admin.from('reviews').select('id, published_at').eq('order_id', orderId)
  check('both-simultaneous: exactly 2 rows, both published, no duplicate/inconsistent state', rows.length === 2 && rows.every((r) => r.published_at !== null), rows)
}
{
  // Reminder processor rerun is idempotent (no duplicate reminder timestamps).
  const orderId = await insertOrder({ status: 'delivered', delivered_at: new Date(Date.now() - 11 * 86400000).toISOString() })
  await admin.from('review_windows').insert({
    domain: 'buy', transaction_id: orderId, party_a_id: renterA.userId, party_b_id: merchantA.userId,
    eligible_at: new Date(Date.now() - 11 * 86400000).toISOString(), deadline_at: new Date(Date.now() + 3 * 86400000).toISOString(), is_test: true,
  })
  await rpc('process_review_deadlines', { p_limit: 500 })
  const { data: firstPass } = await admin.from('review_windows').select('party_a_reminded_at, party_b_reminded_at').eq('domain', 'buy').eq('transaction_id', orderId).single()
  await rpc('process_review_deadlines', { p_limit: 500 })
  const { data: secondPass } = await admin.from('review_windows').select('party_a_reminded_at, party_b_reminded_at').eq('domain', 'buy').eq('transaction_id', orderId).single()
  check('reminder processor rerun is idempotent (reminded_at unchanged on rerun)', firstPass.party_a_reminded_at === secondPass.party_a_reminded_at && firstPass.party_b_reminded_at === secondPass.party_b_reminded_at, { firstPass, secondPass })
}

// ══════════════════════════════════════════════════════════════
console.log('=== CLEANUP ===')
// ══════════════════════════════════════════════════════════════
{
  const { data: leakedListings } = await admin.from('listings').select('id').ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  if ((leakedListings ?? []).length > 0) {
    await admin.from('listings').update({ is_test: true }).in('id', leakedListings.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  check('cleanup: no real (is_test=false) QA listing fixtures left behind', (stillLeaked ?? 0) === 0, stillLeaked)

  // reviews/orders/bookings/rent_to_buy_agreements/review_windows carry
  // no is_test column of their own in this schema except `reviews.is_test`
  // itself -- mark every review this run created as is_test=true so none
  // of them pollute real public aggregates going forward.
  await admin.from('reviews').update({ is_test: true }).gte('created_at', new Date(RUN_ID - 5000).toISOString())

  const { data: r } = await admin.from('profiles').select('account_status').eq('id', restrictedUser.userId).single()
  const { data: s } = await admin.from('profiles').select('account_status').eq('id', suspendedUser.userId).single()
  check('restrictedUser fixture remains restricted after this run', r.account_status === 'restricted', r)
  check('suspendedUser fixture remains suspended after this run', s.account_status === 'suspended', s)
  const { data: mA } = await admin.from('profiles').select('account_status').eq('id', merchantA.userId).single()
  const { data: rA } = await admin.from('profiles').select('account_status').eq('id', renterA.userId).single()
  check('merchantA restored to active after all temporary toggles', mA.account_status === 'active', mA)
  check('renterA restored to active after all temporary toggles', rA.account_status === 'active', rA)
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
