'use client'

import { useState, useRef } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { DayPicker, type DateRange } from 'react-day-picker'
import 'react-day-picker/style.css'
import { ArrowLeft, ArrowRight, ShieldCheck, CheckCircle, Calendar, Star, Info } from 'lucide-react'
import type { Listing } from '@/types'
import { calculateBookingPrice } from '@/lib/bookings/price'
import { formatDate as formatLocaleDate } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import Image from 'next/image'

type Step = 'dates' | 'review' | 'confirmed'

const STEPS: Step[] = ['dates', 'review', 'confirmed']

function ListingSummaryCard({ listing, coverImage, t }: { listing: Listing & { daily_rate: number }; coverImage: string | undefined; t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="flex items-center gap-4 p-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] mb-8">
      <div className="relative w-16 h-14 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
        {coverImage && <Image src={coverImage} alt={listing.title} fill className="object-cover" sizes="64px" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] text-sm leading-snug line-clamp-2">{listing.title}</p>
        <div className="flex items-center gap-1 mt-1 text-xs text-[#9B8B85]">
          <Star size={10} className="text-amber-400 fill-amber-400" />
          <span>{listing.merchant?.unity_score?.toFixed(1)}</span>
          <span>· {listing.merchant?.display_name}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <p className="font-extrabold text-[#8B1A1A] text-lg leading-tight">R{listing.daily_rate}</p>
        <p className="text-xs text-[#9B8B85]">{t('perDay')}</p>
      </div>
    </div>
  )
}

function PriceBreakdownCard({ price, t }: { price: ReturnType<typeof calculateBookingPrice> | null; t: ReturnType<typeof useTranslations> }) {
  if (!price) return null
  return (
    <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-3 text-sm">
      <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
        <span>
          {t('priceRateLine', { rate: `R${price.rateAmount}`, days: price.durationDays })}
          {price.rateUnit === 'weekly' && <span className="text-xs"> {t('weeklyRateApplied')}</span>}
        </span>
        <span>R{price.subtotalAmount}</span>
      </div>
      {price.depositAmount > 0 && (
        <div className="flex justify-between text-[#6B5B55] dark:text-[#9B8B85]">
          <span className="flex items-center gap-1">
            {t('refundableDeposit')} <Info size={12} />
          </span>
          <span>R{price.depositAmount}</span>
        </div>
      )}
      <div className="flex justify-between font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-3 mt-1 text-base">
        <span>{t('totalObligation')}</span>
        <span>R{price.renterTotalAmount}</span>
      </div>
      <p className="text-xs text-[#9B8B85]">{t('estimateNotice')}</p>
    </div>
  )
}

