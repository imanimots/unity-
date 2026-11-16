'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { CATEGORIES } from '@/types'

type TransactionType = 'buy' | 'rent' | 'barter'

/**
 * One flexible form for all 3 transaction types (Step J/K/L), not three
 * separate forms -- fields that only apply to one type render
 * conditionally. Creates a draft, then immediately publishes it
 * (two RPC calls, matching the draft->active lifecycle) so the flow
 * feels like one action to the user while still going through the real
 * draft state server-side.
 */
export function RequestForm() {
  const router = useRouter()
  const t = useTranslations('lookingFor.newRequestPage')
  const tMode = useTranslations('marketplace.mode')
  const [transactionType, setTransactionType] = useState<TransactionType>('buy')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [city, setCity] = useState('')
  const [budgetMin, setBudgetMin] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [barterOfferDescription, setBarterOfferDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const createRes = await fetch('/api/marketplace/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_type: transactionType,
          title,
          description: description || undefined,
          category: category || undefined,
          city: city || undefined,
          budget_min: budgetMin ? Number(budgetMin) : undefined,
          budget_max: budgetMax ? Number(budgetMax) : undefined,
          start_date: transactionType === 'rent' ? startDate : undefined,
          end_date: transactionType === 'rent' ? endDate : undefined,
          barter_offer_description: transactionType === 'barter' ? barterOfferDescription : undefined,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const created = await createRes.json()
      if (!createRes.ok) {
        setError(created.error ?? t('errors.couldNotCreate'))
        return
      }

      const publishRes = await fetch(`/api/marketplace/requests/${created.request_id}/publish`, { method: 'POST' })
      const published = await publishRes.json()
      if (!publishRes.ok) {
        if (published.error?.includes('verification')) {
          setError(t('errors.verificationRequired'))
        } else if (published.error?.includes('Your account cannot do this right now')) {
          setError(t('errors.accountRestricted'))
        } else {
          setError(published.error ?? t('errors.couldNotPublish'))
        }
        return
      }

      router.push(`/looking-for/${created.request_id}`)
    } catch {
      setError(t('errors.networkError'))
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full h-11 px-4 rounded-lg border border-[#E8E0D8] bg-white text-[#1A0A0A] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] transition-colors'

  return (
    <form onSubmit={handleSubmit} className="max-w-xl">
      <div className="rounded-2xl border border-[#F2EDE8] bg-white p-6 sm:p-8 space-y-5">
        <div>
          <label className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('imLookingTo')}</label>
          <div className="flex gap-2">
            {(['buy', 'rent', 'barter'] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setTransactionType(opt)}
                className={`px-4 py-2 rounded-full text-sm font-semibold capitalize transition-colors ${transactionType === opt ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55]'}`}
              >
                {tMode(opt)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="request-title" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('title')}</label>
          <input id="request-title" required value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('titlePlaceholder')} className={inputClass} />
        </div>

        <div>
          <label htmlFor="request-description" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('description')}</label>
          <textarea id="request-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputClass} h-auto py-3`} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="request-category" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('category')}</label>
            <select id="request-category" value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass}>
              <option value="">{t('selectCategory')}</option>
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="request-city" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('city')}</label>
            <input id="request-city" value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
          </div>
        </div>

        {transactionType !== 'barter' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="request-budget-min" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('budgetMin')}</label>
              <input id="request-budget-min" type="number" min={0} value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="request-budget-max" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('budgetMax')}</label>
              <input id="request-budget-max" type="number" min={0} value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} className={inputClass} />
            </div>
          </div>
        )}

        {transactionType === 'rent' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="request-start-date" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('startDate')}</label>
              <input id="request-start-date" required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label htmlFor="request-end-date" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('endDate')}</label>
              <input id="request-end-date" required type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
            </div>
          </div>
        )}

        {transactionType === 'barter' && (
          <div>
            <label htmlFor="request-barter-offer" className="block text-sm font-semibold mb-2 text-[#1A0A0A]">{t('barterOfferLabel')}</label>
            <textarea id="request-barter-offer" value={barterOfferDescription} onChange={(e) => setBarterOfferDescription(e.target.value)} rows={3} className={`${inputClass} h-auto py-3`} />
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" disabled={submitting} className="w-full sm:w-auto px-6 py-3 rounded-full font-semibold bg-[#8B1A1A] text-white hover:bg-[#7A1616] transition-colors disabled:opacity-50">
          {submitting ? t('posting') : t('postRequestButton')}
        </button>
      </div>
    </form>
  )
}
