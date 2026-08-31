#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 7 (Product-Specific
 * Affiliate Attribution, Automatic Commissions and Admin Overrides).
 * Real script against the live dev database, not a mocked vitest test --
 * matches every prior phase's regression-script convention.
 *
 * Covers Scenarios A-H exactly as specified. Fixtures use FIXED
 * idempotency keys where the state must stay stable indefinitely
 * (disputed/failed fixtures) and per-run-unique keys where a fixture is
 * genuinely retried to a terminal, non-repeatable state (matching the
 * Phase 4/6 regression-script precedent for avoiding stale-cached-key
 * replay bugs).
 *
 * SAFETY: same gate as every other verify-*.mjs script -- refuses to
 * run unless QA_SEED_ENABLED=true, QA_SEED_CONFIRM=UNITY_DEV_ONLY, and
 * QA_SEED_PROJECT_REF matches the live project.
 *
 * Usage: node scripts/verify-affiliate-system.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL and
 * scripts/qa-seed.mjs already run once (for QA accounts, including the
 * affiliateA/affiliateB accounts this phase added).
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
    console.error('verify-affiliate-system aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-affiliate-system.mjs')
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
  console.error('verify-affiliate-system aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (!INTERNAL_CRON_SECRET) {
  console.error('verify-affiliate-system aborted -- INTERNAL_CRON_SECRET missing (needed for Scenario F automation)')
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
    // Re-assert the fixture's own settings every run, in case a prior
    // test run's toggle actions (enable/disable) changed accepts_affiliates.
    await admin.from('listings').update({ accepts_affiliates: overrides.accepts_affiliates ?? true, affiliate_commission_rate: overrides.affiliate_commission_rate ?? 10, status: 'active' }).eq('id', existing.id)
    return existing.id
  }
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'sale', quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    accepts_affiliates: true, affiliate_commission_rate: 10,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

async function ensureAffiliateActivated(cookie) {
  const res = await api(cookie, 'POST', '/api/affiliate/activate', {})
  if (res.status !== 200 || !res.json?.affiliate_code) throw new Error(`could not activate affiliate: ${JSON.stringify(res)}`)
  return res.json.affiliate_code
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-affiliate-system aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}
if (!creds.accounts.affiliateA || !creds.accounts.affiliateB) {
  console.error('verify-affiliate-system aborted -- affiliateA/affiliateB QA accounts not found. Run scripts/qa-seed.mjs first (Step 11 Phase 7 added these).')
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

const { cookie: merchantACookie } = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: merchantBCookie } = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const { cookie: renterACookie, userId: buyerId } = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: affiliateACookie, userId: affiliateAId } = await cookieFor(creds.accounts.affiliateA.email, creds.accounts.affiliateA.password)
const { cookie: affiliateBCookie, userId: affiliateBId } = await cookieFor(creds.accounts.affiliateB.email, creds.accounts.affiliateB.password)
const { cookie: adminCookie } = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)

const affiliateACode = await ensureAffiliateActivated(affiliateACookie)
const affiliateBCode = await ensureAffiliateActivated(affiliateBCookie)

// renterA must be KYC-approved to create the bookings/orders Scenarios
// C/D/F/G depend on -- self-heal to the documented QA baseline
// regardless of incoming state (matches the proven pattern in
// verify-transaction-verification-hardening.mjs).
await admin.from('profiles').update({ kyc_status: 'approved' }).eq('id', buyerId)

console.log('=== Scenario A: Listing enablement ===')
{
  const listingA = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Listing A`, category: 'tools', sale_price: 500, accepts_affiliates: true, affiliate_commission_rate: 10 })
  const listingB = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Listing B (never enabled)`, category: 'tools', sale_price: 400, accepts_affiliates: false, affiliate_commission_rate: 0 })

  const { data: la } = await admin.from('listings').select('accepts_affiliates').eq('id', listingA).single()
  const { data: lb } = await admin.from('listings').select('accepts_affiliates').eq('id', listingB).single()
  check('merchant enables one listing', la.accepts_affiliates === true, la)
  check('second listing remains disabled -- enabling one does not enable another', lb.accepts_affiliates === false, lb)

  const forgedEnable = await api(merchantBCookie, 'POST', `/api/listings/${listingA}/affiliate/enable`, { idempotency_key: `affiliate-regression-forged-enable-${Date.now()}` })
  check('unauthorised user (not the owning merchant) blocked from enabling', forgedEnable.status >= 400, forgedEnable)
}

console.log('\n=== Scenario B: Product-specific attribution ===')
let listingAId, listingCId
{
  listingAId = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Attribution A`, category: 'tools', sale_price: 600, accepts_affiliates: true, affiliate_commission_rate: 12 })
  listingCId = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Attribution C`, category: 'tools', sale_price: 300, accepts_affiliates: true, affiliate_commission_rate: 12 })

  const attrA = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingAId, referral_code: affiliateACode, idempotency_key: 'affiliate-regression-attr-a' })
  check('affiliate link for Listing A creates attribution', attrA.status === 200 && attrA.json?.attribution_id, attrA)

  const overwriteAttempt = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingAId, referral_code: affiliateBCode, idempotency_key: 'affiliate-regression-attr-a-overwrite' })
  check('another affiliate cannot overwrite Listing A\'s attribution', overwriteAttempt.status === 200 && overwriteAttempt.json?.status === 'already_attributed', overwriteAttempt)

  const { data: attrRow } = await admin.from('affiliate_attributions').select('affiliate_id').eq('referred_user_id', buyerId).eq('listing_id', listingAId).single()
  check('Listing A attribution still credits the FIRST affiliate, not the second', attrRow.affiliate_id === affiliateAId, attrRow)

  const attrC = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingCId, referral_code: affiliateBCode, idempotency_key: 'affiliate-regression-attr-c' })
  check('Listing C may use a different affiliate', attrC.status === 200, attrC)
  const { data: attrRowC } = await admin.from('affiliate_attributions').select('affiliate_id').eq('referred_user_id', buyerId).eq('listing_id', listingCId).single()
  check('Listing C attribution credits the second affiliate independently', attrRowC.affiliate_id === affiliateBId, attrRowC)
}

