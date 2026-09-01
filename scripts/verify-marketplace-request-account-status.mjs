#!/usr/bin/env node
/**
 * Permanent regression check for marketplace-request (Looking For)
 * account-status hardening (Wave 2D). Proves the confirmed gap is
 * closed: publish_marketplace_request, submit_marketplace_offer, and the
 * canonical commercial transaction RPCs reached via
 * accept_marketplace_offer (create_order, create_booking_request,
 * accept_booking_request, propose_barter, accept_barter_offer,
 * create_rent_to_buy_request, accept_rent_to_buy_request) now enforce
 * profiles.account_status, reusing the existing two-tier model
 * (src/lib/admin/account-status.ts):
 *
 *   - "creation" tier (blocks restricted OR suspended) -- the party
 *     INITIATING new commercial activity: publishing a request,
 *     submitting a commercial offer, and (structurally) the REQUESTER at
 *     offer-acceptance time, since accepting an offer is the exact
 *     moment their first real commitment (order/booking/proposal/RTB
 *     request) is actually created -- create_order/create_booking_request/
 *     propose_barter/create_rent_to_buy_request all treat the requester
 *     as their own "self" (creation-tier) parameter, regardless of
 *     whether they're called directly or via accept_marketplace_offer.
 *   - "transaction" tier (blocks suspended only) -- a counterparty whose
 *     EXISTING active listing/offer is being engaged (restricted alone
 *     must not block servicing an existing opportunity).
 *
 * Uses the permanent QA fixture accounts (scripts/qa-seed.mjs):
 * restrictedUser (restricted, KYC-approved) and suspendedUser
 * (suspended, KYC-approved) -- proving KYC-approved-but-restricted is
 * correctly denied, the core regression. merchantA/renterA are the
 * always-active controls. Draft creation is proven NOT blocked (product
 * decision: only publish is gated). An already-published request is
 * proven to remain untouched after its owner is later restricted (the
 * confirmed product decision for this phase -- no new mechanism exists
 * or was added for that).
 *
 * Fails closed: every assertion is an explicit check() call.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-marketplace-request-account-status.mjs
 * Requires the dev server running at NEXT_PUBLIC_APP_URL and
 * scripts/qa-seed.mjs already run once.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

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
    console.error('verify-marketplace-request-account-status aborted -- safety checks failed:')
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
  console.error('verify-marketplace-request-account-status aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] AcctStatusLF'
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
async function createRequest(cookie, body, idKey) {
  return api(cookie, 'POST', '/api/marketplace/requests', { ...body, idempotency_key: idKey })
}
// publishRequest is defined further below, after ensureAccountStatus/withAccountStatus -- it needs `admin` for is_test marking, already in scope, but is kept next to the fresh-QA-merchant helper it's documented alongside.

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-marketplace-request-account-status aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)
const restrictedUser = await cookieFor(creds.accounts.restrictedUser.email, creds.accounts.restrictedUser.password)
const suspendedUser = await cookieFor(creds.accounts.suspendedUser.email, creds.accounts.suspendedUser.password)

/** Ensures targetStatus via the REAL admin route (idempotent -- a no-op if already correct), matching qa-seed.mjs's own mechanism exactly. Self-healing against drift: these are long-lived shared fixtures and other work in this session may have restored them. */
async function ensureAccountStatus(userId, targetStatus, action) {
  const { data: current } = await admin.from('profiles').select('account_status').eq('id', userId).single()
  if (current.account_status === targetStatus) return
  const key = `acct-status-ensure-${action}-${userId}-${Date.now()}-${Math.random()}`
  const r = await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/${action}`, { user_reason: 'QA fixture account -- restored to documented state for regression coverage', idempotency_key: key })
  if (r.status >= 400) throw new Error(`ensureAccountStatus(${action}) failed for ${userId}: ${JSON.stringify(r)}`)
}
await ensureAccountStatus(restrictedUser.userId, 'restricted', 'restrict')
await ensureAccountStatus(suspendedUser.userId, 'suspended', 'suspend')

// Confirm the fixture accounts are actually in the expected state before relying on them.
{
  const { data: r } = await admin.from('profiles').select('account_status, kyc_status').eq('id', restrictedUser.userId).single()
  const { data: s } = await admin.from('profiles').select('account_status, kyc_status').eq('id', suspendedUser.userId).single()
  check('fixture: restrictedUser is account_status=restricted, kyc_status=approved', r.account_status === 'restricted' && r.kyc_status === 'approved', r)
  check('fixture: suspendedUser is account_status=suspended, kyc_status=approved', s.account_status === 'suspended' && s.kyc_status === 'approved', s)
}

/** Runs fn() while userId's account_status is temporarily changed via the REAL admin route, always restoring afterward -- even on throw. */
async function withAccountStatus(userId, action, fn) {
  const key1 = `acct-status-test-${action}-${userId}-${Date.now()}-${Math.random()}`
  const r = await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/${action}`, { user_reason: 'regression test', idempotency_key: key1 })
  if (r.status >= 400) throw new Error(`withAccountStatus ${action} failed: ${JSON.stringify(r)}`)
  try {
    return await fn()
  } finally {
    const key2 = `acct-status-test-restore-${userId}-${Date.now()}-${Math.random()}`
    await api(adminAuth.cookie, 'POST', `/api/admin/users/${userId}/restore`, { user_reason: 'regression test cleanup', idempotency_key: key2 })
  }
}