function StepIndicator({ current, t }: { current: Step; t: ReturnType<typeof useTranslations> }) {
  const idx = STEPS.indexOf(current)
  return (
    <div className="flex items-center gap-2 mb-10">
      {STEPS.filter((s) => s !== 'confirmed').map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-colors ${
              i < idx ? 'bg-green-500 text-white' : i === idx ? 'bg-[#8B1A1A] text-white' : 'bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#9B8B85]'
            }`}
          >
            {i < idx ? <CheckCircle size={15} /> : i + 1}
          </div>
          <span className={`section-label hidden sm:block ${i === idx ? 'text-[#1A0A0A] dark:text-[#F5F0ED]' : ''}`}>{t(`steps.${step}`)}</span>
          {i < 1 && <div className="w-8 h-px bg-[#F2EDE8] dark:bg-[#2A1A1A] mx-1" />}
        </div>
      ))}
    </div>
  )
}

export function BookingFlow({ listing }: { listing: Listing & { daily_rate: number } }) {
  const t = useTranslations('rent.book')
  const locale = useLocale() as Locale
  const [step, setStep] = useState<Step>('dates')
  const [range, setRange] = useState<DateRange | undefined>()
  const [renterMessage, setRenterMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmedReference, setConfirmedReference] = useState<string | null>(null)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const idempotencyKeyRef = useRef<string>(crypto.randomUUID())

  const coverImage = listing.media?.[0]?.url

  let price: ReturnType<typeof calculateBookingPrice> | null = null
  if (range?.from && range?.to) {
    try {
      price = calculateBookingPrice({
        dailyRate: listing.daily_rate,
        weeklyRate: listing.weekly_rate,
        depositRequired: listing.deposit_required,
        depositAmount: listing.deposit_amount,
        startAt: range.from,
        endAt: range.to,
      })
    } catch {
      price = null
    }
  }

  const canProceedDates = !!(price && price.durationDays >= listing.min_rental_days)

  async function submitRequest() {
    if (!range?.from || !range?.to) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listing_id: listing.id,
          start_at: range.from.toISOString(),
          end_at: range.to.toISOString(),
          renter_message: renterMessage.trim() || undefined,
          idempotency_key: idempotencyKeyRef.current,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('couldNotSubmit'))
        return
      }
      setConfirmedReference(data.booking_reference ?? null)
      setStep('confirmed')

      try {
        await fetch('/api/legal/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies: ['rental-terms', 'cancellations', 'delivery-and-handover'], context: 'booking_request' }),
        })
      } catch {
        // best-effort -- the booking request already succeeded
      }
    } catch {
      setError(t('networkErrorRetry'))
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'confirmed') {
    return (
      <div className="max-w-lg mx-auto px-6 py-20 text-center">
        <div className="w-20 h-20 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-8">
          <CheckCircle size={40} className="text-amber-500" />
        </div>
        <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-3">{t('requestSent')}</h1>
        <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-1">
          {t('yourReference', { reference: confirmedReference ?? '' })}
        </p>
        <p className="text-[#6B5B55] dark:text-[#9B8B85] text-sm mb-10">
          {t('acceptanceNotice', { merchant: listing.merchant?.display_name ?? '' })}
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <Link href="/dashboard/renter/bookings" className="flex-1 flex items-center justify-center gap-2 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors">
            {t('viewMyBookings')}
          </Link>
          <Link href="/listings" className="flex-1 flex items-center justify-center gap-2 py-3.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl text-sm hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors">
            {t('browseMore')}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <Link href={`/listings/${listing.id}`} className="inline-flex items-center gap-1.5 text-sm text-[#6B5B55] dark:text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-8 transition-colors">
        <ArrowLeft size={14} /> {t('backToListing')}
      </Link>

      <h1 className="text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-8">{t('requestToBook')}</h1>

      <StepIndicator current={step} t={t} />
      <ListingSummaryCard listing={listing} coverImage={coverImage} t={t} />

      {step === 'dates' && (
        <div>
          <div className="flex items-center gap-3 mb-6">
            <Calendar size={18} className="text-[#9B8B85]" />
            <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">{t('selectDates')}</h2>
          </div>

          {listing.min_rental_days > 1 && (
            <div className="mb-5 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-xl px-4 py-3">
              <Info size={14} className="shrink-0" />
              {t('minRentalNotice', { days: listing.min_rental_days })}
            </div>
          )}

          <div className="flex justify-center bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 mb-5">
            <DayPicker mode="range" selected={range} onSelect={setRange} disabled={{ before: new Date() }} numberOfMonths={1} className="rdp-unity" />
          </div>

          <p className="text-xs text-[#9B8B85] mb-5">
            {t('availabilityNotice')}
          </p>

          {price && (
            <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] px-5 py-4 mb-5 flex items-center justify-between text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">
                {range?.from && formatLocaleDate(range.from, locale)} →{' '}
                {range?.to && formatLocaleDate(range.to, locale)} ·{' '}
                <strong className="text-[#1A0A0A] dark:text-[#F5F0ED]">{t('days', { count: price.durationDays })}</strong>
              </span>
              <span className="font-extrabold text-[#8B1A1A]">R{price.subtotalAmount}</span>
            </div>
          )}

          <button
            onClick={() => setStep('review')}
            disabled={!canProceedDates}
            className="w-full flex items-center justify-center gap-2 py-4 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-sm"
          >
            {t('continue')} <ArrowRight size={16} />
          </button>
        </div>
      )}

      {step === 'review' && price && (
        <div>
          <h2 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-6">{t('reviewRequest')}</h2>

          <div className="space-y-3 mb-6 text-sm">
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('dates')}</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                {range?.from && formatLocaleDate(range.from, locale)} –{' '}
                {range?.to && formatLocaleDate(range.to, locale)}
              </span>
            </div>
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('duration')}</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{t('days', { count: price.durationDays })}</span>
            </div>
            <div className="flex justify-between items-center px-5 py-4 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A]">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('merchant')}</span>
              <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED] flex items-center gap-1">
                {listing.merchant?.display_name}
                {listing.merchant?.is_verified && <ShieldCheck size={13} className="text-green-500" />}
              </span>
            </div>
          </div>

          <label className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">{t('messageToMerchant')}</label>
          <textarea
            value={renterMessage}
            onChange={(e) => setRenterMessage(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder={t('messagePlaceholder')}
            className="w-full px-4 py-3 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm mb-5"
          />

          <p className="section-label mb-3">{t('priceBreakdown')}</p>
          <PriceBreakdownCard price={price} t={t} />

          <div className="flex items-start gap-2 mt-5 mb-6 text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-xl p-4 border border-[#F2EDE8] dark:border-[#2A1A1A]">
            <ShieldCheck size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <span>
              {t('requestNotice')}
            </span>
          </div>

          <label className="flex items-start gap-2.5 mb-6 text-xs text-[#6B5B55] dark:text-[#9B8B85] cursor-pointer">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
            />
            <span>
              {t.rich('agreeToTerms', {
                terms: (chunks) => <Link key="terms" href="/rental-terms" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
                cancellations: (chunks) => <Link key="cancellations" href="/cancellations" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
                handover: (chunks) => <Link key="handover" href="/delivery-and-handover" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
              })}
            </span>
          </label>

          {error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('dates')}
              className="flex-1 flex items-center justify-center gap-2 py-3.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold rounded-xl hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors text-sm"
            >
              <ArrowLeft size={16} /> {t('back')}
            </button>
            <button
              onClick={submitRequest}
              disabled={submitting || !agreedToTerms}
              className="flex-[2] flex items-center justify-center gap-2 py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors disabled:opacity-60 text-sm"
            >
              {submitting ? t('sending') : t('sendRequest')} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
