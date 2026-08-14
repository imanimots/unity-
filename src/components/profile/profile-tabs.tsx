'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Star } from 'lucide-react'
import { ProfileLink } from '@/components/shared/profile-link'
import type { PublicProfileListing, PublicProfileRequest, PublicProfileReview, PublicProfileSkillTaskPost } from '@/lib/data/profiles'

interface Props {
  profileId: string
  currentUserId: string | null
  listings: PublicProfileListing[]
  listingsTotal: number
  requests: PublicProfileRequest[]
  requestsTotal: number
  skillsAvailable: PublicProfileSkillTaskPost[]
  skillsAvailableTotal: number
  skillsLookingFor: PublicProfileSkillTaskPost[]
  skillsLookingForTotal: number
  tasksAvailable: PublicProfileSkillTaskPost[]
  tasksAvailableTotal: number
  tasksLookingFor: PublicProfileSkillTaskPost[]
  tasksLookingForTotal: number
  reviews: PublicProfileReview[]
  reviewsTotal: number
}

type TabKey = 'available' | 'looking-for' | 'skills' | 'tasks' | 'reviews'
type SubDirection = 'available' | 'looking_for'

function SkillTaskPostGrid({ posts, emptyLabel }: { posts: PublicProfileSkillTaskPost[]; emptyLabel: string }) {
  if (posts.length === 0) return <EmptyState message={emptyLabel} />
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {posts.map((post) => (
        <Link
          key={post.id}
          href={`/barter/skill-task/${post.id}`}
          className="p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
        >
          <div className="text-xs uppercase tracking-[0.08em] text-[#9B8B85] mb-1">
            {post.kind} · {post.delivery_mode.replace('_', ' ')}
          </div>
          <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate mb-1">{post.title}</div>
          {post.description && <p className="text-xs text-[#9B8B85] line-clamp-2">{post.description}</p>}
        </Link>
      ))}
    </div>
  )
}

