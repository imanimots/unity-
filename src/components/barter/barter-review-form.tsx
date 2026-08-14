'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Star } from 'lucide-react'

interface BarterReviewFormProps {
  agreementId: string
  revieweeName: string
}

/**
 * Optional, one-time review after an agreement reaches 'completed' --
 * never required, never blocks any other action. Hidden entirely by
 * the caller once the current user has already reviewed.
 */
export function BarterReviewForm({ agreementId, revieweeName }: BarterReviewFormProps) {
  const router = useRouter()
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit() {
    if (rating < 1) {
      setError('Choose a star rating.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/barter/${agreementId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment: comment || undefined, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not submit your review')
        return
      }
      setSubmitted(true)
      router.refresh()
    } catch {
      setError('Could not submit your review — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return <p className="text-sm text-green-600 dark:text-green-400">Thanks — your review has been submitted.</p>
  }

  return (
    <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-4 space-y-3">
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">Leave a review for {revieweeName} (optional)</h2>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onMouseEnter={() => setHoverRating(n)} onMouseLeave={() => setHoverRating(0)} onClick={() => setRating(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>
            <Star size={22} className={(hoverRating || rating) >= n ? 'fill-[#8B1A1A] text-[#8B1A1A]' : 'text-[#E8E0D8] dark:text-[#2A1A1A]'} />
          </button>
        ))}
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={3}
        placeholder="Say a bit about the trade (optional)…"
        className="w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 resize-none"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="px-5 py-2.5 rounded-xl bg-[#8B1A1A] text-white font-semibold text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit review'}
      </button>
    </div>
  )
}
