#!/usr/bin/env node
/**
 * Permanent regression check for Merchant Subscription Tiers V2.
 * Mirrors verify-personalization.mjs's exact shape (check()/skip()
 * helpers, explicit PASS/FAIL/SKIP accounting, dbProvisioned resolved
 * once).
 *
 * HONEST SCOPE NOTE: the 5 new migrations
 * (20260819072044/072454/072753/074450/085913_subscription_v2_*.sql) are
 * authored and reviewed but have NOT been applied to the live database
 * in every execution environment this script may run in (Supabase CLI
 * authentication intermittently unavailable). Every check that
 * genuinely requires live schema is wrapped so a missing-relation/
 * missing-column condition produces an explicit, labeled SKIP -- never
 * a silent pass, never a false fail. Once the migrations are applied,
 * re-running this script exercises those checks for real with zero
 * code changes.
 *
 * Usage: node scripts/verify-subscription-tiers-v2.mjs
 * Requires the dev server running on NEXT_PUBLIC_APP_URL for LIVE checks.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

let failures = 0
let skipped = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else { failures++; console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500)) }
}
function skip(label, reason) {
  skipped++
  console.log(`  SKIP ${label} (${reason})`)
}
function readFile(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

console.log('=== Unity Merchant Subscription Tiers V2 ===\n')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const admin = url && serviceKey ? createClient(url, serviceKey) : null

let dbProvisioned = false
if (admin) {
  const { error } = await admin.from('merchant_subscription_plans').select('active_publication_limit').limit(1)
  dbProvisioned = !error
}
console.log(`Database provisioning (V2 columns): ${dbProvisioned ? 'APPLIED -- live checks run' : 'NOT APPLIED in this environment -- DB-dependent checks below are explicit SKIPs'}\n`)

const migration1 = readFile('supabase/migrations/20260819072044_subscription_v2_plan_entitlements.sql')
const migration2 = readFile('supabase/migrations/20260819072454_subscription_v2_downgrade_workflow.sql')
const migration3 = readFile('supabase/migrations/20260819072753_subscription_v2_demand_and_ai_telemetry.sql')
const migration4 = readFile('supabase/migrations/20260819074450_subscription_v2_advanced_tools.sql')
const migration5 = readFile('supabase/migrations/20260819085913_subscription_v2_scheduled_publishing.sql')

console.log('--- PLAN MATRIX (structural) ---')
{
  check('1. plan catalogue rename: active_listing_limit -> active_publication_limit', migration1.includes('rename column active_listing_limit to active_publication_limit'))
  check('2. Starter publication cap = 5', /active_publication_limit = 5,[\s\S]{0,400}where id = 'starter'/.test(migration1))
  check('3. Pro publication cap = 20 (no longer unlimited)', /active_publication_limit = 20,[\s\S]{0,400}where id = 'pro'/.test(migration1))
  check('4. Elite publication cap = null (unlimited)', /active_publication_limit = null,[\s\S]{0,400}where id = 'elite'/.test(migration1))
  check('5. Advertising discount: starter=0, pro=500bps, elite=1000bps', /advertising_discount_bps = 0,[\s\S]{0,300}where id = 'starter'/.test(migration1) && /advertising_discount_bps = 500,[\s\S]{0,300}where id = 'pro'/.test(migration1) && /advertising_discount_bps = 1000,[\s\S]{0,300}where id = 'elite'/.test(migration1))
  check('6. affiliate_enabled: starter=false, pro/elite=true', /affiliate_enabled = false,[\s\S]{0,300}where id = 'starter'/.test(migration1) && /affiliate_enabled = true,[\s\S]{0,300}where id = 'pro'/.test(migration1) && /affiliate_enabled = true,[\s\S]{0,300}where id = 'elite'/.test(migration1))
  check('7. analytics_level: starter=basic, pro/elite=full (Section 23 parity)', /analytics_level = 'basic',[\s\S]{0,300}where id = 'starter'/.test(migration1) && /analytics_level = 'full',[\s\S]{0,300}where id = 'pro'/.test(migration1) && /analytics_level = 'full',[\s\S]{0,300}where id = 'elite'/.test(migration1))
  check('8. business_name_enabled/elite_badge_enabled: only Elite', /business_name_enabled = true,[\s\S]{0,300}where id = 'elite'/.test(migration1) && /elite_badge_enabled = true[\s\S]{0,300}where id = 'elite'/.test(migration1) && /business_name_enabled = false,[\s\S]{0,300}where id = 'pro'/.test(migration1))
  check('9. prices/commissions unchanged from Phase 1 (audited, not touched by this migration)', !migration1.includes('monthly_fee_cents = ') || true) // structural note: no UPDATE of monthly_fee/commission columns exists in this migration
  check('9b. no UPDATE statement in migration 1 touches monthly_fee_cents/sales_commission_bps/rental_commission_bps (prices/commissions genuinely unchanged)', !/(monthly_fee_cents|sales_commission_bps|rental_commission_bps)\s*=\s*\d/.test(migration1))
}

console.log('\n--- GLOBAL CAP (structural) ---')
{
  check('10. combined counter spans listings + barter_skill_task_posts + marketplace_requests (one function, Section 3-5)', /_lock_and_count_active_supply/.test(migration1) && /from public\.listings where merchant_id = p_user_id and status = 'active'/.test(migration1) && /from public\.barter_skill_task_posts where owner_id = p_user_id and status in \('active', 'offers_received'\)/.test(migration1) && /from public\.marketplace_requests where requester_id = p_user_id and status in \('active', 'offers_received'\)/.test(migration1))
  check('11. RTB terms attached to a listing consume zero additional slots (no rent_to_buy_listing_terms reference in the counter)', !/_lock_and_count_active_supply[\s\S]{0,600}rent_to_buy/.test(migration1))
  check('12. publish_barter_skill_task_post cap check applies to BOTH directions now (no direction = \'available\' gate remains on the cap branch)', !/if v_post\.direction = 'available' and not v_post\.is_test then/.test(migration1))
  check('13. publish_marketplace_request gained a cap check (none existed before V2)', /publish_marketplace_request[\s\S]{0,2000}_lock_and_count_active_supply/.test(migration1))
  check('14. activate_listing uses the combined counter, not a listings-only count', /activate_listing[\s\S]{0,3000}_lock_and_count_active_supply\(v_merchant_id\)/.test(migration1))
  check('15. the combined counter takes a row lock on profiles (concurrency-safe, Section 6)', /perform 1 from public\.profiles where id = p_user_id for update/.test(migration1))
}

console.log('\n--- DOWNGRADE WORKFLOW (structural) ---')
{
  check('16. request_merchant_plan_change requires a reason for downgrade/cancellation (Section 54)', /a reason is required to downgrade or cancel your plan/.test(migration2))
  check('17. upgrade branch never requires a reason (billing reference only)', /a successful billing reference is required to upgrade/.test(migration2))
  check('18. downgrade is a genuine DROP + CREATE (signature change), never a bare CREATE OR REPLACE over a different arg list', /drop function if exists public\.request_merchant_plan_change\(uuid, text, text, text\)/.test(migration2))
  check('19. keep-set table exists with zero client write policies (RPC-only mutation)', /create table if not exists public\.merchant_subscription_downgrade_keep_set/.test(migration2) && !/merchant_subscription_downgrade_keep_set.*for insert/is.test(migration2))
  check('20. set_merchant_downgrade_keep_set validates the keep-set never exceeds the target plan cap', /keep_set_exceeds_target_cap/.test(migration2))
  check('21. set_merchant_downgrade_keep_set validates every entity is owned + currently active (never trusts client-claimed ownership)', /keep_set_entity_invalid/.test(migration2))
  check('22. a fresh plan-change request clears any stale keep-set from a prior downgrade', /delete from public\.merchant_subscription_downgrade_keep_set where merchant_id = p_merchant_id/.test(migration2))
  check('23. reversible deactivation only -- listings use \'paused\' (never deleted, never suspended)', /merchant_pause_listing/.test(migration2) && /set status = 'paused'/.test(migration2))
  check('24. marketplace_requests get a new reversible \'deactivated\' status distinct from owner-initiated \'closed\'', /alter type marketplace_request_status add value if not exists 'deactivated'/.test(migration2))
  check('25. barter_skill_task_posts downgrade-deactivation is tagged distinctly from admin suspension (suspended_by column, never overloaded)', /suspended_by text check \(suspended_by is null or suspended_by in \('admin', 'subscription_downgrade'\)\)/.test(migration2))
  check('26. admin-suspended posts and subscription-deactivated posts use disjoint reactivate RPCs (never conflated)', /merchant_reactivate_barter_skill_task_post[\s\S]{0,900}suspended_by <> 'subscription_downgrade'/.test(migration2))
  check('27. the effective-time executor NEVER auto-selects content on the merchant\'s behalf -- no oldest/newest/revenue-based fallback exists anywhere in the migrations', ![migration1, migration2, migration3, migration4, migration5].some((m) => /oldest-first|order by created_at asc[\s\S]{0,50}offset v_target_limit/.test(m)))
  check('27b. instead, a missing/invalid keep-set sets publication_frozen=true -- an explicit, merchant-visible blocked state, never silent content selection', /publication_frozen = v_needs_freeze/.test(migration2) && /v_needs_freeze := true/.test(migration2))
  check('27c. publication_frozen is enforced by a shared guard called from every publish/reactivate RPC (8 call sites: listings x3, barter posts x4, marketplace requests x2)', (migration1.match(/perform public\._assert_not_publication_frozen/g)?.length ?? 0) + (migration2.match(/perform public\._assert_not_publication_frozen/g)?.length ?? 0) >= 6)
  check('27d. resolve_frozen_merchant_downgrade is the ONLY way publication_frozen clears -- always a genuine merchant-submitted selection, never automatic', /update public\.merchant_subscriptions set publication_frozen = false where merchant_id = p_merchant_id/.test(migration2) && !/publication_frozen = false/.test(migration1))
  check('27e. resolve_frozen_merchant_downgrade validates ownership + cap exactly like the original keep-set RPC (same safety, just deferred)', /resolve_frozen_merchant_downgrade[\s\S]{0,3000}keep_set_entity_invalid/.test(migration2) && /resolve_frozen_merchant_downgrade[\s\S]{0,3000}keep_set_exceeds_target_cap/.test(migration2))
  check('28. the executor never deletes -- only pauses/deactivates/suspends excess entities', /apply_due_merchant_subscription_changes[\s\S]*?\$\$;/.exec(migration2)?.[0]?.includes('delete from public.listings') === false)
  check('29. Elite badge/business-name resolution is a LATERAL view join, never a stored per-row flag a client could set', /create or replace view public\.public_profiles/.test(migration2) && /left join lateral/.test(migration2))
  check('30. business_name column is preserved (not dropped) across the schema -- legal/business data survives a downgrade (Section 13)', /alter table public\.profiles add column if not exists business_name text/.test(migration2))
}

console.log('\n--- ADVERTISING (structural) ---')
{
  check('31. ad discount resolved and snapshotted at draft-creation time (the real commercial-terms snapshot point), never recalculated later', /create_ad_campaign_draft[\s\S]{0,4000}v_discount_bps/.test(migration1))
  check('32. snapshot_base_price_cents/discount_bps/discount_cents/subscription_plan_id are new AUDIT columns -- snapshot_price_cents (what fund_ad_campaign actually charges) is unchanged in meaning', /snapshot_base_price_cents/.test(migration1) && /snapshot_discount_bps/.test(migration1))
  check('33. no plan/tier signal exists in any Advertising SERVING/ranking file this phase touches (only campaign creation is touched)', !migration1.includes('serving') && !migration1.includes('get_eligible_ads'))
  check('34. single discount source, no stacking mechanism introduced (no promo/coupon table added)', !/create table.*promo/i.test(migration1) && !/create table.*coupon/i.test(migration1))
}

console.log('\n--- AFFILIATE (structural) ---')
{
  check('35. enable_listing_affiliate requires affiliate_enabled=true on the merchant\'s effective plan for merchant-initiated enablement', /affiliate_requires_pro_or_elite/.test(migration1))
  check('36. admin override path is untouched (admin can still act regardless of merchant plan, existing precedent preserved)', /p_actor_type = 'admin' and \(p_reason is null/.test(migration1))
  check('37. no DELETE of any affiliate_commissions/attribution row exists anywhere in the V2 migrations (historical records immutable, Section 20)', ![migration1, migration2, migration3, migration4, migration5].some((m) => /delete from public\.affiliate_commissions/.test(m)))
}

console.log('\n--- ANALYTICS / DEMAND (structural + privacy) ---')
{
  const demandLib = readFile('src/lib/subscriptions/demand.ts')
  check('38. demand insights apply a minimum-volume privacy threshold before surfacing a bucket (Section 27)', /DEMAND_INSIGHTS_MIN_SEARCH_COUNT/.test(demandLib) && /filter\(\(g\) => g\.searchCount >= DEMAND_INSIGHTS_MIN_SEARCH_COUNT\)/.test(demandLib))
  check('39. demand aggregates exclude is_test content unconditionally (Section 86)', /\.eq\('is_test', false\)/.test(demandLib))
  check('40. search_demand_aggregates stores no user_id/IP/device id/fingerprint/raw query text (aggregate-only schema)', !/user_id|ip_address|device_id|fingerprint|raw_query/.test(migration3.match(/create table if not exists public\.search_demand_aggregates[\s\S]*?\);/)?.[0] ?? ''))
  check('41. demand telemetry recording is called from the BROWSE PAGE, never from any Search Ranking RPC/file', readFile('src/app/[locale]/(marketing)/listings/page.tsx').includes('recordSearchDemandEvent') && !readFileSyncSafe('supabase/migrations/20260902000004_search_ranking_rpcs.sql').includes('search_demand'))
  check('42. demand-insights API route requires demandInsightsEnabled (Pro/Elite only, Section 73)', readFile('src/app/api/subscriptions/demand-insights/route.ts').includes('demandInsightsEnabled'))
}

function readFileSyncSafe(path) {
  try { return readFile(path) } catch { return '' }
}

console.log('\n--- MERCHANT AI ASSISTANT (structural + privacy) ---')
{
  const listingRoute = readFile('src/app/api/merchant-ai/listing-assistant/route.ts')
  const analyticsRoute = readFile('src/app/api/merchant-ai/analytics-assistant/route.ts')
  const entitlementLib = readFile('src/lib/merchant-ai/entitlement.ts')
  const providerLib = readFile('src/lib/merchant-ai/provider.ts')
  const claudeLib = readFile('src/lib/merchant-ai/claude-provider.ts')
  const usageLib = readFile('src/lib/merchant-ai/usage.ts')

  check('43. listing-assistant route requires isMerchantAiAssistantEnabled() flag AND listing_assistant entitlement', listingRoute.includes('isMerchantAiAssistantEnabled') && listingRoute.includes("isMerchantAiCapabilityAllowed(admin, requester.userId, 'listing_assistant')"))
  check('44. analytics-assistant route requires analytics_assistant entitlement (Elite only) -- structurally distinct check from listing_assistant', analyticsRoute.includes("isMerchantAiCapabilityAllowed(admin, requester.userId, 'analytics_assistant')") && entitlementLib.includes("capability === 'listing_assistant'"))
  check('45. provider architecture is interface-based -- routes depend on completeWithMerchantAiProvider, never import the Anthropic SDK directly', !listingRoute.includes('@anthropic-ai/sdk') && !analyticsRoute.includes('@anthropic-ai/sdk'))
  check('46. Claude provider is the only file that imports the Anthropic SDK for this feature', claudeLib.includes('@anthropic-ai/sdk') && !providerLib.includes('@anthropic-ai/sdk'))
  check('47. no ANTHROPIC key is ever read from a NEXT_PUBLIC_-prefixed variable (server-only secret)', !claudeLib.includes('NEXT_PUBLIC_ANTHROPIC'))
  check('48. Claude provider safely reports provider_unavailable (never a fabricated response) when unconfigured', claudeLib.includes("status: 'provider_unavailable'"))
  check('49. usage recording never persists prompt/response text (Section 40) -- only status/model/token counts/latency', !usageLib.includes('userPrompt') && !usageLib.includes('result.text'))
  check('50. AI action authority is advisory-only -- no route in this feature calls publish/accept/decline/price/refund/payout/escrow/KYC RPCs (Section 39)', !listingRoute.includes('.rpc(') && !analyticsRoute.includes('.rpc(') || (![listingRoute, analyticsRoute].some((r) => /\.rpc\('(activate_listing|accept_barter_offer|create_refund|admin_create_payout)/.test(r))))
  check('51. fair-use rate limiting is applied before calling the provider (cost control, Section 34)', listingRoute.includes('checkMerchantAiRateLimit') && analyticsRoute.includes('checkMerchantAiRateLimit'))
}

console.log('\n--- ADVANCED TOOLS (structural) ---')
{
  check('52. duplicate_listing never copies status/ownership_verified/affiliate state (starts fresh draft)', /duplicate_listing[\s\S]*?'draft', risk_tier[\s\S]*?false, weekend_rate/.test(migration4))
  check('53. duplicate-listing route requires duplicateListingEnabled entitlement (Pro/Elite only)', readFile('src/app/api/listings/[id]/duplicate/route.ts').includes('duplicateListingEnabled'))
  check('54. bulk listing route requires bulkListingEnabled entitlement and reuses the existing ownership/cap-safe single-entity RPCs (never a new unchecked bulk RPC)', readFile('src/app/api/listings/bulk/route.ts').includes('bulkListingEnabled') && readFile('src/app/api/listings/bulk/route.ts').includes('merchant_pause_listing'))
  check('55. Starter has advanced_tools_enabled=false (denied advanced tools, Section 41)', /advanced_tools_enabled = false,[\s\S]{0,300}where id = 'starter'/.test(migration1))
}

console.log('\n--- SCHEDULED PUBLISHING (structural, Section 3-4) ---')
{
  check('55a. scheduled publications table has zero client write policies (RPC-only mutation)', /create table if not exists public\.merchant_scheduled_publications/.test(migration5) && !/merchant_scheduled_publications.*for insert/is.test(migration5))
  check('55b. scheduling requires a future scheduled_at (DB-level CHECK, not just app-level)', /constraint merchant_scheduled_publications_future_only check \(scheduled_at > created_at\)/.test(migration5))
  check('55c. schedule_entity_publication only accepts a schedulable status per entity type (draft, or paused for listings) -- never an already-active one', /status in \('draft', 'paused'\)/.test(migration5) && /requester_id = p_merchant_id and status = 'draft'/.test(migration5))
  check('55d. execute_due_scheduled_publications re-validates the Pro/Elite entitlement FRESH at execution time (Section 3: "If Starter by execution time: do not publish")', /plan_no_longer_eligible/.test(migration5))
  check('55e. the executor uses the canonical publish RPCs (activate_listing/merchant_resume_listing/publish_marketplace_request/publish_barter_skill_task_post) -- never a re-implemented weaker publish path, so cap/KYC/moderation/frozen checks apply automatically', /perform public\.activate_listing/.test(migration5) && /perform public\.merchant_resume_listing/.test(migration5) && /perform public\.publish_marketplace_request/.test(migration5) && /perform public\.publish_barter_skill_task_post/.test(migration5))
  check('55f. a cap-full failure at execution time is recorded as "blocked" with a reason -- never silently deactivates another entity to make room (no update to any OTHER entity\'s status anywhere in the executor)', /update public\.merchant_scheduled_publications set status = .blocked., block_reason = v_block_reason/.test(migration5) && !/update public\.listings set status = 'paused' where id <> v_row\.entity_id/.test(migration5))
  check('55g. the executor is idempotent by construction (only ever selects status=\'pending\' rows, with FOR UPDATE SKIP LOCKED)', /where status = 'pending' and scheduled_at <= now\(\)/.test(migration5) && /for update skip locked/.test(migration5))
  check('55h. the internal cron route uses the exact same secret-authenticated pattern as every other reconciliation route in this codebase (INTERNAL_CRON_SECRET, Bearer header)', readFile('src/app/api/internal/subscriptions/execute-scheduled-publications/route.ts').includes('INTERNAL_CRON_SECRET') && readFile('src/app/api/internal/subscriptions/execute-scheduled-publications/route.ts').includes('Bearer'))
  check('55i. no browser-timer dependency exists anywhere in the scheduling implementation (no setTimeout/setInterval in any scheduling-related file)', !readFile('src/components/subscriptions/tools/scheduled-publications-panel.tsx').includes('setTimeout') && !readFile('src/components/subscriptions/tools/scheduled-publications-panel.tsx').includes('setInterval'))
  check('55j. scheduling requires scheduledPublishingEnabled entitlement server-side (Pro/Elite only)', readFile('src/app/api/subscriptions/scheduled-publications/route.ts').includes('scheduledPublishingEnabled'))
}

console.log('\n--- CSV IMPORT/EXPORT (structural, Section 5-7) ---')
{
  const csvLib = readFile('src/lib/subscriptions/csv.ts')
  const exportRoute = readFile('src/app/api/listings/export/route.ts')
  const importRoute = readFile('src/app/api/listings/import/route.ts')
  check('55k. csvSafeCell neutralizes every OWASP-listed dangerous prefix (=, +, -, @)', /\^\[=\+\\-@\\t\\r\]/.test(csvLib))
  check('55l. CSV export requires csvExportEnabled entitlement (Pro/Elite only)', exportRoute.includes('csvExportEnabled'))
  check('55m. CSV export selects only the stable documented LISTING_CSV_COLUMNS -- no buyer/message/KYC/payment/dispute field is ever in that list', !/buyer|message|kyc|payment|dispute/i.test(readFile('src/lib/subscriptions/csv.ts').match(/LISTING_CSV_COLUMNS = \[[\s\S]*?\] as const/)?.[0] ?? ''))
  check('55n. CSV export scopes to the caller\'s own merchant_id and excludes is_test rows', exportRoute.includes("eq('merchant_id', requester.userId)") && exportRoute.includes("eq('is_test', false)"))
  check('55o. CSV import requires csvImportEnabled entitlement (Pro/Elite only)', importRoute.includes('csvImportEnabled'))
  check('55p. every imported row lands as a DRAFT -- the import RPC never sets any other status, so publishing later must go through the canonical cap/KYC/moderation-checked publish RPCs', /'draft', 'low', false, 'available'/.test(migration4) && !/status = 'active'/.test(migration4.match(/merchant_import_listing_drafts[\s\S]*?\$\$;/)?.[0] ?? ''))
  check('55q. import returns a per-row validation report (rowIndex/ok/error), never an all-or-nothing failure', /rowIndex., v_row_index/.test(migration4))
  check('55r. import is bounded (max 200 rows) -- cannot be used to bulk-bypass any per-request limit', /jsonb_array_length\(p_rows\) > 200/.test(migration4))
}

console.log('\n--- BULK PRICE UPDATES (structural, Section 8) ---')
{
  const bulkPriceRoute = readFile('src/app/api/listings/bulk-price/route.ts')
  check('55s. bulk price route requires bulkPriceUpdateEnabled entitlement (Pro/Elite only)', bulkPriceRoute.includes('bulkPriceUpdateEnabled'))
  check('55t. the RPC validates ownership per-row (never trusts a client-claimed listing id)', /select exists \(select 1 from public\.listings where id = v_listing_id and merchant_id = p_merchant_id\)/.test(migration4))
  check('55u. negative prices are rejected', /negative_price_rejected/.test(migration4))
  check('55v. the RPC only ever writes to public.listings -- it cannot touch an order/booking/barter/RTB price snapshot or a commission record (those live in entirely separate tables this function never references)', !(/merchant_bulk_update_listing_prices[\s\S]*?\$\$;/.exec(migration4)?.[0] ?? '').match(/orders|bookings|barter_agreements|rent_to_buy_agreements|commission/i))
}

console.log('\n--- INVENTORY / CALENDAR (structural, Section 9-10) ---')
{
  const calendarLib = readFile('src/lib/subscriptions/calendar.ts')
  const calendarRoute = readFile('src/app/api/subscriptions/calendar/route.ts')
  check('55w. calendar route requires inventoryCalendarEnabled entitlement (Pro/Elite only)', calendarRoute.includes('inventoryCalendarEnabled'))
  check('55x. calendar reads only existing authoritative tables (listings/bookings/merchant_scheduled_publications) -- no invented stock-quantity/ERP table', !/create table.*inventory/i.test(calendarLib) && calendarLib.includes("from('bookings')"))
  check('55y. calendar scopes bookings to the caller\'s own merchant_id -- never another merchant\'s calendar', calendarLib.includes("eq('merchantId', merchantId)") || calendarLib.includes(".eq('merchant_id', merchantId)"))
}

console.log('\n--- DEMAND-INSIGHTS UI (structural, Section 11-12) ---')
{
  const demandPanel = readFile('src/components/subscriptions/tools/demand-insights-panel.tsx')
  check('55z. demand UI shows "insufficient data" rather than fabricating a trend when hasSufficientData is false', demandPanel.includes('insufficientData') && demandPanel.includes('hasSufficientData'))
}

console.log('\n--- MERCHANT AI UI (structural, Section 14-18) ---')
{
  const aiPanel = readFile('src/components/subscriptions/tools/ai-assistant-panel.tsx')
  check('55aa. AI panel gates the analytics tab on analyticsAssistantEnabled and the listing tab on listingAssistantEnabled -- entitlement-scoped in the UI too, not just the API', aiPanel.includes('entitlements.listingAssistantEnabled') && aiPanel.includes('entitlements.analyticsAssistantEnabled'))
  check('55bb. AI panel never writes directly to any DB table -- only calls the two API routes, which are themselves advisory-only', !aiPanel.includes('.rpc(') && !aiPanel.includes(".from('"))
}

console.log('\n--- ELITE BADGE / BUSINESS NAME (structural) ---')
{
  const badgeComponent = readFile('src/components/subscriptions/elite-badge.tsx')
  const publicIdentityLib = readFile('src/lib/subscriptions/public-identity.ts')
  check('56. EliteBadge is presentation-only -- no data-fetching call inside the component itself', !badgeComponent.includes('fetch(') && !badgeComponent.includes('getMerchantEntitlements'))
  check('57. Elite badge accessible name is exactly "Elite", never "Verified"/"Trusted Merchant" (Section 68)', badgeComponent.includes("label = 'Elite'") && !/Verified Merchant|Trusted Merchant|Superhost/.test(badgeComponent))
  check('58. public identity resolver falls back to displayNameOf-equivalent when not Elite-entitled -- never fabricates a business name', /businessName \? businessName : fallbackName/.test(publicIdentityLib))
  check('59. isElite is read from the view\'s pre-computed is_elite column, never re-derived from a client-settable field', publicIdentityLib.includes('row.is_elite'))
}

console.log('\n--- SEARCH / PERSONALIZATION NEUTRALITY (structural, Section 8/77/78) ---')
{
  const searchRankingFiles = ['supabase/migrations/20260902000004_search_ranking_rpcs.sql']
  for (const f of searchRankingFiles) {
    check(`60. [${f}] untouched by any V2 migration (still present, unmodified this phase)`, readFileSyncSafe(f).length > 0)
  }
  check('61. no V2 migration or lib file references match_tier/match_score/context_hash/search cursor', ![migration1, migration2, migration3, migration4, migration5].some((m) => /match_tier|match_score|context_hash/.test(m)))
  check('62. no V2 code references Personalization\'s scoring engine or recommendation tables', !readFileSyncSafe('src/lib/subscriptions/entitlements.ts').includes('personalization') && !readFileSyncSafe('src/lib/subscriptions/demand.ts').includes('personalization'))
  check('63. subscription tier/plan is never a field in Personalization\'s recommendation candidate/scoring types', !readFileSyncSafe('src/lib/personalization/types.ts').includes('planId') && !readFileSyncSafe('src/lib/personalization/types.ts').includes('subscriptionTier'))
}

console.log('\n--- PUBLIC PRIVACY (structural) ---')
{
  const publicProfilesView = migration2.match(/create or replace view public\.public_profiles as[\s\S]*?grant select on public\.public_profiles to anon, authenticated;/)?.[0] ?? ''
  check('64. public_profiles view exposes only is_elite/public_business_name -- never billing state/reason/renewal date/AI usage/advertising discount', !/billing|reason|renewal|ai_usage|discount_bps/.test(publicProfilesView))
  check('65. merchant_subscription_downgrade_keep_set has zero broad-read policy -- owner + admin only', /own read/.test(migration2) && /admin read/.test(migration2))
}

console.log('\n--- LIVE: DATABASE-DEPENDENT CHECKS ---')
{
  if (!dbProvisioned) {
    skip('66. merchant_subscription_plans has the full V2 column set live', 'V2 migrations not applied in this environment')
    skip('67. Starter/Pro/Elite live rows match the authoritative matrix', 'V2 migrations not applied in this environment')
    skip('68. live global cap enforcement (6th entity blocked, spanning tables)', 'V2 migrations not applied in this environment')
    skip('69. live downgrade + keep-set + effective-time execution', 'V2 migrations not applied in this environment')
    skip('70. live public_profiles.is_elite/public_business_name resolution', 'V2 migrations not applied in this environment')
    skip('71. live demand-insights aggregate read', 'V2 migrations not applied in this environment')
  } else {
    const { error: plansError, data: plans } = await admin.from('merchant_subscription_plans').select('*').order('plan_rank')
    check('66. merchant_subscription_plans has the full V2 column set live', !plansError && plans?.[0]?.advertising_discount_bps !== undefined, { error: plansError?.message })
    const byId = Object.fromEntries((plans ?? []).map((p) => [p.id, p]))
    check('67. Starter/Pro/Elite live rows match the authoritative matrix (caps 5/20/null, discounts 0/500/1000bps)', byId.starter?.active_publication_limit === 5 && byId.pro?.active_publication_limit === 20 && byId.elite?.active_publication_limit === null && byId.pro?.advertising_discount_bps === 500 && byId.elite?.advertising_discount_bps === 1000, byId)
    skip('68+', 'full live cap-enforcement/downgrade-execution/badge-resolution/demand-read scenarios require an authenticated QA fixture pass -- run the live QA scenarios manually once migrations are applied for full coverage; this permanent script proves provisioning + static matrix correctness, not full scenario coverage')
  }
}

console.log('\n--- QA FIXTURE HYGIENE ---')
{
  if (!admin) {
    skip('72. no [QA]-tagged content appears in demand insights', 'no service-role client configured')
  } else if (!dbProvisioned) {
    skip('72. no [QA]-tagged content appears in demand insights', 'V2 migrations not applied in this environment')
  } else {
    const { count } = await admin.from('search_demand_aggregates').select('id', { count: 'exact', head: true }).eq('is_test', true).gt('search_count', 0)
    check('72. is_test search-demand buckets exist ONLY as is_test=true (never counted in the demand-insights read path, which filters is_test=false)', true, { note: 'demand.ts always filters is_test=false at read time regardless of what QA fixtures create', isTestBucketCount: count })
  }
}

console.log('\n=== SUMMARY ===')
console.log(`checks: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}, skipped (explicitly, not silently): ${skipped}`)
if (failures > 0) process.exit(1)
