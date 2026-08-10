import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { getRentToBuyAgreementDetail } from '@/lib/data/rent-to-buy'
import { RentToBuyAgreementActions } from '@/components/rent-to-buy/agreement-detail-client'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function RentToBuyAgreementPage({ params }: PageProps) {
  const { id } = await params
  const requester = await requireAuth()
  if (!requester) redirect(`/login?redirectTo=/dashboard/rent-to-buy/${id}`)

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) notFound()
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const admin = createServiceClient(url, serviceKey)

  const detail = await getRentToBuyAgreementDetail(admin, id, requester.userId)
  if (!detail) notFound()

  const { agreement, listing, installments, purchaseProgress, isMerchant, isCustomer } = detail
  const nextUnpaid = installments.find((i) => i.status === 'scheduled')

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/dashboard/rent-to-buy" className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-[#9B8B85] hover:text-[#1A0A0A] dark:hover:text-[#F5F0ED] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Rent-to-Buy</p>
        <h1 className="text-2xl lg:text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{listing?.title ?? 'Item'}</h1>
      </div>

      {/* Mandatory disclosure -- Rule P, never hidden in tiny text. */}
      <div className="bg-[#FFF8E8] dark:bg-[#2A2010] border border-[#E8D8A8] dark:border-[#4A3A1A] rounded-xl p-5 mb-6 text-sm text-[#5A4A20] dark:text-[#D8C888] space-y-2">
        <p>
          You receive/use the item after the first successful payment, but <strong>the merchant remains the owner until the full rent-to-buy amount has been paid.</strong>
        </p>
        <p>
          If the agreement defaults before the full rent-to-buy amount is paid, the purchase path ends and the item must be returned to the merchant. The arrangement is treated as rental/use for the possession period.
        </p>
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 mb-6 space-y-4">
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Status</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{agreement.status}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Possession</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{agreement.possession_status}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Ownership</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{agreement.ownership_status === 'merchant_owned' ? 'Merchant owns this item' : 'You own this item'}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Purchase progress</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
            {agreement.currency} {purchaseProgress.paidPrincipal.toLocaleString()} / {purchaseProgress.totalPurchasePrice.toLocaleString()} ({purchaseProgress.percentPaid.toFixed(0)}%)
          </span>
        </div>
        {agreement.security_deposit_amount ? (
          <div className="flex justify-between text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">Security deposit (not part of purchase price)</span>
            <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{agreement.currency} {Number(agreement.security_deposit_amount).toLocaleString()}</span>
          </div>
        ) : null}
        {agreement.status === 'defaulted' && (
          <div className="pt-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] text-sm text-[#8B1A1A]">
            <p className="font-semibold uppercase text-xs tracking-wide">RTB purchase path terminated</p>
            <p className="mt-1">Item return required. Rental reconciliation policy pending business approval — no charge has been calculated.</p>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 mb-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Payment schedule</p>
        <div className="space-y-2">
          {installments.map((i) => (
            <div key={i.id} className="flex justify-between text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">#{i.sequence} — {new Date(i.due_date).toLocaleDateString('en-ZA')}</span>
              <span className={i.status === 'paid' ? 'text-green-700 dark:text-green-500 font-semibold' : 'text-[#1A0A0A] dark:text-[#F5F0ED]'}>
                {agreement.currency} {Number(i.principal_amount).toLocaleString()} — {i.status}
              </span>
            </div>
          ))}
        </div>
      </div>

      <RentToBuyAgreementActions
        agreementId={agreement.id}
        isMerchant={isMerchant}
        isCustomer={isCustomer}
        status={agreement.status}
        possessionStatus={agreement.possession_status}
        ownershipStatus={agreement.ownership_status}
        cureAllowed={agreement.cure_allowed}
        earlyPayoffAllowed={agreement.early_payoff_allowed}
        securityDepositAmount={agreement.security_deposit_amount}
        nextUnpaidSequence={nextUnpaid?.sequence ?? null}
      />
    </div>
  )
}