/**
 * merchantA is a permanent shared fixture reused by every verifier script
 * in this codebase (listings, marketplace requests, barter listings, ...).
 * Its real (is_test=false) active-supply count has, over many historical
 * runs, exceeded its subscription's active_publication_limit -- this
 * script's own account-status assertions have nothing to do with that cap,
 * but every publish call in this script routes through the SAME
 * publish_marketplace_request RPC that also enforces it, so a
 * cap-exhausted merchantA would make nearly every check here fail with
 * "active publication limit reached" instead of exercising the
 * account-status logic under test.
 *
 * merchantA's merchant_subscriptions row is READ-ONLY from this verifier --
 * ZERO INSERT/UPDATE/UPSERT/DELETE against it, full stop (two prior
 * designs violated this: one temporarily elevated merchantA's plan and
 * restored it in `finally`; another kept the PUBLICATION_FROZEN
 * interaction toggling merchantA's `publication_frozen` flag in
 * `finally`. Both rejected -- `finally` is exception-safe, not hard-kill
 * safe: SIGKILL/OOM/host-crash/CI-cancellation never runs it, which could
 * permanently strand the permanent shared fixture on the wrong plan or
 * frozen state). Instead: every request this script publishes is marked
 * is_test=true immediately before the real publish RPC runs
 * (service-role, prerequisite-only -- publish_marketplace_request
 * structurally skips its cap check entirely for is_test rows), and any
 * scenario needing a real merchant_subscriptions mutation (the
 * publication_frozen toggle) or real public visibility (is_test=false)
 * uses its own dedicated, per-run disposable QA merchant instead of
 * merchantA -- see createDisposableQaMerchant() below.
 */
async function publishRequest(cookie, requestId, opts = {}) {
  if (!opts.skipMarkTest) {
    await admin.from('marketplace_requests').update({ is_test: true }).eq('id', requestId)
  }
  return api(cookie, 'POST', `/api/marketplace/requests/${requestId}/publish`, {})
}

