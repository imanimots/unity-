import { Clock3 } from 'lucide-react'

/**
 * Static "pay by" note for list views -- the live countdown lives only on
 * the checkout page itself. The caller (a Server Component with access to
 * getTranslations/getLocale) pre-renders the full localized label --
 * this stays a plain presentational component either way.
 */
export function PaymentDeadlineNote({ label }: { label: string }) {
  return (
    <p className="text-xs flex items-center gap-1.5 mt-1 text-[#9B8B85]">
      <Clock3 size={11} /> {label}
    </p>
  )
}
