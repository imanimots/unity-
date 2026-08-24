#!/usr/bin/env node
/**
 * Permanent regression check for Wave 2E: counter_barter_offer
 * account-status hardening. Mirrors scripts/verify-marketplace-request-account-status.mjs's
 * shape/philosophy (real dev-database script, withAccountStatus via the
 * REAL admin routes, fail-closed check()) and reuses
 * scripts/verify-barter-execution.mjs's listing/propose conventions.
 *
 * Proves the confirmed gap is closed: counter_barter_offer -- a direct
 * barter-negotiation action reachable OUTSIDE the marketplace-request
 * acceptance path -- now enforces profiles.account_status, using the
 * SAME two helpers (_assert_account_status_permits_creation /
 * _assert_account_status_permits_transaction) already reused for the 9
 * RPCs hardened in Wave 2D. Tier classification:
 *
 *   - actor (self): creation tier. Countering creates a brand-new offer
 *     version -- new commercial negotiation activity, the same
 *     classification propose_barter's proposer already gets (restricted
 *     OR suspended denies).
 *   - counterparty (the other party in the agreement, whose current
 *     offer/counter is being responded to): transaction tier, mirroring
 *     propose_barter's counterparty (anchor_owner) treatment exactly --
 *     restricted alone must not block servicing an existing negotiation
 *     the counterparty is already a party to; suspended still blocks.
 *
 * Also proves: the pre-existing KYC check is unaffected; route-layer
 * blockIfCannotCreate (already present on this route before this phase)
 * still 403s independently at the HTTP layer; repeated/concurrent
 * counter calls produce no duplicate durable side effects; the "not your
 * turn" turn-based safety is unaffected by account status.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-barter-counter-offer-account-status.mjs
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
    console.error('verify-barter-counter-offer-account-status aborted -- safety checks failed:')
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
  console.error('verify-barter-counter-offer-account-status aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_LISTING_MARKER = '[QA]'
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
  console.error('verify-barter-counter-offer-account-status aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const outsider = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)

/** Runs fn() while userId's account_status is temporarily changed via the REAL admin route, always restoring afterward -- even on throw. */
async function withAccountStatus(userId, action, fn) {
  const key1 = `barter-counter-acct-${action}-${userId}-${Date.now()}-${Math.random()}`
  const r = await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/${action}`, { user_reason: 'regression test', idempotency_key: key1 })
  if (r.status >= 400) throw new Error(`withAccountStatus ${action} failed: ${JSON.stringify(r)}`)
  try {
    return await fn()
  } finally {
    const key2 = `barter-counter-acct-restore-${userId}-${Date.now()}-${Math.random()}`
    await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/restore`, { user_reason: 'regression test cleanup', idempotency_key: key2 })
  }
}

