import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  parseStrictUtcDateString,
  getCurrentUtcDate,
  getLastCompleteUtcDate,
  enumerateUtcDates,
  buildCountsByDate,
  buildObservationQueryBounds,
  computeObservationWindow,
  resolveObservationMode,
  parseDaysArg,
} from './kyc-legacy-metrics-window.mjs'

// KYC Orphan Cleanup Phase B3M -- pure, offline test matrix (no
// network, no database, no service-role credential, no wall-clock
// dependency: every "now" is injected explicitly).

describe('parseStrictUtcDateString', () => {
  it('1. strict valid observation date accepted', () => {
    expect(parseStrictUtcDateString('2026-09-16')).toBe('2026-09-16')
  })

  it('2. Feb 31 rejected (non-existent calendar date)', () => {
    expect(parseStrictUtcDateString('2026-02-31')).toBeNull()
  })

  it('rejects month 13', () => {
    expect(parseStrictUtcDateString('2026-13-01')).toBeNull()
  })

  it('3. timestamp rejected', () => {
    expect(parseStrictUtcDateString('2026-09-16T00:00:00Z')).toBeNull()
  })

  it('rejects slash format', () => {
    expect(parseStrictUtcDateString('09/16/2026')).toBeNull()
  })

  it('rejects reversed format', () => {
    expect(parseStrictUtcDateString('16-09-2026')).toBeNull()
  })

  it('rejects empty string', () => {
    expect(parseStrictUtcDateString('')).toBeNull()
  })

  it('rejects partial values', () => {
    expect(parseStrictUtcDateString('2026-09')).toBeNull()
  })
})

describe('current UTC day vs. last complete UTC day', () => {
  it('4. current partial UTC day is excluded from the completed range', () => {
    const now = new Date('2026-09-29T10:00:00Z')
    expect(getCurrentUtcDate(now)).toBe('2026-09-29')
    const lastComplete = getLastCompleteUtcDate(now)
    expect(lastComplete).toBe('2026-09-28')
    const range = enumerateUtcDates('2026-09-16', lastComplete)
    expect(range).not.toContain('2026-09-29')
  })

  it('9. current-day missing row is not treated as a completed zero day (never enters the window range at all)', () => {
    const now = new Date('2026-09-29T23:59:59Z')
    const lastComplete = getLastCompleteUtcDate(now)
    // Even one second before UTC midnight, the current day is still excluded.
    expect(lastComplete).toBe('2026-09-28')
    expect(enumerateUtcDates('2026-09-16', lastComplete)).not.toContain(getCurrentUtcDate(now))
  })
})

describe('A3 worked examples', () => {
  it('5. Sep16 observation start, now Sep29 10:00Z -> 13 completed days, not 14', () => {
    const now = new Date('2026-09-29T10:00:00Z')
    const lastComplete = getLastCompleteUtcDate(now)
    const { completedObservationDays } = computeObservationWindow({
      observationStart: '2026-09-16',
      lastCompleteUtcDate: lastComplete,
      countsByDate: new Map(),
    })
    expect(completedObservationDays).toBe(13)
    expect(completedObservationDays).not.toBe(14)
  })

  it('6. at Sep30 00:00Z, Sep29 becomes complete -> 14 days if zero throughout', () => {
    const now = new Date('2026-09-30T00:00:00Z')
    const lastComplete = getLastCompleteUtcDate(now)
    expect(lastComplete).toBe('2026-09-29')
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-09-16',
      lastCompleteUtcDate: lastComplete,
      countsByDate: new Map(),
    })
    expect(completedObservationDays).toBe(14)
    expect(observedZeroDayStreak).toBe(14)
  })
})

describe('streak reset and zero-fill semantics', () => {
  it('7. a positive completed day resets the consecutive streak', () => {
    const countsByDate = buildCountsByDate([
      { bucket_date: '2026-09-16', legacy_attempt_count: 0 },
      { bucket_date: '2026-09-17', legacy_attempt_count: 0 },
      { bucket_date: '2026-09-18', legacy_attempt_count: 3 },
      { bucket_date: '2026-09-19', legacy_attempt_count: 0 },
      { bucket_date: '2026-09-20', legacy_attempt_count: 0 },
    ])
    const { observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-09-16',
      lastCompleteUtcDate: '2026-09-20',
      countsByDate,
    })
    expect(observedZeroDayStreak).toBe(2)
    expect(observedZeroDayStreak).not.toBe(4)
  })

  it('8. a completed day with no row at all synthesizes as zero', () => {
    // No rows recorded anywhere in the range -- every day must be
    // treated as zero, not as "unknown"/excluded.
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-09-01',
      lastCompleteUtcDate: '2026-09-05',
      countsByDate: new Map(),
    })
    expect(completedObservationDays).toBe(5)
    expect(observedZeroDayStreak).toBe(5)
  })
})

