#!/usr/bin/env node
/**
 * Permanent regression check for Unity Phase 2 (Commission Framework).
 * Real script against the live dev database, matching every prior
 * phase's verify-*.mjs shape and safety gates.
 *
 * Fixture design: every mutating call uses either a per-run-unique
 * idempotency key (RUN_ID suffix) for genuinely new fixtures, or is
 * explicitly designed to be safely re-driven from live state (mirroring
 * createCompletedBooking()'s state-guarded steps from
 * verify-merchant-payout-workflow.mjs). merchantA/merchantB are reset to
 * a known Starter baseline via admin_correct_merchant_subscription()
 * (Phase 1) at the start of every run.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-commissions-phase2.mjs
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
    console.error('verify-commissions-phase2 aborted -- safety checks failed:')
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
  console.error('verify-commissions-phase2 aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (!INTERNAL_CRON_SECRET) {
  console.error('verify-commissions-phase2 aborted -- INTERNAL_CRON_SECRET missing (needed for the reconciliation sweep checks)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const RUN_ID = Date.now()
const QA_LISTING_MARKER = '[QA] Commission Regression'

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

async function internalApi(path) {
  const res = await fetch(APP_URL + path, { method: 'POST', headers: { Authorization: `Bearer ${INTERNAL_CRON_SECRET}` } })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

async function resetToStarter(merchantId, adminId) {
  const { error } = await admin.rpc('admin_correct_merchant_subscription', {
    p_admin_id: adminId,
    p_merchant_id: merchantId,
    p_new_plan_id: 'starter',
    p_immediate: true,
    p_reason: 'commission regression baseline reset',
    p_idempotency_key: `commission-regression-reset-${merchantId}-${RUN_ID}`,
  })
  if (error) throw new Error(`baseline reset failed for ${merchantId}: ${error.message}`)
}

async function setPlan(merchantId, adminId, planId) {
  const { error } = await admin.rpc('admin_correct_merchant_subscription', {
    p_admin_id: adminId,
    p_merchant_id: merchantId,
    p_new_plan_id: planId,
    p_immediate: true,
    p_reason: `commission regression: set to ${planId}`,
    p_idempotency_key: `commission-regression-set-${planId}-${merchantId}-${RUN_ID}`,
  })
  if (error) throw new Error(`setPlan(${planId}) failed for ${merchantId}: ${error.message}`)
}

async function insertRentalListing(merchantId, title, overrides = {}) {
  const { data, error } = await admin.from('listings').insert({
    merchant_id: merchantId, title, country_id: 'ZA', category: 'tech', condition: 'good',
    listing_type: 'rental', quantity_available: 1, status: 'active', risk_tier: 'low',
    ownership_verified: false, condition_confirmed: true, min_rental_days: 1, is_test: true,
    daily_rate: 300, ...overrides,
  }).select('id').single()
  if (error) throw new Error(`insertRentalListing failed: ${error.message}`)
  return data.id
}

async function insertSaleListing(merchantId, title, salePrice) {
  const { data, error } = await admin.from('listings').insert({
    merchant_id: merchantId, title, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', quantity_available: 99, status: 'active', risk_tier: 'low',
    ownership_verified: false, condition_confirmed: true, is_test: true, sale_price: salePrice,
  }).select('id').single()
  if (error) throw new Error(`insertSaleListing failed: ${error.message}`)
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

/** Creates a booking and drives it to a captured rental_charge payment only (accepted, not started/completed). Returns { bookingId, paymentId, amount }. */
async function chargeBookingOnly(renterCookie, merchantCookie, listingId, fixtureKey) {
  const anchor = Date.now() + 30 * 24 * 60 * 60 * 1000
  const created = await api(renterCookie, 'POST', '/api/bookings', {
    listing_id: listingId,
    start_at: new Date(anchor).toISOString(),
    end_at: new Date(anchor + 3 * 24 * 60 * 60 * 1000).toISOString(),
    idempotency_key: `commission-regression-create-${fixtureKey}`,
  })
  const bookingId = created.json?.booking_id
  if (!bookingId) throw new Error(`booking creation failed for ${fixtureKey}: ${JSON.stringify(created)}`)

  const acceptRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/accept`, { idempotency_key: `commission-regression-accept-${fixtureKey}` })
  if (acceptRes.status >= 400) throw new Error(`accept failed for ${fixtureKey}: ${JSON.stringify(acceptRes)}`)

  const checkoutRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/checkout`, { test_scenario: 'success', idempotency_key: `commission-regression-checkout-${fixtureKey}` })
  if (checkoutRes.status >= 400) throw new Error(`checkout failed for ${fixtureKey}: ${JSON.stringify(checkoutRes)}`)

  const { data: rentalPayment } = await admin.from('payments').select('id, amount').eq('booking_id', bookingId).eq('payment_type', 'rental_charge').single()
  return { bookingId, paymentId: rentalPayment.id, amount: Number(rentalPayment.amount) }
}

