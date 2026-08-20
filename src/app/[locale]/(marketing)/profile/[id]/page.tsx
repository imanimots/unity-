import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getTranslations, getMessages, getLocale } from 'next-intl/server'
import { ShieldCheck, Store, Calendar, CheckCircle2, Star } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getPublicProfile, getPublicProfileListings, getPublicProfileRequests, getPublicProfileReviews, getPublicProfileSkills, getPublicProfileTasks } from '@/lib/data/profiles'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { resolveProfileRobots } from '@/lib/profiles/seo'
import { getMostRecentSharedTransaction } from '@/lib/profiles/messaging'
import type { Locale } from '@/i18n/locales'
import { ProfileActions } from '@/components/profile/profile-actions'
import { ProfileTabs } from '@/components/profile/profile-tabs'
import { EliteBadge } from '@/components/subscriptions/elite-badge'

interface Props {
  params: Promise<{ id: string }>
}

const UUID_RE = /^[0-9a-f-]{36}$/i

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params
  if (!UUID_RE.test(id)) return { title: 'Profile — Unity', robots: { index: false, follow: false } }

  const result = await getPublicProfile(id)
  const robots = resolveProfileRobots(result.status)
  const title = result.status === 'ok' ? `${result.profile.displayName} — Unity` : 'Profile — Unity'
  return { title, robots }
}

