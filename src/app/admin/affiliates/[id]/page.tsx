import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminAffiliateDetail } from '@/lib/admin/affiliate-service'
import { AdminPageHeader, Pill, ACCOUNT_STATUS_STYLES, formatDateTime, formatMoney } from '@/components/admin/ui'
import { AFFILIATE_COMMISSION_STATUS_LABELS, type AffiliateCommissionStatus } from '@/lib/affiliate/status-labels'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata = { title: 'Affiliate — Unity Admin' }

export default async function AdminAffiliateDetailPage({ params }: PageProps) {
  const { id: affiliateId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminAffiliateDetail(admin, affiliateId)
  if (!detail) notFound()

  const { affiliate, attributions, commissions } = detail

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/affiliates" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to affiliates
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={affiliate.name ?? affiliate.affiliateCode ?? 'Affiliate'} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Affiliate</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Code</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-mono">{affiliate.affiliateCode ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Account status</dt>
            <dd>{affiliate.accountStatus ? <Pill value={affiliate.accountStatus} styles={ACCOUNT_STATUS_STYLES} /> : '—'}</dd>
            <dt className="text-[#9B8B85]">Joined</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(affiliate.createdAt)}</dd>
            <dt className="text-[#9B8B85]">Total paid</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold">{formatMoney(affiliate.paidAmount)}</dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Attributions ({attributions.length})</h2>
          {attributions.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No attributions yet.</p>
          ) : (
            <ul className="space-y-2">
              {attributions.map((a) => {
                const row = a as unknown as { id: string; listing_id: string; status: string; attributed_at: string; listings: { title: string } | null }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{row.listings?.title ?? row.listing_id} — {row.status}</span>
                    <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(row.attributed_at)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Commissions ({commissions.length})</h2>
          {commissions.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No commissions yet.</p>
          ) : (
            <ul className="space-y-2">
              {commissions.map((c) => {
                const row = c as unknown as { id: string; status: AffiliateCommissionStatus; commission_amount: number; created_at: string; listings: { title: string } | null }
                return (
                  <li key={row.id} className="text-sm flex items-baseline justify-between gap-4">
                    <Link href={`/admin/affiliate-commissions/${row.id}`} className="text-[#1A0A0A] dark:text-[#F5F0ED] hover:underline">
                      {row.listings?.title ?? 'Listing'} — {formatMoney(row.commission_amount)}
                    </Link>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium ${AFFILIATE_COMMISSION_STATUS_LABELS[row.status]?.classes ?? ''}`}>
                      {AFFILIATE_COMMISSION_STATUS_LABELS[row.status]?.label ?? row.status}
                    </span>
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
