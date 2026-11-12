'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { PAYOUT_DESTINATION_STATUS_CLASSES, computeDisplayStatus, isExpiringSoon, accountTypeLabel, ACCOUNT_TYPE_OPTIONS } from '@/lib/payouts/destination-status-labels'

interface Bank {
  bank_code: string
  display_name: string
  banv_supported: boolean
}

interface Destination {
  id: string
  version: number
  is_current: boolean
  bank_code: string
  universal_branch_code: string
  account_type: string
  account_last4: string
  verification_status: string
  verified_at: string | null
  verification_expires_at: string | null
  disabled_at: string | null
  created_at: string
  payout_banks: { display_name: string; banv_supported: boolean } | null
}

type KycStatus = 'not_started' | 'pending' | 'under_review' | 'additional_information_required' | 'approved' | 'rejected'

/**
 * E34: the one reusable "Payout destination settings" surface, used
 * identically from the merchant and affiliate dashboards (both map to
 * profiles.id -- phase brief §11, never a duplicate merchant-bank/
 * affiliate-bank data store). Client component + fetch to the existing
 * E32 API routes, matching this codebase's established pattern for an
 * interactive settings form (personalization-settings-form.tsx) --
 * hand-rolled Tailwind, no shadcn Card/Badge/Select (none exist here).
 *
 * Raw account number is held in local state only until the POST
 * succeeds, then cleared and never rendered again (phase brief §17) --
 * the server never echoes it back (payout_destinations' own columns
 * are already safe, confirmed E32).
 */
