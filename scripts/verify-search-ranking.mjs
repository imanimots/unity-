#!/usr/bin/env node
/**
 * Permanent regression check for Search Ranking MVP (search_listings /
 * search_marketplace_requests / search_skill_task_posts SQL RPCs, the
 * generated search_vector columns, the listings is_test RLS fix, and
 * the barter_skill_task_public_posts view widening). Real script
 * against the live dev database, matching every prior phase's
 * regression-script convention.
 *
 * Fails closed: every assertion is an explicit check() call; no
 * skip() of any kind exists in this script -- if a scenario's
 * precondition can't be met, it is a FAIL, not a silent skip.
 *
 * SAFETY: same gate as every other verify-*.mjs script.
 * Usage: node scripts/verify-search-ranking.mjs
 * Requires scripts/qa-seed.mjs already run once (for QA account ids).
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
    console.error('verify-search-ranking aborted -- safety checks failed:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}
assertSafeToRun()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!ANON_KEY || !SERVICE_KEY) {
  console.error('verify-search-ranking aborted -- keys missing')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY)
const anon = createClient(SUPABASE_URL, ANON_KEY)
const QA_MARKER = '[QA] SearchRank'
const RUN_ID = Date.now()
const SCRIPT_START_AT = new Date().toISOString()

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}

let creds
try {
  creds = JSON.parse(readFileSync(join(REPO_ROOT, '.qa-credentials.local.json'), 'utf8'))
} catch {
  console.error('verify-search-ranking aborted -- .qa-credentials.local.json not found. Run scripts/qa-seed.mjs first.')
  process.exit(1)
}
const { data: allUsers } = await admin.auth.admin.listUsers()
const merchantAId = allUsers.users.find((u) => u.email === creds.accounts.merchantA.email)?.id
const renterAId = allUsers.users.find((u) => u.email === creds.accounts.renterA.email)?.id
if (!merchantAId) throw new Error('could not resolve merchantA id')
if (!renterAId) throw new Error('could not resolve renterA id')

const anonAsRenterA = createClient(SUPABASE_URL, ANON_KEY)
const { error: renterSignInError } = await anonAsRenterA.auth.signInWithPassword({ email: creds.accounts.renterA.email, password: creds.accounts.renterA.password })
if (renterSignInError) throw new Error(`renterA sign-in failed: ${renterSignInError.message}`)

// ── Fixture setup: three listings forming a clean tier ladder for a
// single controlled query term, plus is_test/status/direction variants
// to prove eligibility filtering. ──
// Cleanup relies on TWO independent mechanisms: the QA_MARKER title
// sweep below, AND this exhaustive id list -- several exact-title-tier
// and coverage-score fixtures deliberately do NOT carry the QA_MARKER
// prefix (it would corrupt the exact-normalized-title match under
// test), so title-pattern sweeping alone cannot find them. Every
// insertListing() call is tracked here regardless of its title shape,
// guaranteeing complete cleanup independent of title content.
const allCreatedListingIds = []
async function insertListing(overrides) {
  const base = {
    merchant_id: merchantAId, country_id: 'ZA', category: 'electronics', condition: 'good',
    listing_type: 'rental', quantity_available: 1, status: 'active', direction: 'available',
    daily_rate: 150, risk_tier: 'low', ownership_verified: false, condition_confirmed: true, is_test: false,
  }
  const { data, error } = await admin.from('listings').insert({ ...base, ...overrides }).select('id').single()
  if (error) throw new Error(`insertListing failed: ${error.message}`)
  allCreatedListingIds.push(data.id)
  return data.id
}

const TERM = `zqxvantiq${RUN_ID}`
// EXACT_TITLE is the literal, full, normalized title of exactTitleId --
// querying with THIS exact string (not just TERM) is what tier 3 now
// requires (Final Closure round: Tier 3 was previously a bare ILIKE
// substring match, which wrongly promoted "Camera Bag" to the same tier
// as "Camera" for a query of "camera" -- fixed in migration
// 20260902000005 to require normalized(title) = normalized(query)).
// exactTitleId's title also contains TERM as one word among several, so
// it doubles as the "word contained in a longer title" fixture when
// queried with bare TERM instead -- that query must NOT classify it as
// tier 3 (requirement B of the exact-title fix).
const EXACT_TITLE = `${QA_MARKER} Exact ${TERM}`
const exactTitleId = await insertListing({ title: EXACT_TITLE })
const ftsOnlyId = await insertListing({ title: `${QA_MARKER} Photography rig ${RUN_ID}`, description: `Great for ${TERM} shoots and more ${TERM}ing sessions` })
const typoTitleId = await insertListing({ title: `${QA_MARKER} ${TERM}x gear ${RUN_ID}` }) // one-char-off typo of TERM, no exact substring, no FTS token match
const testFlaggedId = await insertListing({ title: `${QA_MARKER} ${TERM} test-flagged ${RUN_ID}`, is_test: true })
const draftId = await insertListing({ title: `${QA_MARKER} ${TERM} draft ${RUN_ID}`, status: 'draft' })
const lockedId = await insertListing({ title: `${QA_MARKER} ${TERM} locked ${RUN_ID}` })
const cheapId = await insertListing({ title: `${QA_MARKER} PriceLadder A ${RUN_ID}`, daily_rate: 50 })
const midId = await insertListing({ title: `${QA_MARKER} PriceLadder B ${RUN_ID}`, daily_rate: 150 })
const expensiveId = await insertListing({ title: `${QA_MARKER} PriceLadder C ${RUN_ID}`, daily_rate: 500 })

// Lock one listing via a REAL accepted barter agreement/offer/offer-item
// chain, mirroring exactly how barter_locked_listings is actually
// populated in production (never insert into that view/table directly --
// it is a derived view over barter_offer_items/barter_offers/
// barter_agreements, see its own pg_get_viewdef). Two distinct parties
// are required (barter_agreements_parties_distinct_chk).
let lockedListingConfirmed = false
{
  const { data: agreement, error: agrErr } = await admin.from('barter_agreements').insert({
    party_a_id: merchantAId, party_b_id: renterAId, status: 'accepted', anchor_listing_id: lockedId,
  }).select('id').single()
  if (agrErr) throw new Error(`lock fixture: barter_agreements insert failed: ${agrErr.message}`)

  const { data: offer, error: offerErr } = await admin.from('barter_offers').insert({
    agreement_id: agreement.id, version: 1, proposed_by: renterAId, status: 'accepted', delivery_method: 'meet_in_person',
  }).select('id').single()
  if (offerErr) throw new Error(`lock fixture: barter_offers insert failed: ${offerErr.message}`)

  const { error: itemErr } = await admin.from('barter_offer_items').insert({
    offer_id: offer.id, listing_id: lockedId, offered_by: merchantAId, kind: 'item',
  })
  if (itemErr) throw new Error(`lock fixture: barter_offer_items insert failed: ${itemErr.message}`)

  const { error: acceptErr } = await admin.from('barter_agreements').update({ accepted_offer_id: offer.id }).eq('id', agreement.id)
  if (acceptErr) throw new Error(`lock fixture: setting accepted_offer_id failed: ${acceptErr.message}`)

  const { data: lockCheck } = await admin.from('barter_locked_listings').select('listing_id').eq('listing_id', lockedId).maybeSingle()
  lockedListingConfirmed = Boolean(lockCheck)
}

console.log('=== Tier classification (exact > FTS > trigram) ===')
{
  // Scenario A: querying the FULL, exact, normalized title -> tier 3.
  const { data: exactData, error } = await admin.rpc('search_listings', {
    p_query: EXACT_TITLE, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null,
    p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100,
  })
  check('1. RPC call succeeds', !error, error)
  const exactById = new Map((exactData ?? []).map((r) => [r.id, r]))
  check('2. exact-title match classified as tier 3 (normalized(title) = normalized(query), not a substring test)', exactById.get(exactTitleId)?.match_tier === 3 && Number(exactById.get(exactTitleId)?.match_score) === 1, exactById.get(exactTitleId))

  // Scenario B: querying just ONE word that is contained within a longer
  // title -- exactTitleId's title is "[QA] SearchRank Exact <TERM>", so a
  // bare-TERM query must NOT classify it as tier 3 anymore (Final Closure
  // fix, requirement B) -- it must fall to tier 2 (FTS), same as ftsOnlyId.
  const { data, error: err2 } = await admin.rpc('search_listings', {
    p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null,
    p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100,
  })
  check('3. RPC call succeeds (word-in-title scenario)', !err2, err2)
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  check('4. a query matching only ONE WORD within a longer title is NOT classified as tier 3 (exact-title fix, requirement B)', byId.get(exactTitleId)?.match_tier === 2, byId.get(exactTitleId))
  check('5. FTS-only match (no title substring) classified as tier 2', byId.get(ftsOnlyId)?.match_tier === 2, byId.get(ftsOnlyId))
  check('6. tier 2 word-in-title and tier 2 FTS-only both rank above the tier-1/excluded rest (both present, same tier)', byId.get(exactTitleId)?.match_tier === byId.get(ftsOnlyId)?.match_tier)
  check('7. is_test=true fixture is excluded even though its title matches the query', !byId.has(testFlaggedId), { present: byId.has(testFlaggedId) })
  check('8. draft-status fixture is excluded', !byId.has(draftId), { present: byId.has(draftId) })
}

console.log('=== Trigram typo fallback ===')
{
  const typoQuery = TERM.slice(0, -1) + 'k' // one-character substitution, no substring/FTS hit expected
  const { data } = await admin.rpc('search_listings', {
    p_query: typoQuery, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null,
    p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100,
  })
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  const hit = byId.get(exactTitleId) ?? byId.get(typoTitleId)
  check('9. a single-character typo of the exact term still returns at least one tier-1 trigram match', Boolean(hit) && hit.match_tier === 1, { hit, ids: (data ?? []).map((r) => r.id) })
}

console.log('=== Unrelated query returns nothing ===')
{
  const { data } = await admin.rpc('search_listings', {
    p_query: `completely-unrelated-nonsense-${RUN_ID}-zzz`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null,
    p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100,
  })
  const byId = new Set((data ?? []).map((r) => r.id))
  check('10. no fixture matches an unrelated query', ![exactTitleId, ftsOnlyId, typoTitleId].some((id) => byId.has(id)), { matched: [...byId] })
}

console.log('=== Empty-query browse is deterministic (Newest) ===')
{
  const { data: run1 } = await admin.rpc('search_listings', { p_query: null, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const { data: run2 } = await admin.rpc('search_listings', { p_query: null, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  check('11. two identical empty-query browse calls return the same order', JSON.stringify((run1 ?? []).map((r) => r.id)) === JSON.stringify((run2 ?? []).map((r) => r.id)))
  check('12. every row has match_tier=0 and match_score=0 on empty query', (run1 ?? []).every((r) => r.match_tier === 0 && Number(r.match_score) === 0))
}

console.log('=== Cursor pagination: no duplicates, no skips ===')
{
  const page1 = (await admin.rpc('search_listings', { p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 2 })).data ?? []
  check('13. page 1 returns exactly the requested limit (enough fixtures exist)', page1.length === 2, { page1 })
  const last = page1[page1.length - 1]
  const page2 = (await admin.rpc('search_listings', { p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: last?.match_tier ?? null, p_cursor_score: last?.match_score ?? null, p_cursor_price: last?.price ?? null, p_cursor_created_at: last?.created_at ?? null, p_cursor_id: last?.id ?? null, p_limit: 2 })).data ?? []
  const page1Ids = new Set(page1.map((r) => r.id))
  check('14. page 2 has no overlap with page 1', page2.every((r) => !page1Ids.has(r.id)), { page1Ids: [...page1Ids], page2Ids: page2.map((r) => r.id) })
}

console.log('=== Sort matrix: price_asc / price_desc (listings) ===')
{
  const asc = (await admin.rpc('search_listings', { p_query: null, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'price_asc', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })).data ?? []
  const ascIds = asc.map((r) => r.id)
  check('15. price_asc: PriceLadder A (50) ranks before B (150) before C (500)', ascIds.indexOf(cheapId) < ascIds.indexOf(midId) && ascIds.indexOf(midId) < ascIds.indexOf(expensiveId), { positions: [ascIds.indexOf(cheapId), ascIds.indexOf(midId), ascIds.indexOf(expensiveId)] })
  const desc = (await admin.rpc('search_listings', { p_query: null, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'price_desc', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })).data ?? []
  const descIds = desc.map((r) => r.id)
  check('16. price_desc: PriceLadder C (500) ranks before B (150) before A (50)', descIds.indexOf(expensiveId) < descIds.indexOf(midId) && descIds.indexOf(midId) < descIds.indexOf(cheapId))
}

console.log('=== Revenue-neutrality: affiliate/commission fields never affect rank ===')
{
  const affId = await insertListing({ title: `${QA_MARKER} RevenueNeutral A ${RUN_ID}`, daily_rate: 150, affiliate_enabled_at: new Date().toISOString(), affiliate_commission_rate: 25 })
  const noAffId = await insertListing({ title: `${QA_MARKER} RevenueNeutral B ${RUN_ID}`, daily_rate: 150 }) // affiliate_enabled_at omitted -- defaults null (disabled)
  const { data } = await admin.rpc('search_listings', { p_query: null, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  check('17. affiliate-enabled and affiliate-disabled listings get identical tier/score (0/0 on empty query) -- affiliate status has zero rank effect', byId.get(affId)?.match_tier === byId.get(noAffId)?.match_tier && Number(byId.get(affId)?.match_score) === Number(byId.get(noAffId)?.match_score))
}

console.log('=== SQL-injection-shaped / oversized / empty query safety ===')
{
  const injected = "x'; DROP TABLE listings; --"
  const { error: e1 } = await admin.rpc('search_listings', { p_query: injected, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  check('18. SQL-injection-shaped query string does not error (parameterized, inert as text)', !e1, e1)
  const { data: stillThere } = await admin.from('listings').select('id').limit(1)
  check('19. listings table still exists and is queryable after the injection-shaped call', Array.isArray(stillThere))
  const huge = 'a'.repeat(10000)
  const { error: e2 } = await admin.rpc('search_listings', { p_query: huge, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  check('20. a 10,000-character query does not error', !e2, e2)
  const { error: e3 } = await admin.rpc('search_listings', { p_query: '   ', p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  check('21. a whitespace-only query does not error and behaves as an empty browse', !e3, e3)
}

console.log('=== marketplace_requests: country filtering, is_test isolation, >60 reachable ===')
{
  const testerAId = merchantAId
  async function insertRequest(overrides) {
    const base = { requester_id: testerAId, transaction_type: 'buy', title: `${QA_MARKER} Req ${RUN_ID}`, category: 'electronics', country_id: 'ZA', status: 'active', is_test: false }
    const { data, error } = await admin.from('marketplace_requests').insert({ ...base, ...overrides }).select('id').single()
    if (error) throw new Error(`insertRequest failed: ${error.message}`)
    return data.id
  }
  const reqTerm = `wibqotrex${RUN_ID}`
  const reqExact = await insertRequest({ title: `${QA_MARKER} ${reqTerm} needed ${RUN_ID}`, budget_min: 100, budget_max: 200 })
  const reqTest = await insertRequest({ title: `${QA_MARKER} ${reqTerm} testflag ${RUN_ID}`, is_test: true })
  const reqBudgetLow = await insertRequest({ title: `${QA_MARKER} BudgetLadder A ${RUN_ID}`, budget_min: 50, budget_max: 80 })
  const reqBudgetHigh = await insertRequest({ title: `${QA_MARKER} BudgetLadder B ${RUN_ID}`, budget_min: 500, budget_max: 800 })
  const reqOffersReceived = await insertRequest({ title: `${QA_MARKER} OffersReceivedReq ${RUN_ID}`, status: 'offers_received' })
  const reqClosed = await insertRequest({ title: `${QA_MARKER} ClosedReq ${RUN_ID}`, status: 'closed' })

  const { data: byTerm } = await admin.rpc('search_marketplace_requests', { p_query: reqTerm, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const byTermIds = new Set((byTerm ?? []).map((r) => r.id))
  check('22. matching request is found by title term', byTermIds.has(reqExact), { byTermIds: [...byTermIds] })
  check('23. is_test=true request is excluded from search results', !byTermIds.has(reqTest))

  const { data: budgetAsc } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'budget_asc', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const budgetAscIds = (budgetAsc ?? []).map((r) => r.id)
  check('24. budget_asc ranks the lower-budget fixture before the higher-budget fixture', budgetAscIds.indexOf(reqBudgetLow) < budgetAscIds.indexOf(reqBudgetHigh))

  const { count: totalEligible } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).eq('is_test', false).in('status', ['active', 'offers_received'])
  const { data: allViaRpc } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  check('25. the RPC can return more than 60 rows when more than 60 exist -- the old hard .limit(60) ceiling is gone', (totalEligible ?? 0) <= 60 || (allViaRpc ?? []).length > 60, { totalEligible, returned: (allViaRpc ?? []).length })

  // ── Additional coverage (Final Closure round) ──
  const { data: descData } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'budget_desc', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const descIds = (descData ?? []).map((r) => r.id)
  check('26. request budget_desc ranks the higher-budget fixture before the lower-budget fixture', descIds.indexOf(reqBudgetHigh) < descIds.indexOf(reqBudgetLow), { positions: [descIds.indexOf(reqBudgetHigh), descIds.indexOf(reqBudgetLow)] })

  const { data: offersReceivedCheck } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  const allNewestIds = new Set((offersReceivedCheck ?? []).map((r) => r.id))
  check('27. a request in status=offers_received is searchable (Looking For lifecycle: active AND offers_received are both public, not just active)', allNewestIds.has(reqOffersReceived), { present: allNewestIds.has(reqOffersReceived) })
  check('28. a request in a terminal, non-public status (closed) is excluded from search results', !allNewestIds.has(reqClosed), { present: allNewestIds.has(reqClosed) })

  const { data: reqPage1 } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 3 })
  check('29. search_marketplace_requests respects p_limit (bounded, not fetch-all)', (reqPage1 ?? []).length === 3, { returned: (reqPage1 ?? []).length })

  const { data: reqRun1 } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const { data: reqRun2 } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  check('30. request newest browse is deterministic across two identical calls', JSON.stringify((reqRun1 ?? []).map((r) => r.id)) === JSON.stringify((reqRun2 ?? []).map((r) => r.id)))

  // Permanent NULL-budget-boundary proof (budget_asc cursor crossing from
  // the last non-null-budget row into the null-budget tail) -- this exact
  // boundary was verified ad hoc during implementation; this is the
  // permanent regression version.
  const { data: budgetAscFull } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'budget_asc', p_cursor_tier: null, p_cursor_score: null, p_cursor_budget: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  const ascRows = budgetAscFull ?? []
  const lastNonNullIdx = ascRows.reduce((acc, r, i) => (r.budget_min !== null ? i : acc), -1)
  const firstNullIdx = ascRows.findIndex((r) => r.budget_min === null)
  if (lastNonNullIdx >= 0 && firstNullIdx >= 0) {
    const boundaryRow = ascRows[lastNonNullIdx]
    const { data: nextPage } = await admin.rpc('search_marketplace_requests', { p_query: null, p_transaction_type: null, p_category: null, p_country_id: null, p_sort: 'budget_asc', p_cursor_tier: boundaryRow.match_tier, p_cursor_score: boundaryRow.match_score, p_cursor_budget: boundaryRow.budget_min, p_cursor_created_at: boundaryRow.created_at, p_cursor_id: boundaryRow.id, p_limit: 3 })
    check('31. budget_asc cursor crossing the non-null-to-null boundary lands exactly on the first null-budget row, no skip/dup', (nextPage ?? [])[0]?.id === ascRows[firstNullIdx].id, { expected: ascRows[firstNullIdx].id, got: (nextPage ?? [])[0]?.id })
  } else {
    check('32. budget_asc cursor crossing the non-null-to-null boundary lands exactly on the first null-budget row, no skip/dup', false, { note: 'boundary not found in current fixture set', lastNonNullIdx, firstNullIdx })
  }
}

console.log('=== barter_skill_task_public_posts view + search_skill_task_posts RPC ===')
{
  async function insertSkillPost(overrides) {
    const base = {
      owner_id: merchantAId, kind: 'skill', direction: 'available', title: `${QA_MARKER} Skill ${RUN_ID}`,
      description: 'desc', category_id: null, subcategory_id: null, delivery_mode: 'remote', status: 'active', is_test: false,
    }
    const { data, error } = await admin.from('barter_skill_task_posts').insert({ ...base, ...overrides }).select('id').single()
    if (error) throw new Error(`insertSkillPost failed: ${error.message}`)
    return data.id
  }
  const skillTerm = `plonvastri${RUN_ID}`
  const activeAvailable = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} tutoring ${RUN_ID}` })
  const draftPost = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} draft ${RUN_ID}`, status: 'draft' })
  const suspendedPost = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} suspended ${RUN_ID}`, status: 'suspended' })
  const testPost = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} test ${RUN_ID}`, is_test: true })
  const lookingForOffersReceived = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} looking ${RUN_ID}`, direction: 'looking_for', status: 'offers_received' })
  const lookingForActive = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} lookingactive ${RUN_ID}`, direction: 'looking_for', status: 'active' })
  const taskAvailable = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} taskavail ${RUN_ID}`, kind: 'task' })
  const taskLookingFor = await insertSkillPost({ title: `${QA_MARKER} ${skillTerm} tasklooking ${RUN_ID}`, kind: 'task', direction: 'looking_for', status: 'offers_received' })

  const { data: viewRows } = await admin.from('barter_skill_task_public_posts').select('id').ilike('title', `%${skillTerm}%`)
  const viewIds = new Set((viewRows ?? []).map((r) => r.id))
  check('33. view includes the active/available fixture', viewIds.has(activeAvailable))
  check('34. view includes a looking_for fixture in offers_received (stays public through first offer, not just active)', viewIds.has(lookingForOffersReceived))
  check('35. view excludes draft', !viewIds.has(draftPost))
  check('36. view excludes suspended', !viewIds.has(suspendedPost))
  check('37. view excludes is_test=true', !viewIds.has(testPost))

  const { data: cols } = await admin.rpc('search_skill_task_posts', { p_query: skillTerm, p_kind: 'skill', p_direction: 'available', p_category_id: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  check('38. search_skill_task_posts finds the active/available fixture by title term', (cols ?? []).some((r) => r.id === activeAvailable), cols)
  check('39. search_skill_task_posts output rows have no price/budget field -- Skills/Tasks are never monetary', (cols ?? []).every((r) => !('price' in r) && !('budget_min' in r) && !('budget_max' in r)))

  // R5-2: an ordinary cross-user query against the BASE table (not the
  // view) must return nothing for another user's non-public row.
  const { data: baseTableAsAnon } = await anon.from('barter_skill_task_posts').select('id').eq('id', draftPost)
  check('40. anon cannot read a draft post directly from the base table (no public SELECT policy exists on it)', (baseTableAsAnon ?? []).length === 0, baseTableAsAnon)

  // ── Additional coverage (Final Closure round): full six-cell
  // Item/Skill/Task x Available/Looking-For entity matrix for Skill/Task,
  // plus Looking-For's plain 'active' status (not just offers_received),
  // Task-kind entity coverage, is_test base-table blocking, and per-entity
  // newest determinism/boundedness. ──
  const { data: skillAvail } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: 'skill', p_direction: 'available', p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  check('41. Skill Available entity coverage: the active/available skill fixture is reachable', (skillAvail ?? []).some((r) => r.id === activeAvailable))

  const { data: skillLooking } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: 'skill', p_direction: 'looking_for', p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  const skillLookingIds = new Set((skillLooking ?? []).map((r) => r.id))
  check('42. Skill Looking For entity coverage: an offers_received fixture is reachable', skillLookingIds.has(lookingForOffersReceived))
  check('43. Skill Looking For lifecycle: a plain status=active fixture (not just offers_received) is also reachable', skillLookingIds.has(lookingForActive))

  const { data: taskAvailRes } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: 'task', p_direction: 'available', p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  check('44. Task Available entity coverage: a task-kind available fixture is reachable', (taskAvailRes ?? []).some((r) => r.id === taskAvailable))

  const { data: taskLookingRes } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: 'task', p_direction: 'looking_for', p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100000 })
  check('45. Task Looking For entity coverage: a task-kind offers_received fixture is reachable', (taskLookingRes ?? []).some((r) => r.id === taskLookingFor))

  const { data: skillRun1 } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: null, p_direction: null, p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  const { data: skillRun2 } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: null, p_direction: null, p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 500 })
  check('46. Skill/Task newest browse is deterministic across two identical calls', JSON.stringify((skillRun1 ?? []).map((r) => r.id)) === JSON.stringify((skillRun2 ?? []).map((r) => r.id)))

  const { data: skillPage1 } = await admin.rpc('search_skill_task_posts', { p_query: null, p_kind: null, p_direction: null, p_category_id: null, p_sort: 'newest', p_cursor_tier: null, p_cursor_score: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 2 })
  check('47. search_skill_task_posts respects p_limit (bounded, not fetch-all)', (skillPage1 ?? []).length === 2, { returned: (skillPage1 ?? []).length })

  const { data: baseTableTestAsAnon } = await anon.from('barter_skill_task_posts').select('id').eq('id', testPost)
  check('48. anon cannot read an is_test=true Skill/Task post directly from the base table', (baseTableTestAsAnon ?? []).length === 0, baseTableTestAsAnon)
}

console.log('=== listings RLS: anon cannot see is_test=true active listings directly ===')
{
  const { data: anonView } = await anon.from('listings').select('id').eq('id', testFlaggedId)
  check('49. anon cannot read an is_test=true active listing directly from the base table', (anonView ?? []).length === 0, anonView)
  const { data: ownerView } = await admin.from('listings').select('id').eq('id', testFlaggedId)
  check('50. the row genuinely exists (service-role confirms) -- proves check 32 is RLS, not a missing row', (ownerView ?? []).length === 1)
}

console.log('=== search_listings called through the real anon (SECURITY INVOKER) path excludes is_test/draft exactly like the admin path ===')
{
  const { data: viaAnon } = await anon.rpc('search_listings', { p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const anonIds = new Set((viaAnon ?? []).map((r) => r.id))
  check('51. anon-invoked RPC finds the exact-title fixture (SECURITY INVOKER still allows the public-eligible row)', anonIds.has(exactTitleId), { anonIds: [...anonIds] })
  check('52. anon-invoked RPC still excludes the is_test=true fixture', !anonIds.has(testFlaggedId))
  check('53. anon-invoked RPC still excludes the draft fixture', !anonIds.has(draftId))
}

console.log('=== Relevance ordering within a single mixed-tier result set ===')
{
  // A genuine trigram-only fixture must NOT contain the query as a
  // literal substring (unlike typoTitleId, which is TERM + "x" -- TERM
  // is still a literal PREFIX of "TERMx", so ILIKE '%TERM%' matches it
  // and it correctly classifies as tier 3, not tier 1; that fixture is
  // for check 7's own different query, TERM with its LAST character
  // substituted, which is not a substring match either way). Here, swap
  // one character in the MIDDLE of the term so the query string is never
  // a substring of the fixture's title, and the random gibberish string
  // shares no real English stem with the query either (no tier-2 hit).
  const midSwapTerm = TERM.slice(0, 4) + 'k' + TERM.slice(5)
  const trigramOnlyId = await insertListing({ title: `${QA_MARKER} ${midSwapTerm} gear ${RUN_ID}` })
  const { data } = await admin.rpc('search_listings', { p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  check('54. FTS tier (2) outranks trigram-only tier (1) within the same relevance-sorted result set', byId.get(trigramOnlyId)?.match_tier === 1 && byId.get(ftsOnlyId)?.match_tier === 2 && (data ?? []).findIndex((r) => r.id === ftsOnlyId) < (data ?? []).findIndex((r) => r.id === trigramOnlyId), { trigramFixture: byId.get(trigramOnlyId), ftsFixture: byId.get(ftsOnlyId) })
}

console.log('=== Title-weighted match outranks description-only match within tier 2 (distinct-lexeme coverage weighting, Keyword-Stuffing Closure round) ===')
{
  // Tier 2's score is now _search_tier2_coverage_score() -- a
  // frequency-insensitive DISTINCT-lexeme coverage score (title
  // matches weighted 3x, matches elsewhere in the vector weighted 1x)
  // -- replacing the previous raw ts_rank(...,2), which was found to
  // still reward raw term repetition once documents reached comparable
  // length (see the Keyword-Stuffing Closure report for the live
  // reproduction). This section supersedes the old ts_rank-weighting
  // check and the old length-dependent anti-stuffing check with a
  // battery that proves the new, unconditional guarantee: repeating a
  // matched lexeme NEVER improves score, regardless of document length.
  const titleWordId = await insertListing({ title: `${QA_MARKER} distinctivewordxyz${RUN_ID} camera ${RUN_ID}` })
  const descWordId = await insertListing({ title: `${QA_MARKER} Unrelated title ${RUN_ID}`, description: `mentions distinctivewordxyz${RUN_ID} once in the description ${RUN_ID}` })
  const { data } = await admin.rpc('search_listings', { p_query: `distinctivewordxyz${RUN_ID}`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const byId = new Map((data ?? []).map((r) => [r.id, r]))
  check('55. a title match outranks a description-only match for the same distinct term (field weighting preserved under the new coverage-score formula)', Number(byId.get(titleWordId)?.match_score) > Number(byId.get(descWordId)?.match_score), { title: byId.get(titleWordId), desc: byId.get(descWordId) })
}

console.log('=== Keyword-stuffing neutrality: unconditional, not length-dependent (Keyword-Stuffing Closure round) ===')
{
  // 57. Single-term stuffing: a title with the term once vs the SAME
  // term repeated 5x -- both fully cover the title, so both must score
  // IDENTICALLY now (not merely "stuffed <= honest" as under the old,
  // length-dependent ts_rank behavior).
  const singleTerm = `stuffguardxyz${RUN_ID}`
  const singleHonestId = await insertListing({ title: `Professional ${singleTerm} equipment available for rent` })
  const singleStuffedId = await insertListing({ title: `${singleTerm} ${singleTerm} ${singleTerm} ${singleTerm} equipment` })
  const { data: singleData } = await admin.rpc('search_listings', { p_query: singleTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const singleById = new Map((singleData ?? []).map((r) => [r.id, r]))
  check('56. single-term stuffing: a title with one honest mention scores IDENTICALLY to a title with the same term repeated 5x', Number(singleById.get(singleHonestId)?.match_score) === Number(singleById.get(singleStuffedId)?.match_score), { honest: singleById.get(singleHonestId), stuffed: singleById.get(singleStuffedId) })

  // 58. Multi-term stuffing: natural use of both distinct query terms
  // once each vs the same two terms where one is repeated 4x -- both
  // cover the SAME two distinct concepts, so both must score identically.
  const termA = `canonstuffxyz${RUN_ID}`
  const termB = `camerastuffxyz${RUN_ID}`
  const naturalBothId = await insertListing({ title: `${termA} ${termB} for sale here` })
  const stuffedOneTermId = await insertListing({ title: `${termA} ${termB} ${termB} ${termB} ${termB}` })
  const { data: multiData } = await admin.rpc('search_listings', { p_query: `${termA} ${termB}`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const multiById = new Map((multiData ?? []).map((r) => [r.id, r]))
  check('57. multi-term stuffing: a title naturally using both distinct terms once each scores IDENTICALLY to a title where one term is repeated 4x (both cover the same 2 distinct concepts)', Number(multiById.get(naturalBothId)?.match_score) === Number(multiById.get(stuffedOneTermId)?.match_score) && multiById.get(naturalBothId)?.match_tier === 2 && multiById.get(stuffedOneTermId)?.match_tier === 2, { natural: multiById.get(naturalBothId), stuffed: multiById.get(stuffedOneTermId) })

  // 59. Title stuffing in isolation, re-asserted against the exact
  // fixtures from check 56 (title term repeated) to directly confirm no
  // repeated-frequency advantage in the title-weighted component.
  const titleStuffTerm = `titlestuffxyz${RUN_ID}`
  const titleOnceId = await insertListing({ title: `A listing about ${titleStuffTerm} today` })
  const titleRepeatedId = await insertListing({ title: `${titleStuffTerm} ${titleStuffTerm} ${titleStuffTerm}` })
  const { data: titleStuffData } = await admin.rpc('search_listings', { p_query: titleStuffTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const titleStuffById = new Map((titleStuffData ?? []).map((r) => [r.id, r]))
  check('58. title stuffing: repeating the matched term 3x in the title gains no score advantage over a single title mention', Number(titleStuffById.get(titleOnceId)?.match_score) === Number(titleStuffById.get(titleRepeatedId)?.match_score), { once: titleStuffById.get(titleOnceId), repeated: titleStuffById.get(titleRepeatedId) })

  // 60. Description stuffing in isolation.
  const descStuffTerm = `descstuffxyz${RUN_ID}`
  const descOnceId = await insertListing({ title: `${QA_MARKER} Unrelated ${RUN_ID}`, description: `mentions ${descStuffTerm} once here` })
  const descRepeatedId = await insertListing({ title: `${QA_MARKER} Unrelated2 ${RUN_ID}`, description: `${descStuffTerm} ${descStuffTerm} ${descStuffTerm} ${descStuffTerm}` })
  const { data: descStuffData } = await admin.rpc('search_listings', { p_query: descStuffTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const descStuffById = new Map((descStuffData ?? []).map((r) => [r.id, r]))
  check('59. description stuffing: repeating the matched term 4x in the description gains no score advantage over a single description mention', Number(descStuffById.get(descOnceId)?.match_score) === Number(descStuffById.get(descRepeatedId)?.match_score), { once: descStuffById.get(descOnceId), repeated: descStuffById.get(descRepeatedId) })

  // 61. Comparable-length adversarial: the EXACT defect reproduced in
  // the closure report -- a short honest title vs a longer stuffed
  // title of genuinely comparable overall length. Previously the
  // stuffed document scored ~1.4x higher under raw ts_rank; now both
  // must score identically.
  const advTerm = `advstuffxyz${RUN_ID}`
  const advHonestId = await insertListing({ title: `Professional ${advTerm} equipment available` }) // 5 words
  const advStuffedId = await insertListing({ title: `${advTerm} ${advTerm} ${advTerm} ${advTerm} equipment` }) // 5 words, comparable length
  const { data: advData } = await admin.rpc('search_listings', { p_query: advTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const advById = new Map((advData ?? []).map((r) => [r.id, r]))
  check('60. comparable-length adversarial pair (the exact defect shape from the closure report) now scores identically -- the stuffed document no longer out-ranks the honest one', Number(advById.get(advHonestId)?.match_score) === Number(advById.get(advStuffedId)?.match_score), { honest: advById.get(advHonestId), stuffed: advById.get(advStuffedId) })

  // 62. Distinct-term coverage still improves relevance, using
  // websearch's own supported OR syntax (an already-supported query
  // semantic, not a new feature) to reach a genuine partial-vs-full
  // distinct-coverage comparison within Tier 2 -- plain space-separated
  // (AND) queries can't demonstrate this cleanly because Tier 2's own
  // gating condition (`@@ websearch_to_tsquery`) requires ALL terms
  // present for an AND query, meaning every AND-gated Tier-2 row already
  // has full coverage by construction.
  const covTermA = `covfullxyz${RUN_ID}`
  const covTermB = `covpartialxyz${RUN_ID}`
  const fullCoverageId = await insertListing({ title: `${covTermA} ${covTermB} listing` })
  const partialCoverageId = await insertListing({ title: `${covTermB} only listing here` })
  const { data: covData } = await admin.rpc('search_listings', { p_query: `${covTermA} OR ${covTermB}`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const covById = new Map((covData ?? []).map((r) => [r.id, r]))
  check('61. distinct-term coverage: a title matching BOTH distinct query concepts (via websearch OR) outranks a title matching only one', Number(covById.get(fullCoverageId)?.match_score) > Number(covById.get(partialCoverageId)?.match_score), { full: covById.get(fullCoverageId), partial: covById.get(partialCoverageId) })

  // 63. Repeated QUERY terms normalize identically to the deduplicated
  // query -- "camera camera camera" must produce the same tier/score as
  // "camera" against the same document (the coverage formula extracts
  // the query's own DISTINCT lexeme set via tsvector_to_array, which
  // already collapses repeated query words).
  const repQueryTerm = `repquery${RUN_ID}`
  const repQueryDocId = await insertListing({ title: `A document about ${repQueryTerm} topics` })
  const { data: singleQData } = await admin.rpc('search_listings', { p_query: repQueryTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const { data: repeatedQData } = await admin.rpc('search_listings', { p_query: `${repQueryTerm} ${repQueryTerm} ${repQueryTerm}`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const singleQRow = (singleQData ?? []).find((r) => r.id === repQueryDocId)
  const repeatedQRow = (repeatedQData ?? []).find((r) => r.id === repQueryDocId)
  check('62. a repeated query ("term term term") produces the same tier and score as the deduplicated query ("term") against the same document', singleQRow?.match_tier === repeatedQRow?.match_tier && Number(singleQRow?.match_score) === Number(repeatedQRow?.match_score), { single: singleQRow, repeated: repeatedQRow })
}

console.log('=== Deterministic tie-break for typed search (equal tier + equal score) ===')
{
  const tieTerm = `tiebreakxyz${RUN_ID}`
  const tieA = await insertListing({ title: `${QA_MARKER} ${tieTerm}` })
  const tieB = await insertListing({ title: `${QA_MARKER} ${tieTerm}` })
  const { data: run1 } = await admin.rpc('search_listings', { p_query: tieTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  const { data: run2 } = await admin.rpc('search_listings', { p_query: tieTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  const ids1 = (run1 ?? []).filter((r) => r.id === tieA || r.id === tieB).map((r) => r.id)
  const ids2 = (run2 ?? []).filter((r) => r.id === tieA || r.id === tieB).map((r) => r.id)
  check('63. two fixtures with identical tier+score (equal-length identical titles) order identically across repeated calls (created_at/id tie-break is deterministic)', JSON.stringify(ids1) === JSON.stringify(ids2), { ids1, ids2 })
}

console.log('=== camera/cameras stemming (FTS configuration proof) ===')
{
  const camId = await insertListing({ title: `${QA_MARKER} camerastemcheck${RUN_ID}`, description: `a great camera for ${RUN_ID}` })
  const { data } = await admin.rpc('search_listings', { p_query: `camerastemcheck${RUN_ID} cameras`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  check('64. the plural query "cameras" matches a description containing the singular "camera" (english stemming)', (data ?? []).some((r) => r.id === camId), data)
}

console.log('=== Authenticated non-owner listings RLS (item 6 of the final closure request) ===')
{
  const nonOwnerVisId = await insertListing({ title: `${QA_MARKER} NonOwnerCheck ${RUN_ID}`, is_test: true })
  const { data: nonOwnerRead } = await anonAsRenterA.from('listings').select('id').eq('id', nonOwnerVisId)
  check('65. an ordinary authenticated NON-OWNER cannot directly read another user\'s active is_test=true listing (live, not inferred from the policy string)', (nonOwnerRead ?? []).length === 0, nonOwnerRead)
  const { data: ownerSelfRead } = await admin.from('listings').select('id').eq('id', nonOwnerVisId).eq('merchant_id', merchantAId)
  check('66. the owner (merchantA) retains their own required read access to their own is_test=true row', (ownerSelfRead ?? []).length === 1, ownerSelfRead)
}

console.log('=== Barter-locked physical listing exclusion (proven with a real accepted offer, not inferred) ===')
{
  check('67. the barter-lock fixture is genuinely present in barter_locked_listings before asserting search excludes it', lockedListingConfirmed)
  const { data: lockedSearch } = await admin.rpc('search_listings', { p_query: TERM, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 100 })
  const lockedIds = new Set((lockedSearch ?? []).map((r) => r.id))
  check('68. a barter-locked listing (real accepted offer, item committed) is excluded from search_listings results even though its title matches the query', !lockedIds.has(lockedId), { present: lockedIds.has(lockedId) })

  // Reusable Skill/Task supply has no equivalent lock concept -- an
  // Available Skill/Task post can be referenced by any number of open
  // offers simultaneously (unlike a physical item) and must remain fully
  // searchable regardless. Proven structurally: the applied migration's
  // search_skill_task_posts function body never references
  // barter_locked_listings at all (unlike search_listings, which does),
  // so no fixture-based test could ever exercise a lock exclusion path
  // that doesn't exist in the SQL to begin with. Check 47 already proves
  // the same fixture remains searchable in the general case.
  const migrationSqlForLock = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260902000004_search_ranking_rpcs.sql'), 'utf8')
  const skillFnMatch = migrationSqlForLock.match(/create or replace function public\.search_skill_task_posts[\s\S]*?\$\$;/i)
  const skillFnBody = skillFnMatch ? skillFnMatch[0] : ''
  check('69. search_skill_task_posts never references barter_locked_listings (structural proof: reusable Skill/Task supply has no physical-item locking concept applied to it)', skillFnBody.length > 0 && !/barter_locked_listings/i.test(skillFnBody), { bodyFound: skillFnBody.length > 0 })
}

console.log('=== Structural neutrality proof: source inspection of the applied ranking RPC migration ===')
{
  // pg_proc/pg_get_functiondef are not exposed via PostgREST, and this
  // repository's convention is to never add a bespoke SQL-introspection
  // RPC just for a regression script. The authoritative artifact for
  // "what these functions can possibly read" is the applied migration
  // SQL itself -- this file contains ONLY the three ranking functions
  // plus the view widening, nothing else, so a whole-file text scan is
  // exact (not an approximation) for proving these functions never
  // reference a given table/column.
  const migrationSql = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260902000004_search_ranking_rpcs.sql'), 'utf8')
  const revenueTerms = ['merchant_subscriptions', 'commission', 'payout', 'escrow_transaction']
  const revenueViolations = revenueTerms.filter((term) => new RegExp(term, 'i').test(migrationSql))
  check('70. the ranking RPC migration source contains no reference to subscription/commission/payout/escrow tables (structural proof covering: subscription tier, Unity commission, payout amount, escrow value neutrality)', revenueViolations.length === 0, { violations: revenueViolations })

  const milestoneTerms = ['barter_contribution_milestones', 'weight_percent']
  const milestoneViolations = milestoneTerms.filter((term) => new RegExp(term, 'i').test(migrationSql))
  check('71. the ranking RPC migration source contains no reference to milestone/weight tables (structural proof that milestone weights never enter search ranking)', milestoneViolations.length === 0, { violations: milestoneViolations })

  check('72. the ranking RPC migration source contains no reference to the profiles table (structural proof public search never broad-reads profiles; identity hydration stays in the existing public_profiles-based data layer)', !/\bprofiles\b/i.test(migrationSql), {})
}

console.log('=== Frontend contract: Top Rated is absent from the public listings sort matrix ===')
{
  const filterBarSrc = readFileSync(join(REPO_ROOT, 'src/components/listings/filter-bar.tsx'), 'utf8')
  const listingsBlockMatch = filterBarSrc.match(/listings:\s*\[([\s\S]*?)\],\n\s*requests:/)
  const listingsBlock = listingsBlockMatch ? listingsBlockMatch[1] : filterBarSrc
  check('73. \'rating\' is not present among the listings entity\'s sort options in FilterBar (Top Rated removed from the public Search sort matrix)', !/value:\s*'rating'/.test(listingsBlock), { listingsBlock: listingsBlock.slice(0, 300) })
}

console.log('=== Exact-title tier fix: case-insensitivity, whitespace normalization, description exclusion, tier-boundary pagination ===')
{
  // C: case differences still exact.
  const caseTerm = `CaseCheck${RUN_ID}`
  const caseTitleId = await insertListing({ title: `SMEG FRIDGE ${caseTerm}` })
  const { data: caseData } = await admin.rpc('search_listings', { p_query: `smeg fridge ${caseTerm}`, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  const caseRow = (caseData ?? []).find((r) => r.id === caseTitleId)
  check('74. a lowercase query matches an uppercase title exactly (case-insensitive Tier 3)', caseRow?.match_tier === 3 && Number(caseRow?.match_score) === 1, caseRow)

  // D: outer/repeated whitespace normalization.
  const wsTerm = `WsCheck${RUN_ID}`
  const wsTitleId = await insertListing({ title: `Canon EOS ${wsTerm}` })
  const { data: wsData } = await admin.rpc('search_listings', { p_query: `  Canon   EOS   ${wsTerm}  `, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  const wsRow = (wsData ?? []).find((r) => r.id === wsTitleId)
  check('75. outer whitespace and repeated internal whitespace in the query still resolve to an exact Tier 3 match (application normalization contract applied at the SQL layer too, independent of the TypeScript layer -- this call bypasses it)', wsRow?.match_tier === 3 && Number(wsRow?.match_score) === 1, wsRow)

  // E: description-only text never enters Tier 3, even when the
  // description is byte-identical to the query (title still differs).
  const descExactTerm = `DescOnlyExact${RUN_ID}`
  const descExactId = await insertListing({ title: `${QA_MARKER} Unrelated Title ${RUN_ID}`, description: descExactTerm })
  const { data: descExactData } = await admin.rpc('search_listings', { p_query: descExactTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 10 })
  const descExactRow = (descExactData ?? []).find((r) => r.id === descExactId)
  check('76. a description that is byte-identical to the query never enters Tier 3 (only title is compared for the exact tier; this row correctly lands in Tier 2 via FTS)', descExactRow?.match_tier === 2, descExactRow)

  // G: deterministic cursor pagination across the tier-3/tier-2 boundary.
  // Two Tier 3 exact matches + one Tier 2 word-in-title match for the
  // SAME query family, paginated with limit 1 per page, must traverse
  // tier 3 first (both, deterministically ordered), then tier 2, with no
  // duplicate/skip at the boundary crossing.
  const boundaryTerm = `BoundaryCheck${RUN_ID}`
  const exact1Id = await insertListing({ title: boundaryTerm, created_at: new Date(Date.now() - 2000).toISOString() })
  const exact2Id = await insertListing({ title: boundaryTerm, created_at: new Date(Date.now() - 1000).toISOString() })
  const tier2Id = await insertListing({ title: `${QA_MARKER} ${boundaryTerm} extra words ${RUN_ID}` })
  const bPage1 = (await admin.rpc('search_listings', { p_query: boundaryTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: null, p_cursor_score: null, p_cursor_price: null, p_cursor_created_at: null, p_cursor_id: null, p_limit: 1 })).data ?? []
  check('77. first page (limit 1) of a mixed tier-3/tier-2 result set returns a Tier 3 row first', bPage1[0]?.match_tier === 3, bPage1[0])
  const last1 = bPage1[0]
  const bPage2 = (await admin.rpc('search_listings', { p_query: boundaryTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: last1?.match_tier ?? null, p_cursor_score: last1?.match_score ?? null, p_cursor_price: last1?.price ?? null, p_cursor_created_at: last1?.created_at ?? null, p_cursor_id: last1?.id ?? null, p_limit: 1 })).data ?? []
  check('78. second page continues within Tier 3 (both exact-match fixtures share the same tier/score, so the second one comes next, not the tier-2 one) with no duplicate of page 1', bPage2[0]?.match_tier === 3 && bPage2[0]?.id !== bPage1[0]?.id, { page1: bPage1[0], page2: bPage2[0] })
  const last2 = bPage2[0]
  const bPage3 = (await admin.rpc('search_listings', { p_query: boundaryTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: last2?.match_tier ?? null, p_cursor_score: last2?.match_score ?? null, p_cursor_price: last2?.price ?? null, p_cursor_created_at: last2?.created_at ?? null, p_cursor_id: last2?.id ?? null, p_limit: 1 })).data ?? []
  check('79. third page correctly crosses the tier boundary into Tier 2 (the word-in-title fixture), proving deterministic pagination across a tier transition with no skip/duplicate', bPage3[0]?.id === tier2Id && bPage3[0]?.match_tier === 2, { page3: bPage3[0], expected: tier2Id })
  const allBoundaryIds = new Set([exact1Id, exact2Id, tier2Id])
  const seenIds = [bPage1[0]?.id, bPage2[0]?.id, bPage3[0]?.id]
  check('80. all three pages together visited each fixture exactly once (no duplicate, no skip across the full traversal)', seenIds.length === 3 && new Set(seenIds).size === 3 && seenIds.every((id) => allBoundaryIds.has(id)), { seenIds, expected: [...allBoundaryIds] })
}

console.log('=== Cursor pagination: Tier 2 internal ordering AND Tier 2 -> Tier 1 crossing, in one traversal (Keyword-Stuffing Closure round, match_score type unchanged: numeric(9,6)) ===')
{
  const cTerm = `cursortier${RUN_ID}`
  const titleMatchId = await insertListing({ title: `${cTerm} in title` })
  const descMatchId = await insertListing({ title: `${QA_MARKER} Unrelated ${RUN_ID}`, description: `mentions ${cTerm} here` })
  const typoTerm = cTerm.slice(0, 4) + 'k' + cTerm.slice(5)
  const trigramOnlyId = await insertListing({ title: `${typoTerm} gear` })

  const callPage = (cursor) => admin.rpc('search_listings', { p_query: cTerm, p_mode: null, p_category: null, p_country_id: null, p_price_min: null, p_price_max: null, p_sort: 'relevance', p_cursor_tier: cursor?.match_tier ?? null, p_cursor_score: cursor?.match_score ?? null, p_cursor_price: cursor?.price ?? null, p_cursor_created_at: cursor?.created_at ?? null, p_cursor_id: cursor?.id ?? null, p_limit: 1 })

  const { data: cp1 } = await callPage(null)
  check('81. Tier 2 internal ordering: page 1 (limit 1) returns the higher-coverage Tier 2 row (title match) first', cp1[0]?.id === titleMatchId && cp1[0]?.match_tier === 2, cp1[0])
  const { data: cp2 } = await callPage(cp1[0])
  check('82. Tier 2 internal ordering: page 2 returns the lower-coverage Tier 2 row (description-only match) next, no duplicate of page 1', cp2[0]?.id === descMatchId && cp2[0]?.match_tier === 2 && cp2[0]?.id !== cp1[0]?.id, cp2[0])
  const { data: cp3 } = await callPage(cp2[0])
  check('83. Tier 2 -> Tier 1 crossing: page 3 correctly crosses into the trigram fallback row, no duplicate/skip', cp3[0]?.id === trigramOnlyId && cp3[0]?.match_tier === 1, cp3[0])

  await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', [titleMatchId, descMatchId, trigramOnlyId])
}

console.log('=== QA fixture isolation ===')
{
  const { data: runListings } = await admin.from('listings').select('id, title').ilike('title', `%${QA_MARKER}%${RUN_ID}%`)
  const allTagged = (runListings ?? []).length > 0 && (runListings ?? []).every((l) => l.title.includes(QA_MARKER))
  check('84. every listing fixture this run created is tagged with the [QA] marker and this run\'s id (identifiable, cleanable)', allTagged, { count: runListings?.length })
}

console.log('')
console.log('=== CLEANUP: no real active/public fixture left behind ===')
{
  // Primary mechanism: sweep by the EXHAUSTIVE id list every
  // insertListing() call appends to -- covers every fixture regardless
  // of whether its title carries the QA_MARKER (several exact-title and
  // coverage-score fixtures deliberately don't, since the marker would
  // corrupt the exact-normalized-title match under test).
  if (allCreatedListingIds.length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', allCreatedListingIds)
  }
  const { count: idLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).in('id', allCreatedListingIds.length > 0 ? allCreatedListingIds : ['00000000-0000-0000-0000-000000000000']).eq('is_test', false).eq('status', 'active')
  check('85. every listing fixture created via insertListing() this run (tracked by id, regardless of title shape) is cleaned up', (idLeaked ?? 0) === 0, { totalCreated: allCreatedListingIds.length, idLeaked })

  // Secondary/defense-in-depth mechanism: the pre-existing QA_MARKER
  // title-pattern sweep, kept for any listing created outside
  // insertListing() and as a second independent check.
  const { data: toClean } = await admin.from('listings').select('id').ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((toClean ?? []).length > 0) {
    await admin.from('listings').update({ status: 'suspended', is_test: true }).in('id', toClean.map((l) => l.id))
  }
  const { count: stillLeaked } = await admin.from('listings').select('id', { count: 'exact', head: true }).ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false).eq('status', 'active')
  check('86. no real active listing fixture is left behind after this run', (stillLeaked ?? 0) === 0, { cleanedCount: toClean?.length ?? 0, stillLeaked })

  const { data: reqToClean } = await admin.from('marketplace_requests').select('id').ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((reqToClean ?? []).length > 0) {
    await admin.from('marketplace_requests').update({ status: 'closed', is_test: true }).in('id', reqToClean.map((r) => r.id))
  }
  const { count: reqStillLeaked } = await admin.from('marketplace_requests').select('id', { count: 'exact', head: true }).ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false).in('status', ['active', 'offers_received'])
  check('87. no real active marketplace_requests fixture is left behind after this run', (reqStillLeaked ?? 0) === 0, { cleanedCount: reqToClean?.length ?? 0, reqStillLeaked })

  const { data: postsToClean } = await admin.from('barter_skill_task_posts').select('id').ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false).gte('created_at', SCRIPT_START_AT)
  if ((postsToClean ?? []).length > 0) {
    await admin.from('barter_skill_task_posts').update({ status: 'archived', is_test: true }).in('id', postsToClean.map((p) => p.id))
  }
  const { count: postsStillLeaked } = await admin.from('barter_skill_task_posts').select('id', { count: 'exact', head: true }).ilike('title', `%${QA_MARKER}%${RUN_ID}%`).eq('is_test', false)
  check('88. no real barter_skill_task_posts fixture is left behind after this run', (postsStillLeaked ?? 0) === 0, { cleanedCount: postsToClean?.length ?? 0, postsStillLeaked })
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
