'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

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
        setError(created.error ?? 'Could not create request')
        return
      }

      const publishRes = await fetch(`/api/marketplace/requests/${created.request_id}/publish`, { method: 'POST' })
      const published = await publishRes.json()
      if (!publishRes.ok) {
        if (published.error?.includes('verification')) {
          setError('You need to complete verification before publishing a request. Your request was saved as a draft.')
        } else {
          setError(published.error ?? 'Could not publish request')
        }
        return
      }

      router.push(`/looking-for/${created.request_id}`)
    } catch {
      setError('Network error — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'w-full h-11 px-4 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30'

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-5">
      <div>
        <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">I&apos;m looking to</label>
        <div className="flex gap-2">
          {(['buy', 'rent', 'barter'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTransactionType(t)}
              className={`px-4 py-2 rounded-full text-sm font-semibold capitalize transition-colors ${transactionType === t ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Title</label>
        <input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Looking for a pressure washer" className={inputClass} />
      </div>

      <div>
        <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputClass} h-auto py-3`} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Category</label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">City</label>
          <input value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
        </div>
      </div>

      {transactionType !== 'barter' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Budget min (ZAR)</label>
            <input type="number" min={0} value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Budget max (ZAR)</label>
            <input type="number" min={0} value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} className={inputClass} />
          </div>
        </div>
      )}

      {transactionType === 'rent' && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">Start date</label>
            <input required type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">End date</label>
            <input required type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
          </div>
        </div>
      )}

      {transactionType === 'barter' && (
        <div>
          <label className="block text-sm font-semibold mb-2 text-[#1A0A0A] dark:text-[#F5F0ED]">What can you offer in return?</label>
          <textarea value={barterOfferDescription} onChange={(e) => setBarterOfferDescription(e.target.value)} rows={3} className={`${inputClass} h-auto py-3`} />
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <button type="submit" disabled={submitting} className="px-6 py-3 rounded-full font-semibold bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50">
        {submitting ? 'Posting…' : 'Post request'}
      </button>
    </form>
  )
}