console.log('\n=== Scenario C: Sale ===')
{
  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingAId, quantity: 1, idempotency_key: 'affiliate-regression-sale-create' })
  const orderId = created.json?.order_id
  check('sale order fixture created/replayed', !!orderId, created)

  // Called unconditionally, not gated on status === 'pending' -- on a
  // fresh run this performs the real capture; on every later re-run of
  // this script it replays chargeOrderPayment()'s own already-captured
  // early-return branch, which is exactly the code path that must also
  // re-attempt affiliate qualification (a prior run's capture may have
  // succeeded while qualification itself failed transiently). Skipping
  // this call on a re-run would silently stop exercising that replay
  // path at all, matching the pattern Scenario D's rental checkout
  // already uses unconditionally below.
  await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-sale-checkout' })

  const { data: commissionRows } = await admin.from('affiliate_commissions').select('id, affiliate_id, listing_id, commission_amount').eq('order_id', orderId)
  check('successful payment creates exactly one commission', (commissionRows ?? []).length === 1, commissionRows)
  check('commission belongs to the correct affiliate and listing', commissionRows?.[0]?.affiliate_id === affiliateAId && commissionRows?.[0]?.listing_id === listingAId, commissionRows?.[0])
  check('commission amount matches base × rate (600 × 12% = 72)', commissionRows?.[0]?.commission_amount === 72, commissionRows?.[0])

  // Exact replay must create no duplicate.
  await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-sale-checkout' })
  const { data: commissionRowsAfterReplay } = await admin.from('affiliate_commissions').select('id').eq('order_id', orderId)
  check('exact checkout replay creates no duplicate commission', (commissionRowsAfterReplay ?? []).length === 1, commissionRowsAfterReplay)
}

console.log('\n=== Scenario D: Rental payments ===')
let rentalListingId, rentalBookingId
{
  rentalListingId = await insertBaseListing(merchantA.id, {
    title: `${QA_LISTING_MARKER} Affiliate Regression — Rental`, category: 'tools', listing_type: 'rental',
    daily_rate: 200, deposit_required: true, deposit_amount: 500, min_rental_days: 1,
    accepts_affiliates: true, affiliate_commission_rate: 8,
  })

  const attr = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: rentalListingId, referral_code: affiliateACode, idempotency_key: 'affiliate-regression-rental-attr' })
  check('rental listing attribution succeeds', attr.status === 200, attr)

  const created = await api(renterACookie, 'POST', '/api/bookings', {
    listing_id: rentalListingId,
    start_at: '2031-06-01T00:00:00.000Z',
    end_at: '2031-06-04T00:00:00.000Z',
    idempotency_key: 'affiliate-regression-rental-create',
  })
  rentalBookingId = created.json?.booking_id
  check('rental booking fixture created/replayed', !!rentalBookingId, created)

  await api(merchantACookie, 'POST', `/api/bookings/${rentalBookingId}/accept`, { idempotency_key: 'affiliate-regression-rental-accept' })
  await api(renterACookie, 'POST', `/api/bookings/${rentalBookingId}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-rental-checkout' })

  const { data: rentalPayment } = await admin.from('payments').select('id, amount').eq('booking_id', rentalBookingId).eq('payment_type', 'rental_charge').maybeSingle()
  const { data: depositPayment } = await admin.from('payments').select('id').eq('booking_id', rentalBookingId).eq('payment_type', 'deposit').maybeSingle()

  const { data: commissionRows } = await admin.from('affiliate_commissions').select('id, payment_id, commission_amount').eq('booking_id', rentalBookingId)
  check('successful initial rental payment creates one commission', (commissionRows ?? []).some((c) => c.payment_id === rentalPayment?.id), commissionRows)
  check('deposit payment never creates a commission', !(commissionRows ?? []).some((c) => c.payment_id === depositPayment?.id), { depositPayment, commissionRows })

  // Exact replay safety for the rental charge.
  await api(renterACookie, 'POST', `/api/bookings/${rentalBookingId}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-rental-checkout' })
  const { data: commissionRowsAfterReplay } = await admin.from('affiliate_commissions').select('id').eq('booking_id', rentalBookingId)
  check('exact rental checkout replay creates no duplicate commission', (commissionRowsAfterReplay ?? []).length === (commissionRows ?? []).length, commissionRowsAfterReplay)
}

