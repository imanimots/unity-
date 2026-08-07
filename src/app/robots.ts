import type { MetadataRoute } from 'next'
import { absoluteUrl, isIndexingEnabled } from '@/lib/seo/config'

/**
 * Unity SEO Pre-Launch Hardening — Part G.
 *
 * Deliberately NOT a blanket `Disallow: /` merely because indexing is
 * currently disabled — that would make every page's `noindex` directive
 * unobservable to a crawler that can't even reach it. Only genuinely
 * private, auth-gated infrastructure (/dashboard/, /admin/, /api/) is
 * disallowed here; public-but-low-value pages (login/register/chat,
 * draft legal pages) rely on their own `noindex` meta instead (see
 * their layout.tsx/page.tsx files) and stay crawlable so that directive
 * is actually seen.
 *
 * Query-parameter patterns are disallowed to avoid crawl traps on the
 * browse page's faceted search (?q=/?category=/?sort=/?maxPrice=/?mode=)
 * and on affiliate/UTM tracking parameters — none of these are ever
 * meant to be indexed as separate URLs from the canonical page.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: [
        '/dashboard/',
        '/admin/',
        '/api/',
        '/*?q=',
        '/*?sort=',
        '/*?category=',
        '/*?maxPrice=',
        '/*?mode=',
        '/*?ref=',
        '/*&ref=',
        '/*utm_source=',
        '/*utm_medium=',
        '/*utm_campaign=',
      ],
    },
    // Never advertise a sitemap while the site isn't meant to be indexed
    // — doing so would misrepresent a public-test deployment as
    // indexing-ready. Exposed automatically once SEO_INDEXING_ENABLED
    // flips on, using the configured app URL (never a hardcoded domain).
    ...(isIndexingEnabled() ? { sitemap: absoluteUrl('/sitemap.xml') } : {}),
  }
}
