import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { getListingsByMerchant } from '@/lib/data/listings'
import { getBarterLockedListingIds } from '@/lib/barter/listing-lock'
import { BarterAgreementView } from '@/components/barter/barter-agreement-view'
import type { BarterAgreement, BarterOffer, BarterOfferItem, BarterHistoryEntry, BarterConfirmation, BarterPayment, Listing } from '@/types'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Trade — Unity' }

type OfferWithItems = BarterOffer & { items: (BarterOfferItem & { listing?: Listing })[] }

export default async function BarterAgreementPage({ params }: PageProps) {
  const { id: agreementId } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/barter/${agreementId}`)

  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) notFound()

  const { data: agreement } = await supabase.from('barter_agreements').select('*').eq('id', agreementId).maybeSingle()
  if (!agreement) notFound() // RLS makes a non-party's row indistinguishable from nonexistent

  const [{ data: offers }, { data: history }, { data: confirmations }, { data: payments }, { data: partyProfiles }] = await Promise.all([
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
  ])

  const nameById = new Map((partyProfiles ?? []).map((p) => [p.id, p.display_name || p.full_name || 'Unity user']))

  const offerIds = (offers ?? []).map((o) => o.id)
  const { data: items } = offerIds.length
    ? await supabase.from('barter_offer_items').select('*, listing:listings(*, media:listing_media(*))').in('offer_id', offerIds)
    : { data: [] as (BarterOfferItem & { offer_id: string; listing?: Listing })[] }

  const itemsByOffer = new Map<string, (BarterOfferItem & { listing?: Listing })[]>()
  for (const item of items ?? []) {
    const list = itemsByOffer.get(item.offer_id) ?? []
    list.push(item)
    itemsByOffer.set(item.offer_id, list)
  }
  const offersWithItems: OfferWithItems[] = (offers ?? []).map((o) => ({ ...o, items: itemsByOffer.get(o.id) ?? [] }))

  const otherPartyId = agreement.party_a_id === requester.userId ? agreement.party_b_id : agreement.party_a_id

  const [myOwnListings, otherPartyListings] = await Promise.all([
    getListingsByMerchant(requester.userId),
    getListingsByMerchant(otherPartyId),
  ])
  const allListingIds = [...myOwnListings, ...otherPartyListings].map((l) => l.id)
  const lockedIds = await getBarterLockedListingIds(allListingIds)

  const myListings = myOwnListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))
  const theirListings = otherPartyListings.filter((l) => l.status === 'active' && !lockedIds.has(l.id))

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/barter" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back to trades
        </Link>
      </div>

      <BarterAgreementView
        agreement={agreement as BarterAgreement}
        offers={offersWithItems}
        history={(history ?? []) as BarterHistoryEntry[]}
        confirmations={(confirmations ?? []) as BarterConfirmation[]}
        payments={(payments ?? []) as BarterPayment[]}
        partyAName={nameById.get(agreement.party_a_id) ?? 'Unity user'}
        partyBName={nameById.get(agreement.party_b_id) ?? 'Unity user'}
        currentUserId={requester.userId}
        myListings={myListings}
        theirListings={theirListings}
      />
    </div>
  )
}