/** Runs fn() while userId's kyc_status is temporarily set to `status` (mirrors verify-transaction-verification-hardening.mjs's withKycStatus exactly -- there is no admin route for this, only a direct table toggle). */
async function withKycStatus(userId, status, fn) {
  const { data: before } = await admin.from('profiles').select('kyc_status').eq('id', userId).single()
  await admin.from('profiles').update({ kyc_status: status }).eq('id', userId)
  try {
    return await fn()
  } finally {
    await admin.from('profiles').update({ kyc_status: before.kyc_status }).eq('id', userId)
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

async function listingPair(label) {
  const a = await insertBaseListing(merchantA.userId, {
    title: `${QA_LISTING_MARKER} CounterAcctStatus Regression — ${label} A`,
    description: 'Permanent regression fixture for verify-barter-counter-offer-account-status.mjs — do not delete.',
    category: 'tech',
  })
  const b = await insertBaseListing(merchantB.userId, {
    title: `${QA_LISTING_MARKER} CounterAcctStatus Regression — ${label} B`,
    description: 'Permanent regression fixture for verify-barter-counter-offer-account-status.mjs — do not delete.',
    category: 'outdoor',
  })
  return [a, b]
}

/**
 * Proposes a fresh agreement (merchantB -> anchor owned by merchantA),
 * left in `proposed` status (never accepted). Per propose_barter's role
 * convention, party_a_id = anchor owner = merchantA, party_b_id =
 * proposer = merchantB, so v_current_offer.proposed_by = merchantB --
 * meaning merchantA is the party who may counter ("self"/creation-tier
 * in every scenario below) and merchantB is the counterparty
 * ("counterparty"/transaction-tier).
 */
async function proposeFresh(label, listingAId, listingBId) {
  const proposed = await api(merchantB.cookie, 'POST', '/api/barter', {
    anchor_listing_id: listingAId,
    party_a_listing_ids: [listingAId],
    party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person',
    message: `counter-offer account-status regression fixture -- ${label}`,
    idempotency_key: `counter-acct-propose-${label}-${RUN_ID}`,
  })
  let agreementId = proposed.json?.agreement_id
  if (!agreementId) {
    const { data: existing } = await admin.from('barter_agreements').select('id').eq('anchor_listing_id', listingAId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    agreementId = existing?.id
  }
  return agreementId
}

function counterPayload(listingAId, listingBId, idKey) {
  return {
    party_a_listing_ids: [listingAId],
    party_b_listing_ids: [listingBId],
    delivery_method: 'meet_in_person',
    message: 'counter-offer account-status regression counter',
    idempotency_key: idKey,
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== BASELINE: active + KYC-approved actor can counter ===')
// ══════════════════════════════════════════════════════════════
{
  const [listingAId, listingBId] = await listingPair('Baseline')
  const agreementId = await proposeFresh('baseline', listingAId, listingBId)
  check('baseline: proposal exists', !!agreementId, agreementId)

  if (agreementId) {
    const before = await admin.from('barter_agreements').select('version, current_offer_id, status').eq('id', agreementId).single()
    const countered = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-baseline-${RUN_ID}`))
    check('baseline: active KYC-approved actor can counter', countered.status === 200 && countered.json?.status === 'countered', countered)
    const after = await admin.from('barter_agreements').select('version, current_offer_id, status').eq('id', agreementId).single()
    check('baseline: agreement version incremented and status is countered', after.data.version === before.data.version + 1 && after.data.status === 'countered' && after.data.current_offer_id !== before.data.current_offer_id, { before: before.data, after: after.data })
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== SELF (actor/counterer): creation tier -- restricted OR suspended denies ===')
// ══════════════════════════════════════════════════════════════
{
  const [listingAId, listingBId] = await listingPair('SelfRestricted')
  const agreementId = await proposeFresh('selfrestricted', listingAId, listingBId)

  await withAccountStatus(merchantA.userId, 'restrict', async () => {
    const before = await admin.from('barter_agreements').select('version, status').eq('id', agreementId).single()
    const denied = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-selfrestricted-${RUN_ID}`))
    check('self restricted: counter DENIED (creation tier blocks restricted)', denied.status === 403, denied)
    const after = await admin.from('barter_agreements').select('version, status').eq('id', agreementId).single()
    check('self restricted: denied attempt left no durable side effect (version/status unchanged)', after.data.version === before.data.version && after.data.status === before.data.status, { before: before.data, after: after.data })
  })

  // Reactivation: the SAME agreement, still `proposed`, can now be countered once restored.
  const afterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-selfrestricted-retry-${RUN_ID}`))
  check('self restricted: reactivation -- same agreement counterable once the actor is restored to active', afterRestore.status === 200 && afterRestore.json?.status === 'countered', afterRestore)
}

{
  const [listingAId, listingBId] = await listingPair('SelfSuspended')
  const agreementId = await proposeFresh('selfsuspended', listingAId, listingBId)

  await withAccountStatus(merchantA.userId, 'suspend', async () => {
    const denied = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-selfsuspended-${RUN_ID}`))
    check('self suspended: counter DENIED', denied.status === 403, denied)
  })
  const afterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-selfsuspended-retry-${RUN_ID}`))
  check('self suspended: reactivation -- succeeds once restored', afterRestore.status === 200 && afterRestore.json?.status === 'countered', afterRestore)
}

// ══════════════════════════════════════════════════════════════
console.log('=== COUNTERPARTY (the other party, whose current offer is being responded to): transaction tier ===')
// ══════════════════════════════════════════════════════════════
{
  // merchantB is the counterparty here (proposed_by on the current offer).
  // Restricted alone must NOT block merchantA from countering against them
  // -- their existing negotiation position remains serviceable.
  const [listingAId, listingBId] = await listingPair('CounterpartyRestricted')
  const agreementId = await proposeFresh('counterpartyrestricted', listingAId, listingBId)

  await withAccountStatus(merchantB.userId, 'restrict', async () => {
    const countered = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-cprestricted-${RUN_ID}`))
    check('counterparty restricted: counter SUCCEEDS -- their existing negotiation remains serviceable', countered.status === 200 && countered.json?.status === 'countered', countered)
  })
}

