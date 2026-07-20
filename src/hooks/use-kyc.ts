'use client'

import { useState, useEffect } from 'react'

export type KycStatus = 'none' | 'pending' | 'approved' | 'rejected'

const STORAGE_KEY = 'unity_mock_kyc'

export function useKyc() {
  // Default to approved so the mock user can book without completing KYC every time.
  // Navigate to /verify to see the full flow.
  const [status, setStatus] = useState<KycStatus>('approved')
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as KycStatus | null
    if (stored) setStatus(stored)
    setHydrated(true)
  }, [])

  const approve = () => {
    localStorage.setItem(STORAGE_KEY, 'approved')
    setStatus('approved')
  }

  const reset = () => {
    localStorage.setItem(STORAGE_KEY, 'none')
    setStatus('none')
  }

  return { status, isApproved: status === 'approved', approve, reset, hydrated }
}
