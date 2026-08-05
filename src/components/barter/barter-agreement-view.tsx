'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { BarterStatusBadge } from './barter-status-badge'
import { BarterActions } from './barter-actions'
import { BarterFinancialStatus } from './barter-financial-status'
import { BarterTimeline } from './barter-timeline'
import { CounterOfferDialog } from './counter-offer-dialog'
import type { BarterAgreement, BarterOffer, BarterOfferItem, BarterHistoryEntry, BarterConfirmation, BarterPayment, Listing } from '@/types'

type OfferWithItems = BarterOffer & { items: (BarterOfferItem & { listing?: Listing })[] }

interface BarterAgreementViewProps {
  agreement: BarterAgreement
  offers: OfferWithItems[]
  history: BarterHistoryEntry[]
  confirmations: BarterConfirmation[]
  payments: BarterPayment[]
  partyAName: string
  partyBName: string
  currentUserId: string
  myListings: Listing[]
  theirListings: Listing[]
}

const DELIVERY_METHOD_LABELS: Record<string, string> = {
  meet_in_person: 'Meet in person', courier: 'Courier', self_collection: 'Self collection', other: 'Other',
}

function ItemGrid({ items, emptyLabel }: { items: (BarterOfferItem & { listing?: Listing })[]; emptyLabel: string }) {
  if (items.length === 0) return <p className="text-sm text-[#9B8B85]">{emptyLabel}</p>
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/listings/${item.listing_id}`}
          className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-2 hover:border-[#8B1A1A]/50 transition-colors"
        >
          <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] mb-1.5">
            {item.listing?.media?.[0]?.url ? (
              <Image src={item.listing.media[0].url} alt={item.listing.title} fill className="object-cover" sizes="120px" />
            ) : null}
          </div>
          <p className="text-xs font-medium text-[#1A0A0A] dark:text-[#F5F0ED] line-clamp-2">{item.listing?.title ?? 'Listing'}</p>
        </Link>
      ))}
    </div>
  )
}

export function BarterAgreementView({ agreement, offers, history, confirmations, payments, partyAName, partyBName, currentUserId, myListings, theirListings }: BarterAgreementViewProps) {
  const [counterOpen, setCounterOpen] = useState(false)

  const currentUserRole: 'party_a' | 'party_b' = agreement.party_a_id === currentUserId ? 'party_a' : 'party_b'
  const otherPartyId = currentUserRole === 'party_a' ? agreement.party_b_id : agreement.party_a_id
  const currentOffer = offers.find((o) => o.id === agreement.current_offer_id)
  const isCurrentProposer = currentOffer?.proposed_by === currentUserId
  const acceptedOffer = offers.find((o) => o.id === agreement.accepted_offer_id)

  const myItems = currentOffer?.items.filter((i) => i.offered_by === currentUserId) ?? []
  const theirItems = currentOffer?.items.filter((i) => i.offered_by === otherPartyId) ?? []

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-3 flex-wrap mb-2">
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            Trade {agreement.agreement_reference}
          </h1>
          <BarterStatusBadge status={agreement.status} />
        </div>
        <BarterActions
          agreementId={agreement.id}
          status={agreement.status}
          isCurrentProposer={isCurrentProposer}
          onCounterClick={() => setCounterOpen(true)}
          currentUserId={currentUserId}
          partyAId={agreement.party_a_id}
          partyBId={agreement.party_b_id}
          acceptedOffer={acceptedOffer ?? null}
          payments={payments}
          confirmations={confirmations}
        />
      </div>

      {acceptedOffer && (
        <BarterFinancialStatus
          offer={acceptedOffer}
          payments={payments}
          partyAId={agreement.party_a_id}
          partyBId={agreement.party_b_id}
          partyAName={partyAName}
          partyBName={partyBName}
        />
      )}

      {currentOffer && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Your items</h2>
              <ItemGrid items={myItems} emptyLabel="No items offered on your side." />
            </div>
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Their items</h2>
              <ItemGrid items={theirItems} emptyLabel="No items offered on their side." />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {currentOffer.cash_adjustment_amount > 0 && (
              <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
                <span className="text-[#6B5B55] dark:text-[#9B8B85]">Cash adjustment</span>
                <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">R{currentOffer.cash_adjustment_amount}</span>
              </div>
            )}
            <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">Delivery</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{DELIVERY_METHOD_LABELS[currentOffer.delivery_method] ?? currentOffer.delivery_method}</span>
            </div>
            {currentOffer.deposit_required && (
              <div className="flex justify-between items-center px-4 py-3 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
                <span className="text-[#6B5B55] dark:text-[#9B8B85]">Deposit</span>
                <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">R{currentOffer.deposit_amount} ({currentOffer.deposit_payer})</span>
              </div>
            )}
          </div>

          {currentOffer.message && (
            <div>
              <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Message</h2>
              <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{currentOffer.message}</p>
            </div>
          )}
        </>
      )}

      {confirmations.length > 0 && (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Completion confirmations</h2>
          <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">{confirmations.length} of 2 parties have confirmed completion.</p>
        </div>
      )}

      <BarterTimeline history={history} />

      <CounterOfferDialog
        open={counterOpen}
        onOpenChange={setCounterOpen}
        agreementId={agreement.id}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        otherPartyId={otherPartyId}
        myListings={myListings}
        theirListings={theirListings}
        currentMyItemIds={myItems.map((i) => i.listing_id)}
        currentTheirItemIds={theirItems.map((i) => i.listing_id)}
        defaults={
          currentOffer
            ? {
                cash_adjustment_amount: currentOffer.cash_adjustment_amount,
                cash_adjustment_payer: currentOffer.cash_adjustment_payer ?? undefined,
                delivery_method: currentOffer.delivery_method,
                delivery_notes: currentOffer.delivery_notes ?? undefined,
                delivery_responsibility: currentOffer.delivery_responsibility ?? undefined,
                deposit_required: currentOffer.deposit_required,
                deposit_amount: currentOffer.deposit_amount ?? undefined,
                deposit_currency: currentOffer.deposit_currency,
                deposit_payer: currentOffer.deposit_payer ?? undefined,
              }
            : undefined
        }
      />
    </div>
  )
}
