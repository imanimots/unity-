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

  const { agreement, listing, merchant, customer, installments, history, returnCases, disputes, commissionEvents, purchaseProgress } = detail
  const pendingReturnCase = returnCases.find((c) => c.status === 'requested' || c.status === 'scheduled')

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-4xl">
      <AdminPageHeader eyebrow="Rent-to-Buy" title={listing?.title ?? 'Agreement'} />

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div><span className="text-[#9B8B85]">Status:</span> <span className="font-semibold">{agreement.status}</span></div>
          <div><span className="text-[#9B8B85]">Possession:</span> <span className="font-semibold">{agreement.possession_status}</span></div>
          <div><span className="text-[#9B8B85]">Ownership:</span> <span className="font-semibold">{agreement.ownership_status}</span></div>
          <div><span className="text-[#9B8B85]">Merchant:</span> <span className="font-semibold">{merchant?.full_name ?? merchant?.display_name} ({merchant?.kyc_status})</span></div>
          <div><span className="text-[#9B8B85]">Customer:</span> <span className="font-semibold">{customer?.full_name ?? customer?.display_name} ({customer?.kyc_status})</span></div>
          <div><span className="text-[#9B8B85]">Purchase progress:</span> <span className="font-semibold">{agreement.currency} {purchaseProgress.paidPrincipal.toLocaleString()} / {purchaseProgress.totalPurchasePrice.toLocaleString()} ({purchaseProgress.percentPaid.toFixed(0)}%)</span></div>
          <div><span className="text-[#9B8B85]">Remaining:</span> <span className="font-semibold">{agreement.currency} {purchaseProgress.remainingBalance.toLocaleString()}</span></div>
          <div><span className="text-[#9B8B85]">Deposit:</span> <span className="font-semibold">{agreement.security_deposit_amount ? `${agreement.currency} ${Number(agreement.security_deposit_amount).toLocaleString()} (not part of purchase price)` : 'None'}</span></div>
        </div>
        {agreement.default_reconciliation_pending && (
          <div className="pt-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] text-[#8B1A1A]">
            <p className="font-semibold uppercase text-xs tracking-wide">RTB purchase path terminated</p>
            <p className="text-xs mt-1">Item return required. Rental reconciliation policy pending / applicable — no charge computed.</p>
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
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Disputes ({disputes.length}) / Commission events ({commissionEvents.length})</p>
        <p className="text-xs text-[#9B8B85]">Commission rate: policy-pending — no chargeable amount exists yet.</p>
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
