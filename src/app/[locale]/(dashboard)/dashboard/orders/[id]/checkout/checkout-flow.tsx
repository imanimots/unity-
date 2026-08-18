'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Loader2 } from 'lucide-react'
import { TestModeBanner } from '@/components/shared/test-mode-banner'
import { formatMoneyFromRands } from '@/lib/i18n/format'
import type { Locale } from '@/i18n/locales'

const TEST_SCENARIO_VALUES = ['success', 'declined', 'retryable_failure', 'terminal_failure', 'timeout'] as const

interface InitialSummary {
  orderReference: string
  listingTitle: string
  sellerDisplayName: string
  quantity: number
  unitPrice: number
  shippingFee: number
  totalAmount: number
  currency: string
  status: string
  testModeAvailable: boolean
}

export function OrderCheckoutFlow({ orderId, initial }: { orderId: string; initial: InitialSummary }) {
  const router = useRouter()
  const t = useTranslations('buy.checkout')
  const tCommon = useTranslations('common')
  const locale = useLocale() as Locale
  const [scenario, setScenario] = useState<(typeof TEST_SCENARIO_VALUES)[number]>('success')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<'success' | 'failed_terminal' | 'failed_retryable' | null>(null)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [agreed, setAgreed] = useState(false)

  const alreadyPaid = initial.status !== 'pending'
  const money = (amount: number) => formatMoneyFromRands(amount, initial.currency, locale)

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const body: Record<string, string> = { idempotency_key: idempotencyKey }
      if (initial.testModeAvailable) body.test_scenario = scenario
      const res = await fetch(`/api/orders/${orderId}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok && res.status !== 200) {
        setError(data.error ?? t('couldNotComplete'))
        setResult(data.status === 'failed_retryable' ? 'failed_retryable' : null)
      } else if (data.status === 'failed_terminal') {
        setResult('failed_terminal')
        setError(data.error)
      } else {
        setResult('success')
        router.refresh()
      }
      setIdempotencyKey(crypto.randomUUID())
    } catch {
      setError(t('networkError'))
    } finally {
      setSubmitting(false)
    }
  }

  if (alreadyPaid || result === 'success') {
    return (
      <div className="space-y-4">
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900/40 rounded-xl p-5 text-center">
          <p className="text-sm font-semibold text-green-800 dark:text-green-300">{t('paymentComplete')}</p>
          <p className="text-xs text-green-700 dark:text-green-400 mt-1">{t('orderIsPaid', { reference: initial.orderReference })}</p>
        </div>
        <Link
          href="/dashboard/orders"
          className="block text-center w-full py-3 rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm font-semibold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A]"
        >
          {t('backToPurchases')}
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <TestModeBanner text={tCommon('testMode')} />

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5 space-y-3">
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('order')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{initial.orderReference}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('item')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{initial.listingTitle}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('seller')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{initial.sellerDisplayName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('quantity')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{initial.quantity}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('unitPrice')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{money(initial.unitPrice)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('shipping')}</span>
          <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{money(initial.shippingFee)}</span>
        </div>
        <div className="flex justify-between text-base pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t('total')}</span>
          <span className="font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{money(initial.totalAmount)}</span>
        </div>
      </div>

      {result === 'failed_terminal' && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 rounded-xl p-4">
          <p className="text-xs text-red-800 dark:text-red-300">{error}</p>
        </div>
      )}

      {initial.testModeAvailable && (
        <div>
          <label className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1 block">{t('testScenarioLabel')}</label>
          <select
            value={scenario}
            onChange={(e) => setScenario(e.target.value as typeof scenario)}
            disabled={submitting}
            className="w-full px-3.5 py-2.5 rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-2 focus:border-[#8B1A1A] focus:ring-[#8B1A1A]/20"
          >
            {TEST_SCENARIO_VALUES.map((s) => (
              <option key={s} value={s}>{t(`testScenarios.${s}`)}</option>
            ))}
          </select>
        </div>
      )}

      <label className="flex items-start gap-2.5 text-xs text-[#6B5B55] dark:text-[#9B8B85] cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 rounded border-[#E8E0D8] accent-[#8B1A1A] shrink-0"
        />
        <span>
          {t.rich('agreeToTerms', {
            terms: (chunks) => <Link key="terms" href="/payments-and-deposits" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
            refunds: (chunks) => <Link key="refunds" href="/refunds" className="text-[#8B1A1A] underline hover:no-underline">{chunks}</Link>,
          })}
        </span>
      </label>

      <button
        onClick={submit}
        disabled={submitting || !agreed}
        className="w-full py-3 rounded-lg bg-[#8B1A1A] hover:bg-[#7A1616] text-white text-sm font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {submitting ? <><Loader2 size={14} className="animate-spin" /> {t('processing')}</> : t('payAmount', { amount: money(initial.totalAmount) })}
      </button>

      {error && result !== 'failed_terminal' && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
