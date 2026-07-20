'use client'

import { useState, useEffect } from 'react'
import type { User } from '@supabase/supabase-js'
import type { Profile } from '@/types'
import { MOCK_CURRENT_USER, MOCK_CURRENT_PROFILE, IS_MOCK_MODE } from '@/lib/mock/data'

interface AuthState {
  user: User | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(IS_MOCK_MODE ? (MOCK_CURRENT_USER as unknown as User) : null)
  const [profile, setProfile] = useState<Profile | null>(IS_MOCK_MODE ? MOCK_CURRENT_PROFILE : null)
  const [loading, setLoading] = useState(!IS_MOCK_MODE)

  useEffect(() => {
    if (IS_MOCK_MODE) {
      setLoading(false)
      return
    }

    let mounted = true

    async function initAuth() {
      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()

        const { data: { user: currentUser } } = await supabase.auth.getUser()
        if (!mounted) return

        setUser(currentUser)

        if (currentUser) {
          const { data } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', currentUser.id)
            .single()
          if (mounted) setProfile(data)
        }

        supabase.auth.onAuthStateChange((_event, session) => {
          if (!mounted) return
          setUser(session?.user ?? null)
          if (!session?.user) setProfile(null)
        })
      } catch {
        // Supabase not configured
      } finally {
        if (mounted) setLoading(false)
      }
    }

    initAuth()
    return () => { mounted = false }
  }, [])

  const signOut = async () => {
    if (IS_MOCK_MODE) {
      window.location.href = '/'
      return
    }
    try {
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      await supabase.auth.signOut()
    } catch {}
    setUser(null)
    setProfile(null)
    window.location.href = '/'
  }

  return { user, profile, loading, signOut }
}
