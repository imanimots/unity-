import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ShoppingBag, ArrowRight, ShieldCheck } from 'lucide-react'
import { formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'
import type { Listing } from '@/types'

/** Sale-side counterpart to BookingCard — real Buy Now flow (create_order → checkout, see /listings/[id]/buy). */
export async function SaleSummaryCard({ listing }: { listing: Listing & { sale_price: number } }) {
  const soldOut = typeof listing.quantity_available === 'number' && listing.quantity_available <= 0
  const t = await getTranslations('buy.saleCard')
  const locale = (await getLocale()) as Locale
  const money = (amount: number) => formatMoneyFromRands(amount, 'ZAR', locale)

  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-2xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-4 shadow-sm">
      <div className="flex items-center gap-2 text-[#9B8B85]">
        <ShoppingBag size={16} strokeWidth={1.75} />
        <span className="text-xs font-medium uppercase tracking-[0.1em]">{t('forSale')}</span>
      </div>

      <div className="flex items-baseline gap-2">
        <span className="text-5xl font-extrabold text-[#8B1A1A] leading-none">{money(listing.sale_price)}</span>
      </div>

      {typeof listing.quantity_available === 'number' && (
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          {soldOut ? t('soldOut') : t('available', { count: listing.quantity_available })}
        </p>
      )}

      {soldOut ? (
        <div className="flex items-center justify-center w-full py-3.5 bg-[#F2EDE8] dark:bg-[#2A1A1A] text-[#9B8B85] font-semibold rounded-xl text-sm">
          {t('soldOut')}
        </div>
      ) : (
        <Link
          href={`/listings/${listing.id}/buy`}
          className="flex items-center justify-center gap-2 w-full py-3.5 bg-[#8B1A1A] text-white font-semibold rounded-xl hover:bg-[#7A1616] transition-colors text-sm"
        >
          {t('buyNow')} <ArrowRight size={16} />
        </Link>
      )}

      <p className="text-xs text-[#9B8B85] text-center flex items-center justify-center gap-1">
        <ShieldCheck size={12} className="text-green-500" />
        {t('secureCheckoutNotice')}
      </p>
    </div>
  )
}
