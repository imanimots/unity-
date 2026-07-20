import type { Profile } from '@/types'
import { MOCK_PROFILES, MOCK_CURRENT_PROFILE, IS_MOCK_MODE } from '@/lib/mock/data'

export async function getProfile(id: string): Promise<Profile | null> {
  if (IS_MOCK_MODE) {
    return MOCK_PROFILES.find((p) => p.id === id) ?? null
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return null

  const { data } = await supabase.from('profiles').select('*').eq('id', id).single()
  return data
}

export async function getServerUser() {
  if (IS_MOCK_MODE) {
    return { user: null, profile: null }
  }

  try {
    const { createClient } = await import('@/lib/supabase/server')
    const supabase = await createClient()
    if (!supabase) return { user: null, profile: null }

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { user: null, profile: null }

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    return { user, profile }
  } catch {
    return { user: null, profile: null }
  }
}

export { MOCK_CURRENT_PROFILE }
