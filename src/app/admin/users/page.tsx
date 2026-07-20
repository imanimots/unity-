'use client'

import { useState, useMemo } from 'react'
import { Search, UserCheck, UserX, RotateCcw, Shield } from 'lucide-react'
import { ADMIN_MOCK_USERS, type AdminUser } from '@/lib/mock/admin-data'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

function AvatarCircle({ name }: { name: string }) {
  const initials = name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="w-8 h-8 rounded-full bg-[#F2EDE8] dark:bg-[#2A1A1A] flex items-center justify-center text-[#1A0A0A] dark:text-[#F5F0ED] text-xs font-bold shrink-0">
      {initials}
    </div>
  )
}

function RoleBadge({ role }: { role: AdminUser['role'] }) {
  const styles: Record<AdminUser['role'], string> = {
    renter:   'bg-blue-100 text-blue-700',
    merchant: 'bg-orange-100 text-orange-700',
    admin:    'bg-[#8B1A1A] text-white',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${styles[role]}`}>
      {role}
    </span>
  )
}

function KycBadge({ status }: { status: AdminUser['kyc_status'] }) {
  const styles: Record<AdminUser['kyc_status'], string> = {
    approved:   'bg-green-100 text-green-700',
    pending:    'bg-amber-100 text-amber-700',
    rejected:   'bg-red-100 text-red-700',
    unverified: 'bg-[#F2EDE8] text-[#6B5B55]',
  }
  const labels: Record<AdminUser['kyc_status'], string> = {
    approved:   'Approved',
    pending:    'Pending',
    rejected:   'Rejected',
    unverified: 'Unverified',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  )
}

function StatusBadge({ status }: { status: AdminUser['status'] }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${
      status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
    }`}>
      {status}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>(ADMIN_MOCK_USERS)
  const [search, setSearch]         = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [kycFilter, setKycFilter]   = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [feedback, setFeedback] = useState<Record<string, string>>({})

  // ── Mutations ──
  const verifyKyc = (id: string) =>
    setUsers(u => u.map(x => x.id === id ? { ...x, kyc_status: 'approved' } : x))

  const toggleSuspend = (id: string) =>
    setUsers(u => u.map(x => x.id === id ? { ...x, status: x.status === 'active' ? 'suspended' : 'active' } : x))

  const resetScore = (id: string) =>
    setUsers(u => u.map(x => x.id === id ? { ...x, unity_score: 0 } : x))

  // ── Feedback flash ──
  const flash = (id: string, msg: string) => {
    setFeedback(f => ({ ...f, [id]: msg }))
    setTimeout(() => setFeedback(f => { const n = { ...f }; delete n[id]; return n }), 1800)
  }

  // ── Filtered list ──
  const filtered = useMemo(() => {
    return users.filter(u => {
      const q = search.toLowerCase()
      if (q && !u.full_name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false
      if (roleFilter !== 'all' && u.role !== roleFilter) return false
      if (kycFilter  !== 'all' && u.kyc_status !== kycFilter)  return false
      if (statusFilter !== 'all' && u.status !== statusFilter)  return false
      return true
    })
  }, [users, search, roleFilter, kycFilter, statusFilter])

  return (
    <div className="p-6 lg:p-8 space-y-6">

      {/* ── Page Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            User Management
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            Users
          </h1>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A]">
          <Shield size={12} className="text-[#8B1A1A]" />
          <span className="text-[11px] font-medium text-[#6B5B55] dark:text-[#9B8B85] uppercase tracking-[0.1em]">
            {users.length} total
          </span>
        </div>
      </div>

      {/* ── Filter Bar ── */}
      <div className="flex flex-wrap gap-3">
        {/* Search */}
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9B8B85]" />
          <input
            type="text"
            placeholder="Search name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] placeholder:text-[#9B8B85] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A] w-56"
          />
        </div>

        {/* Role */}
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
        >
          <option value="all">All Roles</option>
          <option value="renter">Renter</option>
          <option value="merchant">Merchant</option>
          <option value="admin">Admin</option>
        </select>

        {/* KYC */}
        <select
          value={kycFilter}
          onChange={e => setKycFilter(e.target.value)}
          className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
        >
          <option value="all">All KYC</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="unverified">Unverified</option>
          <option value="rejected">Rejected</option>
        </select>

        {/* Status */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg text-sm px-3 py-2 text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:ring-1 focus:ring-[#8B1A1A]"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {/* ── Table ── */}
      <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {['#', 'Name', 'Email', 'Role', 'KYC', 'Score', 'Status', 'Joined', 'Actions'].map(h => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-[11px] font-medium uppercase tracking-[0.1em] text-[#9B8B85] border-b border-[#F2EDE8] dark:border-[#2A1A1A] whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center text-sm text-[#9B8B85]">
                    No users match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((user, idx) => (
                  <tr
                    key={user.id}
                    className="border-b border-[#F2EDE8] dark:border-[#2A1A1A] hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors last:border-0"
                  >
                    {/* # */}
                    <td className="px-4 py-3 text-xs text-[#9B8B85] font-mono">{idx + 1}</td>

                    {/* Name */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5 min-w-[140px]">
                        <AvatarCircle name={user.full_name} />
                        <span className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-nowrap">
                          {user.full_name}
                        </span>
                      </div>
                    </td>

                    {/* Email */}
                    <td className="px-4 py-3">
                      <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85] max-w-[180px] block truncate">
                        {user.email}
                      </span>
                    </td>

                    {/* Role */}
                    <td className="px-4 py-3">
                      <RoleBadge role={user.role} />
                    </td>

                    {/* KYC */}
                    <td className="px-4 py-3">
                      <KycBadge status={user.kyc_status} />
                    </td>

                    {/* Score */}
                    <td className="px-4 py-3">
                      <span className={`text-sm font-medium tabular-nums ${
                        user.unity_score > 0 ? 'text-[#1A0A0A] dark:text-[#F5F0ED]' : 'text-[#9B8B85]'
                      }`}>
                        {user.unity_score > 0 ? user.unity_score.toFixed(1) : '—'}
                      </span>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge status={user.status} />
                    </td>

                    {/* Joined */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">
                        {formatDate(user.created_at)}
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      {feedback[user.id] ? (
                        <span className="text-xs font-medium text-green-600 whitespace-nowrap">
                          {feedback[user.id]}
                        </span>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap min-w-[200px]">
                          {/* Verify KYC */}
                          {user.kyc_status !== 'approved' && (
                            <button
                              onClick={() => {
                                verifyKyc(user.id)
                                flash(user.id, '✓ KYC Approved')
                              }}
                              className="inline-flex items-center gap-1 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <UserCheck size={11} />
                              Verify KYC
                            </button>
                          )}

                          {/* Suspend / Reactivate */}
                          {user.status === 'active' ? (
                            <button
                              onClick={() => {
                                toggleSuspend(user.id)
                                flash(user.id, '✓ Suspended')
                              }}
                              className="inline-flex items-center gap-1 bg-red-600 text-white hover:bg-red-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <UserX size={11} />
                              Suspend
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                toggleSuspend(user.id)
                                flash(user.id, '✓ Reactivated')
                              }}
                              className="inline-flex items-center gap-1 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                            >
                              <UserCheck size={11} />
                              Reactivate
                            </button>
                          )}

                          {/* Reset Score */}
                          <button
                            onClick={() => {
                              resetScore(user.id)
                              flash(user.id, '✓ Score Reset')
                            }}
                            className="inline-flex items-center gap-1 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <RotateCcw size={11} />
                            Reset Score
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Footer count */}
        <div className="px-4 py-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#0F0A0A]">
          <p className="text-xs text-[#9B8B85]">
            Showing <span className="font-medium text-[#6B5B55]">{filtered.length}</span> of{' '}
            <span className="font-medium text-[#6B5B55]">{users.length}</span> users
          </p>
        </div>
      </div>
    </div>
  )
}
