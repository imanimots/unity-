/**
 * Central SEO configuration helper (Unity SEO Pre-Launch Hardening,
 * Part D). One place every page/route reads indexation state and the
 * app's own absolute URL from — nothing else in the app should read
 * `process.env.SEO_INDEXING_ENABLED`/`SEO_MARKETPLACE_INDEXING_ENABLED`/
 * `NEXT_PUBLIC_APP_URL` directly.
 *
 * Two independent gates, both safe-default false:
 *   - SEO_INDEXING_ENABLED: ordinary brand/informational pages (home,
 *     ambassadors, static pages once approved). When false, the ROOT
 *     layout's default `robots` is noindex,nofollow — every page inherits
 *     it unless it sets its own `robots` (Next.js metadata merges
 *     per-field; an explicit child `robots` always wins over the parent).
 *   - SEO_MARKETPLACE_INDEXING_ENABLED: marketplace/listing surfaces
 *     (browse, listing detail). Deliberately independent of the flag
 *     above — flipping general indexing on must never silently expose
 *     marketplace pages too.
 *
 * Neither flag is turned on by this phase. Turning SEO_INDEXING_ENABLED
 * on does NOT affect the permanent-noindex surfaces in Part E (auth,
 * dashboard, admin, chat) or the draft-legal-page mechanism in Part F —
 * both set their own `robots` explicitly and are never driven by this
 * flag at all.
 */

export type RobotsMeta = { index: boolean; follow: boolean }

export const PERMANENT_NOINDEX: RobotsMeta = { index: false, follow: false }

function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

/** Ordinary brand/informational pages — the root layout's default. */
export function isIndexingEnabled(): boolean {
  return readBooleanFlag(process.env.SEO_INDEXING_ENABLED)
}

/** Marketplace/listing surfaces (browse, listing detail) — independent of isIndexingEnabled(). */
export function isMarketplaceIndexingEnabled(): boolean {
  return readBooleanFlag(process.env.SEO_MARKETPLACE_INDEXING_ENABLED)
}

/** The default `robots` value every ordinary page inherits from the root layout. */
export function getDefaultRobotsMeta(): RobotsMeta {
  return isIndexingEnabled() ? { index: true, follow: true } : PERMANENT_NOINDEX
}

/** For browse/listing-detail pages specifically — never follows the general gate. */
export function getMarketplaceRobotsMeta(): RobotsMeta {
  return isMarketplaceIndexingEnabled() ? { index: true, follow: true } : PERMANENT_NOINDEX
}

/**
 * The app's own configured base URL — never the future permanent domain,
 * never hardcoded. Falls back to localhost only for local dev where
 * NEXT_PUBLIC_APP_URL is unset.
 */
export function getAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return raw.replace(/\/+$/, '')
}

/** Builds an absolute URL from a site-relative path, using the configured app URL. */
export function absoluteUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `${getAppUrl()}${normalizedPath}`
}
