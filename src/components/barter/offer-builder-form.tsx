'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Check, Plus } from 'lucide-react'
import type { Listing, BarterDeliveryMethod, BarterDeliveryResponsibility, BarterDepositPayer, BarterSkillTaskPublicPost } from '@/types'
import { ContributionListEditor, contributionsValid, type ContributionInput } from './contribution-builder'

const inputClass =
  'w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20'

const DELIVERY_METHODS: { value: BarterDeliveryMethod; label: string }[] = [
  { value: 'meet_in_person', label: 'Meet in person' },
  { value: 'courier', label: 'Courier' },
  { value: 'self_collection', label: 'Self collection' },
  { value: 'other', label: 'Other (see notes)' },
]

const DELIVERY_RESPONSIBILITIES: { value: BarterDeliveryResponsibility; label: string }[] = [
  { value: 'party_a', label: 'Listing owner arranges' },
  { value: 'party_b', label: 'Proposer arranges' },
  { value: 'shared', label: 'Shared' },
  { value: 'each_handles_own', label: 'Each side handles their own item' },
  { value: 'not_applicable', label: 'Not applicable' },
]

export interface DepositTermInput {
  payer_id: string
  amount: number
  currency: string
  release_basis: 'full_on_completion' | 'milestone_weighted'
}

export interface OfferFormValues {
  party_a_listing_ids: string[]
  party_b_listing_ids: string[]
  party_a_contributions?: ContributionInput[]
  party_b_contributions?: ContributionInput[]
  deposit_terms?: DepositTermInput[]
  cash_adjustment_amount: number
  cash_adjustment_payer?: string
  delivery_method: BarterDeliveryMethod
  delivery_notes?: string
  delivery_responsibility?: BarterDeliveryResponsibility
  deposit_required: boolean
  deposit_amount?: number
  deposit_currency: string
  deposit_payer?: BarterDepositPayer
  message?: string
}

interface OfferBuilderFormProps {
  /** Which side the acting user is on -- determines whether "myListings" maps to party_a or party_b in the submitted payload. */
  currentUserRole: 'party_a' | 'party_b'
  currentUserId: string
  otherPartyId: string
  /** Active, unlocked listings owned by the acting user. */
  myListings: Listing[]
  /** Active, unlocked listings owned by the other party. */
  theirListings: Listing[]
  /** The acting user's own currently-Available Skill/Task posts, offerable as contribution provenance. */
  mySkillTaskOptions?: BarterSkillTaskPublicPost[]
  /** The other party's currently-Available Skill/Task posts, offerable as contribution provenance on their side. */
  theirSkillTaskOptions?: BarterSkillTaskPublicPost[]
  /** Pre-selected on first render (propose flow: the anchor listing). */
  initiallySelectedTheirListingIds?: string[]
  initiallySelectedMyListingIds?: string[]
  initialMyContributions?: ContributionInput[]
  initialTheirContributions?: ContributionInput[]
  defaults?: Partial<OfferFormValues>
  onSubmit: (values: OfferFormValues) => Promise<void>
  /** Called just before navigating away to create a new listing, so the caller can persist current selections (sessionStorage) across the round-trip. */
  onCreateNewListing: (currentMineIds: string[], currentTheirsIds: string[]) => void
  submitLabel: string
  submitting: boolean
  error?: string | null
}

function ListingPickerGrid({
  listings,
  selected,
  onToggle,
  emptyLabel,
}: {
  listings: Listing[]
  selected: Set<string>
  onToggle: (id: string) => void
  emptyLabel: string
}) {
  if (listings.length === 0) {
    return <p className="text-sm text-[#9B8B85] py-3">{emptyLabel}</p>
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-64 overflow-y-auto pr-1">
      {listings.map((listing) => {
        const isSelected = selected.has(listing.id)
        return (
          <button
            key={listing.id}
            type="button"
            onClick={() => onToggle(listing.id)}
            aria-pressed={isSelected}
            className={`relative text-left rounded-xl border p-2 transition-colors ${
              isSelected
                ? 'border-[#8B1A1A] bg-[#F2EDE8] dark:bg-[#2A1A1A]'
                : 'border-[#F2EDE8] dark:border-[#2A1A1A] hover:border-[#8B1A1A]/50'
            }`}
          >
            {isSelected && (
              <span className="absolute top-1.5 right-1.5 z-10 flex items-center justify-center w-5 h-5 rounded-full bg-[#8B1A1A] text-white">
                <Check size={12} strokeWidth={3} />
              </span>
            )}
            <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] mb-1.5">
              {listing.media?.[0]?.url ? (
                <Image src={listing.media[0].url} alt={listing.title} fill className="object-cover" sizes="120px" />
              ) : null}
            </div>
            <p className="text-xs font-medium text-[#1A0A0A] dark:text-[#F5F0ED] line-clamp-2">{listing.title}</p>
          </button>
        )
      })}
    </div>
  )
}