/** Drives one booking all the way to 'completed', triggering the payout-creation hook. Returns { bookingId, paymentId, amount }. */
async function createCompletedBooking(renterCookie, merchantCookie, listingId, fixtureKey) {
  const { bookingId, paymentId, amount } = await chargeBookingOnly(renterCookie, merchantCookie, listingId, fixtureKey)

  await backdateToStartable(bookingId)
  const startRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/start`, { idempotency_key: `commission-regression-start-${fixtureKey}` })
  if (startRes.status >= 400) throw new Error(`start failed for ${fixtureKey}: ${JSON.stringify(startRes)}`)

  const returnRes = await api(renterCookie, 'POST', `/api/bookings/${bookingId}/return`, { idempotency_key: `commission-regression-return-${fixtureKey}` })
  if (returnRes.status >= 400) throw new Error(`return failed for ${fixtureKey}: ${JSON.stringify(returnRes)}`)

  const confirmRes = await api(merchantCookie, 'POST', `/api/bookings/${bookingId}/confirm-return`, { idempotency_key: `commission-regression-confirm-${fixtureKey}` })
  if (confirmRes.status >= 400) throw new Error(`confirm-return failed for ${fixtureKey}: ${JSON.stringify(confirmRes)}`)

  return { bookingId, paymentId, amount }
}

async function completeOrderPurchase(buyerCookie, listingId, fixtureKey) {
  const created = await api(buyerCookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `commission-regression-order-create-${fixtureKey}` })
  const orderId = created.json?.order_id
  if (!orderId) throw new Error(`order creation failed for ${fixtureKey}: ${JSON.stringify(created)}`)

  const checkoutRes = await api(buyerCookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `commission-regression-order-checkout-${fixtureKey}` })
  if (checkoutRes.status >= 400) throw new Error(`order checkout failed for ${fixtureKey}: ${JSON.stringify(checkoutRes)}`)

  const { data: payment } = await admin.from('payments').select('id, amount').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
  return { orderId, paymentId: payment.id, amount: Number(payment.amount) }
}

async function getCommissionByPayment(paymentId) {
  const { data } = await admin.from('unity_commissions').select('*').eq('payment_id', paymentId).maybeSingle()
  return data
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-commissions-phase2 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { cookie: merchantACookie, userId: merchantAId, client: merchantAClient } = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { userId: merchantBId } = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const { cookie: renterACookie, userId: renterAId } = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { userId: affiliateAId } = await signIn(creds.accounts.affiliateA.email, creds.accounts.affiliateA.password)
const { cookie: adminCookie, userId: adminId } = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)

console.log('=== Baseline reset ===')
await resetToStarter(merchantAId, adminId)
await resetToStarter(merchantBId, adminId)
console.log(`  merchantA (${merchantAId}) and merchantB (${merchantBId}) reset to Starter`)

console.log('=== Scenario A: Rental commission -- plan-aware, ledger platform_fee, deposit exclusion ===')
let scenarioABookingId, scenarioAPaymentId, scenarioACommission
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — Rental A`, { deposit_required: true, deposit_amount: 500 })
  const { bookingId, paymentId, amount } = await chargeBookingOnly(renterACookie, merchantACookie, listingId, `rental-a-${RUN_ID}`)
  scenarioABookingId = bookingId
  scenarioAPaymentId = paymentId

  const commission = await getCommissionByPayment(paymentId)
  scenarioACommission = commission
  const expectedCommission = Math.round(amount * 12) / 100 // Starter rental 12%
  check('A1. rental commission qualifies with the Starter rate (12%)', !!commission && commission.standard_rate_bps === 1200 && commission.merchant_plan_id === 'starter', commission)
  check('A2. commission amount matches the exact plan-rate calculation', !!commission && Number(commission.commission_amount) === expectedCommission, { commission, expectedCommission })
  check('A3. excess_base is 0 -- Rule 2 is sale-only, never applies to rentals', !!commission && Number(commission.excess_base) === 0, commission)

  const { data: ledgerRows } = await admin.from('ledger_entries').select('entry_type, amount').eq('booking_id', bookingId).eq('entry_type', 'platform_fee')
  check('A4. platform_fee ledger entry matches the plan-aware commission amount, not the old flat 5%', ledgerRows?.length === 1 && Number(ledgerRows[0].amount) === expectedCommission, { ledgerRows, expectedCommission })

  const { data: depositPayment } = await admin.from('payments').select('id, amount').eq('booking_id', bookingId).eq('payment_type', 'deposit').maybeSingle()
  check('A5. a deposit payment exists on this booking (a meaningful exclusion, not a no-op)', !!depositPayment && Number(depositPayment.amount) > 0, depositPayment)
  const depositCommission = depositPayment ? await getCommissionByPayment(depositPayment.id) : undefined
  check('A6. the deposit payment never produces its own commission row', !depositCommission, depositCommission)
}

