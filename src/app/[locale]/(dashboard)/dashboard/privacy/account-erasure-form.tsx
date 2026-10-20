'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAuth } from '@/hooks/use-auth'

type Phase = 'idle' | 'confirming' | 'submitting' | 'blocked' | 'success' | 'error'

function newIdempotencyKey(): string {
  return `erase-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function AccountErasureForm() {
  const t = useTranslations('privacy.erasure')
  const { signOut } = useAuth()

  const [phase, setPhase] = useState<Phase>('idle')
  const [confirmText, setConfirmText] = useState('')
  const [reasons, setReasons] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [cleanupPending, setCleanupPending] = useState(false)

  const confirmPhrase = t('confirmPhrase')

  async function submitErasure() {
    setPhase('submitting')
    setErrorMessage(null)
    try {
      const res = await fetch('/api/account/erase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotency_key: newIdempotencyKey() }),
      })
      const body = await res.json().catch(() => ({}))

      if (res.status === 409 && body.status === 'blocked') {
        setReasons(body.reasons ?? [])
        setPhase('blocked')
        return
      }
      if (!res.ok) {
        setErrorMessage(body.error ?? t('errorGeneric'))
        setPhase('error')
        return
      }

      setCleanupPending(body.cleanup_status === 'pending')
      setPhase('success')
      setTimeout(() => {
        signOut()
      }, 1800)
    } catch {
      setErrorMessage(t('errorGeneric'))
      setPhase('error')
    }
  }

  if (phase === 'success') {
    return (
      <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-6 space-y-2">
        <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('successTitle')}</h2>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          {cleanupPending ? t('successBodyCleanupPending') : t('successBody')}
        </p>
      </div>
    )
  }

  if (phase === 'blocked') {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-[#1A1010] dark:border-amber-900/40 p-6 space-y-3">
        <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('blockedTitle')}</h2>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{t('blockedIntro')}</p>
        <ul className="list-disc pl-5 text-sm text-[#6B5B55] dark:text-[#9B8B85] space-y-1">
          {reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{t('blockedOutro')}</p>
        <button
          onClick={() => setPhase('idle')}
          className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] underline"
        >
          {t('cancelButton')}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-white dark:bg-[#1A1010] p-6 space-y-4">
      <div>
        <h2 className="text-lg font-bold text-red-700 dark:text-red-400">{t('warningTitle')}</h2>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">{t('warningBody')}</p>
      </div>

      {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}

      {phase === 'confirming' || phase === 'submitting' ? (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
            {t('confirmLabel')}
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={t('confirmPlaceholder')}
              className="mt-1 w-full rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <div className="flex gap-3">
            <button
              disabled={confirmText !== confirmPhrase || phase === 'submitting'}
              onClick={submitErasure}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium disabled:opacity-40"
            >
              {phase === 'submitting' ? t('submittingButton') : t('confirmButton')}
            </button>
            <button
              onClick={() => {
                setPhase('idle')
                setConfirmText('')
              }}
              className="px-4 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]"
            >
              {t('cancelButton')}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setPhase('confirming')}
          className="px-4 py-2 rounded-lg border border-red-300 dark:border-red-900/50 text-sm font-medium text-red-700 dark:text-red-400"
        >
          {t('startButton')}
        </button>
      )}
    </div>
  )
}