/**
 * A TRUE per-run disposable QA merchant. RUN_ID + `purpose`-scoped email
 * -- always a brand-new auth user, never looked up or reused across runs
 * or between the two scenarios that need one (a prior version reused one
 * fixed permanent account across runs, self-healed by cleanup at the end;
 * that still had the same class of hard-interruption risk this whole
 * remediation exists to eliminate -- if the process died before that
 * cleanup ran, the *same* account would carry leftover real state into
 * every subsequent run). No merchant_subscriptions row is created here by
 * default, so _get_effective_merchant_plan_id() naturally defaults a
 * fresh account to 'starter' (cap 5) -- zero prior supply, so a real
 * publish succeeds within that cap on its own, no elevation needed.
 * `withSubscriptionRow` additionally gives the account its OWN
 * merchant_subscriptions row for the one scenario (publication_frozen)
 * that genuinely needs to mutate that table -- always safe, since it is
 * that disposable account's own row, never merchantA's, never reused.
 */
async function createDisposableQaMerchant(purpose, { withSubscriptionRow = false } = {}) {
  const email = `qa-mr-acctstatus-${purpose}-${RUN_ID}@unitytest.internal`
  // Random, never persisted anywhere (not even in memory beyond this
  // function) -- this account is used and discarded within this same run.
  const password = `Qa${randomBytes(18).toString('base64url')}!1`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`createDisposableQaMerchant(${purpose}): createUser failed: ${error.message}`)
  const userId = data.user.id
  await admin.from('profiles').update({ role: 'merchant', kyc_status: 'approved', account_status: 'active' }).eq('id', userId)
  if (withSubscriptionRow) {
    // Every column defaults to exactly what's wanted (current_plan_id
    // 'starter', publication_frozen false, status 'active') -- this
    // account's OWN row, safe to mutate freely, never merchantA's.
    await admin.from('merchant_subscriptions').insert({ merchant_id: userId })
  }
  return cookieFor(email, password)
}

/**
 * Startup hygiene (NOT a correctness dependency -- see the doc comment on
 * the ALREADY-PUBLISHED REQUEST scenario below): quarantines any
 * abandoned prior-run public-visibility fixture -- from a hard-killed run
 * of THIS script, or the old fixed-email disposable account this design
 * superseded -- back into is_test QA inventory. Scoped narrowly to the
 * exact, stable title pattern that ONE scenario produces; touches ONLY
 * is_test, never status/offers/requester/timestamps/lifecycle.
 */
async function quarantineOrphanedPublicFixtures() {
  const { data: orphaned } = await admin.from('marketplace_requests').select('id').ilike('title', `${QA_MARKER} already-published-%`).eq('is_test', false)
  if ((orphaned ?? []).length > 0) {
    await admin.from('marketplace_requests').update({ is_test: true }).in('id', orphaned.map((r) => r.id))
  }
}
await quarantineOrphanedPublicFixtures()

const freshMerchant = await createDisposableQaMerchant('public')

