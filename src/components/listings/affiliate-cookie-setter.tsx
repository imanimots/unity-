'use client'

import { useEffect } from 'react'

export function AffiliateCookieSetter({ affiliateRef }: { affiliateRef: string }) {
  useEffect(() => {
    if (!affiliateRef?.startsWith('AFC-')) return
    const expires = new Date()
    expires.setDate(expires.getDate() + 30)
    document.cookie = `unity_affiliate_ref=${affiliateRef}; path=/; expires=${expires.toUTCString()}; SameSite=Lax`
  }, [affiliateRef])

  return null
}
