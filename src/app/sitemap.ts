import type { MetadataRoute } from 'next'
import { absoluteUrl, isIndexingEnabled } from '@/lib/seo/config'
import { LEGAL_DOCUMENTS } from '@/lib/legal/registry'

/**
 * Unity SEO Pre-Launch Hardening — Part H (safe sitemap foundation only).
 *
 * Deliberately reflects actual current indexability rather than a fixed
 * "safe" list: while SEO_INDEXING_ENABLED is false, every ordinary page
 * is noindex (the root layout's default), and a noindex URL should never
 * appear in a sitemap — so this returns an empty sitemap right now. Once
 * the flag is turned on, the exact same code starts listing entries with
 * zero further changes needed here.
 *
 * Listing/marketplace URLs are deliberately NOT included at all, even
 * once general indexing is enabled — listing URL architecture (slug +
 * short-id, replacing the current bare UUID path) is its own dedicated
 * future phase (see the Phase 8 SEO report's "next code phase" section).
 * Forcing today's legacy UUID URLs into a permanent sitemap now would
 * create URLs that need redirecting/invalidating the moment that phase
 * ships — city/category pages are out of scope entirely until there is
 * enough real inventory to justify them.
 *
 * Only a document whose registry `status` is 'approved' (never 'draft')
 * can ever appear here, and only using its own real `lastUpdated` field
 * — never "today" fabricated at request time.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!isIndexingEnabled()) return []

  const entries: MetadataRoute.Sitemap = [
    { url: absoluteUrl('/') },
    { url: absoluteUrl('/ambassadors') },
  ]

  for (const doc of LEGAL_DOCUMENTS) {
    if (doc.status !== 'approved') continue
    entries.push({ url: absoluteUrl(doc.route), lastModified: doc.lastUpdated })
  }

  return entries
}
