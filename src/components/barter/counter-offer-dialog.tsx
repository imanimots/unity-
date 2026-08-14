'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { OfferBuilderForm, type OfferFormValues } from './offer-builder-form'
import type { ContributionInput } from './contribution-builder'
import type { Listing, BarterSkillTaskPublicPost } from '@/types'

interface CounterOfferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agreementId: string
  currentUserId: string
  currentUserRole: 'party_a' | 'party_b'
  otherPartyId: string
  myListings: Listing[]
  theirListings: Listing[]
  mySkillTaskOptions?: BarterSkillTaskPublicPost[]
  theirSkillTaskOptions?: BarterSkillTaskPublicPost[]
  defaults?: Partial<OfferFormValues>
  currentMyItemIds: string[]
  currentTheirItemIds: string[]
  currentMyContributions?: ContributionInput[]
  currentTheirContributions?: ContributionInput[]
}

const draftKey = (agreementId: string) => `barter-counter-draft:${agreementId}`

function readDraft(agreementId: string): { mine: string[]; theirs: string[] } | null {
  const raw = sessionStorage.getItem(draftKey(agreementId))
  if (!raw) return null
  try {
    return JSON.parse(raw) as { mine: string[]; theirs: string[] }
  } catch {
    return null // Malformed/expired draft — fall through.
  }
}

/** The spec's "Counter-offer modal" — a thin wrapper over offer-builder-form, symmetric with propose-trade-button. */
export function CounterOfferDialog({
  open,
  onOpenChange,
  agreementId,
  currentUserId,
  currentUserRole,
  otherPartyId,
  myListings,
  theirListings,
  mySkillTaskOptions = [],
  theirSkillTaskOptions = [],
  defaults,
  currentMyItemIds,
  currentTheirItemIds,
  currentMyContributions = [],
  currentTheirContributions = [],
}: CounterOfferDialogProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isReturningFromWizard =
    typeof window !== 'undefined' &&
    searchParams.get('returnTo') === 'barter-propose' &&
    searchParams.get('agreement') === agreementId &&
    searchParams.get('counter') === '1'

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Computed once via a lazy useState initializer, not an effect — see
  // propose-trade-button.tsx's matching comment for why. `open` itself
  // stays a controlled prop from the parent (BarterAgreementView) since
  // it's shared state, not local — the effect below still needs to call
  // onOpenChange(true) to actually open it, which is a plain prop-function
  // call rather than a local setState, so it isn't subject to the same
  // constraint.
  const [restored] = useState(() => (isReturningFromWizard ? readDraft(agreementId) : null))

  useEffect(() => {
    if (isReturningFromWizard) {
      onOpenChange(true)
      router.replace(`/dashboard/barter/${agreementId}`, { scroll: false })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleCreateNewListing(mineIds: string[], theirsIds: string[]) {
    sessionStorage.setItem(draftKey(agreementId), JSON.stringify({ mine: mineIds, theirs: theirsIds }))
    router.push(`/dashboard/merchant/listings/new?returnTo=barter-propose&agreement=${agreementId}&counter=1`)
  }

  async function handleSubmit(values: OfferFormValues) {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/barter/${agreementId}/counter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Could not submit your counter-offer')
        return
      }
      sessionStorage.removeItem(draftKey(agreementId))
      onOpenChange(false)
      router.refresh()
    } catch {
      setError('Could not submit your counter-offer — please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Counter this offer</DialogTitle>
          <DialogDescription>Adjust the items, cash, delivery, or deposit terms and send a new offer.</DialogDescription>
        </DialogHeader>
        <OfferBuilderForm
          currentUserRole={currentUserRole}
          currentUserId={currentUserId}
          otherPartyId={otherPartyId}
          myListings={myListings}
          theirListings={theirListings}
          mySkillTaskOptions={mySkillTaskOptions}
          theirSkillTaskOptions={theirSkillTaskOptions}
          initiallySelectedMyListingIds={restored?.mine ?? currentMyItemIds}
          initiallySelectedTheirListingIds={restored?.theirs ?? currentTheirItemIds}
          initialMyContributions={currentMyContributions}
          initialTheirContributions={currentTheirContributions}
          defaults={defaults}
          onSubmit={handleSubmit}
          onCreateNewListing={handleCreateNewListing}
          submitLabel="Send counter-offer"
          submitting={submitting}
          error={error}
        />
      </DialogContent>
    </Dialog>
  )
}
