import type { NextConfig } from "next";

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
  },
  // X-Robots-Tag on genuinely non-HTML/private surfaces (Unity SEO
  // Pre-Launch Hardening, Part D/E) -- reinforces the meta-tag noindex on
  // /dashboard and /admin (which also carries its own `robots` metadata,
  // see their layout.tsx files) and is the ONLY way to communicate
  // noindex on /api, which returns JSON and has no <head> to put a meta
  // tag in.
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
        source: '/admin/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ]
  },
};

export default nextConfig;
