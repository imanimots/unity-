'use client'
import { useState } from 'react'
import { Search, ChevronDown, ChevronUp, AlertTriangle, CheckCircle, ArrowUpRight, MessageSquare } from 'lucide-react'
import { ADMIN_MOCK_DISPUTES, type AdminDispute } from '@/lib/mock/admin-data'

type TabStatus = 'open' | 'pending_evidence' | 'escalated' | 'resolved'

const STATUS_TABS: { key: TabStatus; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'pending_evidence', label: 'Pending Evidence' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'resolved', label: 'Resolved' },
]

const STATUS_BADGE: Record<AdminDispute['status'], string> = {
  open:             'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  resolved:         'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  escalated:        'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  pending_evidence: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
}

const STATUS_LABEL: Record<AdminDispute['status'], string> = {
  open:             'Open',
  resolved:         'Resolved',
  escalated:        'Escalated',
  pending_evidence: 'Pending Evidence',
}

const PRIORITY_BADGE: Record<AdminDispute['priority'], string> = {
  high:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  low:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
}

export default function DisputesPage() {
  const [disputes, setDisputes] = useState<AdminDispute[]>(ADMIN_MOCK_DISPUTES)
  const [selectedTab, setSelectedTab] = useState<TabStatus>('open')
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const resolve = (id: string, favour: 'renter' | 'merchant') => {
    setDisputes(d => d.map(x => x.id === id ? {
      ...x,
      status: 'resolved',
      resolved_in_favour_of: favour,
      resolution: notes[id] || 'Resolved by admin.',
      resolved_at: new Date().toISOString().split('T')[0],
    } : x))
  }

  const requestEvidence = (id: string) =>
    setDisputes(d => d.map(x => x.id === id ? { ...x, status: 'pending_evidence' } : x))

  const escalate = (id: string) =>
    setDisputes(d => d.map(x => x.id === id ? { ...x, status: 'escalated' } : x))

  const openCount = disputes.filter(d => d.status === 'open').length

  const filtered = disputes.filter(d => {
    const matchTab = d.status === selectedTab
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      d.listing_title.toLowerCase().includes(q) ||
      d.raised_by.toLowerCase().includes(q) ||
      d.against.toLowerCase().includes(q) ||
      d.reason.toLowerCase().includes(q)
    return matchTab && matchSearch
  })

  const toggleExpand = (id: string) =>
    setExpandedId(prev => prev === id ? null : id)

  const isActionable = (status: AdminDispute['status']) =>
    status === 'open' || status === 'pending_evidence' || status === 'escalated'

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* PAGE HEADER */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            Dispute Management
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-white">
            Disputes
          </h1>
        </div>
        {openCount > 0 && (
          <span className="mt-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            {openCount} open
          </span>
        )}
      </div>

      {/* TABS */}
      <div className="flex gap-1 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setSelectedTab(tab.key)}
            className={`px-4 py-2.5 text-xs font-medium uppercase tracking-[0.08em] transition-colors ${
              selectedTab === tab.key
                ? 'border-b-2 border-[#8B1A1A] text-[#8B1A1A]'
                : 'text-[#6B5B55] hover:text-[#1A0A0A] dark:hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* SEARCH BAR */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9B8B85]" />
        <input
          type="text"
          placeholder="Search disputes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-white dark:bg-[#1A1010] text-[#1A0A0A] dark:text-white placeholder:text-[#9B8B85] focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
        />
      </div>

      {/* DISPUTE CARDS */}
      <div className="space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-12 text-center">
            <p className="text-sm text-[#9B8B85]">No disputes in this category.</p>
          </div>
        ) : (
          filtered.map(dispute => {
            const isExpanded = expandedId === dispute.id

            return (
              <div
                key={dispute.id}
                className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden"
              >
                {/* CARD HEADER */}
                <button
                  onClick={() => toggleExpand(dispute.id)}
                  className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-[#FAF8F5] dark:hover:bg-[#1A1010] transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium uppercase shrink-0 ${PRIORITY_BADGE[dispute.priority]}`}>
                      {dispute.priority}
                    </span>
                    <span className="text-[11px] text-[#9B8B85] shrink-0">{dispute.id}</span>
                    <span className="text-sm font-semibold text-[#1A0A0A] dark:text-white truncate">
                      {dispute.listing_title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[dispute.status]}`}>
                      {STATUS_LABEL[dispute.status]}
                    </span>
                    <span className="text-base font-extrabold text-[#8B1A1A]">
                      R{dispute.amount_at_stake.toLocaleString()}
                    </span>
                    {isExpanded
                      ? <ChevronUp className="w-4 h-4 text-[#9B8B85]" />
                      : <ChevronDown className="w-4 h-4 text-[#9B8B85]" />
                    }
                  </div>
                </button>

                {/* CARD BODY */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4 space-y-4">
                    {/* Parties + reason */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <div>
                        <span className="text-[#9B8B85]">Raised by: </span>
                        <span className="text-[#1A0A0A] dark:text-white font-medium">{dispute.raised_by}</span>
                        <span className="text-[#9B8B85]"> ({dispute.raised_by_role})</span>
                      </div>
                      <div>
                        <span className="text-[#9B8B85]">Against: </span>
                        <span className="text-[#1A0A0A] dark:text-white font-medium">{dispute.against}</span>
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Reason</p>
                      <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] italic">&ldquo;{dispute.reason}&rdquo;</p>
                    </div>

                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">Description</p>
                      <p className="text-sm text-[#1A0A0A] dark:text-white leading-relaxed">{dispute.description}</p>
                    </div>

                    {dispute.evidence.length > 0 && (
                      <div>
                        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-2">Evidence Files</p>
                        <div className="flex flex-wrap gap-2">
                          {dispute.evidence.map(file => (
                            <span
                              key={file}
                              className="px-2.5 py-1 rounded-full text-xs bg-gray-100 dark:bg-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85]"
                            >
                              {file}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* RESOLUTION SECTION — actionable */}
                    {isActionable(dispute.status) && (
                      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4 space-y-3">
                        <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Admin Resolution</p>
                        <textarea
                          rows={3}
                          placeholder="Resolution notes…"
                          value={notes[dispute.id] || ''}
                          onChange={e => setNotes(n => ({ ...n, [dispute.id]: e.target.value }))}
                          className="w-full text-sm rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] bg-[#FAF8F5] dark:bg-[#120808] text-[#1A0A0A] dark:text-white placeholder:text-[#9B8B85] p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => resolve(dispute.id, 'renter')}
                            className="inline-flex items-center gap-1.5 bg-green-600 text-white hover:bg-green-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <CheckCircle className="w-3 h-3" />
                            Resolve → Renter
                          </button>
                          <button
                            onClick={() => resolve(dispute.id, 'merchant')}
                            className="inline-flex items-center gap-1.5 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <CheckCircle className="w-3 h-3" />
                            Resolve → Merchant
                          </button>
                          <button
                            onClick={() => requestEvidence(dispute.id)}
                            className="inline-flex items-center gap-1.5 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] dark:border-[#2A1A1A] dark:hover:bg-[#2A1A1A] text-xs px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <MessageSquare className="w-3 h-3" />
                            Request Evidence
                          </button>
                          <button
                            onClick={() => escalate(dispute.id)}
                            className="inline-flex items-center gap-1.5 bg-amber-500 text-white hover:bg-amber-600 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors"
                          >
                            <ArrowUpRight className="w-3 h-3" />
                            Escalate
                          </button>
                        </div>
                      </div>
                    )}

                    {/* RESOLVED STATE */}
                    {dispute.status === 'resolved' && (
                      <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-green-600" />
                          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Resolution</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-[#6B5B55] dark:text-[#9B8B85]">Resolved in favour of:</span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            dispute.resolved_in_favour_of === 'renter'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-[#8B1A1A]/10 text-[#8B1A1A] dark:bg-[#8B1A1A]/20'
                          }`}>
                            {dispute.resolved_in_favour_of}
                          </span>
                        </div>
                        {dispute.resolution && (
                          <p className="text-sm text-[#1A0A0A] dark:text-white">{dispute.resolution}</p>
                        )}
                        {dispute.resolved_at && (
                          <p className="text-xs text-[#9B8B85]">Resolved on {dispute.resolved_at}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
