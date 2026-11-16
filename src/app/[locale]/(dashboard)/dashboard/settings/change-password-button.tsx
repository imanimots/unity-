'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'

interface ChangePasswordButtonProps {
  email: string | null
}

/** Reuses the existing, real password-recovery mechanism (POST
 * /api/auth/forgot-password) -- there is no separate in-session
 * change-password endpoint, so "Change password" in Settings sends the
 * same reset email an unauthenticated visitor would request, prefilled
 * with the signed-in user's own address. */
export function ChangePasswordButton({ email }: ChangePasswordButtonProps) {
  const t = useTranslations('account.settingsPage')
  const locale = useLocale()
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function send() {
    if (!email) return
    setStatus('sending')
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, locale }),
      })
      setStatus(res.ok ? 'sent' : 'error')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div>
      <button
        onClick={send}
        disabled={status === 'sending' || status === 'sent' || !email}
        className="px-4 py-2 rounded-lg border border-[#F2EDE8] text-sm font-semibold text-[#1A0A0A] hover:bg-[#F2EDE8] transition-colors disabled:opacity-50"
      >
        {status === 'sending' ? t('sending') : t('sendResetEmail')}
      </button>
      {status === 'sent' && <p className="text-xs text-green-700 mt-2">{t('resetEmailSent')}</p>}
      {status === 'error' && <p className="text-xs text-red-600 mt-2">{t('resetEmailFailed')}</p>}
    </div>
  )
}
