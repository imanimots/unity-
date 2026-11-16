import { Info } from 'lucide-react'

/**
 * The one canonical test-mode disclosure (Step 7) -- placed only where
 * materially relevant (checkout, the payment policy page, booking
 * financial-status displays, admin financial views), never on every page
 * site-wide (a public marketing page plastered with test-mode warnings
 * reads as broken, per the brief). Exact wording is fixed, not
 * per-caller-customized, so it can never silently drift between surfaces.
 */
export function TestModeBanner({ className = '', text }: { className?: string; text?: string }) {
  return (
    <div className={`bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-start gap-2.5 ${className}`}>
      <Info size={16} className="text-blue-600 shrink-0 mt-0.5" />
      <p className="text-xs text-blue-800">
        {text ?? 'Unity is currently operating in test mode. No real payments, deposits or payouts are processed.'}
      </p>
    </div>
  )
}
