'use client'

import { useEffect } from 'react'
import {
  isValidAffiliateCodeFormat,
  parseAffiliateCookie,
  readAffiliateCookieRaw,
  writeAffiliateCookieRaw,
  upsertAffiliateCookieEntry,
  getAffiliateCookieEntry,
} from '@/lib/affiliate/cookie'

/**
 * Captures ?ref= into the canonical JSON-keyed-by-listing-id cookie
 * (src/lib/affiliate/cookie.ts), never overwriting an existing valid
 * entry for this listing -- first-valid-referral-wins is enforced here
 * by simply not re-capturing, matching upsertAffiliateCookieEntry's own
 * documented contract.
 */
export function AffiliateCookieSetter({ listingId, affiliateRef }: { listingId: string; affiliateRef: string }) {
  useEffect(() => {
    if (!isValidAffiliateCodeFormat(affiliateRef)) return

    const existing = parseAffiliateCookie(readAffiliateCookieRaw())
    if (getAffiliateCookieEntry(existing, listingId)) return

    writeAffiliateCookieRaw(upsertAffiliateCookieEntry(existing, listingId, affiliateRef))
  }, [listingId, affiliateRef])

  return null
}
