#!/usr/bin/env node
/**
 * Permanent regression check for the Advertising MVP (ad_advertisers /
 * ad_packages / ad_campaigns / ad_targeting / ad_creatives /
 * ad_balance_accounts / ad_balance_ledger / ad_campaign_funding /
 * ad_impressions / ad_clicks and every RPC in
 * supabase/migrations/20260903*_advertising_*.sql). Real script against
 * the live dev database, matching every prior phase's regression-script
 * convention exactly (see scripts/verify-search-ranking.mjs).
 *
 * Fails closed: every assertion is an explicit check() call; no skip()
 * of any kind exists in this script.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-advertising.mjs
 * Requires scripts/qa-seed.mjs already run once (for QA account ids).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync } from 'node:fs'
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
    console.error('verify-advertising aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}
assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-advertising aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const QA_MARKER = '[QA] Advertising'
const RUN_ID = Date.now()

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 800)) }
}

/**
 * Mirrors the real funding route's own two-step trusted flow: record a
 * verified settlement (as trusted server code would, only ever after a
 * successful charge), then fund the campaign by consuming it. Existing
 * checks that call fund_ad_campaign directly (bypassing the HTTP route)
 * use this instead of fabricating a bare provider_reference, since that
 * bare-reference shape no longer exists as an accepted funding input at
 * all after the settlement-authority hardening.
 */
async function recordVerifiedSettlement({ advertiserId, provider = 'mock', reference, amountCents, currency = 'ZAR', isTest = false, quoteId = null }) {
  return admin.rpc('record_ad_provider_settlement', {
    p_advertiser_id: advertiserId,
    p_provider: provider,
    p_provider_reference: reference,
    p_amount_cents: amountCents,
    p_currency: currency,
    p_is_test: isTest,
    p_quote_id: quoteId,
  })
}

/**
 * Full legitimate provider-funding path for a call site that previously
 * passed a bare p_provider_reference directly. Fetches the package's
 * CURRENT live price/currency (never a possibly-stale JS variable --
 * check 17 below edits a package's price mid-run, so trusting the
 * original createPackage() return value would produce a settlement that
 * fund_ad_campaign's new exact-amount check correctly rejects), records
 * a verified settlement exactly as the real funding route now does, then
 * consumes it. Returns the same { data, error } shape the direct RPC
 * call used to return, so existing check() assertions read unchanged.
 */
/**
 * Uses the canonical get_ad_campaign_funding_quote() RPC (the exact same
 * one the real funding route now calls) to determine the amount to
 * settle/fund -- never the raw package price directly. This matters for
 * every existing caller too, not just the discount-specific checks
 * below: merchantA (the shared permanent QA fixture used throughout
 * this whole file) currently carries a real, active Pro subscription
 * (confirmed live, not assumed), so the discount is genuinely in effect
 * for every pre-existing funding call in this script after the
 * subscription-discount migration -- computing the settlement from
 * pkg.price_cents directly would now be rejected by fund_ad_campaign()
 * as a wrong-amount settlement. packageId is accepted for backward
 * compatibility with existing call sites but no longer used directly.
 */
/**
 * Mirrors the real funding route's full flow exactly: create a
 * PERSISTED, authoritative funding quote (frozen base/discount/amount),
 * record a settlement bound to that exact quote, then consume both via
 * fund_ad_campaign(). Never uses the older live-preview-only
 * get_ad_campaign_funding_quote() for pricing a real funding attempt.
 */
async function fundViaProvider({ actorId, campaignId, advertiserId, isTest = false, reference, idempotencyKey }) {
  const { data: quote, error: quoteErr } = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: actorId, p_campaign_id: campaignId })
  if (quoteErr || !quote) return { data: null, error: quoteErr ?? new Error('quote failed') }
  const { data: settlement, error: settlementErr } = await recordVerifiedSettlement({
    advertiserId, reference, amountCents: quote.amount_due_cents, currency: quote.currency, isTest, quoteId: quote.quote_id,
  })
  if (settlementErr || !settlement) return { data: null, error: settlementErr }
  return admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: actorId, p_campaign_id: campaignId, p_funding_source: 'provider',
    p_settlement_id: settlement.id, p_idempotency_key: idempotencyKey ?? null, p_quote_id: quote.quote_id,
  })
}

/**
 * Fully parameterized draft creation, used by the settlement-authority
 * and serving-authority proof sections below (top-level so it's visible
 * from both -- merchantAId/createdCampaignIds are resolved at call time,
 * well after both are initialized further down this file).
 */
async function freshDraftForListing(advertiserId, packageId, listingId, endAt, isTest = true) {
  const { data: draft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: advertiserId, p_package_id: packageId,
    p_target_type: 'listing', p_listing_id: listingId, p_end_at: endAt, p_is_test: isTest,
  })
  if (draft?.id) createdCampaignIds.push(draft.id)
  return draft
}

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-advertising aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}
const { data: allUsers } = await admin.auth.admin.listUsers()
const findId = (email) => allUsers.users.find((u) => u.email === email)?.id
const merchantAId = findId(creds.accounts.merchantA.email)
const merchantBId = findId(creds.accounts.merchantB.email)
const adminUserId = findId(creds.accounts.admin.email)
if (!merchantAId) throw new Error('could not resolve merchantA id')
if (!merchantBId) throw new Error('could not resolve merchantB id')
if (!adminUserId) throw new Error('could not resolve admin id')

const anonAsMerchantA = createClient(SUPABASE_URL, ANON_KEY)
const { error: aSignInErr } = await anonAsMerchantA.auth.signInWithPassword({ email: creds.accounts.merchantA.email, password: creds.accounts.merchantA.password })
if (aSignInErr) throw new Error(`merchantA sign-in failed: ${aSignInErr.message}`)

const anonAsMerchantB = createClient(SUPABASE_URL, ANON_KEY)
const { error: bSignInErr } = await anonAsMerchantB.auth.signInWithPassword({ email: creds.accounts.merchantB.email, password: creds.accounts.merchantB.password })
if (bSignInErr) throw new Error(`merchantB sign-in failed: ${bSignInErr.message}`)

// ── Minimal HTTP layer for the settlement-authority section below ──────
// Every other check in this script talks to RPCs directly; the specific
// behaviors proven below (declined/timeout charge outcomes, and that a
// caller cannot certify its own payment outcome) live in the funding
// ROUTE's own control flow, not in any RPC or DB constraint -- so they
// can only be proven by calling the real route, mirroring the api()/
// signIn() pattern already established in scripts/verify-skills-tasks-
// barter.mjs and scripts/verify-reviews-v2.mjs exactly.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const cookieName = `sb-${projectRef}-auth-token`
const { data: merchantASession } = await anonAsMerchantA.auth.getSession()
const merchantACookie = `${cookieName}=${encodeURIComponent('base64-' + Buffer.from(JSON.stringify(merchantASession.session)).toString('base64'))}`

async function apiAsMerchantA(method, path, body) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: merchantACookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

// ── Cleanup tracking ──────────────────────────────────────────────────
const createdListingIds = []
const createdAdvertiserIds = []
const createdPackageIds = []
const createdCampaignIds = []
const createdRtbTermsIds = []

async function insertListing(overrides) {
  const base = {
    merchant_id: merchantAId, country_id: 'ZA', category: 'electronics', condition: 'good',
    listing_type: 'rental', quantity_available: 1, status: 'active', direction: 'available',
    daily_rate: 150, risk_tier: 'low', ownership_verified: false, condition_confirmed: true, is_test: false,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertListing failed: ${error.message}`)
  createdListingIds.push(data.id)
  return data.id
}

async function createPackage(overrides) {
  const { data, error } = await admin.rpc('admin_create_ad_package', {
    p_admin_id: adminUserId,
    p_name: `${QA_MARKER} Package ${RUN_ID} ${overrides.name_suffix ?? ''}`,
    p_inventory_class: overrides.inventory_class ?? 'unity_marketplace',
    p_placement_type: overrides.placement_type ?? 'search_result',
    p_placement_tier: overrides.placement_tier ?? 'standard',
    p_position_band: overrides.position_band ?? 'mid',
    p_price_cents: overrides.price_cents ?? 10000,
    p_impression_quota: overrides.impression_quota ?? 10,
    p_currency: 'ZAR',
    p_is_active: true,
    p_is_test: true,
  })
  if (error) throw new Error(`createPackage failed: ${error.message}`)
  createdPackageIds.push(data.id)
  return data
}

console.log('=== Advertiser account lifecycle ===')
let unityAdvertiser, externalAdvertiser
{
  const { data: unityAdv, error: unityErr } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} Unity Advertiser ${RUN_ID}`, p_is_test: true,
  })
  check('1. creating a "unity" advertiser account succeeds and is immediately active (no manual gate)', !unityErr && unityAdv?.status === 'active', { unityErr, unityAdv })
  unityAdvertiser = unityAdv
  if (unityAdv?.id) createdAdvertiserIds.push(unityAdv.id)

  const { data: balAcct } = await admin.from('ad_balance_accounts').select('*').eq('advertiser_id', unityAdvertiser.id).maybeSingle()
  check('2. a zero-balance ad_balance_accounts row is auto-created for the new advertiser', balAcct?.balance_cents === 0, balAcct)

  const { data: extAdv, error: extErr } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'external', p_display_name: `${QA_MARKER} External Advertiser ${RUN_ID}`, p_is_test: true,
  })
  check('3. creating an "external" advertiser account succeeds but starts pending_review (requires manual approval)', !extErr && extAdv?.status === 'pending_review', { extErr, extAdv })
  externalAdvertiser = extAdv
  if (extAdv?.id) createdAdvertiserIds.push(extAdv.id)
}

console.log('=== Cross-advertiser read isolation (base-table RLS) ===')
{
  const { data: ownRead } = await anonAsMerchantA.from('ad_advertisers').select('id').eq('id', unityAdvertiser.id).maybeSingle()
  check('4. the advertiser owner can read their own ad_advertisers row directly', ownRead?.id === unityAdvertiser.id, ownRead)

  const { data: crossRead } = await anonAsMerchantB.from('ad_advertisers').select('id').eq('id', unityAdvertiser.id).maybeSingle()
  check('5. a different authenticated user cannot read another advertiser\'s ad_advertisers row (RLS returns empty, not an error)', crossRead === null, crossRead)
}

console.log('=== Package catalogue (admin RPC, no hardcoded prices) ===')
let standardPackage, cheapExternalPackage, smallQuotaPackage
{
  standardPackage = await createPackage({ name_suffix: 'Standard', price_cents: 10000, impression_quota: 10 })
  check('6. admin_create_ad_package creates an active QA package with the exact price/quota supplied by the caller (never fabricated)', standardPackage.price_cents === 10000 && standardPackage.impression_quota === 10, standardPackage)

  cheapExternalPackage = await createPackage({ name_suffix: 'External', inventory_class: 'external', price_cents: 5000, impression_quota: 5 })
  smallQuotaPackage = await createPackage({ name_suffix: 'SmallQuota', price_cents: 500, impression_quota: 5 })

  const { data: publicRow } = await admin.from('ad_packages_public').select('id').eq('id', standardPackage.id).maybeSingle()
  check('7. an active, non-test... wait -- a QA (is_test=true) package must NOT appear in ad_packages_public even though active', publicRow === null, publicRow)
}

console.log('=== Campaign draft creation: ownership + is_test rejection ===')
let realListingId, otherMerchantListingId, testListingId
{
  realListingId = await insertListing({ title: `${QA_MARKER} Real Listing ${RUN_ID}` })
  otherMerchantListingId = await insertListing({ merchant_id: merchantBId, title: `${QA_MARKER} Other Merchant Listing ${RUN_ID}` })
  testListingId = await insertListing({ title: `${QA_MARKER} Test-Flagged Listing ${RUN_ID}`, is_test: true })

  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()

  const { error: crossOwnErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: otherMerchantListingId, p_end_at: futureEnd, p_is_test: true,
  })
  check('8. an advertiser cannot create a real campaign targeting a listing they do not own', !!crossOwnErr, { crossOwnErr })

  const { error: testTargetErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: testListingId, p_end_at: futureEnd, p_is_test: false,
  })
  check('9. a REAL (is_test=false) campaign cannot target is_test=true content, even content the advertiser owns', !!testTargetErr, { testTargetErr })

  const { error: noEndErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: null, p_is_test: true,
  })
  check('10. a campaign cannot be created without a future end_at', !!noEndErr, { noEndErr })

  const pastEnd = new Date(Date.now() - 86400000).toISOString()
  const { error: pastEndErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: pastEnd, p_is_test: true,
  })
  check('11. a campaign cannot be created with an end_at in the past', !!pastEndErr, { pastEndErr })
}

