import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminRentToBuyAgreementDetail } from '@/lib/admin/rent-to-buy-service'
import { AdminPageHeader } from '@/components/admin/ui'
import { RentToBuyAdminActions } from '@/components/rent-to-buy/admin-actions-client'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function AdminRentToBuyDetailPage({ params }: PageProps) {
  const { id } = await params
  const admin = await requireAdmin()
  if (!admin) notFound()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) notFound()
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const service = createServiceClient(url, serviceKey)

  const detail = await getAdminRentToBuyAgreementDetail(service, id)
  if (!detail) notFound()

  const { agreement, listing, merchant, customer, installments, history, returnCases, disputes, commissions, payouts, evidence, amendments, purchaseProgress, statusDimensions } = detail
  const pendingReturnCase = returnCases.find((c) => c.status === 'requested' || c.status === 'scheduled')

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-4xl">
      <AdminPageHeader eyebrow="Rent-to-Buy" title={listing?.title ?? 'Agreement'} />

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 space-y-3 text-sm">
        {/* Seven independently-tracked status dimensions -- never collapsed into one generic label. */}
        <div className="grid grid-cols-2 gap-3">
          <div><span className="text-[#9B8B85]">Payment status:</span> <span className="font-semibold">{statusDimensions.paymentStatus}</span></div>
          <div><span className="text-[#9B8B85]">Possession status:</span> <span className="font-semibold">{statusDimensions.possessionStatus}</span></div>
          <div><span className="text-[#9B8B85]">Ownership status:</span> <span className="font-semibold">{statusDimensions.ownershipStatus}</span></div>
          <div><span className="text-[#9B8B85]">Escrow settled:</span> <span className="font-semibold">{statusDimensions.escrowSettled ? 'Yes' : 'No'}</span></div>
          <div><span className="text-[#9B8B85]">Default status:</span> <span className="font-semibold">{statusDimensions.defaultStatus}</span></div>
          <div><span className="text-[#9B8B85]">Return status:</span> <span className="font-semibold">{statusDimensions.returnStatus}</span></div>
          <div><span className="text-[#9B8B85]">Deposit status:</span> <span className="font-semibold">{statusDimensions.depositStatus}</span></div>
          <div><span className="text-[#9B8B85]">Agreement status:</span> <span className="font-semibold">{agreement.status}</span></div>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
          <div><span className="text-[#9B8B85]">Merchant:</span> <span className="font-semibold">{merchant?.full_name ?? merchant?.display_name} ({merchant?.kyc_status})</span></div>
          <div><span className="text-[#9B8B85]">Customer:</span> <span className="font-semibold">{customer?.full_name ?? customer?.display_name} ({customer?.kyc_status})</span></div>
          <div><span className="text-[#9B8B85]">Purchase progress:</span> <span className="font-semibold">{agreement.currency} {purchaseProgress.paidPrincipal.toLocaleString()} / {purchaseProgress.totalPurchasePrice.toLocaleString()} ({purchaseProgress.percentPaid.toFixed(0)}%)</span></div>
          <div><span className="text-[#9B8B85]">Remaining:</span> <span className="font-semibold">{agreement.currency} {purchaseProgress.remainingBalance.toLocaleString()}</span></div>
          <div><span className="text-[#9B8B85]">Deposit amount:</span> <span className="font-semibold">{agreement.security_deposit_amount ? `${agreement.currency} ${Number(agreement.security_deposit_amount).toLocaleString()} (not part of purchase price)` : 'None'}</span></div>
          <div><span className="text-[#9B8B85]">Rental/use rate:</span> <span className="font-semibold">{agreement.currency} {Number(agreement.rental_use_rate_amount).toLocaleString()} / {agreement.rental_use_rate_unit}</span></div>
          <div><span className="text-[#9B8B85]">RTB commission rate:</span> <span className="font-semibold">{agreement.rental_commission_rate_bps != null ? `${(agreement.rental_commission_rate_bps / 100).toFixed(1)}% (rental, snapshotted at acceptance)` : 'Not yet accepted'}</span></div>
        </div>
        {agreement.default_reconciliation_pending && (
          <div className="pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] text-[#8B1A1A]">
            <p className="font-semibold uppercase text-xs tracking-wide">Formal default -- settlement pending</p>
            <p className="text-xs mt-1">Awaiting return/recovery confirmation before rental/use settlement, commission, and payout are finalized.</p>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Actions</p>
        <RentToBuyAdminActions agreementId={agreement.id} status={agreement.status} possessionStatus={agreement.possession_status} pendingReturnCaseId={pendingReturnCase?.id ?? null} />
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Payment schedule</p>
        <div className="space-y-2 text-sm">
          {installments.map((i) => (
            <div key={i.id} className="flex justify-between">
              <span>#{i.sequence} — {i.due_date}</span>
              <span>{agreement.currency} {Number(i.principal_amount).toLocaleString()} — {i.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Disputes ({disputes.length})</p>
        {disputes.map((d) => <div key={d.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{d.id} — {d.status}</div>)}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Commission (settlement-based -- one row, computed once)</p>
        {commissions.length === 0 ? (
          <p className="text-xs text-[#9B8B85]">No commission has been computed yet -- created only once this agreement completes or settles.</p>
        ) : commissions.map((c) => (
          <div key={c.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
            {agreement.currency} {Number(c.commission_amount).toLocaleString()} on eligible base {agreement.currency} {Number(c.eligible_base).toLocaleString()} ({c.standard_rate_bps / 100}% rental commission, status: {c.status})
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Merchant payouts ({payouts.length})</p>
        {payouts.map((p) => <div key={p.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{agreement.currency} {Number(p.amount).toLocaleString()} — {p.status}</div>)}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Evidence ({evidence.length}) / Amendments ({amendments.length})</p>
        {evidence.map((e) => <div key={e.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">{e.evidence_type} — {e.file_type}</div>)}
        {amendments.map((a) => <div key={a.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">Amendment ({a.status}): {JSON.stringify(a.proposed_changes)}</div>)}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">History</p>
        <div className="space-y-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          {history.map((h) => (
            <div key={h.id}>{new Date(h.created_at).toLocaleString('en-ZA')} — {h.actor_role} — {h.event_type}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