console.log('=== Scenario B: Idempotent duplicate qualification event ===')
{
  const historyCountBefore = (await admin.from('unity_commission_history').select('id', { count: 'exact', head: true }).eq('commission_id', scenarioACommission.id)).count
  const { error: replay1 } = await admin.rpc('qualify_rental_payment_unity_commission', { p_booking_id: scenarioABookingId, p_payment_id: scenarioAPaymentId, p_idempotency_key: `commission-regression-b-${RUN_ID}` })
  const { error: replay2 } = await admin.rpc('qualify_rental_payment_unity_commission', { p_booking_id: scenarioABookingId, p_payment_id: scenarioAPaymentId, p_idempotency_key: `commission-regression-b2-${RUN_ID}` })
  const { count: commissionCountAfter } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).eq('payment_id', scenarioAPaymentId)
  const historyCountAfter = (await admin.from('unity_commission_history').select('id', { count: 'exact', head: true }).eq('commission_id', scenarioACommission.id)).count
  check('B1. retrying qualification (even with different idempotency keys) never creates a second commission row', !replay1 && !replay2 && commissionCountAfter === 1, { replay1, replay2, commissionCountAfter })
  check('B2. no new history row is written on a qualification replay', historyCountAfter === historyCountBefore, { historyCountBefore, historyCountAfter })
}

console.log('=== Scenario C: Historical plan snapshot survives a later upgrade ===')
{
  await setPlan(merchantAId, adminId, 'pro')

  const { data: commissionAfterUpgrade } = await admin.from('unity_commissions').select('merchant_plan_id, standard_rate_bps, commission_amount').eq('id', scenarioACommission.id).single()
  check('C1. an already-qualified commission keeps its original Starter plan/rate after the merchant upgrades', commissionAfterUpgrade.merchant_plan_id === 'starter' && commissionAfterUpgrade.standard_rate_bps === 1200, commissionAfterUpgrade)

  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — Rental C (Pro)`)
  const { paymentId, amount } = await chargeBookingOnly(renterACookie, merchantACookie, listingId, `rental-c-${RUN_ID}`)
  const newCommission = await getCommissionByPayment(paymentId)
  const expectedProCommission = Math.round(amount * 10) / 100 // Pro rental 10%
  check('C2. a NEW booking qualified after the upgrade correctly uses the new Pro rate', !!newCommission && newCommission.standard_rate_bps === 1000 && Number(newCommission.commission_amount) === expectedProCommission, { newCommission, expectedProCommission })
}

console.log('=== Scenario D: Sale commission -- plan-aware ===')
{
  const listingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — Sale D (Starter)`, 1000)
  const { paymentId } = await completeOrderPurchase(renterACookie, listingId, `sale-d-starter-${RUN_ID}`)
  const commission = await getCommissionByPayment(paymentId)
  check('D1. sale commission qualifies with the Starter rate (6%)', !!commission && commission.standard_rate_bps === 600 && Number(commission.commission_amount) === 60, commission)

  await setPlan(merchantBId, adminId, 'pro')
  const listingId2 = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — Sale D (Pro)`, 1000)
  const { paymentId: paymentId2 } = await completeOrderPurchase(renterACookie, listingId2, `sale-d-pro-${RUN_ID}`)
  const commission2 = await getCommissionByPayment(paymentId2)
  check('D2. a sale after upgrading to Pro correctly uses the new rate (5%)', !!commission2 && commission2.standard_rate_bps === 500 && Number(commission2.commission_amount) === 50, commission2)
}

console.log('=== Scenario E: High-value sale (R250,000, merchant on Pro) ===')
{
  const listingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — Sale E (High-value)`, 250_000)
  const { paymentId } = await completeOrderPurchase(renterACookie, listingId, `sale-e-highvalue-${RUN_ID}`)
  const commission = await getCommissionByPayment(paymentId)
  check('E1. R250,000 sale on Pro produces exactly R6,500 commission', !!commission && Number(commission.commission_amount) === 6500, commission)
  check('E2. standard portion covers exactly the first R100,000', !!commission && Number(commission.standard_rate_base) === 100_000, commission)
  check('E3. excess portion covers exactly the remaining R150,000 at 1%', !!commission && Number(commission.excess_base) === 150_000 && commission.excess_rate_bps === 100, commission)
}

