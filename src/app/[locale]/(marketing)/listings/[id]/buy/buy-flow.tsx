'use client'

import { useState, useEffect } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations, useLocale } from 'next-intl'
import Image from 'next/image'
import { ArrowLeft, Minus, Plus, ShieldCheck, Truck } from 'lucide-react'
import { formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import type { Listing } from '@/types'
import { trackEvent } from '@/lib/analytics/client'
import { EliteBadge } from '@/components/subscriptions/elite-badge'

export function BuyFlow({ listing }: { listing: Listing & { sale_price: number } }) {
  const router = useRouter()
  const t = useTranslations('buy.buyFlow')
  const locale = useLocale() as Locale
  const [quantity, setQuantity] = useState(1)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Fires once per mount of the dedicated buy/checkout page -- see the
  // matching comment in booking-flow.tsx. order_created is emitted
  // server-side only on an actual successful order insert.
  useEffect(() => {
    trackEvent('order_checkout_started', { entityType: 'listing', entityId: listing.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const maxQuantity = Math.max(1, listing.quantity_available ?? 1)
  const total = listing.sale_price * quantity
  const money = (amount: number) => formatMoneyFromRands(amount, 'ZAR', locale)

  async function submit() {
    if (!agreedToTerms) {
      setError(t('termsRequired'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listing.id, quantity, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('couldNotPlaceOrder'))
        return
      }

      // Best-effort -- the order already exists at this point; a failure
      // to record consent must not block checkout. Mirrors
      // booking-flow.tsx's identical pattern (the equivalent call never
      // existed for the Buy/order path before -- added here since this
      // page now shows the terms it references).
      try {
        await fetch('/api/legal/accept', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ policies: ['terms', 'payments-and-deposits'], context: 'checkout' }),
        })
      } catch {
        // swallowed -- see comment above
      }

      router.push(`/dashboard/orders/${data.order_id}/checkout`)
    } catch {
      setError(t('networkErrorRetry'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-lg mx-auto px-4 sm:px-6 py-10">
      <Link
        href={`/listings/${listing.id}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#9B8B85] hover:text-[#1A0A0A] mb-6"
      >
        <ArrowLeft size={13} /> {t('backToListing')}
      </Link>

      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] mb-6">{t('buyNowTitle')}</h1>

      <div className="bg-white rounded-xl border border-[#F2EDE8] p-5 mb-5">
        <div className="flex gap-4">
          <div className="relative w-20 h-20 rounded-lg overflow-hidden bg-[#F2EDE8] shrink-0">
            {listing.media?.[0]?.url ? (
              <Image src={listing.media[0].url} alt={listing.title} fill className="object-cover" sizes="80px" />
            ) : null}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[#1A0A0A] truncate">{listing.title}</p>
            <p className="text-sm text-[#6B5B55] mt-1">{t('each', { amount: money(listing.sale_price) })}</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">{t('available', { count: listing.quantity_available ?? 0 })}</p>
          </div>
        </div>
      </div>

      <div className="space-y-3 mb-5 text-sm">
        <div className="flex justify-between items-center px-5 py-4 bg-white rounded-xl border border-[#F2EDE8]">
          <span className="text-[#6B5B55]">{t('seller')}</span>
          <span className="font-medium text-[#1A0A0A] flex items-center gap-1.5">
            {listing.merchant?.display_name}
            {listing.merchant?.is_elite && <EliteBadge size={13} />}
            {listing.merchant?.is_verified && <ShieldCheck size={13} className="text-green-500" />}
          </span>
        </div>
        <div className="flex justify-between items-center px-5 py-4 bg-white rounded-xl border border-[#F2EDE8]">
          <span className="text-[#6B5B55] flex items-center gap-1.5"><Truck size={13} /> {t('shipping')}</span>
          <span className="font-medium text-[#1A0A0A]">{t(`shippingLabels.${listing.shipping_payer}` as 'shippingLabels.renter')}</span>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-[#F2EDE8] p-5 mb-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#1A0A0A]">{t('quantity')}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#F2EDE8] text-[#1A0A0A] disabled:opacity-40"
            >
              <Minus size={14} />
            </button>
            <span className="w-8 text-center font-semibold text-[#1A0A0A]">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
              disabled={quantity >= maxQuantity}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#F2EDE8] text-[#1A0A0A] disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex justify-between text-base pt-3 border-t border-[#F2EDE8]">
          <span className="font-semibold text-[#1A0A0A]">{t('total')}</span>
          <span className="font-bold text-[#1A0A0A]">{money(total)}</span>
        </div>
      </div>

      <label className="flex items-start gap-2.5 mb-5 text-xs text-[#6B5B55] cursor-pointer">
        <input
          type="checkbox"
          checked={agreedToTerms}
          onChange={(e) => setAgreedToTerms(e.target.checked)}
          className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
        />
        <span>
          {t.rich('agreeToTerms', {
            terms: (chunks) => <Link key="terms" href="/terms" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
            payments: (chunks) => <Link key="payments" href="/payments-and-deposits" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
          })}
        </span>
      </label>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting || !agreedToTerms}
        className="w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
      >
        {submitting ? t('placingOrder') : t('continueToPayment', { amount: money(total) })}
      </button>
    </div>
  )
}