{
  // Suspended counterparty DOES block -- suspended blocks even servicing
  // an existing opportunity, matching every other transaction-tier check.
  const [listingAId, listingBId] = await listingPair('CounterpartySuspended')
  const agreementId = await proposeFresh('counterpartysuspended', listingAId, listingBId)

  await withAccountStatus(merchantB.userId, 'suspend', async () => {
    const denied = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-cpsuspended-${RUN_ID}`))
    check('counterparty suspended: counter DENIED', denied.status === 403, denied)
  })
  const afterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-cpsuspended-retry-${RUN_ID}`))
  check('counterparty suspended: succeeds once the counterparty is restored to active', afterRestore.status === 200 && afterRestore.json?.status === 'countered', afterRestore)
}

// ══════════════════════════════════════════════════════════════
console.log('=== KYC (pre-existing, unchanged): active-but-unverified still gets the existing KYC denial ===')
// ══════════════════════════════════════════════════════════════
{
  const [listingAId, listingBId] = await listingPair('KycUnapproved')
  const agreementId = await proposeFresh('kycunapproved', listingAId, listingBId)

  await withKycStatus(merchantA.userId, 'none', async () => {
    const denied = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-kyc-${RUN_ID}`))
    check('self KYC-unapproved (active account_status): counter DENIED via the existing, unmodified KYC check', denied.status === 403, denied)
  })
  const afterRestore = await api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-kyc-retry-${RUN_ID}`))
  check('self KYC-unapproved: succeeds once KYC is restored to approved', afterRestore.status === 200 && afterRestore.json?.status === 'countered', afterRestore)
}

// ══════════════════════════════════════════════════════════════
console.log('=== LIFECYCLE / NON-ACTOR PROTECTIONS: unaffected by the new check ===')
// ══════════════════════════════════════════════════════════════
{
  // Non-participant is rejected regardless of account status (RLS /
  // "not a party" check fires before account-status is ever reached).
  const [listingAId, listingBId] = await listingPair('NonParticipant')
  const agreementId = await proposeFresh('nonparticipant', listingAId, listingBId)
  const asOutsider = await api(outsider.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-outsider-${RUN_ID}`))
  check('non-participant: counter is rejected (unaffected by this phase)', asOutsider.status >= 400, asOutsider)
}

{
  // "Not your turn": the party who proposed the CURRENT offer cannot
  // counter their own pending offer -- this pre-existing safety must
  // fire identically whether or not the actor is active, and account
  // status must never allow it to be bypassed.
  const [listingAId, listingBId] = await listingPair('NotYourTurn')
  const agreementId = await proposeFresh('notyourturn', listingAId, listingBId)
  // merchantB is proposed_by on the current (initial) offer.
  const wrongTurn = await api(merchantB.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-wrongturn-${RUN_ID}`))
  check('not-your-turn: the current offer\'s own proposer cannot counter it themselves', wrongTurn.status === 403 && (wrongTurn.json?.error ?? '').includes('not your turn'), wrongTurn)
}

