#!/usr/bin/env node
/**
 * Permanent regression check for Step 11 Phase 4 (Barter Phase B --
 * execution, deposits, cash difference & completion). Mirrors
 * scripts/verify-dispute-locking.mjs / verify-chat-security.mjs's shape
 * and philosophy exactly: a real script against the live dev database,
 * not a mocked vitest test.
 *
 * Covers every item in the plan's verification list: no-deposit
 * barter, one-sided deposit, two-sided deposit, cash adjustment (both
 * directions), full completion (dual confirmation + deposit release),
 * cancellation pre-deposit (not_applicable) and post-acceptance
 * (refunded, deposits actually released live), a disputed agreement
 * freezing every new RPC, idempotent replay, forged agreement ids,
 * non-participant access, and admin cancel/hold/release-hold with an
 * audit trail.
 *
 * Safely re-runnable: every mutating call uses a FIXED idempotency key,
 * so re-running replays the same result rather than erroring or
 * duplicating state. Dedicated [QA] Phase4-Barter fixture listings,
 * separate from every other regression script's fixtures.
 *
 * SAFETY: same gate as scripts/qa-seed.mjs.
 * Usage: node scripts/verify-barter-execution.mjs
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
    console.error('verify-barter-execution aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\nSet these in your shell (never commit them):')
    console.error('  QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-ref> node scripts/verify-barter-execution.mjs')
    process.exit(1)
  }
}

assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-barter-execution aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'
const FORGED_ID = '00000000-0000-4000-8000-000000000000'

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  return { client, userId: data.session.user.id, cookie: `${cookieName}=${encodeURIComponent(value)}` }
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
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
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

/** Proposes (merchantB -> anchor owned by merchantA) and accepts. Returns the agreement id. */
async function proposeAndAccept(label, listingAId, listingBId, offerFields) {
  const proposed = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingAId,
    party_a_listing_ids: [listingAId],
    party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person',
    message: `Phase 4 regression fixture -- ${label}`,
    idempotency_key: `phase4-propose-${label}-v1`,
    ...offerFields,
  })
  let agreementId = proposed.json?.agreement_id
  if (!agreementId) {
    const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', listingAId).maybeSingle()
    agreementId = existing?.id
  }
  check(`${label}: proposal exists`, !!agreementId, proposed)
  if (!agreementId) return null

  const { data: existingAgreement } = await admin.from('barter_agreements').select('status').eq('id', agreementId).maybeSingle()
  if (existingAgreement && ['proposed', 'countered'].includes(existingAgreement.status)) {
    const accepted = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/accept`, { idempotency_key: `phase4-accept-${label}-v1` })
    check(`${label}: acceptance succeeds`, accepted.status === 200, accepted)
  }
  return agreementId
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-barter-execution aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const outsider = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminSession = creds.accounts.admin ? await signIn(creds.accounts.admin.email, creds.accounts.admin.password) : null

async function listingPair(label, categoryA, categoryB) {
  const a = await insertBaseListing(merchantA.userId, {
    title: `${QA_LISTING_MARKER} Phase4-Barter Regression — ${label} A`,
    description: 'Permanent regression fixture for verify-barter-execution.mjs — do not delete.',
    category: categoryA,
  })
  const b = await insertBaseListing(merchantB.userId, {
    title: `${QA_LISTING_MARKER} Phase4-Barter Regression — ${label} B`,
    description: 'Permanent regression fixture for verify-barter-execution.mjs — do not delete.',
    category: categoryB,
  })
  return [a, b]
}

// ── 1. No-deposit barter: full lifecycle to completion ──
console.log('\n=== No-deposit barter: full lifecycle ===')
{
  const [listingAId, listingBId] = await listingPair('NoDeposit', 'music', 'outdoor')
  const agreementId = await proposeAndAccept('nodeposit', listingAId, listingBId, {})

  if (agreementId) {
    const { data: payments } = await admin.from('payments').select('id').eq('barter_agreement_id', agreementId)
    check('no-deposit: zero payment rows created on acceptance', (payments ?? []).length === 0, payments)

    const prep = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-nodeposit-progress-preparing-v1' })
    check('no-deposit: accepted -> preparing succeeds without any financial gate', prep.status === 200, prep)

    const ready = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: 'phase4-nodeposit-progress-ready-v1' })
    check('no-deposit: preparing -> awaiting_confirmation succeeds (meet_in_person skips in_transit)', ready.status === 200, ready)

    const confirmA = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-nodeposit-confirm-a-v1' })
    check('no-deposit: first confirmation leaves status awaiting_confirmation (no auto-complete)', confirmA.json?.status === 'awaiting_confirmation' && confirmA.json?.confirmations_count === 1, confirmA)

    const confirmARepeat = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-nodeposit-confirm-a-v1' })
    check('no-deposit: idempotent replay of the first confirmation returns the same cached result', confirmARepeat.status === confirmA.status && JSON.stringify(confirmARepeat.json) === JSON.stringify(confirmA.json), confirmARepeat)

    const confirmB = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-nodeposit-confirm-b-v1' })
    check('no-deposit: second confirmation completes the trade', confirmB.json?.status === 'completed', confirmB)

    const { data: finalAgreement } = await admin.from('barter_agreements').select('status, completed_at').eq('id', agreementId).maybeSingle()
    check('no-deposit: agreement status is completed with completed_at set', finalAgreement?.status === 'completed' && !!finalAgreement?.completed_at, finalAgreement)
  }
}

// ── 2. One-sided deposit: financial gate + pay + idempotent replay ──
console.log('\n=== One-sided deposit (party A pays) ===')
{
  const [listingAId, listingBId] = await listingPair('OneSidedDeposit', 'sports', 'tools')
  const agreementId = await proposeAndAccept('onesided', listingAId, listingBId, {
    deposit_required: true, deposit_payer: 'party_a', deposit_amount: 100,
  })

  if (agreementId) {
    const { data: payments } = await admin.from('payments').select('id, renter_id, payment_type, status').eq('barter_agreement_id', agreementId)
    check('one-sided deposit: exactly one barter_deposit payment row, owed by party A', (payments ?? []).length === 1 && payments[0].renter_id === merchantA.userId, payments)

    const blockedProgress = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-onesided-progress-blocked-v1' })
    check('one-sided deposit: progress is blocked before the deposit is paid', blockedProgress.status >= 400, blockedProgress)

    const pay = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-onesided-pay-v1' })
    check('one-sided deposit: payer can authorize the deposit', pay.status === 200 && pay.json?.depositStatus === 'authorised', pay)

    const payReplay = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-onesided-pay-v1' })
    check('one-sided deposit: idempotent replay of the payment returns the same payment id', payReplay.json?.paymentId === pay.json?.paymentId, payReplay)

    const payAsWrongParty = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-onesided-wrongparty-v1' })
    check('one-sided deposit: the other party has no deposit owed and cannot pay one', payAsWrongParty.status === 404, payAsWrongParty)

    const nowReady = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-onesided-progress-ready-v1' })
    check('one-sided deposit: progress succeeds once the deposit is authorised', nowReady.status === 200, nowReady)
  }
}

// ── 3. Two-sided deposit: both must pay ──
console.log('\n=== Two-sided deposit ===')
{
  const [listingAId, listingBId] = await listingPair('TwoSidedDeposit', 'books', 'garden')
  const agreementId = await proposeAndAccept('twosided', listingAId, listingBId, {
    deposit_required: true, deposit_payer: 'both', deposit_amount: 50,
  })

  if (agreementId) {
    const { data: payments } = await admin.from('payments').select('id, renter_id').eq('barter_agreement_id', agreementId).eq('payment_type', 'barter_deposit')
    check('two-sided deposit: two payment rows, one per party', (payments ?? []).length === 2, payments)

    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-twosided-pay-a-v1' })
    const stillBlocked = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-twosided-progress-blocked-v1' })
    check('two-sided deposit: still blocked with only one side paid', stillBlocked.status >= 400, stillBlocked)

    await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-twosided-pay-b-v1' })
    const nowReady = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-twosided-progress-ready-v1' })
    check('two-sided deposit: ready once both sides have paid', nowReady.status === 200, nowReady)
  }
}

// ── 4. Cash adjustment, both directions ──
console.log('\n=== Cash adjustment (party A pays party B) ===')
{
  const [listingAId, listingBId] = await listingPair('CashAtoB', 'electronics', 'furniture')
  const agreementId = await proposeAndAccept('cashatob', listingAId, listingBId, {
    cash_adjustment_amount: 200, cash_adjustment_payer: merchantA.userId,
  })

  if (agreementId) {
    const { data: payment } = await admin.from('payments').select('renter_id, merchant_id, status').eq('barter_agreement_id', agreementId).eq('payment_type', 'barter_cash_adjustment').maybeSingle()
    check('cash A->B: payment row has party A as payer, party B as counterparty', payment?.renter_id === merchantA.userId && payment?.merchant_id === merchantB.userId, payment)

    const wrongPayer = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/cash-adjustment`, { idempotency_key: 'phase4-cashatob-wrongpayer-v1' })
    check('cash A->B: the non-payer cannot pay it', wrongPayer.status === 404, wrongPayer)

    const pay = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/cash-adjustment`, { idempotency_key: 'phase4-cashatob-pay-v1' })
    check('cash A->B: the payer can charge it', pay.status === 200 && pay.json?.cashAdjustmentStatus === 'captured', pay)
  }
}
console.log('\n=== Cash adjustment (party B pays party A) ===')
{
  const [listingAId, listingBId] = await listingPair('CashBtoA', 'clothing', 'toys')
  const agreementId = await proposeAndAccept('cashbtoa', listingAId, listingBId, {
    cash_adjustment_amount: 150, cash_adjustment_payer: merchantB.userId,
  })

  if (agreementId) {
    const { data: payment } = await admin.from('payments').select('renter_id, merchant_id').eq('barter_agreement_id', agreementId).eq('payment_type', 'barter_cash_adjustment').maybeSingle()
    check('cash B->A: payment row has party B as payer, party A as counterparty', payment?.renter_id === merchantB.userId && payment?.merchant_id === merchantA.userId, payment)

    const pay = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/cash-adjustment`, { idempotency_key: 'phase4-cashbtoa-pay-v1' })
    check('cash B->A: the payer can charge it', pay.status === 200 && pay.json?.cashAdjustmentStatus === 'captured', pay)
  }
}

