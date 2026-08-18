'use client'

import { useState, useEffect, useCallback } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Locale } from '@/i18n/locales'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Percent } from 'lucide-react'
import { formatMoneyFromRands, formatDate } from '@/lib/i18n/format'

interface MerchantCommission {
  id: string
  transactionType: 'sale' | 'rental'
  status: 'pending' | 'held' | 'earned' | 'adjusted' | 'voided'
  reference: string | null
  listingTitle: string | null
  eligibleBase: number
  standardRateBps: number
  standardRateBase: number
  excessRateBps: number
  excessBase: number
  commissionAmount: number
  affiliateReward: number
  merchantProceedsBasis: number
  currency: string
  createdAt: string
  earnedAt: string | null
}

const STATUS_BADGE_CLASSES: Record<MerchantCommission['status'], string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  held: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  earned: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  adjusted: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  voided: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
}

/**
 * Unity Phase 2, Step I -- transparent per-transaction financial
 * breakdown: eligible amount, Unity's commission (with the high-value
 * split explained when it applies), affiliate reward where relevant,
 * and the resulting proceeds basis. Never shows admin-only hold/void
 * reason text, never labels a provider fee as Unity commission (there
 * is no provider fee concept in this codebase yet).
 */
export default function MerchantCommissionsPage() {
  const locale = useLocale() as Locale
  const tMerchant = useTranslations('merchant')
  const t = useTranslations('merchant.commissionsPage')
  const money = useCallback((amount: number, currency = 'ZAR') => formatMoneyFromRands(amount, currency, locale), [locale])
  const STATUS_LABELS: Record<MerchantCommission['status'], string> = {
    pending: tMerchant('commissionStatus.pending'),
    held: tMerchant('commissionStatus.held'),
    earned: tMerchant('commissionStatus.earned'),
    adjusted: tMerchant('commissionStatus.adjusted'),
    voided: tMerchant('commissionStatus.voided'),
  }
  const [commissions, setCommissions] = useState<MerchantCommission[]>([])
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/commissions/me')
      if (res.ok) {
        const data = await res.json()
        setCommissions(data.commissions ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData()
  }, [loadData])

  const totalCommission = commissions.filter((c) => c.status !== 'voided').reduce((sum, c) => sum + c.commissionAmount, 0)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('backLabel')}
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('earningsLabel')}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          {t('heading')}
        </h1>
      </div>

      <div className="bg-[#8B1A1A] rounded-xl p-8 mb-12 border-l-4 border-l-[#C4511F]">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/60 mb-3">{t('totalCommissionLabel')}</p>
        <div className="text-5xl lg:text-6xl font-extrabold text-white leading-none mb-2">{money(totalCommission)}</div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/50">{t('chargedNotice')}</p>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">{t('transactionHistoryLabel')}</p>

        {loading ? (
          <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
        ) : commissions.length === 0 ? (
          <div className="text-center py-16">
            <Percent size={28} className="mx-auto text-[#9B8B85] mb-3" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{t('noCommissionedTransactions')}</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            {commissions.map((c) => (
              <div key={c.id} className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0">
                <div className="flex items-center justify-between gap-4 mb-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate capitalize">
                      {c.listingTitle ?? (c.transactionType === 'sale' ? t('transactionFallbackSale') : t('transactionFallbackRental'))}
                    </div>
                    <div className="text-xs text-[#9B8B85]">{formatDate(c.createdAt, locale)}{c.reference ? ` · ${c.reference}` : ''}</div>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium capitalize whitespace-nowrap ${STATUS_BADGE_CLASSES[c.status]}`}>
                    {STATUS_LABELS[c.status]}
                  </span>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-[#9B8B85]">{t('eligibleAmountLabel')}</dt>
                  <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] text-right">{money(c.eligibleBase, c.currency)}</dd>
                  <dt className="text-[#9B8B85]">
                    {t('unityCommissionLabel', { rate: (c.standardRateBps / 100).toFixed(1), excess: c.excessBase > 0 ? t('excessSuffix') : '' })}
                  </dt>
                  <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] text-right">-{money(c.commissionAmount, c.currency)}</dd>
                  {c.affiliateReward > 0 && (
                    <>
                      <dt className="text-[#9B8B85]">{t('affiliateRewardLabel')}</dt>
                      <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] text-right">-{money(c.affiliateReward, c.currency)}</dd>
                    </>
                  )}
                  <dt className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{t('proceedsBasisLabel')}</dt>
                  <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold text-right">{money(c.merchantProceedsBasis, c.currency)}</dd>
                </dl>
                {c.excessBase > 0 && (
                  <p className="text-[11px] text-[#9B8B85] mt-2">
                    {t('highValueNotice', {
                      rate: (c.standardRateBps / 100).toFixed(1),
                      amount: money(c.standardRateBase, c.currency),
                      remaining: money(c.excessBase, c.currency),
                    })}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-[#9B8B85] text-center">
        {t('footerNotice')}{' '}
        <Link href="/dashboard/merchant/subscription" className="underline hover:text-[#6B5B55] dark:hover:text-[#9B8B85]">{t('managePlanLink')}</Link>
      </p>
    </div>
  )
}
