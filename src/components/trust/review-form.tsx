'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Star } from 'lucide-react'
import { toast } from 'sonner'

interface ReviewFormProps {
  bookingId: string
  listingTitle: string
  revieweeLabel: string  // "your merchant" / "your renter"
  backHref: string
  existingRating?: number
  existingComment?: string
}

export function ReviewForm({ bookingId, listingTitle, revieweeLabel, backHref, existingRating, existingComment }: ReviewFormProps) {
  const router = useRouter()
  const t = useTranslations('rent.review')
  const [rating, setRating] = useState(existingRating ?? 0)
  const [hovered, setHovered] = useState(0)
  const [comment, setComment] = useState(existingComment ?? '')
  const [submitting, setSubmitting] = useState(false)

  const hasExisting = Boolean(existingRating)
  const ratingWordKeys = ['', 'poor', 'belowAverage', 'average', 'good', 'excellent'] as const

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating === 0) { toast.error(t('errorSelectRating')); return }
    if (comment.trim().length < 10) { toast.error(t('errorTooShort')); return }

    setSubmitting(true)
    await new Promise((r) => setTimeout(r, 1000))
    toast.success(t('success'))
    router.push(backHref)
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg mx-auto font-['Plus_Jakarta_Sans']">
      <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 space-y-6">
        <div>
          <p className="text-sm text-[#9B8B85] mb-0.5">{t('reviewingBookingFor')}</p>
          <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{listingTitle}</p>
        </div>

        {hasExisting ? (
          <div className="text-center py-4">
            <div className="flex justify-center gap-1 mb-2">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star
                  key={s}
                  size={28}
                  className={s <= rating ? 'text-amber-400' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'}
                  fill="currentColor"
                />
              ))}
            </div>
            <p className="text-sm text-[#9B8B85]">{t('alreadyReviewed')}</p>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-2 italic">&ldquo;{comment}&rdquo;</p>
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
                {t('rate', { reviewee: revieweeLabel })}
              </label>
              <div className="flex gap-2">
                {[1, 2, 3, 4, 5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onMouseEnter={() => setHovered(s)}
                    onMouseLeave={() => setHovered(0)}
                    onClick={() => setRating(s)}
                    className="focus:outline-none"
                  >
                    <Star
                      size={32}
                      className={s <= (hovered || rating) ? 'text-amber-400' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'}
                      fill="currentColor"
                    />
                  </button>
                ))}
              </div>
              {rating > 0 && (
                <p className="text-xs text-[#9B8B85] mt-1">
                  {t(`ratingWords.${ratingWordKeys[rating]}`)}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={`comment-${bookingId}`} className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
                {t('writeReview')}
              </label>
              <textarea
                id={`comment-${bookingId}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t('sharePlaceholder', { reviewee: revieweeLabel })}
                rows={4}
                className="w-full px-3 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 resize-none"
              />
              <div className="flex justify-between mt-1">
                <span className="text-xs text-[#9B8B85]">{t('minChars')}</span>
                <span className={`text-xs ${comment.length < 10 ? 'text-[#9B8B85]' : 'text-green-500'}`}>
                  {t('charCount', { count: comment.length })}
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] disabled:opacity-50 transition-colors"
            >
              {submitting ? t('submitting') : t('submitReview')}
            </button>
          </>
        )}
      </div>
    </form>
  )
}