export default async function PublicProfilePage({ params }: Props) {
  const { id } = await params
  if (!UUID_RE.test(id)) notFound()

  const locale = (await getLocale()) as Locale
  const t = await getTranslations('common')
  const tProfile = await getTranslations('common.profile')

  const result = await getPublicProfile(id)
  if (result.status === 'not_found') notFound()

  const requester = await getRequestProfile()

  if (result.status === 'unavailable') {
    return (
      <div className="min-h-screen bg-[#FAF8F5] dark:bg-[#0F0A0A] flex items-center justify-center px-4 pt-16">
        <div className="text-center max-w-sm">
          <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-4">{tProfile('unavailableNotice')}</p>
          <Link href="/" className="text-sm text-[#8B1A1A] underline underline-offset-2 hover:text-[#7A1616] transition-colors">
            {tProfile('backToHome')}
          </Link>
        </div>
      </div>
    )
  }

  const { profile } = result
  const isSelf = requester?.userId === profile.id

  const [
    { listings, total: listingsTotal },
    { requests, total: requestsTotal },
    { reviews, total: reviewsTotal },
    { posts: skillsAvailable, total: skillsAvailableTotal },
    { posts: skillsLookingFor, total: skillsLookingForTotal },
    { posts: tasksAvailable, total: tasksAvailableTotal },
    { posts: tasksLookingFor, total: tasksLookingForTotal },
    messageRef,
  ] = await Promise.all([
    getPublicProfileListings(profile.id),
    getPublicProfileRequests(profile.id),
    getPublicProfileReviews(profile.id),
    getPublicProfileSkills(profile.id, 'available'),
    getPublicProfileSkills(profile.id, 'looking_for'),
    getPublicProfileTasks(profile.id, 'available'),
    getPublicProfileTasks(profile.id, 'looking_for'),
    (async () => {
      if (!requester || isSelf) return null
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      if (!supabase) return null
      return getMostRecentSharedTransaction(supabase, requester.userId, profile.id)
    })(),
  ])

  const messageHref = messageRef ? `/chat?${messageRef.type}=${messageRef.id}` : null
  const memberSinceLabel = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(new Date(profile.memberSince))

  // Narrowly scoped nested provider (same principle as the other public
  // book/buy/listing-detail/looking-for-detail/skill-task-detail pages) --
  // ProfileTabs and ReportProfileDialog (via ProfileActions) are 'use
  // client' and need a handful of specific namespaces. Deliberately hand-
  // picked, never the full dictionary tree -- this is the exact public-
  // dictionary-leak class of bug the clickable-profiles security check
  // already caught once in this codebase (see src/app/[locale]/layout.tsx's
  // own comment on the same lesson). No admin/moderation/KYC-status
  // vocabulary is included here, nor is preferred_locale ever read from
  // this profile object (getPublicProfile only ever selects public-safe
  // columns from the public_profiles view in the first place).
  const messages = await getMessages()
  const scoped = {
    common: {
      profile: messages.common.profile,
      state: { loading: messages.common.state.loading },
    },
    skills: { label: messages.skills.label },
    tasks: { label: messages.tasks.label },
    barter: { postForm: { deliveryRemote: messages.barter.postForm.deliveryRemote, deliveryInPerson: messages.barter.postForm.deliveryInPerson, deliveryEither: messages.barter.postForm.deliveryEither } },
    marketplace: { mode: messages.marketplace.mode },
  }

  return (
    <div className="bg-[#FAF8F5] dark:bg-[#0F0A0A] min-h-screen pt-24 pb-24 px-4">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 sm:p-8 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-start gap-6">
            <div className="w-20 h-20 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] overflow-hidden shrink-0 flex items-center justify-center text-3xl font-extrabold text-[#6B5B55] dark:text-[#9B8B85]">
              {profile.avatarUrl ? (
                <Image src={profile.avatarUrl} alt="" width={80} height={80} className="w-full h-full object-cover" />
              ) : (
                <span aria-hidden="true">{profile.displayName.charAt(0).toUpperCase()}</span>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-[-0.02em] text-[#1A0A0A] dark:text-[#F5F0ED]">
                  {profile.displayName}
                </h1>
                {profile.isElite && <EliteBadge label={tProfile('eliteBadgeLabel')} size={18} />}
                {profile.isVerified && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2.5 py-1 rounded-full">
                    <ShieldCheck size={12} aria-hidden="true" /> {t('verified')}
                  </span>
                )}
                {profile.isMerchant && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.08em] text-[#8B1A1A] bg-[#8B1A1A]/10 px-2.5 py-1 rounded-full">
                    <Store size={12} aria-hidden="true" /> {tProfile('merchantBadge')}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-[#9B8B85] uppercase tracking-[0.06em] mb-4">
                <span className="flex items-center gap-1.5">
                  <Calendar size={12} aria-hidden="true" />
                  {tProfile('memberSince', { date: memberSinceLabel })}
                </span>
                {profile.completedTransactionCount > 0 && (
                  <span className="flex items-center gap-1.5">
                    <CheckCircle2 size={12} aria-hidden="true" />
                    {tProfile('completedTransactions', { count: profile.completedTransactionCount })}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {profile.publicRating !== null ? (
                  <>
                    <span className="flex items-center gap-1 text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                      <Star size={15} className="text-amber-400 fill-amber-400" aria-hidden="true" />
                      {profile.publicRating.toFixed(1)}
                    </span>
                    <span className="text-sm text-[#9B8B85]">
                      {tProfile('reviewsCount', { count: profile.reviewCount })}
                    </span>
                  </>
                ) : (
                  <span className="text-sm text-[#9B8B85]">{tProfile('noReviewsYet')}</span>
                )}
              </div>
            </div>

            <div className="shrink-0">
              {isSelf ? (
                <Link
                  href="/dashboard"
                  className="flex items-center justify-center px-5 py-2.5 border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] font-medium rounded-xl text-sm hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                >
                  {tProfile('editProfile')}
                </Link>
              ) : (
                <NextIntlClientProvider messages={scoped}>
                  <ProfileActions profileId={profile.id} messageHref={messageHref} />
                </NextIntlClientProvider>
              )}
            </div>
          </div>
        </div>

        {/* Public activity */}
        <NextIntlClientProvider messages={scoped}>
          <ProfileTabs
            profileId={profile.id}
            currentUserId={requester?.userId ?? null}
            listings={listings}
            listingsTotal={listingsTotal}
            requests={requests}
            requestsTotal={requestsTotal}
            skillsAvailable={skillsAvailable}
            skillsAvailableTotal={skillsAvailableTotal}
            skillsLookingFor={skillsLookingFor}
            skillsLookingForTotal={skillsLookingForTotal}
            tasksAvailable={tasksAvailable}
            tasksAvailableTotal={tasksAvailableTotal}
            tasksLookingFor={tasksLookingFor}
            tasksLookingForTotal={tasksLookingForTotal}
            reviews={reviews}
            reviewsTotal={reviewsTotal}
            locale={locale}
          />
        </NextIntlClientProvider>
      </div>
    </div>
  )
}
