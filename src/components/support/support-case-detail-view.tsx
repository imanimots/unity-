import Link from 'next/link'
import { Pill, formatDateTime } from '@/components/admin/ui'
import { SUPPORT_CASE_CATEGORY_LABELS } from '@/lib/support/types'
import { SUPPORT_LINKED_ENTITY_LABELS, buildSupportLinkedEntityHref } from '@/lib/support/deep-links'
import type { AdminSupportCaseDetail } from '@/lib/admin/support-service'
import type { SupportLinkedEntityType } from '@/lib/support/types'

const STATUS_STYLES: Record<string, string> = {
  open: 'bg-amber-100 text-amber-700',
  in_progress: 'bg-blue-100 text-blue-700',
  waiting_on_user: 'bg-[#F2EDE8] text-[#6B5B55]',
  escalated: 'bg-red-100 text-red-700',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-[#F2EDE8] text-[#9B8B85]',
}

const PRIORITY_STYLES: Record<string, string> = {
  low: 'bg-[#F2EDE8] text-[#6B5B55]',
  normal: 'bg-blue-50 text-blue-700',
  high: 'bg-amber-100 text-amber-700',
  urgent: 'bg-red-100 text-red-700',
}

/** Renders the Support Centre case workspace sections (Part 14). Pure display -- all mutations live in SupportCaseAdminActions. */
export function SupportCaseDetailView({ detail }: { detail: AdminSupportCaseDetail }) {
  const c = detail.case as {
    id: string
    case_number: string
    title: string
    description: string
    category: string
    status: string
    priority: string
    customer_id: string | null
    merchant_id: string | null
    linked_entity_type: SupportLinkedEntityType | null
    linked_entity_id: string | null
    resolution_summary: string | null
    escalation_reason: string | null
    created_at: string
    updated_at: string
    resolved_at: string | null
    closed_at: string | null
  }

  const linkedHref = c.linked_entity_type && c.linked_entity_id ? buildSupportLinkedEntityHref(c.linked_entity_type, c.linked_entity_id) : null

  return (
    <>
      {/* ── Case header ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{c.title}</h2>
          <div className="flex gap-2">
            <Pill value={c.priority} styles={PRIORITY_STYLES} />
            <Pill value={c.status} styles={STATUS_STYLES} />
          </div>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div><dt className="text-[#9B8B85]">Category</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{SUPPORT_CASE_CATEGORY_LABELS[c.category as keyof typeof SUPPORT_CASE_CATEGORY_LABELS] ?? c.category}</dd></div>
          <div><dt className="text-[#9B8B85]">Created</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.created_at)}</dd></div>
          <div><dt className="text-[#9B8B85]">Updated</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.updated_at)}</dd></div>
          {c.resolved_at ? <div><dt className="text-[#9B8B85]">Resolved</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.resolved_at)}</dd></div> : null}
          {c.closed_at ? <div><dt className="text-[#9B8B85]">Closed</dt><dd className="text-[#1A0A0A] dark:text-[#F5F0ED]">{formatDateTime(c.closed_at)}</dd></div> : null}
        </dl>
      </section>

      {/* ── Customer / Merchant ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Customer / Merchant</h2>
        <div className="flex flex-wrap gap-4 text-sm">
          {c.customer_id ? (
            <div>
              <dt className="text-[#9B8B85]">Customer</dt>
              <dd><Link href={`/admin/users/${c.customer_id}`} className="text-[#8B1A1A] underline">{detail.customerName ?? c.customer_id.slice(0, 8)}</Link></dd>
            </div>
          ) : null}
          {c.merchant_id ? (
            <div>
              <dt className="text-[#9B8B85]">Merchant</dt>
              <dd><Link href={`/admin/merchants/${c.merchant_id}`} className="text-[#8B1A1A] underline">{detail.merchantName ?? c.merchant_id.slice(0, 8)}</Link></dd>
            </div>
          ) : null}
          {!c.customer_id && !c.merchant_id ? <p className="text-[#9B8B85]">No customer or merchant linked.</p> : null}
        </div>
      </section>

      {/* ── Related entity ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Related entity</h2>
        {c.linked_entity_type && c.linked_entity_id ? (
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">
            {SUPPORT_LINKED_ENTITY_LABELS[c.linked_entity_type]} —{' '}
            {linkedHref ? (
              <Link href={linkedHref} className="text-[#8B1A1A] underline font-mono text-xs">{c.linked_entity_id}</Link>
            ) : (
              <span className="font-mono text-xs text-[#9B8B85]">{c.linked_entity_id} (no admin detail page yet)</span>
            )}
          </p>
        ) : (
          <p className="text-sm text-[#9B8B85]">No related entity linked.</p>
        )}
      </section>

      {/* ── Description ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Description</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{c.description || 'No description provided.'}</p>
      </section>

      {/* ── Resolution ── */}
      {(c.status === 'resolved' || c.status === 'closed' || c.resolution_summary || c.escalation_reason) ? (
        <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Resolution</h2>
          {c.escalation_reason ? <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]"><span className="text-[#9B8B85]">Escalation reason:</span> {c.escalation_reason}</p> : null}
          {c.resolution_summary ? <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]"><span className="text-[#9B8B85]">Resolution summary:</span> {c.resolution_summary}</p> : null}
          {!c.resolution_summary && !c.escalation_reason ? <p className="text-sm text-[#9B8B85]">Not yet resolved.</p> : null}
        </section>
      ) : null}

      {/* ── Internal notes ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Internal notes</h2>
        {detail.notes.length === 0 ? (
          <p className="text-sm text-[#9B8B85]">No internal notes yet.</p>
        ) : (
          detail.notes.map((n) => (
            <div key={n.id} className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2">
              {n.note}
              <div className="text-[10px] text-[#9B8B85] mt-1">{n.adminName ?? 'Admin'} · {formatDateTime(n.createdAt)}</div>
            </div>
          ))
        )}
      </section>

      {/* ── Case history ── */}
      <section className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-[0.1em] text-[#1A0A0A] dark:text-[#F5F0ED]">Case history</h2>
        {detail.history.length === 0 ? (
          <p className="text-sm text-[#9B8B85]">No history beyond creation.</p>
        ) : (
          <ol className="space-y-2 border-l border-[#F2EDE8] dark:border-[#2A1A1A] pl-4">
            {detail.history.map((h) => (
              <li key={h.id} className="text-sm">
                <span className="font-medium text-[#1A0A0A] dark:text-[#F5F0ED] capitalize">{h.action.replace(/_/g, ' ')}</span>
                {' '}
                <span className="text-[#9B8B85]">by {h.actorAdminName ?? 'system'} · {formatDateTime(h.createdAt)}</span>
                {h.reason ? <div className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">Reason: {h.reason}</div> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
