'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Props {
  agreementId: string
  isMerchant: boolean
  isCustomer: boolean
  status: string
  possessionStatus: string
  ownershipStatus: string
  cureAllowed: boolean
  earlyPayoffAllowed: boolean
  securityDepositAmount: number | null
  nextUnpaidSequence: number | null
}

async function callAction(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Something went wrong')
  return json
}

export function RentToBuyAgreementActions({
  agreementId, isMerchant, isCustomer, status, possessionStatus, ownershipStatus,
  cureAllowed, earlyPayoffAllowed, securityDepositAmount, nextUnpaidSequence,
}: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key)
    setError(null)
    try {
      await callAction(path, body)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const base = `/api/rent-to-buy/agreements/${agreementId}`
  const btn = 'px-4 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-50'
  const primary = `${btn} bg-[#8B1A1A] text-white hover:bg-[#7A1616]`
  const secondary = `${btn} border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:border-[#8B1A1A]/40`

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[#8B1A1A]">{error}</p>}
      <div className="flex flex-wrap gap-3">
        {isMerchant && status === 'pending_merchant_acceptance' && (
          <>
            <button className={primary} disabled={busy !== null} onClick={() => run('accept', `${base}/accept`)}>Accept agreement</button>
            <button className={secondary} disabled={busy !== null} onClick={() => run('decline', `${base}/decline`)}>Decline</button>
          </>
        )}
        {(isMerchant || isCustomer) && (status === 'pending_merchant_acceptance' || status === 'awaiting_first_payment') && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('cancel', `${base}/cancel`)}>Cancel</button>
        )}
        {isCustomer && securityDepositAmount && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('deposit', `${base}/pay-deposit`, { test_scenario: 'success' })}>Pay security deposit</button>
        )}
        {isCustomer && (status === 'awaiting_first_payment' || status === 'active') && nextUnpaidSequence && (
          <button className={primary} disabled={busy !== null} onClick={() => run('installment', `${base}/pay-installment`, { sequence: nextUnpaidSequence, test_scenario: 'success' })}>
            Pay instalment #{nextUnpaidSequence}
          </button>
        )}
        {(isMerchant || isCustomer) && possessionStatus === 'possession_eligible' && (
          <button className={primary} disabled={busy !== null} onClick={() => run('possession', `${base}/confirm-possession`)}>Confirm handover</button>
        )}
        {isCustomer && earlyPayoffAllowed && status === 'active' && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('payoff', `${base}/payoff`, { test_scenario: 'success' })}>Pay off remaining balance</button>
        )}
        {(isMerchant || isCustomer) && cureAllowed && status === 'defaulted' && ownershipStatus === 'merchant_owned' && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('cure', `${base}/cure`)}>Cure default</button>
        )}
        {(isMerchant || isCustomer) && (possessionStatus === 'customer_in_possession' || possessionStatus === 'return_required') && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('return', `${base}/request-return`)}>Request return</button>
        )}
      </div>
    </div>
  )
}
