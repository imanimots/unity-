/**
 * Deterministic decision logic for the two client-side Ads campaign
 * creation surfaces (dashboard/merchant/advertising/page.tsx and
 * .../advertising/new/page.tsx). Extracted so the "what should be shown"
 * decision is testable as a pure function, independent of JSX/rendering --
 * this codebase has no React component-rendering test convention, only
 * pure-logic unit tests, so this is the smallest presentational helper
 * that makes the behavior deterministically provable.
 */

export type AdsAvailabilityState = 'loading' | 'unavailable' | 'ready'

export function resolveAdsAvailability(loading: boolean, available: boolean): AdsAvailabilityState {
  if (loading) return 'loading'
  if (!available) return 'unavailable'
  return 'ready'
}

/**
 * Safe-by-default coercion for the `available` field returned by
 * GET /api/advertising/advertisers. Anything other than the literal
 * boolean `true` -- missing, undefined, malformed, or a failed
 * fetch entirely (caller passes undefined) -- resolves to unavailable,
 * matching isAdvertisingEnabled()'s own "unset/anything but the literal
 * true string" safe-default philosophy on the server.
 */
export function coerceAdsAvailability(value: unknown): boolean {
  return value === true
}
