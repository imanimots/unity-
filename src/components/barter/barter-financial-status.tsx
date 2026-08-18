import { CheckCircle2, Clock, XCircle } from 'lucide-react'
import { deriveBarterFinancialReadiness, BARTER_FINANCIAL_READINESS_COPY, type BarterDepositRequirement, type BarterPaymentStatus, type BarterFinancialReadinessState } from '@/lib/barter/financial-readiness'
import type { BarterOffer, BarterPayment } from '@/types'

interface BarterFinancialStatusLabels {
  paymentStatus: string
  readiness: Record<BarterFinancialReadinessState, { label: string; description: string }>
  paid: string
  failed: string
  pending: string
  depositOf: (name: string) => string
  cashAdjustmentOf: (amount: string) => string
}

interface BarterFinancialStatusProps {
  offer: Pick<BarterOffer, 'deposit_required' | 'deposit_amount' | 'deposit_payer' | 'cash_adjustment_amount' | 'cash_adjustment_payer'>
  payments: BarterPayment[]
  partyAId: string
  partyBId: string
  partyAName: string
  partyBName: string
  /**
   * Rendered both inside [locale] (via BarterAgreementView) AND directly
   * by admin/barter/[id]/page.tsx, which has no NextIntlClientProvider at
   * all. Server-resolved label overrides instead of useTranslations() --
   * admin call sites omit this and keep the English literals below.
   */
  labels?: BarterFinancialStatusLabels
}

const READY_STATUSES = new Set(['authorised', 'captured', 'released'])

function asPaymentStatus(status: string | undefined): BarterPaymentStatus {
  return (status ?? 'pending') as BarterPaymentStatus
}

/** status is the raw payments.status column value -- always one of the payment_status enum's members, just typed loosely on BarterPayment. */
function StatusPill({ status, labels }: { status: string; labels?: BarterFinancialStatusLabels }) {
  if (status && READY_STATUSES.has(status)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-400">
        <CheckCircle2 size={13} /> {labels?.paid ?? 'Paid'}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400">
        <XCircle size={13} /> {labels?.failed ?? 'Failed'}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
      <Clock size={13} /> {labels?.pending ?? 'Pending'}
    </span>
  )
}

/**
 * Deposit-per-party + cash-adjustment status + an overall readiness
 * badge (Step 11 Phase 4 Part K). Purely presentational -- the real
 * gate is mark_barter_progress()'s own server-side readiness check;
 * this only mirrors the same derivation for display.
 */
export function BarterFinancialStatus({ offer, payments, partyAId, partyBId, partyAName, partyBName, labels }: BarterFinancialStatusProps) {
  if (!offer.deposit_required && offer.cash_adjustment_amount <= 0) return null

  const depositA = payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === partyAId)
  const depositB = payments.find((p) => p.payment_type === 'barter_deposit' && p.renter_id === partyBId)
  const cashPayment = payments.find((p) => p.payment_type === 'barter_cash_adjustment')

  const depositRequirements: BarterDepositRequirement[] = []
  if (offer.deposit_required && (offer.deposit_payer === 'party_a' || offer.deposit_payer === 'both')) {
    depositRequirements.push({ payer: 'party_a', status: asPaymentStatus(depositA?.status) })
  }
  if (offer.deposit_required && (offer.deposit_payer === 'party_b' || offer.deposit_payer === 'both')) {
    depositRequirements.push({ payer: 'party_b', status: asPaymentStatus(depositB?.status) })
  }

  const readiness = deriveBarterFinancialReadiness({
    depositRequirements,
    cashAdjustmentRequired: offer.cash_adjustment_amount > 0,
    cashAdjustmentStatus: asPaymentStatus(cashPayment?.status),
  })
  const readinessCopy = labels?.readiness[readiness] ?? BARTER_FINANCIAL_READINESS_COPY[readiness]

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">{labels?.paymentStatus ?? 'Payment status'}</h2>
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.06em] px-2 py-0.5 rounded-full ${
            readiness === 'financially_ready'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : readiness === 'payment_failed'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
          }`}
        >
          {readinessCopy.label}
        </span>
      </div>
      <div className="space-y-2">
        {depositRequirements.some((d) => d.payer === 'party_a') && (
          <div className="flex justify-between items-center px-4 py-2.5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">{labels ? labels.depositOf(partyAName) : `${partyAName}’s deposit`}</span>
            <StatusPill status={depositA?.status ?? 'pending'} labels={labels} />
          </div>
        )}
        {depositRequirements.some((d) => d.payer === 'party_b') && (
          <div className="flex justify-between items-center px-4 py-2.5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">{labels ? labels.depositOf(partyBName) : `${partyBName}’s deposit`}</span>
            <StatusPill status={depositB?.status ?? 'pending'} labels={labels} />
          </div>
        )}
        {offer.cash_adjustment_amount > 0 && (
          <div className="flex justify-between items-center px-4 py-2.5 bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">{labels ? labels.cashAdjustmentOf(`R${offer.cash_adjustment_amount}`) : `Cash adjustment (R${offer.cash_adjustment_amount})`}</span>
            <StatusPill status={cashPayment?.status ?? 'pending'} labels={labels} />
          </div>
        )}
      </div>
      <p className="text-xs text-[#9B8B85] mt-2">{readinessCopy.description}</p>
    </div>
  )
}