export function OfferBuilderForm({
  currentUserRole,
  currentUserId,
  otherPartyId,
  myListings,
  theirListings,
  mySkillTaskOptions = [],
  theirSkillTaskOptions = [],
  initiallySelectedTheirListingIds = [],
  initiallySelectedMyListingIds = [],
  initialMyContributions = [],
  initialTheirContributions = [],
  defaults,
  onSubmit,
  onCreateNewListing,
  submitLabel,
  submitting,
  error,
}: OfferBuilderFormProps) {
  const [selectedMine, setSelectedMine] = useState<Set<string>>(new Set(initiallySelectedMyListingIds))
  const [selectedTheirs, setSelectedTheirs] = useState<Set<string>>(new Set(initiallySelectedTheirListingIds))
  const [myContributions, setMyContributions] = useState<ContributionInput[]>(initialMyContributions)
  const [theirContributions, setTheirContributions] = useState<ContributionInput[]>(initialTheirContributions)
  const [cashAmount, setCashAmount] = useState(defaults?.cash_adjustment_amount ?? 0)
  const [cashPayer, setCashPayer] = useState<'me' | 'them' | ''>(
    defaults?.cash_adjustment_payer ? (defaults.cash_adjustment_payer === currentUserId ? 'me' : 'them') : ''
  )
  const [deliveryMethod, setDeliveryMethod] = useState<BarterDeliveryMethod>(defaults?.delivery_method ?? 'meet_in_person')
  const [deliveryNotes, setDeliveryNotes] = useState(defaults?.delivery_notes ?? '')
  const [deliveryResponsibility, setDeliveryResponsibility] = useState<BarterDeliveryResponsibility | ''>(
    defaults?.delivery_responsibility ?? ''
  )
  const [depositRequired, setDepositRequired] = useState(defaults?.deposit_required ?? false)
  const [depositAmount, setDepositAmount] = useState(defaults?.deposit_amount ?? 0)
  const [depositCurrency] = useState(defaults?.deposit_currency ?? 'ZAR')
  const [depositPayer, setDepositPayer] = useState<'me' | 'them' | 'both' | ''>(
    defaults?.deposit_payer === 'both' ? 'both' : defaults?.deposit_payer ? (defaults.deposit_payer === currentUserRole ? 'me' : 'them') : ''
  )
  // Advanced per-party deposit terms -- mutually exclusive with the
  // legacy single deposit above (mirrors depositTermSchema's own
  // exactly-one-of invariant in src/lib/barter/validation.ts). Only
  // offered once at least one side has a Skill/Task contribution.
  const [useAdvancedDeposits, setUseAdvancedDeposits] = useState(false)
  const [myDepositAmount, setMyDepositAmount] = useState(0)
  const [myDepositBasis, setMyDepositBasis] = useState<'full_on_completion' | 'milestone_weighted'>('full_on_completion')
  const [theirDepositAmount, setTheirDepositAmount] = useState(0)
  const [theirDepositBasis, setTheirDepositBasis] = useState<'full_on_completion' | 'milestone_weighted'>('full_on_completion')
  const [message, setMessage] = useState(defaults?.message ?? '')
  const [validationError, setValidationError] = useState<string | null>(null)

  const hasAnyContribution = myContributions.length > 0 || theirContributions.length > 0

  function toggleMine(id: string) {
    setSelectedMine((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleTheirs(id: string) {
    setSelectedTheirs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const otherPartyRole = currentUserRole === 'party_a' ? 'party_b' : 'party_a'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setValidationError(null)

    if (selectedMine.size === 0 && myContributions.length === 0) {
      setValidationError('Offer at least one of your own listings or Skill/Task contributions.')
      return
    }
    if (selectedTheirs.size === 0 && theirContributions.length === 0) {
      setValidationError('Request at least one listing or Skill/Task contribution.')
      return
    }
    if (!contributionsValid(myContributions) || !contributionsValid(theirContributions)) {
      setValidationError('Every Skill/Task contribution needs a title, at least one milestone, and weights that add up to 100%.')
      return
    }

    const partyAListingIds = currentUserRole === 'party_a' ? Array.from(selectedMine) : Array.from(selectedTheirs)
    const partyBListingIds = currentUserRole === 'party_b' ? Array.from(selectedMine) : Array.from(selectedTheirs)
    const partyAContributions = currentUserRole === 'party_a' ? myContributions : theirContributions
    const partyBContributions = currentUserRole === 'party_b' ? myContributions : theirContributions

    const resolvedCashPayer = cashAmount > 0 ? (cashPayer === 'me' ? currentUserId : cashPayer === 'them' ? otherPartyId : undefined) : undefined
    if (cashAmount > 0 && !resolvedCashPayer) {
      setValidationError('Choose who pays the cash adjustment.')
      return
    }

    let resolvedDepositPayer: BarterDepositPayer | undefined
    if (!useAdvancedDeposits && depositRequired) {
      if (!depositAmount || depositAmount <= 0) {
        setValidationError('Enter a deposit amount.')
        return
      }
      if (depositPayer === 'both') resolvedDepositPayer = 'both'
      else if (depositPayer === 'me') resolvedDepositPayer = currentUserRole
      else if (depositPayer === 'them') resolvedDepositPayer = otherPartyRole
      else {
        setValidationError('Choose who pays the deposit.')
        return
      }
    }

    let depositTerms: DepositTermInput[] | undefined
    if (useAdvancedDeposits) {
      depositTerms = []
      if (myDepositAmount > 0) depositTerms.push({ payer_id: currentUserId, amount: myDepositAmount, currency: depositCurrency, release_basis: myDepositBasis })
      if (theirDepositAmount > 0) depositTerms.push({ payer_id: otherPartyId, amount: theirDepositAmount, currency: depositCurrency, release_basis: theirDepositBasis })
      if (depositTerms.length === 0) depositTerms = undefined
    }

    await onSubmit({
      party_a_listing_ids: partyAListingIds,
      party_b_listing_ids: partyBListingIds,
      party_a_contributions: partyAContributions.length ? partyAContributions : undefined,
      party_b_contributions: partyBContributions.length ? partyBContributions : undefined,
      deposit_terms: depositTerms,
      cash_adjustment_amount: cashAmount,
      cash_adjustment_payer: resolvedCashPayer,
      delivery_method: deliveryMethod,
      delivery_notes: deliveryNotes || undefined,
      delivery_responsibility: deliveryResponsibility || undefined,
      deposit_required: useAdvancedDeposits ? false : depositRequired,
      deposit_amount: !useAdvancedDeposits && depositRequired ? depositAmount : undefined,
      deposit_currency: depositCurrency,
      deposit_payer: resolvedDepositPayer,
      message: message || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">You&apos;re offering</label>
          <button
            type="button"
            onClick={() => onCreateNewListing(Array.from(selectedMine), Array.from(selectedTheirs))}
            className="flex items-center gap-1 text-xs font-medium text-[#8B1A1A] hover:underline"
          >
            <Plus size={13} /> Create new listing for this trade
          </button>
        </div>
        <ListingPickerGrid
          listings={myListings}
          selected={selectedMine}
          onToggle={toggleMine}
          emptyLabel="You have no active listings to offer yet."
        />
      </div>

      <div>
        <label className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-2 block">You&apos;re requesting</label>
        <ListingPickerGrid
          listings={theirListings}
          selected={selectedTheirs}
          onToggle={toggleTheirs}
          emptyLabel="This party has no other active listings available."
        />
      </div>

      <ContributionListEditor
        title="Your Skill/Task contributions (optional)"
        contributions={myContributions}
        availablePosts={mySkillTaskOptions}
        onChange={setMyContributions}
      />

      <ContributionListEditor
        title="Their Skill/Task contributions (optional)"
        contributions={theirContributions}
        availablePosts={theirSkillTaskOptions}
        onChange={setTheirContributions}
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Cash adjustment (optional)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={cashAmount || ''}
            onChange={(e) => setCashAmount(Number(e.target.value) || 0)}
            placeholder="R 0.00"
            className={inputClass}
          />
        </div>
        {cashAmount > 0 && (
          <div>
            <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Who pays?</label>
            <select value={cashPayer} onChange={(e) => setCashPayer(e.target.value as typeof cashPayer)} className={inputClass}>
              <option value="">Select…</option>
              <option value="me">I pay</option>
              <option value="them">They pay</option>
            </select>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Delivery method</label>
          <select value={deliveryMethod} onChange={(e) => setDeliveryMethod(e.target.value as BarterDeliveryMethod)} className={inputClass}>
            {DELIVERY_METHODS.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Who arranges it?</label>
          <select
            value={deliveryResponsibility}
            onChange={(e) => setDeliveryResponsibility(e.target.value as BarterDeliveryResponsibility)}
            className={inputClass}
          >
            <option value="">Select…</option>
            {DELIVERY_RESPONSIBILITIES.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Delivery notes (optional)</label>
        <textarea
          value={deliveryNotes}
          onChange={(e) => setDeliveryNotes(e.target.value)}
          rows={2}
          placeholder="Any details about handover — location, timing…"
          className={`${inputClass} resize-none`}
        />
      </div>

      {hasAnyContribution && (
        <label className="flex items-center gap-2 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
          <input
            type="checkbox"
            checked={useAdvancedDeposits}
            onChange={(e) => {
              setUseAdvancedDeposits(e.target.checked)
              if (e.target.checked) setDepositRequired(false)
            }}
            className="accent-[#8B1A1A]"
          />
          Use itemised per-party deposits (independent amounts, can release by milestone progress)
        </label>
      )}

      {!useAdvancedDeposits && (
        <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-3.5 space-y-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
            <input type="checkbox" checked={depositRequired} onChange={(e) => setDepositRequired(e.target.checked)} className="accent-[#8B1A1A]" />
            Require a deposit
          </label>
          {depositRequired && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Amount</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={depositAmount || ''}
                  onChange={(e) => setDepositAmount(Number(e.target.value) || 0)}
                  placeholder="R 0.00"
                  className={inputClass}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Who pays?</label>
                <select value={depositPayer} onChange={(e) => setDepositPayer(e.target.value as typeof depositPayer)} className={inputClass}>
                  <option value="">Select…</option>
                  <option value="me">I pay</option>
                  <option value="them">They pay</option>
                  <option value="both">Both pay (same amount each)</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {useAdvancedDeposits && (
        <div className="rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-3.5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85]">Your deposit</p>
            <input type="number" min={0} step="0.01" value={myDepositAmount || ''} onChange={(e) => setMyDepositAmount(Number(e.target.value) || 0)} placeholder="R 0.00" className={inputClass} />
            <select value={myDepositBasis} onChange={(e) => setMyDepositBasis(e.target.value as typeof myDepositBasis)} className={inputClass}>
              <option value="full_on_completion">Full amount on completion</option>
              <option value="milestone_weighted" disabled={myContributions.length === 0}>Released by milestone progress</option>
            </select>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#9B8B85]">Their deposit</p>
            <input type="number" min={0} step="0.01" value={theirDepositAmount || ''} onChange={(e) => setTheirDepositAmount(Number(e.target.value) || 0)} placeholder="R 0.00" className={inputClass} />
            <select value={theirDepositBasis} onChange={(e) => setTheirDepositBasis(e.target.value as typeof theirDepositBasis)} className={inputClass}>
              <option value="full_on_completion">Full amount on completion</option>
              <option value="milestone_weighted" disabled={theirContributions.length === 0}>Released by milestone progress</option>
            </select>
          </div>
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">Message (optional)</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="Say a bit about your offer…"
          className={`${inputClass} resize-none`}
        />
      </div>

      {(validationError || error) && <p className="text-sm text-red-600">{validationError ?? error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors text-sm disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : submitLabel}
      </button>
    </form>
  )
}