export function PayoutDestinationSettings() {
  const t = useTranslations('common.payoutDestination')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [kycStatus, setKycStatus] = useState<KycStatus | null>(null)
  const [legalName, setLegalName] = useState<string | null>(null)
  const [destinations, setDestinations] = useState<Destination[]>([])
  const [banks, setBanks] = useState<Bank[]>([])

  const [showForm, setShowForm] = useState(false)
  const [confirmingReplace, setConfirmingReplace] = useState(false)
  const [confirmingDisable, setConfirmingDisable] = useState(false)
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountType, setAccountType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(false)
  const [disabling, setDisabling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [verificationRes, destinationsRes, banksRes] = await Promise.all([fetch('/api/verification/me'), fetch('/api/payout-destinations'), fetch('/api/payout-banks')])
      if (!verificationRes.ok || !destinationsRes.ok || !banksRes.ok) throw new Error()
      const verification = await verificationRes.json()
      const destinationsData = await destinationsRes.json()
      const banksData = await banksRes.json()
      setKycStatus(verification.status)
      setLegalName(verification.legalFirstName && verification.legalSurname ? `${verification.legalFirstName} ${verification.legalSurname}` : null)
      setDestinations(destinationsData.destinations ?? [])
      setBanks(banksData.banks ?? [])
    } catch {
      setError(t('errors.couldNotLoad'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const current = destinations.find((d) => d.is_current && !d.disabled_at) ?? null
  const kycApproved = kycStatus === 'approved'

  async function submitAdd() {
    setFormError(null)
    if (!bankCode || !accountNumber || !accountType) {
      setFormError(t('errors.fillAllFields'))
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/payout-destinations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_code: bankCode, account_number: accountNumber, account_type: accountType }),
      })
      const data = await res.json()
      if (!res.ok) {
        setFormError(data?.error ?? t('errors.couldNotSave'))
        return
      }
      // Clear the raw value from local state immediately -- it is
      // never rendered again, by design (phase brief §17).
      setAccountNumber('')
      setBankCode('')
      setAccountType('')
      setShowForm(false)
      setConfirmingReplace(false)
      setActionMessage(t('messages.added'))
      await load()
    } catch {
      setFormError(t('errors.couldNotSave'))
    } finally {
      setSubmitting(false)
    }
  }

  async function startVerification(destinationId: string) {
    setVerifying(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/payout-destinations/${destinationId}/verify`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setActionMessage(data?.error ?? t('errors.couldNotVerify'))
        return
      }
      setActionMessage(t('messages.verificationStarted'))
      await load()
    } catch {
      setActionMessage(t('errors.couldNotVerify'))
    } finally {
      setVerifying(false)
    }
  }

  async function checkStatus(destinationId: string) {
    setCheckingStatus(true)
    setActionMessage(null)
    try {
      const res = await fetch(`/api/payout-destinations/${destinationId}/reconcile`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setActionMessage(data?.error ?? t('errors.couldNotCheckStatus'))
        return
      }
      setActionMessage(t('messages.statusChecked'))
      await load()
    } catch {
      setActionMessage(t('errors.couldNotCheckStatus'))
    } finally {
      setCheckingStatus(false)
    }
  }

  async function disableCurrent(destinationId: string) {
    setDisabling(true)
    try {
      const res = await fetch(`/api/payout-destinations/${destinationId}/disable`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setActionMessage(data?.error ?? t('errors.couldNotDisable'))
        return
      }
      setConfirmingDisable(false)
      setActionMessage(t('messages.disabled'))
      await load()
    } catch {
      setActionMessage(t('errors.couldNotDisable'))
    } finally {
      setDisabling(false)
    }
  }

  if (loading) return <p className="text-sm text-[#9B8B85]">{t('loading')}</p>
  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>

  const selectedBank = banks.find((b) => b.bank_code === bankCode)

  return (
    <div className="space-y-6">
      {actionMessage && <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">{actionMessage}</p>}

      {/* KYC blocker -- phase brief §54 */}
      {!kycApproved && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">{t('kycBlock.title')}</div>
            <div className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">{t('kycBlock.message')}</div>
          </div>
          <Link href="/verify" className="shrink-0 px-4 py-2 bg-amber-600 text-white text-xs font-semibold uppercase tracking-[0.08em] rounded-lg hover:bg-amber-700 transition-colors">
            {t('kycBlock.cta')}
          </Link>
        </div>
      )}

      {/* Current destination card */}
      {current && !showForm && (
        <div className="p-5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
                {current.payout_banks?.display_name ?? current.bank_code} •••• {current.account_last4}
              </p>
              <p className="text-xs text-[#9B8B85] mt-0.5">{accountTypeLabel(current.account_type)}</p>
            </div>
            {(() => {
              const displayStatus = computeDisplayStatus(current.verification_status, current.verification_expires_at)
              return (
                <span className={`px-2.5 py-1 rounded-full text-[11px] font-medium ${PAYOUT_DESTINATION_STATUS_CLASSES[displayStatus]}`}>{t(`status.${displayStatus}`)}</span>
              )
            })()}
          </div>

          {legalName && (
            <p className="text-xs text-[#9B8B85]">
              {t('accountHolderNotice')} <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{legalName}</span>
            </p>
          )}

          {current.verification_status === 'verified' && current.verified_at && (
            <p className="text-xs text-[#9B8B85]">
              {isExpiringSoon(current.verification_status, current.verification_expires_at) ? t('expiringSoonNotice') : t('verifiedOnNotice', { date: new Date(current.verified_at).toLocaleDateString() })}
            </p>
          )}

          {current.verification_status === 'failed' && <p className="text-xs text-red-600 dark:text-red-400">{t('failedNotice')}</p>}

          {current.payout_banks?.banv_supported === false && current.verification_status === 'unverified' && (
            <p className="text-xs text-amber-600 dark:text-amber-500">{t('banvUnsupportedNotice')}</p>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {current.payout_banks?.banv_supported !== false && (current.verification_status === 'unverified' || current.verification_status === 'failed') && (
              <button
                type="button"
                onClick={() => startVerification(current.id)}
                disabled={verifying || !kycApproved}
                className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
              >
                {verifying ? t('verifying') : t('startVerificationButton')}
              </button>
            )}
            {(current.verification_status === 'pending' || current.verification_status === 'processing') && (
              <button
                type="button"
                onClick={() => checkStatus(current.id)}
                disabled={checkingStatus}
                className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
              >
                {checkingStatus ? t('checkingStatus') : t('checkStatusButton')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setConfirmingReplace(true)}
              className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] border border-[#E8E0D8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
            >
              {t('replaceButton')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDisable(true)}
              className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              {t('disableButton')}
            </button>
          </div>

          {confirmingReplace && (
            <div className="p-4 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 mt-2">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-1">{t('replaceWarning.title')}</p>
              <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">{t('replaceWarning.message')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingReplace(false)
                    setShowForm(true)
                  }}
                  className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors"
                >
                  {t('replaceWarning.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingReplace(false)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                >
                  {t('cancelButton')}
                </button>
              </div>
            </div>
          )}

          {confirmingDisable && (
            <div className="p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 mt-2">
              <p className="text-sm font-semibold text-red-700 dark:text-red-400 mb-1">{t('disableWarning.title')}</p>
              <p className="text-xs text-red-600 dark:text-red-400 mb-3">{t('disableWarning.message')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => disableCurrent(current.id)}
                  disabled={disabling}
                  className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {disabling ? t('disabling') : t('disableWarning.confirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDisable(false)}
                  className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                >
                  {t('cancelButton')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* No destination at all -- phase brief §59, never a "process anyway" shortcut */}
      {!current && !showForm && (
        <div className="p-5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-center">
          <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] mb-1">{t('noDestination.title')}</p>
          <p className="text-xs text-[#9B8B85] mb-4">{t('noDestination.message')}</p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            disabled={!kycApproved}
            className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
          >
            {t('addButton')}
          </button>
        </div>
      )}

      {/* Add/replace form */}
      {showForm && (
        <div className="p-5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] space-y-4">
          <p className="text-sm font-bold uppercase tracking-[0.08em] text-[#1A0A0A] dark:text-[#F5F0ED]">{t('formHeading')}</p>

          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}

          <div>
            <label htmlFor="payout-bank" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">
              {t('bankLabel')}
            </label>
            <select
              id="payout-bank"
              value={bankCode}
              onChange={(e) => setBankCode(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm"
            >
              <option value="">{t('bankPlaceholder')}</option>
              {banks.map((bank) => (
                <option key={bank.bank_code} value={bank.bank_code}>
                  {bank.display_name}
                </option>
              ))}
            </select>
            {selectedBank && !selectedBank.banv_supported && <p className="text-xs text-amber-600 dark:text-amber-500 mt-1.5">{t('banvUnsupportedNotice')}</p>}
          </div>

          <div>
            <label htmlFor="payout-account-number" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">
              {t('accountNumberLabel')}
            </label>
            <input
              id="payout-account-number"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]*"
              maxLength={13}
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm"
            />
          </div>

          <div>
            <label htmlFor="payout-account-type" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1.5">
              {t('accountTypeLabel')}
            </label>
            <select
              id="payout-account-type"
              value={accountType}
              onChange={(e) => setAccountType(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border border-[#E8E0D8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-[#F5F0ED] text-sm"
            >
              <option value="">{t('accountTypePlaceholder')}</option>
              {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {legalName && (
            <p className="text-xs text-[#9B8B85]">
              {t('accountHolderNotice')} <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{legalName}</span>
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={submitAdd}
              disabled={submitting}
              className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] bg-[#8B1A1A] text-white hover:bg-[#6B1414] transition-colors disabled:opacity-50"
            >
              {submitting ? t('saving') : t('saveButton')}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                setFormError(null)
                setAccountNumber('')
              }}
              className="px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.08em] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
            >
              {t('cancelButton')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
