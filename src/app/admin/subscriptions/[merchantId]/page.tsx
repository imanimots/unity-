import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getAdminSubscriptionDetail } from '@/lib/admin/subscriptions-service'
import { AdminPageHeader, formatDateTime, formatMoney } from '@/components/admin/ui'
import { SubscriptionAdminActions } from '@/components/admin/subscription-actions'

interface PageProps {
  params: Promise<{ merchantId: string }>
}

export const metadata = { title: 'Merchant Subscription — Unity Admin' }

/** Unity Phase 1 -- admin override is limited to admin_correct_merchant_subscription(); no direct edit path exists for history or billing attempt rows. */
export default async function AdminSubscriptionDetailPage({ params }: PageProps) {
  const { merchantId } = await params
  const requester = await requireAdmin()
  if (!requester) redirect('/login')

  const admin = await getAdminServiceClient()
  if (!admin) notFound()

  const detail = await getAdminSubscriptionDetail(admin, merchantId)
  if (!detail) notFound()

  const { merchant, effectivePlanId, effectivePlan, subscription, listingUsage, history, billingAttempts } = detail

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <Link href="/admin/subscriptions" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
        <ArrowLeft size={13} /> Back to subscriptions
      </Link>

      <AdminPageHeader eyebrow="Marketplace" title={merchant.name ?? merchant.id} badge={effectivePlanId} />

      <div className="max-w-3xl space-y-8">
        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Merchant</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Name</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{merchant.name ?? '—'}</dd>
            <dt className="text-[#9B8B85]">Account status</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{merchant.accountStatus ?? '—'}</dd>
          </dl>
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Effective plan</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-[#9B8B85]">Plan</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-semibold capitalize">{effectivePlanId}</dd>
            {effectivePlan && (
              <>
                <dt className="text-[#9B8B85]">Monthly fee</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatMoney(effectivePlan.monthlyFeeCents / 100, 'ZAR')}</dd>
                <dt className="text-[#9B8B85]">Sales commission</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{(effectivePlan.salesCommissionBps / 100).toFixed(1)}%</dd>
                <dt className="text-[#9B8B85]">Rental commission</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{(effectivePlan.rentalCommissionBps / 100).toFixed(1)}%</dd>
              </>
            )}
            <dt className="text-[#9B8B85]">Active listings</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">
              {listingUsage.activeCount}
              {listingUsage.limit !== null ? ` / ${listingUsage.limit}` : ' (unlimited)'}
            </dd>
            {subscription && (
              <>
                <dt className="text-[#9B8B85]">Subscription status</dt>
                <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{subscription.status}</dd>
                {subscription.pendingPlanId && (
                  <>
                    <dt className="text-[#9B8B85]">Pending change</dt>
                    <dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                      {subscription.pendingPlanId} on {subscription.pendingPlanEffectiveAt ? formatDateTime(subscription.pendingPlanEffectiveAt) : '—'}
                    </dd>
                  </>
                )}
              </>
            )}
          </dl>
          {!subscription && <p className="text-xs text-[#9B8B85] mt-2">This merchant has never changed plan — implicitly Starter, no subscription row exists.</p>}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Admin actions</h2>
          <SubscriptionAdminActions merchantId={merchant.id} currentPlanId={effectivePlanId} />
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Plan history ({history.length})</h2>
          {history.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No plan changes recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {history.map((h) => (
                <li key={h.id} className="text-sm flex items-baseline justify-between gap-4">
                  <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {h.previousPlanId ? `${h.previousPlanId} → ${h.newPlanId}` : h.newPlanId}
                    <span className="text-[#9B8B85]"> — {h.changeCategory} ({h.actorType}){h.reason ? `: ${h.reason}` : ''}</span>
                  </span>
                  <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(h.effectiveAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-3">Billing attempts ({billingAttempts.length})</h2>
          {billingAttempts.length === 0 ? (
            <p className="text-sm text-[#9B8B85]">No billing attempts recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {billingAttempts.map((b) => (
                <li key={b.id} className="text-sm flex items-baseline justify-between gap-4">
                  <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">
                    {b.planId} — {formatMoney(b.amountCents / 100, 'ZAR')} <span className="capitalize text-[#9B8B85]">({b.status})</span>
                    {b.failureReason ? <span className="text-[#9B8B85]">: {b.failureReason}</span> : null}
                  </span>
                  <span className="text-[#9B8B85] whitespace-nowrap">{formatDateTime(b.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
