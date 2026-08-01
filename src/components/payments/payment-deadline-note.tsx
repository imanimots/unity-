import { Clock3 } from 'lucide-react'

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/**
 * Static "pay by" note for list views -- the live countdown lives only on
 * the checkout page itself. Deliberately does not call Date.now() during
 * render (a server component render must stay pure) -- the caller already
 * knows whether this booking is overdue via its own readiness derivation
 * (expired_unpaid), so that distinction belongs there, not here.
 */
export function PaymentDeadlineNote({ paymentDueAt }: { paymentDueAt: string | null }) {
  if (!paymentDueAt) return null
  return (
    <p className="text-xs flex items-center gap-1.5 mt-1 text-[#9B8B85]">
      <Clock3 size={11} /> Pay by {fmtDateTime(paymentDueAt)}
    </p>
  )
}
