/**
 * Platform improvement programme, Phase 3 item 13 (consent management).
 * Audit finding: docs/ARCHITECTURE.md listed a cookie-consent banner as
 * a requirement under "Security Requirements" but it was never built --
 * src/lib/analytics/client.ts's trackEvent() fired unconditionally for
 * every visitor from first page load.
 *
 * Scope: there is currently no GA4/Meta/TikTok integration anywhere in
 * this codebase (confirmed by this programme's own audit) -- the only
 * thing to gate is this app's own first-party behavioral analytics
 * (src/lib/analytics/*). This module's job is exactly that gate, ready
 * to extend to a third-party tracker's own consent-mode hook the day
 * one is actually added (see the brief's own instruction: "Ensure GA4,
 * Meta Pixel and other non-essential trackers follow the configured
 * consent choices" -- there is nothing to wire up yet, but
 * hasAnalyticsConsent() is the one function such an integration would
 * call).
 *
 * Deliberately per-browser (localStorage), not a server-recorded
 * consent receipt -- this is a cookie-banner-style preference, not a
 * legal-document acceptance. src/app/api/legal/accept/route.ts +
 * legal_acceptances already cover the latter (terms/privacy/popia
 * checkboxes at registration/booking/KYC) and are untouched by this
 * module. Final legal wording and whether a server-recorded consent
 * receipt is also required under POPIA is explicitly flagged for
 * South African legal/privacy review in this programme's final report
 * -- this is a technical gate, not a legal opinion.
 */

export const CONSENT_STORAGE_KEY = 'unity_consent_preferences_v1'
export const CONSENT_VERSION = 1

export interface ConsentPreferences {
  /** Strictly necessary for the service to function (auth session, cart/checkout state). Always true -- there is no UI to disable this, matching standard cookie-banner conventions. */
  essential: true
  /** Gates src/lib/analytics/client.ts's trackEvent() -- page views, search behavior, listing views. Off by default until the visitor explicitly opts in. */
  analytics: boolean
  /** Reserved for the day a third-party ad/marketing pixel is actually added (none exists today). Off by default, never implicitly turned on by an analytics choice. */
  marketing: boolean
  version: number
  decidedAt: string
}

const DEFAULT_PREFERENCES_DECIDED: Omit<ConsentPreferences, 'decidedAt'> = {
  essential: true,
  analytics: false,
  marketing: false,
  version: CONSENT_VERSION,
}

/** Null means "no choice recorded yet" -- the banner should still be shown. Never defaults to an opted-in state. */
export function readConsentPreferences(): ConsentPreferences | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ConsentPreferences>
    if (parsed.version !== CONSENT_VERSION) return null
    if (typeof parsed.analytics !== 'boolean' || typeof parsed.marketing !== 'boolean' || typeof parsed.decidedAt !== 'string') return null
    return { essential: true, analytics: parsed.analytics, marketing: parsed.marketing, version: CONSENT_VERSION, decidedAt: parsed.decidedAt }
  } catch {
    return null
  }
}

export function writeConsentPreferences(choice: { analytics: boolean; marketing: boolean }): void {
  if (typeof window === 'undefined') return
  try {
    const next: ConsentPreferences = { ...DEFAULT_PREFERENCES_DECIDED, ...choice, decidedAt: new Date().toISOString() }
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('unity-consent-changed', { detail: next }))
  } catch {
    // Storage can throw (private browsing, quota, disabled storage) --
    // the banner itself handles a null read by showing again; a failed
    // write is never allowed to crash the page.
  }
}

/** True only after an explicit, stored opt-in. No consent recorded yet (or storage unavailable) resolves to false -- never fail open. */
export function hasAnalyticsConsent(): boolean {
  return readConsentPreferences()?.analytics === true
}

export function hasMarketingConsent(): boolean {
  return readConsentPreferences()?.marketing === true
}

export function hasDecidedConsent(): boolean {
  return readConsentPreferences() !== null
}
