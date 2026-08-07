'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ShieldCheck, Star, ArrowRight, Info } from 'lucide-react'
import type { Listing } from '@/types'

const SHIPPING_LABEL: Record<string, string> = {
  renter: 'Paid by renter',
  merchant: 'Free (merchant covers)',
  split: 'Split 50/50',
  negotiate: 'To be negotiated',
}

/** Only ever rendered for a listing that has a daily rate (rental or both) — see the caller's guard on the listing detail page. */
export function BookingCard({ listing }: { listing: Listing & { daily_rate: number } }) {
  const [days, setDays] = useState(listing.min_rental_days)

  const rate = days >= 7 && listing.weekly_rate
    ? listing.weekly_rate / 7
    : listing.daily_rate

  const rentalFee = Math.round(rate * days)
  const deposit = listing.deposit_required ? (listing.deposit_amount ?? 0) : 0
  const insurance = listing.insurance_amount ? listing.insurance_amount * days : 0
  const total = rentalFee + deposit + insurance

  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-5 shadow-sm">
      {/* Price */}
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-5xl font-extrabold text-[#8B1A1A] leading-none">R{listing.daily_rate}</span>
          <span className="text-lg text-[#9B8B85] mb-0.5">/day</span>
          {listing.weekly_rate && (
            <span className="ml-2 text-xs text-[#9B8B85]">· R{listing.weekly_rate}/wk</span>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-[#9B8B85]">
          <Star size={11} className="text-amber-400 fill-amber-400" />
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
            {listing.merchant?.unity_score?.toFixed(1) ?? '5.0'}
          </span>
          <span>· {listing.merchant?.display_name}</span>
        </div>
      </div>

      {/* Days picker */}
      <div>
        <label className="block text-xs font-medium text-[#9B8B85] mb-1.5 uppercase tracking-wide">
          Rental duration
        </label>
        <div className="flex items-center gap-3">
          <button onClick={() => setDays(Math.max(listing.min_rental_days, days - 1))}
            className="w-9 h-9 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] flex items-center justify-center text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors font-bold">
            −
          </button>
          <span className="flex-1 text-center font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">
            {days} day{days !== 1 ? 's' : ''}
          </span>
          <button onClick={() => setDays(days + 1)}
            className="w-9 h-9 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] flex items-center justify-center text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors font-bold">
            +
          </button>
        </div>
        {listing.min_rental_days > 1 && (
          <p className="text-xs text-[#9B8B85] mt-1 text-center">Minimum {listing.min_rental_days} days</p>
        )}
      </div>

      {/* Breakdown */}
      <div className="space-y-2 text-sm border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
        <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
          <span>R{Math.round(rate)} × {days} day{days !== 1 ? 's' : ''}</span>
          <span>R{rentalFee}</span>
        </div>
        {listing.deposit_required && (
          <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
            <span className="flex items-center gap-1">
              Refundable deposit <Info size={12} className="text-[#9B8B85]" />
            </span>
            <span>R{deposit}</span>
          </div>
        )}
        {insurance > 0 && (
          <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
            <span>Insurance cover</span>
            <span>R{insurance}</span>
          </div>
        )}
        <div className="flex justify-between font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-2 mt-2">
          <span>Total</span>
          <span>R{total}</span>
        </div>
        {listing.deposit_required && (
          <p className="text-xs text-[#9B8B85]">Deposit of R{deposit} returned after item is confirmed returned in good condition.</p>
        )}
      </div>

      {/* Shipping */}
      <div className="flex items-center justify-between text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-3 py-2.5">
        <span>Shipping</span>
        <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
          {SHIPPING_LABEL[listing.shipping_payer]}
        </span>
      </div>

      {/* CTA */}
      <Link href={`/listings/${listing.id}/book`}
        className="flex items-center justify-center gap-2 w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors text-sm">
        Book Now <ArrowRight size={16} />
      </Link>

      <p className="text-xs text-[#9B8B85] text-center flex items-center justify-center gap-1">
        <ShieldCheck size={12} className="text-green-500" />
        Test checkout — payments are simulated during Unity&apos;s public test
      </p>
    </div>
  )
}