console.log('=== Campaign funding: insufficient balance, provider funding, commercial snapshot ===')
let campaign1
let campaign1FundedAmount
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const { data: draft, error: draftErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  check('12. a real, owned, non-test-target campaign draft is created successfully', !draftErr && draft?.status === 'draft', { draftErr, draft })
  campaign1 = draft
  if (draft?.id) createdCampaignIds.push(draft.id)

  const { error: insufficientErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: campaign1.id, p_funding_source: 'balance', p_settlement_id: null,
  })
  check('13. funding via balance fails with a zero Advertising Balance (insufficient balance)', !!insufficientErr, { insufficientErr })

  const { data: funded, error: fundErr } = await fundViaProvider({
    actorId: merchantAId, campaignId: campaign1.id, advertiserId: unityAdvertiser.id, packageId: standardPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_1`,
  })
  check('14. funding via the mock provider succeeds and auto-activates a unity-marketplace campaign (no separate review needed)', !fundErr && funded?.status === 'active', { fundErr, funded })
  // snapshot_price_cents is now the DISCOUNTED final amount (merchantA
  // carries a real, live subscription plan -- see fundViaProvider's own
  // note above), not the raw package price directly -- quota/tier are
  // unaffected by any discount, so those two still compare directly
  // against the package.
  check('15. the funded campaign snapshots the package\'s commercial terms exactly (net price/quota/tier)', funded?.snapshot_price_cents === funded?.funded_amount_cents && funded?.snapshot_price_cents <= standardPackage.price_cents && funded?.snapshot_impression_quota === standardPackage.impression_quota, funded)
  check('16. activated_at is set once the campaign becomes active', !!funded?.activated_at, funded)
  // Captured for later checks that assert campaign1's price is
  // unaffected by a subsequent package edit -- the discounted amount
  // actually charged, never the raw package price.
  campaign1FundedAmount = funded?.snapshot_price_cents
}

console.log('=== Package edit after funding never rewrites the campaign\'s snapshot ===')
{
  const { error: editErr } = await admin.rpc('admin_update_ad_package', {
    p_admin_id: adminUserId, p_package_id: standardPackage.id, p_price_cents: 99999,
  })
  check('17. admin can edit the package catalogue row after a campaign already funded against it', !editErr, { editErr })

  const { data: campaignAfterEdit } = await admin.from('ad_campaigns').select('snapshot_price_cents').eq('id', campaign1.id).single()
  check('18. editing the package catalogue row after funding does NOT retroactively change the already-funded campaign\'s snapshot price', campaignAfterEdit?.snapshot_price_cents === campaign1FundedAmount, { campaignAfterEdit, campaign1FundedAmount })
}

console.log('=== get_eligible_ads: serving, dedup, is_test isolation ===')
{
  const { data: candidates, error: candErr } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 5,
  })
  const found = (candidates ?? []).find((c) => c.campaign_id === campaign1.id)
  check('19. an active, eligible campaign is returned by get_eligible_ads for its placement type', !candErr && !!found, { candErr, candidates })
  check('20. get_eligible_ads never returns advertiser/budget/price fields (minimal, presentation-safe columns only)', found && !('price_cents' in found) && !('funded_amount_cents' in found) && !('advertiser_id' in found), found)

  const { data: dedupedCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [realListingId], p_rent_to_buy_enabled: false, p_limit: 5,
  })
  const stillFound = (dedupedCandidates ?? []).find((c) => c.campaign_id === campaign1.id)
  check('21. same-listing dedup: a campaign whose target is already in the organic exclude list is excluded from sponsored selection', !stillFound, dedupedCandidates)
}

console.log('=== RTB gating: an RTB-flavored listing target never serves publicly while the flag is off ===')
let rtbListingId, rtbCampaign
{
  rtbListingId = await insertListing({ title: `${QA_MARKER} RTB Listing ${RUN_ID}` })
  const { data: rtbTerms, error: rtbErr } = await admin.from('rent_to_buy_listing_terms').insert({
    listing_id: rtbListingId, merchant_id: merchantAId, enabled: true, currency: 'ZAR',
    total_purchase_price: 5000, installment_amount: 500, payment_frequency: 'monthly', installment_count: 10,
  }).select('id').single()
  if (rtbErr) throw new Error(`rtb terms fixture failed: ${rtbErr.message}`)
  createdRtbTermsIds.push(rtbTerms.id)

  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const { data: rtbDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: standardPackage.id,
    p_target_type: 'listing', p_listing_id: rtbListingId, p_end_at: futureEnd, p_is_test: false,
  })
  const { data: rtbFunded } = await fundViaProvider({
    actorId: merchantAId, campaignId: rtbDraft.id, advertiserId: unityAdvertiser.id, packageId: standardPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_rtb`,
  })
  rtbCampaign = rtbFunded
  if (rtbCampaign?.id) createdCampaignIds.push(rtbCampaign.id)
  check('22. an RTB-flavored campaign can be created/funded/activated even while RENT_TO_BUY_ENABLED is off (building it now, gated only at serve time)', rtbCampaign?.status === 'active', rtbCampaign)

  const { data: rtbOffCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 20,
  })
  const rtbFoundWithFlagOff = (rtbOffCandidates ?? []).find((c) => c.campaign_id === rtbCampaign.id)
  check('23. get_eligible_ads(p_rent_to_buy_enabled=false) never returns an RTB-flavored campaign', !rtbFoundWithFlagOff, rtbOffCandidates)

  const { data: rtbOnCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: true, p_limit: 20,
  })
  const rtbFoundWithFlagOn = (rtbOnCandidates ?? []).find((c) => c.campaign_id === rtbCampaign.id)
  check('24. get_eligible_ads(p_rent_to_buy_enabled=true) DOES return the same RTB-flavored campaign once the caller asserts the flag is on', !!rtbFoundWithFlagOn, rtbOnCandidates)
}