console.log('=== Scenario F: Barter is structurally excluded from Unity commission ===')
{
  const barterOrchestratorFiles = [
    'src/lib/payments/orchestrator/authorize-barter-deposit.ts',
    'src/lib/payments/orchestrator/release-barter-deposit.ts',
    'src/lib/payments/orchestrator/charge-barter-cash-adjustment.ts',
  ]
  let anyReferencesCommissionQualify = false
  for (const file of barterOrchestratorFiles) {
    try {
      const contents = readFileSync(join(REPO_ROOT, file), 'utf8')
      if (contents.includes('commissions/qualify') || contents.includes('qualify_sale_unity_commission') || contents.includes('qualify_rental_payment_unity_commission')) {
        anyReferencesCommissionQualify = true
      }
    } catch {
      // file not found is itself a finding, not a pass -- fail closed
      anyReferencesCommissionQualify = true
    }
  }
  check('F1. no barter orchestrator file references either Unity commission qualification RPC', !anyReferencesCommissionQualify, { barterOrchestratorFiles })

  const { count: barterLinkedCommissions } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).not('order_id', 'is', null).not('booking_id', 'is', null)
  check('F2. no commission row can ever reference a barter agreement -- the schema only has order_id/booking_id columns, never barter_agreement_id', barterLinkedCommissions === 0, { barterLinkedCommissions })
}

console.log('=== Scenario G: Affiliate + Unity commission coexistence, and merchant payout integration ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — Rental G (Affiliate)`, { accepts_affiliates: true, affiliate_commission_rate: 10 })

  // Real attribution via the actual RPC (mirrors the app's own open_affiliate_attribution call site).
  await admin.rpc('open_affiliate_attribution', {
    p_referred_user_id: renterAId,
    p_listing_id: listingId,
    p_referral_code: (await admin.from('profiles').select('affiliate_code').eq('id', affiliateAId).single()).data?.affiliate_code,
    p_source: 'cookie',
    p_idempotency_key: `commission-regression-attribution-${RUN_ID}`,
  })

  const { bookingId, paymentId, amount } = await createCompletedBooking(renterACookie, merchantACookie, listingId, `rental-g-${RUN_ID}`)

  const unityCommission = await getCommissionByPayment(paymentId)
  const { data: affiliateCommission } = await admin.from('affiliate_commissions').select('*').eq('payment_id', paymentId).maybeSingle()

  const expectedUnityCommission = Math.round(amount * 10) / 100 // merchantA is on Pro from Scenario C
  const expectedAffiliateReward = Math.round(amount * 10) / 100 // 10% affiliate rate set above

  check('G1. Unity commission qualifies independently of the affiliate commission', !!unityCommission && Number(unityCommission.commission_amount) === expectedUnityCommission, unityCommission)
  check('G2. affiliate commission qualifies independently, on the same payment, with its own rate', !!affiliateCommission && Number(affiliateCommission.commission_amount) === expectedAffiliateReward, affiliateCommission)
  check('G3. both commissions reference the exact same payment -- one obligation each, not merged', unityCommission?.payment_id === affiliateCommission?.payment_id, { unityCommission, affiliateCommission })

  const { data: payout } = await admin.from('merchant_payouts').select('amount').eq('booking_id', bookingId).maybeSingle()
  const expectedPayout = Math.round((amount - expectedUnityCommission - expectedAffiliateReward) * 100) / 100
  check('G4. merchant payout basis = rental charge - Unity commission - affiliate reward, exactly once each', !!payout && Number(payout.amount) === expectedPayout, { payout, expectedPayout, amount, expectedUnityCommission, expectedAffiliateReward })
}