describe('future / not-yet-accumulated observation window', () => {
  it('10. observationStart > lastCompleteUtcDate -> 0 completed days, 0 streak (valid, not an error)', () => {
    const result = computeObservationWindow({
      observationStart: '2026-10-01',
      lastCompleteUtcDate: '2026-09-28',
      countsByDate: new Map(),
    })
    expect(result).toEqual({ completedObservationDays: 0, observedZeroDayStreak: 0 })
  })
})

describe('observation-start CLI resolution', () => {
  it('11. no observation-start supplied -> raw mode, no streak calculation attempted', () => {
    expect(resolveObservationMode(undefined)).toEqual({ mode: 'raw' })
  })

  it('a valid observation-start resolves to windowed mode', () => {
    expect(resolveObservationMode('2026-09-16')).toEqual({ mode: 'windowed', observationStart: '2026-09-16' })
  })

  it('an invalid observation-start resolves to invalid mode, never silently ignored as "raw"', () => {
    expect(resolveObservationMode('2026-02-31')).toEqual({ mode: 'invalid' })
    expect(resolveObservationMode('16-09-2026')).toEqual({ mode: 'invalid' })
  })
})

describe('timezone independence', () => {
  it('12. local timezone does not influence the UTC result', () => {
    // 23:30 in UTC+5 is 18:30 UTC the same day -- must resolve via the
    // instant's UTC calendar date, never a local/offset-naive read.
    const now = new Date('2026-01-01T23:30:00+05:00')
    expect(getCurrentUtcDate(now)).toBe('2026-01-01')
  })

  it('a UTC-morning instant just after midnight stays on the same UTC day, never rolls to the local previous day', () => {
    const now = new Date('2026-01-02T00:30:00Z')
    expect(getCurrentUtcDate(now)).toBe('2026-01-02')
  })
})

describe('--days argument validation', () => {
  it('13. invalid --days values rejected', () => {
    expect(parseDaysArg('0')).toBeNull()
    expect(parseDaysArg('-5')).toBeNull()
    expect(parseDaysArg('abc')).toBeNull()
    expect(parseDaysArg('12.5')).toBeNull()
    expect(parseDaysArg('')).toBeNull()
  })

  it('14. --days cap enforced', () => {
    expect(parseDaysArg('9999', { max: 365 })).toBeNull()
    expect(parseDaysArg('365', { max: 365 })).toBe(365)
    expect(parseDaysArg('366', { max: 365 })).toBeNull()
  })

  it('default applies only when the flag is entirely absent', () => {
    expect(parseDaysArg(undefined, { defaultValue: 30 })).toBe(30)
  })
})