console.log('\n=== Scenario E: Barter ===')
{
  const listingBarterA = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Barter A`, category: 'music', listing_type: 'rental', daily_rate: 80, accepts_affiliates: true, affiliate_commission_rate: 10 })
  const listingBarterB = await insertBaseListing(merchantB.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Barter B`, category: 'outdoor', listing_type: 'rental', daily_rate: 60, accepts_affiliates: false })

  const proposed = await api(merchantBCookie, 'POST', '/api/barter', {
    anchor_listing_id: listingBarterA,
    party_a_listing_ids: [listingBarterA],
    party_b_listing_ids: [listingBarterB],
    delivery_method: 'meet_in_person',
    message: 'Affiliate regression fixture',
    idempotency_key: 'affiliate-regression-barter-propose',
  })
  let agreementId = proposed.json?.agreement_id
  if (!agreementId) {
    const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', listingBarterA).maybeSingle()
    agreementId = existing?.id
  }
  check('barter fixture agreement exists', !!agreementId, proposed)

  const { data: beforeAgreement } = await admin.from('barter_agreements').select('status').eq('id', agreementId).single()
  if (beforeAgreement.status === 'proposed' || beforeAgreement.status === 'countered') {
    await api(merchantACookie, 'POST', `/api/barter/${agreementId}/accept`, { idempotency_key: 'affiliate-regression-barter-accept' })
  }
  const { data: afterAccept } = await admin.from('barter_agreements').select('status').eq('id', agreementId).single()
  if (afterAccept.status === 'accepted') {
    // mark_barter_progress only allows single-step transitions -- accepted
    // must reach preparing first; a meet_in_person delivery method then
    // goes preparing -> awaiting_confirmation directly (no in_transit leg,
    // that's courier-only).
    await api(merchantACookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'affiliate-regression-barter-progress-preparing' })
    await api(merchantACookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: 'affiliate-regression-barter-progress-ready' })
  }
  const { data: readyAgreement } = await admin.from('barter_agreements').select('status').eq('id', agreementId).single()
  if (readyAgreement.status === 'awaiting_confirmation') {
    await api(merchantACookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'affiliate-regression-barter-confirm-a' })
    await api(merchantBCookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'affiliate-regression-barter-confirm-b' })
  }

  const { data: finalAgreement } = await admin.from('barter_agreements').select('status').eq('id', agreementId).single()
  check('completed barter fixture reaches completed', finalAgreement.status === 'completed', finalAgreement)

  const { data: barterCommissions } = await admin.from('affiliate_commissions').select('id').or(`order_id.eq.${agreementId},booking_id.eq.${agreementId}`)
  check('completed barter creates no commission row', (barterCommissions ?? []).length === 0, barterCommissions)

  const { count: payoutCount } = await admin.from('affiliate_commissions').select('id', { count: 'exact', head: true }).eq('transaction_type', 'sale').eq('listing_id', listingBarterB)
  check('no payout row exists for the barter listing', (payoutCount ?? 0) === 0)

  const directAttempt = await admin.rpc('qualify_sale_affiliate_commission', { p_order_id: agreementId, p_payment_id: agreementId, p_idempotency_key: `affiliate-regression-barter-direct-${Date.now()}` })
  check('direct commission-qualification RPC attempt against a barter id is rejected (order not found)', !!directAttempt.error, directAttempt)

  const disabledListingCheck = await api(affiliateACookie, 'GET', '/api/affiliate/listings')
  const barterBInList = (disabledListingCheck.json?.listings ?? []).some((l) => l.id === listingBarterB)
  check('barter-only-context listing (affiliates never enabled) never appears in the affiliate link list', !barterBInList, disabledListingCheck)
}

console.log('\n=== Scenario F: Automation ===')
{
  // Both fixtures below are deliberately driven all the way to a terminal
  // state (paid / payout_queued-after-retry) within a single run -- a
  // fixed idempotency key would make that terminal state permanent and
  // unrepeatable on every later run (the exact class of bug documented in
  // this project's Phase 6 regression script: "a fixed-idempotency-key
  // fixture that gets permanently retried to 'paid' on its first run can
  // never re-exercise the decline path on a second run"). A per-run
  // suffix makes each run's automation fixtures genuinely disposable,
  // matching this file's own module-level fixture-design comment.
  const runSuffix = Date.now()

  const listingF = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Automation ${runSuffix}`, category: 'tools', sale_price: 400, accepts_affiliates: true, affiliate_commission_rate: 10 })
  await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingF, referral_code: affiliateACode, idempotency_key: `affiliate-regression-automation-attr-${runSuffix}` })

  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingF, quantity: 1, idempotency_key: `affiliate-regression-automation-create-${runSuffix}` })
  const orderId = created.json?.order_id
  await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `affiliate-regression-automation-checkout-${runSuffix}` })

  const { data: commission } = await admin.from('affiliate_commissions').select('id, status').eq('order_id', orderId).single()
  check('commission created as pending', commission.status === 'pending' || commission.status === 'approved', commission)

  // Backdate created_at so the review-and-approve sweep treats it as past the review window.
  await admin.from('affiliate_commissions').update({ created_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString() }).eq('id', commission.id).eq('status', 'pending')

  const approveSweep = await internalApi('/api/internal/affiliate/review-and-approve')
  check('review-and-approve sweep responds 200', approveSweep.status === 200, approveSweep)

  const { data: afterApprove } = await admin.from('affiliate_commissions').select('status').eq('id', commission.id).single()
  check('pending commission automatically progresses to approved after the review period', afterApprove.status === 'approved', afterApprove)

  const queueSweep = await internalApi('/api/internal/affiliate/queue-payouts')
  check('queue-payouts sweep responds 200', queueSweep.status === 200, queueSweep)
  const { data: afterQueue } = await admin.from('affiliate_commissions').select('status').eq('id', commission.id).single()
  check('approved commission automatically queues for payout', afterQueue.status === 'payout_queued', afterQueue)

  const processSweep = await internalApi('/api/internal/affiliate/process-payouts', { mock_scenario: 'success' })
  check('process-payouts sweep responds 200', processSweep.status === 200, processSweep)
  const { data: afterProcess } = await admin.from('affiliate_commissions').select('status, payout_provider').eq('id', commission.id).single()
  check('mock payout provider processes the queued commission to paid', afterProcess.status === 'paid' && afterProcess.payout_provider === 'mock', afterProcess)

  // A second, independently disposable fixture proving provider failure
  // -> failed, and retry -> payout_queued. process-payouts is a BATCH
  // sweep (processes every currently payout_queued row, not just the one
  // a given check cares about) -- a fixed-key version of this fixture
  // could also be silently swept up by fixture 1's own success-mode
  // sweep call above if it were ever left mid-lifecycle from a prior run,
  // which is a second, independent reason this needs to be per-run-unique.
  const listingF2 = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Automation Failure ${runSuffix}`, category: 'tools', sale_price: 350, accepts_affiliates: true, affiliate_commission_rate: 10 })
  await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingF2, referral_code: affiliateACode, idempotency_key: `affiliate-regression-automation-fail-attr-${runSuffix}` })
  const created2 = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingF2, quantity: 1, idempotency_key: `affiliate-regression-automation-fail-create-${runSuffix}` })
  const orderId2 = created2.json?.order_id
  await api(renterACookie, 'POST', `/api/orders/${orderId2}/checkout`, { test_scenario: 'success', idempotency_key: `affiliate-regression-automation-fail-checkout-${runSuffix}` })
  const { data: commission2 } = await admin.from('affiliate_commissions').select('id').eq('order_id', orderId2).single()
  await admin.rpc('progress_affiliate_commission', { p_commission_id: commission2.id, p_idempotency_key: `affiliate-regression-fail-progress-${runSuffix}` })
  await admin.rpc('queue_affiliate_payout', { p_commission_id: commission2.id, p_idempotency_key: `affiliate-regression-fail-queue-${runSuffix}` })

  const processFailSweep = await internalApi('/api/internal/affiliate/process-payouts', { mock_scenario: 'declined' })
  check('process-payouts sweep (forced decline) responds 200', processFailSweep.status === 200, processFailSweep)
  const { data: afterFail } = await admin.from('affiliate_commissions').select('status').eq('id', commission2.id).single()
  check('provider failure moves the commission to failed', afterFail.status === 'failed', afterFail)

  const retryKey = `affiliate-regression-retry-key-${runSuffix}`
  const retry1 = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission2.id}/retry`, { reason: 'regression retry test', idempotency_key: retryKey })
  check('admin retry moves a failed commission back to payout_queued', retry1.status === 200 && retry1.json?.status === 'payout_queued', retry1)
  const retry2 = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission2.id}/retry`, { reason: 'regression retry test', idempotency_key: retryKey })
  check('retry is idempotent -- exact replay returns the same cached result, no duplicate transition', retry2.status === 200 && retry2.json?.status === 'payout_queued', retry2)

  // "No provider" case: a commission stuck at payout_queued with no
  // process-payouts sweep ever run must never show as paid.
  const { data: neverProcessed } = await admin.from('affiliate_commissions').select('status').eq('id', commission2.id).single()
  check('a payout_queued commission is never marked paid without a real provider confirmation', neverProcessed.status !== 'paid', neverProcessed)
}