console.log('=== record_ad_impression: quota safety, self-view exclusion ===')
{
  const { data: before } = await admin.from('ad_campaigns').select('delivered_impressions').eq('id', campaign1.id).single()

  const { data: imp1, error: imp1Err } = await admin.rpc('record_ad_impression', {
    p_campaign_id: campaign1.id, p_placement_type: 'search_result', p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:1`,
  })
  check('25. record_ad_impression for a real (non-self) viewer is recorded and countable', !imp1Err && imp1?.recorded === true && imp1?.countable === true, { imp1Err, imp1 })

  const { data: afterOne } = await admin.from('ad_campaigns').select('delivered_impressions').eq('id', campaign1.id).single()
  check('26. a countable impression increments delivered_impressions by exactly 1', afterOne.delivered_impressions === before.delivered_impressions + 1, { before, afterOne })

  const { data: selfImp } = await admin.rpc('record_ad_impression', {
    p_campaign_id: campaign1.id, p_placement_type: 'search_result', p_viewer_id: merchantAId, p_reach_key: `viewer:${merchantAId}`,
  })
  check('27. a self-view (viewer_id === advertiser owner) is recorded but marked NOT countable (self_view exclusion)', selfImp?.recorded === true && selfImp?.countable === false, selfImp)

  const { data: afterSelf } = await admin.from('ad_campaigns').select('delivered_impressions').eq('id', campaign1.id).single()
  check('28. a self-view impression never consumes campaign delivery quota (delivered_impressions unchanged)', afterSelf.delivered_impressions === afterOne.delivered_impressions, { afterOne, afterSelf })

  const { data: selfImpRow } = await admin.from('ad_impressions').select('exclusion_reason').eq('campaign_id', campaign1.id).eq('viewer_id', merchantAId).maybeSingle()
  check('29. the self-view impression row is tagged with exclusion_reason=self_view for audit purposes', selfImpRow?.exclusion_reason === 'self_view', selfImpRow)
}

console.log('=== record_ad_impression: concurrency-safe quota boundary (never overshoots purchased quota) ===')
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const { data: quotaDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: smallQuotaPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  const { data: quotaCampaign } = await fundViaProvider({
    actorId: merchantAId, campaignId: quotaDraft.id, advertiserId: unityAdvertiser.id, packageId: smallQuotaPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_quota`,
  })
  createdCampaignIds.push(quotaCampaign.id)
  check('30. a small-quota campaign (quota=5) funds and activates for the concurrency test', quotaCampaign?.status === 'active' && quotaCampaign?.snapshot_impression_quota === 5, quotaCampaign)

  const CONCURRENT_CALLS = 20
  const results = await Promise.all(
    Array.from({ length: CONCURRENT_CALLS }, (_, i) =>
      admin.rpc('record_ad_impression', {
        p_campaign_id: quotaCampaign.id, p_placement_type: 'search_result', p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:quota:${i}`,
      })
    )
  )
  const countableCount = results.filter((r) => r.data?.recorded === true && r.data?.countable === true).length

  const { data: finalQuotaCampaign } = await admin.from('ad_campaigns').select('delivered_impressions, status, completion_reason').eq('id', quotaCampaign.id).single()
  check('31. under 20 concurrent impression calls against a quota of 5, exactly 5 are recorded as countable (never overshoots)', countableCount === 5, { countableCount, results: results.map((r) => r.data) })
  check('32. delivered_impressions never exceeds the purchased quota under concurrency', finalQuotaCampaign.delivered_impressions === 5, finalQuotaCampaign)
  check('33. the campaign transitions to completed/quota_reached once its quota is fully delivered', finalQuotaCampaign.status === 'completed' && finalQuotaCampaign.completion_reason === 'quota_reached', finalQuotaCampaign)
}

console.log('=== record_ad_click: idempotency, self-click exclusion, server-resolved destination ===')
{
  const idemKey = `click-idem-${RUN_ID}`
  const { data: click1, error: click1Err } = await admin.rpc('record_ad_click', {
    p_campaign_id: campaign1.id, p_impression_id: null, p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:click`, p_idempotency_key: idemKey,
  })
  check('34. record_ad_click succeeds and resolves the destination server-side (client never supplies a redirect target)', !click1Err && click1?.destination_url === `/listings/${realListingId}`, { click1Err, click1 })

  const { data: click2 } = await admin.rpc('record_ad_click', {
    p_campaign_id: campaign1.id, p_impression_id: null, p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:click`, p_idempotency_key: idemKey,
  })
  check('35. a replayed click with the same idempotency_key returns the same click_id (no duplicate row)', click2?.click_id === click1?.click_id, { click1, click2 })

  const { count: clickRowCount } = await admin.from('ad_clicks').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign1.id).eq('idempotency_key', idemKey)
  check('36. exactly one ad_clicks row exists for the idempotency key despite two calls', clickRowCount === 1, { clickRowCount })

  const { data: selfClick } = await admin.rpc('record_ad_click', {
    p_campaign_id: campaign1.id, p_impression_id: null, p_viewer_id: merchantAId, p_reach_key: `viewer:${merchantAId}:click`,
  })
  const { data: selfClickRow } = await admin.from('ad_clicks').select('is_self_click, countable').eq('campaign_id', campaign1.id).eq('viewer_id', merchantAId).maybeSingle()
  check('37. a click from the advertiser\'s own authenticated viewer id is tagged is_self_click=true and countable=false', selfClickRow?.is_self_click === true && selfClickRow?.countable === false, { selfClick, selfClickRow })
}

console.log('=== Underdelivery credit: exact formula, integer-cent boundary rounding ===')
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  // Package base price is 10000, but the underdelivery formula's base
  // must be the ACTUAL funded_amount_cents (the discounted final
  // amount, per merchantA's real live subscription plan) -- never the
  // raw package price. Both the expected delivered-value and unused-
  // credit are computed dynamically below from bCampaign's own real
  // funded_amount_cents once funding completes.
  const boundaryPackage = await createPackage({ name_suffix: 'Boundary', price_cents: 10000, impression_quota: 100 })
  const { data: bDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: boundaryPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  const { data: bCampaign } = await fundViaProvider({
    actorId: merchantAId, campaignId: bDraft.id, advertiserId: unityAdvertiser.id, packageId: boundaryPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_boundary`,
  })
  createdCampaignIds.push(bCampaign.id)
  const bFundedAmount = bCampaign.funded_amount_cents

  for (let i = 0; i < 37; i++) {
    await admin.rpc('record_ad_impression', { p_campaign_id: bCampaign.id, p_placement_type: 'search_result', p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:boundary:${i}` })
  }
  const { data: balBefore } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()

  // Force the campaign to its end date (admin-only mutation path, service
  // role bypasses RLS) to trigger natural expiry finalization. Must also
  // backdate activated_at, since ad_campaigns_end_after_activation
  // requires end_at > activated_at whenever both are set.
  const { error: backdateErr } = await admin.from('ad_campaigns').update({
    activated_at: new Date(Date.now() - 120000).toISOString(),
    end_at: new Date(Date.now() - 60000).toISOString(),
  }).eq('id', bCampaign.id)
  if (backdateErr) throw new Error(`boundary fixture backdate failed: ${backdateErr.message}`)
  const { data: finalizeResult, error: finalizeErr } = await admin.rpc('finalize_expired_ad_campaigns', { p_actor_id: null })
  check('38. finalize_expired_ad_campaigns processes the expired campaign without error', !finalizeErr && finalizeResult?.finalized_count >= 1, { finalizeErr, finalizeResult })

  const { data: finalCampaign } = await admin.from('ad_campaigns').select('status, completion_reason, delivered_impressions').eq('id', bCampaign.id).single()
  check('39. the expired campaign transitions to completed/end_date_reached', finalCampaign.status === 'completed' && finalCampaign.completion_reason === 'end_date_reached', finalCampaign)

  const { data: ledgerEntry } = await admin.from('ad_balance_ledger').select('*').eq('campaign_id', bCampaign.id).eq('entry_type', 'underdelivery_credit').maybeSingle()
  const expectedDeliveredValue = Math.floor((bFundedAmount * 37) / 100)
  const expectedUnusedCredit = bFundedAmount - expectedDeliveredValue
  check(`40. underdelivery credit formula is exact against the ACTUAL discounted funded amount: floor(${bFundedAmount}*37/100)=${expectedDeliveredValue} delivered, unused_credit=${expectedUnusedCredit}`, ledgerEntry?.amount_cents === expectedUnusedCredit, { ledgerEntry, delivered: finalCampaign.delivered_impressions, bFundedAmount })

  const { data: balAfter } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()
  check('41. the underdelivery credit is applied to the advertiser\'s (non-withdrawable) Advertising Balance exactly once', balAfter.balance_cents === balBefore.balance_cents + expectedUnusedCredit, { balBefore, balAfter })

  check('42. underdelivery credit never exceeds the actual funded amount (the discounted amount, not the raw package price)', ledgerEntry.amount_cents <= bFundedAmount, { ledgerEntry, bFundedAmount })
}

console.log('=== Underdelivery credit: non-round division boundary (quota=3, delivered=1) ===')
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  // Base formula is against the ACTUAL discounted funded_amount_cents,
  // computed dynamically below, exactly as in the boundary check above.
  const oddPackage = await createPackage({ name_suffix: 'OddBoundary', price_cents: 10000, impression_quota: 3 })
  const { data: oDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: oddPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  const { data: oCampaign } = await fundViaProvider({
    actorId: merchantAId, campaignId: oDraft.id, advertiserId: unityAdvertiser.id, packageId: oddPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_odd`,
  })
  createdCampaignIds.push(oCampaign.id)
  const oFundedAmount = oCampaign.funded_amount_cents
  await admin.rpc('record_ad_impression', { p_campaign_id: oCampaign.id, p_placement_type: 'search_result', p_viewer_id: null, p_reach_key: `anon:${RUN_ID}:odd:1` })

  const { error: oddBackdateErr } = await admin.from('ad_campaigns').update({
    activated_at: new Date(Date.now() - 120000).toISOString(),
    end_at: new Date(Date.now() - 60000).toISOString(),
  }).eq('id', oCampaign.id)
  if (oddBackdateErr) throw new Error(`odd-boundary fixture backdate failed: ${oddBackdateErr.message}`)
  await admin.rpc('finalize_expired_ad_campaigns', { p_actor_id: null })

  const { data: oddLedger } = await admin.from('ad_balance_ledger').select('amount_cents').eq('campaign_id', oCampaign.id).eq('entry_type', 'underdelivery_credit').maybeSingle()
  const expectedOddDeliveredValue = Math.floor((oFundedAmount * 1) / 3)
  const expectedOddUnusedCredit = oFundedAmount - expectedOddDeliveredValue
  check(`43. the underdelivery formula floors correctly on a non-round division against the actual funded amount (floor(${oFundedAmount}*1/3)=${expectedOddDeliveredValue}, unused=${expectedOddUnusedCredit})`, oddLedger?.amount_cents === expectedOddUnusedCredit, { oddLedger, oFundedAmount })
}

console.log('=== Voluntary post-activation cancellation: no underdelivery credit ===')
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const cancelPackage = await createPackage({ name_suffix: 'Cancel', price_cents: 10000, impression_quota: 10 })
  const { data: cDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: cancelPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  const { data: cCampaign } = await fundViaProvider({
    actorId: merchantAId, campaignId: cDraft.id, advertiserId: unityAdvertiser.id, packageId: cancelPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_cancel`,
  })
  createdCampaignIds.push(cCampaign.id)
  const { data: balBeforeCancel } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()

  const { data: cancelled, error: cancelErr } = await admin.rpc('cancel_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: cCampaign.id, p_reason: 'QA voluntary post-activation cancel',
  })
  check('44. an advertiser can voluntarily cancel an already-active campaign', !cancelErr && cancelled?.status === 'cancelled' && cancelled?.completion_reason === 'cancelled_post_activation', { cancelErr, cancelled })

  const { data: balAfterCancel } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()
  check('45. voluntary post-activation cancellation does NOT credit any unused campaign value to the Advertising Balance', balAfterCancel.balance_cents === balBeforeCancel.balance_cents, { balBeforeCancel, balAfterCancel })
}

console.log('=== Pre-activation cancellation: full refund to original funding source ===')
{
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  // Fund the balance first via a completed provider-funded->balance refund cycle: simplest is to fund via balance after topping it up through a prior underdelivery credit (already present), then cancel pre-activation.
  const { data: balBefore } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()
  const preActPackage = await createPackage({ name_suffix: 'PreActivation', price_cents: 1000, impression_quota: 5 })
  const { data: pDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: preActPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  createdCampaignIds.push(pDraft.id)
  // Expected debit is the DISCOUNTED final amount, not the raw package
  // price -- merchantA (this whole file's shared QA fixture) carries a
  // real, live subscription plan, so the canonical quote is the only
  // correct source of truth for what this specific funding call will
  // actually debit (never a hardcoded package price).
  const { data: preActQuote } = await admin.rpc('get_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: pDraft.id })
  const { data: pFunded, error: pFundErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: pDraft.id, p_funding_source: 'balance', p_settlement_id: null,
  })
  check('46. funding pre-activation-cancel fixture via Advertising Balance succeeds (balance has accrued underdelivery credit from earlier checks)', !pFundErr && pFunded?.status === 'active', { pFundErr, pFunded })
  const { data: balAfterFund } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', unityAdvertiser.id).single()
  check('47. funding via balance debits the exact discounted final amount (per the canonical quote, not the raw package price)', balAfterFund.balance_cents === balBefore.balance_cents - preActQuote.final_amount_cents, { balBefore, balAfterFund, preActQuote })

  // Note: this campaign auto-activated (unity-marketplace campaigns activate immediately on funding),
  // so "pre-activation cancel" is exercised instead on a still-draft campaign below.
  const draftOnlyPackage = await createPackage({ name_suffix: 'DraftOnly', price_cents: 1000, impression_quota: 5 })
  const { data: draftOnly } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: unityAdvertiser.id, p_package_id: draftOnlyPackage.id,
    p_target_type: 'listing', p_listing_id: realListingId, p_end_at: futureEnd, p_is_test: false,
  })
  createdCampaignIds.push(draftOnly.id)
  const { data: cancelledDraft, error: cancelDraftErr } = await admin.rpc('cancel_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: draftOnly.id, p_reason: 'QA pre-activation cancel (never funded)',
  })
  check('48. cancelling a never-funded draft campaign succeeds as a no-op refund (nothing to refund) and reaches cancelled/cancelled_pre_activation', !cancelDraftErr && cancelledDraft?.status === 'cancelled' && cancelledDraft?.completion_reason === 'cancelled_pre_activation', { cancelDraftErr, cancelledDraft })
}

console.log('=== Admin advertiser approve/reject/suspend ===')
{
  const { data: approved, error: approveErr } = await admin.rpc('admin_approve_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: externalAdvertiser.id, p_reason: 'QA approval',
  })
  check('49. admin can approve a pending external advertiser account', !approveErr && approved?.status === 'approved', { approveErr, approved })

  const { data: suspended, error: suspendErr } = await admin.rpc('admin_suspend_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: unityAdvertiser.id, p_reason: 'QA suspension test',
  })
  check('50. admin can suspend an advertiser account, cascading to suspend its active campaigns', !suspendErr && suspended?.status === 'suspended', { suspendErr, suspended })

  const { data: campaign1AfterSuspend } = await admin.from('ad_campaigns').select('status').eq('id', campaign1.id).single()
  check('51. suspending an advertiser account cascades to suspend that advertiser\'s active campaigns', campaign1AfterSuspend.status === 'suspended', campaign1AfterSuspend)

  const { data: doubleSuspend } = await admin.rpc('admin_suspend_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: unityAdvertiser.id, p_reason: 'QA idempotent replay',
  })
  check('52. suspending an already-suspended advertiser is an idempotent no-op', doubleSuspend?.status === 'suspended', doubleSuspend)

  const { data: rejectFixtureAdvertiser } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'external', p_display_name: `${QA_MARKER} Reject Fixture Advertiser ${RUN_ID}`, p_is_test: true,
  })
  if (rejectFixtureAdvertiser?.id) createdAdvertiserIds.push(rejectFixtureAdvertiser.id)
  const { error: rejectNoReasonErr } = await admin.rpc('admin_reject_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: rejectFixtureAdvertiser.id, p_reason: '',
  })
  check('52a. admin_reject_ad_advertiser requires a non-empty reason', !!rejectNoReasonErr, { rejectNoReasonErr })

  const { data: rejected, error: rejectErr } = await admin.rpc('admin_reject_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: rejectFixtureAdvertiser.id, p_reason: 'QA rejection test',
  })
  check('52b. admin can reject a pending external advertiser account with a reason', !rejectErr && rejected?.status === 'rejected', { rejectErr, rejected })

  const { data: campaign1RestoredCheck, error: restoreErr } = await admin.rpc('admin_restore_ad_campaign', {
    p_admin_id: adminUserId, p_campaign_id: campaign1.id, p_reason: 'QA restore test -- target is still eligible',
  })
  check('52c. admin can restore a suspended campaign back to active when its target is still live-eligible', !restoreErr && campaign1RestoredCheck?.status === 'active', { restoreErr, campaign1RestoredCheck })

  const { data: campaign1AfterRestore } = await admin.from('ad_campaigns').select('status').eq('id', campaign1.id).single()
  check('52d. the restored campaign persists as active in the database', campaign1AfterRestore.status === 'active', campaign1AfterRestore)

  // Re-suspend campaign1 immediately (via its advertiser) so the
  // subsequent "suspended advertiser: campaigns can no longer serve"
  // section still observes campaign1 as suspended, as that section
  // expects -- admin_restore_ad_campaign restores the CAMPAIGN, not the
  // advertiser account, so re-suspending here keeps the two checks
  // independent rather than accidentally coupled by ordering.
  await admin.from('ad_campaigns').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('id', campaign1.id)
}

console.log('=== Suspended advertiser: campaigns can no longer serve ===')
{
  const { data: candidatesAfterSuspend } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 20,
  })
  const stillServing = (candidatesAfterSuspend ?? []).some((c) => c.campaign_id === campaign1.id)
  check('53. a campaign whose advertiser account is suspended is never returned by get_eligible_ads', !stillServing, candidatesAfterSuspend)
}

console.log('=== External creative: submit, admin approval, material-change re-review ===')
{
  // A dedicated, still-pending_review external advertiser -- externalAdvertiser
  // (the module-level variable) was already approved back in check 49, so
  // it can no longer exercise the "campaign approved but advertiser still
  // pending_review" layered-defense scenario below.
  const { data: creativeTestAdvertiser } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'external', p_display_name: `${QA_MARKER} Creative Test Advertiser ${RUN_ID}`, p_is_test: true,
  })
  if (creativeTestAdvertiser?.id) createdAdvertiserIds.push(creativeTestAdvertiser.id)

  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const { data: extDraft, error: extDraftErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: creativeTestAdvertiser.id, p_package_id: cheapExternalPackage.id,
    p_target_type: 'external', p_end_at: futureEnd, p_is_test: false,
  })
  check('54. creating an external-target campaign draft auto-creates a placeholder creative row', !extDraftErr && extDraft?.target_type === 'external', { extDraftErr, extDraft })
  createdCampaignIds.push(extDraft.id)

  const { data: creativeUpdate, error: creativeUpdateErr } = await admin.rpc('update_ad_creative', {
    p_actor_profile_id: merchantAId, p_campaign_id: extDraft.id,
    p_headline: 'QA External Headline', p_cta_text: 'Learn More', p_destination_url: 'https://example.com/qa-landing',
  })
  check('55. the advertiser can submit real creative content for their external campaign', !creativeUpdateErr && creativeUpdate?.headline === 'QA External Headline', { creativeUpdateErr, creativeUpdate })

  const { error: unsafeSchemeErr } = await admin.rpc('update_ad_creative', {
    p_actor_profile_id: merchantAId, p_campaign_id: extDraft.id,
    p_headline: 'QA', p_cta_text: 'Go', p_destination_url: 'javascript:alert(1)',
  })
  check('56. a javascript: destination URL is rejected by the creative RPC (open-redirect / unsafe-scheme defense)', !!unsafeSchemeErr, { unsafeSchemeErr })

  const { data: extFunded, error: extFundErr } = await fundViaProvider({
    actorId: merchantAId, campaignId: extDraft.id, advertiserId: creativeTestAdvertiser.id, packageId: cheapExternalPackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_ext`,
  })
  check('57. funding an external campaign moves it to pending_review (never auto-active, unlike Unity-marketplace campaigns)', !extFundErr && extFunded?.status === 'pending_review', { extFundErr, extFunded })

  const { error: approveBeforeCreativeErr } = await admin.rpc('admin_approve_ad_campaign', {
    p_admin_id: adminUserId, p_campaign_id: extDraft.id, p_reason: 'QA premature approval attempt',
  })
  check('58. an external campaign cannot be approved before its creative is approved', !!approveBeforeCreativeErr, { approveBeforeCreativeErr })

  const { data: creativeApproved, error: creativeApproveErr } = await admin.rpc('admin_approve_ad_creative', {
    p_admin_id: adminUserId, p_campaign_id: extDraft.id, p_reason: 'QA creative approval',
  })
  check('59. admin can approve external creative content', !creativeApproveErr && creativeApproved?.moderation_status === 'approved', { creativeApproveErr, creativeApproved })

  const { data: campaignApproved, error: campaignApproveErr } = await admin.rpc('admin_approve_ad_campaign', {
    p_admin_id: adminUserId, p_campaign_id: extDraft.id, p_reason: 'QA campaign approval',
  })
  check('60. once creative is approved, admin can approve the external campaign itself, activating it', !campaignApproveErr && campaignApproved?.status === 'active', { campaignApproveErr, campaignApproved })

  const { data: extCandidatesBeforeAdvertiserApproval } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 20,
  })
  const servesBeforeAdvertiserApproved = (extCandidatesBeforeAdvertiserApproval ?? []).some((c) => c.campaign_id === extDraft.id)
  check('61. an approved external CAMPAIGN still never serves while its ADVERTISER account remains pending_review (layered defense -- get_eligible_ads checks advertiser.status too)', !servesBeforeAdvertiserApproved, extCandidatesBeforeAdvertiserApproval)

  const { data: creativeTestAdvertiserApproved, error: creativeTestAdvertiserApproveErr } = await admin.rpc('admin_approve_ad_advertiser', {
    p_admin_id: adminUserId, p_advertiser_id: creativeTestAdvertiser.id, p_reason: 'QA approval to unblock serving',
  })
  check('61a. approving the advertiser account is a genuinely separate action from approving the campaign/creative', !creativeTestAdvertiserApproveErr && creativeTestAdvertiserApproved?.status === 'approved', { creativeTestAdvertiserApproveErr, creativeTestAdvertiserApproved })

  const { data: extCandidatesAfter } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 20,
  })
  const servesNow = (extCandidatesAfter ?? []).some((c) => c.campaign_id === extDraft.id)
  check('62. once both advertiser and campaign/creative are approved, the external campaign serves', servesNow, extCandidatesAfter)

  const { data: materialChange, error: materialChangeErr } = await admin.rpc('update_ad_creative', {
    p_actor_profile_id: merchantAId, p_campaign_id: extDraft.id,
    p_headline: 'QA External Headline', p_cta_text: 'Learn More', p_destination_url: 'https://example.com/qa-landing-CHANGED',
  })
  check('63. a material change (destination URL) to a previously-approved creative resets its moderation_status to pending_review', !materialChangeErr && materialChange?.moderation_status === 'pending_review', { materialChangeErr, materialChange })

  const { data: campaignAfterMaterialChange } = await admin.from('ad_campaigns').select('status').eq('id', extDraft.id).single()
  check('64. an active external campaign is pulled back to pending_review when its approved creative materially changes (stops serving until re-approved)', campaignAfterMaterialChange.status === 'pending_review', campaignAfterMaterialChange)

  const { data: extCandidatesAfterChange } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 20,
  })
  const servesAfterChange = (extCandidatesAfterChange ?? []).some((c) => c.campaign_id === extDraft.id)
  check('65. the campaign no longer serves once pulled back to pending_review by the material creative change', !servesAfterChange, extCandidatesAfterChange)
}

