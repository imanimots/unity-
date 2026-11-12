'use client'

import { useState, useEffect, useCallback } from 'react'
import { AdminPageHeader, Pill } from '@/components/admin/ui'

interface Readiness {
  executionGateConfigured: boolean
  credentialsPresent: boolean
  productActivationConfirmed: 'yes' | 'no' | 'unknown'
  sourceOfFundsConfirmed: 'yes' | 'no' | 'unknown'
  webhookConfigured: 'yes' | 'no' | 'unknown'
  webhookSigningConfigured: boolean
  destinationAuthorityHealthy: boolean
  providerClientHealthy: boolean
  sandboxCertified: boolean
  sandboxCertificationBlockedReason: string | null
  productionCanaryApproved: boolean
}

const BOOL_STYLES: Record<string, string> = { yes: 'bg-green-100 text-green-700', no: 'bg-red-100 text-red-700' }
const TRISTATE_STYLES: Record<string, string> = { yes: 'bg-green-100 text-green-700', no: 'bg-red-100 text-red-700', unknown: 'bg-[#F2EDE8] text-[#6B5B55]' }

function boolPill(value: boolean) {
  return <Pill value={value ? 'yes' : 'no'} styles={BOOL_STYLES} />
}

/**
 * /admin/payouts/readiness -- E34 phase brief §47: exposes
 * getPeachPayoutActivationReadiness() to authorized admins. Pure
 * read-only display -- no action on this page can flip any gate; that
 * is deliberate (phase brief §48/§50: activation is a separate,
 * explicit decision never made from a UI button).
 */
export default function AdminPayoutReadinessPage() {
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [productionReady, setProductionReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/payouts/readiness')
      if (!res.ok) throw new Error()
      const data = await res.json()
      setReadiness(data.readiness)
      setProductionReady(data.productionReady)
    } catch {
      setError('Could not load readiness status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <AdminPageHeader eyebrow="Payments Operations" title="Peach Payouts Readiness" badge={productionReady ? undefined : 'Production gate OFF'} />

      {loading && <p className="text-sm text-[#9B8B85]">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {readiness && (
        <>
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
            <Row label="Execution gate configured (PEACH_PAYOUTS_EXECUTION_ENABLED)">{boolPill(readiness.executionGateConfigured)}</Row>
            <Row label="Payouts credentials present">{boolPill(readiness.credentialsPresent)}</Row>
            <Row label="Peach Payouts product activated">
              <Pill value={readiness.productActivationConfirmed} styles={TRISTATE_STYLES} />
            </Row>
            <Row label="Source of funds approved">
              <Pill value={readiness.sourceOfFundsConfirmed} styles={TRISTATE_STYLES} />
            </Row>
            <Row label="Webhook signing secret configured">{boolPill(readiness.webhookSigningConfigured)}</Row>
            <Row label="Webhook URL registered on Dashboard (cannot be verified by code)">
              <Pill value={readiness.webhookConfigured} styles={TRISTATE_STYLES} />
            </Row>
            <Row label="Destination authority (payout_banks) healthy">{boolPill(readiness.destinationAuthorityHealthy)}</Row>
            <Row label="Provider client healthy">{boolPill(readiness.providerClientHealthy)}</Row>
            <Row label="Sandbox certification completed">
              <div className="text-right">
                {boolPill(readiness.sandboxCertified)}
                {readiness.sandboxCertificationBlockedReason && <p className="text-[11px] text-[#9B8B85] mt-1">{readiness.sandboxCertificationBlockedReason}</p>}
              </div>
            </Row>
            <Row label="Real-money canary approved">{boolPill(readiness.productionCanaryApproved)}</Row>
          </div>

          <div className={`rounded-xl p-5 border ${productionReady ? 'bg-green-50 border-green-200' : 'bg-[#F2EDE8] dark:bg-[#1A1010] border-[#E8E0D8] dark:border-[#2A1A1A]'}`}>
            <p className="text-sm font-bold uppercase tracking-[0.08em]">{productionReady ? 'Production ready' : 'Production NOT ready'}</p>
            <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1">
              Every readiness item above must be satisfied simultaneously. Even when all are, activation still requires a separate, explicit decision -- this page cannot enable
              production execution.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] max-w-md">{label}</p>
      {children}
    </div>
  )
}
