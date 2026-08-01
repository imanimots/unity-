'use client'

import { useState, useEffect, useCallback } from 'react'
import { Download } from 'lucide-react'
import { Pill, SEVERITY_STYLES, StatCard, AdminPageHeader, inputClass, secondaryButtonClass, formatDateTime } from '@/components/admin/ui'

interface AdminException {
  id: string
  type: string
  severity: string
  entityType: string
  entityId: string
  summary: string
  detectedAt: string
  suggestedAction: string
  resolved: boolean
}

export default function AdminExceptionsPage() {
  const [exceptions, setExceptions] = useState<AdminException[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [severityFilter, setSeverityFilter] = useState('all')
  const [showResolved, setShowResolved] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/exceptions')
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load exceptions')
      }
      const body = await res.json()
      setExceptions(body.exceptions ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load exceptions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  async function resolve(id: string) {
    setResolvingId(id)
    try {
      const res = await fetch(`/api/admin/exceptions/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not resolve')
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve')
    } finally {
      setResolvingId(null)
    }
  }

  const visible = exceptions.filter((e) => (showResolved || !e.resolved) && (severityFilter === 'all' || e.severity === severityFilter))
  const highCount = exceptions.filter((e) => e.severity === 'high' && !e.resolved).length
  const openCount = exceptions.filter((e) => !e.resolved).length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="Operational Exceptions" title="Exception Queue" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Open" value={openCount} />
        <StatCard label="High severity" value={highCount} />
        <StatCard label="Total (incl. resolved)" value={exceptions.length} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className={inputClass}>
          <option value="all">All severities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-[#6B5B55] dark:text-[#9B8B85]">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
        <a href="/api/admin/exceptions?format=csv" className={secondaryButtonClass}>
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Type', 'Severity', 'Summary', 'Detected', 'Suggested action', ''].map((h) => (
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
              ) : visible.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No open exceptions — everything looks healthy.</td></tr>
              ) : (
                visible.map((e) => (
                  <tr key={e.id} className={`border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0 ${e.resolved ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">{e.type.replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3"><Pill value={e.severity} styles={SEVERITY_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] max-w-md">{e.summary}</td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDateTime(e.detectedAt)}</td>
                    <td className="px-4 py-3 text-xs text-[#6B5B55] dark:text-[#9B8B85] max-w-xs">{e.suggestedAction}</td>
                    <td className="px-4 py-3">
                      {e.resolved ? (
                        <span className="text-xs text-green-700">Resolved</span>
                      ) : (
                        <button disabled={resolvingId === e.id} onClick={() => resolve(e.id)} className={secondaryButtonClass}>Resolve</button>
                      )}
                    </td>
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
