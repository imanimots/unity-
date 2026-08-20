'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'

/** Elite-only public business-name branding settings (Section 19). */
export function BusinessNameSettings() {
  const t = useTranslations('merchant.subscriptionPage.businessName')
  const [businessName, setBusinessName] = useState('')
  const [publicName, setPublicName] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/subscriptions/business-name')
      if (res.ok) {
        const body = await res.json()
        setBusinessName(body.businessName ?? '')
        setPublicName(body.publicName)
        setEnabled(body.businessNameEnabled)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  async function save() {
    setSaving(true)
    setSaved(false)
    try {
      const res = await fetch('/api/subscriptions/business-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessName }) })
      if (res.ok) setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  if (loading || !enabled) return null

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6 mb-8">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-2">{t('title')}</p>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{t('description', { fallback: publicName ?? '' })}</p>
      <div className="flex items-center gap-3">
        <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder={t('placeholder')} maxLength={200} className="flex-1 px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm" />
        <button onClick={save} disabled={saving} className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors">
          {saving ? t('working') : t('saveAction')}
        </button>
      </div>
      {saved && <p className="text-xs text-green-700 dark:text-green-400 mt-2">{t('saved')}</p>}
    </div>
  )
}
