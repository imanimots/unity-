'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Repeat } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { OfferBuilderForm, type OfferFormValues } from './offer-builder-form'
import type { Listing } from '@/types'

interface ProposeTradeButtonProps {
  anchorListing: Listing
  currentUserId: string
  /** Viewer's own active, unlocked listings. */
  myListings: Listing[]
  /** The anchor listing owner's active, unlocked listings (includes the anchor itself). */
  ownerListings: Listing[]
  className?: string
}

const draftKey = (anchorId: string) => `barter-offer-draft:${anchorId}`

function readDraft(anchorId: string): { mine: string[]; theirs: string[] } | null {
  const raw = sessionStorage.getItem(draftKey(anchorId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as { mine: string[]; theirs: string[] }
  } catch {
    return null // Malformed/expired draft — fall through to a fresh dialog.
  }
}

/**
 * "Propose Trade" entry point on a listing's detail page — the spec's
 * "Proposal modal". The viewer is always party_b (proposer) here; the
 * anchor listing's owner is party_a. Selections survive the "create a
 * new listing" round-trip via sessionStorage (see offer-builder-form's
 * onCreateNewListing callback) — the wizard itself is reused completely
 * unmodified, this component only restores which listings were already
 * chosen when the user returns.
 */
export function ProposeTradeButton({ anchorListing, currentUserId, myListings, ownerListings, className }: ProposeTradeButtonProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isReturningFromWizard =
    typeof window !== 'undefined' && searchParams.get('returnTo') === 'barter-propose' && searchParams.get('anchor') === anchorListing.id

  // Computed once, at mount, via a lazy useState initializer — the
  // React-compiler-approved way to seed one-time initial state from an
  // external source (here: the URL + sessionStorage, after returning from
  // the "create a new listing" round-trip). Since this depends on
  // `window`, the server-rendered pass and the client's first paint can
  // disagree for the rare case of landing directly on this URL — React
  // self-heals a hydration mismatch by re-rendering with the client
  // value, and the only user-visible effect here is the dialog opening
  // one paint later than ideal, which is an acceptable tradeoff for not
  // needing a setState call inside an effect.
  const [open, setOpen] = useState(() => isReturningFromWizard)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restored] = useState(() => (isReturningFromWizard ? readDraft(anchorListing.id) : null))

  useEffect(() => {
    // Pure external-navigation side effect — cleans the return-flow query
    // params off the URL once. No setState here; `open`/`restored` are
    // already correctly seeded above.
    if (isReturningFromWizard) {
      router.replace(`/listings/${anchorListing.id}`, { scroll: false })
    }
    // Only ever run on first mount for this page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleCreateNewListing(mineIds: string[], theirsIds: string[]) {
    sessionStorage.setItem(draftKey(anchorListing.id), JSON.stringify({ mine: mineIds, theirs: theirsIds }))
    router.push(`/dashboard/merchant/listings/new?returnTo=barter-propose&anchor=${anchorListing.id}`)
  }

  async function handleSubmit(values: OfferFormValues) {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/barter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anchor_listing_id: anchorListing.id,
          ...values,
          idempotency_key: crypto.randomUUID(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not submit your trade proposal')
        return
      }
      sessionStorage.removeItem(draftKey(anchorListing.id))
      setOpen(false)
      router.push(`/dashboard/barter/${data.agreement_id}`)
    } catch {
      setError('Could not submit your trade proposal — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          'flex items-center justify-center gap-2 w-full py-3 border border-[#8B1A1A] text-[#8B1A1A] font-semibold rounded-xl text-sm hover:bg-[#8B1A1A]/5 transition-colors'
        }
      >
        <Repeat size={16} /> Propose Trade
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Propose a trade</DialogTitle>
            <DialogDescription>Offer one or more of your listings in exchange for {anchorListing.title}.</DialogDescription>
          </DialogHeader>
          <OfferBuilderForm
            currentUserRole="party_b"
            currentUserId={currentUserId}
            otherPartyId={anchorListing.merchant_id}
            myListings={myListings}
            theirListings={ownerListings}
            initiallySelectedTheirListingIds={restored?.theirs ?? [anchorListing.id]}
            initiallySelectedMyListingIds={restored?.mine ?? []}
            onSubmit={handleSubmit}
            onCreateNewListing={handleCreateNewListing}
            submitLabel="Send trade proposal"
            submitting={submitting}
            error={error}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