// ── 5. Full completion with a two-sided deposit: deposits released on success ──
console.log('\n=== Full completion releases deposits ===')
{
  const [listingAId, listingBId] = await listingPair('FullCompletion', 'art', 'kitchen')
  const agreementId = await proposeAndAccept('fullcompletion', listingAId, listingBId, {
    deposit_required: true, deposit_payer: 'both', deposit_amount: 75,
  })

  if (agreementId) {
    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-fullcompletion-pay-a-v1' })
    await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-fullcompletion-pay-b-v1' })
    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-fullcompletion-progress-preparing-v1' })
    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'awaiting_confirmation', idempotency_key: 'phase4-fullcompletion-progress-ready-v1' })
    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-fullcompletion-confirm-a-v1' })
    const finalConfirm = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-fullcompletion-confirm-b-v1' })
    check('full completion: trade completes', finalConfirm.json?.status === 'completed', finalConfirm)

    const { data: deposits } = await admin.from('payments').select('renter_id, status').eq('barter_agreement_id', agreementId).eq('payment_type', 'barter_deposit')
    check('full completion: both deposits are released', (deposits ?? []).length === 2 && deposits.every((d) => d.status === 'released'), deposits)
  }
}

// ── 6. Cancellation before acceptance: not_applicable ──
console.log('\n=== Cancellation pre-acceptance ===')
{
  const [listingAId, listingBId] = await listingPair('CancelPreAccept', 'automotive', 'baby')
  const proposed = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingAId, party_a_listing_ids: [listingAId], party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person', idempotency_key: 'phase4-cancelpreaccept-propose-v1',
  })
  let agreementId = proposed.json?.agreement_id
  if (!agreementId) {
    const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', listingAId).maybeSingle()
    agreementId = existing?.id
  }
  if (agreementId) {
    const cancel = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/cancel`, { idempotency_key: 'phase4-cancelpreaccept-cancel-v1' })
    check('cancel pre-acceptance: settlement is not_applicable', cancel.json?.settlement === 'not_applicable', cancel)
  }
}

// ── 7. Cancellation after acceptance with an authorised deposit: refunded, released live ──
console.log('\n=== Cancellation post-acceptance releases the deposit ===')
{
  const [listingAId, listingBId] = await listingPair('CancelPostAccept', 'jewelry', 'appliances')
  const agreementId = await proposeAndAccept('cancelpostaccept', listingAId, listingBId, {
    deposit_required: true, deposit_payer: 'party_a', deposit_amount: 60,
  })

  if (agreementId) {
    await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-cancelpostaccept-pay-v1' })
    const cancel = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/cancel`, { idempotency_key: 'phase4-cancelpostaccept-cancel-v1' })
    check('cancel post-acceptance: settlement is refunded', cancel.json?.settlement === 'refunded', cancel)

    const { data: deposit } = await admin.from('payments').select('status').eq('barter_agreement_id', agreementId).eq('payment_type', 'barter_deposit').maybeSingle()
    check('cancel post-acceptance: the authorised deposit is actually released live', deposit?.status === 'released', deposit)
  }
}

