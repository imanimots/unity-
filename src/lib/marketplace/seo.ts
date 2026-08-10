import { PERMANENT_NOINDEX, isMarketplaceIndexingEnabled, type RobotsMeta } from '@/lib/seo/config'

/**
 * Statuses that are actually browsable via the public Looking For feed
 * (mirrors getMarketplaceRequests()'s own status filter exactly).
 * Everything else -- draft, matched, completed, closed, archived,
 * date_passed -- is not "active/public" for indexing purposes, even
 * though some of those statuses stay readable via RLS so an existing
 * offer thread doesn't 404.
 */
const PUBLICLY_ACTIVE_STATUSES = new Set(['active', 'offers_received'])

export function isMarketplaceRequestPubliclyActive(status: string, isTest: boolean): boolean {
  return !isTest && PUBLICLY_ACTIVE_STATUSES.has(status)
}

/**
 * Reuses the existing marketplace indexing gate (isMarketplaceIndexingEnabled(),
 * same authority /listings/[id] already uses) -- never a separate flag.
 * Resolves noindex today because that gate is globally off; only
 * becomes indexable later if the same approved gate is ever turned on,
 * and only for a request that is genuinely active/public right now.
 */
export function resolveLookingForRequestRobots(status: string, isTest: boolean): RobotsMeta {
  const eligible = isMarketplaceRequestPubliclyActive(status, isTest)
  return isMarketplaceIndexingEnabled() && eligible ? { index: true, follow: true } : PERMANENT_NOINDEX
}
