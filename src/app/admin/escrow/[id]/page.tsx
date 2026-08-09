import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminEscrowDetail } from '@/lib/admin/escrow-service'
import { AdminPageHeader, formatDateTime, formatMoney } from '@/components/admin/ui'
import { EscrowActions } from '@/components/admin/escrow-actions'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Secure Transaction — Unity Admin' }

/**
 * Phase 3 -- admin overrides only: release/refund/cancel. No direct edit
 * path exists anywhere for the original principal_amount/currency/
 * provider/transaction reference. TradeSafe is a proposed provider
 * only -- no user/merchant/admin-facing copy anywhere in this codebase
 * claims a live TradeSafe integration.
 */
export default async function AdminEscrowDetailPage({ params }: PageProps) {
  const { id: escrowId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminEscrowDetail(admin, escrowId)
  if (!detail) notFound()

  const { escrow, transactionReference, disputes, history } = detail
  const e = escrow as unknown as {
    id: string
    transaction_type: string
    status: string
    provider: string
    provider_reference: string | null
    principal_amount: number
    secure_transaction_fee_amount: number
    currency: string
    released_to: string | null
    release_reason: string | null
    refunded_amount: number
    failure_reason: string | null
    created_at: string
    funded_at: string | null
    released_at: string | null
    refunded_at: string | null
    cancelled_at: string | null
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/escrow" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to secure transactions
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={`Escrow — ${transactionReference ?? e.transaction_type}`} badge={e.status} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Transaction</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Type</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{e.transaction_type}</dd>
            <dt className="text-[#9B8B85]">Reference</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{transactionReference ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Provider</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.provider}</dd>
            <dt className="text-[#9B8B85]">Provider reference</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.provider_reference ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Created</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(e.created_at)}</dd>
            {e.funded_at && (<><dt className="text-[#9B8B85]">Funded</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(e.funded_at)}</dd></>)}
            {e.released_at && (<><dt className="text-[#9B8B85]">Released</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(e.released_at)}</dd></>)}
            {e.refunded_at && (<><dt className="text-[#9B8B85]">Refunded</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(e.refunded_at)}</dd></>)}
            {e.cancelled_at && (<><dt className="text-[#9B8B85]">Cancelled</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(e.cancelled_at)}</dd></>)}
          </dl>
          <p className="text-xs text-[#9B8B85] mt-2">
            Principal amount, currency, provider, and transaction reference are immutable snapshots — corrections happen through refund or append-only history, never a direct edit.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Financials</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Held in trust (principal)</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(e.principal_amount, e.currency)}</dd>
            <dt className="text-[#9B8B85]">Secure transaction fee (never Unity commission)</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(e.secure_transaction_fee_amount, e.currency)}</dd>
            <dt className="text-[#9B8B85]">Refunded so far</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(e.refunded_amount, e.currency)}</dd>
            {e.released_to && (<><dt className="text-[#9B8B85]">Released to</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.released_to}</dd></>)}
            {e.release_reason && (<><dt className="text-[#9B8B85]">Release reason</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.release_reason}</dd></>)}
            {e.failure_reason && (<><dt className="text-[#9B8B85]">Failure reason</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{e.failure_reason}</dd></>)}
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Disputes ({disputes.length})</h2>
          {disputes.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No disputes on this transaction.</p>
          ) : (
            <ul className="space-y-2">
              {disputes.map((d) => {
                const row = d as unknown as { id: string; status: string; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <Link href={`/admin/disputes/${row.id}`} className="text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline capitalize">{row.status}</Link>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Admin actions</h2>
          <EscrowActions escrowId={e.id} status={e.status} defaultReleaseTo={e.released_to} />
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Immutable history</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No history recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => {
                const row = h as unknown as { id: string; previous_status: string | null; new_status: string; actor_type: string; reason: string | null; created_at: string }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {row.previous_status ? `${row.previous_status} → ${row.new_status}` : row.new_status}
                      <span className="text-[#9B8B85]"> — {row.actor_type}{row.reason ? `: ${row.reason}` : ''}</span>
                    </span>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.created_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
