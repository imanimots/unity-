'use client'
import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, Edit2, Save, X, BookOpen, CheckCircle, Loader2 } from 'lucide-react'

type Entry = { id: string; title: string | null; category: string; content: string; created_at: string }

const CATEGORIES = ['platform', 'faq', 'policy', 'listing'] as const

const CATEGORY_COLORS: Record<string, string> = {
  platform: 'bg-blue-100 text-blue-700',
  faq: 'bg-green-100 text-green-700',
  policy: 'bg-amber-100 text-amber-700',
  listing: 'bg-orange-100 text-orange-700',
}

const CATEGORY_LABELS: Record<string, string> = {
  platform: 'Platform',
  faq: 'FAQ',
  policy: 'Policy',
  listing: 'Listing',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: '2-digit' })
}

/**
 * E48 Risk 3 -- real persistence via /api/admin/knowledge-base, backed by
 * the existing public.knowledge_base table (previously only ever written
 * to by /api/assistant/embed's seed step, never read back by any admin
 * UI). Create/edit now generate an embedding server-side on every
 * request, so there is no separate "re-embed" step to remember -- the
 * old "Re-Embed All" button is removed since it blindly re-inserted the
 * static seed list with no dedup, which would now create duplicate rows
 * in a genuinely persisted table.
 */
