'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  const [rating, setRating] = useState(existingRating ?? 0)
  const [hovered, setHovered] = useState(0)
  const [comment, setComment] = useState(existingComment ?? '')
  const [submitting, setSubmitting] = useState(false)

  const hasExisting = Boolean(existingRating)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating === 0) { toast.error('Please select a star rating'); return }
    if (comment.trim().length < 10) { toast.error('Please write at least 10 characters'); return }

    setSubmitting(true)
    await new Promise((r) => setTimeout(r, 1000))
    toast.success('Review submitted — thank you!')
    router.push(backHref)
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg mx-auto font-['Plus_Jakarta_Sans']">
      <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 space-y-6">
        <div>
          <p className="text-sm text-[#9B8B85] mb-0.5">Reviewing booking for</p>
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
            <p className="text-sm text-[#9B8B85]">You&apos;ve already reviewed this booking.</p>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-2 italic">&ldquo;{comment}&rdquo;</p>
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
                Rate {revieweeLabel}
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
                  {['', 'Poor', 'Below average', 'Average', 'Good', 'Excellent'][rating]}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={`comment-${bookingId}`} className="block text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] mb-2">
                Write a review
              </label>
              <textarea
                id={`comment-${bookingId}`}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={`Share your experience with ${revieweeLabel}…`}
                rows={4}
                className="w-full px-3 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20 resize-none"
              />
              <div className="flex justify-between mt-1">
                <span className="text-xs text-[#9B8B85]">Minimum 10 characters</span>
                <span className={`text-xs ${comment.length < 10 ? 'text-[#9B8B85]' : 'text-green-500'}`}>
                  {comment.length} chars
                </span>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] disabled:opacity-50 transition-colors"
            >
              {submitting ? 'Submitting…' : 'Submit review'}
            </button>
          </>
        )}
      </div>
    </form>
  )
}