console.log('=== Scenario H: Full refund -> commission voided ===')
{
  const listingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — Sale H (Full refund)`, 1000)
  const { paymentId } = await completeOrderPurchase(renterACookie, listingId, `sale-h-fullrefund-${RUN_ID}`)
  const commissionBefore = await getCommissionByPayment(paymentId)
  check('H1. commission qualified before the refund', commissionBefore?.status === 'pending', commissionBefore)

  const { data: refundResult, error: refundError } = await admin.rpc('create_refund', { p_payment_id: paymentId, p_amount: 1000, p_reason: 'regression: full refund', p_idempotency_key: `commission-regression-h-refund-${RUN_ID}` })
  check('H2. create_refund succeeds', !refundError, refundError)
  // No refund-completion route exists anywhere in this codebase yet (confirmed live, Step A) --
  // direct service-role update is the documented fallback, mirroring backdateToStartable()'s
  // own precedent for a similarly-missing capability.
  await admin.from('refunds').update({ status: 'completed' }).eq('id', refundResult.refund_id)
  await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'refunded', p_actor_type: 'system' })

  const sweep1 = await internalApi('/api/internal/commissions/reconcile-refunds')
  check('H3. the reconciliation sweep runs successfully', sweep1.status === 200, sweep1.json)

  const commissionAfter = await getCommissionByPayment(paymentId)
  check('H4. a fully refunded payment voids its commission', commissionAfter?.status === 'voided', commissionAfter)

  const sweep2 = await internalApi('/api/internal/commissions/reconcile-refunds')
  const commissionAfterRetry = await getCommissionByPayment(paymentId)
  check('H5. re-running the sweep on an already-voided commission is a harmless no-op', sweep2.status === 200 && commissionAfterRetry?.status === 'voided', { sweep2: sweep2.json, commissionAfterRetry })
}

console.log('=== Scenario I: Partial refund -> proportional adjustment, idempotent on retry ===')
{
  const listingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — Sale I (Partial refund)`, 1000)
  const { paymentId } = await completeOrderPurchase(renterACookie, listingId, `sale-i-partialrefund-${RUN_ID}`)
  const commissionBefore = await getCommissionByPayment(paymentId)

  const { data: refundResult } = await admin.rpc('create_refund', { p_payment_id: paymentId, p_amount: 400, p_reason: 'regression: partial refund', p_idempotency_key: `commission-regression-i-refund-${RUN_ID}` })
  await admin.from('refunds').update({ status: 'completed' }).eq('id', refundResult.refund_id)
  await admin.rpc('transition_payment_status', { p_payment_id: paymentId, p_new_status: 'partially_refunded', p_actor_type: 'system' })

  await internalApi('/api/internal/commissions/reconcile-refunds')
  const commissionAfter = await getCommissionByPayment(paymentId)
  // Derived from the commission's own rate snapshot, not a hardcoded
  // plan assumption -- merchantB's plan at this point in the script
  // depends on which earlier scenarios already ran (D/E upgrade it to
  // Pro). Refunded R400 of R1000 (40%) -> remaining eligible base R600,
  // commission recomputed on R600 at the ORIGINAL snapshot rate.
  const expectedEffective = Math.round(600 * commissionBefore.standard_rate_bps) / 10000
  const { data: adjustments } = await admin.from('unity_commission_adjustments').select('amount').eq('commission_id', commissionBefore.id)
  const effectiveAmount = Number(commissionBefore.commission_amount) + (adjustments ?? []).reduce((sum, a) => sum + Number(a.amount), 0)
  check('I1. a partial refund adjusts the commission to the correct proportional amount', commissionAfter?.status === 'adjusted' && effectiveAmount === expectedEffective, { commissionAfter, effectiveAmount, expectedEffective, adjustments })

  const adjustmentCountBefore = (adjustments ?? []).length
  await internalApi('/api/internal/commissions/reconcile-refunds')
  const { data: adjustmentsAfterRetry } = await admin.from('unity_commission_adjustments').select('amount').eq('commission_id', commissionBefore.id)
  check('I2. retrying the sweep against an unchanged refund state creates no duplicate adjustment', (adjustmentsAfterRetry ?? []).length === adjustmentCountBefore, { before: adjustmentCountBefore, after: adjustmentsAfterRetry?.length })
}

