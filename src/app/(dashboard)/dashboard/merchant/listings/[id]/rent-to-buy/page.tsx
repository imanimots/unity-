'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
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
  const [cureAllowed, setCureAllowed] = useState(false)

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
          setCureAllowed(body.terms.default_cure_allowed)
        }
      })
      .finally(() => setLoading(false))
  }, [id])

  const submit = async (nextEnabled: boolean) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
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
          default_cure_allowed: cureAllowed,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Could not save terms')
      setEnabled(nextEnabled)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save terms')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12 text-sm text-[#9B8B85]">Loading…</div>

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/merchant/listings" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>
      <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight mb-2">Rent-to-Buy Terms</h1>
      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mb-8">
        {enabled ? 'Rent-to-buy is enabled for this listing.' : 'Rent-to-buy is not yet enabled for this listing.'} You remain the owner of the item until the customer has paid the full amount below.
      </p>

      {error && <p className="text-sm text-[#8B1A1A] mb-4">{error}</p>}
      {saved && <p className="text-sm text-green-700 dark:text-green-500 mb-4">Terms saved.</p>}

      <div className="space-y-5">
        <div>
          <label className={labelClass}>Total rent-to-buy purchase price (ZAR)</label>
          <input className={inputClass} type="number" min="1" value={totalPurchasePrice} onChange={(e) => setTotalPurchasePrice(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Instalment amount (ZAR)</label>
            <input className={inputClass} type="number" min="1" value={installmentAmount} onChange={(e) => setInstallmentAmount(e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Number of instalments</label>
            <input className={inputClass} type="number" min="1" value={installmentCount} onChange={(e) => setInstallmentCount(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelClass}>Payment frequency</label>
          <select className={inputClass} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Security deposit (ZAR, optional — never counts toward the purchase price)</label>
          <input className={inputClass} type="number" min="0" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          <input type="checkbox" checked={earlyPayoffAllowed} onChange={(e) => setEarlyPayoffAllowed(e.target.checked)} />
          Allow the customer to pay off the remaining balance early
        </label>
        <label className="flex items-center gap-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
          <input type="checkbox" checked={cureAllowed} onChange={(e) => setCureAllowed(e.target.checked)} />
          Allow the customer to cure a default and resume the agreement
        </label>

        <div className="flex gap-3 pt-2">
          <button disabled={saving} onClick={() => submit(true)} className="px-5 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#7A1616] disabled:opacity-50">
            Save and enable
          </button>
          <button disabled={saving} onClick={() => submit(false)} className="px-5 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] disabled:opacity-50">
            Save as disabled
          </button>
        </div>
      </div>
    </div>
  )
}