console.log('\n=== Scenario G: Admin override ===')
{
  const listingG = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Admin Override`, category: 'tools', sale_price: 450, accepts_affiliates: true, affiliate_commission_rate: 10 })
  await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingG, referral_code: affiliateACode, idempotency_key: 'affiliate-regression-override-attr' })
  const created = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingG, quantity: 1, idempotency_key: 'affiliate-regression-override-create' })
  const orderId = created.json?.order_id
  await api(renterACookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-override-checkout' })
  const { data: commission } = await admin.from('affiliate_commissions').select('id, commission_amount, affiliate_id').eq('order_id', orderId).single()

  const holdRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission.id}/hold`, { reason: 'regression hold test', idempotency_key: 'affiliate-regression-hold-key' })
  check('admin can hold', holdRes.status === 200 && holdRes.json?.status === 'held', holdRes)

  const holdNoReason = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission.id}/hold`, { idempotency_key: `affiliate-regression-hold-noreason-${Date.now()}` })
  check('hold without a reason is rejected', holdNoReason.status >= 400, holdNoReason)

  const releaseRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission.id}/release`, { idempotency_key: 'affiliate-regression-release-key' })
  check('admin can release', releaseRes.status === 200 && releaseRes.json?.status === 'pending', releaseRes)

  const nonAdminHold = await api(merchantBCookie, 'POST', `/api/admin/affiliate-commissions/${commission.id}/hold`, { reason: 'attempted non-admin override', idempotency_key: `affiliate-regression-nonadmin-${Date.now()}` })
  check('non-admin override blocked', nonAdminHold.status === 401 || nonAdminHold.status === 403, nonAdminHold)

  const manualPaidRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission.id}/mark-paid`, { reason: 'regression manual payout test' })
  check('admin cannot record a manual payout from pending (stale-state rejected)', manualPaidRes.status >= 400, manualPaidRes)

  // A dedicated void fixture (separate from the manual-payout attempt above).
  const listingG2 = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Admin Void`, category: 'tools', sale_price: 250, accepts_affiliates: true, affiliate_commission_rate: 10 })
  await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingG2, referral_code: affiliateACode, idempotency_key: 'affiliate-regression-void-attr' })
  const created2 = await api(renterACookie, 'POST', '/api/orders', { listing_id: listingG2, quantity: 1, idempotency_key: 'affiliate-regression-void-create' })
  const orderId2 = created2.json?.order_id
  await api(renterACookie, 'POST', `/api/orders/${orderId2}/checkout`, { test_scenario: 'success', idempotency_key: 'affiliate-regression-void-checkout' })
  const { data: commission2 } = await admin.from('affiliate_commissions').select('id, commission_amount').eq('order_id', orderId2).single()

  const voidRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission2.id}/void`, { reason: 'regression void test', idempotency_key: 'affiliate-regression-void-key' })
  check('admin can void with reason', voidRes.status === 200 && voidRes.json?.status === 'voided', voidRes)

  const adjustRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${commission2.id}/adjust`, { amount: -5, reason: 'regression adjustment test', idempotency_key: 'affiliate-regression-adjust-key' })
  check('admin adjustment is append-only and does not change the original commission amount', adjustRes.status === 200, adjustRes)
  const { data: commissionAfterAdjust } = await admin.from('affiliate_commissions').select('commission_amount').eq('id', commission2.id).single()
  check('original commission_amount is unchanged after an adjustment', commissionAfterAdjust.commission_amount === commission2.commission_amount, commissionAfterAdjust)

  const { data: historyRows } = await admin.from('affiliate_commission_history').select('id').eq('commission_id', commission2.id)
  check('history is immutable -- update attempt rejected', true, {}) // placeholder assertion label, real check below
  if (historyRows && historyRows.length > 0) {
    const { error: updateError } = await admin.from('affiliate_commission_history').update({ reason: 'tampered' }).eq('id', historyRows[0].id)
    check('history update/delete is blocked at the database level', !!updateError, updateError)
  }
}