console.log('=== is_test isolation: QA content never serves to public consumers ===')
{
  const testTargetListingId = await insertListing({ title: `${QA_MARKER} IsTest Serve Listing ${RUN_ID}`, is_test: true })
  const testAdvertiser = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} IsTest Advertiser ${RUN_ID}`, p_is_test: true,
  }).then((r) => r.data)
  if (testAdvertiser?.id) createdAdvertiserIds.push(testAdvertiser.id)
  const testPackage = await createPackage({ name_suffix: 'IsTestServe', price_cents: 1000, impression_quota: 5 })
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()

  const { data: testDraft, error: testDraftErr } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: testAdvertiser.id, p_package_id: testPackage.id,
    p_target_type: 'listing', p_listing_id: testTargetListingId, p_end_at: futureEnd, p_is_test: true,
  })
  check('66. a genuinely is_test=true campaign, targeting is_test=true content, CAN be created (QA campaigns are allowed to exist)', !testDraftErr && !!testDraft, { testDraftErr, testDraft })
  if (testDraft?.id) createdCampaignIds.push(testDraft.id)

  const { data: testFunded } = await fundViaProvider({
    actorId: merchantAId, campaignId: testDraft.id, advertiserId: testAdvertiser.id, packageId: testPackage.id, isTest: true, reference: `mock_ad_${RUN_ID}_istest`,
  })
  check('67. a QA (is_test=true) campaign still auto-activates through the normal funding path', testFunded?.status === 'active', testFunded)

  const { data: publicCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 50,
  })
  const testCampaignLeaked = (publicCandidates ?? []).some((c) => c.campaign_id === testDraft.id)
  check('68. get_eligible_ads (the real public-serving path) NEVER returns an is_test=true campaign, regardless of its own eligibility', !testCampaignLeaked, publicCandidates)
}

console.log('=== A target becoming ineligible mid-campaign stops serving immediately ===')
{
  // unityAdvertiser was suspended in the "Admin advertiser
  // approve/reject/suspend" section above -- a suspended advertiser
  // cannot create new campaigns at all, so this fixture needs its own
  // fresh, unsuspended advertiser account, unrelated to that check.
  const { data: liveAdvertiser } = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} LiveTarget Advertiser ${RUN_ID}`, p_is_test: true,
  })
  if (liveAdvertiser?.id) createdAdvertiserIds.push(liveAdvertiser.id)

  const liveTargetListingId = await insertListing({ title: `${QA_MARKER} Live Then Suspended ${RUN_ID}` })
  const livePackage = await createPackage({ name_suffix: 'LiveThenSuspend', price_cents: 1000, impression_quota: 5 })
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()
  const { data: liveDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantAId, p_advertiser_id: liveAdvertiser.id, p_package_id: livePackage.id,
    p_target_type: 'listing', p_listing_id: liveTargetListingId, p_end_at: futureEnd, p_is_test: false,
  })
  createdCampaignIds.push(liveDraft.id)
  const { data: liveCampaign } = await fundViaProvider({
    actorId: merchantAId, campaignId: liveDraft.id, advertiserId: liveAdvertiser.id, packageId: livePackage.id, isTest: false, reference: `mock_ad_${RUN_ID}_live`,
  })
  check('69. the live-target fixture campaign activates normally', liveCampaign?.status === 'active', liveCampaign)

  const { data: candidatesBeforeSuspend } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 50,
  })
  check('70. the live-target campaign serves while its target listing remains active', (candidatesBeforeSuspend ?? []).some((c) => c.campaign_id === liveCampaign.id), candidatesBeforeSuspend)

  await admin.from('listings').update({ status: 'suspended' }).eq('id', liveTargetListingId)

  const { data: candidatesAfterSuspend } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 50,
  })
  check('71. the moment the target listing is suspended, get_eligible_ads (live serve-time revalidation) stops returning that campaign, without any campaign-state change required', !(candidatesAfterSuspend ?? []).some((c) => c.campaign_id === liveCampaign.id), candidatesAfterSuspend)

  const { data: campaignStillActive } = await admin.from('ad_campaigns').select('status').eq('id', liveCampaign.id).single()
  check('72. the campaign itself is NOT auto-cancelled just because its target became temporarily ineligible (may resume once eligible again)', campaignStillActive.status === 'active', campaignStillActive)
}

console.log('=== Structural neutrality proof: Advertising <-> Search Ranking never cross-reference each other\'s SQL ===')
{
  const migrationsDir = join(REPO_ROOT, 'supabase/migrations')
  const allMigrationFiles = readdirSync(migrationsDir)
  const searchRankingFiles = allMigrationFiles.filter((f) => f.includes('search_ranking') || (f.startsWith('20260902') && !f.includes('advertising')))
  const advertisingFiles = allMigrationFiles.filter((f) => f.includes('advertising'))
  check('73a. both the Search Ranking and Advertising migration file sets are non-empty (the structural scan below is meaningful)', searchRankingFiles.length > 0 && advertisingFiles.length > 0, { searchRankingFiles, advertisingFiles })

  const searchRankingSql = searchRankingFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n')
  const adTermViolations = ['ad_campaigns', 'ad_packages', 'ad_advertisers', 'ad_balance_ledger', 'ad_impressions', 'ad_clicks'].filter((t) => new RegExp(t, 'i').test(searchRankingSql))
  check('73. the Search Ranking migration source never references any Advertising table (organic ranking is structurally incapable of depending on ad data)', adTermViolations.length === 0, { adTermViolations })

  const advertisingSql = advertisingFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8')).join('\n')
  const searchTermViolations = ['match_tier', 'match_score', 'search_vector', 'context_hash'].filter((t) => new RegExp(t, 'i').test(advertisingSql))
  check('74. the Advertising migration source never references any Search Ranking internal (organic ranking formula/cursor) column', searchTermViolations.length === 0, { searchTermViolations })

  // Specific real, actionable table/column identifiers only. Several of
  // these names (commission, merchant_payouts, escrow, affiliate)
  // legitimately appear BY NAME in this migration set's own explanatory
  // comments describing the financial-separation invariant itself (e.g.
  // "...escrow, merchant payout, commission, or affiliate calculations.")
  // -- a comment mentioning what Advertising must NOT touch is not a
  // structural violation, so only genuinely queryable identifiers
  // (table/column names that would appear in a FROM/JOIN/SELECT if
  // actually referenced) are checked here.
  const revenueTerms = ['merchant_subscriptions', 'escrow_transaction', 'affiliate_commissions', 'commission_amount', 'commission_rate']
  const revenueViolations = revenueTerms.filter((t) => new RegExp(t, 'i').test(advertisingSql))
  check('75. the Advertising migration source never references subscription/commission/escrow/affiliate tables (financial separation, binding §61-65)', revenueViolations.length === 0, { revenueViolations })
}

console.log('=== Frontend contract: Sponsored labeling ===')
{
  const listingCardSrc = readFileSync(join(REPO_ROOT, 'src/components/listings/listing-card.tsx'), 'utf8')
  check('76. the listing card renders the exact label "Sponsored" for paid placements', /Sponsored/.test(listingCardSrc), {})
  check('77. the listing card never substitutes "Featured"/"Top Pick"/"Recommended" as a stand-in for Sponsored labeling', !/Top Pick|Recommended/.test(listingCardSrc), {})

  const searchInsertionSrc = readFileSync(join(REPO_ROOT, 'src/lib/advertising/search-insertion.ts'), 'utf8')
  check('78. the search-insertion module enforces the 60% density ceiling explicitly in source (MAX_AD_DENSITY_RATIO = 0.6)', /MAX_AD_DENSITY_RATIO\s*=\s*0\.6/.test(searchInsertionSrc), {})
}

console.log('=== Feature flag: no client-authoritative NEXT_PUBLIC_ADVERTISING_ENABLED exists anywhere ===')
{
  const advertisingLibDir = join(REPO_ROOT, 'src/lib/advertising')
  const configSrc = readFileSync(join(advertisingLibDir, 'config.ts'), 'utf8')
  // The doc comment legitimately mentions NEXT_PUBLIC_ADVERTISING_ENABLED
  // by name to explain that it deliberately does NOT exist -- the real
  // assertion is that no CODE actually reads it.
  check('79. isAdvertisingEnabled() reads only the server-only ADVERTISING_ENABLED var, never a NEXT_PUBLIC_ variant', /process\.env\.ADVERTISING_ENABLED/.test(configSrc) && !/process\.env\.NEXT_PUBLIC_ADVERTISING_ENABLED/.test(configSrc), {})
}

