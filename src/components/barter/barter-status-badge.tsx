import { BARTER_STATUS_LABELS } from '@/lib/barter/status-labels'
import type { BarterStatus } from '@/types'

/**
 * Rendered both inside [locale] (via BarterAgreementView) AND directly by
 * admin/barter/[id]/page.tsx, which has no NextIntlClientProvider at all
 * (admin stays English-only/unprefixed). Takes a server-resolved `label`
 * override instead of calling useTranslations() directly -- admin call
 * sites don't pass it and keep the English default.
 */
export function BarterStatusBadge({ status, label }: { status: BarterStatus; label?: string }) {
  const { label: defaultLabel, classes } = BARTER_STATUS_LABELS[status]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{label ?? defaultLabel}</span>
}
