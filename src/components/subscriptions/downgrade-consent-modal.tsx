'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import type { MerchantSubscriptionPlan } from '@/types'
import { computeDowngradeChangeKeys, DOWNGRADE_REASON_CATEGORIES, type DowngradeReasonCategory } from '@/lib/subscriptions/downgrade-diff'
import type { MerchantPublicationSummary } from '@/app/api/subscriptions/me/publications/route'

interface DowngradeConsentModalProps {
  currentPlan: MerchantSubscriptionPlan
  targetPlan: MerchantSubscriptionPlan
  onClose: () => void
  onConfirmed: () => void
}

type Step = 'compare' | 'keepset' | 'reason' | 'confirm'

/**
 * Section 52's deliberate, multi-step downgrade consequence flow.
 * Nothing is submitted to the server until the FINAL confirm button on
 * the last step -- closing the modal at any earlier point leaves the
 * subscription completely unchanged (no partial API calls happen along
 * the way). Every entitlement the merchant actually loses must be
 * individually checked before "Continue" is enabled on the compare
 * step; a keep-set step only appears when their current usage exceeds
 * the target plan's cap.
 */
export function DowngradeConsentModal({ currentPlan, targetPlan, onClose, onConfirmed }: DowngradeConsentModalProps) {
  const t = useTranslations('merchant.subscriptionPage.downgradeFlow')
  const [step, setStep] = useState<Step>('compare')
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  const [publications, setPublications] = useState<MerchantPublicationSummary[] | null>(null)
  const [selectedKeepIds, setSelectedKeepIds] = useState<Set<string>>(new Set())
  const [reasonCategory, setReasonCategory] = useState<DowngradeReasonCategory>('too_expensive')
  const [reasonText, setReasonText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const changeKeys = useMemo(() => computeDowngradeChangeKeys(currentPlan, targetPlan), [currentPlan, targetPlan])
  const allAcknowledged = changeKeys.every((k) => acknowledged.has(k))
  const targetIsStarter = targetPlan.id === 'starter'

  const loadPublications = useCallback(async () => {
    const res = await fetch('/api/subscriptions/me/publications')
    if (res.ok) {
      const body = await res.json()
      setPublications(body.items)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPublications()
  }, [loadPublications])

  const needsKeepSet = publications !== null && targetPlan.active_publication_limit !== null && publications.length > targetPlan.active_publication_limit

  function toggleAck(key: string) {
    setAcknowledged((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleKeep(entityId: string) {
    setSelectedKeepIds((prev) => {
      const next = new Set(prev)
      if (next.has(entityId)) next.delete(entityId)
      else if (targetPlan.active_publication_limit === null || next.size < targetPlan.active_publication_limit) next.add(entityId)
      return next
    })
  }

  function goNext() {
    if (step === 'compare') {
      setStep(needsKeepSet ? 'keepset' : 'reason')
    } else if (step === 'keepset') {
      setStep('reason')
    } else if (step === 'reason') {
      setStep('confirm')
    }
  }

  function goBack() {
    if (step === 'confirm') setStep('reason')
    else if (step === 'reason') setStep(needsKeepSet ? 'keepset' : 'compare')
    else if (step === 'keepset') setStep('compare')
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const endpoint = targetIsStarter ? '/api/subscriptions/cancel' : '/api/subscriptions/downgrade'
      const body: Record<string, unknown> = {
        reasonCategory,
        reasonText: reasonText.trim() || undefined,
        acknowledgedChangeKeys: [...acknowledged],
        idempotency_key: crypto.randomUUID(),
      }
      if (!targetIsStarter) body.targetPlanId = targetPlan.id
      if (needsKeepSet) body.keepSetEntities = publications?.filter((p) => selectedKeepIds.has(p.entityId)).map((p) => ({ entityType: p.entityType, entityId: p.entityId }))

      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await res.json()
      if (!res.ok) {
        setError(result.error ?? t('genericError'))
        return
      }
      onConfirmed()
    } catch {
      setError(t('genericError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={t('title')}>
      <div className="bg-white dark:bg-[#1A1010] rounded-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 sm:p-8">
        <h2 className="text-lg font-extrabold uppercase tracking-tight text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{t('title')}</h2>
        <p className="text-xs text-[#9B8B85] mb-6">{t('stepLabel', { current: step === 'compare' ? 1 : step === 'keepset' ? 2 : step === 'reason' ? 3 : 4, total: needsKeepSet ? 4 : 3 })}</p>

        {step === 'compare' && (
          <div>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">{t('compareIntro', { from: currentPlan.display_name, to: targetPlan.display_name })}</p>
            <ul className="space-y-2 mb-6">
              {changeKeys.map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <input type="checkbox" id={`ack-${key}`} checked={acknowledged.has(key)} onChange={() => toggleAck(key)} className="mt-1" />
                  <label htmlFor={`ack-${key}`} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {t(`changes.${key}`)}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === 'keepset' && publications && (
          <div>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-4">
              {t('keepSetIntro', { limit: targetPlan.active_publication_limit ?? 0, count: publications.length })}
            </p>
            <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {publications.map((pub) => (
                <li key={pub.entityId} className="flex items-start gap-2">
                  <input type="checkbox" id={`keep-${pub.entityId}`} checked={selectedKeepIds.has(pub.entityId)} onChange={() => toggleKeep(pub.entityId)} className="mt-1" />
                  <label htmlFor={`keep-${pub.entityId}`} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {pub.title}
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-[#9B8B85]">{t('keepSetSelected', { selected: selectedKeepIds.size, limit: targetPlan.active_publication_limit ?? 0 })}</p>
          </div>
        )}

        {step === 'reason' && (
          <div>
            <label className="block text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] mb-2">{t('reasonLabel')}</label>
            <select value={reasonCategory} onChange={(e) => setReasonCategory(e.target.value as DowngradeReasonCategory)} className="w-full mb-4 px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm">
              {DOWNGRADE_REASON_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`reasonCategories.${cat}`)}
                </option>
              ))}
            </select>
            <textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              placeholder={t('reasonTextPlaceholder')}
              className="w-full px-3 py-2 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-transparent text-sm min-h-[80px]"
              maxLength={1000}
            />
          </div>
        )}

        {step === 'confirm' && (
          <div>
            <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] mb-2 font-semibold">{t('confirmSummary', { plan: targetPlan.display_name })}</p>
            <p className="text-xs text-[#9B8B85] mb-4">{t('confirmEffective')}</p>
            {needsKeepSet && <p className="text-xs text-[#9B8B85] mb-4">{t('confirmKeepSet', { count: selectedKeepIds.size })}</p>}
          </div>
        )}

        {error && <p className="text-xs text-red-600 dark:text-red-400 mb-4">{error}</p>}

        <div className="flex items-center justify-between gap-3 mt-4">
          <button onClick={step === 'compare' ? onClose : goBack} className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]">
            {step === 'compare' ? t('cancelAction') : t('backAction')}
          </button>
          {step !== 'confirm' ? (
            <button
              onClick={goNext}
              disabled={(step === 'compare' && !allAcknowledged) || (step === 'keepset' && selectedKeepIds.size !== (targetPlan.active_publication_limit ?? 0) && selectedKeepIds.size !== publications?.length)}
              className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-40 transition-colors"
            >
              {t('continueAction')}
            </button>
          ) : (
            <button onClick={submit} disabled={submitting} className="px-5 py-2.5 rounded-xl font-semibold uppercase text-xs tracking-[0.1em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50 transition-colors">
              {submitting ? t('working') : t('confirmAction')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