// ══════════════════════════════════════════════════════════════
console.log('=== PUBLISH: Buy/Rent/Barter Looking For ===')
// ══════════════════════════════════════════════════════════════
for (const mode of ['buy', 'rent', 'barter']) {
  const dates = mode === 'rent' ? { start_date: '2031-06-01', end_date: '2031-06-10' } : {}

  // Unrestricted (merchantA) succeeds.
  {
    const created = await createRequest(merchantA.cookie, { transaction_type: mode, title: `${QA_MARKER} publish-ok-${mode}-${RUN_ID}`, ...dates }, `pub-ok-${mode}-${RUN_ID}`)
    check(`${mode}: create draft succeeds (unrestricted)`, created.status === 201, created)
    const published = await publishRequest(merchantA.cookie, created.json.request_id)
    check(`${mode}: publish succeeds (unrestricted, KYC-approved)`, published.status === 200 && published.json?.status === 'active', published)
  }

  // Restricted denied.
  {
    const created = await createRequest(restrictedUser.cookie, { transaction_type: mode, title: `${QA_MARKER} publish-restricted-${mode}-${RUN_ID}`, ...dates }, `pub-restricted-${mode}-${RUN_ID}`)
    check(`${mode}: draft creation succeeds even while restricted (drafts are not gated)`, created.status === 201, created)
    const published = await publishRequest(restrictedUser.cookie, created.json.request_id)
    check(`${mode}: publish DENIED for a restricted account`, published.status === 403, published)
    const { data: stillDraft } = await admin.from('marketplace_requests').select('status').eq('id', created.json.request_id).single()
    check(`${mode}: denied publish leaves the request in draft`, stillDraft.status === 'draft', stillDraft)
  }

  // Suspended denied.
  {
    const created = await createRequest(suspendedUser.cookie, { transaction_type: mode, title: `${QA_MARKER} publish-suspended-${mode}-${RUN_ID}`, ...dates }, `pub-suspended-${mode}-${RUN_ID}`)
    check(`${mode}: draft creation succeeds even while suspended`, created.status === 201, created)
    const published = await publishRequest(suspendedUser.cookie, created.json.request_id)
    check(`${mode}: publish DENIED for a suspended account`, published.status === 403, published)
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== PUBLISH: unverified / anonymous ===')
// ══════════════════════════════════════════════════════════════
{
  const unauth = await createRequest(null, { transaction_type: 'buy', title: `${QA_MARKER} anon-${RUN_ID}` }, `anon-${RUN_ID}`)
  check('anonymous create is denied', unauth.status === 401, unauth)
}

// ══════════════════════════════════════════════════════════════
console.log('=== RESPOND: submitting an offer ===')
// ══════════════════════════════════════════════════════════════
{
  // A published request from merchantA (unrestricted owner) to respond against.
  const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} respond-target-${RUN_ID}` }, `respond-target-${RUN_ID}`)
  const published = await publishRequest(merchantA.cookie, created.json.request_id)
  const requestId = created.json.request_id
  check('respond-target request published', published.status === 200, published)

  // Unrestricted responder (renterA) succeeds with a private_offer.
  const okOffer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'private_offer', amount: 100, idempotency_key: `offer-ok-${RUN_ID}` })
  check('private_offer succeeds for an unrestricted responder', okOffer.status === 201, okOffer)

  // Restricted responder denied for a commercial offer type.
  const restrictedOffer = await api(restrictedUser.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'private_offer', amount: 100, idempotency_key: `offer-restricted-${RUN_ID}` })
  check('private_offer DENIED for a restricted responder', restrictedOffer.status === 403, restrictedOffer)

  // Suspended responder denied.
  const suspendedOffer = await api(suspendedUser.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'private_offer', amount: 100, idempotency_key: `offer-suspended-${RUN_ID}` })
  check('private_offer DENIED for a suspended responder', suspendedOffer.status === 403, suspendedOffer)

  // message_only is never gated by account status (non-commercial, risk-reducing).
  const restrictedMessage = await api(restrictedUser.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'message_only', message: 'hello', idempotency_key: `msg-restricted-${RUN_ID}` })
  check('message_only succeeds even for a restricted responder (non-commercial)', restrictedMessage.status === 201, restrictedMessage)
  const suspendedMessage = await api(suspendedUser.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'message_only', message: 'hello', idempotency_key: `msg-suspended-${RUN_ID}` })
  check('message_only succeeds even for a suspended responder (non-commercial)', suspendedMessage.status === 201, suspendedMessage)
}

// ══════════════════════════════════════════════════════════════
console.log('=== ACCEPT: requester status gates acceptance (creation tier -- restricted OR suspended blocks) ===')
// ══════════════════════════════════════════════════════════════
{
  // merchantA publishes; renterA responds; then merchantA (the requester/accepter) is temporarily restricted/suspended.
  const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} accept-requester-restricted-${RUN_ID}` }, `accept-req-restricted-create-${RUN_ID}`)
  await publishRequest(merchantA.cookie, created.json.request_id)
  const offer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${created.json.request_id}/offers`, { offer_type: 'private_offer', amount: 50, idempotency_key: `accept-req-restricted-offer-${RUN_ID}` })
  check('offer submitted for requester-restricted-at-accept scenario', offer.status === 201, offer)

  await withAccountStatus(merchantA.userId, 'restrict', async () => {
    const acceptRes = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, {})
    check('accept DENIED when the requester (accepter) is restricted -- accepting creates their first real commitment', acceptRes.status === 403, acceptRes)
  })
  // After restore, the SAME offer can now be accepted (offer was never consumed by the denied attempt).
  const acceptAfterRestore = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, { idempotency_key: `accept-req-restricted-final-${RUN_ID}` })
  check('accept succeeds once the requester is restored to active', acceptAfterRestore.status === 200, acceptAfterRestore)
}

{
  const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} accept-requester-suspended-${RUN_ID}` }, `accept-req-suspended-create-${RUN_ID}`)
  await publishRequest(merchantA.cookie, created.json.request_id)
  const offer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${created.json.request_id}/offers`, { offer_type: 'private_offer', amount: 50, idempotency_key: `accept-req-suspended-offer-${RUN_ID}` })

  await withAccountStatus(merchantA.userId, 'suspend', async () => {
    const acceptRes = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, {})
    check('accept DENIED when the requester (accepter) is suspended', acceptRes.status === 403, acceptRes)
  })
}

// ══════════════════════════════════════════════════════════════
console.log('=== ACCEPT: counterparty (responder) status uses the lighter transaction tier ===')
// ══════════════════════════════════════════════════════════════
{
  // The offer is submitted while renterA is still active (submitting a
  // commercial offer itself requires creation-tier eligibility) -- THEN
  // renterA becomes restricted, and the still-pending offer must remain
  // acceptable: restricted alone must not block servicing an existing
  // opportunity a party already committed to before the restriction.
  const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} accept-responder-restricted-${RUN_ID}` }, `accept-resp-restricted-create-${RUN_ID}`)
  await publishRequest(merchantA.cookie, created.json.request_id)
  const offer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${created.json.request_id}/offers`, { offer_type: 'private_offer', amount: 50, idempotency_key: `accept-resp-restricted-offer-${RUN_ID}` })
  check('offer submitted while responder still active', offer.status === 201, offer)

  await withAccountStatus(renterA.userId, 'restrict', async () => {
    const acceptRes = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, { idempotency_key: `accept-resp-restricted-final-${RUN_ID}` })
    check('accept SUCCEEDS even though the responder (counterparty) is now restricted -- their existing offer remains serviceable', acceptRes.status === 200, acceptRes)
  })
}

{
  // Same shape, but the responder becomes SUSPENDED (not merely
  // restricted) before acceptance -- this must block, since suspended
  // blocks even servicing an existing opportunity.
  const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} accept-responder-suspended-${RUN_ID}` }, `accept-resp-suspended-create-${RUN_ID}`)
  await publishRequest(merchantA.cookie, created.json.request_id)
  const offer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${created.json.request_id}/offers`, { offer_type: 'private_offer', amount: 50, idempotency_key: `accept-resp-suspended-offer-${RUN_ID}` })
  check('offer submitted while responder still active', offer.status === 201, offer)

  await withAccountStatus(renterA.userId, 'suspend', async () => {
    const acceptRes = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, {})
    check('accept DENIED when the responder (counterparty) is now suspended', acceptRes.status === 403, acceptRes)
  })
  // Once restored, the same still-pending offer becomes acceptable again.
  const acceptAfterRestore = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, { idempotency_key: `accept-resp-suspended-final-${RUN_ID}` })
  check('accept succeeds once the responder is restored to active', acceptAfterRestore.status === 200, acceptAfterRestore)
}

// ══════════════════════════════════════════════════════════════
console.log('=== EXISTING TRANSACTION SERVICING: a rent request accepted via marketplace_requests remains serviceable after later restriction ===')
// ══════════════════════════════════════════════════════════════
{
  const created = await createRequest(merchantA.cookie, { transaction_type: 'rent', title: `${QA_MARKER} servicing-${RUN_ID}`, start_date: '2031-07-01', end_date: '2031-07-05' }, `servicing-create-${RUN_ID}`)
  await publishRequest(merchantA.cookie, created.json.request_id)
  const offer = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${created.json.request_id}/offers`, { offer_type: 'private_offer', rental_start_date: '2031-07-01', rental_end_date: '2031-07-05', idempotency_key: `servicing-offer-${RUN_ID}` })
  check('rent offer submitted', offer.status === 201, offer)
  const accepted = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${offer.json.offer_id}/accept`, { idempotency_key: `servicing-accept-${RUN_ID}` })
  check('rent offer accepted -- booking created via accept_marketplace_offer -> create_booking_request -> accept_booking_request', accepted.status === 200 && !!accepted.json?.terms?.booking_id, accepted)
  const bookingId = accepted.json?.terms?.booking_id

  const { data: bookingBefore } = await admin.from('bookings').select('status').eq('id', bookingId).single()
  check('booking reached accepted status through the marketplace_request-driven flow', bookingBefore.status === 'accepted', bookingBefore)

  // Now restrict the requester (merchantA is the listing owner in this
  // flow's backing listing, i.e. the merchant/accepter) AFTER the
  // booking already exists -- existing obligations must remain durable
  // and servicing actions must remain reachable. blockIfCannotTransact
  // (suspended-only) already governs checkout/start per existing,
  // unmodified Buy/Rent/Barter hardening -- restricted alone must not
  // newly block them.
  await withAccountStatus(renterA.userId, 'restrict', async () => {
    const { data: bookingStillThere } = await admin.from('bookings').select('id, status').eq('id', bookingId).single()
    check('the existing booking is untouched by a later restriction on the renter (not deleted, not force-cancelled)', bookingStillThere.id === bookingId && bookingStillThere.status === 'accepted', bookingStillThere)
  })
}

// ══════════════════════════════════════════════════════════════
console.log('=== ALREADY-PUBLISHED REQUEST: stays exactly as-is after the owner is later restricted (confirmed product decision) ===')
// ══════════════════════════════════════════════════════════════
{
  // Uses freshMerchant, not merchantA -- this is the one scenario in this
  // script that needs a genuinely real (is_test=false), anonymously
  // readable request (see the fresh-QA-merchant doc comment above).
  // is_test=false is required here (the assertion below is exactly about
  // real public visibility) -- QA-identifiability instead comes from
  // non-behavioral fields only: the [QA] title marker, the RUN_ID suffix,
  // the description, and the disposable account's own @unitytest.internal
  // QA email domain.
  const created = await createRequest(
    freshMerchant.cookie,
    { transaction_type: 'buy', title: `${QA_MARKER} already-published-${RUN_ID}`, description: `Disposable per-run QA regression fixture for verify-marketplace-request-account-status.mjs (run ${RUN_ID}) -- safe to ignore, not real demand.` },
    `already-published-create-${RUN_ID}`
  )
  const published = await publishRequest(freshMerchant.cookie, created.json.request_id, { skipMarkTest: true })
  check('request published while owner still active', published.status === 200, published)
  const requestId = created.json.request_id

  // TEST CORRECTNESS (must complete with the request genuinely
  // is_test=false, or the public-visibility assertion means nothing) is
  // strictly separated from POST-TEST QA HYGIENE (the `finally` below).
  // Correctness never depends on the hygiene step running -- see
  // quarantineOrphanedPublicFixtures()'s doc comment: if this process is
  // killed before the `finally` executes, the request simply stays real
  // and public until the NEXT run's startup sweep quarantines it; no
  // future run's correctness is affected either way, because every run
  // uses a brand-new disposable merchant with independent, zero, prior
  // supply.
  try {
    await withAccountStatus(freshMerchant.userId, 'restrict', async () => {
      const { data: stillActive } = await admin.from('marketplace_requests').select('status').eq('id', requestId).single()
      check('the already-published request stays status=active after its owner is later restricted -- no retroactive mechanism exists or was added', stillActive.status === 'active', stillActive)

      const publicRead = await api(null, 'GET', `/api/marketplace/requests/${requestId}`, undefined)
      check('the already-published request remains publicly readable after its owner is later restricted', publicRead.status === 200, publicRead)

      // Another user can still submit a commercial offer against it -- the
      // REQUEST OWNER'S restriction does not retroactively freeze new
      // offers from OTHER users (confirmed product decision: "stays
      // exactly as-is", no new offer-blocking mechanism keyed off the
      // request owner's status was added this phase).
      const offerAgainstRestrictedOwner = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${requestId}/offers`, { offer_type: 'private_offer', amount: 10, idempotency_key: `already-published-offer-${RUN_ID}` })
      check('another (unrestricted) user can still submit an offer against a request whose owner is now restricted', offerAgainstRestrictedOwner.status === 201, offerAgainstRestrictedOwner)
    })
  } finally {
    // Best-effort QA hygiene ONLY -- changes is_test alone. Never touches
    // status/offers/requester/timestamps, so the request's real,
    // legitimately-produced lifecycle (e.g. offers_received from the
    // offer submitted just above) is preserved exactly as-is, just no
    // longer publicly discoverable.
    await admin.from('marketplace_requests').update({ is_test: true }).eq('id', requestId)
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== REAPPROVAL: publish works again once restored, provided KYC/cap/freeze still permit it ===')
// ══════════════════════════════════════════════════════════════
{
  let reapprovalRequestId
  await withAccountStatus(merchantA.userId, 'restrict', async () => {
    const created = await createRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} reapproval-${RUN_ID}` }, `reapproval-create-${RUN_ID}`)
    const publishWhileRestricted = await publishRequest(merchantA.cookie, created.json.request_id)
    check('publish denied while restricted', publishWhileRestricted.status === 403, publishWhileRestricted)
    reapprovalRequestId = created.json.request_id
  })
  const publishAfterRestore = await publishRequest(merchantA.cookie, reapprovalRequestId)
  check('the SAME draft (never destroyed) publishes successfully once the account is restored to active', publishAfterRestore.status === 200 && publishAfterRestore.json?.status === 'active', publishAfterRestore)
}

// ══════════════════════════════════════════════════════════════
console.log('=== PUBLICATION_FROZEN interaction: freeze still blocks even an unrestricted account, independent of the new check ===')
// ══════════════════════════════════════════════════════════════
{
  // Audit: _assert_not_publication_frozen() (and the request/publish
  // paths around it) reads only the actor's own merchant_subscriptions
  // row -- no dependency anywhere on merchantA's specific identity, its
  // Pro plan, its historical/pre-existing supply, or any other prior
  // transaction. Safe to move to an independent disposable merchant, so
  // merchantA's merchant_subscriptions row is never written at all (not
  // even inside a try/finally -- see the doc comment above
  // createDisposableQaMerchant). A SEPARATE disposable merchant from the
  // public-visibility one (freshMerchant) is used here deliberately, even
  // though nothing currently would conflict -- independent actors mean
  // this scenario's account-status/lifecycle state can never interact
  // with that one's, now or if either scenario changes in the future.
  const frozenTestMerchant = await createDisposableQaMerchant('frozen', { withSubscriptionRow: true })
  const created = await createRequest(frozenTestMerchant.cookie, { transaction_type: 'buy', title: `${QA_MARKER} frozen-${RUN_ID}` }, `frozen-create-${RUN_ID}`)
  // This disposable merchant's OWN merchant_subscriptions row -- never
  // merchantA's, never reused across runs, so no try/finally is needed
  // for hard-kill safety: an abandoned run's frozen flag on THIS account
  // has no bearing on any future run, which always creates a different one.
  await admin.from('merchant_subscriptions').update({ publication_frozen: true }).eq('merchant_id', frozenTestMerchant.userId)
  const publishWhileFrozen = await publishRequest(frozenTestMerchant.cookie, created.json.request_id)
  check('publish denied while publication_frozen=true (unrelated to account_status, still enforced)', publishWhileFrozen.status === 409, publishWhileFrozen)
  await admin.from('merchant_subscriptions').update({ publication_frozen: false }).eq('merchant_id', frozenTestMerchant.userId)
  const publishAfterUnfreeze = await publishRequest(frozenTestMerchant.cookie, created.json.request_id)
  check('publish succeeds once unfrozen (account_status check did not block or bypass the freeze gate)', publishAfterUnfreeze.status === 200, publishAfterUnfreeze)
}

// ══════════════════════════════════════════════════════════════
console.log('=== CLEANUP ===')
// ══════════════════════════════════════════════════════════════
{
  const { data: leaked } = await admin.from('listings').select('id').ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  if ((leaked ?? []).length > 0) {
    await admin.from('listings').update({ is_test: true }).in('id', leaked.map((l) => l.id))
  }
  // No exclusion needed here for the ALREADY-PUBLISHED REQUEST fixture --
  // its own `finally` (above) already quarantines it (is_test=true)
  // immediately after its public-visibility assertions complete, so by
  // the time this general sweep runs it's already handled. This section
  // is now a plain, unconditional catch-all for every other
  // merchantA/renterA-owned leaked fixture, matching every other
  // verifier's convention in this codebase. (If a hard kill ever skips
  // that scenario's own `finally`, quarantineOrphanedPublicFixtures() at
  // the NEXT run's startup catches it instead -- this section doesn't
  // need to know about that case either.)
  const { data: leakedRequests } = await admin.from('marketplace_requests').select('id').ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  if ((leakedRequests ?? []).length > 0) {
    await admin.from('marketplace_requests').update({ is_test: true }).in('id', leakedRequests.map((r) => r.id))
  }
  const { count: stillLeakedListings } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  const { count: stillLeakedRequests } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  check('cleanup succeeds -- no real (is_test=false) QA listing/request fixtures left behind', (stillLeakedListings ?? 0) === 0 && (stillLeakedRequests ?? 0) === 0, { stillLeakedListings, stillLeakedRequests })

  // Confirm the permanent restrictedUser/suspendedUser fixtures are still
  // exactly as qa-seed.mjs left them -- this script must never weaken them.
  const { data: r } = await admin.from('profiles').select('account_status').eq('id', restrictedUser.userId).single()
  const { data: s } = await admin.from('profiles').select('account_status').eq('id', suspendedUser.userId).single()
  check('restrictedUser fixture remains restricted after this run', r.account_status === 'restricted', r)
  check('suspendedUser fixture remains suspended after this run', s.account_status === 'suspended', s)

  // Confirm merchantA/renterA (temporarily toggled via withAccountStatus) ended active.
  const { data: mA } = await admin.from('profiles').select('account_status').eq('id', merchantA.userId).single()
  const { data: rA } = await admin.from('profiles').select('account_status').eq('id', renterA.userId).single()
  check('merchantA restored to active after all temporary toggles', mA.account_status === 'active', mA)
  check('renterA restored to active after all temporary toggles', rA.account_status === 'active', rA)

  // Deliberately NO cleanup for freshMerchant/its request: this is a true
  // per-run disposable identity (see createDisposableQaMerchant's doc
  // comment) -- correctness of the NEXT run must never depend on this
  // run's cleanup having executed. Its one real (is_test=false) request
  // is allowed to remain as ordinary historical QA data; the next run
  // creates an entirely different RUN_ID-scoped account with independent,
  // zero, prior active supply, so an abandoned/killed run here can never
  // affect it.
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
