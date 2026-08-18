'use client'

import { useState } from 'react'
import { useRouter, Link } from '@/i18n/navigation'
import { useTranslations, useLocale } from 'next-intl'
import Image from 'next/image'
import { ArrowLeft, Minus, Plus } from 'lucide-react'
import { formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import type { Listing } from '@/types'

export function BuyFlow({ listing }: { listing: Listing & { sale_price: number } }) {
  const router = useRouter()
  const t = useTranslations('buy.buyFlow')
  const locale = useLocale() as Locale
  const [quantity, setQuantity] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const maxQuantity = Math.max(1, listing.quantity_available ?? 1)
  const total = listing.sale_price * quantity
  const money = (amount: number) => formatMoneyFromRands(amount, 'ZAR', locale)

  async function submit() {
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
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] mb-6"
      >
        <ArrowLeft size={13} /> {t('backToListing')}
      </Link>

      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] mb-6">{t('buyNowTitle')}</h1>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 mb-5">
        <div className="flex gap-4">
          <div className="relative w-20 h-20 rounded-lg overflow-hidden bg-[#F2EDE8] dark:bg-[#2A1A1A] shrink-0">
            {listing.media?.[0]?.url ? (
              <Image src={listing.media[0].url} alt={listing.title} fill className="object-cover" sizes="80px" />
            ) : null}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{listing.title}</p>
            <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1">{t('each', { amount: money(listing.sale_price) })}</p>
            <p className="text-xs text-[#9B8B85] mt-0.5">{t('available', { count: listing.quantity_available ?? 0 })}</p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 mb-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{t('quantity')}</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              disabled={quantity <= 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] disabled:opacity-40"
            >
              <Minus size={14} />
            </button>
            <span className="w-8 text-center font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{quantity}</span>
            <button
              type="button"
              onClick={() => setQuantity((q) => Math.min(maxQuantity, q + 1))}
              disabled={quantity >= maxQuantity}
              className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex justify-between text-base pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('total')}</span>
          <span className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{money(total)}</span>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
      >
        {submitting ? t('placingOrder') : t('continueToPayment', { amount: money(total) })}
      </button>
    </div>
  )
}