// ══════════════════════════════════════════════════════════════
console.log('=== CONCURRENCY: repeated/concurrent counter calls produce no duplicate durable side effects ===')
// ══════════════════════════════════════════════════════════════
{
  // Same idempotency key, fired concurrently. The idempotency-key check
  // happens BEFORE the agreement row lock (pre-existing architecture,
  // unrelated to this phase), so under a true race the loser can either
  // (a) get the identical cached replay result, or (b) lose the row-lock
  // race, re-read the now-updated agreement, and correctly fail
  // "not your turn" against the winner's own fresh offer -- both are
  // safely convergent outcomes with zero duplicate durable side effects.
  // What must NEVER happen: two offer version-2 rows, or a 500.
  const [listingAId, listingBId] = await listingPair('ConcurrentSameKey')
  const agreementId = await proposeFresh('concurrentsamekey', listingAId, listingBId)
  const key = `counter-concurrent-samekey-${RUN_ID}`
  const [r1, r2] = await Promise.all([
    api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, key)),
    api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, key)),
  ])
  check('concurrent same-key: neither call 500s', r1.status !== 500 && r2.status !== 500, { r1, r2 })
  check('concurrent same-key: at least one call succeeds', r1.status === 200 || r2.status === 200, { r1, r2 })
  const { data: offerVersions } = await admin.from('barter_offers').select('id, version').eq('agreement_id', agreementId)
  check('concurrent same-key: exactly one new offer version created (version 2), no duplicate', (offerVersions ?? []).filter((o) => o.version === 2).length === 1, offerVersions)
}

{
  // Different idempotency keys, fired concurrently, against a fresh
  // `proposed` agreement -- the RPC's own row lock + "not your turn"
  // re-check after the first counter flips proposed_by must let exactly
  // one succeed, never both.
  const [listingAId, listingBId] = await listingPair('ConcurrentDistinctKeys')
  const agreementId = await proposeFresh('concurrentdistinctkeys', listingAId, listingBId)
  const [r1, r2] = await Promise.all([
    api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-concurrent-a-${RUN_ID}`)),
    api(merchantA.cookie, 'POST', `/api/barter/${agreementId}/counter`, counterPayload(listingAId, listingBId, `counter-concurrent-b-${RUN_ID}`)),
  ])
  const successCount = [r1, r2].filter((r) => r.status === 200).length
  check('concurrent distinct keys: exactly one of the two racing counters succeeds', successCount === 1, { r1, r2 })
  const { data: finalAgreement } = await admin.from('barter_agreements').select('version').eq('id', agreementId).single()
  check('concurrent distinct keys: agreement version incremented exactly once (2), not twice', finalAgreement.version === 2, finalAgreement)
}

// ══════════════════════════════════════════════════════════════
console.log('=== REQUIRED REGRESSION CROSS-CHECK: marketplace-request account-status verifier must still pass ===')
// ══════════════════════════════════════════════════════════════
console.log('  (run separately: node scripts/verify-marketplace-request-account-status.mjs)')

// ══════════════════════════════════════════════════════════════
console.log('=== CLEANUP ===')
// ══════════════════════════════════════════════════════════════
{
  const { data: leaked } = await admin.from('listings').select('id').ilike('title', `${QA_LISTING_MARKER} CounterAcctStatus Regression%`).eq('is_test', false)
  if ((leaked ?? []).length > 0) {
    await admin.from('listings').update({ is_test: true }).in('id', leaked.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', `${QA_LISTING_MARKER} CounterAcctStatus Regression%`).eq('is_test', false)
  check('cleanup succeeds -- no real (is_test=false) QA listing fixtures left behind', (stillLeaked ?? 0) === 0, { stillLeaked })

  const { data: mA } = await admin.from('profiles').select('account_status, kyc_status').eq('id', merchantA.userId).single()
  const { data: mB } = await admin.from('profiles').select('account_status, kyc_status').eq('id', merchantB.userId).single()
  check('merchantA restored to active/approved after all temporary toggles', mA.account_status === 'active' && mA.kyc_status === 'approved', mA)
  check('merchantB restored to active/approved after all temporary toggles', mB.account_status === 'active' && mB.kyc_status === 'approved', mB)
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