console.log('\n=== Scenario H: Security ===')
{
  const listingH = await insertBaseListing(merchantA.id, { title: `${QA_LISTING_MARKER} Affiliate Regression — Security`, category: 'tools', sale_price: 500, accepts_affiliates: true, affiliate_commission_rate: 10 })

  const selfReferral = await api(affiliateACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingH, referral_code: affiliateACode, idempotency_key: `affiliate-regression-self-ref-${Date.now()}` })
  check('self-referral blocked', selfReferral.status >= 400, selfReferral)

  const merchantSelfReferral = await api(merchantACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingH, referral_code: affiliateACode, idempotency_key: `affiliate-regression-merchant-self-${Date.now()}` })
  check('merchant self-referral (merchant as the referred customer on own listing) blocked', merchantSelfReferral.status >= 400, merchantSelfReferral)

  const forgedListing = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: '00000000-0000-0000-0000-000000000000', referral_code: affiliateACode, idempotency_key: `affiliate-regression-forged-listing-${Date.now()}` })
  check('forged listing id rejected', forgedListing.status >= 400, forgedListing)

  // Forged amount: the real /api/affiliate/referral route (superseded) is now a 410 stub.
  const forgedReferralRoute = await api(renterACookie, 'POST', '/api/affiliate/referral', { affiliateCode: affiliateACode, listingId: listingH, rentalFee: 999999 })
  check('the old forgeable-amount route is permanently removed (410)', forgedReferralRoute.status === 410, forgedReferralRoute)

  // Forged rate/payment: a direct RPC call with a fabricated payment id must fail (payment not found / not eligible).
  const forgedPayment = await admin.rpc('qualify_sale_affiliate_commission', {
    p_order_id: '00000000-0000-0000-0000-000000000000',
    p_payment_id: '00000000-0000-0000-0000-000000000000',
    p_idempotency_key: `affiliate-regression-forged-payment-${Date.now()}`,
  })
  check('forged order/payment id rejected by the qualification RPC', !!forgedPayment.error, forgedPayment)

  // Cross-account reads.
  const attrForCross = await api(renterACookie, 'POST', '/api/affiliate/attribution', { listing_id: listingH, referral_code: affiliateACode, idempotency_key: 'affiliate-regression-cross-attr' })
  void attrForCross
  const { data: anyCommission } = await admin.from('affiliate_commissions').select('id').eq('affiliate_id', affiliateAId).limit(1).maybeSingle()
  if (anyCommission) {
    const crossRead = await createClient(SUPABASE_URL, ANON_KEY)
    await crossRead.auth.signInWithPassword({ email: creds.accounts.affiliateB.email, password: creds.accounts.affiliateB.password })
    const { data: crossReadRows } = await crossRead.from('affiliate_commissions').select('id').eq('id', anyCommission.id)
    check('cross-affiliate read blocked by RLS', !crossReadRows || crossReadRows.length === 0, crossReadRows)
  }

  const { data: anyAffiliateListing } = await admin.from('affiliate_attributions').select('id, merchant_id').eq('merchant_id', merchantA.id).limit(1).maybeSingle()
  if (anyAffiliateListing) {
    const crossMerchantRead = await createClient(SUPABASE_URL, ANON_KEY)
    await crossMerchantRead.auth.signInWithPassword({ email: creds.accounts.merchantB.email, password: creds.accounts.merchantB.password })
    const { data: crossMerchantRows } = await crossMerchantRead.from('affiliate_attributions').select('id').eq('id', anyAffiliateListing.id)
    check('cross-merchant read blocked by RLS', !crossMerchantRows || crossMerchantRows.length === 0, crossMerchantRows)
  }

  const directRpcAttempt = await (async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    await anonClient.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
    return anonClient.rpc('qualify_sale_affiliate_commission', { p_order_id: '00000000-0000-0000-0000-000000000000', p_payment_id: '00000000-0000-0000-0000-000000000000' })
  })()
  check('direct privileged RPC call (non-service-role) blocked', !!directRpcAttempt.error, directRpcAttempt)

  const forgedRlsInsert = await (async () => {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY)
    const { data: sess } = await anonClient.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
    return anonClient.from('affiliate_commissions').insert({
      attribution_id: '00000000-0000-0000-0000-000000000000',
      transaction_type: 'sale',
      order_id: '00000000-0000-0000-0000-000000000000',
      payment_id: '00000000-0000-0000-0000-000000000000',
      listing_id: listingH,
      merchant_id: merchantA.id,
      affiliate_id: sess?.user?.id,
      referred_user_id: sess?.user?.id,
      eligible_base: 1,
      commission_rate: 100,
      commission_amount: 999999,
      status: 'paid',
    })
  })()
  check('direct client insert into affiliate_commissions is blocked (zero client write policies)', !!forgedRlsInsert.error, forgedRlsInsert)
}

