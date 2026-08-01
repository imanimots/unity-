import { CheckCircle2, Clock, AlertTriangle, XCircle, CreditCard, CalendarX } from 'lucide-react'
import {
  FINANCIAL_READINESS_RENTER_COPY,
  FINANCIAL_READINESS_MERCHANT_COPY,
  type FinancialReadinessState,
} from '@/lib/checkout/financial-readiness'

const ICONS: Record<FinancialReadinessState, typeof CheckCircle2> = {
  not_prepared: Clock,
  awaiting_payment: CreditCard,
  processing: Clock,
  payment_failed_retryable: AlertTriangle,
  payment_failed_terminal: XCircle,
  deposit_failed_retryable: AlertTriangle,
  deposit_failed_terminal: XCircle,
  financially_ready: CheckCircle2,
  no_payment_required: CheckCircle2,
  expired_unpaid: CalendarX,
}

const TONE: Record<FinancialReadinessState, string> = {
  not_prepared: 'text-[#9B8B85]',
  awaiting_payment: 'text-blue-600 dark:text-blue-400',
  processing: 'text-blue-600 dark:text-blue-400',
  payment_failed_retryable: 'text-amber-600 dark:text-amber-400',
  payment_failed_terminal: 'text-red-600 dark:text-red-400',
  deposit_failed_retryable: 'text-amber-600 dark:text-amber-400',
  deposit_failed_terminal: 'text-red-600 dark:text-red-400',
  financially_ready: 'text-green-600 dark:text-green-400',
  no_payment_required: 'text-green-600 dark:text-green-400',
  expired_unpaid: 'text-[#9B8B85]',
}

interface Props {
  readiness: FinancialReadinessState
  audience: 'renter' | 'merchant'
  children?: React.ReactNode
}

/** Provider-neutral -- renders purely from the derived FinancialReadinessState, never imports a provider. */
export function FinancialReadinessCard({ readiness, audience, children }: Props) {
  const copy = (audience === 'renter' ? FINANCIAL_READINESS_RENTER_COPY : FINANCIAL_READINESS_MERCHANT_COPY)[readiness]
  const Icon = ICONS[readiness]
  const tone = TONE[readiness]

  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
      <div className="flex items-start gap-3">
        <Icon size={20} className={`shrink-0 mt-0.5 ${tone}`} />
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${tone}`}>{copy.label}</p>
          {copy.description && <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] mt-1">{copy.description}</p>}
        </div>
      </div>
      {children && <div className="mt-4 pt-4 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">{children}</div>}
    </div>
  )
}
