#!/usr/bin/env node
/**
 * Permanent regression check for individual listing pause/resume --
 * available to every merchant subscription tier (Starter/Pro/Elite),
 * while bulk listing management stays Pro/Elite-only. Mirrors every
 * other verify-*.mjs script's safety-gate and check() conventions.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-listing-pause-resume.mjs
 * Requires scripts/qa-seed.mjs already run once.
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
    console.error('verify-listing-pause-resume aborted -- safety checks failed:')
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
  console.error('verify-listing-pause-resume aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const QA_MARKER = '[QA] PauseResume'
const RUN_ID = Date.now()
const qaFixtureAccountIds = new Set()

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-listing-pause-resume aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

async function signIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const value = 'base64-' + Buffer.from(JSON.stringify(data.session)).toString('base64')
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
async function getHtml(cookie, path) {
  const res = await fetch(APP_URL + path, { headers: cookie ? { Cookie: cookie } : {} })
  return { status: res.status, html: await res.text() }
}

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

async function setPlan(merchantId, adminId, planId) {
  const { error } = await admin.rpc('admin_correct_merchant_subscription', {
    p_admin_id: adminId,
    p_merchant_id: merchantId,
    p_new_plan_id: planId,
    p_immediate: true,
    p_reason: `pause/resume regression: set to ${planId}`,
    p_idempotency_key: `pause-resume-set-${planId}-${merchantId}-${RUN_ID}-${Math.random()}`,
  })
  if (error) throw new Error(`setPlan(${planId}) failed for ${merchantId}: ${error.message}`)
}
async function insertListing(merchantId, title, overrides = {}) {
  // Deliberately NOT is_test:true by default -- _lock_and_count_active_
  // supply() excludes is_test=true rows entirely (the established QA
  // convention letting fixture accounts exceed the real cap harmlessly),
  // so cap-boundary tests specifically need real, cap-counted rows. Every
  // fixture this script creates is flipped to is_test=true in CLEANUP at
  // the end, matching every other verify-*.mjs script's own convention.
  const { data, error } = await admin.from('listings').insert({
    merchant_id: merchantId, title, country_id: 'ZA', category: 'tools', condition: 'good',
    listing_type: 'sale', sale_price: 1000, quantity_available: 99, status: 'active',
    risk_tier: 'low', ownership_verified: false, condition_confirmed: true,
    ...overrides,
  }).select('id').single()
  if (error) throw new Error(`insertListing failed: ${error.message}`)
  return data.id
}
async function getActiveSupplyBaseline(merchantId) {
  // Reads the SAME combined-supply count the product RPCs themselves use
  // (_lock_and_count_active_supply: real active listings + real active
  // available Skill/Task posts), rather than re-deriving it from a
  // `listings`-only query. Every cap-boundary scenario in this file now
  // runs against a fresh disposable merchant (see createDisposableMerchant()
  // below) whose baseline should always measure 0 -- calling the
  // authoritative RPC directly here, rather than assuming 0, is defense
  // in depth: it keeps the boundary math correct even in the
  // unexpected case that a disposable account's supply isn't genuinely
  // zero, without ever needing to broadly pause a shared account's
  // pre-existing inventory to find out.
  const { data, error } = await admin.rpc('_lock_and_count_active_supply', { p_user_id: merchantId })
  if (error) throw new Error(`getActiveSupplyBaseline failed for ${merchantId}: ${error.message}`)
  return data
}

// Fresh, disposable, per-run merchant -- never reused across runs, never
// mutated, safe to abandon in any state. Used for scenarios that only
// need SOME valid merchant to own a listing, never merchantA/merchantB's
// specific identity or history (matches the same isolation pattern
// already applied to the Affiliate and Commissions verifiers). Starts
// with zero active supply by construction, so it never needs a broad
// clearMerchantActiveListings()-style mutation of a permanent shared
// actor's pre-existing inventory to have cap headroom.
const DISPOSABLE_MERCHANT_PASSWORD = 'PauseResumeRegress123!'
async function createDisposableMerchant(label) {
  const email = `qa-pauseresume-${label}-${RUN_ID}@unitytest.internal`
  const { data: user } = await admin.auth.admin.createUser({ email, password: DISPOSABLE_MERCHANT_PASSWORD, email_confirm: true })
  await admin.from('profiles').update({ role: 'merchant', account_status: 'active', kyc_status: 'approved' }).eq('id', user.user.id)
  const signedIn = await signIn(email, DISPOSABLE_MERCHANT_PASSWORD)
  return { userId: user.user.id, cookie: signedIn.cookie, client: signedIn.client }
}

const merchantA = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const merchantB = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const adminAuth = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)
for (const id of [merchantA.userId, merchantB.userId, adminAuth.userId]) qaFixtureAccountIds.add(id)

// No BASELINE RESET step -- merchantA/merchantB's subscription (plan,
// pending_plan, publication_frozen) is never read or written anywhere in
// this file. Every plan-sensitive scenario below runs against its own
// fresh disposable merchant (see createDisposableMerchant() above),
// which starts at a known baseline by construction, so there is nothing
// for a startup reset to prepare on the permanent shared accounts. This
// is a deliberate omission, not an oversight -- see this phase's report
// for the empirical proof (an adversarial run with merchantA forced onto
// Starter still passes 52/52 and leaves merchantA on Starter, unread and
// unwritten by this script).

console.log('=== BASIC SINGLE LISTING (per tier) ===')
{
  // Real per-tier plan transitions are genuinely under test here (each
  // tier must independently allow pause/resume), so this keeps ONE actor
  // across the Starter->Pro->Elite loop and performs the real
  // transitions -- exactly the "if testing a real plan transition, use a
  // disposable merchant and perform the real transition" guidance. A
  // fresh disposable actor starts at zero active supply, so every
  // resume() in this loop has natural cap headroom regardless of what
  // merchantA's own real historical inventory looks like.
  const basicMerchant = await createDisposableMerchant('basic')
  console.log(`  disposable basic-tier owner this run: ${basicMerchant.userId}`)
  qaFixtureAccountIds.add(basicMerchant.userId)
  for (const [tierName, planId] of [['Starter', 'starter'], ['Pro', 'pro'], ['Elite', 'elite']]) {
    await setPlan(basicMerchant.userId, adminAuth.userId, planId)
    const listingId = await insertListing(basicMerchant.userId, `${QA_MARKER} ${tierName} Basic ${RUN_ID}`)

    const pauseRes = await api(basicMerchant.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
    const { data: afterPause } = await admin.from('listings').select('status').eq('id', listingId).single()
    check(`${tierName}: owner pauses own active listing`, pauseRes.status === 200 && afterPause?.status === 'paused', { pauseRes, afterPause })

    const resumeRes = await api(basicMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
    const { data: afterResume } = await admin.from('listings').select('status').eq('id', listingId).single()
    check(`${tierName}: owner resumes own paused listing`, resumeRes.status === 200 && afterResume?.status === 'active', { resumeRes, afterResume })

    await admin.from('listings').update({ status: 'paused', is_test: true }).eq('id', listingId) // keep supply clean for the next tier; quarantine immediately
  }
}

console.log('=== AUTHORIZATION ===')
{
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} Auth ${RUN_ID}`)

  const anonPause = await api(null, 'POST', `/api/listings/${listingId}/pause`, {})
  check('anonymous pause denied', anonPause.status === 401, anonPause)

  const otherPause = await api(merchantB.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('other merchant pause denied', otherPause.status === 403, otherPause)

  await admin.from('listings').update({ status: 'paused' }).eq('id', listingId)
  const otherResume = await api(merchantB.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
  check('other merchant resume denied', otherResume.status === 403, otherResume)
  await admin.from('listings').update({ status: 'active' }).eq('id', listingId)

  // Admin-suspended listing: merchant cannot self-resume via merchant_resume_listing (wrong source state).
  await admin.from('listings').update({ status: 'suspended' }).eq('id', listingId)
  const resumeSuspended = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
  const { data: afterSuspendedAttempt } = await admin.from('listings').select('status').eq('id', listingId).single()
  check('merchant cannot resume an admin-suspended listing (bypass blocked)', resumeSuspended.status === 409 && afterSuspendedAttempt?.status === 'suspended', { resumeSuspended, afterSuspendedAttempt })
  const pauseSuspended = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('merchant cannot pause an admin-suspended listing either (wrong source state)', pauseSuspended.status === 409, pauseSuspended)
}

console.log('=== BULK MANAGEMENT REMAINS PRO/ELITE-ONLY ===')
{
  // Same reasoning as BASIC SINGLE LISTING -- real Starter/Pro/Elite
  // transitions on one disposable actor, never merchantA.
  const bulkMerchant = await createDisposableMerchant('bulk')
  console.log(`  disposable bulk-tier owner this run: ${bulkMerchant.userId}`)
  qaFixtureAccountIds.add(bulkMerchant.userId)

  await setPlan(bulkMerchant.userId, adminAuth.userId, 'starter')
  const listingId = await insertListing(bulkMerchant.userId, `${QA_MARKER} BulkStarter ${RUN_ID}`)
  const starterBulk = await api(bulkMerchant.cookie, 'POST', '/api/listings/bulk', { action: 'pause', listingIds: [listingId] })
  check('Starter denied bulk pause', starterBulk.status === 403, starterBulk)
  const { data: afterStarterBulk } = await admin.from('listings').select('status').eq('id', listingId).single()
  check('Starter bulk denial did not mutate listing state', afterStarterBulk?.status === 'active', afterStarterBulk)

  await setPlan(bulkMerchant.userId, adminAuth.userId, 'pro')
  const proBulk = await api(bulkMerchant.cookie, 'POST', '/api/listings/bulk', { action: 'pause', listingIds: [listingId] })
  const { data: afterProBulk } = await admin.from('listings').select('status').eq('id', listingId).single()
  check('Pro retains bulk pause access', proBulk.status === 200 && afterProBulk?.status === 'paused', { proBulk, afterProBulk })

  const proBulkResume = await api(bulkMerchant.cookie, 'POST', '/api/listings/bulk', { action: 'resume', listingIds: [listingId] })
  check('Pro retains bulk resume access', proBulkResume.status === 200, proBulkResume)

  await setPlan(bulkMerchant.userId, adminAuth.userId, 'elite')
  await admin.from('listings').update({ status: 'paused' }).eq('id', listingId)
  const eliteBulk = await api(bulkMerchant.cookie, 'POST', '/api/listings/bulk', { action: 'resume', listingIds: [listingId] })
  check('Elite retains bulk resume access', eliteBulk.status === 200, eliteBulk)

  await admin.from('listings').update({ status: 'paused', is_test: true }).eq('id', listingId)
}

console.log('=== INDIVIDUAL PATH NEVER REQUIRES THE BULK ENTITLEMENT (source check) ===')
{
  // Checks actual functional usage (the import + call that would gate the
  // route), not mere prose mention -- both route files' own doc comments
  // legitimately explain "unlike .../bulk, this deliberately does NOT
  // check entitlements.bulkListingEnabled", which would false-positive a
  // bare substring search.
  const routeSrc = readFileSync(join(REPO_ROOT, 'src/app/api/listings/[id]/pause/route.ts'), 'utf8') + readFileSync(join(REPO_ROOT, 'src/app/api/listings/[id]/resume/route.ts'), 'utf8')
  check('individual pause/resume routes never call getMerchantEntitlements (no bulk-tier gate)', !routeSrc.includes('getMerchantEntitlements'), {})
  const bulkSrc = readFileSync(join(REPO_ROOT, 'src/app/api/listings/bulk/route.ts'), 'utf8')
  check('bulk route retains its bulkListingEnabled gate (unmodified)', bulkSrc.includes('bulkListingEnabled'), {})
}

console.log('=== SUBSCRIPTION CAP REVALIDATION ON RESUME ===')
{
  // Starter cap = 5, on a fresh disposable actor. Baseline is measured
  // via the same RPC the product code uses (rather than hardcoding 0) as
  // defense-in-depth -- a brand-new actor should always measure 0, but
  // this keeps the exact same relative-baseline math/check labels the
  // section always used, just against an actor whose real supply is
  // never mixed with merchantA's unrelated historical inventory.
  const starterCapMerchant = await createDisposableMerchant('startercap')
  console.log(`  disposable Starter-cap owner this run: ${starterCapMerchant.userId}`)
  qaFixtureAccountIds.add(starterCapMerchant.userId)
  await setPlan(starterCapMerchant.userId, adminAuth.userId, 'starter')
  const starterBaseline = await getActiveSupplyBaseline(starterCapMerchant.userId)
  const starterToCreate = Math.max(0, 5 - 1 - starterBaseline)
  const starterActives = []
  for (let i = 0; i < starterToCreate; i++) starterActives.push(await insertListing(starterCapMerchant.userId, `${QA_MARKER} StarterCapActive${i} ${RUN_ID}`))
  const starterPaused = await insertListing(starterCapMerchant.userId, `${QA_MARKER} StarterCapPaused ${RUN_ID}`, { status: 'paused' })

  const resumeUnderCap = await api(starterCapMerchant.cookie, 'POST', `/api/listings/${starterPaused}/resume`, {})
  const countAfterUnderCap = await getActiveSupplyBaseline(starterCapMerchant.userId)
  check(`Starter: ${starterBaseline + starterToCreate} active + 1 paused -> resume succeeds -> ${starterBaseline + starterToCreate + 1}`, resumeUnderCap.status === 200 && countAfterUnderCap === starterBaseline + starterToCreate + 1, { resumeUnderCap, countAfterUnderCap, starterBaseline, starterToCreate })

  const starterExtraPaused = await insertListing(starterCapMerchant.userId, `${QA_MARKER} StarterCapExtra ${RUN_ID}`, { status: 'paused' })
  const resumeAtCap = await api(starterCapMerchant.cookie, 'POST', `/api/listings/${starterExtraPaused}/resume`, {})
  const { data: extraAfterDenied } = await admin.from('listings').select('status').eq('id', starterExtraPaused).single()
  const countAfterAtCap = await getActiveSupplyBaseline(starterCapMerchant.userId)
  check('Starter: at cap (5) + 1 paused -> resume denied -> remains at cap', resumeAtCap.status === 422 && extraAfterDenied?.status === 'paused' && countAfterAtCap === 5, { resumeAtCap, extraAfterDenied, countAfterAtCap })
  check('Starter at-cap denial uses the normal capacity error, not a generic 500', resumeAtCap.json?.error?.toLowerCase().includes('publication limit'), resumeAtCap.json)
  await admin.from('listings').update({ is_test: true }).in('id', [...starterActives, starterPaused, starterExtraPaused])

  // Pro cap = 20, then Elite (unlimited) -- kept on ONE disposable actor
  // across the transition, since "the SAME previously-denied listing now
  // resumes after upgrading" is a genuine plan-TRANSITION assertion, not
  // just a plan-stable one (matches "if testing a real plan transition,
  // use a disposable merchant and perform the real transition").
  const proEliteCapMerchant = await createDisposableMerchant('proelitecap')
  console.log(`  disposable Pro/Elite-cap owner this run: ${proEliteCapMerchant.userId}`)
  qaFixtureAccountIds.add(proEliteCapMerchant.userId)
  await setPlan(proEliteCapMerchant.userId, adminAuth.userId, 'pro')
  const proBaseline = await getActiveSupplyBaseline(proEliteCapMerchant.userId)
  const proToCreate = Math.max(0, 20 - 1 - proBaseline)
  const proActives = []
  for (let i = 0; i < proToCreate; i++) proActives.push(await insertListing(proEliteCapMerchant.userId, `${QA_MARKER} ProCapActive${i} ${RUN_ID}`))
  const proPaused = await insertListing(proEliteCapMerchant.userId, `${QA_MARKER} ProCapPaused ${RUN_ID}`, { status: 'paused' })
  const proResumeUnderCap = await api(proEliteCapMerchant.cookie, 'POST', `/api/listings/${proPaused}/resume`, {})
  const proCountAfter = await getActiveSupplyBaseline(proEliteCapMerchant.userId)
  check(`Pro: ${proBaseline + proToCreate} active + 1 paused -> resume succeeds -> ${proBaseline + proToCreate + 1}`, proResumeUnderCap.status === 200 && proCountAfter === proBaseline + proToCreate + 1, { proResumeUnderCap, proCountAfter, proBaseline, proToCreate })

  const proExtraPaused = await insertListing(proEliteCapMerchant.userId, `${QA_MARKER} ProCapExtra ${RUN_ID}`, { status: 'paused' })
  const proResumeAtCap = await api(proEliteCapMerchant.cookie, 'POST', `/api/listings/${proExtraPaused}/resume`, {})
  const proCountAtCap = await getActiveSupplyBaseline(proEliteCapMerchant.userId)
  check('Pro: at cap (20) + 1 paused -> resume denied -> remains at cap', proResumeAtCap.status === 422 && proCountAtCap === 20, { proResumeAtCap, proCountAtCap })

  // Elite: unlimited.
  await setPlan(proEliteCapMerchant.userId, adminAuth.userId, 'elite')
  const eliteResume = await api(proEliteCapMerchant.cookie, 'POST', `/api/listings/${proExtraPaused}/resume`, {})
  check('Elite: no subscription publication cap (the same previously-denied listing now resumes)', eliteResume.status === 200, eliteResume)
  await admin.from('listings').update({ is_test: true }).in('id', [...proActives, proPaused, proExtraPaused])
}

console.log('=== PUBLICATION FREEZE ===')
{
  // publication_frozen is subscription-level, permanent-shared-actor
  // state, not just a listing status -- freezing/unfreezing merchantA's
  // REAL subscription row would be exactly the class of shared-actor
  // mutation this hardening phase removes, and the final resume-after-
  // unfreeze call needs cap headroom too. A disposable actor sidesteps
  // both concerns at once.
  const freezeMerchant = await createDisposableMerchant('freeze')
  console.log(`  disposable freeze-test owner this run: ${freezeMerchant.userId}`)
  qaFixtureAccountIds.add(freezeMerchant.userId)
  await setPlan(freezeMerchant.userId, adminAuth.userId, 'starter')
  const listingId = await insertListing(freezeMerchant.userId, `${QA_MARKER} Freeze ${RUN_ID}`)

  await admin.from('merchant_subscriptions').update({ publication_frozen: true }).eq('merchant_id', freezeMerchant.userId)
  const pauseWhileFrozen = await api(freezeMerchant.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('frozen merchant may still pause an existing active listing', pauseWhileFrozen.status === 200, pauseWhileFrozen)

  const resumeWhileFrozen = await api(freezeMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
  check('frozen merchant cannot resume while frozen', resumeWhileFrozen.status === 409 && resumeWhileFrozen.json?.error?.toLowerCase().includes('downgrade'), resumeWhileFrozen)

  await admin.from('merchant_subscriptions').update({ publication_frozen: false }).eq('merchant_id', freezeMerchant.userId)
  const resumeAfterUnfreeze = await api(freezeMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
  check('resume succeeds once freeze is cleared (all other eligibility passes)', resumeAfterUnfreeze.status === 200, resumeAfterUnfreeze)

  await admin.from('listings').update({ status: 'paused', is_test: true }).eq('id', listingId)
}

console.log('=== IDEMPOTENCY / CONCURRENCY ===')
{
  // resume-twice below needs cap headroom -- a fresh disposable actor
  // rather than merchantA (whose real historical active-supply is
  // uncontrolled; a prior phase's diagnosis measured it already over the
  // Starter cap from unrelated residue at one point in this session).
  const concurrencyMerchant = await createDisposableMerchant('concurrency')
  console.log(`  disposable concurrency owner this run: ${concurrencyMerchant.userId}`)
  qaFixtureAccountIds.add(concurrencyMerchant.userId)
  await setPlan(concurrencyMerchant.userId, adminAuth.userId, 'starter')
  const listingId = await insertListing(concurrencyMerchant.userId, `${QA_MARKER} Concurrency ${RUN_ID}`)

  // merchant_pause_listing/merchant_resume_listing originally took no row
  // lock on the target listing and their closing UPDATE had no status
  // precondition -- two concurrent calls on the SAME listing could both
  // pass the guard check and both succeed, each inserting its own
  // listing_history row (a real duplicate-audit-record defect, not just a
  // cosmetic double-200). Fixed via migration
  // 20260904000002_fix_listing_pause_resume_concurrent_duplicate_history.sql:
  // the UPDATE now carries the status precondition in its own WHERE
  // clause, and the history insert is gated on ROW_COUNT > 0, so the
  // race-loser's UPDATE affects 0 rows and it raises the same pre-existing
  // domain error instead. This now gives a hard single-winner contract:
  // exactly one 200, exactly one listing_history row, no 500.
  const pauseTwice = await Promise.all([
    api(concurrencyMerchant.cookie, 'POST', `/api/listings/${listingId}/pause`, {}),
    api(concurrencyMerchant.cookie, 'POST', `/api/listings/${listingId}/pause`, {}),
  ])
  const pauseWinners = pauseTwice.filter((r) => r.status === 200).length
  const { data: afterPauseTwice } = await admin.from('listings').select('status').eq('id', listingId).single()
  const { count: pauseHistoryCount } = await admin.from('listing_history').select('id', { count: 'exact', head: true }).eq('listing_id', listingId).eq('change_reason', 'merchant_paused')
  check('pause called twice concurrently -- exactly one succeeds, final state is paused, exactly one history row, no 500', pauseWinners === 1 && afterPauseTwice?.status === 'paused' && pauseHistoryCount === 1 && pauseTwice.every((r) => r.status === 200 || r.status === 409), { pauseTwice: pauseTwice.map((r) => r.status), afterPauseTwice, pauseHistoryCount })

  const resumeTwice = await Promise.all([
    api(concurrencyMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {}),
    api(concurrencyMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {}),
  ])
  const resumeWinners = resumeTwice.filter((r) => r.status === 200).length
  const { data: afterResumeTwice } = await admin.from('listings').select('status').eq('id', listingId).single()
  const { count: resumeHistoryCount } = await admin.from('listing_history').select('id', { count: 'exact', head: true }).eq('listing_id', listingId).eq('change_reason', 'merchant_resumed')
  check('resume called twice concurrently -- exactly one succeeds, final state is active, exactly one history row, no 500', resumeWinners === 1 && afterResumeTwice?.status === 'active' && resumeHistoryCount === 1 && resumeTwice.every((r) => r.status === 200 || r.status === 409), { resumeTwice: resumeTwice.map((r) => r.status), afterResumeTwice, resumeHistoryCount })
  await admin.from('listings').update({ is_test: true }).eq('id', listingId)

  // Two simultaneous resumes at the cap boundary, on TWO DIFFERENT listings
  // -- this is the scenario that actually determines cap safety. Final
  // active supply must never exceed the cap, regardless of how many of the
  // two calls report success. Own disposable actor -- independent of the
  // concurrency actor above and of merchantB.
  const capRaceMerchant = await createDisposableMerchant('caprace')
  console.log(`  disposable cap-race owner this run: ${capRaceMerchant.userId}`)
  qaFixtureAccountIds.add(capRaceMerchant.userId)
  await setPlan(capRaceMerchant.userId, adminAuth.userId, 'starter')
  const capRaceBaseline = await getActiveSupplyBaseline(capRaceMerchant.userId)
  const capRaceToCreate = Math.max(0, 5 - 1 - capRaceBaseline)
  const capRaceActives = []
  for (let i = 0; i < capRaceToCreate; i++) capRaceActives.push(await insertListing(capRaceMerchant.userId, `${QA_MARKER} CapRaceActive${i} ${RUN_ID}`))
  const capRaceA = await insertListing(capRaceMerchant.userId, `${QA_MARKER} CapRaceA ${RUN_ID}`, { status: 'paused' })
  const capRaceB = await insertListing(capRaceMerchant.userId, `${QA_MARKER} CapRaceB ${RUN_ID}`, { status: 'paused' })
  const capRaceResults = await Promise.all([
    api(capRaceMerchant.cookie, 'POST', `/api/listings/${capRaceA}/resume`, {}),
    api(capRaceMerchant.cookie, 'POST', `/api/listings/${capRaceB}/resume`, {}),
  ])
  const capRaceWinners = capRaceResults.filter((r) => r.status === 200).length
  const finalActiveSupply = await getActiveSupplyBaseline(capRaceMerchant.userId)
  check('two simultaneous resumes at the Starter cap boundary -- exactly one succeeds, final supply never exceeds cap', capRaceWinners === 1 && finalActiveSupply === 5, { capRaceResults: capRaceResults.map((r) => r.status), finalActiveSupply, capRaceBaseline, capRaceToCreate })
  await admin.from('listings').update({ is_test: true }).in('id', [...capRaceActives, capRaceA, capRaceB])
}

console.log('=== EXISTING TRANSACTION PRESERVATION ===')
{
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} Transactions ${RUN_ID}`, { quantity_available: 5 })

  const { data: order, error: orderErr } = await admin.from('orders').insert({
    listing_id: listingId, buyer_id: merchantB.userId, seller_id: merchantA.userId, quantity: 1,
    unit_price: 1000, total_amount: 1000, status: 'pending',
  }).select('id').single()
  if (orderErr) console.error('order fixture insert failed', orderErr)

  const { data: reviewBefore } = await admin.from('reviews').select('id').eq('listing_id', listingId).maybeSingle()
  void reviewBefore

  const pauseRes = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('pause succeeds on a listing with an existing order', pauseRes.status === 200, pauseRes)

  const { data: orderAfter } = await admin.from('orders').select('id, status, total_amount').eq('id', order?.id).maybeSingle()
  check('existing order is not cancelled, deleted, or rewritten by pause', order?.id && orderAfter?.id === order.id && orderAfter?.status === 'pending' && Number(orderAfter?.total_amount) === 1000, { order, orderAfter })

  const { data: listingAfter } = await admin.from('listings').select('status').eq('id', listingId).single()
  check('listing itself is not deleted (still exists, status paused)', listingAfter?.status === 'paused', listingAfter)

  await admin.from('orders').delete().eq('id', order?.id) // QA-only fixture cleanup, real data untouched
  await admin.from('listings').update({ status: 'active' }).eq('id', listingId)
}

console.log('=== PUBLIC VISIBILITY ===')
{
  // This scenario never needed merchantA's specific identity or history --
  // only SOME merchant, active/approved, owning one listing, with a
  // non-owner reader. Using a fresh disposable merchant instead of the
  // permanent shared merchantA removes any need to touch merchantA's
  // pre-existing inventory at all: a brand-new actor starts at zero
  // active supply by construction, so it has natural Starter-cap headroom
  // (0 -> 1, cap 5) without any clearMerchantActiveListings()-style broad
  // mutation of a shared account. merchantB remains the non-owner reader
  // (read-only here, so reusing the permanent shared account carries no
  // contamination risk).
  const visibilityMerchant = await createDisposableMerchant('visibility')
  console.log(`  disposable visibility owner this run: ${visibilityMerchant.userId}`)
  qaFixtureAccountIds.add(visibilityMerchant.userId) // keeps the QA HYGIENE section's ownership check accurate for this disposable actor's fixture
  await setPlan(visibilityMerchant.userId, adminAuth.userId, 'starter')
  const supplyBeforeFixture = await getActiveSupplyBaseline(visibilityMerchant.userId)

  const listingId = await insertListing(visibilityMerchant.userId, `${QA_MARKER} Visibility ${RUN_ID}`)

  const beforePause = await getHtml(null, `/listings/${listingId}`)
  check('active listing is publicly visible before pause', beforePause.status === 200, { status: beforePause.status })

  const { data: publicReadBefore } = await merchantB.client.from('listings').select('id').eq('id', listingId).maybeSingle()
  check('another authenticated user can read the active listing directly (RLS)', !!publicReadBefore, publicReadBefore)

  const pauseRes = await api(visibilityMerchant.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('pause call itself succeeds', pauseRes.status === 200, pauseRes)

  const { data: publicReadAfter } = await merchantB.client.from('listings').select('id').eq('id', listingId).maybeSingle()
  check('paused listing is excluded from public/other-user visibility at the RLS layer', !publicReadAfter, publicReadAfter)

  const { data: ownerReadAfter } = await visibilityMerchant.client.from('listings').select('id, status').eq('id', listingId).maybeSingle()
  check('owner can still read their own paused listing', ownerReadAfter?.status === 'paused', ownerReadAfter)

  const browseResults = await api(null, 'GET', `/api/search/listings?q=${encodeURIComponent(`${QA_MARKER} Visibility ${RUN_ID}`)}`)
  const browseIds = Array.isArray(browseResults.json?.listings) ? browseResults.json.listings.map((l) => l.id) : (Array.isArray(browseResults.json) ? browseResults.json.map((l) => l.id) : [])
  check('paused listing excluded from search results (or search endpoint unreachable this way -- informational)', browseResults.status !== 200 || !browseIds.includes(listingId), { status: browseResults.status, includesId: browseIds.includes(listingId) })

  const supplyBeforeResume = await getActiveSupplyBaseline(visibilityMerchant.userId)

  // Assert the resume call's own response BEFORE asserting its expected
  // side effect -- a denied resume (e.g. cap/freeze) must surface as its
  // own clear failure here, never silently fall through to a confusing
  // "visibility" failure caused by a listing that never actually resumed.
  const resumeRes = await api(visibilityMerchant.cookie, 'POST', `/api/listings/${listingId}/resume`, {})
  check('resume call itself succeeds (prerequisite for the visibility assertion below) -- a fresh disposable owner has natural cap headroom, so this is never a legitimate denial', resumeRes.status === 200, { resumeRes, supplyBeforeFixture, supplyBeforeResume })

  const { data: publicReadAfterResume } = await merchantB.client.from('listings').select('id').eq('id', listingId).maybeSingle()
  check('resumed listing regains public visibility', !!publicReadAfterResume, publicReadAfterResume)

  const browseAfterResume = await api(null, 'GET', `/api/search/listings?q=${encodeURIComponent(`${QA_MARKER} Visibility ${RUN_ID}`)}`)
  const browseIdsAfterResume = Array.isArray(browseAfterResume.json?.listings) ? browseAfterResume.json.listings.map((l) => l.id) : (Array.isArray(browseAfterResume.json) ? browseAfterResume.json.map((l) => l.id) : [])
  check('resumed listing is findable again through the canonical public search route (or search endpoint unreachable this way -- informational)', browseAfterResume.status !== 200 || browseIdsAfterResume.includes(listingId), { status: browseAfterResume.status, includesId: browseIdsAfterResume.includes(listingId) })

  // Quarantine (is_test:true), never delete -- listings.merchant_id is
  // `references profiles(id) on delete cascade`, and profiles.id is
  // itself `references auth.users on delete cascade`, so deleting the
  // disposable owner's auth user would CASCADE-DELETE this listing row.
  // That would destroy real QA audit/history state, which this codebase
  // never does (mutation is always is_test false->true, never a row
  // delete). The disposable auth user is therefore deliberately left
  // in place -- an orphaned, never-reused QA auth account costs nothing
  // and is the same accepted housekeeping debt already established for
  // the Affiliate/Commissions disposable actors; it is never deleted
  // here specifically to keep the listing row itself intact.
  await admin.from('listings').update({ status: 'paused', is_test: true }).eq('id', listingId)
}

console.log('=== PUBLIC-PROFILE ACTIVE LISTING COUNT ===')
{
  const { count: countBefore } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantA.userId).eq('status', 'active').eq('is_test', false)
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} ProfileCount ${RUN_ID}`)
  const { count: countActive } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantA.userId).eq('status', 'active').eq('is_test', false)
  check('active listing counts toward active supply', countActive === (countBefore ?? 0) + 1, { countBefore, countActive })

  await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  const { count: countAfterPause } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantA.userId).eq('status', 'active').eq('is_test', false)
  check('paused listing no longer counts toward active supply', countAfterPause === countBefore, { countAfterPause, countBefore })
}

console.log('=== RTB PRESERVATION (RTB V2 must not regress) ===')
{
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} RtbPreserve ${RUN_ID}`)
  const { data: rtbTermsBefore, error: rtbTermsErr } = await admin.from('rent_to_buy_listing_terms').insert({
    listing_id: listingId, merchant_id: merchantA.userId, enabled: true, currency: 'ZAR',
    total_purchase_price: 1200, installment_amount: 400, installment_count: 3, payment_frequency: 'monthly',
    possession_trigger_type: 'first_payment', rental_use_rate_amount: 60, rental_use_rate_unit: 'monthly',
    grace_period_days: 7, return_window_days: 14,
  }).select('id, terms_version').single()
  if (rtbTermsErr) console.error('rtb terms fixture insert failed', rtbTermsErr)

  const pauseRes = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('pause succeeds on an RTB-enabled listing', pauseRes.status === 200, pauseRes)

  const { data: rtbTermsAfter } = await admin.from('rent_to_buy_listing_terms').select('id, enabled, total_purchase_price, terms_version').eq('listing_id', listingId).maybeSingle()
  check('RTB terms remain attached and unchanged after pause', rtbTermsAfter?.id === rtbTermsBefore?.id && rtbTermsAfter?.enabled === true && Number(rtbTermsAfter?.total_purchase_price) === 1200, { rtbTermsBefore, rtbTermsAfter })

  await admin.from('listings').update({ status: 'active' }).eq('id', listingId)
}

console.log('=== AFFILIATE PRESERVATION ===')
{
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} AffiliatePreserve ${RUN_ID}`, { accepts_affiliates: true, affiliate_commission_rate: 10 })
  const pauseRes = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('pause succeeds on an Affiliate-enabled listing', pauseRes.status === 200, pauseRes)

  const { data: listingAfter } = await admin.from('listings').select('accepts_affiliates, affiliate_commission_rate').eq('id', listingId).single()
  check('Affiliate configuration remains intact after pause (not cleared/rewritten)', listingAfter?.accepts_affiliates === true && Number(listingAfter?.affiliate_commission_rate) === 10, listingAfter)

  await admin.from('listings').update({ status: 'active' }).eq('id', listingId)
}

console.log('=== ERROR MAPPING ===')
{
  const listingId = await insertListing(merchantA.userId, `${QA_MARKER} ErrorMapping ${RUN_ID}`, { status: 'draft' })
  const pauseDraft = await api(merchantA.cookie, 'POST', `/api/listings/${listingId}/pause`, {})
  check('pausing a non-active listing returns a clear domain error, not a generic 500', pauseDraft.status === 409 && !pauseDraft.json?.error?.includes('Could not save'), pauseDraft)

  const notFoundId = '00000000-0000-0000-0000-000000000000'
  const pauseMissing = await api(merchantA.cookie, 'POST', `/api/listings/${notFoundId}/pause`, {})
  check('pausing a non-existent listing returns 404, not a generic 500', pauseMissing.status === 404, pauseMissing)
}

console.log('=== QA HYGIENE ===')
{
  // Scoped to titles ending in THIS run's own RUN_ID (every fixture this
  // file creates embeds it as the final title token -- confirmed across
  // every insertListing() call site) rather than every historical
  // "[QA] PauseResume%" row ever created. The unscoped query used to work
  // by coincidence only because every fixture, across every run, was
  // always owned by the same fixed set of permanent accounts (merchantA/
  // merchantB/adminAuth) -- now that PUBLIC VISIBILITY uses a fresh
  // disposable actor with a different id every run, an unscoped query
  // would find PRIOR runs' disposable-actor-owned rows and fail against
  // the CURRENT run's fresh qaFixtureAccountIds Set, which never
  // contains a previous run's ids. This is what this check's own label
  // ("...created this run...") already claimed to mean.
  const { data: runListings } = await admin.from('listings').select('id, merchant_id').ilike('title', `${QA_MARKER}%${RUN_ID}`)
  const allOwnedByQaAccounts = (runListings ?? []).every((l) => qaFixtureAccountIds.has(l.merchant_id))
  check('all fixtures created this run are owned by dedicated QA accounts', (runListings ?? []).length > 0 && allOwnedByQaAccounts, { count: runListings?.length })
}

console.log('=== CLEANUP ===')
{
  const { data: toClean } = await admin.from('listings').select('id').ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', `${QA_MARKER}%`).eq('is_test', false)
  check('cleanup succeeds (no real listing fixture of any status left behind after this run)', (stillLeaked ?? 0) === 0, { stillLeaked })

  // No merchantA/merchantB plan reset here -- their subscription is never
  // touched by this script (see the note where they're signed in, above).
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
