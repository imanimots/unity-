/**
 * KYC Orphan Cleanup Phase B3M -- pure, offline UTC-calendar-day
 * observation-window logic shared by scripts/report-kyc-legacy-
 * finalization-metrics.mjs and scripts/verify-kyc-legacy-metrics-
 * source.mjs's test coverage.
 *
 * No network. No database. No credentials. Every function here takes
 * its "current time" as an explicit, injectable parameter (never reads
 * the wall clock itself) so it can be exercised deterministically in
 * tests -- see kyc-legacy-metrics-window.test.mjs.
 *
 * Design authority: the B3M architecture reports (B3M-A / B3M-A2 /
 * B3M-A3). Key rules encoded here:
 *   - Only FULL UTC calendar days can ever count toward the 14-day
 *     zero-attempt observation window -- the current, still-in-
 *     progress UTC day never can, no matter how late it is queried.
 *   - Missing dates inside the eligible [observationStart,
 *     lastCompleteUtcDate] range synthesize as zero (the recorder is
 *     event-driven: no request, no row) -- but ONLY inside that range.
 *   - A single completed day with a positive count resets the
 *     consecutive-zero streak immediately.
 *   - `observationStart > lastCompleteUtcDate` is a valid state (a
 *     freshly-started window), not an error -- both counters are 0.
 */

const STRICT_UTC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ENUMERATED_DAYS = 20000 // ~54 years -- a generous sanity cap, never a real limit

/**
 * Strictly validates a UTC calendar date string in exactly `YYYY-MM-DD`
 * form, rejecting timestamps, slash formats, reversed formats, and
 * non-existent calendar dates (e.g. 2026-02-31, 2026-13-01). Returns
 * the canonical string on success, or `null` on any rejection. Never
 * throws, never silently normalizes.
 */
export function parseStrictUtcDateString(input) {
  if (typeof input !== 'string') return null
  if (!STRICT_UTC_DATE_RE.test(input)) return null
  const [yStr, mStr, dStr] = input.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (m < 1 || m > 12) return null
  if (d < 1 || d > 31) return null
  const ms = Date.UTC(y, m - 1, d)
  const roundTrip = new Date(ms)
  if (roundTrip.getUTCFullYear() !== y || roundTrip.getUTCMonth() !== m - 1 || roundTrip.getUTCDate() !== d) {
    return null // e.g. 2026-02-31 rolls over to March -- reject rather than silently normalize
  }
  return input
}

/** Formats a Date's UTC calendar date as `YYYY-MM-DD`. Uses the Date's
 * absolute instant via UTC accessors only -- never local/machine time. */
export function toUtcDateString(date) {
  return date.toISOString().slice(0, 10)
}

/** Returns the `YYYY-MM-DD` UTC calendar date containing `now` (an
 * injectable Date, defaulting to the real wall clock only at the call
 * site that isn't under test). */
export function getCurrentUtcDate(now = new Date()) {
  return toUtcDateString(now)
}

/** Adds (or subtracts, for negative `n`) `n` UTC calendar days to a
 * strict `YYYY-MM-DD` date string. */
export function addUtcDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d) + n * 86_400_000
  return toUtcDateString(new Date(ms))
}

/** The most recent UTC calendar day that has FULLY elapsed as of `now`
 * -- i.e. `getCurrentUtcDate(now)` minus one day. The current UTC day
 * itself is never "complete" no matter how late in the day it is. */
export function getLastCompleteUtcDate(now = new Date()) {
  return addUtcDays(getCurrentUtcDate(now), -1)
}

/** Every UTC date from `startStr` through `endStr` inclusive, in order.
 * Returns `[]` if `startStr > endStr`. Both must already be validated
 * strict `YYYY-MM-DD` strings. */
export function enumerateUtcDates(startStr, endStr) {
  const dates = []
  let cur = startStr
  let guard = 0
  while (cur <= endStr) {
    dates.push(cur)
    cur = addUtcDays(cur, 1)
    guard += 1
    if (guard > MAX_ENUMERATED_DAYS) break // sanity cap only, never a real-world limit
  }
  return dates
}

