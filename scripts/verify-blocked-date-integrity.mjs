#!/usr/bin/env node
/**
 * Permanent regression check for the Blocked-Date Integrity fix
 * (20260914101000_enforce_booking_listing_availability_integrity.sql +
 * the SAST booking-flow normalization + the dispute error-mapper
 * addition).
 *
 * Two modes, both explicit -- there is no implicit default:
 *
 *   --source-only   Static text/regex assertions against the migration
 *                    and TS source. No network, no DB client, no
 *                    credentials, no Supabase CLI, no mutation. Safe to
 *                    run anywhere, anytime.
 *
 *   --live          NOT IMPLEMENTED in this phase (deliberately). A
 *                    future deployment-verification phase fills this in
 *                    with the non-destructive live proof described in
 *                    the Blocked-Date Integrity B3 report (§29): two
 *                    concurrent RPC/API calls racing for the same
 *                    disposable QA listing, repeated across several
 *                    iterations, asserting exactly one side ever wins.
 *                    Calling --live today does nothing but print this
 *                    notice and exit 1 -- it never touches the network
 *                    or a database client.
 *
 * Running with no flag at all does nothing but print usage and exit 1
 * -- there is no accidental live-capable default.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

let failures = 0
function check(label, cond, detail) {
  if (cond) console.log(`  ok ${label}`)
  else {
    failures += 1
    console.error(`  FAIL ${label}`, JSON.stringify(detail ?? {}).slice(0, 500))
  }
}

function readFile(path) {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

// Extracts the SQL body of one `create or replace function public.<name>`
// definition (from its header through its own closing `$$;`), so checks
// can be scoped to exactly one function rather than the whole file.
function extractFunctionBody(sql, fnName) {
  const headerIdx = sql.indexOf(`create or replace function public.${fnName}(`)
  if (headerIdx === -1) return null
  const bodyStart = sql.indexOf('as $$', headerIdx)
  if (bodyStart === -1) return null
  const bodyEnd = sql.indexOf('$$;', bodyStart + 5)
  if (bodyEnd === -1) return null
  return sql.slice(headerIdx, bodyEnd + 3)
}

function runSourceOnly() {
  console.log('=== Blocked-Date Integrity -- source-only static verification ===\n')

  const migrationsDir = join(REPO_ROOT, 'supabase', 'migrations')
  const allMigrationFiles = readdirSync(migrationsDir)
  const matches = allMigrationFiles.filter((f) => f.endsWith('_enforce_booking_listing_availability_integrity.sql'))

  check('1. exactly one new migration matching the logical basename exists', matches.length === 1, matches)
  if (matches.length !== 1) {
    report()
    return
  }

  const sql = readFile(join('supabase', 'migrations', matches[0]))
  const helperBody = extractFunctionBody(sql, '_booking_overlaps_availability_period')
  const bookingTrgBody = extractFunctionBody(sql, 'bookings_check_availability_conflict')
  const availTrgBody = extractFunctionBody(sql, 'listing_availability_check_booking_conflict')
  const createBookingBody = extractFunctionBody(sql, 'create_booking_request')

  check('2. symmetric helper exists', helperBody !== null)
  check(
    '3. helper signature accepts (timestamptz, timestamptz, date, date)',
    /create or replace function public\._booking_overlaps_availability_period\(\s*p_booking_start_at timestamptz,\s*p_booking_end_at timestamptz,\s*p_block_start_date date,\s*p_block_end_date date\s*\)/.test(
      sql
    )
  )
  check('4. helper queries no tables', helperBody !== null && !/\bfrom\b/i.test(helperBody), helperBody)
  check('5. helper contains Africa/Johannesburg', helperBody !== null && helperBody.includes('Africa/Johannesburg'))
  check('6. helper contains tstzrange', helperBody !== null && helperBody.includes('tstzrange'))
  check(
    '7. helper contains no booking timestamp ::date cast',
    helperBody !== null && !helperBody.includes('p_booking_start_at::date') && !helperBody.includes('p_booking_end_at::date')
  )

  check('8. booking trigger function exists', bookingTrgBody !== null)
  check('9. availability trigger function exists', availTrgBody !== null)
  check(
    '10. booking trigger attached to bookings',
    /create trigger bookings_check_availability_conflict_trg\s+before insert or update on public\.bookings/.test(sql)
  )
  check(
    '11. availability trigger attached to listing_availability',
    /create trigger listing_availability_check_booking_conflict_trg\s+before insert or update of listing_id, start_date, end_date on public\.listing_availability/.test(
      sql
    )
  )
  check(
    '12. both trigger functions lock public.listings FOR UPDATE',
    bookingTrgBody !== null &&
      availTrgBody !== null &&
      /from public\.listings where id = new\.listing_id for update/.test(bookingTrgBody) &&
      /from public\.listings where id = new\.listing_id for update/.test(availTrgBody)
  )
  check(
    '13. both trigger functions call the same symmetric helper',
    bookingTrgBody !== null &&
      availTrgBody !== null &&
      bookingTrgBody.includes('public._booking_overlaps_availability_period(') &&
      availTrgBody.includes('public._booking_overlaps_availability_period(')
  )
  check(
    "14. booking trigger checks accepted/active",
    bookingTrgBody !== null && /new\.status not in \('accepted', 'active'\)/.test(bookingTrgBody)
  )
  check(
    '15. availability trigger queries accepted/active bookings',
    availTrgBody !== null && /b\.status in \('accepted', 'active'\)/.test(availTrgBody)
  )

  check('16. create_booking_request replacement exists', createBookingBody !== null)
  check(
    '17. create_booking_request calls the symmetric helper',
    createBookingBody !== null && createBookingBody.includes('public._booking_overlaps_availability_period(')
  )
  // Scoped to the create_booking_request function body specifically (not
  // the whole file) -- the migration's own header comment documents the
  // historical bug and legitimately quotes the old predicate as prose;
  // what actually matters is that the *replacement function's own code*
  // no longer contains it.
  check(
    "18. old pattern 'start_date < p_end_at::date' absent from create_booking_request's body",
    createBookingBody !== null && !createBookingBody.includes('start_date < p_end_at::date')
  )
  check(
    "19. old pattern 'end_date > p_start_at::date' absent from create_booking_request's body",
    createBookingBody !== null && !createBookingBody.includes('end_date > p_start_at::date')
  )

  check('20. migration does NOT replace accept_booking_request', !sql.includes('function public.accept_booking_request'))
  check('21. migration does NOT replace resolve_dispute', !sql.includes('function public.resolve_dispute'))
  check('22. migration does NOT replace cancel_dispute', !sql.includes('function public.cancel_dispute'))
  check('23. migration does NOT replace save_listing_draft', !sql.includes('function public.save_listing_draft'))

  const fnDefCount = (sql.match(/create or replace function public\./g) ?? []).length
  check('24. migration contains no unrelated CREATE OR REPLACE function (exactly 4: helper + 2 triggers + create_booking_request)', fnDefCount === 4, {
    fnDefCount,
  })

  check(
    '25. trigger/helper ACLs do not grant anon/authenticated execute',
    !/grant execute[^;]*to (anon|authenticated|public)\b/i.test(sql)
  )

  try {
    const gitStatus = execSync('git status --porcelain -- supabase/migrations', { cwd: REPO_ROOT, encoding: 'utf8' })
    const lines = gitStatus.split('\n').filter(Boolean)
    const modifiedHistorical = lines.filter((l) => !l.startsWith('??') && !l.includes(matches[0]))
    check('26. historical migration files untouched', modifiedHistorical.length === 0, modifiedHistorical)
  } catch (e) {
    check('26. historical migration files untouched', false, { error: String(e) })
  }

  const bookingFlow = readFile('src/app/[locale]/(marketing)/listings/[id]/book/booking-flow.tsx')
  check(
    '27. booking-flow imports the date utility',
    bookingFlow.includes("from '@/lib/bookings/date'") && bookingFlow.includes('calendarDateToSastIso')
  )
  check(
    '28. booking-flow no longer calls toISOString() for range.from/range.to payload',
    !bookingFlow.includes('range.from.toISOString()') && !bookingFlow.includes('range.to.toISOString()')
  )

  const dateUtil = readFile('src/lib/bookings/date.ts')
  check('29. date utility emits an explicit +02:00 offset', dateUtil.includes('+02:00'))

  const disputeMapper = readFile('src/lib/disputes/rpc-errors.ts')
  check(
    '30. dispute mapper recognizes the canonical trigger message',
    disputeMapper.includes('this listing is no longer available for the requested dates')
  )

  console.log('\n=== Edge-matrix sanity checks (design-time only, not a substitute for deployed DB proof) ===')
  runEdgeMatrixSanityChecks()

  report()
}

// Pure-JS mirror of the SQL predicate, used ONLY to sanity-check that the
// conceptual edge cases this fix is meant to cover are internally
// consistent -- NOT a re-implementation the SQL is graded against, and
// NOT a substitute for a real deployed-DB proof. SAST is a fixed +02:00,
// no-DST offset, so this arithmetic mirror is safe for these purposes.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000
function blockRangeMs(startDateIso, endDateIso) {
  const start = new Date(startDateIso + 'T00:00:00Z').getTime() - SAST_OFFSET_MS
  const endExclusiveDate = new Date(endDateIso + 'T00:00:00Z')
  endExclusiveDate.setUTCDate(endExclusiveDate.getUTCDate() + 1)
  const end = endExclusiveDate.getTime() - SAST_OFFSET_MS
  return { start, end }
}
function overlaps(bookingStartIso, bookingEndIso, blockStartDate, blockEndDate) {
  const bStart = new Date(bookingStartIso).getTime()
  const bEnd = new Date(bookingEndIso).getTime()
  const { start: aStart, end: aEnd } = blockRangeMs(blockStartDate, blockEndDate)
  return bStart < aEnd && aStart < bEnd
}

function runEdgeMatrixSanityChecks() {
  check(
    'single-day block conflicts with a booking starting that day',
    overlaps('2026-09-15T00:00:00+02:00', '2026-09-16T00:00:00+02:00', '2026-09-15', '2026-09-15')
  )
  check(
    'first-day of a multi-day block conflicts',
    overlaps('2026-09-15T00:00:00+02:00', '2026-09-16T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'last-day of a multi-day block conflicts (the historically-buggy case)',
    overlaps('2026-09-18T00:00:00+02:00', '2026-09-19T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'booking contains the entire block',
    overlaps('2026-09-10T00:00:00+02:00', '2026-09-20T00:00:00+02:00', '2026-09-15', '2026-09-16')
  )
  check(
    'block contains the entire booking',
    overlaps('2026-09-15T00:00:00+02:00', '2026-09-16T00:00:00+02:00', '2026-09-10', '2026-09-20')
  )
  check(
    'booking entirely before the block does not conflict',
    !overlaps('2026-09-01T00:00:00+02:00', '2026-09-05T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'booking entirely after the block does not conflict',
    !overlaps('2026-09-25T00:00:00+02:00', '2026-09-28T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'booking starting exactly at the block end-boundary (back-to-back) does not conflict',
    !overlaps('2026-09-19T00:00:00+02:00', '2026-09-22T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'booking ending exactly at midnight on the block start day does not conflict',
    !overlaps('2026-09-10T00:00:00+02:00', '2026-09-15T00:00:00+02:00', '2026-09-15', '2026-09-18')
  )
  check(
    'booking ending mid-day into the block start day does conflict',
    overlaps('2026-09-10T00:00:00+02:00', '2026-09-15T10:00:00+02:00', '2026-09-15', '2026-09-15')
  )
}

function report() {
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--source-only')) {
    runSourceOnly()
    return
  }
  if (args.includes('--live')) {
    console.log('--live is NOT IMPLEMENTED in this phase (deliberately).')
    console.log('No network or database client is touched by this flag today.')
    console.log('See the Blocked-Date Integrity B3 report (§29) for the intended future live-concurrency proof design.')
    process.exit(1)
  }
  console.log('Usage: node scripts/verify-blocked-date-integrity.mjs --source-only')
  console.log('       node scripts/verify-blocked-date-integrity.mjs --live   (not implemented yet)')
  process.exit(1)
}

main()
