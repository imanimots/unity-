import { notFound, redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { getListingsByMerchant } from '@/lib/data/listings'
import { getBarterLockedListingIds } from '@/lib/barter/listing-lock'
import { BarterAgreementView } from '@/components/barter/barter-agreement-view'
import { withLocalePrefix, type Locale } from '@/i18n/locales'
import type {
  BarterAgreement, BarterOffer, BarterOfferItem, BarterHistoryEntry, BarterConfirmation, BarterPayment,
  BarterContributionDetails, BarterDepositTerm, BarterMilestoneEvidence, BarterSkillTaskPublicPost,
} from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Trade — Unity' }

type OfferWithItems = BarterOffer & { items: BarterOfferItem[] }

export default async function BarterAgreementPage({ params }: PageProps) {
  const { id: agreementId } = await params
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix(`/dashboard/barter/${agreementId}`, locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: agreement } = await supabase.from('barter_agreements').select('*').eq('id', agreementId).maybeSingle()
  if (!agreement) notFound() // RLS makes a non-party's row indistinguishable from nonexistent

  const [{ data: offers }, { data: history }, { data: confirmations }, { data: payments }, { data: partyProfiles }, { data: myReview }] = await Promise.all([
    supabase.from('barter_offers').select('*').eq('agreement_id', agreementId).order('version', { ascending: true }),
    supabase.from('barter_history').select('*').eq('agreement_id', agreementId).order('created_at', { ascending: true }),
    supabase.from('barter_confirmations').select('*').eq('agreement_id', agreementId),
    // Step 11 Phase 4 -- deposit/cash-adjustment payment rows.
    supabase.from('payments').select('*').eq('barter_agreement_id', agreementId),
    // public_profiles, not the base `profiles` table -- either party
    // reading the OTHER party's identity here is a public-identity
    // read, not a self-read, and the base table's RLS is now
    // auth.uid() = id only (see
    // supabase/migrations/20260831000001_profiles_privacy_boundary.sql).
    supabase.from('public_profiles').select('id, display_name, full_name').in('id', [agreement.party_a_id, agreement.party_b_id]),
    // Skills + Tasks under Barter -- has the current user already reviewed this agreement?
    supabase.from('reviews').select('id').eq('barter_agreement_id', agreementId).eq('reviewer_id', requester.userId).maybeSingle(),
  ])

  const nameById = new Map((partyProfiles ?? []).map((p) => [p.id, p.display_name || p.full_name || 'Unity user']))

  const offerIds = (offers ?? []).map((o) => o.id)
  const { data: items } = offerIds.length
    ? await supabase
        .from('barter_offer_items')
        .select('*, listing:listings(*, media:listing_media(*)), contribution_details:barter_contribution_details(*), milestones:barter_contribution_milestones(*)')
        .in('offer_id', offerIds)
    : { data: [] as (BarterOfferItem & { offer_id: string })[] }

  // contribution_details is a 1:1 embed (PK = offer_item_id) -- PostgREST
  // returns it as an object when it recognizes the FK as unique, but
  // normalize defensively in case it comes back as a single-element array.
  const normalizedItems = (items ?? []).map((item) => {
    const raw = item as unknown as BarterOfferItem & { offer_id: string; contribution_details?: BarterContributionDetails | BarterContributionDetails[] | null }
    const details = Array.isArray(raw.contribution_details) ? raw.contribution_details[0] : raw.contribution_details
    return { ...raw, contribution_details: details ?? undefined } as BarterOfferItem & { offer_id: string }
  })

  const itemsByOffer = new Map<string, BarterOfferItem[]>()
  for (const item of normalizedItems) {
    const list = itemsByOffer.get(item.offer_id) ?? []
    list.push(item)
    itemsByOffer.set(item.offer_id, list)
  }
  const offersWithItems: OfferWithItems[] = (offers ?? []).map((o) => ({ ...o, items: itemsByOffer.get(o.id) ?? [] }))

  const acceptedOfferWithItems = offersWithItems.find((o) => o.id === agreement.accepted_offer_id)
  const acceptedMilestoneIds = (acceptedOfferWithItems?.items ?? []).flatMap((i) => (i.milestones ?? []).map((m) => m.id))

  const [{ data: depositTerms }, { data: evidenceRows }] = await Promise.all([
    offerIds.length ? supabase.from('barter_deposit_terms').select('*').in('offer_id', offerIds) : Promise.resolve({ data: [] as BarterDepositTerm[] }),
    acceptedMilestoneIds.length
      ? supabase.from('barter_milestone_evidence').select('*').in('milestone_id', acceptedMilestoneIds).order('created_at', { ascending: true })
      : Promise.resolve({ data: [] as BarterMilestoneEvidence[] }),
  ])

  const evidenceByMilestone: Record<string, BarterMilestoneEvidence[]> = {}
  for (const row of (evidenceRows ?? []) as BarterMilestoneEvidence[]) {
    const list = evidenceByMilestone[row.milestone_id] ?? []
    list.push(row)
    evidenceByMilestone[row.milestone_id] = list
  }

  const otherPartyId = agreement.party_a_id === requester.userId ? agreement.party_b_id : agreement.party_a_id

  const [myOwnListings, otherPartyListings, { data: mySkillTaskOptions }, { data: theirSkillTaskOptions }] = await Promise.all([
    getListingsByMerchant(requester.userId),
    getListingsByMerchant(otherPartyId),
    supabase.from('barter_skill_task_public_posts').select('*').eq('owner_id', requester.userId).eq('direction', 'available'),
    supabase.from('barter_skill_task_public_posts').select('*').eq('owner_id', otherPartyId).eq('direction', 'available'),
  ])
  const allListingIds = [...myOwnListings, ...otherPartyListings].map((l) => l.id)
  const lockedIds = await getBarterLockedListingIds(allListingIds)

  const myListings = myOwnListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
  const theirListings = otherPartyListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))

  const t = await getTranslations('barter')

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/barter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('backToTrades')}
        </Link>
      </div>

      <BarterAgreementView
        agreement={agreement as BarterAgreement}
        offers={offersWithItems}
        history={(history ?? []) as BarterHistoryEntry[]}
        confirmations={(confirmations ?? []) as BarterConfirmation[]}
        payments={(payments ?? []) as BarterPayment[]}
        depositTerms={(depositTerms ?? []) as BarterDepositTerm[]}
        evidenceByMilestone={evidenceByMilestone}
        alreadyReviewed={!!myReview}
        partyAName={nameById.get(agreement.party_a_id) ?? 'Unity user'}
        partyBName={nameById.get(agreement.party_b_id) ?? 'Unity user'}
        currentUserId={requester.userId}
        myListings={myListings}
        theirListings={theirListings}
        mySkillTaskOptions={(mySkillTaskOptions ?? []) as BarterSkillTaskPublicPost[]}
        theirSkillTaskOptions={(theirSkillTaskOptions ?? []) as BarterSkillTaskPublicPost[]}
      />
    </div>
  )
}