export default function KnowledgeBasePage() {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('all')

  // Add form state
  const [addTitle, setAddTitle] = useState('')
  const [addCategory, setAddCategory] = useState<string>('platform')
  const [addContent, setAddContent] = useState('')

  // Edit form state
  const [editTitle, setEditTitle] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editContent, setEditContent] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/admin/knowledge-base')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Could not load knowledge base entries')
      setEntries(body.entries ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load knowledge base entries')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const deleteEntry = async (id: string) => {
    if (!confirm('Delete this entry?')) return
    setActionError(null)
    setActionBusy(true)
    try {
      const res = await fetch(`/api/admin/knowledge-base/${id}`, { method: 'DELETE' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Could not delete entry')
      setEntries((e) => e.filter((x) => x.id !== id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete entry')
    } finally {
      setActionBusy(false)
    }
  }

  const startEdit = (entry: Entry) => {
    setActionError(null)
    setEditingId(entry.id)
    setEditTitle(entry.title ?? '')
    setEditCategory(entry.category)
    setEditContent(entry.content)
  }

  const saveEdit = async (id: string) => {
    setActionError(null)
    setActionBusy(true)
    try {
      const res = await fetch(`/api/admin/knowledge-base/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle || null, category: editCategory, content: editContent }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Could not save changes')
      setEntries((e) => e.map((x) => (x.id === id ? (body.entry as Entry) : x)))
      setEditingId(null)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setActionBusy(false)
    }
  }

  const addEntry = async () => {
    if (!addTitle.trim() || !addContent.trim()) return
    setActionError(null)
    setActionBusy(true)
    try {
      const res = await fetch('/api/admin/knowledge-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: addTitle, category: addCategory, content: addContent }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Could not create entry')
      setEntries((e) => [body.entry as Entry, ...e])
      setAddTitle('')
      setAddCategory('platform')
      setAddContent('')
      setShowAdd(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not create entry')
    } finally {
      setActionBusy(false)
    }
  }

  const filteredEntries = categoryFilter === 'all'
    ? entries
    : entries.filter(e => e.category === categoryFilter)

  const categories = Array.from(new Set(entries.map(e => e.category)))
  const totalEntries = entries.length
  const uniqueCategories = categories.length
  const mostRecent = entries.reduce<string | null>((latest, e) => (!latest || e.created_at > latest ? e.created_at : latest), null)

  return (
    <div className="p-6 lg:p-8">
      {/* Page Header */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            AI ASSISTANT
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A]">
            KNOWLEDGE BASE
          </h1>
        </div>
      </div>

      {actionError && <p className="text-sm text-red-600 mb-4">{actionError}</p>}

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Entries</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A]">{totalEntries}</p>
        </div>

        <div className="bg-white border border-[#F2EDE8] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Categories</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A]">{uniqueCategories}</p>
        </div>

        <div className="bg-white border border-[#F2EDE8] rounded-xl p-4 col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Most Recent Entry</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A]">{mostRecent ? formatDate(mostRecent) : '—'}</p>
        </div>
      </div>

      {/* Add New Entry Panel */}
      <div className="mb-6">
        {!showAdd ? (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs px-3 py-1.5 rounded-lg transition-colors font-medium uppercase tracking-[0.08em]"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Entry
          </button>
        ) : (
          <div className="bg-white border border-[#F2EDE8] rounded-xl p-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">
              NEW ENTRY
            </p>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Title"
                value={addTitle}
                onChange={e => setAddTitle(e.target.value)}
                className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A]"
              />
              <select
                value={addCategory}
                onChange={e => setAddCategory(e.target.value)}
                className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A]"
              >
                {CATEGORIES.map(c => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
              <textarea
                placeholder="Content"
                value={addContent}
                onChange={e => setAddContent(e.target.value)}
                rows={4}
                className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A] resize-none h-32"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={addEntry}
                  disabled={actionBusy}
                  className="bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {actionBusy ? 'Adding…' : 'Add Entry'}
                </button>
                <button
                  onClick={() => {
                    setShowAdd(false)
                    setAddTitle('')
                    setAddCategory('platform')
                    setAddContent('')
                  }}
                  className="border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs px-3 py-1.5 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Filter Pills */}
      <div className="flex flex-wrap gap-2 mb-6">
        {['all', ...CATEGORIES].map(cat => (
          <button
            key={cat}
            onClick={() => setCategoryFilter(cat)}
            className={`text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors ${
              categoryFilter === cat
                ? 'bg-[#8B1A1A] text-white'
                : 'border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8]'
            }`}
          >
            {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* Entries List */}
      {loading ? (
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-12 text-center flex items-center justify-center gap-2 text-sm text-[#9B8B85]">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : loadError ? (
        <div className="bg-white border border-[#F2EDE8] rounded-xl p-12 text-center">
          <p className="text-sm text-red-600">{loadError}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {filteredEntries.length === 0 && (
            <div className="bg-white border border-[#F2EDE8] rounded-xl p-12 text-center">
              <p className="text-sm text-[#9B8B85]">No entries in this category.</p>
            </div>
          )}

          {filteredEntries.map(entry => (
            <div
              key={entry.id}
              className="bg-white border border-[#F2EDE8] rounded-xl overflow-hidden"
            >
              {editingId === entry.id ? (
                /* Edit Mode */
                <div className="p-5">
                  <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">
                    EDITING ENTRY
                  </p>
                  <div className="flex flex-col gap-3">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A]"
                    />
                    <select
                      value={editCategory}
                      onChange={e => setEditCategory(e.target.value)}
                      className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A]"
                    >
                      {CATEGORIES.map(c => (
                        <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                      ))}
                    </select>
                    <textarea
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                      className="w-full bg-white border border-[#F2EDE8] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] focus:outline-none focus:border-[#8B1A1A] resize-none h-40"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => saveEdit(entry.id)}
                        disabled={actionBusy}
                        className="flex items-center gap-1.5 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {actionBusy ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="flex items-center gap-1.5 border border-[#F2EDE8] text-[#6B5B55] hover:bg-[#F2EDE8] text-xs px-3 py-1.5 rounded-lg transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* View Mode */
                <>
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#F2EDE8]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full flex-shrink-0 ${
                          CATEGORY_COLORS[entry.category] ?? 'bg-[#F2EDE8] text-[#6B5B55]'
                        }`}
                      >
                        {CATEGORY_LABELS[entry.category] ?? entry.category}
                      </span>
                      <p className="text-sm font-semibold text-[#1A0A0A] truncate">
                        {entry.title}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => startEdit(entry)}
                        className="p-1.5 rounded-lg text-[#9B8B85] hover:text-[#6B5B55] hover:bg-[#F2EDE8] transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteEntry(entry.id)}
                        disabled={actionBusy}
                        className="p-1.5 rounded-lg text-[#9B8B85] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Card Body */}
                  <div className="px-5 py-4">
                    <p className="text-sm text-[#6B5B55] leading-relaxed whitespace-pre-wrap">
                      {entry.content}
                    </p>
                    <p className="text-[11px] text-[#9B8B85] mt-3">
                      {entry.content.length} characters
                    </p>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