// ── 8. A disputed agreement freezes every new RPC ──
console.log('\n=== Disputed agreement freezes progress/completion/payment ===')
{
  const [listingAId, listingBId] = await listingPair('DisputedFreeze', 'health', 'office')
  const agreementId = await proposeAndAccept('disputedfreeze', listingAId, listingBId, {
    deposit_required: true, deposit_payer: 'party_a', deposit_amount: 40,
  })

  if (agreementId) {
    const openDispute = await api(merchantA.cookie, 'POST', '/api/disputes', {
      barter_agreement_id: agreementId,
      title: 'Phase 4 regression dispute',
      description: 'Permanent regression fixture.',
      requested_resolution: 'n/a',
      idempotency_key: 'phase4-disputedfreeze-open-v1',
    })
    let disputeId = openDispute.json?.dispute_id
    if (!disputeId) {
      const { data: existing } = await admin.from('disputes').select('id').eq('barter_agreement_id', agreementId).maybeSingle()
      disputeId = existing?.id
    }
    check('disputed: dispute opens against the barter agreement', !!disputeId, openDispute)

    const { data: agreementAfterDispute } = await admin.from('barter_agreements').select('status').eq('id', agreementId).maybeSingle()
    check('disputed: agreement status flips to disputed', agreementAfterDispute?.status === 'disputed', agreementAfterDispute)

    const blockedDeposit = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/deposit`, { idempotency_key: 'phase4-disputedfreeze-deposit-blocked-v1' })
    check('disputed: deposit payment is blocked', blockedDeposit.status >= 400, blockedDeposit)

    const blockedProgress = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: 'phase4-disputedfreeze-progress-blocked-v1' })
    check('disputed: progress is blocked', blockedProgress.status >= 400, blockedProgress)

    const blockedConfirm = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: 'phase4-disputedfreeze-confirm-blocked-v1' })
    check('disputed: completion confirmation is blocked', blockedConfirm.status >= 400, blockedConfirm)

    const blockedCancel = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/cancel`, { idempotency_key: 'phase4-disputedfreeze-cancel-blocked-v1' })
    check('disputed: a participant cannot cancel a disputed agreement', blockedCancel.status >= 400, blockedCancel)
  }
}

