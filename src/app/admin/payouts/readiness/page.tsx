'use client'

import { useState, useEffect, useCallback } from 'react'
import { AdminPageHeader, Pill } from '@/components/admin/ui'

interface Readiness {
  activeProvider: string
  realProviderConfigured: boolean
  executionGateConfigured: boolean
  destinationAuthorityHealthy: boolean
  sandboxCertified: boolean
  productionCanaryApproved: boolean
  integrationStatus: string
}

const BOOL_STYLES: Record<string, string> = {
  yes: 'bg-green-100 text-green-700',
  no: 'bg-red-100 text-red-700',
}

function boolPill(value: boolean) {
  return <Pill value={value ? 'yes' : 'no'} styles={BOOL_STYLES} />
}

/**
 * Read-only provider-neutral launch readiness. This surface cannot enable
 * payment execution and deliberately contains no Peach activation logic.
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
    load()
  }, [load])

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-10 space-y-8">
      <AdminPageHeader
        eyebrow="Payments Operations"
        title="Payment Provider Readiness"
        badge={productionReady ? undefined : 'Production gate OFF'}
      />

      {loading && <p className="text-sm text-[#9B8B85]">Loading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {readiness && (
        <>
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl divide-y divide-[#F2EDE8] dark:divide-[#2A1A1A]">
            <Row label="Configured provider">
              <span className="text-sm font-semibold text-right">{readiness.activeProvider}</span>
            </Row>
            <Row label="Real provider integrated">{boolPill(readiness.realProviderConfigured)}</Row>
            <Row label="Provider-neutral payout execution gate enabled">{boolPill(readiness.executionGateConfigured)}</Row>
            <Row label="Destination authority healthy">{boolPill(readiness.destinationAuthorityHealthy)}</Row>
            <Row label="Sandbox certification completed">{boolPill(readiness.sandboxCertified)}</Row>
            <Row label="Real-money canary approved">{boolPill(readiness.productionCanaryApproved)}</Row>
            <Row label="Integration status">
              <span className="text-sm font-semibold text-right">{readiness.integrationStatus}</span>
            </Row>
          </div>

          <div className={`rounded-xl p-5 border ${productionReady ? 'bg-green-50 border-green-200' : 'bg-[#F2EDE8] dark:bg-[#1A1010] border-[#E8E0D8] dark:border-[#2A1A1A]'}`}>
            <p className="text-sm font-bold uppercase tracking-[0.08em]">
              {productionReady ? 'Production ready' : 'Production NOT ready'}
            </p>
            <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1">
              TradeSafe or another real provider must be integrated and sandbox-certified before production
              execution can be approved. This page is read-only and cannot enable money movement.
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