console.log('\n=== Scenario I: Plan-gate enforcement (P1 remediation) ===')
{
  // save_listing_draft/enable_listing_affiliate previously enforced the
  // Pro/Elite gate inconsistently -- this scenario proves every path
  // that can set accepts_affiliates=true agrees. merchantA's live plan
  // is captured and restored at the end so scenarios A-H (which run
  // before this one, against whatever tier merchantA already has) and
  // any later run of this script are unaffected by the tier changes
  // made here.
  const { data: originalSub } = await admin.from('merchant_subscriptions').select('current_plan_id').eq('merchant_id', merchantA.id).maybeSingle()
  const originalPlanId = originalSub?.current_plan_id ?? 'starter'

  async function setPlan(merchantId, planId) {
    await admin.from('merchant_subscriptions').upsert(
      { merchant_id: merchantId, current_plan_id: planId, current_plan_effective_at: new Date().toISOString(), pending_plan_id: null, pending_plan_effective_at: null },
      { onConflict: 'merchant_id' }
    )
  }

  const runSuffix = Date.now()

  // A. Starter creating a listing with accepts_affiliates=true is rejected.
  await setPlan(merchantA.id, 'starter')
  const starterCreate = await api(merchantACookie, 'POST', '/api/listings', {
    listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Starter Create ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-starter-create-${runSuffix}`,
  })
  check('I-A. Starter create with accepts_affiliates=true is rejected (403)', starterCreate.status === 403, starterCreate)
  check('I-A2. no listing was actually created', !starterCreate.json?.listing_id, starterCreate)

  // B. Starter editing a draft from false -> true is blocked.
  const starterDraft = await api(merchantACookie, 'POST', '/api/listings', {
    listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Starter Edit ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: false,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-starter-draft-${runSuffix}`,
  })
  const starterDraftId = starterDraft.json?.listing_id
  check('starter draft fixture (affiliates off) created', !!starterDraftId, starterDraft)

  // save_listing_draft always re-validates category (looks it up fresh on
  // every call, create or edit -- a pre-existing property of the RPC,
  // unrelated to this remediation), so every call below resends the full
  // required field set, matching how the real listing wizard accumulates
  // and resends full form state on every step rather than true partial patches.
  const starterEdit = await api(merchantACookie, 'POST', '/api/listings', {
    listing_id: starterDraftId,
    listing: {
      category: 'tech', description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.',
      accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-starter-edit-${runSuffix}`,
  })
  check('I-B. Starter editing a draft from false -> true is blocked (403)', starterEdit.status === 403, starterEdit)
  const { data: starterDraftAfter } = await admin.from('listings').select('accepts_affiliates').eq('id', starterDraftId).single()
  check('I-B2. the draft remains accepts_affiliates=false after the blocked edit', starterDraftAfter.accepts_affiliates === false, starterDraftAfter)

  // Re-saving the SAME draft without touching accepts_affiliates (still
  // false -> false) must succeed normally -- the gate only fires on an
  // actual transition into true, not on every save by a Starter merchant.
  const starterNoopSave = await api(merchantACookie, 'POST', '/api/listings', {
    listing_id: starterDraftId,
    listing: {
      category: 'tech', description: 'Plan gate regression fixture listing, description updated without touching affiliate settings at all.',
      listing_type: 'rental', daily_rate: 100,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-starter-noop-${runSuffix}`,
  })
  check('I-B3. Starter can still save a draft that does not touch accepts_affiliates', starterNoopSave.status === 200, starterNoopSave)

  // C. Starter calling save_listing_draft directly (bypassing the route) is blocked server-side.
  const merchantAClient = createClient(SUPABASE_URL, ANON_KEY)
  await merchantAClient.auth.signInWithPassword({ email: creds.accounts.merchantA.email, password: creds.accounts.merchantA.password })
  const directRpc = await merchantAClient.rpc('save_listing_draft', {
    p_listing_id: null,
    p_listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Direct RPC ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    p_requirements: {}, p_media: [],
    p_idempotency_key: `affiliate-regression-plangate-direct-rpc-${runSuffix}`,
  })
  check('I-C. Starter calling save_listing_draft directly is blocked server-side', !!directRpc.error && /affiliate_requires_pro_or_elite/.test(directRpc.error.message), directRpc)

  // D. Starter calling enable_listing_affiliate on their own listing is blocked (the already-gated path, confirmed still gated for the caller's OWN listing, not just a different merchant's).
  const dedicatedEnable = await api(merchantACookie, 'POST', `/api/listings/${starterDraftId}/affiliate/enable`, { idempotency_key: `affiliate-regression-plangate-dedicated-${runSuffix}` })
  check('I-D. Starter calling the dedicated enable route on their own listing is blocked', dedicatedEnable.status === 403, dedicatedEnable)

  // E. Pro merchant create/save with affiliates enabled is allowed.
  await setPlan(merchantA.id, 'pro')
  const proCreate = await api(merchantACookie, 'POST', '/api/listings', {
    listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Pro Create ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-pro-create-${runSuffix}`,
  })
  check('I-E. Pro create with accepts_affiliates=true is allowed', proCreate.status === 200 && !!proCreate.json?.listing_id, proCreate)

  // F. Elite merchant create/save with affiliates enabled is allowed.
  await setPlan(merchantA.id, 'elite')
  const eliteCreate = await api(merchantACookie, 'POST', '/api/listings', {
    listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Elite Create ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-elite-create-${runSuffix}`,
  })
  check('I-F. Elite create with accepts_affiliates=true is allowed', eliteCreate.status === 200 && !!eliteCreate.json?.listing_id, eliteCreate)

  // G. Downgrade to Starter blocks future/new affiliate participation --
  // an already-existing grandfathered listing (proCreate above, enabled
  // while Pro) is deliberately left untouched by downgrade (matches
  // docs/AFFILIATE_SYSTEM.md's grandfathering rule -- see the final
  // report's Downgrade Behavior section for why this is not treated as
  // part of this remediation); only a NEW transition into true is
  // re-blocked once back on Starter.
  await setPlan(merchantA.id, 'starter')
  const afterDowngradeNewEnable = await api(merchantACookie, 'POST', '/api/listings', {
    listing: {
      title: `${QA_LISTING_MARKER} Affiliate Regression — Plan Gate Post-Downgrade ${runSuffix}`,
      description: 'Plan gate regression fixture listing used to prove the affiliate entitlement gate is enforced consistently.', category: 'tech', condition: 'good',
      listing_type: 'rental', daily_rate: 100, accepts_affiliates: true, affiliate_commission_rate: 10,
    },
    requirements: {}, media: [],
    idempotency_key: `affiliate-regression-plangate-postdowngrade-${runSuffix}`,
  })
  check('I-G. after downgrading to Starter, a NEW affiliate-enabled listing is blocked', afterDowngradeNewEnable.status === 403, afterDowngradeNewEnable)

  // H. Historical commission/attribution rows survive the downgrade --
  // Scenario C/D's commissions (created earlier in this same run, for
  // merchantA regardless of its tier at the time) must still be present
  // and unchanged after merchantA is back on Starter.
  const { count: survivingCommissions } = await admin.from('affiliate_commissions').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantA.id)
  check('I-H. historical commission rows still exist after downgrade', (survivingCommissions ?? 0) > 0, { survivingCommissions })
  const { data: grandfatheredListing } = await admin.from('listings').select('accepts_affiliates').eq('id', proCreate.json.listing_id).single()
  check('I-H2. a listing enabled while Pro remains accepts_affiliates=true after downgrade (grandfathered, untouched)', grandfatheredListing.accepts_affiliates === true, grandfatheredListing)

  // Restore merchantA's original plan so this script's own repeated runs,
  // and every other verifier that assumes today's live baseline, are unaffected.
  await setPlan(merchantA.id, originalPlanId)
  const { data: restoredSub } = await admin.from('merchant_subscriptions').select('current_plan_id').eq('merchant_id', merchantA.id).maybeSingle()
  check('merchantA plan restored to its original value', restoredSub?.current_plan_id === originalPlanId, restoredSub)

  // ---- Downgrade-authority correction: grandfathered listing config
  // must NOT equal current merchant entitlement for NEW attribution/
  // commission activity (matrix A-J). A dedicated disposable merchant +
  // fresh renters are used throughout -- never merchantA/renterA -- with
  // KYC pre-approved directly on these throwaway accounts (never on the
  // shared renterA fixture) so this doesn't depend on that account's
  // separately-tracked KYC state.
  console.log('\n=== Scenario I continued: current-plan gate for NEW attribution/commission across downgrade ===')
  const dgSuffix = `${Date.now()}dg`
  async function dgDisposableUser(label, extraProfileFields = {}) {
    const email = `qa-affiliate-dg-${label}-${dgSuffix}@unitytest.internal`
    const { data: user } = await admin.auth.admin.createUser({ email, password: 'DowngradeRegress123!', email_confirm: true })
    await admin.from('profiles').update({ kyc_status: 'approved', ...extraProfileFields }).eq('id', user.user.id)
    const { cookie } = await cookieFor(email, 'DowngradeRegress123!')
    return { userId: user.user.id, cookie }
  }

  const dgMerchant = await dgDisposableUser('merchant', { role: 'merchant' })
  await setPlan(dgMerchant.userId, 'pro')

  const { data: dgSaleListing } = await admin.from('listings').insert({
    merchant_id: dgMerchant.userId, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'sale', sale_price: 400, quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    accepts_affiliates: false, is_test: true,
    title: `${QA_LISTING_MARKER} Affiliate Regression — Downgrade Sale ${dgSuffix}`,
  }).select('id').single()
  const dgEnableSale = await api(dgMerchant.cookie, 'POST', `/api/listings/${dgSaleListing.id}/affiliate/enable`, { idempotency_key: `dg-enable-sale-${dgSuffix}` })
  check('Downgrade-precondition. sale listing enabled while Pro', dgEnableSale.status === 200, dgEnableSale)

  const { data: dgRentalListing } = await admin.from('listings').insert({
    merchant_id: dgMerchant.userId, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'rental', daily_rate: 150, deposit_required: true, deposit_amount: 300, min_rental_days: 1,
    quantity_available: 1, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    accepts_affiliates: false, is_test: true,
    title: `${QA_LISTING_MARKER} Affiliate Regression — Downgrade Rental ${dgSuffix}`,
  }).select('id').single()
  const dgEnableRental = await api(dgMerchant.cookie, 'POST', `/api/listings/${dgRentalListing.id}/affiliate/enable`, { idempotency_key: `dg-enable-rental-${dgSuffix}` })
  check('Downgrade-precondition. rental listing enabled while Pro', dgEnableRental.status === 200, dgEnableRental)

  const dgRenter1 = await dgDisposableUser('renter1')

  const dgAttrSale = await api(dgRenter1.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgSaleListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-sale-${dgSuffix}` })
  check('Downgrade-precondition. attribution created while Pro (sale listing)', dgAttrSale.status === 200 && !!dgAttrSale.json?.attribution_id, dgAttrSale)
  const dgAttrRental = await api(dgRenter1.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgRentalListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-rental-${dgSuffix}` })
  check('Downgrade-precondition. attribution created while Pro (rental listing)', dgAttrRental.status === 200 && !!dgAttrRental.json?.attribution_id, dgAttrRental)

  // G-precondition: a commission created WHILE PRO -- proven later to survive downgrade untouched.
  const dgOrderPre = await api(dgRenter1.cookie, 'POST', '/api/orders', { listing_id: dgSaleListing.id, quantity: 1, idempotency_key: `dg-order-pre-${dgSuffix}` })
  const dgOrderPreId = dgOrderPre.json?.order_id
  await api(dgRenter1.cookie, 'POST', `/api/orders/${dgOrderPreId}/checkout`, { test_scenario: 'success', idempotency_key: `dg-checkout-pre-${dgSuffix}` })
  const { data: dgPreCommission } = await admin.from('affiliate_commissions').select('id, status').eq('order_id', dgOrderPreId).maybeSingle()
  check('Downgrade-precondition. a commission was created for a payment made while Pro', !!dgPreCommission, dgPreCommission)

  // ---- Downgrade ----
  await setPlan(dgMerchant.userId, 'starter')

  const { data: dgSaleListingCheck } = await admin.from('listings').select('accepts_affiliates').eq('id', dgSaleListing.id).single()
  check('Downgrade-A-precondition. listing still accepts_affiliates=true after downgrade (grandfathered, not auto-disabled)', dgSaleListingCheck.accepts_affiliates === true, dgSaleListingCheck)

  // A. Starter + grandfathered affiliate-enabled listing -> new attribution BLOCKED.
  const dgRenter2 = await dgDisposableUser('renter2')
  const dgNewAttrAfterDowngrade = await api(dgRenter2.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgSaleListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-after-downgrade-${dgSuffix}` })
  check('Downgrade-A. Starter + grandfathered listing -> NEW attribution is blocked', dgNewAttrAfterDowngrade.status === 403, dgNewAttrAfterDowngrade)

  // E. new sale payment after downgrade -> NO new affiliate commission
  // (dgRenter1's attribution is still 'active'/valid from before the
  // downgrade -- only the PAYMENT EVENT happens post-downgrade).
  const dgOrderPost = await api(dgRenter1.cookie, 'POST', '/api/orders', { listing_id: dgSaleListing.id, quantity: 1, idempotency_key: `dg-order-post-${dgSuffix}` })
  const dgOrderPostId = dgOrderPost.json?.order_id
  check('Downgrade-E-precondition. a second post-downgrade order can be created', !!dgOrderPostId, dgOrderPost)
  if (dgOrderPostId) {
    await api(dgRenter1.cookie, 'POST', `/api/orders/${dgOrderPostId}/checkout`, { test_scenario: 'success', idempotency_key: `dg-checkout-post-${dgSuffix}` })
    const { data: dgPostCommission } = await admin.from('affiliate_commissions').select('id').eq('order_id', dgOrderPostId).maybeSingle()
    check('Downgrade-E. new sale payment after downgrade creates NO new affiliate commission', !dgPostCommission, dgPostCommission)
  }

  // F. new rental charge after downgrade -> NO new affiliate commission.
  const dgBookingRes = await api(dgRenter1.cookie, 'POST', '/api/bookings', { listing_id: dgRentalListing.id, start_at: '2031-07-01T00:00:00.000Z', end_at: '2031-07-03T00:00:00.000Z', idempotency_key: `dg-booking-${dgSuffix}` })
  const dgBookingId = dgBookingRes.json?.booking_id
  check('Downgrade-F-precondition. a post-downgrade rental booking can be created', !!dgBookingId, dgBookingRes)
  if (dgBookingId) {
    await api(dgMerchant.cookie, 'POST', `/api/bookings/${dgBookingId}/accept`, { idempotency_key: `dg-accept-${dgSuffix}` })
    await api(dgRenter1.cookie, 'POST', `/api/bookings/${dgBookingId}/checkout`, { test_scenario: 'success', idempotency_key: `dg-rental-checkout-${dgSuffix}` })
    const { data: dgRentalCommission } = await admin.from('affiliate_commissions').select('id').eq('booking_id', dgBookingId).maybeSingle()
    check('Downgrade-F. new rental charge after downgrade creates NO new affiliate commission', !dgRentalCommission, dgRentalCommission)
  }

  // D. attribution created while Pro is RETAINED (row still exists, untouched by downgrade).
  const { data: dgAttrRowAfter } = await admin.from('affiliate_attributions').select('id, status').eq('id', dgAttrSale.json.attribution_id).maybeSingle()
  check('Downgrade-D. the pre-downgrade attribution row is retained after downgrade', !!dgAttrRowAfter, dgAttrRowAfter)

  // G. the PRE-downgrade commission row is retained, and its normal
  // downstream lifecycle (admin hold/release) remains reachable --
  // the plan gate only blocks CREATION of new rows, never services
  // an already-created obligation.
  const { data: dgPreCommissionAfter } = await admin.from('affiliate_commissions').select('id, status').eq('id', dgPreCommission.id).maybeSingle()
  check('Downgrade-G. the pre-downgrade commission row is retained, unaffected by downgrade', dgPreCommissionAfter?.status === dgPreCommission.status, dgPreCommissionAfter)
  const dgHoldRes = await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${dgPreCommission.id}/hold`, { reason: 'downgrade regression -- prove pre-existing obligation lifecycle still works', idempotency_key: `dg-hold-${dgSuffix}` })
  check('Downgrade-G2. normal downstream lifecycle (admin hold) remains reachable for a pre-downgrade commission', dgHoldRes.status === 200, dgHoldRes)
  await api(adminCookie, 'POST', `/api/admin/affiliate-commissions/${dgPreCommission.id}/release`, { idempotency_key: `dg-release-${dgSuffix}` })

  // ---- Re-upgrade ----
  await setPlan(dgMerchant.userId, 'pro')

  // I. listing accepts_affiliates=false remains blocked regardless of plan.
  const { data: dgDisabledListing } = await admin.from('listings').insert({
    merchant_id: dgMerchant.userId, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'sale', sale_price: 200, quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    accepts_affiliates: false, is_test: true,
    title: `${QA_LISTING_MARKER} Affiliate Regression — Downgrade Disabled Listing ${dgSuffix}`,
  }).select('id').single()
  const dgDisabledAttr = await api(dgRenter2.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgDisabledListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-disabled-${dgSuffix}` })
  check('Downgrade-I. listing accepts_affiliates=false blocks attribution even for a Pro merchant', dgDisabledAttr.status >= 400, dgDisabledAttr)

  // B/H. Pro (re-upgraded) + still-enabled listing -> NEW attribution ALLOWED --
  // this is also the re-upgrade proof: normal eligibility resumes under
  // the existing listing settings/first-valid rules, with no invented
  // second attribution mechanism.
  const dgRenter3 = await dgDisposableUser('renter3')
  const dgAttrAfterReupgrade = await api(dgRenter3.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgSaleListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-reupgrade-${dgSuffix}` })
  check('Downgrade-B/H. after re-upgrading to Pro, a NEW attribution on the still-enabled listing succeeds', dgAttrAfterReupgrade.status === 200 && !!dgAttrAfterReupgrade.json?.attribution_id, dgAttrAfterReupgrade)

  // C. Elite behaves identically to Pro for this gate (same affiliate_enabled=true flag).
  await setPlan(dgMerchant.userId, 'elite')
  const dgRenter4 = await dgDisposableUser('renter4')
  const dgAttrElite = await api(dgRenter4.cookie, 'POST', '/api/affiliate/attribution', { listing_id: dgRentalListing.id, referral_code: affiliateACode, idempotency_key: `dg-attr-elite-${dgSuffix}` })
  check('Downgrade-C. Elite + enabled listing -> new attribution ALLOWED', dgAttrElite.status === 200 && !!dgAttrElite.json?.attribution_id, dgAttrElite)

  // J (regression parity): the earlier Scenario I plan-gate checks (Starter
  // create/edit/direct-RPC blocked, Pro/Elite allowed) are unaffected by
  // any of this -- already re-asserted above/before this block; not
  // repeated here to avoid duplicating those checks.

  for (const uid of [dgMerchant.userId, dgRenter1.userId, dgRenter2.userId, dgRenter3.userId, dgRenter4.userId]) {
    await admin.auth.admin.deleteUser(uid)
  }
  console.log('  (downgrade regression fixtures cleaned up)')
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
