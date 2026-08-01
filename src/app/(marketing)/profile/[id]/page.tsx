import Image from 'next/image'
import Link from 'next/link'
import { Star, ShieldCheck, Calendar, Package, ArrowLeft } from 'lucide-react'
import { getProfile } from '@/lib/data/profiles'
import { getListingsByMerchant, getProfileReviews } from '@/lib/data/listings'

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const profile = await getProfile(id)
  return { title: profile ? `${profile.display_name ?? 'Profile'} — Unity` : 'Profile — Unity' }
}

export default async function PublicProfilePage({ params }: Props) {
  const { id } = await params
  const profile = await getProfile(id)

  if (!profile) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-4">Profile not found.</p>
          <Link href="/" className="text-sm text-[#8B1A1A] underline underline-offset-2 hover:text-[#7A1616] transition-colors">
            ← Back to home
          </Link>
        </div>
      </div>
    )
  }

  const [reviews, listings] = await Promise.all([
    getProfileReviews(id),
    getListingsByMerchant(id),
  ])

  const displayName = profile.display_name ?? 'User'
  const fullName = profile.full_name ?? displayName
  const avatarUrl = profile.avatar_url
  const joinYear = new Date(profile.created_at).getFullYear()
  const avgRating = reviews.length
    ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
    : (profile.unity_score?.toFixed(1) ?? '—')

  const starFill = (star: number, rating: number) =>
    star <= Math.floor(rating) ? 'text-amber-400 fill-amber-400' : star - 0.5 <= rating ? 'text-amber-300 fill-amber-300' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen">

      {/* Page header */}
      <div className="pt-24 pb-12 px-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010]">
        <div className="max-w-5xl mx-auto">
          <Link href="/listings" className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.08em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-8 transition-colors">
            <ArrowLeft size={13} /> Back
          </Link>

          <div className="flex items-start gap-6">
            {/* Avatar */}
            <div className="w-20 h-20 rounded-xl bg-[#F2EDE8] dark:bg-[#2A1A1A] overflow-hidden shrink-0 flex items-center justify-center text-3xl font-extrabold text-[#6B5B55] dark:text-[#9B8B85]">
              {avatarUrl ? (
                <Image src={avatarUrl} alt={displayName} width={80} height={80} className="w-full h-full object-cover" />
              ) : (
                displayName.charAt(0).toUpperCase()
              )}
            </div>

            {/* Name + meta */}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-3 mb-2">
                <h1 className="text-3xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED]">
                  {fullName}
                </h1>
                {profile.kyc_status === 'approved' && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2.5 py-1 rounded-full">
                    <ShieldCheck size={12} /> Verified
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-[#9B8B85] uppercase tracking-[0.08em]">
                <span className="flex items-center gap-1.5"><Calendar size={12} /> Joined {joinYear}</span>
                <span className="flex items-center gap-1.5"><Package size={12} /> {profile.role === 'both' ? 'Renter & Merchant' : profile.role}</span>
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="mt-8 flex items-center gap-8">
            <div>
              <div className="text-4xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none mb-1">{avgRating}</div>
              <div className="section-label text-[#9B8B85]">Unity Score</div>
            </div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star key={s} size={20} className={starFill(s, Number(avgRating))} fill="currentColor" />
              ))}
            </div>
            {reviews.length > 0 && (
              <div className="pl-4 border-l border-[#F2EDE8] dark:border-[#2A1A1A]">
                <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none mb-1">{reviews.length}</div>
                <div className="section-label text-[#9B8B85]">{reviews.length === 1 ? 'Review' : 'Reviews'}</div>
              </div>
            )}
            {listings.length > 0 && (
              <div className="pl-4 border-l border-[#F2EDE8] dark:border-[#2A1A1A]">
                <div className="text-2xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none mb-1">{listings.length}</div>
                <div className="section-label text-[#9B8B85]">Listings</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-5xl mx-auto px-4 py-12">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">

          {/* Reviews */}
          <div className="lg:col-span-2">
            <p className="section-label text-[#9B8B85] mb-3">REVIEWS</p>
            <h2 className="text-2xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-7">
              What people say
              {reviews.length > 0 && <span className="text-[#9B8B85] text-lg font-normal normal-case tracking-normal ml-2">({reviews.length})</span>}
            </h2>

            {reviews.length === 0 ? (
              <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-10 text-center">
                <p className="text-sm text-[#9B8B85]">No reviews yet.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {reviews.map((r) => {
                  const reviewerName = r.reviewer.display_name ?? r.reviewer.full_name ?? 'User'
                  return (
                    <div key={r.id} className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex items-center gap-2.5">
                          <div className="w-9 h-9 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-sm font-bold text-[#6B5B55] dark:text-[#9B8B85] shrink-0">
                            {reviewerName.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{reviewerName}</div>
                            <div className="text-xs text-[#9B8B85]">{new Date(r.created_at).toLocaleDateString('en-ZA', { year: 'numeric', month: 'short' })}</div>
                          </div>
                        </div>
                        <div className="flex gap-0.5 shrink-0">
                          {[1, 2, 3, 4, 5].map((s) => (
                            <Star key={s} size={13} className={s <= r.rating ? 'text-amber-400 fill-amber-400' : 'text-[#F2EDE8] dark:text-[#2A1A1A]'} fill="currentColor" />
                          ))}
                        </div>
                      </div>
                      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed">{r.comment}</p>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Listings sidebar */}
          <div>
            <p className="section-label text-[#9B8B85] mb-3">LISTINGS</p>
            <h2 className="text-2xl font-extrabold uppercase tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED] mb-7">
              Items
              {listings.length > 0 && <span className="text-[#9B8B85] text-lg font-normal normal-case tracking-normal ml-2">({listings.length})</span>}
            </h2>
            {listings.length === 0 ? (
              <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 text-center">
                <p className="text-sm text-[#9B8B85]">No active listings.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {listings.slice(0, 6).map((listing) => {
                  const cover = listing.media?.[0]?.url
                  return (
                    <Link
                      key={listing.id}
                      href={`/listings/${listing.id}`}
                      className="flex items-center gap-3 p-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors"
                    >
                      <div className="w-12 h-12 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
                        {cover ? (
                          <Image src={cover} alt={listing.title} width={48} height={48} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-lg">📦</div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{listing.title}</div>
                        <div className="text-xs text-[#9B8B85]">R{listing.daily_rate}/day</div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}
