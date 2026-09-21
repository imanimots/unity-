import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
      },
      {
        // Public listing/avatar photos served from Supabase Storage --
        // found missing during Step 3 live validation (the merchant
        // listings page 500'd on next/image with any real listing photo,
        // a pre-existing gap unrelated to admin moderation, fixed here
        // since it blocked verifying the merchant-facing UI).
        protocol: 'https',
        hostname: '*.supabase.co',
      },
    ],
    // AVIF checked first (best compression), WebP as the fallback for
    // browsers that don't support it — Next.js otherwise only serves
    // WebP by default (Unity SEO Pre-Launch Hardening, Part K).
    formats: ['image/avif', 'image/webp'],
  },
  // X-Robots-Tag on genuinely non-HTML/private surfaces (Unity SEO
  // Pre-Launch Hardening, Part D/E) -- reinforces the meta-tag noindex on
  // /dashboard and /admin (which also carries its own `robots` metadata,
  // see their layout.tsx files) and is the ONLY way to communicate
  // noindex on /api, which returns JSON and has no <head> to put a meta
  // tag in. /dashboard is now reachable under locale prefixes too (i18n
  // Phase 2) -- /af/dashboard and /zu/dashboard get the identical header;
  // /admin is never locale-prefixed (stays English-only, outside the
  // [locale] segment), so it needs only its original unprefixed rule.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/dashboard/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/af/dashboard/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/zu/dashboard/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      {
        source: '/admin/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
      // Security Hardening -- Phase F, Commit A. Global baseline security
      // headers, applied to every route. CSP ships Report-Only first
      // (Security Hardening Phase E's own rollout decision) -- it does
      // NOT enforce frame-ancestors, so X-Frame-Options: DENY is the
      // actual active clickjacking-protection layer for now, not a
      // redundant legacy fallback. No report-uri/report-to directive is
      // set: no real report-collection endpoint exists in this repo yet,
      // and inventing one would be indistinguishable from real telemetry
      // while doing nothing -- violations surface in-browser (devtools
      // console) during controlled testing instead. Every source in the
      // policy below is derived from the actual external-origin
      // inventory audited in Whole-Site Security & Evidence Closure --
      // Phase D / Security Hardening Phase E (Supabase REST + Storage +
      // Realtime, and the picsum.photos placeholder image host already
      // present in `images.remotePatterns` above) -- no bare `*` source
      // anywhere. HSTS is production-only (guarded below) so a plain-HTTP
      // local dev server is never told to force HTTPS.
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy-Report-Only',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://*.supabase.co https://picsum.photos",
              "font-src 'self'",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
              "frame-src 'self'",
              "worker-src 'self'",
              "media-src 'self' https://*.supabase.co",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
            : []),
        ],
      },
    ]
  },
};

export default withNextIntl(nextConfig);
