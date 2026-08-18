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
    ]
  },
};

export default withNextIntl(nextConfig);
