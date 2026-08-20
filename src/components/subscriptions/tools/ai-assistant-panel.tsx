'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import type { MerchantEntitlements } from '@/lib/subscriptions/entitlements'

/**
 * Section 14-17: merchant-facing assistant surface. Pro gets the
 * listing/offer assistant; Elite additionally gets the analytics/
 * trends assistant. Every response is a SUGGESTION -- nothing here
 * writes to any listing/offer/analytics record automatically.
 */
export function AiAssistantPanel({ entitlements }: { entitlements: MerchantEntitlements }) {
  const t = useTranslations('merchant.tools.ai')
  const [mode, setMode] = useState<'listing' | 'analytics'>(entitlements.listingAssistantEnabled ? 'listing' : 'analytics')
  const [draftText, setDraftText] = useState('')
  const [question, setQuestion] = useState('')
  const [response, setResponse] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function askListing() {
    setLoading(true)
    setError(null)
    setResponse(null)
    try {
      const res = await fetch('/api/merchant-ai/listing-assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftText }) })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? t('genericError'))
        return
      }
      setResponse(body.suggestions)
    } catch {
      setError(t('genericError'))
    } finally {
      setLoading(false)
    }
  }

  async function askAnalytics() {
    setLoading(true)
    setError(null)
    setResponse(null)
    try {
      const res = await fetch('/api/merchant-ai/analytics-assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) })
      const body = await res.json()
      if (!res.ok) {
        setError(body.error ?? t('genericError'))
        return
      }
      setResponse(body.answer)
    } catch {
      setError(t('genericError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-6">
      {entitlements.listingAssistantEnabled && entitlements.analyticsAssistantEnabled && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setMode('listing')} className={`text-xs uppercase px-3 py-1.5 rounded-lg ${mode === 'listing' ? 'bg-[#8B1A1A] text-white' : 'text-[#9B8B85]'}`}>
            {t('listingTab')}
          </button>
          <button onClick={() => setMode('analytics')} className={`text-xs uppercase px-3 py-1.5 rounded-lg ${mode === 'analytics' ? 'bg-[#8B1A1A] text-white' : 'text-[#9B8B85]'}`}>
            {t('analyticsTab')}
          </button>
        </div>
      )}

      {mode === 'listing' && entitlements.listingAssistantEnabled && (
        <div>
          <p className="text-xs text-[#9B8B85] mb-3">{t('listingIntro')}</p>
          <textarea value={draftText} onChange={(e) => setDraftText(e.target.value)} placeholder={t('listingPlaceholder')} className="w-full px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm min-h-[100px] mb-3" />
          <button onClick={askListing} disabled={loading || !draftText.trim()} className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors">
            {loading ? t('working') : t('askAction')}
          </button>
        </div>
      )}

      {mode === 'analytics' && entitlements.analyticsAssistantEnabled && (
        <div>
          <p className="text-xs text-[#9B8B85] mb-3">{t('analyticsIntro')}</p>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('analyticsPlaceholder')} className="w-full px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm mb-3" />
          <button onClick={askAnalytics} disabled={loading || !question.trim()} className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors">
            {loading ? t('working') : t('askAction')}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-3">{error}</p>}
      {response && (
        <div className="mt-4 p-4 rounded-lg bg-[#F2EDE8] dark:bg-[#2A1A1A]">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-2">{t('suggestionLabel')}</p>
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{response}</p>
        </div>
      )}
    </div>
  )
}
