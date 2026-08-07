/**
 * Fail-closed evaluation helpers, shared by verify-*.mjs scripts that
 * assert against a live Supabase query or a live HTTP fetch. Extracted
 * into their own module specifically so they can be unit-tested (see
 * scripts/lib/__tests__/fail-closed.test.mjs) -- a script that only ever
 * runs against a live dev database can't otherwise get automated
 * coverage proving its OWN error handling actually fails closed.
 *
 * The bug this exists to prevent: `const { data } = await query` then
 * `check(label, (data ?? []).length === 0)` silently treats a genuine
 * query error (e.g. a missing column) as an empty, passing result --
 * the exact false-pass a regression script must never produce.
 */

/**
 * Evaluates a Supabase-style `{ data, error }` result. Any error, or a
 * result shape that doesn't match what the caller expects, is a
 * failure -- never silently coerced into an empty/passing value.
 */
export function evaluateQueryResult({ data, error }, { expectArray = true } = {}) {
  if (error) {
    const code = error.code ?? 'unknown'
    const message = error.message ?? String(error)
    return { ok: false, reason: `query error: ${code} ${message}`.trim() }
  }
  if (expectArray) {
    if (!Array.isArray(data)) {
      return { ok: false, reason: `expected an array result, got ${data === null ? 'null' : typeof data}` }
    }
    return { ok: true, data }
  }
  if (data === undefined) {
    return { ok: false, reason: 'unexpected undefined result' }
  }
  // data === null is a legitimate "no row found" outcome for a
  // .maybeSingle() call -- not a failure on its own; the caller decides
  // whether a null row is itself pass/fail for its specific assertion.
  return { ok: true, data }
}

/**
 * Fetches a URL and never throws -- a network error (e.g. the dev
 * server isn't running) becomes an explicit `{ ok: false, reason }`
 * instead of an uncaught exception that would abort the whole script
 * and leave every remaining check unreported.
 */
export async function safeFetchText(url, options) {
  try {
    const res = await fetch(url, options)
    const text = await res.text()
    return { ok: true, status: res.status, headers: res.headers, text }
  } catch (err) {
    return { ok: false, status: 0, headers: new Headers(), text: '', reason: err instanceof Error ? err.message : String(err) }
  }
}
