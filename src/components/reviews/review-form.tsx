'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'
import type { ReviewDomain } from '@/lib/reviews/validation'

interface ReviewFormProps {
  domain: ReviewDomain
  transactionId: string
  revieweeName: string
  transactionTitle: string
  backHref: string
}

/**
 * Reviews V2 — real, server-backed review submission for all 4 domains.
 * Replaces the old fake setTimeout booking-review path
 * (src/components/trust/review-form.tsx) and the barter-only form
 * (src/components/barter/barter-review-form.tsx), both now unused.
 * Double-blind: after submission, the review stays hidden from the
 * counterpart (and from this user's own subsequent views) until either
 * they also submit, or the 14-day window expires — this form never
 * shows or implies the counterpart's rating/text.
 */
export function ReviewForm({ domain, transactionId, revieweeName, transactionTitle, backHref }: ReviewFormProps) {
  const router = useRouter()
  const t = useTranslations('reviews.form')
  const [rating, setRating] = useState(0)
  const [hoverRating, setHoverRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating < 1) {
      setError(t('chooseRating'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/reviews/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain,
          transaction_id: transactionId,
          rating,
          comment: comment.trim() || undefined,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('couldNotSubmit'))
        return
      }
      setSubmitted(true)
      router.refresh()
    } catch {
      setError(t('couldNotSubmitRetry'))
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] p-6 text-center space-y-2">
        <p className="text-sm font-semibold text-green-600 dark:text-green-400">{t('submittedTitle')}</p>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{t('submittedBlindExplainer')}</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg mx-auto font-['Plus_Jakarta_Sans']">
      <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 space-y-6">
        <div>
          <p className="text-sm text-[#9B8B85] mb-0.5">{t('reviewingTransactionFor')}</p>
          <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{transactionTitle}</p>
        </div>

        <p className="text-xs text-[#9B8B85] bg-[#F2EDE8] dark:bg-[#2A1A1A] rounded-lg px-3 py-2">{t('blindExplainer')}</p>

        <div>
          <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
            {t('rate', { reviewee: revieweeName })}
          </label>
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((s) => (
              <button
                key={s}
                type="button"
                onMouseEnter={() => setHoverRating(s)}
                onMouseLeave={() => setHoverRating(0)}
                onClick={() => setRating(s)}
                className="focus:outline-none"
                aria-label={`${s} star${s > 1 ? 's' : ''}`}
              >
                <Star
                  size={32}
                  className={s <= (hoverRating || rating) ? 'text-amber-400' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'}
                  fill="currentColor"
                />
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor={`comment-${transactionId}`} className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
            {t('writeReview')}
          </label>
          <textarea
            id={`comment-${transactionId}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('sharePlaceholder', { reviewee: revieweeName })}
            rows={4}
            className="w-full px-3 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 resize-none"
          />
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] disabled:opacity-50 transition-colors"
        >
          {submitting ? t('submitting') : t('submitReview')}
        </button>

        <Link href={backHref} className="block text-center text-xs text-[#9B8B85] hover:text-[#6B5B55] underline">
          {t('cancel')}
        </Link>
      </div>
    </form>
  )
}