// Deliberately a SEPARATE fixture from the one above -- admin-cancelling
// it is a terminal action (status -> cancelled), which would make the
// primary "disputed" fixture above unsafe to re-check as still-disputed
// on a subsequent run. Keeping this destructive step isolated to its
// own disposable fixture keeps every other check in this file safely
// re-runnable indefinitely.
console.log('\n=== Admin can cancel a disputed agreement ===')
if (adminSession) {
  const [listingAId, listingBId] = await listingPair('DisputedAdminCancel', 'games', 'photography')
  const agreementId = await proposeAndAccept('disputedadmincancel', listingAId, listingBId, {})

  if (agreementId) {
    const openDispute = await api(merchantA.cookie, 'POST', '/api/disputes', {
      barter_agreement_id: agreementId,
      title: 'Phase 4 regression dispute (admin-cancel fixture)',
      description: 'Permanent regression fixture.',
      requested_resolution: 'n/a',
      idempotency_key: 'phase4-disputedadmincancel-open-v1',
    })
    check('disputed admin-cancel: dispute opens', openDispute.status === 201 || !!openDispute.json?.dispute_id, openDispute)

    const adminCancel = await api(adminSession.cookie, 'POST', `/api/admin/barter/${agreementId}/cancel`, { reason: 'dispute resolution', idempotency_key: 'phase4-disputedadmincancel-cancel-v1' })
    check('disputed admin-cancel: an admin CAN cancel a disputed agreement, settlement frozen pending dispute', adminCancel.json?.settlement === 'frozen_pending_dispute', adminCancel)
  }
}

// ── 9. Forged agreement id ──
console.log('\n=== Forged agreement id ===')
{
  const getForged = await api(merchantA.cookie, 'GET', `/api/barter/${FORGED_ID}`)
  check('forged id: GET is rejected', getForged.status === 404, getForged)
  const acceptForged = await api(merchantA.cookie, 'POST', `/api/barter/${FORGED_ID}/accept`, { idempotency_key: `phase4-forged-accept-${Date.now()}` })
  check('forged id: accept is rejected', acceptForged.status >= 400, acceptForged)
  const depositForged = await api(merchantA.cookie, 'POST', `/api/barter/${FORGED_ID}/deposit`, { idempotency_key: `phase4-forged-deposit-${Date.now()}` })
  check('forged id: deposit payment is rejected', depositForged.status >= 400, depositForged)
  const progressForged = await api(merchantA.cookie, 'POST', `/api/barter/${FORGED_ID}/progress`, { target_status: 'preparing', idempotency_key: `phase4-forged-progress-${Date.now()}` })
  check('forged id: progress is rejected', progressForged.status >= 400, progressForged)
  const confirmForged = await api(merchantA.cookie, 'POST', `/api/barter/${FORGED_ID}/confirm-completion`, { idempotency_key: `phase4-forged-confirm-${Date.now()}` })
  check('forged id: completion confirmation is rejected', confirmForged.status >= 400, confirmForged)
}

