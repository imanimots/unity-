#!/usr/bin/env node
/**
 * KYC Orphan Cleanup Phase B3M -- read-only operational reporter for
 * the durable legacy no-intent finalization attempt metric
 * (public.kyc_legacy_finalize_daily_metrics, incremented by
 * public.record_kyc_legacy_finalize_attempt()).
 *
 * Reads ONLY: bucket_date, legacy_attempt_count. Never prints a
 * user id, document id, storage path, MIME type, file size, or any
 * other KYC content -- the table itself carries none of that, but this
 * script is also written never to assume otherwise.
 *
 * Two modes:
 *   RAW MODE (no --observation-start): prints recorded aggregate rows
 *     for the last `--days` days plus a safe total. Computes NO
 *     streak, NO completed-observation-day count, and makes NO
 *     B3B-readiness claim of any kind.
 *   WINDOWED MODE (--observation-start=YYYY-MM-DD supplied): additionally
 *     prints COMPLETED OBSERVATION DAYS and OBSERVED ZERO-DAY STREAK,
 *     computed only over full UTC calendar days from observation-start
 *     through the last FULLY ELAPSED UTC day (never the current,
 *     still-in-progress UTC day -- see scripts/lib/kyc-legacy-metrics-
 *     window.mjs for the exact rules and rationale).
 *
 * SELECTED CONTRACT (Option B, per the B3M-B1F audit): `--days` and
 * `--observation-start` may be combined freely. `--days` controls ONLY
 * the raw display section's query window and is NEVER read by the
 * windowed/streak computation below -- the observation-mode query
 * always covers the ENTIRE [observation-start, last-complete-UTC-day]
 * range via explicit `bucket_date` bounds (buildObservationQueryBounds
 * in kyc-legacy-metrics-window.mjs), with no row-count limit anywhere.
 * This makes a "--days=1 --observation-start=<14 days ago>"
 * truncation attempt structurally incapable of hiding a real, older
 * non-zero day inside the streak calculation -- the two queries share
 * no state. See kyc-legacy-metrics-window.test.mjs for the explicit
 * regression proving this.
 *
 * This script NEVER outputs a B3B decision, a cutover approval, or any
 * language implying the legacy compatibility path is safe to remove --
 * that call is human-gated and requires far more than a zero streak
 * (see the B3M architecture reports). It also never prints
 * SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, or any other
 * environment value.
 *
 * No Supabase CLI is used or required -- this is a plain
 * @supabase/supabase-js service-role read, the same non-interactive
 * pattern used by every other live-proof script in this repo.
 *
 * Usage:
 *   node scripts/report-kyc-legacy-finalization-metrics.mjs [--days=N] [--observation-start=YYYY-MM-DD]
 */

import { config } from 'dotenv'
import {
  getCurrentUtcDate,
  getLastCompleteUtcDate,
  buildCountsByDate,
  buildObservationQueryBounds,
  computeObservationWindow,
  resolveObservationMode,
  parseDaysArg,
  addUtcDays,
} from './lib/kyc-legacy-metrics-window.mjs'

config({ path: '.env.local' })