/** Builds a `Map<bucket_date, legacy_attempt_count>` from raw aggregate
 * rows (each `{ bucket_date, legacy_attempt_count }`), coercing the
 * count to a number. */
export function buildCountsByDate(rows) {
  const map = new Map()
  for (const row of rows ?? []) {
    map.set(row.bucket_date, Number(row.legacy_attempt_count))
  }
  return map
}

/**
 * Computes the two headline observation-window numbers.
 *
 * `completedObservationDays` -- how many full UTC days fall in
 * [observationStart, lastCompleteUtcDate] (0 if the range is empty,
 * i.e. observationStart > lastCompleteUtcDate -- a valid, non-error
 * state for a freshly-started window).
 *
 * `observedZeroDayStreak` -- walking backward from
 * lastCompleteUtcDate, the count of consecutive completed days with
 * either no row (`countsByDate` missing that date) or an explicit
 * zero count, stopping at (not including) the most recent day with a
 * positive count.
 */
export function computeObservationWindow({ observationStart, lastCompleteUtcDate, countsByDate }) {
  if (observationStart > lastCompleteUtcDate) {
    return { completedObservationDays: 0, observedZeroDayStreak: 0 }
  }
  const days = enumerateUtcDates(observationStart, lastCompleteUtcDate)
  const completedObservationDays = days.length
  let observedZeroDayStreak = 0
  for (let i = days.length - 1; i >= 0; i -= 1) {
    const count = countsByDate?.get(days[i]) ?? 0
    if (count > 0) break
    observedZeroDayStreak += 1
  }
  return { completedObservationDays, observedZeroDayStreak }
}

/**
 * Decides how the reporter should treat a raw `--observation-start`
 * CLI value, without ever inventing one on its own.
 *   - `undefined` (flag absent)          -> { mode: 'raw' }
 *   - a strictly valid YYYY-MM-DD string -> { mode: 'windowed', observationStart }
 *   - anything else                      -> { mode: 'invalid' }
 */
export function resolveObservationMode(rawArg) {
  if (rawArg === undefined) return { mode: 'raw' }
  const parsed = parseStrictUtcDateString(rawArg)
  if (!parsed) return { mode: 'invalid' }
  return { mode: 'windowed', observationStart: parsed }
}

/**
 * Computes the `bucket_date` query bounds an observation-mode reporter
 * query MUST use to guarantee it can see any stored row for every date
 * `computeObservationWindow()` might later classify as a completed
 * observation day. Returns `null` when the window has not yet
 * accumulated a single completed day (`observationStart >
 * lastCompleteUtcDate`) -- in that case no query is needed at all,
 * since the answer is already known to be
 * `{ completedObservationDays: 0, observedZeroDayStreak: 0 }`.
 *
 * Deliberately takes no `days`/row-count input of any kind, and always
 * returns an inclusive [gte, lte] DATE range, never a row limit --
 * this table is sparse (at most one row per day, only on days with
 * real activity), so a fixed row-count limit does not correspond to a
 * fixed calendar interval and could silently omit a real, older
 * non-zero day while still returning "enough" rows to look plausible.
 * `--days` must never influence this function's output; it exists
 * purely to bound the separate, streak-agnostic raw display query.
 */
export function buildObservationQueryBounds({ observationStart, lastCompleteUtcDate }) {
  if (observationStart > lastCompleteUtcDate) return null
  return { gte: observationStart, lte: lastCompleteUtcDate }
}

/**
 * Validates `--days=N`: a strictly positive integer, capped at `max`.
 * Returns the numeric value, `defaultValue` if `raw` is `undefined`,
 * or `null` for anything invalid (non-digit, zero, negative, decimal,
 * or over the cap) -- callers must treat `null` as a rejection, never
 * silently fall back to the default.
 */
export function parseDaysArg(raw, { defaultValue = 30, max = 365 } = {}) {
  if (raw === undefined) return defaultValue
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (n <= 0 || n > max) return null
  return n
}