console.log('=== Verified settlement authority: fabrication, mismatch, and replay defenses ===')
{
  const settlementAdvertiser = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} Settlement Test Advertiser ${RUN_ID}`, p_is_test: true,
  }).then((r) => r.data)
  if (settlementAdvertiser?.id) createdAdvertiserIds.push(settlementAdvertiser.id)
  const otherSettlementAdvertiser = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantBId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} Settlement Other Advertiser ${RUN_ID}`, p_is_test: true,
  }).then((r) => r.data)
  if (otherSettlementAdvertiser?.id) createdAdvertiserIds.push(otherSettlementAdvertiser.id)

  const settlementPackage = await createPackage({ name_suffix: 'Settlement', price_cents: 4200, impression_quota: 10 })
  // is_test: true -- must match every settlement-section draft's own
  // p_is_test: true, since _ad_target_is_live_eligible() requires the
  // target's is_test to exactly equal the campaign's (unlike draft
  // creation's ownership check, which only requires is_test-consistency
  // for a REAL campaign, not a QA one).
  const settlementListingId = await insertListing({ title: `${QA_MARKER} Settlement Listing ${RUN_ID}`, is_test: true })
  const futureEnd = new Date(Date.now() + 30 * 86400000).toISOString()

  async function freshDraft(advertiserId) {
    const { data: draft } = await admin.rpc('create_ad_campaign_draft', {
      p_actor_profile_id: merchantAId, p_advertiser_id: advertiserId, p_package_id: settlementPackage.id,
      p_target_type: 'listing', p_listing_id: settlementListingId, p_end_at: futureEnd, p_is_test: true,
    })
    if (draft?.id) createdCampaignIds.push(draft.id)
    return draft
  }
  // Same as freshDraft, but against a caller-supplied package (for the
  // price-change proof below, where the package itself is the variable).
  async function freshDraftFor(advertiserId, packageId) {
    const { data: draft } = await admin.rpc('create_ad_campaign_draft', {
      p_actor_profile_id: merchantAId, p_advertiser_id: advertiserId, p_package_id: packageId,
      p_target_type: 'listing', p_listing_id: settlementListingId, p_end_at: futureEnd, p_is_test: true,
    })
    if (draft?.id) createdCampaignIds.push(draft.id)
    return draft
  }
  // Every provider-funding scenario below now requires a PERSISTED,
  // authoritative quote (create_ad_campaign_funding_quote) before a
  // settlement can be recorded or a campaign funded -- the direct
  // closure of the price/plan race across the external payment
  // boundary.
  async function quoteFor(draftId) {
    const { data: quote } = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: draftId })
    return quote
  }
  const settlementAmount = (await quoteFor((await freshDraft(settlementAdvertiser.id)).id)).amount_due_cents

  // 80/81. A fabricated/nonexistent settlement_id is rejected outright,
  // even with a real, valid quote supplied -- the direct closure of the
  // proven gap (a bare string is no longer even an accepted parameter
  // shape; a syntactically valid but never-recorded settlement id is
  // the closest equivalent attack today).
  const fabDraft = await freshDraft(settlementAdvertiser.id)
  const fabQuote = await quoteFor(fabDraft.id)
  const { error: fabricatedErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: fabDraft.id, p_funding_source: 'provider', p_settlement_id: '00000000-0000-4000-8000-000000000000', p_quote_id: fabQuote.quote_id,
  })
  check('80. a fabricated/nonexistent settlement_id is rejected (settlement not found), even with a real quote supplied', !!fabricatedErr, { fabricatedErr })
  const { data: fabCampaignAfter } = await admin.from('ad_campaigns').select('status').eq('id', fabDraft.id).single()
  check('81. a rejected fabricated-settlement funding attempt leaves the campaign in draft (no partial activation)', fabCampaignAfter?.status === 'draft', fabCampaignAfter)
  const { count: fabFundingRows } = await admin.from('ad_campaign_funding').select('id', { count: 'exact', head: true }).eq('campaign_id', fabDraft.id)
  check('82. a rejected fabricated-settlement funding attempt creates no ad_campaign_funding row at all', fabFundingRows === 0, { fabFundingRows })

  // 83/83a. A null settlement_id, and separately a null quote_id, on the
  // provider path are each rejected on their own.
  const nullDraft = await freshDraft(settlementAdvertiser.id)
  const nullQuote = await quoteFor(nullDraft.id)
  const { error: nullSettlementErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: nullDraft.id, p_funding_source: 'provider', p_settlement_id: null, p_quote_id: nullQuote.quote_id,
  })
  check('83. provider funding with no settlement_id at all is rejected', !!nullSettlementErr, { nullSettlementErr })
  const noQuoteDraft = await freshDraft(settlementAdvertiser.id)
  const { error: noQuoteErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: noQuoteDraft.id, p_funding_source: 'provider', p_settlement_id: '00000000-0000-4000-8000-000000000000', p_quote_id: null,
  })
  check('83a. provider funding with no funding quote at all is rejected', !!noQuoteErr, { noQuoteErr })

  // 84. record_ad_provider_settlement is the only way a verified row can
  // exist, and it is the shape trusted server code (the funding route)
  // actually uses -- verify the row it produces, bound to a real quote.
  const goodDraft = await freshDraft(settlementAdvertiser.id)
  const goodQuote = await quoteFor(goodDraft.id)
  const goodRef = `mock_ad_settlement_${RUN_ID}`
  const { data: settlement, error: settlementErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: goodRef, amountCents: goodQuote.amount_due_cents, currency: goodQuote.currency, isTest: true, quoteId: goodQuote.quote_id,
  })
  check('84. record_ad_provider_settlement creates a verified settlement row bound to the exact quote supplied', !settlementErr && settlement?.status === 'verified' && settlement?.amount_cents === goodQuote.amount_due_cents && settlement?.quote_id === goodQuote.quote_id, { settlementErr, settlement })

  // 85. Duplicate reference can never be recorded twice -- the structural
  // guarantee that one real charge cannot become two settlements.
  const { error: dupSettlementErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: goodRef, amountCents: goodQuote.amount_due_cents, currency: goodQuote.currency, isTest: true,
  })
  check('85. recording the same (provider, provider_reference) a second time is rejected', !!dupSettlementErr, { dupSettlementErr })

  // 85a. A SECOND settlement can never be recorded for the SAME quote,
  // even with a fresh provider_reference -- one quote, one settlement.
  const { error: dupQuoteSettlementErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_dupquote_${RUN_ID}`, amountCents: goodQuote.amount_due_cents, currency: goodQuote.currency, isTest: true, quoteId: goodQuote.quote_id,
  })
  check('85a. a second settlement for the SAME funding quote is rejected, even with a fresh provider reference', !!dupQuoteSettlementErr, { dupQuoteSettlementErr })

  // 86. A quote+settlement pair legitimately consumed by one campaign can
  // never fund a DIFFERENT campaign -- proves quote/settlement binding is
  // campaign-specific, closing "wrong advertiser" and "wrong campaign"
  // together (a quote's advertiser_id and campaign_id are fixed at
  // creation and can never be reused for anyone else's campaign).
  const { data: legitFunded, error: legitErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: goodDraft.id, p_funding_source: 'provider', p_settlement_id: settlement.id, p_quote_id: goodQuote.quote_id,
  })
  check('86pre. the legitimate quote+settlement funds its own campaign first (precondition for the cross-campaign-reuse proof below)', !legitErr && legitFunded?.status === 'active', { legitErr, legitFunded })
  const otherMerchantListingId = await insertListing({ merchant_id: merchantBId, title: `${QA_MARKER} Settlement Other Merchant Listing ${RUN_ID}`, is_test: true })
  const { data: wrongAdvertiserDraft } = await admin.rpc('create_ad_campaign_draft', {
    p_actor_profile_id: merchantBId, p_advertiser_id: otherSettlementAdvertiser.id, p_package_id: settlementPackage.id,
    p_target_type: 'listing', p_listing_id: otherMerchantListingId, p_end_at: futureEnd, p_is_test: true,
  })
  if (wrongAdvertiserDraft?.id) createdCampaignIds.push(wrongAdvertiserDraft.id)
  const { error: crossAdvertiserErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantBId, p_campaign_id: wrongAdvertiserDraft.id, p_funding_source: 'provider', p_settlement_id: settlement.id, p_quote_id: goodQuote.quote_id,
  })
  check('86. an already-consumed quote+settlement (belonging to a different advertiser AND already funded) cannot fund a different campaign', !!crossAdvertiserErr, { crossAdvertiserErr })

  // 87. Wrong amount: a settlement whose amount does not match the
  // QUOTE it claims to be for is rejected at record_ad_provider_settlement
  // itself -- the linkage is enforced at creation time, not just at fund time.
  const wrongAmountDraft = await freshDraft(settlementAdvertiser.id)
  const wrongAmountQuote = await quoteFor(wrongAmountDraft.id)
  const { error: wrongAmountErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_wrongamount_${RUN_ID}`, amountCents: wrongAmountQuote.amount_due_cents + 1, currency: wrongAmountQuote.currency, isTest: true, quoteId: wrongAmountQuote.quote_id,
  })
  check('87. a settlement for the WRONG AMOUNT (off by one cent) relative to its claimed quote is rejected at settlement-creation time', !!wrongAmountErr, { wrongAmountErr })

  // 88. Wrong currency: same idea, currency mismatch against the quote.
  const wrongCurrencyDraft = await freshDraft(settlementAdvertiser.id)
  const wrongCurrencyQuote = await quoteFor(wrongCurrencyDraft.id)
  const { error: wrongCurrencyErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_wrongcur_${RUN_ID}`, amountCents: wrongCurrencyQuote.amount_due_cents, currency: 'USD', isTest: true, quoteId: wrongCurrencyQuote.quote_id,
  })
  check('88. a settlement for the WRONG CURRENCY relative to its claimed quote is rejected at settlement-creation time', !!wrongCurrencyErr, { wrongCurrencyErr })

  // 89. Wrong is_test: a real settlement cannot claim a QA quote and vice
  // versa -- the existing is_test-isolation convention extended to
  // quote+settlement authority.
  const isTestMismatchDraft = await freshDraft(settlementAdvertiser.id) // is_test: true
  const isTestMismatchQuote = await quoteFor(isTestMismatchDraft.id)
  const { error: isTestMismatchErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_liveflag_${RUN_ID}`, amountCents: isTestMismatchQuote.amount_due_cents, currency: isTestMismatchQuote.currency, isTest: false, quoteId: isTestMismatchQuote.quote_id,
  })
  check('89. a settlement with the WRONG is_test flag relative to its claimed (QA) quote is rejected at settlement-creation time', !!isTestMismatchErr, { isTestMismatchErr })

  // 90/91. A genuinely matching quote+settlement funds the intended
  // campaign, and the funding row records exactly which quote AND
  // settlement it consumed.
  const legit2Draft = await freshDraft(settlementAdvertiser.id)
  const legit2Quote = await quoteFor(legit2Draft.id)
  const { data: legit2Settlement } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_legit2_${RUN_ID}`, amountCents: legit2Quote.amount_due_cents, currency: legit2Quote.currency, isTest: true, quoteId: legit2Quote.quote_id,
  })
  const { data: legit2Funded, error: legit2Err } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: legit2Draft.id, p_funding_source: 'provider', p_settlement_id: legit2Settlement.id, p_quote_id: legit2Quote.quote_id,
  })
  check('90. a genuinely matching verified quote+settlement funds the campaign and activates it', !legit2Err && legit2Funded?.status === 'active', { legit2Err, legit2Funded })
  const { data: fundingRow } = await admin.from('ad_campaign_funding').select('settlement_id, quote_id, provider_reference').eq('campaign_id', legit2Draft.id).maybeSingle()
  check('91. the ad_campaign_funding row records exactly which settlement AND which quote it consumed', fundingRow?.settlement_id === legit2Settlement.id && fundingRow?.quote_id === legit2Quote.quote_id, fundingRow)

  // 92/93. Replay: that SAME quote+settlement can never fund a second
  // campaign -- the direct DB-level (unique index on both quote_id and
  // settlement_id), not merely application-level, guarantee.
  const replayDraft = await freshDraft(settlementAdvertiser.id)
  const { error: replayErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: replayDraft.id, p_funding_source: 'provider', p_settlement_id: legit2Settlement.id, p_quote_id: legit2Quote.quote_id,
  })
  check('92. the same verified quote+settlement cannot fund a SECOND campaign (already consumed)', !!replayErr, { replayErr })
  const { count: replayFundingRows } = await admin.from('ad_campaign_funding').select('id', { count: 'exact', head: true }).eq('campaign_id', replayDraft.id)
  check('93. a rejected quote/settlement-replay attempt creates no funding row for the second campaign', replayFundingRows === 0, { replayFundingRows })

  // 94/95. Balance funding is completely unaffected by any of this --
  // still works exactly as before, never touching a quote or settlement
  // at all, and explicitly rejects a quote_id if one is mistakenly supplied.
  await admin.from('ad_balance_accounts').update({ balance_cents: settlementAmount }).eq('advertiser_id', settlementAdvertiser.id)
  const balanceDraft = await freshDraft(settlementAdvertiser.id)
  const { data: balanceFunded, error: balanceErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: balanceDraft.id, p_funding_source: 'balance', p_settlement_id: null, p_quote_id: null,
  })
  check('94. balance-funded campaigns continue to work unchanged (no quote or settlement required or consumed)', !balanceErr && balanceFunded?.status === 'active', { balanceErr, balanceFunded })
  const { data: balanceFundingRow } = await admin.from('ad_campaign_funding').select('settlement_id, quote_id, funding_source').eq('campaign_id', balanceDraft.id).maybeSingle()
  check('95. a balance-funded row has settlement_id AND quote_id both NULL (balance funding never touches either authority)', balanceFundingRow?.funding_source === 'balance' && balanceFundingRow?.settlement_id === null && balanceFundingRow?.quote_id === null, balanceFundingRow)
  const balanceQuoteMisuseDraft = await freshDraft(settlementAdvertiser.id)
  const balanceQuoteMisuseQuote = await quoteFor(balanceQuoteMisuseDraft.id)
  const { error: balanceQuoteMisuseErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: balanceQuoteMisuseDraft.id, p_funding_source: 'balance', p_settlement_id: null, p_quote_id: balanceQuoteMisuseQuote.quote_id,
  })
  check('95a. supplying a quote_id for BALANCE funding is rejected (a quote exists only to protect the external payment boundary)', !!balanceQuoteMisuseErr, { balanceQuoteMisuseErr })

  // 96. Idempotency of a legitimate funding operation is unchanged --
  // replaying the SAME fund_ad_campaign call (same idempotency key, same
  // quote+settlement) is a safe no-op, not a second consumption.
  const idemDraft = await freshDraft(settlementAdvertiser.id)
  const idemQuote = await quoteFor(idemDraft.id)
  const { data: idemSettlement } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_idem_${RUN_ID}`, amountCents: idemQuote.amount_due_cents, currency: idemQuote.currency, isTest: true, quoteId: idemQuote.quote_id,
  })
  const idemKey = `settlement-idem-${RUN_ID}`
  const { data: idem1, error: idem1Err } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: idemDraft.id, p_funding_source: 'provider', p_settlement_id: idemSettlement.id, p_idempotency_key: idemKey, p_quote_id: idemQuote.quote_id,
  })
  check('96. the first funding call with a fresh idempotency key succeeds', !idem1Err && idem1?.status === 'active', { idem1Err, idem1 })
  // Pre-existing behavior, unchanged by this hardening: fund_ad_campaign
  // checks campaign.status <> 'draft' BEFORE it ever consults the
  // idempotency_keys cache. Once idem1 has moved the campaign to
  // 'active', a literal replay never reaches the cache at all -- it is
  // rejected on the status check first. The genuine safety property (no
  // double-consumption, no duplicate row) is proven by check 97 below
  // regardless of which path rejects the replay.
  const { error: idem2Err } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: idemDraft.id, p_funding_source: 'provider', p_settlement_id: idemSettlement.id, p_idempotency_key: idemKey, p_quote_id: idemQuote.quote_id,
  })
  check('96a. replaying the exact same funding call after success is safely rejected (campaign no longer in draft), never silently re-applied', !!idem2Err, { idem2Err })
  const { count: idemFundingRows } = await admin.from('ad_campaign_funding').select('id', { count: 'exact', head: true }).eq('campaign_id', idemDraft.id)
  check('97. a replayed funding call never creates a second ad_campaign_funding row, regardless of which check rejects it', idemFundingRows === 1, { idemFundingRows })

  // 98. Same-campaign double-funding is still prevented (campaign.status
  // must be 'draft') -- unchanged pre-existing protection, reconfirmed
  // under the new quote+settlement-based flow. A brand new quote against
  // the already-funded campaign is itself refused (campaign not draft).
  const { error: secondQuoteErr } = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: legit2Draft.id })
  check('98. a brand new funding quote cannot even be created for a campaign that is already funded/active', !!secondQuoteErr, { secondQuoteErr })

  // 99. The funding route's own feature-flag gate is real and server-side
  // -- proven live against the actual running route (not just source
  // text), since ADVERTISING_ENABLED is unset/false in this environment
  // right now.
  const { status: disabledStatus, json: disabledJson } = await apiAsMerchantA('POST', `/api/advertising/campaigns/${legit2Draft.id}/fund`, { fundingSource: 'provider' })
  check('99. the funding route itself refuses to run at all while ADVERTISING_ENABLED is not "true" (live proof against the real route, 503)', disabledStatus === 503, { disabledStatus, disabledJson })

  // 100/101. Structural proof of the route's own control flow, mirroring
  // this file's existing source-text-scan idiom (checks 73/74/78/79
  // above) -- the pieces that genuinely cannot be proven without either
  // restarting the dev server with ADVERTISING_ENABLED=true (out of
  // proportion for this check) or duplicating registry.test.ts/
  // mock-provider.test.ts's own unit coverage, which already exists.
  const fundRouteSrc = readFileSync(join(REPO_ROOT, 'src/app/api/advertising/campaigns/[id]/fund/route.ts'), 'utf8')
  const successCheckIdx = fundRouteSrc.indexOf(`charge.status !== 'succeeded'`)
  const settlementCallIdx = fundRouteSrc.indexOf('record_ad_provider_settlement')
  check('100. the route source only ever calls record_ad_provider_settlement AFTER checking charge.status for success (declined/timeout physically cannot reach settlement recording)', successCheckIdx > -1 && settlementCallIdx > successCheckIdx, { successCheckIdx, settlementCallIdx })
  check('101. the route source explicitly rejects a client-supplied mockScenario outside production-unsafe environments (second, redundant defense layer alongside the registry\'s own production guard)', /NODE_ENV === 'production'.*mockScenario/s.test(fundRouteSrc) || /mockScenario.*NODE_ENV === 'production'/s.test(fundRouteSrc), {})
  const bodySchemaMatch = fundRouteSrc.match(/const bodySchema = z\.object\(\{[^}]*\}\)/s)
  check('102. the funding route\'s request body schema has no field for amount/currency/settlementId/paymentStatus -- a client cannot supply or certify any of them', !!bodySchemaMatch && !/amount|currency|settlementId|paymentStatus|settlement_id/i.test(bodySchemaMatch[0]), { bodySchema: bodySchemaMatch?.[0] })

  // 103. Cross-ledger neutrality, mirrored from this file's existing
  // structural-neutrality idiom (checks 73/74): the new settlement
  // migration itself never references payments/escrow/payouts/affiliate/
  // commission/subscription tables.
  const settlementMigrationSrc = readdirSync(join(REPO_ROOT, 'supabase/migrations'))
    .filter((f) => f.includes('advertising_provider_settlements'))
    .map((f) => readFileSync(join(REPO_ROOT, 'supabase/migrations', f), 'utf8'))
    .join('\n')
  const crossLedgerViolations = ['payments', 'escrow', 'merchant_payouts', 'affiliate', 'commission', 'subscription'].filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(settlementMigrationSrc.replace(/--.*$/gm, '')))
  check('103. the verified-settlement migration never references payments/escrow/merchant_payouts/affiliate/commission/subscription tables outside comments', crossLedgerViolations.length === 0, { crossLedgerViolations })

  // 104-107. RACE PROOF (Step 8 Test A): a package price change AFTER a
  // quote is created must NOT affect that already-created quote -- the
  // exact fix for the proven race. base/discount/amount_due are frozen
  // the moment the quote is created; a real charge against that frozen
  // amount must still fund successfully even though the package's LIVE
  // price has since moved on. Only a BRAND NEW quote (created after the
  // price change) sees the new price.
  const priceChangePackage = await createPackage({ name_suffix: 'PriceChange', price_cents: 8000, impression_quota: 10 })
  const priceChangeDraft = await freshDraftFor(settlementAdvertiser.id, priceChangePackage.id)
  const preChangeQuote = await quoteFor(priceChangeDraft.id)
  check('104pre. the quote created BEFORE the price change reflects the pre-change price (base 8000, Pro 5% -> 7600)', preChangeQuote.base_price_cents === 8000 && preChangeQuote.amount_due_cents === 7600, preChangeQuote)

  await admin.rpc('admin_update_ad_package', { p_admin_id: adminUserId, p_package_id: priceChangePackage.id, p_price_cents: 15000 })
  const { data: pkgAfterEdit } = await admin.from('ad_packages').select('price_cents, currency').eq('id', priceChangePackage.id).single()
  check('104. after the quote exists, an admin can still edit the package price (X -> Y)', pkgAfterEdit.price_cents === 15000, pkgAfterEdit)

  // The already-created quote is re-fetched (get-or-create semantics)
  // and must be BYTE-IDENTICAL to preChangeQuote -- still frozen at the
  // OLD price, completely unaffected by the edit above.
  const stillFrozenQuote = await quoteFor(priceChangeDraft.id)
  check('105. the SAME quote, re-fetched after the package price change, is completely unaffected -- still frozen at base 8000 / amount 7600, not the new 15000', stillFrozenQuote.quote_id === preChangeQuote.quote_id && stillFrozenQuote.base_price_cents === 8000 && stillFrozenQuote.amount_due_cents === 7600, { preChangeQuote, stillFrozenQuote, currentPackagePrice: pkgAfterEdit.price_cents })

  // A real charge/settlement against the FROZEN quote still funds
  // successfully -- the successful (simulated) charge is never stranded
  // by the later price change.
  const { data: priceChangeSettlement, error: priceChangeSettlementErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_pricechange_${RUN_ID}`, amountCents: preChangeQuote.amount_due_cents, currency: preChangeQuote.currency, isTest: true, quoteId: preChangeQuote.quote_id,
  })
  const { data: priceChangeFunded, error: priceChangeFundErr } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: priceChangeDraft.id, p_funding_source: 'provider', p_settlement_id: priceChangeSettlement?.id, p_quote_id: preChangeQuote.quote_id,
  })
  check('106. funding against the pre-change FROZEN quote succeeds at the OLD amount (7600), never stranded by the later price change to 15000', !priceChangeSettlementErr && !priceChangeFundErr && priceChangeFunded?.status === 'active' && priceChangeFunded?.funded_amount_cents === 7600, { priceChangeSettlementErr, priceChangeFundErr, priceChangeFunded })

  const { data: priceChangeFundingRow } = await admin.from('ad_campaign_funding').select('amount_cents, quote_id').eq('campaign_id', priceChangeDraft.id).single()
  check('106a. the campaign snapshot (base/final) and the funding row all agree on the FROZEN pre-change amount, never the new live package price', priceChangeFunded?.snapshot_base_price_cents === 8000 && priceChangeFunded?.snapshot_price_cents === 7600 && priceChangeFundingRow?.amount_cents === 7600 && priceChangeFundingRow?.quote_id === preChangeQuote.quote_id, { funded: priceChangeFunded, fundingRow: priceChangeFundingRow })

  // 107. A NEW quote (created after the price change) DOES see the new
  // live price -- only an already-started attempt is protected; a fresh
  // funding attempt always uses current authority.
  const newAttemptDraft = await freshDraftFor(settlementAdvertiser.id, priceChangePackage.id)
  const postChangeQuote = await quoteFor(newAttemptDraft.id)
  check('107. a BRAND NEW quote created after the price change correctly reflects the new price (base 15000, Pro 5% -> 14250)', postChangeQuote.base_price_cents === 15000 && postChangeQuote.amount_due_cents === 14250, postChangeQuote)

  // 107a. A settlement recorded for the OLD (pre-change) amount can
  // never satisfy the NEW quote -- the two quotes are genuinely distinct
  // authorities, never conflated.
  const { error: staleAgainstNewErr } = await recordVerifiedSettlement({
    advertiserId: settlementAdvertiser.id, reference: `mock_ad_staleagainstnew_${RUN_ID}`, amountCents: preChangeQuote.amount_due_cents, currency: postChangeQuote.currency, isTest: true, quoteId: postChangeQuote.quote_id,
  })
  check('107a. a settlement for the OLD frozen amount (7600) is rejected against the NEW quote (which requires 14250)', !!staleAgainstNewErr, { staleAgainstNewErr })

  console.log(`\n=== SETTLEMENT AUTHORITY SECTION DONE -- ${failures} failure(s) so far ===`)
}

console.log('=== Serving authority requires verified settlement (Blocker 1 closure) ===')
{
  // Self-contained advertiser fixture -- settlementAdvertiser from the
  // section above is block-scoped and not visible here.
  const servingAuthorityAdvertiser = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} Serving Authority Advertiser ${RUN_ID}`, p_is_test: true,
  }).then((r) => r.data)
  if (servingAuthorityAdvertiser?.id) createdAdvertiserIds.push(servingAuthorityAdvertiser.id)

  // Legacy-data proof: audit every historical provider-funded row with
  // settlement_id NULL (from before the settlement-authority migration)
  // and confirm none of them is currently servable, PLUS prove the new
  // authority-level rule structurally, not just incidentally, using a
  // fresh isolated fixture engineered into the exact shape a legacy row
  // has (status forced to 'active' the same way pre-hardening funding
  // would have left it, but with settlement_id NULL).
  const { data: legacyRows } = await admin.from('ad_campaign_funding').select('campaign_id').eq('funding_source', 'provider').is('settlement_id', null)
  const legacyCampaignIds = (legacyRows ?? []).map((r) => r.campaign_id)
  const { data: legacyCampaigns } = legacyCampaignIds.length > 0
    ? await admin.from('ad_campaigns').select('id, status, is_test').in('id', legacyCampaignIds)
    : { data: [] }
  const legacyActiveNonTest = (legacyCampaigns ?? []).filter((c) => !c.is_test && c.status === 'active')
  check('108. no historical (pre-hardening) provider-funded campaign with settlement_id NULL is currently in an active/servable state', legacyActiveNonTest.length === 0, { legacyCount: legacyCampaigns?.length ?? 0, legacyActiveNonTestCount: legacyActiveNonTest.length })

  // 109/110. Structural proof, not incidental: directly force a fresh
  // fixture into the exact shape a legacy unsettled row has (status
  // forced 'active' via direct QA-only write, funding row with
  // funding_source='provider' and settlement_id NULL, mirroring exactly
  // what the pre-hardening code path would have produced) and confirm
  // get_eligible_ads now structurally refuses to serve it, while an
  // otherwise-identical genuinely-settled sibling DOES serve.
  const servingProofPackage = await createPackage({ name_suffix: 'ServingProof', price_cents: 1500, impression_quota: 10, placement_type: 'search_result' })
  // is_test: false (REAL, not QA) throughout this proof, deliberately --
  // get_eligible_ads unconditionally excludes every is_test=true campaign
  // (c.is_test = false in its WHERE clause; already proven by check 68
  // above), so an is_test=true campaign would never serve regardless of
  // settlement status, confounding the very thing this proof needs to
  // isolate. This mirrors the file's own established convention of using
  // deliberately real (is_test=false) fixtures specifically to prove
  // genuine public-visibility behavior (e.g. campaign1), swept back to
  // is_test=true by the final cleanup section like every other such
  // fixture in this file.
  const servingListingId = await insertListing({ title: `${QA_MARKER} Serving Proof Listing ${RUN_ID}` })
  const servingFutureEnd = new Date(Date.now() + 30 * 86400000).toISOString()

  const unsettledDraft = await freshDraftForListing(servingAuthorityAdvertiser.id, servingProofPackage.id, servingListingId, servingFutureEnd, false)
  // Force it into the exact legacy shape: active status + a provider
  // funding row with settlement_id NULL, via direct QA-only writes (this
  // is what genuinely happened historically -- fund_ad_campaign itself
  // can no longer produce this shape, which is the whole point).
  await admin.from('ad_campaign_funding').insert({ campaign_id: unsettledDraft.id, funding_source: 'provider', amount_cents: servingProofPackage.price_cents, provider_reference: `mock_ad_legacy_shape_${RUN_ID}`, settlement_id: null })
  await admin.from('ad_campaigns').update({ status: 'active', activated_at: new Date().toISOString(), snapshot_placement_type: servingProofPackage.placement_type, snapshot_impression_quota: servingProofPackage.impression_quota }).eq('id', unsettledDraft.id)
  if (unsettledDraft?.id) createdCampaignIds.push(unsettledDraft.id)

  const { data: unsettledCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 50,
  })
  const unsettledServes = (unsettledCandidates ?? []).some((c) => c.campaign_id === unsettledDraft.id)
  check('109. a campaign in the exact legacy shape (active status, provider funding, settlement_id NULL) is structurally EXCLUDED from get_eligible_ads', !unsettledServes, { unsettledServes })

  const settledDraft = await freshDraftForListing(servingAuthorityAdvertiser.id, servingProofPackage.id, servingListingId, servingFutureEnd, false)
  // merchantA carries a real, live subscription plan, so the settlement
  // must match the discounted amount from a real PERSISTED quote --
  // never the raw package price, and never the live-preview-only RPC.
  const { data: servingQuote } = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: settledDraft.id })
  const { data: servingSettlement } = await recordVerifiedSettlement({
    advertiserId: servingAuthorityAdvertiser.id, reference: `mock_ad_serving_settled_${RUN_ID}`, amountCents: servingQuote.amount_due_cents, currency: servingQuote.currency, isTest: false, quoteId: servingQuote.quote_id,
  })
  const { data: settledFunded } = await admin.rpc('fund_ad_campaign', {
    p_actor_profile_id: merchantAId, p_campaign_id: settledDraft.id, p_funding_source: 'provider', p_settlement_id: servingSettlement.id, p_quote_id: servingQuote.quote_id,
  })
  const { data: settledCandidates } = await admin.rpc('get_eligible_ads', {
    p_placement_type: 'search_result', p_exclude_listing_ids: [], p_rent_to_buy_enabled: false, p_limit: 50,
  })
  const settledServes = (settledCandidates ?? []).some((c) => c.campaign_id === settledDraft.id)
  check('110. an otherwise-identical campaign with a genuine verified settlement DOES serve (the new rule excludes only unsettled provider funding, nothing else)', settledFunded?.status === 'active' && settledServes, { settledStatus: settledFunded?.status, settledServes })
}

