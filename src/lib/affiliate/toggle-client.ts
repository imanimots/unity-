/**
 * Browser-side mutation for the merchant "Accept Affiliates" per-listing
 * toggle (src/app/[locale]/(dashboard)/dashboard/merchant/affiliates/page.tsx).
 * Extracted to a pure function so both outcomes -- an explicit RPC/API
 * error response and a raw fetch() rejection (offline, DNS failure,
 * connection refused) -- are exercised identically and neither can ever
 * go uncaught. Previously only the non-ok-response branch was handled;
 * a thrown fetch() had no catch anywhere in the call chain, so a network
 * failure surfaced no error to the user at all (silent failure) even
 * though nothing was actually mutated server-side.
 */

export type AffiliateToggleResult = { ok: true } | { ok: false; error: string }

export async function requestAffiliateToggle(listingId: string, enable: boolean, fallbackError: string): Promise<AffiliateToggleResult> {
  try {
    const res = await fetch(`/api/listings/${listingId}/affiliate/${enable ? 'enable' : 'disable'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    return { ok: false, error: body?.error ?? fallbackError }
  } catch {
    // fetch() itself rejected (offline, DNS failure, connection refused,
    // CORS block) -- nothing was sent/received, so this is exactly as
    // safe to report as any other failure: no mutation occurred.
    return { ok: false, error: fallbackError }
  }
}
