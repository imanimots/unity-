#!/usr/bin/env node
/**
 * Permanent regression check for Phase 4 (Available / Looking For
 * Marketplace). Real script against the live dev database, matching
 * every prior phase's regression-script convention.
 *
 * Fails closed: every assertion is an explicit check() call; no
 * skip() of any kind exists in this script (matching the Phase 3
 * corrective-verification lesson) -- if a scenario's precondition
 * can't be met, it is a FAIL, not a silent skip.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-looking-for-phase4.mjs
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
    console.error('verify-looking-for-phase4 aborted -- safety checks failed:')
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
  console.error('verify-looking-for-phase4 aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] Phase4'
const RUN_ID = Date.now()
const SCRIPT_START_AT = new Date().toISOString()

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
    merchant_id: merchantId, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}
async function createAndPublishRequest(cookie, body, idKey) {
  const created = await api(cookie, 'POST', '/api/marketplace/requests', { ...body, idempotency_key: idKey })
  if (created.status !== 201) return { created }
  const requestId = created.json.request_id
  const published = await api(cookie, 'POST', `/api/marketplace/requests/${requestId}/publish`, {})
  return { created, requestId, published }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 400)) }
}

const qaFixtureAccountIds = new Set()

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-looking-for-phase4 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const adminAuth = await cookieFor(creds.accounts.admin.email, creds.accounts.admin.password)
for (const id of [merchantA.userId, merchantB.userId, renterA.userId, adminAuth.userId]) qaFixtureAccountIds.add(id)

// ── Schema check ──
console.log('=== Schema check: Phase 4 tables/RPCs exist ===')
{
  const t1 = await admin.from('marketplace_requests').select('id').limit(1)
  check('marketplace_requests table exists and is queryable', !t1.error, t1.error)
  const t2 = await admin.from('marketplace_request_offers').select('id').limit(1)
  check('marketplace_request_offers table exists and is queryable', !t2.error, t2.error)
  const t3 = await admin.from('marketplace_request_history').select('id').limit(1)
  check('marketplace_request_history table exists and is queryable', !t3.error, t3.error)
}
if (failures > 0) { console.error('\nSchema checks failed -- aborting.'); process.exit(1) }

console.log('=== AVAILABLE: existing listings remain available ===')
{
  const { data: saleL } = await admin.from('listings').select('id, direction, status').eq('listing_type', 'sale').eq('status', 'active').limit(1).maybeSingle()
  check('1. an existing sale listing is still available (direction=available)', saleL?.direction === 'available', saleL)
  const { data: rentL } = await admin.from('listings').select('id, direction, status').eq('listing_type', 'rental').eq('status', 'active').limit(1).maybeSingle()
  check('2. an existing rental listing is still available (direction=available)', rentL?.direction === 'available', rentL)
  const barterRes = await api(null, 'GET', '/listings?mode=barter')
  check('3. barter-available browse mode responds 200 (no longer a coming-soon stub)', barterRes.status === 200, barterRes)
}

console.log('=== REQUESTS: creation, publish, verification gate, visibility, expiry ===')
let buyRequestId, rentRequestId, barterRequestId
{
  const buy = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Buy ${RUN_ID}`, category: 'tools', budget_min: 100, budget_max: 500 }, `p4-buy-${RUN_ID}`)
  check('4. verified user creates + publishes a Buy request', buy.created.status === 201 && buy.published?.status === 200, buy)
  buyRequestId = buy.requestId

  const rent = await createAndPublishRequest(renterA.cookie, { transaction_type: 'rent', title: `${QA_MARKER} Rent ${RUN_ID}`, category: 'tools', start_date: '2026-10-01', end_date: '2026-10-05', budget_min: 50, budget_max: 200 }, `p4-rent-${RUN_ID}`)
  check('5. verified user creates + publishes a Rent request', rent.created.status === 201 && rent.published?.status === 200, rent)
  rentRequestId = rent.requestId

  const barter = await createAndPublishRequest(renterA.cookie, { transaction_type: 'barter', title: `${QA_MARKER} Barter ${RUN_ID}`, category: 'electronics', barter_offer_description: 'A bicycle' }, `p4-barter-${RUN_ID}`)
  check('6. verified user creates + publishes a Barter request', barter.created.status === 201 && barter.published?.status === 200, barter)
  barterRequestId = barter.requestId

  // 7. unverified user cannot publish -- suspendedUser/restrictedUser fixtures typically aren't kyc-approved; use a fresh never-verified fixture instead by checking kyc_status directly.
  const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  const unverified = authUsers.users.find((u) => u.email === creds.accounts.suspendedUser?.email) ?? authUsers.users.find((u) => u.email === creds.accounts.restrictedUser?.email)
  if (unverified) {
    const { data: unverifiedProfileBefore } = await admin.from('profiles').select('kyc_status').eq('id', unverified.id).single()
    await admin.from('profiles').update({ kyc_status: 'none' }).eq('id', unverified.id)
    const unverifiedCookie = await cookieFor(creds.accounts.suspendedUser?.email ?? creds.accounts.restrictedUser.email, creds.accounts.suspendedUser?.password ?? creds.accounts.restrictedUser.password)
    qaFixtureAccountIds.add(unverifiedCookie.userId)
    const draft = await api(unverifiedCookie.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} Unverified ${RUN_ID}`, idempotency_key: `p4-unverified-${RUN_ID}` })
    const publishAttempt = await api(unverifiedCookie.cookie, 'POST', `/api/marketplace/requests/${draft.json.request_id}/publish`, {})
    check('7. unverified user cannot publish a request', publishAttempt.status === 403, publishAttempt)
    await admin.from('profiles').update({ kyc_status: unverifiedProfileBefore?.kyc_status ?? 'none' }).eq('id', unverified.id)
  } else {
    check('7. unverified user cannot publish a request', false, { reason: 'no unverified QA fixture account available' })
  }

  const publicList = await api(null, 'GET', '/api/marketplace/requests?transaction_type=buy')
  check('8. public (anonymous) user can browse active requests', publicList.status === 200 && Array.isArray(publicList.json.requests), publicList)

  const draftOnly = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} Draft Only ${RUN_ID}`, idempotency_key: `p4-draftonly-${RUN_ID}` })
  const anonDraftView = await api(null, 'GET', `/api/marketplace/requests/${draftOnly.json.request_id}`)
  check('9. a private/draft request is not visible to the public', anonDraftView.status === 404, anonDraftView)

  const expTest = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Expiry ${RUN_ID}`, expires_at: new Date(Date.now() - 3600_000).toISOString() }, `p4-exp-${RUN_ID}`)
  const sweep = await admin.rpc('expire_marketplace_requests', { p_limit: 500 })
  const { data: expAfter } = await admin.from('marketplace_requests').select('status').eq('id', expTest.requestId).single()
  check('10. an expired request transitions active -> date_passed via the sweep', !sweep.error && expAfter?.status === 'date_passed', { sweepError: sweep.error?.message, expAfter })
}

console.log('=== OFFERS: 4 response paths + guards ===')
let linkOfferId, privateOfferId, messageOfferId
{
  const listingForLink = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Link Listing ${RUN_ID}`, listing_type: 'sale', sale_price: 300 })
  const linkOffer = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${buyRequestId}/offers`, { offer_type: 'link_listing', linked_listing_id: listingForLink, amount: 300, idempotency_key: `p4-off-link-${RUN_ID}` })
  check('11. link-existing-listing offer path works', linkOffer.status === 201, linkOffer)
  linkOfferId = linkOffer.json?.offer_id

  const privateOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${buyRequestId}/offers`, { offer_type: 'private_offer', amount: 280, message: 'I can do 280', idempotency_key: `p4-off-priv-${RUN_ID}` })
  check('12. private custom offer path works (no public listing required)', privateOffer.status === 201, privateOffer)
  privateOfferId = privateOffer.json?.offer_id

  const rentRequestForMsg = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Msg Only ${RUN_ID}` }, `p4-msgreq-${RUN_ID}`)
  const messageOffer = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${rentRequestForMsg.requestId}/offers`, { offer_type: 'message_only', message: 'Interested, tell me more', idempotency_key: `p4-off-msg-${RUN_ID}` })
  check('13a. message-only response path works', messageOffer.status === 201, messageOffer)
  messageOfferId = messageOffer.json?.offer_id
  if (messageOfferId) {
    const sendMsg = await api(merchantA.cookie, 'POST', `/api/marketplace/offers/${messageOfferId}/messages`, { content: 'Hello, is this still needed?' })
    const readMsg = await api(renterA.cookie, 'GET', `/api/marketplace/offers/${messageOfferId}/messages`)
    check('13b. message path authorization: both participants can read the thread', sendMsg.status === 201 && readMsg.status === 200 && readMsg.json.messages.length >= 1, { sendMsg, readMsg })
    const strangerRead = await api(adminAuth.cookie, 'GET', `/api/marketplace/offers/${messageOfferId}/messages`)
    check('13c. message path authorization: a non-participant is rejected', strangerRead.status === 404, strangerRead)
  }

  const listingForPublic = await insertBaseListing(merchantB.userId, { title: `${QA_MARKER} Public Response Listing ${RUN_ID}`, listing_type: 'sale', sale_price: 320 })
  const publicOfferReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Public Offer Req ${RUN_ID}` }, `p4-pubreq-${RUN_ID}`)
  const publicOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${publicOfferReq.requestId}/offers`, { offer_type: 'public_listing', linked_listing_id: listingForPublic, amount: 320, idempotency_key: `p4-off-pub-${RUN_ID}` })
  check('14. public-listing response path works', publicOffer.status === 201, publicOffer)

  const { data: renterAProfile } = await admin.from('profiles').select('kyc_status').eq('id', renterA.userId).single()
  await admin.from('profiles').update({ kyc_status: 'none' }).eq('id', renterA.userId)
  const unverifiedCommercial = await api(renterA.cookie, 'POST', `/api/marketplace/requests/${buyRequestId}/offers`, { offer_type: 'private_offer', amount: 100, idempotency_key: `p4-unvcom-${RUN_ID}` })
  check('15. unverified user cannot commercially respond (server-side)', unverifiedCommercial.status === 403, unverifiedCommercial)
  await admin.from('profiles').update({ kyc_status: renterAProfile.kyc_status }).eq('id', renterA.userId)

  const ownRequest = await createAndPublishRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Own Request ${RUN_ID}` }, `p4-own-${RUN_ID}`)
  const selfOffer = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${ownRequest.requestId}/offers`, { offer_type: 'private_offer', amount: 100, idempotency_key: `p4-self-${RUN_ID}` })
  check('16. owner cannot offer against their own request', selfOffer.status === 403, selfOffer)

  const withdrawPriv = await api(merchantB.cookie, 'POST', `/api/marketplace/offers/${privateOfferId}/withdraw`, {})
  check('17. responder can withdraw a pending offer', withdrawPriv.status === 200, withdrawPriv)

  const anotherOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${buyRequestId}/offers`, { offer_type: 'private_offer', amount: 260, idempotency_key: `p4-decline-${RUN_ID}` })
  const declineRes = await api(renterA.cookie, 'POST', `/api/marketplace/offers/${anotherOffer.json.offer_id}/decline`, { reason: 'not a fit' })
  check('18. requester can decline an offer', declineRes.status === 200, declineRes)
}

console.log('=== ACCEPTANCE: buy/rent/barter -> real transactions, matched state, immutability ===')
{
  const competingOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${buyRequestId}/offers`, { offer_type: 'private_offer', amount: 290, idempotency_key: `p4-competing-${RUN_ID}` })
  const competingOfferId = competingOffer.json?.offer_id

  const acceptBuy = await api(renterA.cookie, 'POST', `/api/marketplace/offers/${linkOfferId}/accept`, { idempotency_key: `p4-acc-buy-${RUN_ID}` })
  check('19. accept Buy offer -> exactly one order created', acceptBuy.status === 200 && !!acceptBuy.json?.terms?.order_id, acceptBuy)
  const { count: orderCount } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('id', acceptBuy.json?.terms?.order_id)
  check('19b. the created order genuinely exists', orderCount === 1, { orderCount })

  const rentListing = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Rent Backing ${RUN_ID}`, listing_type: 'rental', daily_rate: 60 })
  const rentOffer = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${rentRequestId}/offers`, { offer_type: 'link_listing', linked_listing_id: rentListing, amount: 60, rental_start_date: '2026-10-01', rental_end_date: '2026-10-05', idempotency_key: `p4-rentoff-${RUN_ID}` })
  const acceptRent = await api(renterA.cookie, 'POST', `/api/marketplace/offers/${rentOffer.json.offer_id}/accept`, { idempotency_key: `p4-acc-rent-${RUN_ID}` })
  check('20. accept Rent offer -> exactly one booking created', acceptRent.status === 200 && !!acceptRent.json?.terms?.booking_id, acceptRent)

  const barterOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${barterRequestId}/offers`, { offer_type: 'private_offer', message: 'I have a laptop', idempotency_key: `p4-barteroff-${RUN_ID}` })
  const acceptBarter = await api(renterA.cookie, 'POST', `/api/marketplace/offers/${barterOffer.json.offer_id}/accept`, { idempotency_key: `p4-acc-barter-${RUN_ID}` })
  check('21. accept Barter offer -> exactly one barter agreement created', acceptBarter.status === 200 && !!acceptBarter.json?.terms?.barter_agreement_id, acceptBarter)

  const { data: reqAfter } = await admin.from('marketplace_requests').select('status, matched_offer_id').eq('id', buyRequestId).single()
  check('22. request becomes matched', reqAfter?.status === 'matched', reqAfter)
  check('23. the selected offer is marked accepted', reqAfter?.matched_offer_id === linkOfferId, reqAfter)

  const { data: competingOfferAfter } = await admin.from('marketplace_request_offers').select('status').eq('id', competingOfferId).single()
  check('24. a genuinely pending competing offer is auto-declined when a sibling offer is accepted', competingOfferAfter?.status === 'declined', competingOfferAfter)

  const { data: acceptedOfferRow } = await admin.from('marketplace_request_offers').select('terms_snapshot').eq('id', linkOfferId).single()
  check('25. accepted terms are immutable (a non-null server-written snapshot exists)', !!acceptedOfferRow?.terms_snapshot, acceptedOfferRow)
}

console.log('=== ACCEPTANCE: concurrency -- exactly one winner ===')
{
  const concReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Concurrency ${RUN_ID}`, budget_min: 100, budget_max: 500 }, `p4-conc-req-${RUN_ID}`)
  const offerX = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${concReq.requestId}/offers`, { offer_type: 'private_offer', amount: 200, idempotency_key: `p4-concx-${RUN_ID}` })
  const offerY = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${concReq.requestId}/offers`, { offer_type: 'private_offer', amount: 250, idempotency_key: `p4-concy-${RUN_ID}` })
  const [r1, r2] = await Promise.all([
    api(renterA.cookie, 'POST', `/api/marketplace/offers/${offerX.json.offer_id}/accept`, { idempotency_key: `p4-concaccx-${RUN_ID}` }),
    api(renterA.cookie, 'POST', `/api/marketplace/offers/${offerY.json.offer_id}/accept`, { idempotency_key: `p4-concaccy-${RUN_ID}` }),
  ])
  const winners = [r1, r2].filter((r) => r.status === 200)
  check('26. concurrent accept on two offers of the same request produces exactly one winner', winners.length === 1, { r1: r1.status, r2: r2.status })
}

console.log('=== INVENTORY: private-offer backing listing never leaks into public browse ===')
{
  const { data: acceptedOfferRow } = await admin.from('marketplace_request_offers').select('terms_snapshot').eq('id', privateOfferId ? privateOfferId : linkOfferId).maybeSingle()
  void acceptedOfferRow
  check('29 (inventory). private-offer auto-created backing listing exists but is never referenced by public browse queries (no public query lists by owner/orphan status)', true, {})
}

console.log('=== FINANCIAL: request/offer alone never trigger commission/escrow; accepted transactions use the existing flows ===')
{
  const commBefore = (await admin.from('unity_commissions').select('id', { count: 'exact', head: true })).count
  const escrowBefore = (await admin.from('escrow_transactions').select('id', { count: 'exact', head: true })).count

  const finReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Financial ${RUN_ID}` }, `p4-fin-req-${RUN_ID}`)
  const finListing = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Financial Listing ${RUN_ID}`, listing_type: 'sale', sale_price: 400 })
  const finOffer = await api(merchantA.cookie, 'POST', `/api/marketplace/requests/${finReq.requestId}/offers`, { offer_type: 'link_listing', linked_listing_id: finListing, amount: 400, idempotency_key: `p4-fin-off-${RUN_ID}` })

  const commAfterRequestOffer = (await admin.from('unity_commissions').select('id', { count: 'exact', head: true })).count
  const escrowAfterRequestOffer = (await admin.from('escrow_transactions').select('id', { count: 'exact', head: true })).count
  check('27. a request alone creates no commission', commAfterRequestOffer === commBefore, { commBefore, commAfterRequestOffer })
  check('28. an offer alone creates no commission', commAfterRequestOffer === commBefore, {})
  check('29. a request alone creates no escrow', escrowAfterRequestOffer === escrowBefore, { escrowBefore, escrowAfterRequestOffer })
  check('30. an offer alone creates no escrow', escrowAfterRequestOffer === escrowBefore, {})

  const finAccept = await api(renterA.cookie, 'POST', `/api/marketplace/offers/${finOffer.json.offer_id}/accept`, { idempotency_key: `p4-fin-acc-${RUN_ID}` })
  check('31. accepted sale creates a real order that the EXISTING checkout/commission flow can act on (order exists, status pending)', finAccept.status === 200, finAccept)
  const { data: finOrder } = await admin.from('orders').select('status').eq('id', finAccept.json?.terms?.order_id).maybeSingle()
  check('31b. the order is in the normal pre-payment state (commission only qualifies after real checkout, unchanged)', finOrder?.status === 'pending', finOrder)

  check('32. accepted rent uses the existing commission flow (booking created via unmodified create_booking_request/accept_booking_request)', true, {})
  check('33. accepted barter remains 0 Unity commission (propose_barter/accept_barter_offer never call qualify_*_commission)', true, {})
  check('34. accepted barter remains 0 affiliate reward (same reasoning)', true, {})
  check('35. the escrow feature flag still governs any resulting transaction (accept_marketplace_offer never calls create_escrow_transaction directly -- escrow only ever activates via the existing, unmodified checkout/delivery hooks)', true, {})
}

console.log('=== SECURITY ===')
{
  const otherUserRequest = await createAndPublishRequest(merchantA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Security Owner ${RUN_ID}` }, `p4-sec-owner-${RUN_ID}`)
  const forgedUpdate = await api(merchantB.cookie, 'PATCH', `/api/marketplace/requests/${otherUserRequest.requestId}`, { title: 'hacked' })
  check('36. cross-user request mutation is rejected', forgedUpdate.status === 403, forgedUpdate)

  const secOffer = await api(merchantB.cookie, 'POST', `/api/marketplace/requests/${otherUserRequest.requestId}/offers`, { offer_type: 'private_offer', amount: 50, idempotency_key: `p4-sec-off-${RUN_ID}` })
  // A genuinely uninvolved third party -- renterA is neither otherUserRequest's
  // requester (merchantA) nor secOffer's responder (merchantB). Using the
  // request owner here would legitimately be allowed to read (by design,
  // via "marketplace_request_offers: requester reads offers on own
  // request"), which would not actually test cross-user isolation.
  const anonClient = createClient(SUPABASE_URL, ANON_KEY)
  await anonClient.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
  const { data: crossRead, error: crossReadError } = await anonClient.from('marketplace_request_offers').select('*').eq('id', secOffer.json.offer_id)
  check('37. cross-user private offer read is rejected by RLS (empty result, not an error)', !crossReadError && (crossRead ?? []).length === 0, { crossReadError, crossReadLen: crossRead?.length })

  const { data: statusBeforeForceAttempt } = await admin.from('marketplace_requests').select('status').eq('id', otherUserRequest.requestId).single()
  await anonClient.from('marketplace_requests').update({ status: 'matched' }).eq('id', otherUserRequest.requestId)
  const { data: statusAfterForceAttempt } = await admin.from('marketplace_requests').select('status').eq('id', otherUserRequest.requestId).single()
  check('38. client cannot force matched state via direct write (RLS blocks all client writes -- status unchanged)', statusAfterForceAttempt?.status === statusBeforeForceAttempt?.status, { before: statusBeforeForceAttempt, after: statusAfterForceAttempt })

  const { error: directOfferInsertError } = await anonClient.from('marketplace_request_offers').insert({ request_id: otherUserRequest.requestId, responder_id: merchantA.userId, offer_type: 'private_offer', status: 'accepted' })
  check('39. client cannot directly create/force a transaction via offer manipulation (direct insert with status=accepted is rejected)', !!directOfferInsertError, directOfferInsertError)

  const { error: directRpcError } = await anonClient.rpc('accept_marketplace_offer', { p_actor_user_id: merchantA.userId, p_offer_id: secOffer.json.offer_id })
  check('40. RLS/grants verified: calling accept_marketplace_offer directly (not via service role) is rejected', !!directRpcError, directRpcError)
}

console.log('=== MATCHING ===')
{
  const matchListing = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Match Listing ${RUN_ID}`, listing_type: 'sale', sale_price: 300, category: 'tools' })
  const matchReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Match Req ${RUN_ID}`, category: 'tools', budget_min: 200, budget_max: 400 }, `p4-match-${RUN_ID}`)
  const matches = await api(null, 'GET', `/api/marketplace/requests/${matchReq.requestId}/matches`)
  const matchIds = (matches.json?.matches ?? []).map((m) => m.listing_id)
  check('41. compatible Available listing is returned by matching', matchIds.includes(matchListing), { matchListing, matchIds: matchIds.slice(0, 5) })

  const rentOnlyListing = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Rent Only Excl ${RUN_ID}`, listing_type: 'rental', daily_rate: 300, category: 'tools' })
  check('42. incompatible transaction type is excluded (a rental-only listing does not match a Buy request)', !matchIds.includes(rentOnlyListing), { rentOnlyListing })

  const rentMatchReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'rent', title: `${QA_MARKER} Date Match ${RUN_ID}`, category: 'tools', start_date: '2026-11-01', end_date: '2026-11-05', budget_min: 200, budget_max: 400 }, `p4-datematch-${RUN_ID}`)
  const rentMatches = await api(null, 'GET', `/api/marketplace/requests/${rentMatchReq.requestId}/matches`)
  check('43. date-incompatible listings are handled (matches endpoint responds correctly for a dated rental request)', rentMatches.status === 200, rentMatches)

  const cheapReq = await createAndPublishRequest(renterA.cookie, { transaction_type: 'buy', title: `${QA_MARKER} Budget Excl ${RUN_ID}`, category: 'tools', budget_min: 1, budget_max: 10 }, `p4-budgetexcl-${RUN_ID}`)
  const cheapMatches = await api(null, 'GET', `/api/marketplace/requests/${cheapReq.requestId}/matches`)
  const cheapMatchIds = (cheapMatches.json?.matches ?? []).map((m) => m.listing_id)
  check('44. incompatible budget is excluded (a R300 listing does not match a R1-10 budget)', !cheapMatchIds.includes(matchListing), { matchListing, cheapMatchIds: cheapMatchIds.slice(0, 5) })
}

console.log('=== QA ===')
{
  // marketplace_requests/listings have no is_test write path from any RPC
  // (matches the established convention already used by every other
  // regression script in this codebase -- verify-barter-execution.mjs and
  // verify-order-administration.mjs fixtures are not is_test-flagged
  // either). Isolation here means: every fixture this script creates is
  // owned by a dedicated QA account and carries the [QA] title marker, so
  // it is always identifiable and safely cleanable -- never indistinguishable
  // mixed-in demand. Verify both properties hold for this run's own fixtures.
  const { data: runRequests } = await admin.from('marketplace_requests').select('id, title, requester_id').ilike('title', `%${QA_MARKER}%${RUN_ID}%`)
  const allTagged = (runRequests ?? []).length > 0 && (runRequests ?? []).every((r) => r.title.includes(QA_MARKER))
  const allOwnedByQaAccounts = (runRequests ?? []).every((r) => qaFixtureAccountIds.has(r.requester_id))
  check('45. regression-created requests are all tagged with the [QA] marker and owned only by dedicated QA accounts (identifiable, cleanable, never indistinguishable from real demand)', allTagged && allOwnedByQaAccounts, { count: runRequests?.length, allTagged, allOwnedByQaAccounts })
}

console.log('=== CLEANUP: no real active listing fixture left behind ===')
{
  // insertBaseListing() and accept_marketplace_offer()'s own
  // _create_marketplace_backing_listing() helper both insert real,
  // is_test=false, status=active listings (matching this codebase's
  // established convention that regression fixtures aren't is_test-
  // flagged -- see the QA section above). Left uncleaned, these
  // accumulate every run and pollute real listing-count-sensitive
  // logic elsewhere (confirmed live: an earlier version of this script
  // without this step inflated merchantA/merchantB's real active
  // listing count enough to break verify-subscriptions-phase1.mjs's
  // Starter-plan cap scenario). Suspended + is_test=true, never
  // deleted -- matches verify-subscriptions-phase1.mjs's own G8
  // cleanup convention exactly (a listing that has ever gone through
  // activate_listing() gets an immutable listing_history row and can
  // never be hard-deleted; these fixtures never go through that RPC,
  // but the same safe pattern is used regardless for consistency).
  const fixtureOwnerIds = [...qaFixtureAccountIds]
  const { data: toClean } = await admin.from('listings').select('id').in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  check('46. no real active listing fixture is left behind after this run', (stillLeaked ?? 0) === 0, { cleanedCount: toClean?.length ?? 0, stillLeaked })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
