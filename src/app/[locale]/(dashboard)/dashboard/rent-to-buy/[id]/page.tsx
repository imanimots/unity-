import { notFound, redirect } from 'next/navigation'
import { getTranslations, getLocale } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'
import { requireAuth } from '@/lib/supabase/require-admin'
import { getRentToBuyAgreementDetail } from '@/lib/data/rent-to-buy'
import { RentToBuyAgreementActions } from '@/components/rent-to-buy/agreement-detail-client'
import { formatDate } from '@/lib/i18n/format'
import { withLocalePrefix, type Locale } from '@/i18n/locales'

interface PageProps {
  params: Promise<{ id: string }>
}

const STATUS_KEYS: Record<string, string> = {
  pending_merchant_acceptance: 'pendingMerchantAcceptance',
  awaiting_first_payment: 'awaitingFirstPayment',
  active: 'active',
  defaulted: 'defaulted',
  return_required: 'returnRequired',
  completed: 'completed',
  cancelled: 'cancelled',
  disputed: 'disputed',
}

const POSSESSION_KEYS: Record<string, string> = {
  not_delivered: 'notDelivered',
  possession_eligible: 'possessionEligible',
  customer_in_possession: 'customerInPossession',
  return_required: 'returnRequired',
  return_in_progress: 'returnInProgress',
  returned_to_merchant: 'returnedToMerchant',
  recovered: 'recovered',
}

const INSTALLMENT_KEYS: Record<string, string> = {
  scheduled: 'scheduled',
  paid: 'paid',
  failed: 'failed',
  waived: 'waived',
}

export default async function RentToBuyAgreementPage({ params }: PageProps) {
  const { id } = await params
  const locale = (await getLocale()) as Locale
  const requester = await requireAuth()
  if (!requester) {
    const target = withLocalePrefix(`/dashboard/rent-to-buy/${id}`, locale)
    redirect(`${withLocalePrefix('/login', locale)}?redirectTo=${encodeURIComponent(target)}`)
  }

  const t = await getTranslations('rtb')

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
          <ArrowLeft size={13} /> {t('back')}
        </Link>
      </div>

      <div className="mb-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">{t('label')}</p>
        <h1 className="text-2xl lg:text-3xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED] tracking-tight">{listing?.title ?? t('item')}</h1>
      </div>

      {/* Mandatory disclosure -- Rule P, never hidden in tiny text. */}
      <div className="bg-[#FFF8E8] dark:bg-[#2A2010] border border-[#E8D8A8] dark:border-[#4A3A1A] rounded-xl p-5 mb-6 text-sm text-[#5A4A20] dark:text-[#D8C888] space-y-2">
        <p>{t.rich('disclosureFirst', { strong: (chunks) => <strong>{chunks}</strong> })}</p>
        <p>{t('disclosureDefault')}</p>
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 mb-6 space-y-4">
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('statusLabel')}</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t(`status.${STATUS_KEYS[agreement.status] ?? 'active'}`)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('possessionLabel')}</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t(`possessionStatus.${POSSESSION_KEYS[agreement.possession_status] ?? 'notDelivered'}`)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('ownershipLabel')}</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{t(agreement.ownership_status === 'merchant_owned' ? 'ownershipStatus.merchantOwned' : 'ownershipStatus.customerOwned')}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('purchaseProgress')}</span>
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">
            {agreement.currency} {purchaseProgress.paidPrincipal.toLocaleString()} / {purchaseProgress.totalPurchasePrice.toLocaleString()} ({purchaseProgress.percentPaid.toFixed(0)}%)
          </span>
        </div>
        {agreement.security_deposit_amount ? (
          <div className="flex justify-between text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">{t('securityDeposit')}</span>
            <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{agreement.currency} {Number(agreement.security_deposit_amount).toLocaleString()}</span>
          </div>
        ) : null}
        {agreement.status === 'defaulted' && (
          <div className="pt-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] text-sm text-[#8B1A1A]">
            <p className="font-semibold uppercase text-xs tracking-wide">{t('terminated')}</p>
            <p className="mt-1">{t('returnRequiredNotice')}</p>
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-6 mb-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">{t('paymentSchedule')}</p>
        <div className="space-y-2">
          {installments.map((i) => (
            <div key={i.id} className="flex justify-between text-sm">
              <span className="text-[#6B5B55] dark:text-[#9B8B85]">#{i.sequence} — {formatDate(i.due_date, locale)}</span>
              <span className={i.status === 'paid' ? 'text-green-700 dark:text-green-500 font-semibold' : 'text-[#1A0A0A] dark:text-[#F5F0ED]'}>
                {agreement.currency} {Number(i.principal_amount).toLocaleString()} — {t(`installmentStatus.${INSTALLMENT_KEYS[i.status] ?? 'scheduled'}`)}
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