// ── 10. Non-participant access ──
console.log('\n=== Non-participant access ===')
{
  const [listingAId, listingBId] = await listingPair('NonParticipant', 'watches', 'shoes')
  const agreementId = await proposeAndAccept('nonparticipant', listingAId, listingBId, {})

  if (agreementId) {
    const getAsOutsider = await api(outsider.cookie, 'GET', `/api/barter/${agreementId}`)
    check('non-participant: GET is rejected (RLS, indistinguishable from nonexistent)', getAsOutsider.status === 404, getAsOutsider)
    const progressAsOutsider = await api(outsider.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: `phase4-nonparticipant-progress-${Date.now()}` })
    check('non-participant: progress is rejected', progressAsOutsider.status >= 400, progressAsOutsider)
    const confirmAsOutsider = await api(outsider.cookie, 'POST', `/api/barter/${agreementId}/confirm-completion`, { idempotency_key: `phase4-nonparticipant-confirm-${Date.now()}` })
    check('non-participant: completion confirmation is rejected', confirmAsOutsider.status >= 400, confirmAsOutsider)
    const cancelAsOutsider = await api(outsider.cookie, 'POST', `/api/barter/${agreementId}/cancel`, { idempotency_key: `phase4-nonparticipant-cancel-${Date.now()}` })
    check('non-participant: cancel is rejected', cancelAsOutsider.status >= 400, cancelAsOutsider)
  }
}

// ── 11. Admin hold / release-hold with audit trail ──
console.log('\n=== Admin hold / release-hold ===')
if (adminSession) {
  const [listingAId, listingBId] = await listingPair('AdminHold', 'collectibles', 'instruments')
  const agreementId = await proposeAndAccept('adminhold', listingAId, listingBId, {})

  if (agreementId) {
    // Hold then release forms a complete, reversible cycle within a
    // single run -- a FIXED idempotency key would replay the first
    // run's now-stale cached response on every subsequent run (the live
    // row has since been toggled back by this same scenario's own
    // release step), so these two calls use a fresh key every run.
    const runId = Date.now()
    const hold = await api(adminSession.cookie, 'POST', `/api/admin/barter/${agreementId}/hold`, { reason: 'regression check', idempotency_key: `phase4-adminhold-hold-${runId}` })
    check('admin hold: succeeds', hold.json?.admin_hold === true, hold)

    const { data: heldAgreement } = await admin.from('barter_agreements').select('admin_hold, admin_hold_reason').eq('id', agreementId).maybeSingle()
    check('admin hold: admin_hold set with a reason', heldAgreement?.admin_hold === true && heldAgreement?.admin_hold_reason === 'regression check', heldAgreement)

    const { data: holdHistory } = await admin.from('barter_history').select('event_type, actor_role').eq('agreement_id', agreementId).eq('event_type', 'barter_admin_hold_set').order('created_at', { ascending: false }).limit(1).maybeSingle()
    check('admin hold: audited in barter_history with actor_role=admin', holdHistory?.actor_role === 'admin', holdHistory)

    const blockedWhileHeld = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/progress`, { target_status: 'preparing', idempotency_key: `phase4-adminhold-progress-blocked-${runId}` })
    check('admin hold: participant actions are blocked while held', blockedWhileHeld.status >= 400, blockedWhileHeld)

    const release = await api(adminSession.cookie, 'POST', `/api/admin/barter/${agreementId}/release-hold`, { idempotency_key: `phase4-adminhold-release-${runId}` })
    check('admin hold: release succeeds', release.json?.admin_hold === false, release)

    const { data: releaseHistory } = await admin.from('barter_history').select('actor_role').eq('agreement_id', agreementId).eq('event_type', 'barter_admin_hold_released').order('created_at', { ascending: false }).limit(1).maybeSingle()
    check('admin hold: release audited in barter_history with actor_role=admin', releaseHistory?.actor_role === 'admin', releaseHistory)
  }
} else {
  console.log('  skipped -- no admin QA account in .qa-credentials.local.json')
}

console.log('\n=== SUMMARY ===')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
