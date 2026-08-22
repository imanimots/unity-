'use client'

import { useState, useEffect, use } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'

interface PageProps {
  params: Promise<{ id: string }>
}

const inputClass = 'w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-sm text-[#1A0A0A] dark:text-[#F5F0ED]'
const labelClass = 'block text-xs font-semibold uppercase tracking-wide text-[#6B5B55] dark:text-[#9B8B85] mb-1.5'

/**
 * Merchant configures the RTB terms for their own listing. Enabling
 * (submitting with enabled=true) is blocked server-side while
 * RENT_TO_BUY_ENABLED is off (Rule M) -- the route returns 503 in that
 * case, surfaced here as a plain error message rather than hidden.
 */
export default function MerchantRentToBuyTermsPage({ params }: PageProps) {
  const { id } = use(params)
  const t = useTranslations('merchant.rtbTerms')
  const tFrequency = useTranslations('rtb.frequency')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [enabled, setEnabled] = useState(false)
  const [totalPurchasePrice, setTotalPurchasePrice] = useState('')
  const [installmentAmount, setInstallmentAmount] = useState('')
  const [installmentCount, setInstallmentCount] = useState('')
  const [frequency, setFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly')
  const [depositAmount, setDepositAmount] = useState('')
  const [earlyPayoffAllowed, setEarlyPayoffAllowed] = useState(false)
  const [possessionTriggerType, setPossessionTriggerType] = useState<'first_payment' | 'installment_count' | 'percentage' | 'full_payment'>('first_payment')
  const [possessionTriggerValue, setPossessionTriggerValue] = useState('')
  const [rentalUseRateAmount, setRentalUseRateAmount] = useState('')
  const [rentalUseRateUnit, setRentalUseRateUnit] = useState<'daily' | 'weekly' | 'monthly'>('monthly')
  const [wearDamageStandard, setWearDamageStandard] = useState('')
  const [gracePeriodDays, setGracePeriodDays] = useState('7')
  const [returnWindowDays, setReturnWindowDays] = useState('14')

  useEffect(() => {
    fetch(`/api/listings/${id}/rent-to-buy-terms`)
      .then((r) => r.json())
      .then((body) => {
        if (body.terms) {
          setEnabled(body.terms.enabled)
          setTotalPurchasePrice(String(body.terms.total_purchase_price))
          setInstallmentAmount(String(body.terms.installment_amount))
          setInstallmentCount(String(body.terms.installment_count))
          setFrequency(body.terms.payment_frequency)
          setDepositAmount(body.terms.security_deposit_amount ? String(body.terms.security_deposit_amount) : '')
          setEarlyPayoffAllowed(body.terms.early_payoff_allowed)
          if (body.terms.possession_trigger_type) setPossessionTriggerType(body.terms.possession_trigger_type)
          if (body.terms.possession_trigger_value !== null && body.terms.possession_trigger_value !== undefined) setPossessionTriggerValue(String(body.terms.possession_trigger_value))
          if (body.terms.rental_use_rate_amount !== null && body.terms.rental_use_rate_amount !== undefined) setRentalUseRateAmount(String(body.terms.rental_use_rate_amount))
          if (body.terms.rental_use_rate_unit) setRentalUseRateUnit(body.terms.rental_use_rate_unit)
          if (body.terms.wear_damage_standard) setWearDamageStandard(body.terms.wear_damage_standard)
          if (body.terms.grace_period_days !== null && body.terms.grace_period_days !== undefined) setGracePeriodDays(String(body.terms.grace_period_days))
          if (body.terms.return_window_days !== null && body.terms.return_window_days !== undefined) setReturnWindowDays(String(body.terms.return_window_days))
        }
      })
      .finally(() => setLoading(false))
  }, [id])

  const submit = async (nextEnabled: boolean) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const usesValue = possessionTriggerType === 'installment_count' || possessionTriggerType === 'percentage'
      const res = await fetch(`/api/listings/${id}/rent-to-buy-terms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: nextEnabled,
          total_purchase_price: Number(totalPurchasePrice),
          installment_amount: Number(installmentAmount),
          installment_count: Number(installmentCount),
          payment_frequency: frequency,
          security_deposit_amount: depositAmount ? Number(depositAmount) : undefined,
          early_payoff_allowed: earlyPayoffAllowed,
          possession_trigger_type: possessionTriggerType,
          possession_trigger_value: usesValue && possessionTriggerValue ? Number(possessionTriggerValue) : undefined,
          rental_use_rate_amount: Number(rentalUseRateAmount || 0),
          rental_use_rate_unit: rentalUseRateUnit,
          wear_damage_standard: wearDamageStandard || undefined,
          grace_period_days: Number(gracePeriodDays || 0),
          return_window_days: Number(returnWindowDays || 0),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? t('errors.couldNotSave'))
      setEnabled(nextEnabled)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.couldNotSave'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-sm text-[#9B8B85]">{t('loading')}</div>

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant/listings" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> {t('back')}
        </Link>
      </div>
      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-2">{t('heading')}</h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        {enabled ? t('enabledNotice') : t('disabledNotice')} {t('ownershipNotice')}
      </p>

      {error && <p className="text-sm text-[#8B1A1A] mb-4">{error}</p>}
      {saved && <p className="text-sm text-green-700 dark:text-green-500 mb-4">{t('termsSaved')}</p>}

      <div className="space-y-5">
        <div>
          <label className={labelClass}>{t('totalPurchasePrice')}</label>
          <input className={inputClass} type="number" min="1" value={totalPurchasePrice} onChange={(e) => setTotalPurchasePrice(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t('installmentAmount')}</label>
            <input className={inputClass} type="number" min="1" value={installmentAmount} onChange={(e) => setInstallmentAmount(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>{t('installmentCount')}</label>
            <input className={inputClass} type="number" min="1" value={installmentCount} onChange={(e) => setInstallmentCount(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelClass}>{t('paymentFrequency')}</label>
          <select className={inputClass} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            <option value="weekly">{tFrequency('weekly')}</option>
            <option value="biweekly">{tFrequency('biweekly')}</option>
            <option value="monthly">{tFrequency('monthly')}</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>{t('securityDeposit')}</label>
          <input className={inputClass} type="number" min="0" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
          <p className="text-xs text-[#9B8B85] mt-1">{t('securityDepositNotice')}</p>
        </div>

        <div className="pt-2 border-t border-[#E8E0D8] dark:border-[#2A1A1A]">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1A0A0A] dark:text-[#F5F0ED] mt-4 mb-3">{t('possessionSection')}</h2>
          <div>
            <label className={labelClass}>{t('possessionTrigger')}</label>
            <select className={inputClass} value={possessionTriggerType} onChange={(e) => setPossessionTriggerType(e.target.value as typeof possessionTriggerType)}>
              <option value="first_payment">{t('trigger.firstPayment')}</option>
              <option value="installment_count">{t('trigger.installmentCount')}</option>
              <option value="percentage">{t('trigger.percentage')}</option>
              <option value="full_payment">{t('trigger.fullPayment')}</option>
            </select>
          </div>
          {(possessionTriggerType === 'installment_count' || possessionTriggerType === 'percentage') && (
            <div className="mt-3">
              <label className={labelClass}>{possessionTriggerType === 'installment_count' ? t('trigger.installmentCountValue') : t('trigger.percentageValue')}</label>
              <input className={inputClass} type="number" min="1" value={possessionTriggerValue} onChange={(e) => setPossessionTriggerValue(e.target.value)} />
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-[#E8E0D8] dark:border-[#2A1A1A]">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-[#1A0A0A] dark:text-[#F5F0ED] mt-4 mb-3">{t('rentalUseSection')}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t('rentalUseRateAmount')}</label>
              <input className={inputClass} type="number" min="0" value={rentalUseRateAmount} onChange={(e) => setRentalUseRateAmount(e.target.value)} />
            </div>
            <div>
              <label className={labelClass}>{t('rentalUseRateUnit')}</label>
              <select className={inputClass} value={rentalUseRateUnit} onChange={(e) => setRentalUseRateUnit(e.target.value as typeof rentalUseRateUnit)}>
                <option value="daily">{t('unit.daily')}</option>
                <option value="weekly">{t('unit.weekly')}</option>
                <option value="monthly">{t('unit.monthly')}</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-[#9B8B85] mt-1.5">{t('rentalUseNotice')}</p>
        </div>

        <div>
          <label className={labelClass}>{t('wearDamageStandard')}</label>
          <textarea className={`${inputClass} min-h-[90px]`} value={wearDamageStandard} onChange={(e) => setWearDamageStandard(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>{t('gracePeriodDays')}</label>
            <input className={inputClass} type="number" min="0" value={gracePeriodDays} onChange={(e) => setGracePeriodDays(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>{t('returnWindowDays')}</label>
            <input className={inputClass} type="number" min="0" value={returnWindowDays} onChange={(e) => setReturnWindowDays(e.target.value)} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          <input type="checkbox" checked={earlyPayoffAllowed} onChange={(e) => setEarlyPayoffAllowed(e.target.checked)} />
          {t('allowEarlyPayoff')}
        </label>
        <p className="text-xs text-[#9B8B85]">{t('escrowNotice')}</p>

        <div className="flex gap-3 pt-2">
          <button disabled={saving} onClick={() => submit(true)} className="px-5 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50">
            {t('saveAndEnable')}
          </button>
          <button disabled={saving} onClick={() => submit(false)} className="px-5 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] disabled:opacity-50">
            {t('saveAsDisabled')}
          </button>
        </div>
      </div>
    </div>
  )
}
