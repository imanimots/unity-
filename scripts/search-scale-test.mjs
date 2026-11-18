#!/usr/bin/env node
/**
 * Platform improvement programme, Phase 2 item 11 (search scalability).
 *
 * NOT YET RUN. This script is the test plan made executable, not a
 * measured result -- per the programme brief's own fallback
 * instruction ("Document limitations when a valid performance
 * environment is unavailable. Do not insert synthetic listings into
 * the live marketplace."), running this against the project this
 * engagement has used throughout (there is no separate staging
 * project) would insert up to 100,000 synthetic rows into the one
 * shared Supabase project -- a live-write action at a scale that
 * needs explicit case-by-case authorization under this project's
 * standing policy, the same policy that gated every other live-write
 * decision across this engagement (QA seeding, RLS negative-access
 * testing, etc.). This script is ready to run the moment that
 * authorization is given, and cleans up everything it creates.
 *
 * What it does, end to end:
 *   1. Inserts N synthetic listings (N from argv, e.g. 1000/10000/
 *      100000), every one tagged is_test = true AND a dedicated
 *      is_test-safe marker title prefix ("ScaleTest-<runToken>-"), so
 *      they are both excluded from every real public query path
 *      (is_test = false is already enforced at both the RLS and RPC
 *      layer -- see search_listings) and separately, trivially
 *      identifiable for cleanup even if that weren't true.
 *   2. Runs search_listings via the Supabase JS client (never a direct
 *      psql/SQL-Editor connection) for a representative set of query
 *      shapes: plain browse (no query), a common keyword, a typo
 *      variant, a province filter, a date-range filter, and a
 *      combination of all three -- records wall-clock latency per call
 *      from Node, which is what a real request would experience
 *      (round-trip, not server-side EXPLAIN time alone).
 *   3. Deletes every row it created (by the run token), verifying the
 *      count deleted matches the count created, before exiting.
 *
 * Usage (once authorized):
 *   QA_SEED_ENABLED=true node scripts/search-scale-test.mjs 1000
 *   QA_SEED_ENABLED=true node scripts/search-scale-test.mjs 10000
 *   QA_SEED_ENABLED=true node scripts/search-scale-test.mjs 100000
 *
 * Reuses the exact same safety gate convention as scripts/qa-seed.mjs
 * (NODE_ENV !== 'production', QA_SEED_ENABLED=true, project-ref match)
 * rather than inventing a separate one.
 */
import { createClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'

const N = Number(process.argv[2] ?? 1000)
if (!Number.isInteger(N) || N <= 0 || N > 200_000) {
  console.error('Usage: node scripts/search-scale-test.mjs <row-count, 1-200000>')
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run: NODE_ENV=production')
  process.exit(1)
}
if (process.env.QA_SEED_ENABLED !== 'true') {
  console.error('Refusing to run without explicit authorization: set QA_SEED_ENABLED=true')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const expectedRef = process.env.QA_SEED_PROJECT_REF
if (!url || !serviceKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (expectedRef && !url.includes(expectedRef)) {
  console.error(`Refusing to run: Supabase URL does not match QA_SEED_PROJECT_REF (${expectedRef})`)
  process.exit(1)
}

const runToken = randomBytes(6).toString('hex')
const titlePrefix = `ScaleTest-${runToken}-`
const admin = createClient(url, serviceKey)

async function findAnyRealMerchantId() {
  // Needs one existing merchant_id to satisfy listings' FK -- reuses
  // whichever merchant already exists in this project (e.g. from
  // qa-seed.mjs) rather than creating a new auth user, since this
  // script's job is search load, not identity fixtures.
  const { data, error } = await admin.from('profiles').select('id').in('role', ['merchant', 'both']).limit(1).maybeSingle()
  if (error || !data) throw new Error('No existing merchant profile found -- run scripts/qa-seed.mjs first')
  return data.id
}

async function insertSyntheticListings(merchantId, count) {
  const BATCH = 500
  let inserted = 0
  for (let offset = 0; offset < count; offset += BATCH) {
    const batchSize = Math.min(BATCH, count - offset)
    const rows = Array.from({ length: batchSize }, (_, i) => {
      const n = offset + i
      return {
        merchant_id: merchantId,
        title: `${titlePrefix}${n}`,
        description: `Synthetic listing #${n} for search scale testing.`,
        category: ['tech', 'outdoor', 'tools', 'fashion', 'events', 'vehicles', 'music', 'sports', 'baby'][n % 9],
        condition: 'good',
        listing_type: 'rental',
        daily_rate: 50 + (n % 500),
        min_rental_days: 1,
        status: 'active',
        is_test: true,
        province: ['Gauteng', 'Western Cape', 'KwaZulu-Natal'][n % 3],
        city: ['Johannesburg', 'Cape Town', 'Durban'][n % 3],
        country_id: 'ZA',
      }
    })
    const { error } = await admin.from('listings').insert(rows)
    if (error) throw new Error(`Insert failed at offset ${offset}: ${error.message}`)
    inserted += batchSize
  }
  return inserted
}

async function timedSearch(label, params) {
  const start = performance.now()
  const { data, error } = await admin.rpc('search_listings', { p_limit: 24, ...params })
  const ms = performance.now() - start
  console.log(`  ${label}: ${ms.toFixed(1)}ms, ${error ? `ERROR: ${error.message}` : `${data?.length ?? 0} rows`}`)
  return ms
}

async function cleanup(count) {
  const { error, count: deleted } = await admin.from('listings').delete({ count: 'exact' }).like('title', `${titlePrefix}%`)
  if (error) throw new Error(`Cleanup failed: ${error.message} -- MANUAL CLEANUP REQUIRED for title prefix ${titlePrefix}`)
  if (deleted !== count) {
    console.error(`WARNING: created ${count} rows but deleted ${deleted} -- check for title prefix ${titlePrefix} manually`)
  }
  return deleted
}

async function main() {
  console.log(`Search scale test: N=${N}, run token=${runToken}`)
  const merchantId = await findAnyRealMerchantId()

  console.log(`Inserting ${N} synthetic listings (is_test=true, title prefix ${titlePrefix})...`)
  const t0 = performance.now()
  const inserted = await insertSyntheticListings(merchantId, N)
  console.log(`Inserted ${inserted} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

  // NOTE: is_test=true rows are excluded by search_listings' own
  // eligibility filter, so these timed calls measure the RPC's
  // baseline query-planning/execution cost against a larger table,
  // not the synthetic rows' own retrieval -- which is the right thing
  // to measure, since production search never returns is_test rows
  // either. This means these numbers are a lower bound, not an upper
  // bound, for how search behaves once *real* catalog size reaches N.
  console.log('Timed search_listings calls (ms, wall-clock from Node):')
  await timedSearch('plain browse (no query)', {})
  await timedSearch('common keyword', { p_query: 'camera' })
  await timedSearch('typo variant', { p_query: 'camra' })
  await timedSearch('province filter', { p_province: 'Gauteng' })
  await timedSearch('date-range filter', { p_start_date: '2026-12-01', p_end_date: '2026-12-10' })
  await timedSearch('combined filters', { p_query: 'camera', p_province: 'Gauteng', p_start_date: '2026-12-01', p_end_date: '2026-12-10' })

  console.log('Cleaning up synthetic rows...')
  const deleted = await cleanup(inserted)
  console.log(`Deleted ${deleted} rows. Done.`)
}

main().catch((err) => {
  console.error('FAILED:', err.message)
  console.error(`If rows were already inserted, clean up manually: delete from listings where title like '${titlePrefix}%';`)
  process.exit(1)
})