function SubDirectionToggle({ value, onChange, availableCount, lookingForCount }: { value: SubDirection; onChange: (v: SubDirection) => void; availableCount: number; lookingForCount: number }) {
  const options: { key: SubDirection; label: string; count: number }[] = [
    { key: 'available', label: 'Available', count: availableCount },
    { key: 'looking_for', label: 'Looking For', count: lookingForCount },
  ]
  return (
    <div className="inline-flex rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] p-0.5 mb-4">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            value === o.key ? 'bg-[#8B1A1A] text-white' : 'text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]'
          }`}
        >
          {o.label} ({o.count})
        </button>
      ))}
    </div>
  )
}

function normalizedListingPrice(l: PublicProfileListing): string {
  if (l.daily_rate !== null) return `R${l.daily_rate}/day`
  if (l.sale_price !== null) return `R${l.sale_price}`
  return ''
}

export function ProfileTabs({
  profileId,
  currentUserId,
  listings,
  listingsTotal,
  requests,
  requestsTotal,
  skillsAvailable,
  skillsAvailableTotal,
  skillsLookingFor,
  skillsLookingForTotal,
  tasksAvailable,
  tasksAvailableTotal,
  tasksLookingFor,
  tasksLookingForTotal,
  reviews: initialReviews,
  reviewsTotal,
}: Props) {
  const [tab, setTab] = useState<TabKey>('available')
  const [skillsDirection, setSkillsDirection] = useState<SubDirection>('available')
  const [tasksDirection, setTasksDirection] = useState<SubDirection>('available')
  const [reviews, setReviews] = useState(initialReviews)
  const [reviewsOffset, setReviewsOffset] = useState(initialReviews.length)
  const [loadingMore, setLoadingMore] = useState(false)

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'available', label: 'Available', count: listingsTotal },
    { key: 'looking-for', label: 'Looking For', count: requestsTotal },
    { key: 'skills', label: 'Skills', count: skillsAvailableTotal + skillsLookingForTotal },
    { key: 'tasks', label: 'Tasks', count: tasksAvailableTotal + tasksLookingForTotal },
    { key: 'reviews', label: 'Reviews', count: reviewsTotal },
  ]

  async function loadMoreReviews() {
    setLoadingMore(true)
    try {
      const res = await fetch(`/api/profile/${profileId}/reviews?offset=${reviewsOffset}`)
      const data = await res.json()
      setReviews((prev) => [...prev, ...(data.reviews ?? [])])
      setReviewsOffset((prev) => prev + (data.reviews?.length ?? 0))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div>
      <div role="tablist" aria-label="Public activity" className="flex gap-1 border-b border-[#F2EDE8] dark:border-[#2A1A1A] mb-6">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
              const idx = tabs.findIndex((x) => x.key === tab)
              const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
              setTab(tabs[next].key)
            }}
            className={`px-4 py-3 text-sm font-semibold border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? 'border-[#8B1A1A] text-[#1A0A0A] dark:text-[#F5F0ED]'
                : 'border-transparent text-[#9B8B85] hover:text-[#6B5B55] dark:hover:text-[#F5F0ED]'
            }`}
          >
            {t.label} <span className="text-[#9B8B85]">({t.count})</span>
          </button>
        ))}
      </div>

      {tab === 'available' && (
        <div role="tabpanel">
          {listings.length === 0 ? (
            <EmptyState message="No active listings right now." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {listings.map((listing) => (
                <Link
                  key={listing.id}
                  href={`/listings/${listing.id}`}
                  className="flex items-center gap-3 p-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                >
                  <div className="w-14 h-14 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0 flex items-center justify-center text-lg">
                    {listing.media?.[0]?.url ? (
                      <Image src={listing.media[0].url} alt={listing.title} width={56} height={56} className="w-full h-full object-cover" />
                    ) : (
                      '📦'
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{listing.title}</div>
                    <div className="text-xs text-[#9B8B85]">{normalizedListingPrice(listing)}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'looking-for' && (
        <div role="tabpanel">
          {requests.length === 0 ? (
            <EmptyState message="No active Looking For requests right now." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {requests.map((req) => (
                <Link
                  key={req.id}
                  href={`/looking-for/${req.id}`}
                  className="p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                >
                  <div className="text-xs uppercase tracking-[0.08em] text-[#9B8B85] mb-1">{req.transaction_type.replace('_', '-')}</div>
                  <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{req.title}</div>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'skills' && (
        <div role="tabpanel">
          <SubDirectionToggle value={skillsDirection} onChange={setSkillsDirection} availableCount={skillsAvailableTotal} lookingForCount={skillsLookingForTotal} />
          <SkillTaskPostGrid
            posts={skillsDirection === 'available' ? skillsAvailable : skillsLookingFor}
            emptyLabel={skillsDirection === 'available' ? 'No Skills offered right now.' : 'Not looking for any Skills right now.'}
          />
        </div>
      )}

      {tab === 'tasks' && (
        <div role="tabpanel">
          <SubDirectionToggle value={tasksDirection} onChange={setTasksDirection} availableCount={tasksAvailableTotal} lookingForCount={tasksLookingForTotal} />
          <SkillTaskPostGrid
            posts={tasksDirection === 'available' ? tasksAvailable : tasksLookingFor}
            emptyLabel={tasksDirection === 'available' ? 'No Tasks offered right now.' : 'Not looking for any Tasks right now.'}
          />
        </div>
      )}

      {tab === 'reviews' && (
        <div role="tabpanel">
          {reviews.length === 0 ? (
            <EmptyState message="No reviews yet." />
          ) : (
            <div className="space-y-4">
              {reviews.map((r) => (
                <div key={r.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] overflow-hidden flex items-center justify-center text-sm font-bold text-[#6B5B55] dark:text-[#9B8B85] shrink-0">
                        {r.reviewer?.avatarUrl ? (
                          <Image src={r.reviewer.avatarUrl} alt="" width={36} height={36} className="w-full h-full object-cover" />
                        ) : (
                          (r.reviewer?.displayName ?? '?').charAt(0).toUpperCase()
                        )}
                      </div>
                      <div>
                        <ProfileLink
                          userId={r.reviewer?.id}
                          displayName={r.reviewer?.displayName ?? 'Unity Member'}
                          currentUserId={currentUserId}
                          className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]"
                        />
                        <div className="text-xs text-[#9B8B85]">{new Date(r.created_at).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short' })}</div>
                      </div>
                    </div>
                    <div className="flex gap-0.5 shrink-0" aria-label={`${r.rating} out of 5 stars`}>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star key={s} size={13} className={s <= r.rating ? 'text-amber-400 fill-amber-400' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'} fill="currentColor" />
                      ))}
                    </div>
                  </div>
                  {r.comment && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{r.comment}</p>}
                </div>
              ))}
              {reviews.length < reviewsTotal && (
                <button
                  type="button"
                  onClick={loadMoreReviews}
                  disabled={loadingMore}
                  className="w-full py-2.5 border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-medium rounded-xl text-sm hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load more reviews'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-10 text-center">
      <p className="text-sm text-[#9B8B85]">{message}</p>
    </div>
  )
}
