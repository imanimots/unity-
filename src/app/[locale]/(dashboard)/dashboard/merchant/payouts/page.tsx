'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowLeft, Clock, CheckCircle, AlertCircle, Loader2, Wallet } from 'lucide-react'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { formatDate, formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'

interface MerchantPayout {
  id: string
  amount: number
  currency: string
  status: 'pending' | 'processing' | 'paid' | 'failed'
  payoutReference: string | null
  failureMessage: string | null
  bookingReference: string | null
  listingTitle: string | null
  createdAt: string
  processingStartedAt: string | null
  paidAt: string | null
  failedAt: string | null
}

const STATUS_BADGE_CLASSES: Record<MerchantPayout['status'], string> = {
  pending: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  processing: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  paid: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
}

const STATUS_ICON: Record<MerchantPayout['status'], React.ReactNode> = {
  pending: <Clock size={13} />,
  processing: <Loader2 size={13} className="animate-spin" />,
  paid: <CheckCircle size={13} />,
  failed: <AlertCircle size={13} />,
}

export default function PayoutsPage() {
  const t = useTranslations('merchant.payoutsPage')
  const locale = useLocale() as Locale
  const [payouts, setPayouts] = useState<MerchantPayout[]>([])
  const [totals, setTotals] = useState({ pending: 0, processing: 0, paid: 0, failed: 0 })
  const [loading, setLoading] = useState(true)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/payouts/me')
      if (res.ok) {
        const data = await res.json()
        setPayouts(data.payouts ?? [])
        setTotals(data.totals ?? { pending: 0, processing: 0, paid: 0, failed: 0 })
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData()
  }, [loadData])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('back')}
        </Link>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('sectionLabel')}</p>
        <h1 className="text-3xl lg:text-4xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">
          {t('heading')}
        </h1>
      </div>

      <TestModeBanner className="mb-8" />

      <div className="bg-[#8B1A1A] rounded-xl p-8 mb-8 border-l-4 border-l-[#C4511F]">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-white/60 mb-3">{t('totalPaid')}</p>
        <div className="text-5xl lg:text-6xl font-extrabold text-white leading-none mb-2">
          {formatMoneyFromRands(totals.paid, 'ZAR', locale)}
        </div>
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-white/50">{t('manualNotice')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('pending')}</p>
          <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{formatMoneyFromRands(totals.pending, 'ZAR', locale)}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('processing')}</p>
          <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{formatMoneyFromRands(totals.processing, 'ZAR', locale)}</div>
        </div>
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-3">{t('failed')}</p>
          <div className="text-3xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED] leading-none">{formatMoneyFromRands(totals.failed, 'ZAR', locale)}</div>
        </div>
      </div>

      <div className="mb-12">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">{t('historyLabel')}</p>

        {loading ? (
          <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
        ) : payouts.length === 0 ? (
          <div className="text-center py-16">
            <Wallet size={28} className="mx-auto text-[#9B8B85] mb-3" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">{t('emptyTitle')}</p>
            <p className="text-xs text-[#9B8B85] mt-2">{t('emptyDesc')}</p>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] overflow-hidden">
            {payouts.map((p) => (
              <div key={p.id} className="px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A] last:border-b-0">
                <div className="flex items-center justify-between gap-4 mb-1.5">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] truncate">{p.listingTitle ?? p.bookingReference ?? t('defaultTitle')}</div>
                    <div className="text-xs text-[#9B8B85]">{formatDate(p.createdAt, locale)}{p.bookingReference ? ` · ${p.bookingReference}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoneyFromRands(Number(p.amount), 'ZAR', locale)}</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_BADGE_CLASSES[p.status]}`}>
                      {STATUS_ICON[p.status]} {t(`status.${p.status}`)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-[#9B8B85] leading-relaxed">
                  {p.status === 'failed' && p.failureMessage ? p.failureMessage : t(`statusExplanations.${p.status}`)}
                </p>
                {p.status === 'paid' && p.payoutReference && (
                  <p className="text-[11px] text-[#9B8B85] mt-1">{t('reference', { reference: p.payoutReference })}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-[#9B8B85] text-center">
        {t('footerNotice')}{' '}
        <Link href="/chat" className="underline hover:text-[#6B5B55] dark:hover:text-[#9B8B85]">{t('contactSupport')}</Link>
      </p>
    </div>
  )
}
