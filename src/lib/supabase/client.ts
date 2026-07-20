'use client'

import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || url === 'your_project_url_here' || !key) {
    // Return a client that will fail gracefully — callers check IS_MOCK_MODE before using it
    return createBrowserClient('https://placeholder.supabase.co', 'placeholder')
  }
  return createBrowserClient(url, key)
}