describe('B3M-B1F -- observation query coverage must never depend on --days (false-zero hardening)', () => {
  it('buildObservationQueryBounds ignores days entirely -- its signature accepts no such input', () => {
    // The function's own arity/shape is the proof: there is no `days`
    // parameter for a truncation attempt to reach in the first place.
    expect(buildObservationQueryBounds.length).toBe(1)
    const bounds = buildObservationQueryBounds({ observationStart: '2026-09-01', lastCompleteUtcDate: '2026-09-15' })
    expect(bounds).toEqual({ gte: '2026-09-01', lte: '2026-09-15' })
  })

  it('15. --days=1 truncation attempt cannot hide a real non-zero row inside the observation window', () => {
    // Exact scenario from the B3M-B1F audit: observationStart 15 days
    // before "now", a real non-zero attempt 10 days ago, operator
    // attempts a truncating --days=1. The bounds function never sees
    // --days at all, so the query it drives always covers the full
    // range -- simulated here by feeding computeObservationWindow rows
    // built from the FULL bounds, never a --days=1-limited subset.
    const now = new Date('2026-09-16T10:00:00Z')
    const observationStart = '2026-09-01'
    const lastCompleteUtcDate = getLastCompleteUtcDate(now) // 2026-09-15
    const bounds = buildObservationQueryBounds({ observationStart, lastCompleteUtcDate })
    expect(bounds).toEqual({ gte: '2026-09-01', lte: '2026-09-15' })

    // The "authoritative" query (using `bounds`, never `--days`) would
    // return this row -- a genuine attempt recorded 2026-09-10.
    const rowsAsQueriedWithFullBounds = [{ bucket_date: '2026-09-10', legacy_attempt_count: 1 }]
    const countsByDate = buildCountsByDate(rowsAsQueriedWithFullBounds)

    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart,
      lastCompleteUtcDate,
      countsByDate,
    })
    // 2026-09-01 through 2026-09-15 inclusive = 15 days.
    expect(completedObservationDays).toBe(15)
    // Streak must stop at the 2026-09-10 non-zero day -- only
    // 2026-09-11..2026-09-15 (5 days) are zero, NOT a false 15-day streak.
    expect(observedZeroDayStreak).toBe(5)
    expect(observedZeroDayStreak).not.toBe(15)
  })

  it('16. a single sparse non-zero row inside a long completed range is never missed regardless of row density', () => {
    const observationStart = '2026-09-01'
    const lastCompleteUtcDate = '2026-09-14' // 14 completed days
    // Only ONE row exists in the entire 14-day range, in the middle.
    const countsByDate = buildCountsByDate([{ bucket_date: '2026-09-05', legacy_attempt_count: 2 }])
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart,
      lastCompleteUtcDate,
      countsByDate,
    })
    expect(completedObservationDays).toBe(14)
    // 2026-09-06 through 2026-09-14 inclusive = 9 zero days after the sparse non-zero row.
    expect(observedZeroDayStreak).toBe(9)
  })

  it('17. zero rows returned across an authoritatively-covered range synthesizes every day as zero (safe)', () => {
    const bounds = buildObservationQueryBounds({ observationStart: '2026-09-01', lastCompleteUtcDate: '2026-09-05' })
    expect(bounds).toEqual({ gte: '2026-09-01', lte: '2026-09-05' })
    const countsByDate = buildCountsByDate([]) // query executed, authoritatively, zero rows returned
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-09-01',
      lastCompleteUtcDate: '2026-09-05',
      countsByDate,
    })
    expect(completedObservationDays).toBe(5)
    expect(observedZeroDayStreak).toBe(5)
  })

  it('18. an older non-zero day outside the trailing 14 is compatible with a >=14 current streak', () => {
    // 20-day completed window: non-zero on day 3, zero for the
    // remaining 17 days (days 4..20).
    const rows = [{ bucket_date: '2026-09-03', legacy_attempt_count: 1 }]
    const countsByDate = buildCountsByDate(rows)
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-09-01',
      lastCompleteUtcDate: '2026-09-20',
      countsByDate,
    })
    expect(completedObservationDays).toBe(20)
    expect(observedZeroDayStreak).toBe(17)
    expect(observedZeroDayStreak).toBeGreaterThanOrEqual(14)
  })

  it('a future observationStart needs no query at all -- bounds is null, matching the 0/0 window result', () => {
    const bounds = buildObservationQueryBounds({ observationStart: '2026-10-01', lastCompleteUtcDate: '2026-09-28' })
    expect(bounds).toBeNull()
    const { completedObservationDays, observedZeroDayStreak } = computeObservationWindow({
      observationStart: '2026-10-01',
      lastCompleteUtcDate: '2026-09-28',
      countsByDate: new Map(),
    })
    expect({ completedObservationDays, observedZeroDayStreak }).toEqual({ completedObservationDays: 0, observedZeroDayStreak: 0 })
  })
})

describe('B3M-B1F -- query-error-must-not-synthesize-zero is a source-order property, proven statically', () => {
  it('the reporter source returns/aborts on a windowed-query error strictly before computing a streak', () => {
    // This is a `main()`-level, live-query-touching behavior. Per this
    // phase's "no live reporter execution, pure tests only" rule, it is
    // proven by static source-order inspection here rather than by
    // executing or mocking the Supabase client -- matching
    // scripts/verify-kyc-legacy-metrics-source.mjs's own static-only
    // convention for this exact same property.
    const source = readFileSync(fileURLToPath(new URL('../report-kyc-legacy-finalization-metrics.mjs', import.meta.url)), 'utf8')
    const windowErrorIdx = source.indexOf('if (windowError)')
    const computeIdx = source.indexOf('computeObservationWindow({')
    expect(windowErrorIdx).toBeGreaterThan(-1)
    expect(computeIdx).toBeGreaterThan(-1)
    expect(windowErrorIdx).toBeLessThan(computeIdx)
    // The error branch must itself abort (never merely log and continue).
    const errorBranch = source.slice(windowErrorIdx, windowErrorIdx + 200)
    expect(errorBranch).toMatch(/return/)
  })
})

describe('reporter output never contains cutover-approval language', () => {
  it('15. the reporter script source never emits B3B-approval phrasing', () => {
    const reporterPath = fileURLToPath(new URL('../report-kyc-legacy-finalization-metrics.mjs', import.meta.url))
    const source = readFileSync(reporterPath, 'utf8')
    expect(source).not.toMatch(/SAFE TO REMOVE LEGACY/i)
    expect(source).not.toMatch(/READY FOR B3B/i)
    expect(source).not.toMatch(/CUTOVER APPROVED/i)
  })
})