const TABLE = 'kyc_legacy_finalize_daily_metrics'
const DEFAULT_DAYS = 30
const MAX_DAYS = 365

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/)
    if (!m) continue
    out[m[1]] = m[2]
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const days = parseDaysArg(args.days, { defaultValue: DEFAULT_DAYS, max: MAX_DAYS })
  if (days === null) {
    console.error(`Invalid --days value. Must be a positive integer, at most ${MAX_DAYS}.`)
    process.exitCode = 1
    return
  }

  const observationMode = resolveObservationMode(args['observation-start'])
  if (observationMode.mode === 'invalid') {
    console.error('Invalid --observation-start value. Required format: exact YYYY-MM-DD, a real UTC calendar date.')
    process.exitCode = 1
    return
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured in this environment.')
    process.exitCode = 1
    return
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const now = new Date()
  const currentUtcDate = getCurrentUtcDate(now)
  const lastCompleteUtcDate = getLastCompleteUtcDate(now)
  const rawWindowStart = addUtcDays(currentUtcDate, -days)

  const { data: rows, error } = await admin
    .from(TABLE)
    .select('bucket_date, legacy_attempt_count')
    .gte('bucket_date', rawWindowStart)
    .order('bucket_date', { ascending: true })

  if (error) {
    console.error('Could not read the KYC legacy finalization metric table.')
    process.exitCode = 1
    return
  }

  console.log(`KYC legacy finalization attempt metrics -- last ${days} day(s)`)
  console.log('')
  let total = 0
  for (const row of rows ?? []) {
    console.log(`${row.bucket_date}  ${row.legacy_attempt_count}`)
    total += Number(row.legacy_attempt_count)
  }
  console.log('')
  console.log(`TOTAL RECORDED ATTEMPTS (last ${days} day(s)): ${total}`)

  const currentDayRow = (rows ?? []).find((r) => r.bucket_date === currentUtcDate)
  if (currentDayRow) {
    console.log('')
    console.log(`CURRENT_PARTIAL_DAY: ${currentUtcDate}`)
    console.log(`ATTEMPTS_RECORDED_SO_FAR: ${currentDayRow.legacy_attempt_count}`)
  } else {
    console.log('')
    console.log(`CURRENT_PARTIAL_DAY: ${currentUtcDate}`)
    console.log('NO ATTEMPT RECORDED SO FAR TODAY')
  }

  if (observationMode.mode === 'raw') {
    console.log('')
    console.log('No --observation-start supplied -- raw aggregate data only.')
    console.log('No zero-day streak, no completed-observation-day count, and no B3B readiness assessment can be made without it.')
    return
  }

  // WINDOWED MODE -- query coverage for the streak calculation is
  // computed from observationStart/lastCompleteUtcDate ONLY, via
  // buildObservationQueryBounds(). `days` is never read past this
  // point: it has already done its only job (bounding the raw display
  // section above) and must never leak into streak query coverage.
  const { observationStart } = observationMode
  const bounds = buildObservationQueryBounds({ observationStart, lastCompleteUtcDate })

  let completedObservationDays = 0
  let observedZeroDayStreak = 0

  if (bounds) {
    // Explicit inclusive DATE bounds, no .limit()/.range() of any kind
    // -- authoritative coverage of every date the streak calculation
    // could classify as "completed", regardless of how sparse the
    // table is inside that range. A query-level failure here MUST NOT
    // fall through to a streak computation: it aborts the script
    // instead (no false zero from an unreadable table).
    const { data: windowRows, error: windowError } = await admin
      .from(TABLE)
      .select('bucket_date, legacy_attempt_count')
      .gte('bucket_date', bounds.gte)
      .lte('bucket_date', bounds.lte)
      .order('bucket_date', { ascending: true })

    if (windowError) {
      console.error('Could not read the KYC legacy finalization metric table for the observation window.')
      process.exitCode = 1
      return
    }

    const countsByDate = buildCountsByDate(windowRows)
    ;({ completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart,
      lastCompleteUtcDate,
      countsByDate,
    }))
  }
  // else: observationStart is still in the future relative to
  // lastCompleteUtcDate -- no completed day exists yet, no query is
  // needed, and the answer is definitionally 0/0 (see
  // buildObservationQueryBounds / computeObservationWindow).

  console.log('')
  console.log(`OBSERVATION START: ${observationStart}`)
  console.log(`LAST COMPLETE UTC DATE: ${lastCompleteUtcDate}`)
  console.log(`COMPLETED OBSERVATION DAYS: ${completedObservationDays}`)
  console.log(`OBSERVED ZERO-DAY STREAK: ${observedZeroDayStreak}`)
  console.log('')
  console.log('(This figure is computed from a query covering the full observation range by')
  console.log(' explicit date bounds, independent of --days and with no row-count limit --')
  console.log(' --days affects only the raw display section above, never this calculation.)')
  console.log('')
  console.log('This is factual data only. It is not a B3B cutover decision. Human sign-off, an')
  console.log('immediate pre-decision instrumentation/source health re-check, and confirmation')
  console.log('that no deliberate legacy QA fell inside this window remain required regardless')
  console.log('of the streak length.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
