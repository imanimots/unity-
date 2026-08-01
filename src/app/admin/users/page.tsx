'use client'

import { useState, useEffect, useCallback } from 'react'
import { Search, X, Download } from 'lucide-react'
import { Pill, ACCOUNT_STATUS_STYLES, StatCard, AdminPageHeader, inputClass, primaryButtonClass, secondaryButtonClass, newIdempotencyKey, formatDate, formatDateTime } from '@/components/admin/ui'

interface AdminUserRow {
  id: string
  fullName: string | null
  displayName: string | null
  role: string
  kycStatus: string
  accountStatus: string
  unityScore: number
  createdAt: string
}

interface AdminUserDetail {
  profile: AdminUserRow & { phone: string | null; statusReason: string | null; statusChangedAt: string | null }
  verification: { status: string; reviewedAt: string | null } | null
  listingsCount: number
  bookingsAsRenterCount: number
  bookingsAsMerchantCount: number
  disputeCount: null
  accountHistory: Array<{ id: string; actionType: string; previousStatus: string; newStatus: string; userReason: string | null; internalNote: string | null; adminId: string; createdAt: string }>
  notes: Array<{ id: string; note: string; adminId: string; createdAt: string }>
}

const KYC_STYLES: Record<string, string> = {
  none: 'bg-[#F2EDE8] text-[#6B5B55]',
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')
  const [kycFilter, setKycFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reasonInput, setReasonInput] = useState('')
  const [noteInput, setNoteInput] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (roleFilter !== 'all') params.set('role', roleFilter)
      if (kycFilter !== 'all') params.set('kyc_status', kycFilter)
      if (statusFilter !== 'all') params.set('account_status', statusFilter)

      const res = await fetch(`/api/admin/users?${params.toString()}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load users')
      }
      const body = await res.json()
      setUsers(body.users ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load users')
    } finally {
      setLoading(false)
    }
  }, [search, roleFilter, kycFilter, statusFilter])

  useEffect(() => {
    const t = setTimeout(() => {
      load()
    }, 250)
    return () => clearTimeout(t)
  }, [load])

  const loadDetail = useCallback(async (userId: string) => {
    setDetailLoading(true)
    setActionError(null)
    setReasonInput('')
    setNoteInput('')
    try {
      const res = await fetch(`/api/admin/users/${userId}`)
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not load user')
      }
      setDetail(await res.json())
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not load user')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedId) loadDetail(selectedId)
  }, [selectedId, loadDetail])

  async function performAction(action: 'restrict' | 'suspend' | 'restore') {
    if (!selectedId) return
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_reason: reasonInput || null, idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Action failed')
      }
      await loadDetail(selectedId)
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionPending(false)
    }
  }

  async function submitNote() {
    if (!selectedId || !noteInput.trim()) return
    setActionPending(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/admin/users/${selectedId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: noteInput.trim(), idempotency_key: newIdempotencyKey() }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.error ?? 'Could not add note')
      }
      setNoteInput('')
      await loadDetail(selectedId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not add note')
    } finally {
      setActionPending(false)
    }
  }

  const activeCount = users.filter((u) => u.accountStatus === 'active').length
  const restrictedCount = users.filter((u) => u.accountStatus === 'restricted').length
  const suspendedCount = users.filter((u) => u.accountStatus === 'suspended').length

  return (
    <div className="p-6 lg:p-8 space-y-6">
      <AdminPageHeader eyebrow="User Management" title="Users" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="Total" value={users.length} />
        <StatCard label="Active" value={activeCount} />
        <StatCard label="Restricted" value={restrictedCount} />
        <StatCard label="Suspended" value={suspendedCount} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input type="text" placeholder="Search name…" value={search} onChange={(e) => setSearch(e.target.value)} className={`pl-8 w-60 ${inputClass}`} />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className={inputClass}>
          <option value="all">All roles</option>
          <option value="renter">Renter</option>
          <option value="merchant">Merchant</option>
          <option value="both">Both</option>
          <option value="admin">Admin</option>
        </select>
        <select value={kycFilter} onChange={(e) => setKycFilter(e.target.value)} className={inputClass}>
          <option value="all">All KYC status</option>
          <option value="none">None</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputClass}>
          <option value="all">All account status</option>
          <option value="active">Active</option>
          <option value="restricted">Restricted</option>
          <option value="suspended">Suspended</option>
        </select>
        <a
          href={`/api/admin/users?format=csv${roleFilter !== 'all' ? `&role=${roleFilter}` : ''}${kycFilter !== 'all' ? `&kyc_status=${kycFilter}` : ''}${statusFilter !== 'all' ? `&account_status=${statusFilter}` : ''}`}
          className={secondaryButtonClass}
        >
          <Download size={11} /> CSV
        </a>
      </div>

      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['Name', 'Role', 'KYC', 'Unity score', 'Account status', 'Joined', ''].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-red-600">{error}</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-16 text-center text-sm text-[#9B8B85]">No users match your filters.</td></tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0">
                    <td className="px-4 py-3 text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">{u.fullName ?? u.displayName ?? u.id.slice(0, 8)}</td>
                    <td className="px-4 py-3 text-sm capitalize text-[#6B5B55] dark:text-[#9B8B85]">{u.role}</td>
                    <td className="px-4 py-3"><Pill value={u.kycStatus} styles={KYC_STYLES} /></td>
                    <td className="px-4 py-3 text-sm tabular-nums text-[#6B5B55] dark:text-[#9B8B85]">{u.unityScore.toFixed(1)}</td>
                    <td className="px-4 py-3"><Pill value={u.accountStatus} styles={ACCOUNT_STATUS_STYLES} /></td>
                    <td className="px-4 py-3 text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-nowrap">{formatDate(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <button onClick={() => setSelectedId(u.id)} className={secondaryButtonClass}>View</button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedId ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/40" onClick={() => setSelectedId(null)} />
          <div className="relative w-full max-w-md bg-white dark:bg-[#0F0A0A] border-l border-[#F2EDE8] dark:border-[#2A1A1A] h-full overflow-y-auto p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">User detail</h2>
              <button onClick={() => setSelectedId(null)} className="text-[#9B8B85] hover:text-[#1A0A0A]"><X size={18} /></button>
            </div>

            {detailLoading || !detail ? (
              <p className="text-sm text-[#9B8B85]">Loading…</p>
            ) : (
              <>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED]">{detail.profile.fullName ?? detail.profile.displayName}</p>
                  <p className="text-xs text-[#9B8B85]">{detail.profile.phone ?? 'No phone on file'}</p>
                  <div className="flex gap-2 pt-1">
                    <Pill value={detail.profile.role} styles={{}} />
                    <Pill value={detail.profile.kycStatus} styles={KYC_STYLES} />
                    <Pill value={detail.profile.accountStatus} styles={ACCOUNT_STATUS_STYLES} />
                  </div>
                  {detail.profile.statusReason ? (
                    <p className="text-xs text-[#6B5B55] dark:text-[#9B8B85] pt-1">Reason: {detail.profile.statusReason}</p>
                  ) : null}
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg py-2">
                    <p className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{detail.listingsCount}</p>
                    <p className="text-[10px] uppercase text-[#9B8B85]">Listings</p>
                  </div>
                  <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg py-2">
                    <p className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{detail.bookingsAsRenterCount}</p>
                    <p className="text-[10px] uppercase text-[#9B8B85]">As renter</p>
                  </div>
                  <div className="bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg py-2">
                    <p className="text-lg font-bold text-[#1A0A0A] dark:text-[#F5F0ED] tabular-nums">{detail.bookingsAsMerchantCount}</p>
                    <p className="text-[10px] uppercase text-[#9B8B85]">As merchant</p>
                  </div>
                </div>
                <p className="text-[11px] text-[#9B8B85]">Dispute count: not yet available (no dispute domain exists).</p>

                {actionError ? <p className="text-xs text-red-600">{actionError}</p> : null}

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Account action</p>
                  <input
                    type="text"
                    placeholder="Reason (shown to the user, if applicable)"
                    value={reasonInput}
                    onChange={(e) => setReasonInput(e.target.value)}
                    className={`w-full ${inputClass}`}
                  />
                  <div className="flex gap-2 flex-wrap">
                    {detail.profile.accountStatus !== 'restricted' ? (
                      <button disabled={actionPending} onClick={() => performAction('restrict')} className={secondaryButtonClass}>Restrict</button>
                    ) : null}
                    {detail.profile.accountStatus !== 'suspended' ? (
                      <button disabled={actionPending} onClick={() => performAction('suspend')} className={primaryButtonClass}>Suspend</button>
                    ) : null}
                    {detail.profile.accountStatus !== 'active' ? (
                      <button disabled={actionPending} onClick={() => performAction('restore')} className={secondaryButtonClass}>Restore to active</button>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Account history</p>
                  {detail.accountHistory.length === 0 ? (
                    <p className="text-xs text-[#9B8B85]">No status changes recorded.</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.accountHistory.map((h) => (
                        <li key={h.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85]">
                          <span className="font-medium capitalize">{h.actionType}</span> ({h.previousStatus} → {h.newStatus}) — {formatDateTime(h.createdAt)}
                          {h.userReason ? <div>Reason: {h.userReason}</div> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
                  <p className="text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85]">Internal notes</p>
                  {detail.notes.map((n) => (
                    <div key={n.id} className="text-xs text-[#6B5B55] dark:text-[#9B8B85] bg-[#FAF8F5] dark:bg-[#1A1010] rounded-lg px-3 py-2">
                      {n.note}
                      <div className="text-[10px] text-[#9B8B85] mt-1">{formatDateTime(n.createdAt)}</div>
                    </div>
                  ))}
                  <textarea
                    placeholder="Add an internal note…"
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    className={`w-full ${inputClass}`}
                    rows={2}
                  />
                  <button disabled={actionPending || !noteInput.trim()} onClick={submitNote} className={secondaryButtonClass}>Add note</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