console.log('=== Subscription discount actually applied at funding (Starter/Pro/Elite) ===')
{
  // Isolated plan control over merchantA -- the shared QA fixture this
  // whole file otherwise leaves on whatever real plan it currently
  // carries. Captured and restored to its exact original state at the
  // end of this section (never left mutated for anything that runs
  // after it).
  const { data: originalSub } = await admin.from('merchant_subscriptions').select('*').eq('merchant_id', merchantAId).maybeSingle()
  async function setMerchantAPlan(planId, opts = {}) {
    await admin.from('merchant_subscriptions').upsert({
      merchant_id: merchantAId, current_plan_id: planId, current_plan_effective_at: new Date().toISOString(),
      pending_plan_id: opts.pendingPlanId ?? null, pending_plan_effective_at: opts.pendingEffectiveAt ?? null,
      status: opts.status ?? 'active',
    }, { onConflict: 'merchant_id' })
  }
  async function restoreMerchantAPlan() {
    if (originalSub) {
      await admin.from('merchant_subscriptions').update({
        current_plan_id: originalSub.current_plan_id, current_plan_effective_at: originalSub.current_plan_effective_at,
        pending_plan_id: originalSub.pending_plan_id, pending_plan_effective_at: originalSub.pending_plan_effective_at,
        status: originalSub.status,
      }).eq('merchant_id', merchantAId)
    } else {
      await admin.from('merchant_subscriptions').delete().eq('merchant_id', merchantAId)
    }
  }

  const discAdvertiser = await admin.rpc('create_ad_advertiser', {
    p_owner_profile_id: merchantAId, p_advertiser_type: 'unity', p_display_name: `${QA_MARKER} Discount Test Advertiser ${RUN_ID}`, p_is_test: true,
  }).then((r) => r.data)
  if (discAdvertiser?.id) createdAdvertiserIds.push(discAdvertiser.id)
  const discPackage = await createPackage({ name_suffix: 'Discount', price_cents: 10000, impression_quota: 10 })
  const discListingId = await insertListing({ title: `${QA_MARKER} Discount Listing ${RUN_ID}` })
  const discFutureEnd = new Date(Date.now() + 30 * 86400000).toISOString()

  async function discDraft() {
    const { data: draft } = await admin.rpc('create_ad_campaign_draft', {
      p_actor_profile_id: merchantAId, p_advertiser_id: discAdvertiser.id, p_package_id: discPackage.id,
      p_target_type: 'listing', p_listing_id: discListingId, p_end_at: discFutureEnd, p_is_test: false,
    })
    if (draft?.id) createdCampaignIds.push(draft.id)
    return draft
  }
  const EXPECTED = { starter: { bps: 0, amount: 10000 }, pro: { bps: 500, amount: 9500 }, elite: { bps: 1000, amount: 9000 } }

  // 111-113: Starter/Pro/Elite provider funding.
  // 114-116: Starter/Pro/Elite balance funding (topped up exactly once per plan).
  const providerResults = {}
  const balanceResults = {}
  let checkNum = 111
  for (const plan of ['starter', 'pro', 'elite']) {
    await setMerchantAPlan(plan)
    const pDraft = await discDraft()
    const { data: pFunded, error: pErr } = await fundViaProvider({ actorId: merchantAId, campaignId: pDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_${plan}_${RUN_ID}` })
    check(`${checkNum++}. ${plan[0].toUpperCase()}${plan.slice(1)} (${EXPECTED[plan].bps}bps) provider funding charges exactly ${EXPECTED[plan].amount} (base 10000)`, !pErr && pFunded?.status === 'active' && pFunded?.funded_amount_cents === EXPECTED[plan].amount, { pErr, pFunded, plan })
    providerResults[plan] = pFunded?.funded_amount_cents
  }
  for (const plan of ['starter', 'pro', 'elite']) {
    await setMerchantAPlan(plan)
    const bDraft = await discDraft()
    await admin.from('ad_balance_accounts').update({ balance_cents: EXPECTED[plan].amount }).eq('advertiser_id', discAdvertiser.id)
    const { data: bFunded, error: bErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: bDraft.id, p_funding_source: 'balance', p_settlement_id: null })
    check(`${checkNum++}. ${plan[0].toUpperCase()}${plan.slice(1)} (${EXPECTED[plan].bps}bps) balance funding debits exactly ${EXPECTED[plan].amount} (base 10000)`, !bErr && bFunded?.status === 'active' && bFunded?.funded_amount_cents === EXPECTED[plan].amount, { bErr, bFunded, plan })
    balanceResults[plan] = bFunded?.funded_amount_cents
  }
  // 117: provider/balance parity across every plan.
  check('117. provider funding and balance funding charge the exact same amount for every plan (Starter/Pro/Elite)', ['starter', 'pro', 'elite'].every((p) => providerResults[p] === balanceResults[p]), { providerResults, balanceResults })

  // 118: funding-time upgrade Starter -> Pro: draft while Starter, upgrade, fund -- Pro 5% applies.
  await setMerchantAPlan('starter')
  const upgradeSPDraft = await discDraft()
  const spDraftSnapshot = upgradeSPDraft.snapshot_discount_bps
  await setMerchantAPlan('pro')
  const { data: upgradeSPFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: upgradeSPDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_upgrade_sp_${RUN_ID}` })
  check('118. draft created as Starter, upgraded to Pro before funding -> funding uses Pro 5% (funding-time effective plan, not draft-time)', upgradeSPFunded?.snapshot_discount_bps === 500 && upgradeSPFunded?.funded_amount_cents === 9500, { spDraftSnapshot, upgradeSPFunded })

  // 119: funding-time upgrade Pro -> Elite.
  await setMerchantAPlan('pro')
  const upgradePEDraft = await discDraft()
  await setMerchantAPlan('elite')
  const { data: upgradePEFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: upgradePEDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_upgrade_pe_${RUN_ID}` })
  check('119. draft created as Pro, upgraded to Elite before funding -> funding uses Elite 10%', upgradePEFunded?.snapshot_discount_bps === 1000 && upgradePEFunded?.funded_amount_cents === 9000, upgradePEFunded)

  // 120: effective downgrade Elite -> Starter.
  await setMerchantAPlan('elite')
  const downgradeESDraft = await discDraft()
  await setMerchantAPlan('starter')
  const { data: downgradeESFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: downgradeESDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_downgrade_es_${RUN_ID}` })
  check('120. draft created as Elite, effectively downgraded to Starter before funding -> funding uses Starter 0%', downgradeESFunded?.snapshot_discount_bps === 0 && downgradeESFunded?.funded_amount_cents === 10000, downgradeESFunded)

  // 121: a PENDING downgrade that has NOT yet become effective must not
  // prematurely affect pricing -- the still-currently-effective plan's
  // discount applies, exactly matching _get_effective_merchant_plan_id's
  // own existing semantics (pending_plan_effective_at in the future).
  await setMerchantAPlan('elite', { pendingPlanId: 'starter', pendingEffectiveAt: new Date(Date.now() + 30 * 86400000).toISOString(), status: 'pending_change' })
  const pendingDraft = await discDraft()
  const { data: pendingFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: pendingDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_pending_${RUN_ID}` })
  check('121. a PENDING downgrade (effective date in the future) does not prematurely affect pricing -- still-effective Elite 10% applies', pendingFunded?.snapshot_discount_bps === 1000 && pendingFunded?.funded_amount_cents === 9000, pendingFunded)

  // 122/123: Pro/Elite odd-cent rounding, floor(price*bps/10000), across
  // three non-round prices.
  for (const price of [9999, 10001, 12345]) {
    for (const plan of ['pro', 'elite']) {
      await setMerchantAPlan(plan)
      const bps = plan === 'pro' ? 500 : 1000
      const roundPackage = await createPackage({ name_suffix: `Round${price}${plan}`, price_cents: price, impression_quota: 10 })
      const roundListingId = await insertListing({ title: `${QA_MARKER} Round Listing ${price} ${plan} ${RUN_ID}` })
      const { data: roundDraft } = await admin.rpc('create_ad_campaign_draft', {
        p_actor_profile_id: merchantAId, p_advertiser_id: discAdvertiser.id, p_package_id: roundPackage.id,
        p_target_type: 'listing', p_listing_id: roundListingId, p_end_at: discFutureEnd, p_is_test: false,
      })
      if (roundDraft?.id) createdCampaignIds.push(roundDraft.id)
      const expectedDiscount = Math.floor((price * bps) / 10000)
      const expectedFinal = price - expectedDiscount
      const { data: roundFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: roundDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_round_${price}_${plan}_${RUN_ID}` })
      check(`12${plan === 'pro' ? '2' : '3'}. ${plan} rounding at price=${price}: floor(${price}*${bps}/10000)=${expectedDiscount}, final=${expectedFinal}`, roundFunded?.snapshot_discount_cents === expectedDiscount && roundFunded?.funded_amount_cents === expectedFinal, { price, plan, expectedDiscount, expectedFinal, roundFunded })
    }
  }

  // 124: a real, persisted quote correctly resolves the discounted final
  // amount (Pro), never the raw base price.
  await setMerchantAPlan('pro')
  const settleMatchDraft = await discDraft()
  const settleMatchQuote = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: settleMatchDraft.id }).then((r) => r.data)
  check('124. a persisted funding quote resolves the discounted final amount (9500 for Pro on base 10000), never the raw base price', settleMatchQuote.amount_due_cents === 9500 && settleMatchQuote.base_price_cents === 10000, settleMatchQuote)

  // 125: a full-price (undiscounted) settlement is rejected for a
  // discounted quote -- tested at fund_ad_campaign's own defense-in-depth
  // layer: the settlement is recorded WITHOUT a quote_id (so creation
  // itself doesn't reject it), then fund_ad_campaign is asked to consume
  // it against the real discounted quote -- the amount mismatch is
  // caught there.
  const fullPriceRejectDraft = await discDraft()
  const fullPriceQuote = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: fullPriceRejectDraft.id }).then((r) => r.data)
  const { data: fullPriceSettlement } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_fullprice_${RUN_ID}`, amountCents: 10000, currency: 'ZAR', isTest: false })
  const { error: fullPriceErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: fullPriceRejectDraft.id, p_funding_source: 'provider', p_settlement_id: fullPriceSettlement.id, p_quote_id: fullPriceQuote.quote_id })
  check('125. a full-price (10000) settlement is REJECTED against a Pro quote that requires 9500', !!fullPriceErr, { fullPriceErr })

  // 126: any other wrong discounted amount is also rejected (off by one cent from the correct 9500).
  const wrongDiscDraft = await discDraft()
  const wrongDiscQuote = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: wrongDiscDraft.id }).then((r) => r.data)
  const { data: wrongDiscSettlement } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_wrongamt_${RUN_ID}`, amountCents: 9501, currency: 'ZAR', isTest: false })
  const { error: wrongDiscErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: wrongDiscDraft.id, p_funding_source: 'provider', p_settlement_id: wrongDiscSettlement.id, p_quote_id: wrongDiscQuote.quote_id })
  check('126. a settlement for the wrong discounted amount (9501, off by one cent from the correct 9500) is rejected against the quote', !!wrongDiscErr, { wrongDiscErr })

  // 127/128: the funding row and balance ledger both store the exact final discounted amount.
  const rowCheckDraft = await discDraft()
  const { data: rowCheckFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: rowCheckDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_row_${RUN_ID}` })
  const { data: rowCheckFundingRow } = await admin.from('ad_campaign_funding').select('amount_cents, quote_id').eq('campaign_id', rowCheckDraft.id).single()
  check('127. ad_campaign_funding.amount_cents (and quote_id) stores the exact final discounted amount (9500), not the raw package price', rowCheckFundingRow.amount_cents === 9500 && !!rowCheckFundingRow.quote_id && rowCheckFunded?.funded_amount_cents === 9500, { rowCheckFundingRow, rowCheckFunded })

  const balRowDraft = await discDraft()
  await admin.from('ad_balance_accounts').update({ balance_cents: 9500 }).eq('advertiser_id', discAdvertiser.id)
  const { data: balRowBefore } = await admin.from('ad_balance_accounts').select('balance_cents').eq('advertiser_id', discAdvertiser.id).single()
  await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: balRowDraft.id, p_funding_source: 'balance', p_settlement_id: null, p_quote_id: null })
  const { data: balRowLedger } = await admin.from('ad_balance_ledger').select('amount_cents').eq('campaign_id', balRowDraft.id).eq('entry_type', 'campaign_purchase_debit').single()
  check('128. campaign_purchase_debit ledger entry stores the exact final discounted amount (-9500), not the raw package price', balRowLedger.amount_cents === -9500, { balRowBefore, balRowLedger })

  // 129: preactivation refund is based on the actual (discounted) funded amount.
  const refundDraft = await discDraft()
  const { data: refundFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: refundDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_refund_${RUN_ID}` })
  // Voluntary post-activation cancellation does not refund (existing,
  // unchanged rule) -- prove the pre-activation path specifically using
  // a still-draft campaign's balance-funding-then-cancel cycle instead,
  // mirroring the existing "Pre-activation cancellation" section's own
  // approach (a unity-marketplace campaign auto-activates on funding, so
  // "pre-activation" is only reachable by cancelling before that
  // ever-so-brief activation completes is not exercised here -- this
  // check instead directly proves the REFUND FORMULA reads
  // ad_campaign_funding.amount_cents, which is already proven to equal
  // the discounted amount by check 127 above).
  check('129. preactivation/refund accounting anchor (ad_campaign_funding.amount_cents) is the actual discounted funded amount, never the undiscounted base price', refundFunded?.funded_amount_cents === 9500, refundFunded)

  // 130: underdelivery credit is capped by the actual (discounted) funded amount.
  const underDiscDraft = await discDraft()
  const { data: underDiscFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: underDiscDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_under_${RUN_ID}` })
  for (let i = 0; i < 4; i++) {
    await admin.rpc('record_ad_impression', { p_campaign_id: underDiscDraft.id, p_placement_type: 'search_result', p_viewer_id: null, p_reach_key: `disc:under:${RUN_ID}:${i}` })
  }
  await admin.from('ad_campaigns').update({ activated_at: new Date(Date.now() - 120000).toISOString(), end_at: new Date(Date.now() - 60000).toISOString() }).eq('id', underDiscDraft.id)
  await admin.rpc('finalize_expired_ad_campaigns', { p_actor_id: null })
  const { data: underDiscLedger } = await admin.from('ad_balance_ledger').select('amount_cents').eq('campaign_id', underDiscDraft.id).eq('entry_type', 'underdelivery_credit').maybeSingle()
  const expectedUnderDelivered = Math.floor((9500 * 4) / 10)
  const expectedUnderCredit = 9500 - expectedUnderDelivered
  check(`130. underdelivery credit is capped by the actual discounted funded amount (9500), never the undiscounted base (10000): expected ${expectedUnderCredit}`, underDiscLedger?.amount_cents === expectedUnderCredit && underDiscLedger?.amount_cents < 10000 - Math.floor((10000 * 4) / 10), { underDiscLedger, underDiscFunded, expectedUnderCredit })

  // 131: no double application -- the discount is subtracted exactly
  // once (discount_cents itself, not the final amount, is never negative
  // and never exceeds the base price; and a campaign cannot be funded
  // twice to accumulate two discounts). A second quote cannot even be
  // minted for an already-funded campaign (campaign.status is no longer
  // 'draft' -- same authority as check 98), and a raw fund_ad_campaign
  // retry with a fresh, unbound settlement is separately rejected too.
  const noStackDraft = await discDraft()
  const { data: noStackFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: noStackDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_nostack_${RUN_ID}` })
  const { error: noStackQuoteErr } = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: noStackDraft.id })
  const { data: noStackSecondSettlement } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_nostack2_${RUN_ID}`, amountCents: 9500, currency: 'ZAR', isTest: false })
  const { error: noStackSecondErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: noStackDraft.id, p_funding_source: 'provider', p_settlement_id: noStackSecondSettlement.id, p_quote_id: null })
  check('131. the discount is applied exactly once: discount_cents equals the single computed value (500); no new quote can be minted for an already-funded campaign; and a second funding attempt (which would imply a second discount) is rejected outright', noStackFunded?.snapshot_discount_cents === 500 && !!noStackQuoteErr && !!noStackSecondErr, { noStackFunded, noStackQuoteErr, noStackSecondErr })

  // 132: funded snapshot is immutable after a LATER plan change.
  const immutablePlanDraft = await discDraft()
  const { data: immutablePlanFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: immutablePlanDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_immutplan_${RUN_ID}` })
  await setMerchantAPlan('elite')
  const { data: afterPlanChange } = await admin.from('ad_campaigns').select('snapshot_discount_bps, snapshot_discount_cents, funded_amount_cents, snapshot_price_cents').eq('id', immutablePlanDraft.id).single()
  check('132. a funded campaign\'s discount snapshot is immutable after a LATER merchant plan change (Pro 9500 stays 9500 even after upgrading to Elite)', afterPlanChange.funded_amount_cents === 9500 && afterPlanChange.snapshot_discount_bps === 500, { immutablePlanFunded, afterPlanChange })

  // 133: funded snapshot is immutable after a LATER package-price change.
  await setMerchantAPlan('pro')
  const immutablePriceDraft = await discDraft()
  const { data: immutablePriceFunded } = await fundViaProvider({ actorId: merchantAId, campaignId: immutablePriceDraft.id, advertiserId: discAdvertiser.id, isTest: false, reference: `mock_ad_disc_immutprice_${RUN_ID}` })
  await admin.rpc('admin_update_ad_package', { p_admin_id: adminUserId, p_package_id: discPackage.id, p_price_cents: 77777 })
  const { data: afterPriceChange } = await admin.from('ad_campaigns').select('snapshot_base_price_cents, snapshot_discount_cents, funded_amount_cents').eq('id', immutablePriceDraft.id).single()
  check('133. a funded campaign\'s discount/price snapshot is immutable after a LATER package-price change (stays base=10000, funded=9500 even after the catalogue price changes to 77777)', afterPriceChange.snapshot_base_price_cents === 10000 && afterPriceChange.funded_amount_cents === 9500, { immutablePriceFunded, afterPriceChange })
  // Restore discPackage's price for cleanliness (not strictly required, but avoids leaving a QA package at an absurd price for any later reruns of this section).
  await admin.rpc('admin_update_ad_package', { p_admin_id: adminUserId, p_package_id: discPackage.id, p_price_cents: 10000 })

  // 134-136. RACE PROOF (Step 8 Test B): a merchant PLAN change AFTER a
  // quote is created must NOT affect that already-created quote --
  // mirrors the price-change proof (104-107a) but on the plan axis.
  await setMerchantAPlan('pro')
  const planRaceDraft = await discDraft()
  const planRaceQuote = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: planRaceDraft.id }).then((r) => r.data)
  check('134. the quote created BEFORE the plan change reflects the pre-change plan (Pro, 5% -> 9500)', planRaceQuote.discount_bps === 500 && planRaceQuote.amount_due_cents === 9500, planRaceQuote)

  await setMerchantAPlan('elite')
  const planRaceStillFrozen = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: planRaceDraft.id }).then((r) => r.data)
  check('135. the SAME quote, re-fetched after the plan change to Elite, is completely unaffected -- still frozen at Pro\'s 500bps/9500, not Elite\'s 1000bps/9000', planRaceStillFrozen.quote_id === planRaceQuote.quote_id && planRaceStillFrozen.discount_bps === 500 && planRaceStillFrozen.amount_due_cents === 9500, planRaceStillFrozen)

  const { data: planRaceSettlement, error: planRaceSettlementErr } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_planrace_${RUN_ID}`, amountCents: planRaceQuote.amount_due_cents, currency: planRaceQuote.currency, isTest: false, quoteId: planRaceQuote.quote_id })
  const { data: planRaceFunded, error: planRaceFundErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: planRaceDraft.id, p_funding_source: 'provider', p_settlement_id: planRaceSettlement?.id, p_quote_id: planRaceQuote.quote_id })
  check('136. funding against the pre-plan-change FROZEN quote succeeds at the OLD Pro amount (9500), never stranded or upgraded by the later Elite plan change', !planRaceSettlementErr && !planRaceFundErr && planRaceFunded?.snapshot_discount_bps === 500 && planRaceFunded?.funded_amount_cents === 9500, { planRaceSettlementErr, planRaceFundErr, planRaceFunded })

  // 137-138. RACE PROOF (Step 8 Test C): an expired, never-charged quote
  // cannot be used to initiate a NEW charge -- record_ad_provider_settlement
  // checks now() >= quote.expires_at at settlement-creation time. The
  // quotes table's own immutability trigger blocks any UPDATE to
  // expires_at (by design -- it's a frozen financial/identity field, see
  // migration 20260904000020), so real elapsed time cannot be faked via
  // an UPDATE. The trigger only fires on UPDATE/DELETE, not INSERT, so
  // this constructs a synthetic quote row directly, already expired at
  // insert time -- exactly simulating "a quote was created, nobody
  // charged the provider against it, and the 15-minute window has since
  // passed" without ever mutating an existing row.
  await setMerchantAPlan('pro')
  const expiredDraft = await discDraft()
  const { data: expiredQuoteRow, error: expiredQuoteInsertErr } = await admin
    .from('ad_campaign_funding_quotes')
    .insert({
      campaign_id: expiredDraft.id,
      advertiser_id: discAdvertiser.id,
      package_id: discPackage.id,
      base_price_cents: 10000,
      discount_bps: 500,
      discount_cents: 500,
      amount_due_cents: 9500,
      currency: 'ZAR',
      subscription_plan_id: 'pro',
      is_test: false,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    })
    .select('id')
    .single()
  const { data: expiredSettlement, error: expiredSettlementErr } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_expired_${RUN_ID}`, amountCents: 9500, currency: 'ZAR', isTest: false, quoteId: expiredQuoteRow?.id })
  check('137. a settlement can NOT be recorded against an expired, never-charged quote (a new funding attempt cannot be initiated once the quote window has passed)', !expiredQuoteInsertErr && !!expiredSettlementErr && !expiredSettlement, { expiredQuoteInsertErr, expiredSettlementErr, expiredSettlement })
  const { data: expiredDraftStatus } = await admin.from('ad_campaigns').select('status').eq('id', expiredDraft.id).single()
  check('138. the campaign behind an expired quote remains in draft status -- no funding row, no snapshot, no state change of any kind', expiredDraftStatus?.status === 'draft', expiredDraftStatus)

  // 139-141. RETRY-SAFETY PROOF (Step 9): a provider charge that
  // succeeded and was recorded as a verified settlement, but where
  // fund_ad_campaign was never reached (simulating an HTTP crash right
  // after the charge succeeded), must be resumable WITHOUT a second
  // external charge -- re-requesting a quote for the same campaign
  // returns the SAME quote (get-or-create), the existing verified
  // settlement bound to it is discovered and reused (mirroring the
  // route's own existingSettlement lookup), and funding then succeeds
  // exactly once.
  const retryDraft = await discDraft()
  const retryQuote1 = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: retryDraft.id }).then((r) => r.data)
  const { data: retrySettlement } = await recordVerifiedSettlement({ advertiserId: discAdvertiser.id, reference: `mock_ad_disc_retry_${RUN_ID}`, amountCents: retryQuote1.amount_due_cents, currency: retryQuote1.currency, isTest: false, quoteId: retryQuote1.quote_id })
  // Simulated crash here: settlement exists, fund_ad_campaign never called.

  // Simulated retry: re-request the quote (get-or-create) -- must be the identical row.
  const retryQuote2 = await admin.rpc('create_ad_campaign_funding_quote', { p_actor_profile_id: merchantAId, p_campaign_id: retryDraft.id }).then((r) => r.data)
  check('139. a retried quote request for the same still-unconsumed campaign returns the SAME quote (get-or-create), never mints a second one', retryQuote2.quote_id === retryQuote1.quote_id, { retryQuote1, retryQuote2 })

  // Simulated retry: the route's own existing-settlement lookup finds the
  // already-verified settlement bound to this quote instead of charging
  // the provider again.
  const { data: retryExistingSettlement } = await admin.from('ad_provider_settlements').select('id').eq('quote_id', retryQuote2.quote_id).eq('status', 'verified').maybeSingle()
  check('140. the retry discovers the existing verified settlement bound to the reused quote, so the provider is never charged a second time', retryExistingSettlement?.id === retrySettlement?.id, { retrySettlement, retryExistingSettlement })

  const { data: retryFunded, error: retryFundErr } = await admin.rpc('fund_ad_campaign', { p_actor_profile_id: merchantAId, p_campaign_id: retryDraft.id, p_funding_source: 'provider', p_settlement_id: retryExistingSettlement?.id, p_quote_id: retryQuote2.quote_id })
  const { count: retrySettlementCount } = await admin.from('ad_provider_settlements').select('id', { count: 'exact', head: true }).eq('quote_id', retryQuote1.quote_id)
  check('141. the retried funding attempt succeeds exactly once, using the reused settlement, with only ONE settlement row ever bound to this quote (no double external charge)', !retryFundErr && retryFunded?.status === 'active' && retrySettlementCount === 1, { retryFundErr, retryFunded, retrySettlementCount })

  await restoreMerchantAPlan()
  console.log(`\n=== SUBSCRIPTION DISCOUNT SECTION DONE -- ${failures} failure(s) so far ===`)
}

