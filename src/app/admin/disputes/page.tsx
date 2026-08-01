import { AlertTriangle } from 'lucide-react'
import { AdminPageHeader } from '@/components/admin/ui'

/**
 * Disputes are explicitly out of scope for Step 9 (dispute adjudication,
 * damage assessment) — and no `disputes` table exists in the database at
 * all (confirmed by audit). This page previously showed fabricated
 * dispute counts and local-state-only "Resolve"/"Escalate" actions,
 * which the brief explicitly calls out to remove ("mock dispute counts
 * presented as real"). It is replaced with an honest unavailable state
 * rather than any fake operational data, per "REAL DATA ONLY" —
 * building the real dispute domain is future work, not this step.
 */
export default function AdminDisputesPage() {
  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Trust & Safety" title="Disputes" />
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl px-6 py-16 text-center space-y-3">
        <AlertTriangle className="mx-auto text-[#9B8B85]" size={28} />
        <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">Dispute handling is not built yet</p>
        <p className="text-xs text-[#9B8B85] max-w-md mx-auto">
          There is no dispute domain in the database yet, and dispute adjudication is explicitly out of scope for this
          phase. This page intentionally shows no data rather than placeholder figures.
        </p>
      </div>
    </div>
  )
}
