import { CheckCircle2, XCircle, Circle } from 'lucide-react'
import type { PaymentStatus } from '@/lib/checkout/financial-readiness'

interface StepProps {
  label: string
  status: PaymentStatus
  targetStatus: 'captured' | 'authorised'
  failureReason: string | null
}

function Step({ label, status, targetStatus, failureReason }: StepProps) {
  const done = status === targetStatus
  const failed = status === 'failed'
  const Icon = done ? CheckCircle2 : failed ? XCircle : Circle
  const tone = done ? 'text-green-600 dark:text-green-400' : failed ? 'text-red-600 dark:text-red-400' : 'text-[#9B8B85]'

  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon size={16} className={`shrink-0 mt-0.5 ${tone}`} />
      <div>
        <span className="text-[#1A0A0A] dark:text-[#F5F0ED]">{label}</span>
        {failed && failureReason && <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">{failureReason}</p>}
      </div>
    </div>
  )
}

interface Props {
  rentalPaymentStatus: PaymentStatus
  rentalFailureReason: string | null
  depositRequired: boolean
  depositPaymentStatus: PaymentStatus
  depositFailureReason: string | null
}

/**
 * Renter-facing step-by-step attempt summary -- only ever shows the
 * user-safe failure strings already stored on the payment record
 * (e.g. "card declined"), never a raw provider error or internal code.
 */
export function PaymentAttemptSummary({ rentalPaymentStatus, rentalFailureReason, depositRequired, depositPaymentStatus, depositFailureReason }: Props) {
  return (
    <div className="space-y-3">
      <Step label="Rental payment" status={rentalPaymentStatus} targetStatus="captured" failureReason={rentalFailureReason} />
      {depositRequired && <Step label="Deposit authorization" status={depositPaymentStatus} targetStatus="authorised" failureReason={depositFailureReason} />}
    </div>
  )
}