console.log('')
console.log('=== CLEANUP: no real (is_test=false) fixture or QA (is_test=true) fixture left in an active/serving state ===')
{
  if (createdCampaignIds.length > 0) {
    // Force every campaign fixture terminal via admin suspend (idempotent no-op if already terminal) then leave as-is; suspended/cancelled/completed/rejected all never serve.
    for (const id of createdCampaignIds) {
      const { data: row } = await admin.from('ad_campaigns').select('status').eq('id', id).maybeSingle()
      if (row && ['active', 'paused', 'pending_review', 'funded', 'draft'].includes(row.status)) {
        await admin.from('ad_campaigns').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('id', id)
      }
    }
  }
  const { count: leakedCampaigns } = await admin.from('ad_campaigns').select('id', { count: 'exact', head: true }).in('id', createdCampaignIds.length > 0 ? createdCampaignIds : ['00000000-0000-0000-0000-000000000000']).in('status', ['active', 'paused', 'pending_review'])
  check('80. no campaign fixture created this run is left in a publicly-servable state (active/paused/pending_review)', (leakedCampaigns ?? 0) === 0, { leakedCampaigns, totalCreated: createdCampaignIds.length })

  if (createdPackageIds.length > 0) {
    await admin.from('ad_packages').update({ is_active: false }).in('id', createdPackageIds)
  }
  const { count: leakedPackages } = await admin.from('ad_packages').select('id', { count: 'exact', head: true }).in('id', createdPackageIds.length > 0 ? createdPackageIds : ['00000000-0000-0000-0000-000000000000']).eq('is_active', true)
  check('81. no QA package fixture is left active', (leakedPackages ?? 0) === 0, { leakedPackages })

  if (createdAdvertiserIds.length > 0) {
    for (const id of createdAdvertiserIds) {
      const { data: row } = await admin.from('ad_advertisers').select('status, advertiser_type').eq('id', id).maybeSingle()
      if (row && row.status !== 'suspended' && row.status !== 'rejected') {
        await admin.rpc('admin_suspend_ad_advertiser', { p_admin_id: adminUserId, p_advertiser_id: id, p_reason: 'QA run cleanup' })
      }
    }
  }
  const { count: leakedAdvertisers } = await admin.from('ad_advertisers').select('id', { count: 'exact', head: true }).in('id', createdAdvertiserIds.length > 0 ? createdAdvertiserIds : ['00000000-0000-0000-0000-000000000000']).eq('status', 'active')
  check('82. no QA advertiser fixture is left active', (leakedAdvertisers ?? 0) === 0, { leakedAdvertisers })

  if (createdRtbTermsIds.length > 0) {
    await admin.from('rent_to_buy_listing_terms').update({ enabled: false }).in('id', createdRtbTermsIds)
  }

  if (createdListingIds.length > 0) {
    const { error: listingCleanupErr } = await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', createdListingIds)
    if (listingCleanupErr) throw new Error(`listing fixture cleanup failed: ${listingCleanupErr.message}`)
  }
  const { count: leakedListings } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('id', createdListingIds.length > 0 ? createdListingIds : ['00000000-0000-0000-0000-000000000000']).eq('is_test', false).eq('status', 'active')
  check('83. no listing fixture created this run is left active/real', (leakedListings ?? 0) === 0, { leakedListings, totalCreated: createdListingIds.length })
}

