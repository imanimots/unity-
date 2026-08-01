import { PaymentStatusBadge } from './payment-status-badge'
import type { PaymentStatus } from '@/lib/checkout/financial-readiness'

interface Props {
  bookingReference: string | null
  listingTitle: string
  merchantDisplayName: string
  startAt: string | null
  endAt: string | null
  durationUnits: number | null
  rateUnit: string | null
  rateAmount: number | null
  subtotalAmount: number | null
  platformFeeAmount: number | null
  depositAmount: number | null
  totalAmount: number | null
  currency: string
  rentalPaymentStatus: PaymentStatus
  depositPaymentStatus: PaymentStatus
}

function money(amount: number | null, currency: string) {
  if (amount === null) return '—'
  return `${currency === 'ZAR' ? 'R' : currency + ' '}${amount.toFixed(2)}`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Renders only trusted, server-derived values passed in as props -- never
 * recalculates an amount itself. Does not show merchant payout details
 * (payable amount, payout status) -- this is the renter-facing summary
 * only, per Step 5's requirement.
 */
export function PaymentBreakdown(props: Props) {
  const {
    bookingReference, listingTitle, merchantDisplayName, startAt, endAt, durationUnits,
    rateUnit, rateAmount, subtotalAmount, platformFeeAmount, depositAmount, totalAmount,
    currency, rentalPaymentStatus, depositPaymentStatus,
  } = props

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Booking reference', value: bookingReference ?? '—' },
    { label: 'Listing', value: listingTitle },
    { label: 'Merchant', value: merchantDisplayName },
    { label: 'Rental dates', value: `${fmtDate(startAt)} – ${fmtDate(endAt)}` },
    { label: 'Duration', value: durationUnits ? `${durationUnits} ${rateUnit ?? 'day'}${durationUnits === 1 ? '' : 's'}` : '—' },
    { label: 'Rate', value: rateAmount !== null ? `${money(rateAmount, currency)} / ${rateUnit ?? 'day'}` : '—' },
  ]

  return (
    <div className="bg-white dark:bg-[#1A1010] rounded-xl border border-[#F2EDE8] dark:border-[#2A1A1A] p-5">
      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">Booking &amp; payment summary</p>

      <dl className="space-y-2 mb-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 text-sm">
            <dt className="text-[#6B5B55] dark:text-[#9B8B85]">{row.label}</dt>
            <dd className="text-[#1A0A0A] dark:text-[#F5F0ED] font-medium text-right">{row.value}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Rental subtotal</span>
          <span className="text-[#1A0A0A] dark:text-[#F5F0ED] font-medium">{money(subtotalAmount, currency)}</span>
        </div>
        {platformFeeAmount !== null && platformFeeAmount > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-[#6B5B55] dark:text-[#9B8B85]">Platform fee</span>
            <span className="text-[#1A0A0A] dark:text-[#F5F0ED] font-medium">{money(platformFeeAmount, currency)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#6B5B55] dark:text-[#9B8B85]">Deposit (refundable)</span>
          <span className="text-[#1A0A0A] dark:text-[#F5F0ED] font-medium">{depositAmount && depositAmount > 0 ? money(depositAmount, currency) : 'None'}</span>
        </div>
        <div className="flex items-center justify-between text-base pt-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A]">
          <span className="font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">Total financial obligation</span>
          <span className="font-bold text-[#8B1A1A]">{money(totalAmount, currency)}</span>
        </div>
      </div>

      <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] mt-4 pt-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
          Rental payment <PaymentStatusBadge status={rentalPaymentStatus} />
        </div>
        {depositAmount && depositAmount > 0 && (
          <div className="flex items-center gap-2 text-xs text-[#6B5B55] dark:text-[#9B8B85]">
            Deposit <PaymentStatusBadge status={depositPaymentStatus} />
          </div>
        )}
      </div>
    </div>
  )
}
