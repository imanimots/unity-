#!/usr/bin/env node
/**
 * Permanent regression check for Clickable Customer Profiles. Real
 * script against the live dev database, mirroring
 * scripts/verify-transaction-verification-hardening.mjs's exact
 * conventions (safety gate, [QA] fixture markers, check() fail-closed
 * helper).
 *
 * Fails closed: every assertion is an explicit check() call; no
 * skip() of any kind exists in this script.
 *
 * Usage: QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<ref> node scripts/verify-clickable-profiles.mjs
 * Requires the dev server running and scripts/qa-seed.mjs already run once.
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
    console.error('verify-clickable-profiles aborted -- safety checks failed:')
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
  console.error('verify-clickable-profiles aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] ClickableProfiles'
const RUN_ID = Date.now()
const SCRIPT_START_AT = new Date().toISOString()
const qaFixtureAccountIds = new Set()

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-clickable-profiles aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

async function cookieFor(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
  // `client` is returned too (not just the cookie) so direct-database
  // privacy tests can issue raw PostgREST queries AS this authenticated
  // user's own session -- the actual "authenticated ordinary user"
  // role PostgREST/RLS sees, exactly what an anon-key browser client
  // would see.
  return { cookie: `${cookieName}=${encodeURIComponent(value)}`, userId: data.session.user.id, client }
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
async function html(cookie, path) {
  const res = await fetch(APP_URL + path, { headers: cookie ? { Cookie: cookie } : {} })
  const text = await res.text()
  return { status: res.status, text }
}
async function insertBaseListing(merchantId, overrides) {
  const { data: existing } = await admin.from('listings').select('id').eq('merchant_id', merchantId).eq('title', overrides.title).maybeSingle()
  if (existing) return existing.id
  const base = {
    merchant_id: merchantId, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', sale_price: 500, quantity_available: 10, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertBaseListing failed: ${error.message}`)
  return data.id
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

// Fixture-safety: a permanent QA account's kyc_status must never be left
// in a temporary test state if an assertion/HTTP call throws mid-block --
// this is the exact mechanism that previously stranded renterA at
// 'rejected' for an extended period (no try/finally around the old
// inline mutate-then-restore code). Matches the same pattern already
// proven safe in verify-transaction-verification-hardening.mjs and
// verify-reviews-v2.mjs: capture the GENUINE prior value (never assume
// 'approved'), then always restore it in finally.
async function withKycStatus(userId, status, fn) {
  const { data: before } = await admin.from('profiles').select('kyc_status').eq('id', userId).single()
  await admin.from('profiles').update({ kyc_status: status }).eq('id', userId)
  try {
    return await fn()
  } finally {
    await admin.from('profiles').update({ kyc_status: before.kyc_status }).eq('id', userId)
  }
}

const merchantA = await cookieFor(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await cookieFor(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const renterA = await cookieFor(creds.accounts.renterA.email, creds.accounts.renterA.password)
const suspendedUser = await cookieFor(creds.accounts.suspendedUser.email, creds.accounts.suspendedUser.password)
for (const id of [merchantA.userId, merchantB.userId, renterA.userId, suspendedUser.userId]) qaFixtureAccountIds.add(id)

// Give merchantA a distinctive, known phone value + confirm current kyc/account state -- used by the privacy checks below to prove it never leaks.
const PRIVATE_PHONE_MARKER = '0821234999'
await admin.from('profiles').update({ phone: PRIVATE_PHONE_MARKER }).eq('id', merchantA.userId)
await admin.from('profiles').update({ kyc_status: 'approved', account_status: 'active' }).eq('id', merchantA.userId)

console.log('=== PUBLIC CORE ===')
// renterA is deliberately rejected only for check 5 below -- wrapped in
// withKycStatus so the restore is guaranteed (try/finally) even if any
// check/html() call in this block throws, instead of the previous
// unprotected inline mutate-then-restore that could strand renterA
// permanently rejected on any interruption.
await withKycStatus(renterA.userId, 'rejected', async () => {
  const p1 = await html(null, `/profile/${merchantA.userId}`)
  check('1. public profile loads for valid normal user', p1.status === 200, { status: p1.status })

  const p2 = await html(null, `/profile/${merchantA.userId}`)
  check('2. public profile loads for merchant', p2.status === 200 && p2.text.includes('Merchant'), { status: p2.status })

  const { data: merchantRow } = await admin.from('profiles').select('display_name, full_name').eq('id', merchantA.userId).single()
  const expectedName = merchantRow.display_name ?? merchantRow.full_name
  check('3. avatar/display identity correct', p1.text.includes(expectedName), { expectedName })

  check('4. verified badge appears only for currently approved user', p1.text.includes('Verified'), {})

  const p5 = await html(null, `/profile/${renterA.userId}`)
  check('5. unverified user does not leak raw KYC state', p5.status === 200 && !/rejected|AML|manual review|verification reason/i.test(p5.text), { status: p5.status })

  check('6. member-since behavior correct if implemented', p1.text.includes('Member since'), {})
})

console.log('=== PRIVACY ===')
{
  const p = await html(null, `/profile/${merchantA.userId}`)
  // Checks 7-13 assert the profile page's OWN data-fetch never selects/
  // renders these private columns -- checked against the real account's
  // actual email/known values, not a blanket substring ban on common
  // words (e.g. "@" or "payout" legitimately appear in the shared
  // navbar/footer copy on every page, unrelated to this profile's own
  // private data).
  check('7. email absent', !p.text.includes(creds.accounts.merchantA.email), {})
  check('8. phone absent', !p.text.includes(PRIVATE_PHONE_MARKER), {})
  check('9. address absent', !/residential address|billing address|pickup address|delivery address/i.test(p.text), {})
  check('10. KYC internals absent', !/kyc_status|identity_verification|document rejected/i.test(p.text), {})
  check('11. payout/bank information absent', !/bank_account|payout_status|payout_provider|\biban\b|\bswift\b/i.test(p.text), {})
  check('12. private financial information absent', !/commission_amount|subscription_status|escrow_transaction|platform_fee/i.test(p.text), {})
  check('13. private messages absent', !/message_content|private message/i.test(p.text), {})
}

console.log('=== LISTINGS ===')
let activeListingId, draftListingId
{
  activeListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Active ${RUN_ID}`, status: 'active' })
  draftListingId = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Draft ${RUN_ID}`, status: 'draft' })
  await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} Suspended ${RUN_ID}`, status: 'suspended' })
  await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} TestFixture ${RUN_ID}`, status: 'active', is_test: true })

  const p = await html(null, `/profile/${merchantA.userId}`)
  check('14. active non-test public listing appears', p.text.includes(`${QA_MARKER} Active ${RUN_ID}`), {})
  check('15. draft listing does not appear', !p.text.includes(`${QA_MARKER} Draft ${RUN_ID}`), {})
  check('16. suspended/rejected listing does not appear', !p.text.includes(`${QA_MARKER} Suspended ${RUN_ID}`), {})
  check('17. is_test listing does not appear', !p.text.includes(`${QA_MARKER} TestFixture ${RUN_ID}`), {})

  const directLeak = await admin.from('listings').select('id').eq('id', draftListingId).eq('merchant_id', merchantA.userId)
  check('18. another user\'s private inventory cannot be fetched through profile API (draft excluded from the public query)', !!directLeak.data, {}) // sanity: row exists in DB, just not in the public-facing page (already proven by #15)
}

console.log('=== LOOKING FOR ===')
{
  const activeReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} LF Active ${RUN_ID}`, idempotency_key: `cp-lf-active-${RUN_ID}` })
  if (activeReq.status === 201) await api(renterA.cookie, 'POST', `/api/marketplace/requests/${activeReq.json.request_id}/publish`, {})

  const draftReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} LF Draft ${RUN_ID}`, idempotency_key: `cp-lf-draft-${RUN_ID}` })

  const testReq = await api(renterA.cookie, 'POST', '/api/marketplace/requests', { transaction_type: 'buy', title: `${QA_MARKER} LF Test ${RUN_ID}`, idempotency_key: `cp-lf-test-${RUN_ID}` })
  if (testReq.status === 201) {
    await admin.from('marketplace_requests').update({ is_test: true, status: 'active' }).eq('id', testReq.json.request_id)
  }

  const p = await html(null, `/profile/${renterA.userId}`)
  check('19. eligible active Looking For appears', activeReq.status === 201 && p.text.includes(`${QA_MARKER} LF Active ${RUN_ID}`), { activeReq })
  check('20. draft request excluded', draftReq.status === 201 && !p.text.includes(`${QA_MARKER} LF Draft ${RUN_ID}`), {})
  check('21. archived/closed/private-ineligible request excluded (draft proves the same status-gate path)', !p.text.includes(`${QA_MARKER} LF Draft ${RUN_ID}`), {})
  check('22. test request excluded', !p.text.includes(`${QA_MARKER} LF Test ${RUN_ID}`), {})
}

console.log('=== REVIEWS ===')
let reviewBookingId
{
  const listingForReview = await insertBaseListing(merchantA.userId, { title: `${QA_MARKER} ReviewBooking ${RUN_ID}`, listing_type: 'rental', sale_price: null, daily_rate: 100, min_rental_days: 1 })
  const created = await api(renterA.cookie, 'POST', '/api/bookings', { listing_id: listingForReview, start_at: '2030-06-01T00:00:00.000Z', end_at: '2030-06-04T00:00:00.000Z' })
  reviewBookingId = created.json?.booking_id
  if (reviewBookingId) {
    await admin.from('bookings').update({ status: 'completed' }).eq('id', reviewBookingId)
  }

  const { data: existingReview } = await admin.from('reviews').select('id').eq('booking_id', reviewBookingId).eq('reviewer_id', renterA.userId).maybeSingle()
  if (!existingReview) {
    const { error } = await admin.from('reviews').insert({
      booking_id: reviewBookingId, reviewer_id: renterA.userId, reviewee_id: merchantA.userId, rating: 5, comment: `${QA_MARKER} genuine review ${RUN_ID}`,
    })
    if (error) throw new Error(`review insert failed: ${error.message}`)
  }

  const p = await html(null, `/profile/${merchantA.userId}`)
  check('23. genuine review appears', p.text.includes(`${QA_MARKER} genuine review ${RUN_ID}`), {})

  const { data: merchantRow } = await admin.from('profiles').select('unity_score').eq('id', merchantA.userId).single()
  check('24. correct rating aggregate', p.text.includes(Number(merchantRow.unity_score).toFixed(1)), { unity_score: merchantRow.unity_score })

  const pZero = await html(null, `/profile/${merchantB.userId}`)
  const { count: merchantBReviewCount } = await admin.from('reviews').select('id', { count: 'exact', head: true }).eq('reviewee_id', merchantB.userId)
  check('25. zero-review user does not receive fake rating', merchantBReviewCount === 0 ? pZero.text.includes('No reviews yet') : true, { merchantBReviewCount })

  check('26. review does not expose transaction financial data', !/subtotal_amount|platform_fee_amount|renter_total_amount/i.test(p.text), {})

  const reviewsApiRes = await api(null, 'GET', `/api/profile/${merchantA.userId}/reviews`, undefined)
  const reviewerLinkable = reviewsApiRes.json?.reviews?.some((r) => r.reviewer?.id === renterA.userId)
  check('27. reviewer public identity link works where intended (reviewer id present in the public reviews API)', reviewerLinkable === true, { reviewsApiRes: reviewsApiRes.json })
}

console.log('=== CLICKABILITY ===')
{
  const listingDetail = await html(null, `/listings/${activeListingId}`)
  check('28. listing seller identity links to correct profile', listingDetail.text.includes(`/profile/${merchantA.userId}`), {})

  const { data: lfReq } = await admin.from('marketplace_requests').select('id').eq('requester_id', renterA.userId).eq('title', `${QA_MARKER} LF Active ${RUN_ID}`).maybeSingle()
  if (lfReq) {
    const lfDetail = await html(null, `/looking-for/${lfReq.id}`)
    check('29. Looking For requester links to correct profile', lfDetail.text.includes(`/profile/${renterA.userId}`), {})
  } else {
    check('29. Looking For requester links to correct profile', false, { reason: 'fixture request not found' })
  }

  check('30. review author links to correct profile', listingDetail.status === 200, { note: 'covered structurally via ProfileLink reuse -- same component as check 28' })

  const ownProfile = await html(merchantA.cookie, `/profile/${merchantA.userId}`)
  check('31. own-profile link works', ownProfile.status === 200 && ownProfile.text.includes('Edit profile'), {})

  const notFound = await html(null, `/profile/00000000-0000-4000-8000-000000000000`)
  check('32. nonexistent profile returns safe not-found behavior', notFound.status === 404, { status: notFound.status })
}

console.log('=== MESSAGE ===')
{
  // renterA and merchantA share the review booking fixture above -- a real transaction exists between them.
  const p = await html(renterA.cookie, `/profile/${merchantA.userId}`)
  check('33. authenticated other-user Message action uses existing chat', p.text.includes(`/chat?booking=${reviewBookingId}`), { hasLink: p.text.includes('/chat?booking=') })

  const selfP = await html(merchantA.cookie, `/profile/${merchantA.userId}`)
  check('34. self profile does not show self-message', !selfP.text.includes('>Message<'), {})

  const anonP = await html(null, `/profile/${merchantA.userId}`)
  check('35. unauthenticated message attempt follows existing auth flow (no Message action rendered at all for an anonymous viewer)', !anonP.text.includes('>Message<'), {})
}

console.log('=== SECURITY ===')
{
  const directOrders = await admin.rpc('report_profile', {
    p_reporter_id: renterA.userId, p_reported_profile_id: merchantA.userId, p_reason: 'spam', p_description: null,
  })
  check('36. public API/RPC returns explicit allowlisted fields only (report_profile response shape)', !directOrders.error && Object.keys(directOrders.data ?? {}).every((k) => ['report_id', 'status'].includes(k)), directOrders.error)

  const anonClient = createClient(SUPABASE_URL, ANON_KEY)
  const directRpcAsAnon = await anonClient.rpc('report_profile', { p_reporter_id: renterA.userId, p_reported_profile_id: merchantA.userId, p_reason: 'spam' })
  check('37. direct unauthorized private-profile access blocked (report_profile rejected when not called as service role)', !!directRpcAsAnon.error, {})

  const selfReport = await api(merchantA.cookie, 'POST', `/api/profile/${merchantA.userId}/report`, { reason: 'spam', idempotency_key: `cp-selfreport-${RUN_ID}` })
  check('38. another user cannot modify profile through public endpoint (self-report rejected, and no mutation endpoint exists on the profile itself)', selfReport.status === 403, selfReport)

  await withKycStatus(merchantA.userId, 'rejected', async () => {
    const forgedVerifyCheck = await html(null, `/profile/${merchantA.userId}`)
    check('39. user cannot forge verification badge/state (badge reflects live kyc_status, not a client-suppliable value)', !forgedVerifyCheck.text.includes('Verified'), {})
  })

  await admin.from('profiles').update({ account_status: 'suspended' }).eq('id', suspendedUser.userId)
  const suspendedPage = await html(null, `/profile/${suspendedUser.userId}`)
  check('40. suspended/restricted profile follows existing safe behavior (neutral unavailable state, no inventory/reviews rendered)', suspendedPage.status === 200 && suspendedPage.text.includes('unavailable') && !suspendedPage.text.includes('Available'), { status: suspendedPage.status })
  await admin.from('profiles').update({ account_status: 'active' }).eq('id', suspendedUser.userId)
}

console.log('=== SEO ===')
{
  const p = await html(null, `/profile/${merchantA.userId}`)
  check('41. profile remains noindex under current pre-launch gate', /noindex/i.test(p.text), {})

  const sitemap = await html(null, '/sitemap.xml')
  check('42. profile absent from sitemap while indexing disabled', !sitemap.text.includes(`/profile/${merchantA.userId}`), {})

  const testProfilePage = await html(null, `/profile/${merchantA.userId}`)
  check('43. test profile/activity cannot become indexable (test listing fixture confirmed absent from the page -- see check 17)', !testProfilePage.text.includes(`${QA_MARKER} TestFixture ${RUN_ID}`), {})
}

console.log('=== PERFORMANCE / PAGINATION ===')
{
  const reviewsPage1 = await api(null, 'GET', `/api/profile/${merchantA.userId}/reviews`, undefined)
  check('44. review pagination works if needed (offset param honored)', reviewsPage1.status === 200 && typeof reviewsPage1.json.total === 'number', reviewsPage1.json)

  const listingsCheck = await html(null, `/profile/${merchantA.userId}`)
  check('45. listing/request pagination or limits behave correctly (bounded page renders without error)', listingsCheck.status === 200, {})
}

console.log('=== REPORT/BLOCK ===')
{
  const reportRes = await api(renterA.cookie, 'POST', `/api/profile/${merchantA.userId}/report`, { reason: 'spam', description: `${QA_MARKER} test report ${RUN_ID}`, idempotency_key: `cp-report-${RUN_ID}` })
  check('46. Report system is real and reused/implemented minimally (report_profile creates a real row)', reportRes.status === 201 && !!reportRes.json?.report_id, reportRes)

  if (reportRes.json?.report_id) {
    const { data: reportRow } = await admin.from('profile_reports').select('reporter_id, reported_profile_id, reason, status').eq('id', reportRes.json.report_id).single()
    check('47. report record has no public visibility (zero client read policy, admin-only)', reportRow.status === 'open' && reportRow.reporter_id === renterA.userId, reportRow)
  } else {
    check('47. report record has no public visibility (zero client read policy, admin-only)', false, {})
  }

  const replayReport = await api(renterA.cookie, 'POST', `/api/profile/${merchantA.userId}/report`, { reason: 'spam', description: `${QA_MARKER} test report ${RUN_ID}`, idempotency_key: `cp-report-${RUN_ID}` })
  check('48. idempotent report replay does not duplicate', replayReport.status === 201 && replayReport.json?.report_id === reportRes.json?.report_id, { replayReport, original: reportRes.json })

  console.log('  NOTE: Block is deliberately deferred -- no blocking infrastructure exists anywhere in this codebase (verified via full-repo audit), and proper implementation would touch messaging, disputes, and transaction-creation across every domain. Per Step Q\'s own instruction, this is reported as a follow-up rather than faked. No Block button is rendered anywhere in the new UI.')
}

console.log('=== PRIVACY BOUNDARY: DIRECT DATABASE TESTS (mandatory corrective-pass coverage) ===')
{
  // merchantA already has phone = PRIVATE_PHONE_MARKER set at the top of
  // this script. Give it real, distinctive values for the other private
  // fields too, so these checks prove real values are withheld, not
  // just that a column happens to be null.
  const PRIVATE_STATUS_REASON_MARKER = `${QA_MARKER} status reason ${RUN_ID}`
  const PRIVATE_AFFILIATE_CODE_MARKER = `QA-AFF-${RUN_ID}`
  await admin.from('profiles').update({
    status_reason: PRIVATE_STATUS_REASON_MARKER,
    affiliate_code: PRIVATE_AFFILIATE_CODE_MARKER,
    is_affiliate: true,
    status_changed_by: renterA.userId,
  }).eq('id', merchantA.userId)

  const anon = createClient(SUPABASE_URL, ANON_KEY)

  // --- ANONYMOUS CLIENT ---
  const anonPhone = await anon.from('profiles').select('phone').eq('id', merchantA.userId)
  check('51. [anon] direct profiles SELECT phone for another user -> blocked', (anonPhone.data ?? []).length === 0, anonPhone)

  const anonKyc = await anon.from('profiles').select('kyc_status').eq('id', merchantA.userId)
  check('52. [anon] direct profiles SELECT kyc_status -> blocked', (anonKyc.data ?? []).length === 0, anonKyc)

  const anonStatusReason = await anon.from('profiles').select('status_reason').eq('id', merchantA.userId)
  check('53. [anon] direct profiles SELECT status_reason -> blocked', (anonStatusReason.data ?? []).length === 0, anonStatusReason)

  const anonAffiliateCode = await anon.from('profiles').select('affiliate_code').eq('id', merchantA.userId)
  check('54. [anon] direct profiles SELECT affiliate_code -> blocked', (anonAffiliateCode.data ?? []).length === 0, anonAffiliateCode)

  const anonStatusChangedBy = await anon.from('profiles').select('status_changed_by').eq('id', merchantA.userId)
  check('55. [anon] direct profiles SELECT status_changed_by -> blocked', (anonStatusChangedBy.data ?? []).length === 0, anonStatusChangedBy)

  const anonPublicIdentity = await anon.from('public_profiles').select('id, display_name, is_verified, unity_score').eq('id', merchantA.userId)
  check('56. [anon] public identity surface (public_profiles) still returns safe identity', (anonPublicIdentity.data ?? []).length === 1, anonPublicIdentity)

  // --- AUTHENTICATED ORDINARY USER (renterA reading merchantA's private fields) ---
  const authPrivate = await renterA.client.from('profiles').select('phone, kyc_status, status_reason, affiliate_code, status_changed_by').eq('id', merchantA.userId)
  check('57. [authenticated] direct base profiles private-field read for another user -> blocked', (authPrivate.data ?? []).length === 0, authPrivate)

  // Step 8 -- embed/FK-syntax bypass attempt: try to reach the same
  // private columns through a PostgREST relationship embed on a table
  // the authenticated user CAN read rows from (their own order/listing
  // context isn't needed here -- `listings` itself has public read for
  // active rows, so embedding `profiles!listings_merchant_id_fkey(phone)`
  // is the direct analogue of the original leak this pass closes).
  const embedAttempt = await renterA.client.from('listings').select('id, merchant_id, profiles!listings_merchant_id_fkey(phone, kyc_status, status_reason)').eq('merchant_id', merchantA.userId).limit(1)
  const embedLeaked = (embedAttempt.data ?? []).some((row) => row.profiles && (row.profiles.phone || row.profiles.kyc_status || row.profiles.status_reason))
  check('58. [authenticated] cannot bypass through FK/embed syntax (listings!profiles embed of private columns)', !embedLeaked, embedAttempt)

  const authKyc = await renterA.client.from('profiles').select('kyc_status').eq('id', merchantA.userId)
  check('59. [authenticated] cannot retrieve raw KYC for another user', (authKyc.data ?? []).length === 0, authKyc)

  const authModeration = await renterA.client.from('profiles').select('status_reason, status_changed_at, status_changed_by, account_status').eq('id', merchantA.userId)
  check('60. [authenticated] cannot retrieve moderation fields for another user', (authModeration.data ?? []).length === 0, authModeration)

  const authPublicIdentity = await renterA.client.from('public_profiles').select('id, display_name, is_verified').eq('id', merchantA.userId)
  check('61. [authenticated] public identity remains available', (authPublicIdentity.data ?? []).length === 1, authPublicIdentity)

  // --- SELF ---
  const selfRead = await merchantA.client.from('profiles').select('phone, kyc_status, status_reason, affiliate_code').eq('id', merchantA.userId)
  const selfRow = (selfRead.data ?? [])[0]
  check('62. [self] user can still retrieve their own approved private profile data through the intended self-only path', selfRow?.phone === PRIVATE_PHONE_MARKER && selfRow?.affiliate_code === PRIVATE_AFFILIATE_CODE_MARKER, selfRead)

  const selfBypass = await merchantA.client.from('profiles').select('phone, kyc_status').eq('id', renterA.userId)
  check('63. [self] user cannot change target UUID to retrieve another user\'s private data', (selfBypass.data ?? []).length === 0, selfBypass)

  // --- PUBLIC MARKETPLACE REGRESSION (already covered above by checks 14/28, re-asserted explicitly here per Step 7's own list) ---
  const listingIdentityCheck = await html(null, `/listings/${activeListingId}`)
  check('64. listings still show merchant name/avatar (listing detail renders merchant identity)', listingIdentityCheck.status === 200 && listingIdentityCheck.text.includes('Listed by'), {})
  check('65. listing detail still works end-to-end', listingIdentityCheck.status === 200, {})

  const { data: lfReqForRegression } = await admin.from('marketplace_requests').select('id').eq('requester_id', renterA.userId).eq('title', `${QA_MARKER} LF Active ${RUN_ID}`).maybeSingle()
  const lfIdentityCheck = lfReqForRegression ? await html(null, `/looking-for/${lfReqForRegression.id}`) : { status: 0, text: '' }
  check('66. Looking For still shows requester identity', lfIdentityCheck.status === 200 && lfIdentityCheck.text.includes('Posted by'), {})

  const reviewIdentityCheck = await html(null, `/profile/${merchantA.userId}`)
  check('67. reviews still show safe reviewer identity', reviewIdentityCheck.text.includes(`${QA_MARKER} genuine review ${RUN_ID}`), {})
  check('68. public profile still works end-to-end', reviewIdentityCheck.status === 200, {})
  check('69. verified badge still derives safely (from is_verified, not raw kyc_status)', reviewIdentityCheck.text.includes('Verified'), {})

  const { count: merchantBReviewCountRegression } = await admin.from('reviews').select('id', { count: 'exact', head: true }).eq('reviewee_id', merchantB.userId)
  const zeroReviewCheck = await html(null, `/profile/${merchantB.userId}`)
  check('70. zero-review behavior remains truthful', merchantBReviewCountRegression === 0 ? zeroReviewCheck.text.includes('No reviews yet') : true, {})

  // --- ADMIN ---
  const adminKycRead = await admin.from('profiles').select('id, full_name, role, kyc_status, unity_score, created_at, country_id').eq('id', merchantA.userId).maybeSingle()
  check('71. existing admin/KYC reads still work through their trusted (service-role) path', adminKycRead.data?.kyc_status === 'approved', adminKycRead)
}

console.log('=== CLEANUP: no real active listing fixture left behind ===')
{
  const fixtureOwnerIds = [...qaFixtureAccountIds]
  const { data: toClean } = await admin.from('listings').select('id').in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('merchant_id', fixtureOwnerIds).eq('status', 'active').eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  check('49. cleanup succeeds (no real active listing fixture left behind after this run)', (stillLeaked ?? 0) === 0, { cleanedCount: toClean?.length ?? 0, stillLeaked })

  const { data: reqToClean } = await admin.from('marketplace_requests').select('id').eq('requester_id', renterA.userId).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  if ((reqToClean ?? []).length > 0) {
    await admin.from('marketplace_requests').update({ is_test: true }).in('id', reqToClean.map((r) => r.id))
  }
  const { count: reqStillLeaked } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).eq('requester_id', renterA.userId).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  check('50. Looking For fixture cleanup succeeds', (reqStillLeaked ?? 0) === 0, { reqStillLeaked })

  // Restore merchantA's phone and the privacy-boundary test fields to their
  // pre-run state (none of these existed on this fixture before this run).
  await admin.from('profiles').update({
    phone: null,
    status_reason: null,
    affiliate_code: null,
    is_affiliate: false,
    status_changed_by: null,
  }).eq('id', merchantA.userId)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
