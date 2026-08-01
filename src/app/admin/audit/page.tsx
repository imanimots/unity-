'use client'

import { useState, useEffect } from 'react'
import { Download } from 'lucide-react'
import { AdminPageHeader, StatCard, secondaryButtonClass, formatDateTime } from '@/components/admin/ui'

interface AdminAuditEntry {
  id: string
  actorId: string | null
  actionType: string
  entityType: string
  entityId: string
  safeReason: string | null
  createdAt: string
  result: string
}

export default function AdminAuditPage() {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/audit')
      .then(async (res) => {
        if (!res.ok) {
          const b = await res.json().catch(() => ({}))
          throw new Error(b.error ?? 'Could not load the audit log')
        }
        return res.json()
      })
      .then((body) => setEntries(body.entries ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the audit log'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Accountability" title="Admin Audit Log" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Entries shown" value={entries.length} />
        <StatCard label="Listing actions" value={entries.filter((e) => e.entityType === 'listing').length} />
        <StatCard label="User / KYC actions" value={entries.filter((e) => e.entityType !== 'listing').length} />
      </div>

      <div className="flex justify-end">
        <a href="/api/admin/audit?format=csv" className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Actor', 'Action', 'Entity', 'Result', 'Reason', 'When'].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No admin actions recorded yet.</td></tr>
              ) : (
                entries.map((e) => (
                  <tr key={`${e.entityType}-${e.id}`} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{e.actorId ? e.actorId.slice(0, 8) : 'system'}</td>
                    <td className="px-4 py-3 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] capitalize whitespace-nowrap">{e.actionType.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{e.entityType} {e.entityId.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{e.result}</td>
                    <td className="px-4 py-3 text-xs text-[#6B5B55] dark:text-[#9B8B85] max-w-xs">{e.safeReason ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(e.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
