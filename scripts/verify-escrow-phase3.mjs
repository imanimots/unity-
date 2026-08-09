#!/usr/bin/env node
/**
 * Permanent regression check for Phase 3 (Escrow Architecture / TradeSafe
 * Readiness). Real script against the live dev database, matching every
 * prior phase's regression-script convention (verify-order-
 * administration.mjs, verify-dispute-payout-recovery.mjs).
 *
 * Corrective verification (item G): this script previously SKIPPED its
 * safe-by-default proof whenever it happened to run against a server
 * with ESCROW_ENABLED=true, because ESCROW_ENABLED is a process-level
 * flag this script cannot toggle mid-run. Feature-flag safety may never
 * be an ambiguous skip, so that proof now runs as an ISOLATED,
 * deterministic subprocess (`npx vitest run` against
 * src/lib/escrow/__tests__/orchestrator.test.ts and
 * production-safety.test.ts) -- real module imports with controlled
 * env vars, no dependency on the live server's ambient configuration.
 * It always produces a real PASS/FAIL, on every run, regardless of how
 * the dev server happens to be configured.
 *
 * The remaining scenarios (B-H: creation, funding, release on
 * completion, dispute-freeze, admin refund/cancel, webhook dedup,
 * idempotent replay) genuinely require a live server with
 * ESCROW_ENABLED=true -- these exercise real HTTP/DB integration an
 * isolated unit test cannot reach. Per the corrective instruction, none
 * of these may be silently skipped either: if the live server isn't
 * configured for it, the script now FAILS LOUDLY (non-zero exit, clear
 * diagnostic) instead of downgrading them to a skip.
 *
 * SAFETY: same gate as every other verify-*.mjs script -- refuses to
 * run unless QA_SEED_ENABLED=true, QA_SEED_CONFIRM=UNITY_DEV_ONLY, and
 * QA_SEED_PROJECT_REF matches the live project.
 *
 * Usage:
 *   ESCROW_ENABLED=true npm run dev   (in one terminal)
 *   node scripts/verify-escrow-phase3.mjs   (in another)
 * Requires scripts/qa-seed.mjs already run once (for QA accounts + admin).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
    console.error('verify-escrow-phase3 aborted -- safety checks failed:')
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
  console.error('verify-escrow-phase3 aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA] Escrow Phase 3'
const RUN_ID = Date.now()

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
    listing_type: 'sale', quantity_available: 99, status: 'active', is_test: true,
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

// No skip() helper -- item G corrective fix removed every ambiguous
// skip from this script. Every scenario now either produces a
// deterministic PASS/FAIL from a dedicated fixture, or the script fails
// its own precondition loudly (see the ESCROW_ENABLED probe below).
let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-escrow-phase3 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)

// ── Migration presence check ──
console.log('=== Schema check: Phase 3 tables/RPCs exist ===')
{
  const { error: tableErr } = await admin.from('escrow_transactions').select('id').limit(1)
  check('escrow_transactions table exists and is queryable', !tableErr, tableErr)
  const { error: historyErr } = await admin.from('escrow_transaction_history').select('id').limit(1)
  check('escrow_transaction_history table exists and is queryable', !historyErr, historyErr)
  const { error: eventsErr } = await admin.from('escrow_provider_events').select('id').limit(1)
  check('escrow_provider_events table exists and is queryable', !eventsErr, eventsErr)
}

if (failures > 0) {
  console.error('\nSchema checks failed -- migrations 20260825000001..20260825000005 are likely not applied yet. Aborting before fixture creation.')
  process.exit(1)
}

// ── Scenario A: safe-by-default + production-mock-fail-closed ──
// Always run, regardless of the live server's own ESCROW_ENABLED state
// -- isolated subprocess, real module imports, controlled env vars. No
// ambient dependency, so this always produces a real PASS/FAIL, never a
// skip (item G corrective fix).
console.log('=== Scenario A: safe-by-default + production mock fail-closed (isolated, deterministic) ===')
{
  const vitestResult = spawnSync(
    'npx',
    ['vitest', 'run', 'src/lib/escrow/__tests__/orchestrator.test.ts', 'src/lib/escrow/__tests__/production-safety.test.ts', 'src/lib/env/__tests__/validate.test.ts'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
  const vitestOutput = `${vitestResult.stdout ?? ''}\n${vitestResult.stderr ?? ''}`
  // vitest's exit code is the sole authoritative signal (0 iff every
  // test in every listed file passed) -- its default reporter's summary
  // output does not print individual file paths, so asserting on
  // filenames in the text was a check-authoring bug, not a product bug
  // (caught on the first corrective-pass run: exit code 0, i.e. all 25
  // tests genuinely passed, while a since-removed filename regex
  // incorrectly reported FAIL).
  const vitestPassed = vitestResult.status === 0
  check('A1. safe-by-default: escrow orchestrator functions are no-ops (never touch the DB) while ESCROW_ENABLED is not "true"', vitestPassed, { exitCode: vitestResult.status })
  check('A2. production + mock (default or explicitly named) throws EscrowProviderConfigurationError -- getEscrowProvider() is the one central guard, cannot be bypassed by a caller-supplied provider name', vitestPassed, { exitCode: vitestResult.status })
  check('A3. production + tradesafe is unaffected by the guard -- UnsupportedTradeSafeProvider remains unsupported on its own terms in every environment', vitestPassed, { exitCode: vitestResult.status })
  check('A4. env validator flags NODE_ENV=production + ESCROW_ENABLED=true + ESCROW_PROVIDER=mock as a critical failure (defense in depth)', vitestPassed, { exitCode: vitestResult.status })
  if (!vitestPassed) {
    console.error('  --- isolated vitest output ---')
    console.error(vitestOutput.slice(0, 2000))
  }
}

// ── Probe: is ESCROW_ENABLED=true on the running dev server? ──
// Scenarios B-H genuinely require live HTTP/DB integration an isolated
// unit test cannot reach. If the running server isn't configured for
// it, this is now a hard FAILURE of the script's own precondition --
// never a silent downgrade to skip (item G corrective fix: core
// behavior must not silently skip).
console.log('=== Probing live ESCROW_ENABLED state ===')
let escrowLive = false
let probeOrderId = null
let probePaymentId = null
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Probe`, category: 'tools', sale_price: 500 })
  const created = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `escrow-probe-create-${RUN_ID}` })
  probeOrderId = created.json?.order_id ?? created.json?.id
  if (probeOrderId) {
    await api(renterA.cookie, 'POST', `/api/orders/${probeOrderId}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-probe-checkout-${RUN_ID}` })
    const { data: payment } = await admin.from('payments').select('id').eq('order_id', probeOrderId).eq('payment_type', 'order_payment').maybeSingle()
    probePaymentId = payment?.id ?? null
    if (probePaymentId) {
      const { data: escrowRow } = await admin.from('escrow_transactions').select('id, status').eq('payment_id', probePaymentId).maybeSingle()
      escrowLive = !!escrowRow
    }
  }
  console.log(`  escrow appears to be ${escrowLive ? 'ENABLED' : 'DISABLED'} on the running dev server`)
}

if (!escrowLive) {
  console.error('')
  console.error('FAIL: Scenarios B-H (creation, funding, release, dispute-freeze, admin')
  console.error('overrides, webhook dedup, idempotent replay) require a live server with')
  console.error('ESCROW_ENABLED=true. This is a precondition failure, not an optional skip --')
  console.error('restart the dev server with ESCROW_ENABLED=true and re-run this script.')
  console.error('')
  failures++
  console.log(`${failures} CHECK(S) FAILED (core lifecycle scenarios could not run -- see above)`)
  process.exit(1)
}

// ── Full lifecycle (only reached when escrow is live) ──
console.log('=== Scenario B: escrow creation + funding mirrors the underlying payment ===')
{
  const { data: escrow } = await admin.from('escrow_transactions').select('*').eq('payment_id', probePaymentId).single()
  const { data: payment } = await admin.from('payments').select('amount, currency').eq('id', probePaymentId).single()
  check('B1. escrow was created for the order payment', !!escrow, escrow)
  check('B2. escrow reached funded status after capture', escrow?.status === 'funded', escrow)
  check('B3. principal_amount exactly matches the payment amount (never a commission-adjusted figure)', Number(escrow?.principal_amount) === Number(payment?.amount), { escrow, payment })
  check('B4. secure_transaction_fee_amount is tracked separately from principal (never summed in)', escrow?.secure_transaction_fee_amount === 0, escrow)
  check('B5. provider is "mock" -- no live TradeSafe call was ever made', escrow?.provider === 'mock', escrow)
}

console.log('=== Scenario C: release on order delivery ===')
{
  const shipRes = await api(merchantA.cookie, 'POST', `/api/orders/${probeOrderId}/ship`, { idempotency_key: `escrow-c-ship-${RUN_ID}` })
  check('C0. order can be shipped (fixture setup)', shipRes.status === 200, shipRes)
  const deliverRes = await api(renterA.cookie, 'POST', `/api/orders/${probeOrderId}/confirm-delivery`, { idempotency_key: `escrow-c-deliver-${RUN_ID}` })
  check('C0b. order delivery confirms successfully (fixture setup)', deliverRes.status === 200, deliverRes)
  const { data: escrow } = await admin.from('escrow_transactions').select('status, released_to, released_at').eq('payment_id', probePaymentId).single()
  const { data: order } = await admin.from('orders').select('seller_id').eq('id', probeOrderId).single()
  check('C1. escrow was released on delivery confirmation', escrow?.status === 'released', escrow)
  check('C2. released_to is the seller (never the buyer, never a client-asserted value)', escrow?.released_to === order?.seller_id, { escrow, order })
  check('C3. released_at is set', !!escrow?.released_at, escrow)

  const { data: history } = await admin.from('escrow_transaction_history').select('*').eq('escrow_transaction_id', (await admin.from('escrow_transactions').select('id').eq('payment_id', probePaymentId).single()).data.id).order('created_at', { ascending: true })
  const releasedRow = (history ?? []).find((h) => h.new_status === 'released')
  check('C4. an immutable history row records the release with actor_type=system', releasedRow?.actor_type === 'system', releasedRow)
}

console.log('=== Scenario D: dispute freezes release; resolution alone is never sufficient -- the underlying transaction must also have genuinely completed ===')
{
  // D-not-delivered: order is only 'shipped' (never delivered) when
  // disputed. Even after a favor_respondent resolution, release must
  // stay BLOCKED -- a resolved dispute alone must never imply the
  // transaction was actually completed (item 5, 20260825000008).
  const listingIdBlocked = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Dispute Not Delivered`, category: 'tools', sale_price: 400 })
  const createdBlocked = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingIdBlocked, quantity: 1, idempotency_key: `escrow-d-nd-create-${RUN_ID}` })
  const orderIdBlocked = createdBlocked.json.order_id ?? createdBlocked.json.id
  await api(renterA.cookie, 'POST', `/api/orders/${orderIdBlocked}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-d-nd-checkout-${RUN_ID}` })
  await api(merchantA.cookie, 'POST', `/api/orders/${orderIdBlocked}/ship`, { idempotency_key: `escrow-d-nd-ship-${RUN_ID}` })

  const { data: paymentBlocked } = await admin.from('payments').select('id').eq('order_id', orderIdBlocked).eq('payment_type', 'order_payment').single()
  const { data: escrowBlocked } = await admin.from('escrow_transactions').select('id, status').eq('payment_id', paymentBlocked.id).single()

  const openedBlocked = await api(renterA.cookie, 'POST', '/api/disputes', { order_id: orderIdBlocked, title: 'Escrow test dispute (not delivered)', description: 'testing escrow freeze', requested_resolution: 'refund', idempotency_key: `escrow-d-nd-open-${RUN_ID}` })
  const disputeIdBlocked = openedBlocked.json?.dispute_id

  const { error: blockedError } = await admin.rpc('release_escrow_transaction', {
    p_actor_type: 'system', p_actor_id: null, p_escrow_id: escrowBlocked.id, p_released_to: merchantA.userId, p_reason: null, p_idempotency_key: null,
  })
  check('D1. release is blocked while an unresolved dispute exists on the underlying order', !!blockedError && /not currently eligible/.test(blockedError.message), blockedError)

  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeIdBlocked}/start-review`, { idempotency_key: `escrow-d-nd-review-${RUN_ID}` }).catch(() => {})
  await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeIdBlocked}/resolve`, { outcome: 'favor_respondent', idempotency_key: `escrow-d-nd-resolve-${RUN_ID}` }).catch(() => {})

  const { error: stillBlockedError } = await admin.rpc('release_escrow_transaction', {
    p_actor_type: 'admin', p_actor_id: adminAuth.userId, p_escrow_id: escrowBlocked.id, p_released_to: merchantA.userId, p_reason: 'escrow phase 3 regression: should stay blocked', p_idempotency_key: `escrow-d-nd-release-${RUN_ID}`,
  })
  check('D2. a resolved dispute alone does NOT unblock release when the order was never actually delivered', !!stillBlockedError && /transaction_not_completed/.test(stillBlockedError.message), stillBlockedError)

  // D-delivered: order IS genuinely delivered before the dispute opens.
  // After a favor_respondent resolution, release must be ALLOWED.
  const listingIdAllowed = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Dispute Delivered`, category: 'tools', sale_price: 400 })
  const createdAllowed = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingIdAllowed, quantity: 1, idempotency_key: `escrow-d-d-create-${RUN_ID}` })
  const orderIdAllowed = createdAllowed.json.order_id ?? createdAllowed.json.id
  await api(renterA.cookie, 'POST', `/api/orders/${orderIdAllowed}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-d-d-checkout-${RUN_ID}` })
  const shipAllowedRes = await api(merchantA.cookie, 'POST', `/api/orders/${orderIdAllowed}/ship`, { idempotency_key: `escrow-d-d-ship-${RUN_ID}` })
  check('D-setup: fixture order can be shipped', shipAllowedRes.status === 200, shipAllowedRes)
  const deliverAllowedRes = await api(renterA.cookie, 'POST', `/api/orders/${orderIdAllowed}/confirm-delivery`, { idempotency_key: `escrow-d-d-deliver-${RUN_ID}` })
  check('D-setup: fixture order delivery confirms successfully', deliverAllowedRes.status === 200, deliverAllowedRes)

  const { data: paymentAllowed } = await admin.from('payments').select('id').eq('order_id', orderIdAllowed).eq('payment_type', 'order_payment').single()
  const { data: escrowAllowed } = await admin.from('escrow_transactions').select('id, status').eq('payment_id', paymentAllowed.id).single()

  // Since ESCROW_ENABLED is on, confirm-delivery's own best-effort hook
  // (src/app/api/orders/[id]/confirm-delivery/route.ts) already released
  // this escrow SYNCHRONOUSLY, actor_type=system, the moment delivery
  // was genuinely confirmed -- before any dispute could exist. That is
  // itself the correct, intended behavior (proven by D-setup above and
  // by C1-C4). A dispute opened on this order AFTER that point flips
  // orders.status to 'disputed' (pre_dispute_status='delivered'
  // captured) and can never be used to re-release an already-released
  // row -- so D3 instead calls _escrow_transaction_completion_block()
  // directly: the precise, isolated proof that a favor_respondent-
  // resolved dispute whose pre_dispute_status was 'delivered' does NOT
  // block release, exactly the fallback branch 20260825000008 added.
  const openedAllowed = await api(renterA.cookie, 'POST', '/api/disputes', { order_id: orderIdAllowed, title: 'Escrow test dispute (delivered)', description: 'testing the completion-block fallback for an already-delivered order', requested_resolution: 'refund', idempotency_key: `escrow-d-d-open-${RUN_ID}` })
  const disputeIdAllowed = openedAllowed.json?.dispute_id
  check('D-setup: fixture dispute opens', openedAllowed.status === 201 && !!disputeIdAllowed, openedAllowed)
  const reviewAllowedRes = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeIdAllowed}/start-review`, { idempotency_key: `escrow-d-d-review-${RUN_ID}` })
  check('D-setup: fixture dispute enters review', reviewAllowedRes.status === 200, reviewAllowedRes)
  const resolveAllowedRes = await api(adminAuth.cookie, 'POST', `/api/admin/disputes/${disputeIdAllowed}/resolve`, { outcome: 'favor_respondent', idempotency_key: `escrow-d-d-resolve-${RUN_ID}` })
  check('D-setup: fixture dispute resolves favor_respondent', resolveAllowedRes.status === 200, resolveAllowedRes)

  const { data: escrowRowAllowed } = await admin.from('escrow_transactions').select('*').eq('id', escrowAllowed.id).single()
  const { data: releasedBySystem } = await admin.from('escrow_transaction_history').select('*').eq('escrow_transaction_id', escrowAllowed.id).eq('new_status', 'released').eq('actor_type', 'system').maybeSingle()
  check('D3a. the automatic system release already happened synchronously at genuine delivery confirmation, before the dispute existed', !!releasedBySystem, releasedBySystem)

  const { data: blockResult, error: blockCheckError } = await admin.rpc('_escrow_transaction_completion_block', { p_escrow: escrowRowAllowed })
  check('D3b. _escrow_transaction_completion_block() does NOT block a favor_respondent-resolved dispute whose pre_dispute_status was the terminal "delivered" value', !blockCheckError && blockResult === null, { blockResult, blockCheckError })
}

console.log('=== Scenario E: admin refund (never blocked by a dispute) ===')
{
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Refund`, category: 'tools', sale_price: 300 })
  const created = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `escrow-e-create-${RUN_ID}` })
  const orderId = created.json.order_id ?? created.json.id
  await api(renterA.cookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-e-checkout-${RUN_ID}` })
  const { data: payment } = await admin.from('payments').select('id').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
  const { data: escrow } = await admin.from('escrow_transactions').select('id, principal_amount').eq('payment_id', payment.id).single()

  const refundRes = await api(adminAuth.cookie, 'POST', `/api/admin/escrow/${escrow.id}/refund`, { amount: Number(escrow.principal_amount), reason: 'escrow phase 3 regression: full refund' })
  check('E1. admin refund succeeds', refundRes.status === 200, refundRes)
  const { data: escrowAfter } = await admin.from('escrow_transactions').select('status, refunded_amount').eq('id', escrow.id).single()
  check('E2. a full refund reaches status=refunded with the exact amount recorded', escrowAfter?.status === 'refunded' && Number(escrowAfter?.refunded_amount) === Number(escrow.principal_amount), escrowAfter)

  const replay = await api(adminAuth.cookie, 'POST', `/api/admin/escrow/${escrow.id}/refund`, { amount: Number(escrow.principal_amount), reason: 'should be rejected -- already refunded' })
  check('E3. a second refund attempt on an already-refunded escrow transaction is rejected', replay.status !== 200, replay)
}

console.log('=== Scenario F: admin cancel (pending -> cancelled only) ===')
{
  // Dedicated fixture (own listing/order/payment/escrow), never
  // dependent on an earlier scenario happening to leave a suitable
  // ambient row behind -- deterministic PASS/FAIL every run, no skip
  // possible (item G corrective fix).
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Cancel Guard`, category: 'tools', sale_price: 350 })
  const created = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `escrow-f-create-${RUN_ID}` })
  const orderId = created.json.order_id ?? created.json.id
  const checkoutRes = await api(renterA.cookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-f-checkout-${RUN_ID}` })
  check('F-setup: fixture order checks out successfully (escrow auto-creates and auto-funds)', checkoutRes.status === 200, checkoutRes)
  const { data: payment } = await admin.from('payments').select('id').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
  const { data: fundedEscrow } = await admin.from('escrow_transactions').select('id, status').eq('payment_id', payment.id).single()
  check('F-setup: fixture escrow reached funded status', fundedEscrow?.status === 'funded', fundedEscrow)

  const { error: cancelError } = await admin.rpc('cancel_escrow_transaction', { p_admin_id: adminAuth.userId, p_escrow_id: fundedEscrow.id, p_reason: 'should be rejected -- already funded, not pending', p_idempotency_key: `escrow-f-${RUN_ID}` })
  check('F1. cancel is rejected once an escrow transaction is no longer pending', !!cancelError, cancelError)
}

console.log('=== Scenario G: webhook intake dedup ===')
{
  const eventId = `evt-escrow-${RUN_ID}`
  const body = JSON.stringify({ event_id: eventId, type: 'escrow.test' })
  const first = await fetch(APP_URL + '/api/escrow/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': 'mock-signature' }, body })
  const firstJson = await first.json()
  const second = await fetch(APP_URL + '/api/escrow/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': 'mock-signature' }, body })
  const secondJson = await second.json()
  check('G1. a fresh webhook event is recorded', first.status === 200 && firstJson.status === 'received', firstJson)
  check('G2. the exact same provider_event_id replayed is recognized as a duplicate, not reprocessed', second.status === 200 && secondJson.status === 'duplicate_ignored', secondJson)

  const invalid = await fetch(APP_URL + '/api/escrow/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: `evt-invalid-${RUN_ID}` }) })
  check('G3. an unsigned/invalid webhook is rejected (401), not silently accepted', invalid.status === 401, { status: invalid.status })

  const unknownProvider = await fetch(APP_URL + '/api/escrow/webhooks/stripe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check('G4. an unregistered provider name is rejected (404)', unknownProvider.status === 404, { status: unknownProvider.status })
}

console.log('=== Scenario H: idempotent replay (release) never double-transitions ===')
{
  // Dedicated fixture, deterministically driven to 'released' via the
  // real delivery flow (not dependent on an earlier scenario's ambient
  // state) -- deterministic PASS/FAIL every run, no skip possible.
  const listingId = await insertBaseListing(merchantA.userId, { title: `${QA_LISTING_MARKER} — Replay Guard`, category: 'tools', sale_price: 350 })
  const created = await api(renterA.cookie, 'POST', '/api/orders', { listing_id: listingId, quantity: 1, idempotency_key: `escrow-h-create-${RUN_ID}` })
  const orderId = created.json.order_id ?? created.json.id
  await api(renterA.cookie, 'POST', `/api/orders/${orderId}/checkout`, { test_scenario: 'success', idempotency_key: `escrow-h-checkout-${RUN_ID}` })
  const shipRes = await api(merchantA.cookie, 'POST', `/api/orders/${orderId}/ship`, { idempotency_key: `escrow-h-ship-${RUN_ID}` })
  check('H-setup: fixture order can be shipped', shipRes.status === 200, shipRes)
  const deliverRes = await api(renterA.cookie, 'POST', `/api/orders/${orderId}/confirm-delivery`, { idempotency_key: `escrow-h-deliver-${RUN_ID}` })
  check('H-setup: fixture order delivery confirms successfully (escrow auto-releases)', deliverRes.status === 200, deliverRes)
  const { data: payment } = await admin.from('payments').select('id').eq('order_id', orderId).eq('payment_type', 'order_payment').single()
  const { data: releasedEscrow } = await admin.from('escrow_transactions').select('id, status').eq('payment_id', payment.id).single()
  check('H-setup: fixture escrow reached released status', releasedEscrow?.status === 'released', releasedEscrow)

  const { error } = await admin.rpc('release_escrow_transaction', { p_actor_type: 'admin', p_actor_id: adminAuth.userId, p_escrow_id: releasedEscrow.id, p_released_to: adminAuth.userId, p_reason: 'should be rejected -- already released', p_idempotency_key: null })
  check('H1. releasing an already-released escrow transaction is rejected (status guard, not a silent no-op)', !!error, error)
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
