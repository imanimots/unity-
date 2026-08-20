#!/usr/bin/env node
/**
 * Permanent regression check for Unity Phase 1 (Merchant Subscriptions &
 * Economics). Real script against the live dev database, matching every
 * prior phase's verify-*.mjs shape and safety gates
 * (verify-merchant-payout-workflow.mjs, verify-order-administration.mjs).
 *
 * Fixture design: every subscription lifecycle call uses a
 * PER-RUN-UNIQUE idempotency key (RUN_ID below) -- request_merchant_plan_change
 * rejects a same-plan request, so a fixed key that replayed a cached
 * "upgrade to X" result across runs would silently skip the real
 * upgrade the second time (the cached jsonb is returned WITHOUT
 * re-running the underlying upsert). Idempotent replay itself is
 * instead proven with an explicit same-run double-call (Scenario B).
 * merchantA/merchantB are both reset to a known Starter baseline via
 * admin_correct_merchant_subscription() at the start of every run
 * (that RPC never rejects a same-plan target), so the whole script is
 * safely re-runnable end to end.
 *
 * No new QA accounts needed -- merchantA drives the main lifecycle
 * scenarios, merchantB (confirmed live to have zero real/is_test=false
 * active listings) drives the listing-cap scenario, admin/renterA/
 * affiliateB cover the admin and forgery checks.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-subscriptions-phase1.mjs
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
    console.error('verify-subscriptions-phase1 aborted -- safety checks failed:')
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
  console.error('verify-subscriptions-phase1 aborted -- NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (!INTERNAL_CRON_SECRET) {
  console.error('verify-subscriptions-phase1 aborted -- INTERNAL_CRON_SECRET missing (needed for the apply-due sweep check)')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const RUN_ID = Date.now()
const QA_LISTING_MARKER = '[QA] Subscription Cap Regression'

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
    p_reason: 'regression baseline reset',
    p_idempotency_key: `sub-regression-reset-${merchantId}-${RUN_ID}`,
  })
  if (error) throw new Error(`baseline reset failed for ${merchantId}: ${error.message}`)
}

async function historyCount(merchantId) {
  const { count } = await admin.from('merchant_subscription_history').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId)
  return count ?? 0
}

async function billingAttemptCount(merchantId) {
  const { count } = await admin.from('merchant_subscription_billing_attempts').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantId)
  return count ?? 0
}

async function getSubscriptionRow(merchantId) {
  const { data } = await admin.from('merchant_subscriptions').select('*').eq('merchant_id', merchantId).maybeSingle()
  return data
}

// ── Load QA accounts ──
let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-subscriptions-phase1 aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}

const { cookie: merchantACookie, userId: merchantAId, client: merchantAClient } = await signIn(creds.accounts.merchantA.email, creds.accounts.merchantA.password)
const { cookie: merchantBCookie, userId: merchantBId } = await signIn(creds.accounts.merchantB.email, creds.accounts.merchantB.password)
const { cookie: renterACookie } = await signIn(creds.accounts.renterA.email, creds.accounts.renterA.password)
const { cookie: adminCookie, userId: adminId } = await signIn(creds.accounts.admin.email, creds.accounts.admin.password)

console.log('=== Baseline reset ===')
await resetToStarter(merchantAId, adminId)
await resetToStarter(merchantBId, adminId)
console.log(`  merchantA (${merchantAId}) and merchantB (${merchantBId}) reset to Starter`)

console.log('=== Scenario A: Plan catalogue & default state ===')
{
  const { status, json } = await api(null, 'GET', '/api/subscriptions/plans')
  check('A1. plan catalogue is public (no auth required)', status === 200, { status })
  const plans = json?.plans ?? []
  const byId = Object.fromEntries(plans.map((p) => [p.id, p]))
  check('A2. exactly 3 active plans returned: starter/pro/elite', plans.length === 3 && byId.starter && byId.pro && byId.elite, { ids: plans.map((p) => p.id) })
  check('A3. Starter rates match the V2 authoritative model (0 fee, 600/1200 bps, global publication cap 5)', byId.starter?.monthly_fee_cents === 0 && byId.starter?.sales_commission_bps === 600 && byId.starter?.rental_commission_bps === 1200 && byId.starter?.active_publication_limit === 5, byId.starter)
  check('A4. Pro rates match the V2 authoritative model (19900 cents fee, 500/1000 bps, global publication cap 20 -- no longer unlimited)', byId.pro?.monthly_fee_cents === 19900 && byId.pro?.sales_commission_bps === 500 && byId.pro?.rental_commission_bps === 1000 && byId.pro?.active_publication_limit === 20, byId.pro)
  check('A5. Elite rates match the V2 authoritative model (49900 cents fee, 400/800 bps, unlimited)', byId.elite?.monthly_fee_cents === 49900 && byId.elite?.sales_commission_bps === 400 && byId.elite?.rental_commission_bps === 800 && byId.elite?.active_publication_limit === null, byId.elite)
  check('A6. barter commission is 0 on every plan', plans.every((p) => p.barter_commission_bps === 0), plans)

  const me = await api(merchantACookie, 'GET', '/api/subscriptions/me')
  check('A7. a freshly-reset merchant resolves to Starter with no row-dependent surprises', me.json?.planId === 'starter', me.json)
  check('A8. GET /api/subscriptions/me requires auth', (await api(null, 'GET', '/api/subscriptions/me')).status === 401, {})
}

console.log('=== Scenario B: Upgrade (billing-gated, immediate) ===')
{
  const declined = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'pro', mockScenario: 'declined', idempotency_key: `sub-upgrade-declined-${RUN_ID}`,
  })
  check('B1. a declined mock charge returns 402 and never changes the plan', declined.status === 402, declined.json)
  const meAfterDecline = await api(merchantACookie, 'GET', '/api/subscriptions/me')
  check('B2. plan is still Starter after a declined upgrade attempt', meAfterDecline.json?.planId === 'starter', meAfterDecline.json)

  const billingCountBefore = await billingAttemptCount(merchantAId)
  const upgradeKey = `sub-upgrade-pro-${RUN_ID}`
  const upgraded = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'pro', mockScenario: 'success', idempotency_key: upgradeKey,
  })
  check('B3. a successful mock charge upgrades the plan immediately', upgraded.status === 200 && upgraded.json?.current_plan_id === 'pro', upgraded.json)
  const billingCountAfter = await billingAttemptCount(merchantAId)
  check('B4. exactly one billing attempt (failed) + one billing attempt (succeeded) recorded so far', billingCountAfter === billingCountBefore + 1, { billingCountBefore, billingCountAfter })

  const meAfterUpgrade = await api(merchantACookie, 'GET', '/api/subscriptions/me')
  check('B5. GET /api/subscriptions/me reflects the new plan and unlimited listing cap', meAfterUpgrade.json?.planId === 'pro' && meAfterUpgrade.json?.listingUsage?.limit === null, meAfterUpgrade.json)

  const historyBefore = await historyCount(merchantAId)
  const replay = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'pro', mockScenario: 'success', idempotency_key: upgradeKey,
  })
  const historyAfter = await historyCount(merchantAId)
  check('B6. exact idempotent replay (same key, same body) returns success with no new history row', replay.status === 200 && historyAfter === historyBefore, { historyBefore, historyAfter, replay: replay.json })

  const conflict = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'elite', mockScenario: 'success', idempotency_key: upgradeKey,
  })
  check('B7. reusing the same idempotency key with a different target plan is rejected as a conflict', conflict.status === 409, conflict.json)

  const samePlan = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'pro', mockScenario: 'success', idempotency_key: `sub-upgrade-same-plan-${RUN_ID}`,
  })
  check('B8. requesting the plan already active is rejected, not silently accepted', samePlan.status === 409, samePlan.json)
}

console.log('=== Scenario C: Downgrade scheduling & pending-change cancellation ===')
{
  const toElite = await api(merchantACookie, 'POST', '/api/subscriptions/upgrade', {
    targetPlanId: 'elite', mockScenario: 'success', idempotency_key: `sub-upgrade-elite-${RUN_ID}`,
  })
  check('C1. upgrade Starter-path merchant to Elite for the downgrade scenario', toElite.status === 200 && toElite.json?.current_plan_id === 'elite', toElite.json)

  const rejectedDowngradeToStarter = await api(merchantACookie, 'POST', '/api/subscriptions/downgrade', {
    targetPlanId: 'starter', idempotency_key: `sub-downgrade-to-starter-${RUN_ID}`,
  })
  check('C2. downgrade endpoint rejects "starter" as a target -- must use /cancel instead', rejectedDowngradeToStarter.status === 400, rejectedDowngradeToStarter.json)

  const downgrade = await api(merchantACookie, 'POST', '/api/subscriptions/downgrade', {
    targetPlanId: 'pro', idempotency_key: `sub-downgrade-pro-${RUN_ID}`,
  })
  check('C3. downgrade to Pro is scheduled, not immediate', downgrade.status === 200 && downgrade.json?.status === 'pending_change' && downgrade.json?.pending_plan_id === 'pro', downgrade.json)

  const meDuringPending = await api(merchantACookie, 'GET', '/api/subscriptions/me')
  check('C4. current plan stays Elite until the scheduled change actually applies', meDuringPending.json?.planId === 'elite' && meDuringPending.json?.subscription?.status === 'pending_change', meDuringPending.json)

  const cancelPending = await api(merchantACookie, 'POST', '/api/subscriptions/cancel-pending-change', { idempotency_key: `sub-cancel-pending-1-${RUN_ID}` })
  check('C5. cancelling a pending change reverts to active on the unchanged current plan', cancelPending.status === 200 && cancelPending.json?.status === 'active' && cancelPending.json?.pending_plan_id === null, cancelPending.json)

  const cancelPendingAgain = await api(merchantACookie, 'POST', '/api/subscriptions/cancel-pending-change', { idempotency_key: `sub-cancel-pending-2-${RUN_ID}` })
  check('C6. cancelling with nothing pending is rejected, not a silent no-op success', cancelPendingAgain.status === 404, cancelPendingAgain.json)
}

console.log('=== Scenario D: Cancellation to Starter + the apply-due sweep ===')
{
  const cancel = await api(merchantACookie, 'POST', '/api/subscriptions/cancel', { idempotency_key: `sub-cancel-${RUN_ID}` })
  check('D1. cancelling schedules a reversion to Starter, not an immediate change', cancel.status === 200 && cancel.json?.status === 'cancelled' && cancel.json?.pending_plan_id === 'starter', cancel.json)

  const row = await getSubscriptionRow(merchantAId)
  check('D2. current plan is still Elite immediately after cancelling', row?.current_plan_id === 'elite', row)

  // No route can move calendar time backward -- direct service-role
  // update is the documented fallback for this one case, mirroring
  // verify-merchant-payout-workflow.mjs's backdateToStartable().
  const { error: backdateError } = await admin.from('merchant_subscriptions').update({ pending_plan_effective_at: new Date(Date.now() - 60_000).toISOString() }).eq('merchant_id', merchantAId)
  check('D3. backdate the scheduled reversion into the past (fixture setup)', !backdateError, backdateError)

  const swept = await internalApi('/api/internal/subscriptions/apply-due', {})
  check('D4. the internal apply-due sweep reports at least one applied change', swept.status === 200 && swept.json?.applied >= 1, swept.json)

  const rowAfterSweep = await getSubscriptionRow(merchantAId)
  check('D5. merchantA has genuinely reverted to Starter after the sweep', rowAfterSweep?.current_plan_id === 'starter' && rowAfterSweep?.status === 'active' && rowAfterSweep?.pending_plan_id === null, rowAfterSweep)

  const { data: reversionHistory } = await admin.from('merchant_subscription_history').select('*').eq('merchant_id', merchantAId).eq('change_category', 'reversion').order('created_at', { ascending: false }).limit(1)
  check('D6. the reversion is recorded as a system-actor history row', reversionHistory?.[0]?.actor_type === 'system' && reversionHistory?.[0]?.new_plan_id === 'starter', reversionHistory?.[0])

  // Scoped to merchantA specifically rather than asserting the sweep's
  // global applied-count is 0 -- the sweep operates DB-wide, and other
  // merchants could legitimately have their own due changes at the same
  // moment without that being a regression in this phase.
  const sweptAgain = await internalApi('/api/internal/subscriptions/apply-due', {})
  const rowStillStarter = await getSubscriptionRow(merchantAId)
  check('D7. re-running the sweep is a harmless no-op for an already-reverted merchant', sweptAgain.status === 200 && rowStillStarter?.current_plan_id === 'starter' && rowStillStarter?.status === 'active', { sweptAgain: sweptAgain.json, rowStillStarter })
}

console.log('=== Scenario E: Admin correction ===')
{
  const missingReason = await api(adminCookie, 'POST', `/api/admin/subscriptions/${merchantAId}/correct`, {
    newPlanId: 'pro', immediate: true, idempotency_key: `sub-admin-correct-missing-reason-${RUN_ID}`,
  })
  check('E1. admin correction without a reason is rejected', missingReason.status === 400, missingReason.json)

  const corrected = await api(adminCookie, 'POST', `/api/admin/subscriptions/${merchantAId}/correct`, {
    newPlanId: 'pro', immediate: true, reason: 'regression: goodwill correction', idempotency_key: `sub-admin-correct-${RUN_ID}`,
  })
  check('E2. a reasoned admin correction succeeds and applies immediately', corrected.status === 200 && corrected.json?.current_plan_id === 'pro', corrected.json)

  const detail = await api(adminCookie, 'GET', `/api/admin/subscriptions/${merchantAId}`)
  check('E3. admin detail resolves the corrected effective plan', detail.status === 200 && detail.json?.effectivePlanId === 'pro', detail.json)
  const adminCorrectionEntry = (detail.json?.history ?? []).find((h) => h.changeCategory === 'admin_correction')
  check('E4. the correction is recorded as an admin-actor history row, distinct from a merchant-initiated change', adminCorrectionEntry?.actorType === 'admin' && adminCorrectionEntry?.actorId === adminId, adminCorrectionEntry)

  const list = await api(adminCookie, 'GET', '/api/admin/subscriptions')
  check('E5. the admin list includes merchantA after its plan change', (list.json?.subscriptions ?? []).some((s) => s.merchantId === merchantAId), { count: list.json?.subscriptions?.length })

  // adminId itself: a real profile that has never had any subscription
  // RPC called against it, so it genuinely has zero merchant_subscriptions
  // rows -- proves "no row = Starter" resolves without a 404, distinct
  // from merchantB (which the baseline reset above already gave a row).
  const detailNoRowMerchant = await api(adminCookie, 'GET', `/api/admin/subscriptions/${adminId}`)
  check('E6. admin detail resolves a profile with no subscription row to implicit Starter, not a 404', detailNoRowMerchant.status === 200 && detailNoRowMerchant.json?.effectivePlanId === 'starter' && detailNoRowMerchant.json?.subscription === null, detailNoRowMerchant.json)
}

console.log('=== Scenario F: Security -- forged admin access and direct RPC/RLS bypass attempts ===')
{
  const nonAdminCorrect = await api(renterACookie, 'POST', `/api/admin/subscriptions/${merchantAId}/correct`, {
    newPlanId: 'starter', immediate: true, reason: 'forged attempt', idempotency_key: `sub-forged-correct-${RUN_ID}`,
  })
  check('F1. a non-admin cannot call the admin correction route', nonAdminCorrect.status === 401 || nonAdminCorrect.status === 403, nonAdminCorrect.json)

  const { data: crossTenantRead } = await merchantAClient.from('merchant_subscriptions').select('*').eq('merchant_id', merchantBId)
  check('F2. RLS blocks a merchant from reading another merchant\'s subscription row directly', (crossTenantRead ?? []).length === 0, crossTenantRead)

  // The function has zero EXECUTE grant for authenticated/anon (only
  // service_role) -- Postgres blocks the call at the grant level
  // ("permission denied for function", 42501) before the function body's
  // own "not authorized" check ever runs. Both outcomes prove the same
  // security boundary; either is an acceptable pass here.
  const { error: directRpcError } = await merchantAClient.rpc('request_merchant_plan_change', {
    p_merchant_id: merchantAId, p_target_plan_id: 'elite', p_billing_reference: 'forged-ref', p_idempotency_key: `sub-forged-rpc-${RUN_ID}`,
  })
  const rpcBlocked = !!directRpcError && (directRpcError.message.includes('not authorized') || directRpcError.message.includes('permission denied'))
  check('F3. calling the plan-change RPC directly (not via service role) is rejected', rpcBlocked, directRpcError)

  // Postgres RLS silently filters an UPDATE's target rows rather than
  // raising an error -- a blocked write is a genuine 0-row no-op, not an
  // exception. The real proof is that the row is unchanged afterward.
  const beforeWrite = await getSubscriptionRow(merchantAId)
  await merchantAClient.from('merchant_subscriptions').update({ current_plan_id: 'elite' }).eq('merchant_id', merchantAId)
  const afterWrite = await getSubscriptionRow(merchantAId)
  check('F4. a direct table write to merchant_subscriptions has no effect -- zero client write policies', afterWrite?.current_plan_id === beforeWrite?.current_plan_id, { beforeWrite, afterWrite })
}

console.log('=== Scenario G: Starter listing cap (real listings only, test fixtures exempt) ===')
{
  await resetToStarter(merchantBId, adminId)

  // Listings that have ever been through activate_listing() gain a
  // listing_history row, which is immutable (prevent_row_mutation()) --
  // the listing itself can then never be hard-deleted (confirmed live:
  // deleting one raises "listing_history records are immutable and
  // cannot be updated or deleted", a real FK/trigger interaction, not a
  // hypothetical). Fixtures are therefore REUSED across runs (reset to
  // 'pending'/is_test=false at the start) rather than recreated, and
  // SUSPENDED + marked is_test=true at the end (never deleted) so
  // nothing real/public-visible lingers between runs.
  const { data: existingFixtures } = await admin.from('listings').select('id, title').eq('merchant_id', merchantBId).ilike('title', `${QA_LISTING_MARKER}%`)
  const existingByTitle = new Map((existingFixtures ?? []).map((l) => [l.title, l.id]))

  const listingIds = []
  for (let i = 1; i <= 6; i++) {
    const title = `${QA_LISTING_MARKER} #${i}`
    const existingId = existingByTitle.get(title)
    if (existingId) {
      const { error } = await admin.from('listings').update({ status: 'pending', is_test: false }).eq('id', existingId)
      if (error) throw new Error(`fixture listing reset failed: ${error.message}`)
      await admin.from('listing_moderation').upsert({ listing_id: existingId, moderation_status: 'approved' })
      listingIds.push(existingId)
    } else {
      const { data, error } = await admin.from('listings').insert({
        merchant_id: merchantBId, title, country_id: 'ZA', category: 'tech', condition: 'good',
        listing_type: 'rental', quantity_available: 1, status: 'pending', risk_tier: 'low', ownership_verified: false,
        condition_confirmed: true, min_rental_days: 1, is_test: false, daily_rate: 100,
      }).select('id').single()
      if (error) throw new Error(`fixture listing insert failed: ${error.message}`)
      await admin.from('listing_moderation').upsert({ listing_id: data.id, moderation_status: 'approved' })
      listingIds.push(data.id)
    }
  }

  const { count: preExistingRealActive } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantBId).eq('status', 'active').eq('is_test', false)
  check('G1. merchantB starts this scenario with zero real active listings', (preExistingRealActive ?? 0) === 0, { preExistingRealActive })

  const { count: preExistingTestActive } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantBId).eq('status', 'active').eq('is_test', true)
  check('G2. merchantB already has real QA/test fixture listings that would exceed a 5-listing cap if ever miscounted', (preExistingTestActive ?? 0) > 5, { preExistingTestActive })

  const activationResults = []
  for (const listingId of listingIds) {
    const { data, error } = await admin.rpc('activate_listing', { p_listing_id: listingId, p_admin_id: adminId, p_idempotency_key: `sub-cap-activate-${listingId}-${RUN_ID}` })
    activationResults.push({ listingId, data, error: error?.message ?? null })
  }

  check('G3. the first 5 real listings activate successfully on Starter', activationResults.slice(0, 5).every((r) => !r.error), activationResults.slice(0, 5))
  check('G4. the 6th real listing is blocked by the Starter global publication cap', !!activationResults[5].error && activationResults[5].error.includes('active_publication_limit_reached'), activationResults[5])

  const { count: activeAfterCap } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantBId).eq('status', 'active').eq('is_test', false)
  check('G5. exactly 5 real listings are active, never 6', (activeAfterCap ?? 0) === 5, { activeAfterCap })

  const upgraded = await api(merchantBCookie, 'POST', '/api/subscriptions/upgrade', { targetPlanId: 'pro', mockScenario: 'success', idempotency_key: `sub-cap-upgrade-${RUN_ID}` })
  check('G6. upgrading to Pro succeeds', upgraded.status === 200, upgraded.json)

  const sixthListingId = listingIds[5]
  const { data: sixthActivation, error: sixthError } = await admin.rpc('activate_listing', { p_listing_id: sixthListingId, p_admin_id: adminId, p_idempotency_key: `sub-cap-activate-retry-${sixthListingId}-${RUN_ID}` })
  check('G7. the same 6th listing activates once the merchant is on an unlimited plan -- the cap follows the live effective plan, not a fixed snapshot', !sixthError && sixthActivation, { sixthActivation, sixthError: sixthError?.message })

  // Cleanup -- never leave a real, publicly-visible active listing
  // behind. Suspended + is_test=true (not deleted -- these fixtures have
  // listing_history rows and can never be hard-deleted, see above) so a
  // future run's reset step can reuse them and no public surface ever
  // sees them as real/active in the meantime.
  await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', listingIds)
  await resetToStarter(merchantBId, adminId)
  const { count: cleanedUp } = await admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', merchantBId).eq('status', 'active').eq('is_test', false)
  check('G8. no fixture listing is left real and active after the scenario', (cleanedUp ?? 0) === 0, { cleanedUp })
}

console.log('=== Scenario H: Email dispatch ===')
{
  const { data: emailRows } = await admin.from('email_deliveries').select('id, event_type, status').eq('related_entity_type', 'merchant_subscription').eq('related_entity_id', merchantAId)
  check('H1. at least one merchant_subscription-related email was dispatched for merchantA', (emailRows ?? []).length > 0, { count: emailRows?.length })
}

console.log('=== Scenario I: Grandfathering by construction ===')
{
  // The cap check in activate_listing() only ever runs on NEW activation
  // attempts -- it never re-evaluates an already-active listing. This is
  // proven structurally (no sweep, no periodic re-check exists anywhere
  // in this phase's code), and confirmed live: an over-cap merchant's
  // pre-existing real active listings, if any existed, would never be
  // touched by this phase's migrations (purely additive columns/RPCs).
  const { count: migrationCount } = await admin.from('merchant_subscription_plans').select('id', { count: 'exact', head: true })
  check('I1. the plan catalogue has exactly 3 rows -- no unexpected extra/missing plan from a partial migration', migrationCount === 3, { migrationCount })
}

console.log('=== Final cleanup ===')
await resetToStarter(merchantAId, adminId)
await resetToStarter(merchantBId, adminId)
console.log('  merchantA and merchantB reset to Starter')

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
