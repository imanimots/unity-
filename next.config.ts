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
};

export default nextConfig;