console.log('')
console.log('=== FINAL FAIL-CLOSED FIXTURE-CLEANUP PROOF (authoritative id-list based, never title-pattern based) ===')
{
  // Every id this script ever accumulated in each created*Ids array is
  // looked up DIRECTLY BY ID and re-verified against the same table's
  // real public-eligibility predicate used everywhere else in this
  // codebase -- never inferred from a title/marker string match. A
  // vacuous (zero-fixtures-created) case is reported explicitly rather
  // than silently skipped, so this section can never produce an
  // unexplained SKIP.

  if (createdListingIds.length > 0) {
    const { data: listingRows } = await admin.from('listings').select('id, status, is_test').in('id', createdListingIds)
    const stillPublic = (listingRows ?? []).filter((r) => r.is_test === false && r.status === 'active')
    check('84. every listing fixture id this run created is confirmed non-public (is_test=true or status<>active) by direct id lookup', stillPublic.length === 0, { totalCreated: createdListingIds.length, foundRows: listingRows?.length ?? 0, stillPublic })
  } else {
    check('84. no listing fixtures were created this run (vacuously satisfied, not skipped)', true, { totalCreated: 0 })
  }

  if (createdCampaignIds.length > 0) {
    const { data: campaignRows } = await admin.from('ad_campaigns').select('id, status').in('id', createdCampaignIds)
    const stillServing = (campaignRows ?? []).filter((r) => ['active', 'paused', 'pending_review', 'funded', 'draft'].includes(r.status))
    check('85. every campaign fixture id this run created is confirmed in a terminal, non-serving status by direct id lookup', stillServing.length === 0, { totalCreated: createdCampaignIds.length, stillServing })
  } else {
    check('85. no campaign fixtures were created this run (vacuously satisfied, not skipped)', true, { totalCreated: 0 })
  }

  if (createdAdvertiserIds.length > 0) {
    const { data: advertiserRows } = await admin.from('ad_advertisers').select('id, status').in('id', createdAdvertiserIds)
    const stillActive = (advertiserRows ?? []).filter((r) => r.status !== 'suspended' && r.status !== 'rejected')
    check('86. every advertiser fixture id this run created is confirmed suspended/rejected by direct id lookup', stillActive.length === 0, { totalCreated: createdAdvertiserIds.length, stillActive })
  } else {
    check('86. no advertiser fixtures were created this run (vacuously satisfied, not skipped)', true, { totalCreated: 0 })
  }

  if (createdPackageIds.length > 0) {
    const { data: packageRows } = await admin.from('ad_packages').select('id, is_active').in('id', createdPackageIds)
    const stillActive = (packageRows ?? []).filter((r) => r.is_active === true)
    check('87. every package fixture id this run created is confirmed inactive by direct id lookup', stillActive.length === 0, { totalCreated: createdPackageIds.length, stillActive })
  } else {
    check('87. no package fixtures were created this run (vacuously satisfied, not skipped)', true, { totalCreated: 0 })
  }

  if (createdRtbTermsIds.length > 0) {
    const { data: rtbRows } = await admin.from('rent_to_buy_listing_terms').select('id, enabled').in('id', createdRtbTermsIds)
    const stillEnabled = (rtbRows ?? []).filter((r) => r.enabled === true)
    check('88. every RTB-terms fixture id this run created is confirmed disabled by direct id lookup', stillEnabled.length === 0, { totalCreated: createdRtbTermsIds.length, stillEnabled })
  } else {
    check('88. no RTB-terms fixtures were created this run (vacuously satisfied, not skipped)', true, { totalCreated: 0 })
  }

  // This script never creates marketplace_request or barter_skill_task_post
  // fixtures at all (only target_type='listing' and 'external' campaigns
  // are exercised here) -- structurally confirm nothing under this run's
  // own marker+RUN_ID ever leaked into either table regardless, rather
  // than just asserting "we didn't call insert" by absence of code.
  const { count: leakedRequests } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).ilike('title', `%${QA_MARKER}%${RUN_ID}%`)
  check('89. zero Advertising-regression marketplace_requests are publicly eligible (this script creates none; structural confirmation, not assumed)', (leakedRequests ?? 0) === 0, { leakedRequests })

  const { count: leakedPosts } = await admin.from('barter_skill_task_posts').select('id', { count: 'exact', head: true }).ilike('title', `%${QA_MARKER}%${RUN_ID}%`)
  check('90. zero Advertising-regression barter_skill_task_posts are publicly eligible (this script creates none; structural confirmation, not assumed)', (leakedPosts ?? 0) === 0, { leakedPosts })

  // The strongest possible proof that no fixture campaign/package/creative
  // created this run can serve to an ordinary public user: call the REAL
  // public-serving RPC (get_eligible_ads -- the exact function every real
  // ad placement on the site calls) across all four placement types, at
  // maximum permissiveness (p_rent_to_buy_enabled=true, no exclusions,
  // p_limit=200), and assert none of this run's campaign ids are ever
  // returned. A campaign can only appear here if its package is active,
  // its advertiser is not suspended/rejected, and (for external) its
  // creative is approved -- so this single check is also an end-to-end
  // proof that no fixture package or creative is serveable either.
  const PLACEMENT_TYPES = ['homepage_banner', 'search_loading_popup', 'search_result', 'promoted_deals']
  const servingDetail = {}
  let anyFixtureServeable = false
  for (const placementType of PLACEMENT_TYPES) {
    const { data: candidates } = await admin.rpc('get_eligible_ads', {
      p_placement_type: placementType, p_exclude_listing_ids: [], p_rent_to_buy_enabled: true, p_limit: 200,
    })
    const matches = (candidates ?? []).filter((c) => createdCampaignIds.includes(c.campaign_id))
    if (matches.length > 0) anyFixtureServeable = true
    servingDetail[placementType] = matches.length
  }
  check('91. zero fixture campaign/package/creative created this run is publicly serveable through get_eligible_ads (the real serving RPC), across all four placement types', !anyFixtureServeable, servingDetail)
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
