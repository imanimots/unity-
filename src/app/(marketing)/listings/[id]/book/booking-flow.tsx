'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { DayPicker, type DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'
import {
  ArrowLeft, ArrowRight, ShieldCheck, CheckCircle,
  Calendar, CreditCard, Star, Info, UserCheck,
} from 'lucide-react'
import type { Listing } from '@/types'
import Image from 'next/image'

type Step = 'dates' | 'review' | 'payment' | 'confirmed'

const STEP_LABELS: Record<Step, string> = {
  dates: 'Select dates',
  review: 'Review booking',
  payment: 'Payment',
  confirmed: 'Confirmed',
}

const STEPS: Step[] = ['dates', 'review', 'payment', 'confirmed']

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.indexOf(current)
  return (
    <div className="flex items-center gap-2 mb-10">
      {STEPS.filter((s) => s !== 'confirmed').map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors ${
              i < idx
                ? 'bg-green-500 text-white'
                : i === idx
                ? 'bg-[#8B1A1A] text-white'
                : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#9B8B85]'
            }`}
          >
            {i < idx ? <CheckCircle size={15} /> : i + 1}
          </div>
          <span
            className={`section-label hidden sm:block ${
              i === idx ? 'text-[#1A0A0A] dark:text-[#F5F0ED]' : ''
            }`}
          >
            {STEP_LABELS[step]}
          </span>
          {i < 2 && <div className="w-8 h-px bg-[#F2EDE8] dark:bg-[#2A1A1A] mx-1" />}
        </div>
      ))}
    </div>
  )
}

const UNAVAILABLE_DATES = [
  new Date(2026, 5, 15), new Date(2026, 5, 16), new Date(2026, 5, 17),
  new Date(2026, 5, 22), new Date(2026, 5, 23),
  new Date(2026, 6, 4), new Date(2026, 6, 5),
]

// ─── Eligibility gate components ──────────────────────────────────────────────

function KycGate({ listingId }: { listingId: string }) {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-6">
        <ShieldCheck size={32} className="text-amber-500" />
      </div>
      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
        Identity Verification Required
      </h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        You need to complete KYC verification before booking. It takes less than 2 minutes.
      </p>
      <Link
        href={`/verify?redirectTo=/listings/${listingId}/book`}
        className="inline-flex items-center gap-2 px-6 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors"
      >
        <ShieldCheck size={15} /> Verify my identity
      </Link>
    </div>
  )
}

function ScoreGate({ listingId, required, actual }: { listingId: string; required: number; actual: number }) {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-6">
        <Star size={32} className="text-amber-500" />
      </div>
      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
        Unity Score Too Low
      </h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-2">
        Your Unity Score is{' '}
        <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{actual.toFixed(1)}</strong> — this listing
        requires <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{required}+</strong>.
      </p>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        Improve your score by completing more rentals and collecting positive reviews.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/listings"
          className="inline-flex items-center justify-center gap-2 px-5 py-3 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl text-sm hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
        >
          Browse other listings
        </Link>
        <Link
          href={`/listings/${listingId}`}
          className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors"
        >
          Back to listing
        </Link>
      </div>
    </div>
  )
}

function CreditGate({ listingId }: { listingId: string }) {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-6">
        <UserCheck size={32} className="text-amber-500" />
      </div>
      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
        Identity Verification Required
      </h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        This merchant requires renters to have a verified identity before booking. Complete KYC verification — it
        takes less than 2 minutes.
      </p>
      <Link
        href={`/verify?redirectTo=/listings/${listingId}/book`}
        className="inline-flex items-center gap-2 px-6 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors"
      >
        <UserCheck size={15} /> Verify my identity
      </Link>
    </div>
  )
}

// ─── Main booking flow ────────────────────────────────────────────────────────

export function BookingFlow({ listing }: { listing: Listing }) {
  const [step, setStep] = useState<Step>('dates')
  const [kycApproved, setKycApproved] = useState(true)
  const [renterScore, setRenterScore] = useState(4.5)
  const [range, setRange] = useState<DateRange | undefined>()
  const [paymentProcessing, setPaymentProcessing] = useState(false)
  const [bookingRef] = useState(() => `UNI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`)

  useEffect(() => {
    const storedKyc = localStorage.getItem('unity_mock_kyc')
    const storedScore = localStorage.getItem('unity_mock_score')
    if (storedKyc && storedKyc !== 'approved') setKycApproved(false)
    if (storedScore) setRenterScore(parseFloat(storedScore))
  }, [])

  const coverImage = listing.media?.[0]?.url

  const days =
    range?.from && range?.to
      ? Math.max(1, Math.ceil((range.to.getTime() - range.from.getTime()) / 86400000))
      : listing.min_rental_days

  const useWeeklyRate = days >= 7 && listing.weekly_rate
  const rate = useWeeklyRate ? listing.weekly_rate! / 7 : listing.daily_rate
  const rentalFee = Math.round(rate * days)
  const deposit = listing.deposit_required ? (listing.deposit_amount ?? 0) : 0
  const insurance = listing.insurance_amount ? listing.insurance_amount * days : 0
  const total = rentalFee + deposit + insurance

  const canProceedDates = !!(range?.from && range?.to && days >= listing.min_rental_days)

  async function handlePayment() {
    setPaymentProcessing(true)
    await new Promise((r) => setTimeout(r, 2000))

    // Record affiliate referral if tracking cookie is present
    if (listing.accepts_affiliates) {
      const match = document.cookie.match(/unity_affiliate_ref=([^;]+)/)
      const affiliateCode = match?.[1]
      if (affiliateCode) {
        try {
          await fetch('/api/affiliate/referral', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              affiliateCode,
              listingId: listing.id,
              commissionRate: listing.affiliate_commission_rate,
              rentalFee,
            }),
          })
          document.cookie = 'unity_affiliate_ref=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
        } catch {
          // Non-critical: referral tracking failure doesn't block the booking confirmation
        }
      }
    }

    setPaymentProcessing(false)
    setStep('confirmed')
  }

  // Eligibility checks — evaluated after state is initialized
  if (!kycApproved && !listing.requires_credit_score) {
    return <KycGate listingId={listing.id} />
  }
  if (listing.min_unity_score > 0 && renterScore < listing.min_unity_score) {
    return <ScoreGate listingId={listing.id} required={listing.min_unity_score} actual={renterScore} />
  }
  if (listing.requires_credit_score && !kycApproved) {
    return <CreditGate listingId={listing.id} />
  }

  const ListingSummary = () => (
    <div className="flex items-center gap-4 p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] mb-8">
      <div className="relative w-16 h-14 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
        {coverImage && <Image src={coverImage} alt={listing.title} fill className="object-cover" sizes="64px" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm leading-snug line-clamp-2">
          {listing.title}
        </p>
        <div className="flex items-center gap-1 mt-1 text-xs text-[#9B8B85]">
          <Star size={10} className="text-amber-400 fill-amber-400" />
          <span>{listing.merchant?.unity_score?.toFixed(1)}</span>
          <span>· {listing.merchant?.display_name}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="font-extrabold text-[#8B1A1A] text-lg leading-tight">R{listing.daily_rate}</p>
        <p className="text-xs text-[#9B8B85]">/day</p>
      </div>
    </div>
  )

  const PriceBreakdown = () => (
    <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-3 text-sm">
      <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
        <span>
          R{Math.round(rate)} × {days} day{days !== 1 ? 's' : ''}
        </span>
        <span>R{rentalFee}</span>
      </div>
      {listing.deposit_required && (
        <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
          <span className="flex items-center gap-1">
            Refundable deposit <Info size={12} />
          </span>
          <span>R{deposit}</span>
        </div>
      )}
      {insurance > 0 && (
        <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
          <span>Insurance</span>
          <span>R{insurance}</span>
        </div>
      )}
      <div className="flex justify-between font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-3 mt-1 text-base">
        <span>Total {listing.deposit_required ? '(incl. deposit)' : ''}</span>
        <span>R{total}</span>
      </div>
    </div>
  )

  // ── CONFIRMED ──
  if (step === 'confirmed') {
    return (
      <div className="max-w-lg mx-auto px-6 py-20 text-center">
        <div className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-8">
          <CheckCircle size={40} className="text-green-500" />
        </div>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">
          Booking Confirmed!
        </h1>
        <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-1">
          Your booking reference is{' '}
          <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{bookingRef}</strong>
        </p>
        <p className="text-[#6B5B55] dark:text-[#9B8B85] text-sm mb-10">
          {listing.merchant?.display_name} has been notified and will confirm your booking shortly. You&apos;ll receive
          an email confirmation.
        </p>

        <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 mb-8 text-left space-y-4">
          <div className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{listing.title}</div>
          {range?.from && range?.to && (
            <div className="flex justify-between text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">Dates</span>
              <span className="text-[#1A0A0A] dark:text-[#F5F0ED] font-medium">
                {range.from.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} –{' '}
                {range.to.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">Total paid</span>
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED] font-bold">R{total}</span>
          </div>
          {listing.deposit_required && (
            <div className="flex items-start gap-2 text-xs text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg p-3">
              <ShieldCheck size={13} className="shrink-0 mt-0.5" />
              <span>
                R{deposit} deposit held securely in escrow — returned when you confirm the item is back in good
                condition.
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <Link
            href="/dashboard/renter"
            className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors"
          >
            View my bookings
          </Link>
          <Link
            href="/listings"
            className="flex-1 flex items-center justify-center gap-2 py-3.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl text-sm hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
          >
            Browse more
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      {/* Back link */}
      <Link
        href={`/listings/${listing.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-8 transition-colors"
      >
        <ArrowLeft size={14} /> Back to listing
      </Link>

      {/* Page heading */}
      <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">
        Book This Item
      </h1>

      <StepIndicator current={step} />
      <ListingSummary />

      {/* ── STEP 1: DATES ── */}
      {step === 'dates' && (
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Calendar size={18} className="text-[#9B8B85]" />
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
              Select Dates
            </h2>
          </div>

          {listing.min_rental_days > 1 && (
            <div className="mb-5 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-3">
              <Info size={14} className="shrink-0" />
              Minimum rental period: {listing.min_rental_days} days
            </div>
          )}

          <div className="flex justify-center bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 mb-5">
            <DayPicker
              mode="range"
              selected={range}
              onSelect={setRange}
              disabled={[{ before: new Date() }, ...UNAVAILABLE_DATES]}
              numberOfMonths={1}
              className="rdp-unity"
            />
          </div>

          {range?.from && range?.to && (
            <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-5 py-4 mb-5 flex items-center justify-between text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">
                {range.from.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} →{' '}
                {range.to.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
                {' '}·{' '}
                <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{days} days</strong>
              </span>
              <span className="font-extrabold text-[#8B1A1A]">R{rentalFee}</span>
            </div>
          )}

          <button
            onClick={() => setStep('review')}
            disabled={!canProceedDates}
            className="w-full flex items-center justify-center gap-2 py-4 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-sm"
          >
            Continue <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* ── STEP 2: REVIEW ── */}
      {step === 'review' && (
        <div>
          <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-6">
            Review Booking
          </h2>

          <div className="space-y-3 mb-8 text-sm">
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">Dates</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                {range?.from?.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} –{' '}
                {range?.to?.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </div>
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">Duration</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{days} days</span>
            </div>
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">Merchant</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED] flex items-center gap-1">
                {listing.merchant?.display_name}
                {listing.merchant?.kyc_status === 'approved' && (
                  <ShieldCheck size={13} className="text-green-500" />
                )}
              </span>
            </div>
          </div>

          <p className="section-label mb-3">Price breakdown</p>
          <PriceBreakdown />

          <div className="flex items-start gap-2 mt-5 mb-8 text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl p-4 border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <ShieldCheck size={14} className="text-green-500 shrink-0 mt-0.5" />
            <span>
              By proceeding, you agree to Unity&apos;s{' '}
              <Link href="/terms" className="underline hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED]">
                rental terms
              </Link>
              . Your payment will be held in escrow and released to the merchant only after you confirm the item has
              been returned in good condition.
            </span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setStep('dates')}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
            >
              <ArrowLeft size={16} /> Back
            </button>
            <button
              onClick={() => setStep('payment')}
              className="flex-[2] flex items-center justify-center gap-2 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors text-sm"
            >
              Proceed to payment <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: PAYMENT ── */}
      {step === 'payment' && (
        <div>
          <div className="flex items-center gap-3 mb-6">
            <CreditCard size={18} className="text-[#9B8B85]" />
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">Payment</h2>
          </div>

          <PriceBreakdown />

          <div className="mt-8 bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-3.5 bg-[#0d76be] text-white">
              <ShieldCheck size={16} />
              <span className="text-sm font-semibold">PayFast Secure Payment</span>
              <span className="ml-auto text-xs opacity-80">Sandbox mode</span>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <button className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-[#0d76be] bg-blue-50 dark:bg-blue-900/20">
                  <CreditCard size={22} className="text-[#0d76be]" />
                  <span className="text-xs font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Card Payment</span>
                </button>
                <button className="flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-[#F2EDE8] dark:border-[#2A1A1A] hover:border-[#9B8B85] transition-colors">
                  <span className="text-xl">🏦</span>
                  <span className="text-xs font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Instant EFT</span>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">
                    Card number
                  </label>
                  <input
                    disabled
                    placeholder="4111 1111 1111 1111"
                    defaultValue="4111 1111 1111 1111"
                    className="w-full px-4 py-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#1A1010] text-[#9B8B85] text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">
                      Expiry
                    </label>
                    <input
                      disabled
                      placeholder="12/28"
                      defaultValue="12/28"
                      className="w-full px-4 py-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#1A1010] text-[#9B8B85] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">CVV</label>
                    <input
                      disabled
                      placeholder="123"
                      defaultValue="123"
                      className="w-full px-4 py-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#1A1010] text-[#9B8B85] text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="text-xs text-[#9B8B85] text-center">
                🔒 Test mode — no real payment processed
              </div>
            </div>
          </div>

          <div className="flex gap-3 mt-8">
            <button
              onClick={() => setStep('review')}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
            >
              <ArrowLeft size={16} /> Back
            </button>
            <button
              onClick={handlePayment}
              disabled={paymentProcessing}
              className="flex-[2] flex items-center justify-center gap-2 py-3.5 bg-[#0d76be] text-white font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-70 text-sm"
            >
              {paymentProcessing ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{' '}
                  Processing...
                </>
              ) : (
                <>
                  Pay R{total} <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
