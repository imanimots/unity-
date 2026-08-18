import { DISPUTE_STATUS_LABELS } from '@/lib/disputes/status-labels'
import type { DisputeStatus } from '@/types'

/**
 * Rendered both inside the [locale] dashboard tree (via DisputeDetailView)
 * AND inside admin/disputes/[id]/page.tsx, which has no NextIntlClientProvider
 * at all (admin stays English-only/unprefixed, see AGENTS.md). Calling
 * useTranslations() unconditionally here would throw outside [locale] --
 * so this takes a server-resolved `label` override instead, exactly like
 * ListingCard's verifiedLabel pattern. Admin call sites simply don't pass
 * it and keep the English default.
 */
export function DisputeStatusBadge({ status, label }: { status: DisputeStatus; label?: string }) {
  const { label: defaultLabel, classes } = DISPUTE_STATUS_LABELS[status]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{label ?? defaultLabel}</span>
}
