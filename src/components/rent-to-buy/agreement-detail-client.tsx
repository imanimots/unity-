'use client'

import { useState } from 'react'
import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'

type RtbTestScenario = 'success' | 'declined'

interface Props {
  agreementId: string
  isMerchant: boolean
  isCustomer: boolean
  status: string
  possessionStatus: string
  ownershipStatus: string
  earlyPayoffAllowed: boolean
  securityDepositAmount: number | null
  nextUnpaidSequence: number | null
  handedOverAt: string | null
  hasPendingAmendment: boolean
  pendingTermination: 'none' | 'proposed_by_me' | 'proposed_by_other'
  /** Server-resolved isMockScenarioSelectionAllowed() (RTB payments share
   * the same src/lib/payments provider/registry as checkout) -- a normal
   * payment action never claims an outcome; test_scenario is only ever
   * sent when this is true, and then only via the explicit picker below,
   * never a hidden default. The 3 payment routes independently re-check
   * the same condition server-side regardless of what this prop says. */
  testModeAvailable: boolean
}

async function callAction(path: string, body: Record<string, unknown> = {}) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? 'Something went wrong')
  return json
}

export function RentToBuyAgreementActions({
  agreementId, isMerchant, isCustomer, status, possessionStatus, ownershipStatus,
  earlyPayoffAllowed, securityDepositAmount, nextUnpaidSequence, handedOverAt, hasPendingAmendment, pendingTermination,
  testModeAvailable,
}: Props) {
  const router = useRouter()
  const t = useTranslations('rtb')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [defaultReason, setDefaultReason] = useState('')
  const [showDefaultConfirm, setShowDefaultConfirm] = useState(false)
  const [testScenario, setTestScenario] = useState<RtbTestScenario>('success')
  const scenarioBody = testModeAvailable ? { test_scenario: testScenario } : {}

  const run = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key)
    setError(null)
    try {
      await callAction(path, body)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.generic'))
    } finally {
      setBusy(null)
    }
  }

  const base = `/api/rent-to-buy/agreements/${agreementId}`
  const btn = 'px-4 py-2.5 rounded-xl text-xs font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-50'
  const primary = `${btn} bg-[#8B1A1A] text-white hover:bg-[#7A1616]`
  const secondary = `${btn} border border-[#E8E0D8] text-[#1A0A0A] hover:border-[#8B1A1A]/40`
  const danger = `${btn} border border-[#8B1A1A] text-[#8B1A1A] hover:bg-[#8B1A1A]/10`

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-[#8B1A1A]">{error}</p>}
      {testModeAvailable && isCustomer && (
        <div className="bg-white rounded-xl border border-dashed border-amber-400/60 p-4">
          <div className="flex items-center justify-between mb-2.5">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-amber-600">{t('testMode.heading')}</p>
            <span className="text-[10px] font-mono text-[#9B8B85]">{t('testMode.provider')}</span>
          </div>
          <div className="flex gap-4">
            {(['success', 'declined'] as const).map((scenario) => (
              <label key={scenario} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="rtb_test_scenario"
                  value={scenario}
                  checked={testScenario === scenario}
                  onChange={() => setTestScenario(scenario)}
                  disabled={busy !== null}
                  className="accent-[#8B1A1A]"
                />
                <span className="text-[#1A0A0A]">{t(`testMode.${scenario}`)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        {isMerchant && status === 'pending_merchant_acceptance' && (
          <>
            <button className={primary} disabled={busy !== null} onClick={() => run('accept', `${base}/accept`)}>{t('actions.acceptAgreement')}</button>
            <button className={secondary} disabled={busy !== null} onClick={() => run('decline', `${base}/decline`)}>{t('actions.decline')}</button>
          </>
        )}
        {(isMerchant || isCustomer) && (status === 'pending_merchant_acceptance' || status === 'awaiting_first_payment') && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('cancel', `${base}/cancel`)}>{t('actions.cancel')}</button>
        )}
        {isCustomer && securityDepositAmount && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('deposit', `${base}/pay-deposit`, scenarioBody)}>{t('actions.payDeposit')}</button>
        )}
        {isCustomer && (status === 'awaiting_first_payment' || status === 'active') && nextUnpaidSequence && (
          <button className={primary} disabled={busy !== null} onClick={() => run('installment', `${base}/pay-installment`, { sequence: nextUnpaidSequence, ...scenarioBody })}>
            {t('actions.payInstallment', { sequence: nextUnpaidSequence })}
          </button>
        )}
        {isMerchant && possessionStatus === 'possession_eligible' && !handedOverAt && (
          <button className={primary} disabled={busy !== null} onClick={() => run('handover', `${base}/mark-handed-over`)}>{t('actions.markHandedOver')}</button>
        )}
        {isCustomer && possessionStatus === 'possession_eligible' && handedOverAt && (
          <button className={primary} disabled={busy !== null} onClick={() => run('possession', `${base}/confirm-possession`)}>{t('actions.confirmPossession')}</button>
        )}
        {isCustomer && earlyPayoffAllowed && status === 'active' && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('payoff', `${base}/payoff`, scenarioBody)}>{t('actions.payOff')}</button>
        )}
        {(isMerchant || isCustomer) && (possessionStatus === 'customer_in_possession' || possessionStatus === 'return_required') && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('return', `${base}/request-return`)}>{t('actions.requestReturn')}</button>
        )}
        {(isMerchant || isCustomer) && status === 'active' && pendingTermination === 'none' && !hasPendingAmendment && (
          <button className={secondary} disabled={busy !== null} onClick={() => run('propose-termination', `${base}/propose-termination`)}>{t('actions.proposeTermination')}</button>
        )}
        {(isMerchant || isCustomer) && status === 'active' && pendingTermination === 'proposed_by_other' && (
          <button className={primary} disabled={busy !== null} onClick={() => run('accept-termination', `${base}/accept-termination`)}>{t('actions.acceptTermination')}</button>
        )}
        {(isMerchant || isCustomer) && status === 'active' && pendingTermination === 'proposed_by_me' && (
          <p className="text-xs text-[#9B8B85] self-center">{t('terminationPending')}</p>
        )}
        {isMerchant && status === 'active' && ownershipStatus === 'merchant_owned' && !showDefaultConfirm && (
          <button className={danger} disabled={busy !== null} onClick={() => setShowDefaultConfirm(true)}>{t('actions.initiateDefault')}</button>
        )}
      </div>

      {showDefaultConfirm && (
        <div className="rounded-xl border border-[#8B1A1A]/30 bg-[#8B1A1A]/5 p-4 space-y-2">
          <p className="text-sm text-[#8B1A1A] font-medium">{t('initiateDefaultWarning')}</p>
          <textarea
            className="w-full px-3 py-2 rounded-lg border border-[#E8E0D8] bg-white text-sm"
            placeholder={t('defaultReasonPlaceholder')}
            value={defaultReason}
            onChange={(e) => setDefaultReason(e.target.value)}
          />
          <div className="flex gap-3">
            <button
              className={danger}
              disabled={busy !== null || defaultReason.trim().length === 0}
              onClick={async () => {
                await run('initiate-default', `${base}/initiate-default`, { reason: defaultReason })
                setShowDefaultConfirm(false)
              }}
            >
              {t('confirmInitiateDefault')}
            </button>
            <button className={secondary} disabled={busy !== null} onClick={() => setShowDefaultConfirm(false)}>{t('actions.decline')}</button>
          </div>
        </div>
      )}
    </div>
  )
}
