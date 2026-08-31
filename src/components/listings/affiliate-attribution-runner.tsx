'use client'

import { useEffect, useRef } from 'react'
import {
  parseAffiliateCookie,
  readAffiliateCookieRaw,
  writeAffiliateCookieRaw,
  getAffiliateCookieEntry,
  consumeAffiliateCookieEntry,
} from '@/lib/affiliate/cookie'

// A definitive server response (success, or a rejection that will never
// change on retry -- invalid code, listing not eligible, self-referral,
// idempotency conflict) consumes the cookie entry so a stale/rejected
// referral doesn't keep re-firing on every future page view. A transient
// failure (not signed in yet, rate-limited, service unavailable, network
// error) leaves the entry in place so a later visit can retry within the
// cookie's normal 30-day lifetime.
const DEFINITIVE_STATUSES = new Set([200, 400, 403, 404, 409])

/**
 * Fires the real attribution call the moment it's actually possible to:
 * an authenticated visitor viewing a listing they have a valid, not-yet-
 * consumed referral cookie entry for. This is the missing link between
 * AffiliateCookieSetter (captures ?ref=) and POST /api/affiliate/
 * attribution (was never reached by any frontend code -- see the P1
 * attribution-wiring remediation). Anonymous visitors are left alone;
 * the cookie persists until they sign in and load this listing again
 * (matches the route's own documented contract).
 *
 * One-shot per mount (guarded by a ref, safe under React Strict Mode's
 * double-invoke) -- never fires on re-render, never polls.
 */
export function AffiliateAttributionRunner({ listingId, isSignedIn }: { listingId: string; isSignedIn: boolean }) {
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current || !isSignedIn) return
    attempted.current = true

    const payload = parseAffiliateCookie(readAffiliateCookieRaw())
    const entry = getAffiliateCookieEntry(payload, listingId)
    if (!entry) return

    fetch('/api/affiliate/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        listing_id: listingId,
        referral_code: entry.code,
        // Deterministic, not random -- a duplicate call for the same
        // listing/code (Strict Mode, a second tab) hits the same
        // idempotency key rather than creating a second stored request.
        idempotency_key: `affiliate-attr-${listingId}-${entry.code}`.slice(0, 128),
      }),
    })
      .then((res) => {
        if (!DEFINITIVE_STATUSES.has(res.status)) return
        const next = consumeAffiliateCookieEntry(payload, listingId)
        writeAffiliateCookieRaw(next)
      })
      .catch(() => {
        // Network failure -- leave the cookie entry for a later retry.
      })
  }, [listingId, isSignedIn])

  return null
}
