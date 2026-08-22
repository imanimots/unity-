'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Wallet } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { formatMoneyFromRands } from '@/lib/i18n/format'
import type { PublicRentToBuyTerms } from '@/lib/rent-to-buy/public-terms'
import type { Locale } from '@/i18n/locales'

interface Props {
  listingId: string
  terms: PublicRentToBuyTerms
  locale: Locale
  className?: string
}

/**
 * "Request Rent-to-Buy" entry point on a listing's detail page -- mirrors
 * ProposeTradeButton's dialog-based CTA shape exactly, but simpler: the
 * commercial terms are already fully merchant-defined and snapshotted
 * server-side by create_rent_to_buy_request itself, so there is no form
 * to fill in here -- only a clear terms summary (Rule 41: material terms
 * must not hide behind "by continuing you agree") and a confirm action
 * that reaches the existing canonical POST /api/rent-to-buy/agreements
 * route (listing_id only -- no second API/RPC invented for this entry
 * point).
 */
export function RequestRentToBuyButton({ listingId, terms, locale, className }: Props) {
  const router = useRouter()
  const t = useTranslations('rtb')
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/rent-to-buy/agreements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listing_id: listingId, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? t('errors.generic'))
        return
      }
      setSent(data.agreement_id)
    } catch {
      setError(t('errors.generic'))
    } finally {
      setSubmitting(false)
    }
  }

  function handleViewRequest() {
    if (sent) router.push(`/dashboard/rent-to-buy/${sent}`)
  }

  const frequencyLabel = t(`frequency.${terms.payment_frequency}`)
  const triggerLabel =
    terms.possession_trigger_type === 'first_payment' ? t('trigger.firstPayment')
    : terms.possession_trigger_type === 'full_payment' ? t('trigger.fullPayment')
    : terms.possession_trigger_type === 'installment_count' ? t('trigger.installmentCountValue') + `: ${terms.possession_trigger_value}`
    : t('trigger.percentageValue') + `: ${terms.possession_trigger_value}%`

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
        <Wallet size={16} /> {t('actions.requestRentToBuy')}
      </button>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setSent(null); setError(null) } }}>
        <DialogContent className="max-w-lg">
          {sent ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('requestSentTitle')}</DialogTitle>
                <DialogDescription>{t('requestSentDesc')}</DialogDescription>
              </DialogHeader>
              <button
                type="button"
                onClick={handleViewRequest}
                className="mt-4 w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors"
              >
                {t('viewRequest')}
              </button>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{t('reviewTermsTitle')}</DialogTitle>
                <DialogDescription>{t('reviewTermsDesc')}</DialogDescription>
              </DialogHeader>

              <div className="mt-4 space-y-2 text-sm">
                {[
                  [t('totalPurchasePriceLabel'), formatMoneyFromRands(terms.total_purchase_price, terms.currency, locale)],
                  [t('installmentSummaryLabel'), `${formatMoneyFromRands(terms.installment_amount, terms.currency, locale)} × ${terms.installment_count} (${frequencyLabel})`],
                  [t('possessionTriggerLabel'), triggerLabel],
                  ...(terms.security_deposit_amount ? [[t('securityDepositLabel'), formatMoneyFromRands(terms.security_deposit_amount, terms.currency, locale)]] : []),
                  [t('rentalUseRateLabel'), `${formatMoneyFromRands(terms.rental_use_rate_amount, terms.currency, locale)} / ${t(`unit.${terms.rental_use_rate_unit}`)}`],
                  [t('gracePeriodLabel'), t('daysCount', { count: terms.grace_period_days })],
                  [t('returnWindowLabel'), t('daysCount', { count: terms.return_window_days })],
                  [t('earlyPayoffLabel'), terms.early_payoff_allowed ? t('yes') : t('no')],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between items-start gap-4 px-3 py-2 rounded-lg bg-[#FAF8F5] dark:bg-[#1A1010]">
                    <span className="text-[#6B5B55] dark:text-[#9B8B85]">{label}</span>
                    <span className="font-medium text-right text-[#1A0A0A] dark:text-[#F5F0ED]">{value}</span>
                  </div>
                ))}
                {terms.wear_damage_standard && (
                  <div className="px-3 py-2 rounded-lg bg-[#FAF8F5] dark:bg-[#1A1010]">
                    <p className="text-[#6B5B55] dark:text-[#9B8B85] mb-1">{t('wearDamageStandardLabel')}</p>
                    <p className="text-[#1A0A0A] dark:text-[#F5F0ED]">{terms.wear_damage_standard}</p>
                  </div>
                )}
              </div>

              <div className="mt-4 rounded-xl bg-[#FFF8E8] dark:bg-[#2A2010] border border-[#E8D8A8] dark:border-[#4A3A1A] p-4 text-xs text-[#5A4A20] dark:text-[#D8C888] space-y-1.5">
                <p>{t('disclosurePossession')}</p>
                <p>{t('disclosureOwnership')}</p>
                <p>{t('disclosureEscrow')}</p>
              </div>

              {error && <p className="mt-3 text-sm text-[#8B1A1A]">{error}</p>}

              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirm}
                className="mt-4 w-full py-3 bg-[#8B1A1A] text-white font-semibold rounded-xl text-sm hover:bg-[#7A1616] transition-colors disabled:opacity-50"
              >
                {submitting ? t('sending') : t('confirmRequest')}
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
