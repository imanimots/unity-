/**
 * Central helper for the unity_affiliate_ref cookie -- capture,
 * validation, persistence-read, consumption, expiry, and clearing all
 * live here, so no call site (the listing page, the attribution route)
 * re-implements cookie parsing.
 *
 * Step 11 Phase 7: redesigned from a single un-scoped cookie (one code,
 * last-listing-visited wins across the whole site) to one JSON-encoded
 * cookie keyed by listing id -- this is what makes "different listings
 * may use different affiliates" actually representable. Capped at the
 * 20 most-recently-visited listings (oldest evicted first) to bound
 * cookie size.
 *
 * Never stores rate, amount, or any PII -- only a referral code, a
 * listing id, and a capture timestamp. The server always re-validates
 * the code against the real profiles.affiliate_code table before it is
 * ever trusted for anything financial.
 */

export const AFFILIATE_COOKIE_NAME = 'unity_affiliate_ref'
export const AFFILIATE_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
const MAX_TRACKED_LISTINGS = 20
const AFFILIATE_CODE_PATTERN = /^AFC-[A-Z0-9]{4}$/

export interface AffiliateCookieEntry {
  code: string
  capturedAt: string
}

export type AffiliateCookiePayload = Record<string, AffiliateCookieEntry>

export function isValidAffiliateCodeFormat(code: string | null | undefined): code is string {
  return !!code && AFFILIATE_CODE_PATTERN.test(code)
}

/** Never throws -- a malformed/tampered cookie value is treated as empty, not an error. */
export function parseAffiliateCookie(raw: string | undefined | null): AffiliateCookiePayload {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: AffiliateCookiePayload = {}
    for (const [listingId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry &&
        typeof entry === 'object' &&
        isValidAffiliateCodeFormat((entry as { code?: unknown }).code as string | undefined) &&
        typeof (entry as { capturedAt?: unknown }).capturedAt === 'string'
      ) {
        result[listingId] = entry as AffiliateCookieEntry
      }
    }
    return result
  } catch {
    return {}
  }
}

export function serializeAffiliateCookie(payload: AffiliateCookiePayload): string {
  return JSON.stringify(payload)
}

function isEntryExpired(entry: AffiliateCookieEntry, now: Date): boolean {
  const capturedAt = new Date(entry.capturedAt).getTime()
  if (Number.isNaN(capturedAt)) return true
  return now.getTime() - capturedAt > AFFILIATE_COOKIE_MAX_AGE_SECONDS * 1000
}

/** Drops expired entries -- called before every read/write so a stale cookie never grows unbounded or resurfaces an old code. */
export function pruneExpiredEntries(payload: AffiliateCookiePayload, now: Date = new Date()): AffiliateCookiePayload {
  const result: AffiliateCookiePayload = {}
  for (const [listingId, entry] of Object.entries(payload)) {
    if (!isEntryExpired(entry, now)) result[listingId] = entry
  }
  return result
}

/**
 * Adds/overwrites the entry for one listing. If the listing already has
 * an entry, it is left untouched by the CALLER's own decision (this
 * function itself always overwrites) -- the listing page only calls
 * this for a listing with no existing cookie entry, matching "first
 * valid referral wins" being enforced by not re-capturing over an
 * existing one, not by this function refusing to write.
 */
export function upsertAffiliateCookieEntry(
  payload: AffiliateCookiePayload,
  listingId: string,
  code: string,
  now: Date = new Date()
): AffiliateCookiePayload {
  const pruned = pruneExpiredEntries(payload, now)
  const next: AffiliateCookiePayload = { ...pruned, [listingId]: { code, capturedAt: now.toISOString() } }

  const entries = Object.entries(next).sort((a, b) => new Date(b[1].capturedAt).getTime() - new Date(a[1].capturedAt).getTime())
  if (entries.length <= MAX_TRACKED_LISTINGS) return next

  return Object.fromEntries(entries.slice(0, MAX_TRACKED_LISTINGS))
}

export function getAffiliateCookieEntry(payload: AffiliateCookiePayload, listingId: string, now: Date = new Date()): AffiliateCookieEntry | null {
  const entry = payload[listingId]
  if (!entry || isEntryExpired(entry, now)) return null
  return entry
}

/** Consuming removes the listing's entry -- once attribution is persisted server-side, the cookie no longer needs to carry it. */
export function consumeAffiliateCookieEntry(payload: AffiliateCookiePayload, listingId: string): AffiliateCookiePayload {
  const next = { ...payload }
  delete next[listingId]
  return next
}

export function clearAffiliateCookie(): AffiliateCookiePayload {
  return {}
}

/** Browser-only. Reads the raw unity_affiliate_ref cookie value, or null if absent/SSR. */
export function readAffiliateCookieRaw(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${AFFILIATE_COOKIE_NAME}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : null
}

/** Browser-only, no-op during SSR. First-party only -- no Secure flag change from the original setter; SameSite=Lax as before. */
export function writeAffiliateCookieRaw(payload: AffiliateCookiePayload): void {
  if (typeof document === 'undefined') return
  const expires = new Date(Date.now() + AFFILIATE_COOKIE_MAX_AGE_SECONDS * 1000)
  document.cookie = `${AFFILIATE_COOKIE_NAME}=${encodeURIComponent(serializeAffiliateCookie(payload))}; path=/; expires=${expires.toUTCString()}; SameSite=Lax`
}