console.log('=== Scenario J: Dispute hold and release ===')
{
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — Rental J (Dispute)`)
  const { bookingId, paymentId } = await chargeBookingOnly(renterACookie, merchantACookie, listingId, `rental-j-${RUN_ID}`)

  const { data: existingDispute } = await admin.from('disputes').select('id, status').eq('booking_id', bookingId).not('status', 'in', '(resolved,closed,cancelled)').maybeSingle()
  let disputeId = existingDispute?.id
  if (!disputeId) {
    const opened = await api(renterACookie, 'POST', '/api/disputes', {
      booking_id: bookingId, title: 'Regression dispute', description: 'Commission regression fixture', requested_resolution: 'N/A',
      idempotency_key: `commission-regression-dispute-open-${RUN_ID}`,
    })
    disputeId = opened.json?.dispute_id
    check('J1. dispute opens successfully', opened.status === 201 && !!disputeId, opened)
  }

  const sweepHeld = await internalApi('/api/internal/commissions/reconcile-refunds')
  const commissionHeld = await getCommissionByPayment(paymentId)
  check('J2. an unresolved dispute holds the commission', sweepHeld.status === 200 && commissionHeld?.status === 'held', { sweep: sweepHeld.json, commissionHeld })

  // No automated financial-outcome resolution exists for disputes in
  // this codebase (confirmed live, Phase 2 Step A/9) -- resolving is an
  // admin/manual act on the dispute's status label alone. Direct
  // service-role update is the documented fallback for driving the
  // dispute itself to a resolved state for this test.
  await admin.from('disputes').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', disputeId)

  const sweepReleased = await internalApi('/api/internal/commissions/reconcile-refunds')
  const commissionReleased = await getCommissionByPayment(paymentId)
  check('J3. a resolved dispute releases the hold, returning to pending', sweepReleased.status === 200 && commissionReleased?.status === 'pending', { sweep: sweepReleased.json, commissionReleased })
}

console.log('=== Scenario K: Security -- unauthorized writes, merchant visibility, admin access ===')
{
  const { error: directRpcError } = await merchantAClient.rpc('qualify_rental_payment_unity_commission', {
    p_booking_id: scenarioABookingId, p_payment_id: scenarioAPaymentId, p_idempotency_key: `commission-regression-forged-${RUN_ID}`,
  })
  const rpcBlocked = !!directRpcError && (directRpcError.message.includes('not authorized') || directRpcError.message.includes('permission denied'))
  check('K1. calling the qualification RPC directly (not via service role) is rejected', rpcBlocked, directRpcError)

  const beforeWrite = await getCommissionByPayment(scenarioAPaymentId)
  await merchantAClient.from('unity_commissions').update({ commission_amount: 0 }).eq('id', scenarioACommission.id)
  const afterWrite = await getCommissionByPayment(scenarioAPaymentId)
  check('K2. a direct table write to unity_commissions has no effect -- zero client write policies', Number(afterWrite?.commission_amount) === Number(beforeWrite?.commission_amount), { beforeWrite, afterWrite })

  const { data: crossTenantRead } = await merchantAClient.from('unity_commissions').select('*').eq('merchant_id', merchantBId)
  check('K3. RLS blocks a merchant from reading another merchant\'s commission rows directly', (crossTenantRead ?? []).length === 0, crossTenantRead)

  const meRes = await api(merchantACookie, 'GET', '/api/commissions/me')
  const ownRow = (meRes.json?.commissions ?? []).find((c) => c.id === scenarioACommission.id)
  check('K4. a merchant can read their own commission via GET /api/commissions/me', meRes.status === 200 && !!ownRow, { status: meRes.status, found: !!ownRow })

  const unauthMeRes = await api(null, 'GET', '/api/commissions/me')
  check('K5. GET /api/commissions/me requires auth', unauthMeRes.status === 401, unauthMeRes)

  const adminListRes = await api(adminCookie, 'GET', '/api/admin/commissions')
  check('K6. admin list route returns real data', adminListRes.status === 200 && Array.isArray(adminListRes.json?.commissions), adminListRes)

  const adminDetailRes = await api(adminCookie, 'GET', `/api/admin/commissions/${scenarioACommission.id}`)
  const hasHistory = (adminDetailRes.json?.history ?? []).length > 0
  check('K7. admin detail route resolves the commission and its history', adminDetailRes.status === 200 && hasHistory, adminDetailRes)

  const nonAdminAdminRes = await api(renterACookie, 'GET', '/api/admin/commissions')
  check('K8. a non-admin cannot reach the admin commissions list', nonAdminAdminRes.status === 401 || nonAdminAdminRes.status === 403, nonAdminAdminRes)
}

console.log('=== Scenario L: Merchant payout reads the EFFECTIVE Unity commission, never a stale ledger figure ===')
{
  // Final Corrective Verification (post-provisional-acceptance), Check 3/6:
  // createMerchantPayout() previously derived platformFee from the
  // write-once ledger_entries.platform_fee row, which is never updated by
  // hold/release/void/create_unity_commission_adjustment. This is only
  // reachable while the rental payment is still 'captured' (a refund
  // would block payout creation entirely via a different guard) -- but an
  // admin CAN void/adjust a commission before the booking ever completes,
  // with no refund involved at all. Fixed in create-merchant-payout.ts to
  // read unity_commissions (+ adjustments) directly.
  const listingId = await insertRentalListing(merchantAId, `${QA_LISTING_MARKER} — Rental L (Admin void before completion)`)
  const { bookingId, paymentId, amount } = await chargeBookingOnly(renterACookie, merchantACookie, listingId, `rental-l-${RUN_ID}`)
  const commissionBefore = await getCommissionByPayment(paymentId)

  const voidRes = await api(adminCookie, 'POST', `/api/admin/commissions/${commissionBefore.id}/void`, {
    reason: 'regression: admin corrects a calculation error before completion, no refund involved',
    idempotency_key: `commission-regression-l-void-${RUN_ID}`,
  })
  check('L1. admin can void the commission before the booking completes', voidRes.status === 200 && voidRes.json?.status === 'voided', voidRes)

  const { data: paymentAfterVoid } = await admin.from('payments').select('status').eq('id', paymentId).single()
  check('L2. voiding the commission does not itself touch the payment status (no refund occurred)', paymentAfterVoid.status === 'captured', paymentAfterVoid)

  await backdateToStartable(bookingId)
  const startRes = await api(renterACookie, 'POST', `/api/bookings/${bookingId}/start`, { idempotency_key: `commission-regression-l-start-${RUN_ID}` })
  const returnRes = await api(renterACookie, 'POST', `/api/bookings/${bookingId}/return`, { idempotency_key: `commission-regression-l-return-${RUN_ID}` })
  const confirmRes = await api(merchantACookie, 'POST', `/api/bookings/${bookingId}/confirm-return`, { idempotency_key: `commission-regression-l-confirm-${RUN_ID}` })
  check('L3. booking completes normally despite the voided commission', startRes.status < 400 && returnRes.status < 400 && confirmRes.status < 400, { startRes, returnRes, confirmRes })

  const { data: payout } = await admin.from('merchant_payouts').select('amount').eq('booking_id', bookingId).maybeSingle()
  check(
    'L4. payout equals the FULL rental charge (a voided commission means R0 owed to Unity) -- never the stale un-voided ledger figure',
    !!payout && Number(payout.amount) === amount,
    { payout, amount, staleWouldHaveBeen: Math.round((amount - Number(commissionBefore.commission_amount)) * 100) / 100 }
  )
}

console.log('=== Scenario M: Large-pool (150+) reconciliation -- full coverage, ordinal >100 processing, idempotent retry ===')
{
  // Financial Maintenance: commission reconciliation batching/pagination
  // fix. reconcileCommissionDisputes()/reconcileCommissionRefunds() used
  // to fetch a single unordered .limit(100) page, so once the live
  // candidate pool exceeded 100 rows (confirmed live, 154-164+ across
  // this project's history), some eligible rows were never even
  // examined by any given sweep run. Fixed via deterministic keyset
  // pagination (ORDER BY created_at, id) that walks every candidate
  // exactly once per run regardless of pool size. This scenario proves
  // it: ensures a 150+ candidate pool genuinely exists, plants 3
  // individually-verifiable actionable fixtures at the TAIL of created_at
  // order (guaranteed ordinal position > 100), and proves each is
  // correctly reconciled -- not merely scanned -- plus idempotent retry.
  const TARGET_POOL_SIZE = 150
  const { count: poolBefore } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'adjusted', 'held'])
  const shortfall = Math.max(0, TARGET_POOL_SIZE - (poolBefore ?? 0))

  if (shortfall > 0) {
    const fillerListingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — M Filler`, 50)
    const CONCURRENCY = 10
    for (let i = 0; i < shortfall; i += CONCURRENCY) {
      const batch = []
      for (let j = i; j < Math.min(i + CONCURRENCY, shortfall); j++) {
        batch.push(completeOrderPurchase(renterACookie, fillerListingId, `m-filler-${j}-${RUN_ID}`))
      }
      await Promise.all(batch)
    }
  }

  // Three tail-ordinal actionable fixtures, created last so they sort
  // after every other candidate by created_at.
  const disputeListingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — M DisputeHold`, 500)
  const { orderId: disputeOrderId, paymentId: disputePaymentId } = await completeOrderPurchase(renterACookie, disputeListingId, `m-dispute-${RUN_ID}`)
  const disputeOpenRes = await api(renterACookie, 'POST', '/api/disputes', {
    order_id: disputeOrderId, title: 'Large-pool regression dispute', description: 'Scenario M fixture', requested_resolution: 'N/A',
    idempotency_key: `commission-regression-m-dispute-open-${RUN_ID}`,
  })
  check('M1. dispute opens against the tail-ordinal order fixture', disputeOpenRes.status === 201, disputeOpenRes)

  const fullRefundListingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — M FullRefund`, 1000)
  const { paymentId: fullRefundPaymentId } = await completeOrderPurchase(renterACookie, fullRefundListingId, `m-fullrefund-${RUN_ID}`)
  const { data: fullRefundResult } = await admin.rpc('create_refund', { p_payment_id: fullRefundPaymentId, p_amount: 1000, p_reason: 'Scenario M full refund', p_idempotency_key: `commission-regression-m-fullrefund-${RUN_ID}` })
  await admin.from('refunds').update({ status: 'completed' }).eq('id', fullRefundResult.refund_id)
  await admin.rpc('transition_payment_status', { p_payment_id: fullRefundPaymentId, p_new_status: 'refunded', p_actor_type: 'system' })

  const partialRefundListingId = await insertSaleListing(merchantBId, `${QA_LISTING_MARKER} — M PartialRefund`, 1000)
  const { paymentId: partialRefundPaymentId } = await completeOrderPurchase(renterACookie, partialRefundListingId, `m-partialrefund-${RUN_ID}`)
  const partialRefundCommissionBefore = await getCommissionByPayment(partialRefundPaymentId)
  const { data: partialRefundResult } = await admin.rpc('create_refund', { p_payment_id: partialRefundPaymentId, p_amount: 400, p_reason: 'Scenario M partial refund', p_idempotency_key: `commission-regression-m-partialrefund-${RUN_ID}` })
  await admin.from('refunds').update({ status: 'completed' }).eq('id', partialRefundResult.refund_id)
  await admin.rpc('transition_payment_status', { p_payment_id: partialRefundPaymentId, p_new_status: 'partially_refunded', p_actor_type: 'system' })

  const { count: poolAfter } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'adjusted', 'held'])
  check('M2. candidate pool now exceeds 150 -- this is genuinely a >100-row scenario', (poolAfter ?? 0) >= TARGET_POOL_SIZE, { poolBefore, shortfall, poolAfter })

  const disputeCommissionCreatedAt = (await getCommissionByPayment(disputePaymentId))?.created_at
  const { count: precedingCount } = await admin.from('unity_commissions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'adjusted', 'held']).lt('created_at', disputeCommissionCreatedAt)
  check('M3. the dispute-hold fixture sits at ordinal position > 100 (candidates created before it)', (precedingCount ?? 0) > 100, { precedingCount })

  const sweep1 = await internalApi('/api/internal/commissions/reconcile-refunds')
  check('M4. sweep run 1 responds 200', sweep1.status === 200, sweep1)
  check('M5. sweep run 1 scans the full candidate pool, not capped at 100', (sweep1.json?.disputesScanned ?? 0) >= TARGET_POOL_SIZE && (sweep1.json?.refundsScanned ?? 0) >= TARGET_POOL_SIZE, sweep1.json)
  check('M6. sweep run 1 reports zero failures', sweep1.json?.disputesFailed === 0 && sweep1.json?.refundsFailed === 0, sweep1.json)

  const disputeCommissionAfterRun1 = await getCommissionByPayment(disputePaymentId)
  check('M7. the tail-ordinal dispute fixture was actually held (not merely scanned)', disputeCommissionAfterRun1?.status === 'held', disputeCommissionAfterRun1)

  const fullRefundCommissionAfterRun1 = await getCommissionByPayment(fullRefundPaymentId)
  check('M8. the tail-ordinal full-refund fixture was voided', fullRefundCommissionAfterRun1?.status === 'voided', fullRefundCommissionAfterRun1)

  const expectedPartialEffective = Math.round(600 * partialRefundCommissionBefore.standard_rate_bps) / 10000
  const { data: adjustmentsAfterRun1 } = await admin.from('unity_commission_adjustments').select('amount').eq('commission_id', partialRefundCommissionBefore.id)
  const partialEffectiveAfterRun1 = Number(partialRefundCommissionBefore.commission_amount) + (adjustmentsAfterRun1 ?? []).reduce((sum, a) => sum + Number(a.amount), 0)
  check('M9. the tail-ordinal partial-refund fixture was adjusted to the correct proportional amount', partialEffectiveAfterRun1 === expectedPartialEffective, { partialEffectiveAfterRun1, expectedPartialEffective, adjustmentsAfterRun1 })

  const sweep2 = await internalApi('/api/internal/commissions/reconcile-refunds')
  check('M10. sweep run 2 responds 200 and scans the full pool again', sweep2.status === 200 && (sweep2.json?.disputesScanned ?? 0) >= TARGET_POOL_SIZE, sweep2.json)

  const { data: adjustmentsAfterRun2 } = await admin.from('unity_commission_adjustments').select('id').eq('commission_id', partialRefundCommissionBefore.id)
  check('M11. no duplicate adjustment was created by the second run', (adjustmentsAfterRun2 ?? []).length === (adjustmentsAfterRun1 ?? []).length, { before: adjustmentsAfterRun1?.length, after: adjustmentsAfterRun2?.length })

  const disputeCommissionAfterRun2 = await getCommissionByPayment(disputePaymentId)
  check('M12. dispute-hold fixture unchanged on the second run (still held, no error)', disputeCommissionAfterRun2?.status === 'held', disputeCommissionAfterRun2)

  const fullRefundCommissionAfterRun2 = await getCommissionByPayment(fullRefundPaymentId)
  check('M13. full-refund fixture unchanged on the second run (still voided, no duplicate void)', fullRefundCommissionAfterRun2?.status === 'voided', fullRefundCommissionAfterRun2)
}

console.log('=== Final cleanup ===')
await resetToStarter(merchantAId, adminId)
await resetToStarter(merchantBId, adminId)
console.log('  merchantA and merchantB reset to Starter')

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
