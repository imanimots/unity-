import { PERMANENT_NOINDEX, isMarketplaceIndexingEnabled, type RobotsMeta } from '@/lib/seo/config'
import type { PublicProfileResult } from '@/lib/data/profiles'

/**
 * Reuses the existing marketplace indexing gate (isMarketplaceIndexingEnabled()),
 * same authority Looking For requests already use -- never a separate
 * flag. A not-found or suspended/unavailable profile is always
 * noindex regardless of the flag, since there's nothing genuine to
 * index in either case.
 */
export function resolveProfileRobots(status: PublicProfileResult['status']): RobotsMeta {
  if (status !== 'ok') return PERMANENT_NOINDEX
  return isMarketplaceIndexingEnabled() ? { index: true, follow: true } : PERMANENT_NOINDEX
}
