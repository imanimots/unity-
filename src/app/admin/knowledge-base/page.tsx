'use client'
import { useState } from 'react'
import { Plus, Trash2, Edit2, Save, X, RefreshCw, BookOpen, Loader2, CheckCircle } from 'lucide-react'
import { KNOWLEDGE_BASE_ENTRIES } from '@/lib/assistant/seed-data'

type Entry = { id: string; title: string; category: string; content: string }

const CATEGORIES = ['platform', 'faq', 'policy', 'listing'] as const
type Category = typeof CATEGORIES[number]

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

export default function KnowledgeBasePage() {
  const [entries, setEntries] = useState<Entry[]>(
    KNOWLEDGE_BASE_ENTRIES.map((e, i) => ({ ...e, id: `kb-${i}` }))
  )
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [reEmbedStatus, setReEmbedStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')

  // Add form state
  const [addTitle, setAddTitle] = useState('')
  const [addCategory, setAddCategory] = useState<string>('platform')
  const [addContent, setAddContent] = useState('')

  // Edit form state
  const [editTitle, setEditTitle] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [editContent, setEditContent] = useState('')

  const handleReEmbed = async () => {
    setReEmbedStatus('loading')
    try {
      const res = await fetch('/api/assistant/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: true }),
      })
      setReEmbedStatus(res.ok ? 'success' : 'error')
      setTimeout(() => setReEmbedStatus('idle'), 3000)
    } catch {
      setReEmbedStatus('error')
      setTimeout(() => setReEmbedStatus('idle'), 3000)
    }
  }

  const deleteEntry = (id: string) => {
    if (confirm('Delete this entry?')) setEntries(e => e.filter(x => x.id !== id))
  }

  const startEdit = (entry: Entry) => {
    setEditingId(entry.id)
    setEditTitle(entry.title)
    setEditCategory(entry.category)
    setEditContent(entry.content)
  }

  const saveEdit = (id: string) => {
    setEntries(e =>
      e.map(x => x.id === id ? { ...x, title: editTitle, category: editCategory, content: editContent } : x)
    )
    setEditingId(null)
  }

  const addEntry = () => {
    if (!addTitle.trim() || !addContent.trim()) return
    setEntries(e => [...e, { title: addTitle, category: addCategory, content: addContent, id: `kb-new-${Date.now()}` }])
    setAddTitle('')
    setAddCategory('platform')
    setAddContent('')
    setShowAdd(false)
  }

  const filteredEntries = categoryFilter === 'all'
    ? entries
    : entries.filter(e => e.category === categoryFilter)

  const categories = Array.from(new Set(entries.map(e => e.category)))
  const totalEntries = entries.length
  const uniqueCategories = categories.length

  return (
    <div className="p-6 lg:p-8">
      {/* Page Header */}
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-1">
            AI ASSISTANT
          </p>
          <h1 className="text-2xl font-extrabold uppercase text-[#1A0A0A] dark:text-[#F5F0ED]">
            KNOWLEDGE BASE
          </h1>
        </div>

        {/* Re-Embed Button */}
        <button
          onClick={handleReEmbed}
          disabled={reEmbedStatus === 'loading'}
          className={`flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] px-4 py-2 rounded-lg transition-colors flex-shrink-0 ${
            reEmbedStatus === 'success'
              ? 'bg-green-100 text-green-700'
              : reEmbedStatus === 'error'
              ? 'bg-red-100 text-red-700'
              : 'bg-[#8B1A1A] text-white hover:bg-[#7A1616]'
          } disabled:opacity-60 disabled:cursor-not-allowed`}
        >
          {reEmbedStatus === 'idle' && (
            <>
              <RefreshCw className="w-3.5 h-3.5" />
              RE-EMBED ALL
            </>
          )}
          {reEmbedStatus === 'loading' && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Embedding…
            </>
          )}
          {reEmbedStatus === 'success' && (
            <>
              <CheckCircle className="w-3.5 h-3.5" />
              Done!
            </>
          )}
          {reEmbedStatus === 'error' && (
            <>
              <X className="w-3.5 h-3.5" />
              Failed
            </>
          )}
        </button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <BookOpen className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Total Entries</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{totalEntries}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Categories</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">{uniqueCategories}</p>
        </div>

        <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-4 col-span-2 lg:col-span-1">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-4 h-4 text-[#9B8B85]" />
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85]">Last Updated</p>
          </div>
          <p className="text-2xl font-bold text-[#1A0A0A] dark:text-[#F5F0ED]">Today</p>
        </div>
      </div>

      {/* Add New Entry Panel */}
      <div className="mb-6">
        {!showAdd ? (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs px-3 py-1.5 rounded-lg transition-colors font-medium uppercase tracking-[0.08em]"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Entry
          </button>
        ) : (
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.15em] text-[#9B8B85] mb-4">
              NEW ENTRY
            </p>
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Title"
                value={addTitle}
                onChange={e => setAddTitle(e.target.value)}
                className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A]"
              />
              <select
                value={addCategory}
                onChange={e => setAddCategory(e.target.value)}
                className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A]"
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
                className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A] resize-none h-32"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={addEntry}
                  className="bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors"
                >
                  Add Entry
                </button>
                <button
                  onClick={() => {
                    setShowAdd(false)
                    setAddTitle('')
                    setAddCategory('platform')
                    setAddContent('')
                  }}
                  className="border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs px-3 py-1.5 rounded-lg transition-colors"
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
                : 'border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A]'
            }`}
          >
            {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
          </button>
        ))}
      </div>

      {/* Entries List */}
      <div className="flex flex-col gap-4">
        {filteredEntries.length === 0 && (
          <div className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-12 text-center">
            <p className="text-sm text-[#9B8B85]">No entries in this category.</p>
          </div>
        )}

        {filteredEntries.map(entry => (
          <div
            key={entry.id}
            className="bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl overflow-hidden"
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
                    className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A]"
                  />
                  <select
                    value={editCategory}
                    onChange={e => setEditCategory(e.target.value)}
                    className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A]"
                  >
                    {CATEGORIES.map(c => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </select>
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full bg-white dark:bg-[#1A1010] border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-lg px-3 py-2 text-sm text-[#1A0A0A] dark:text-[#F5F0ED] focus:outline-none focus:border-[#8B1A1A] resize-none h-40"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => saveEdit(entry.id)}
                      className="flex items-center gap-1.5 bg-[#8B1A1A] text-white hover:bg-[#7A1616] text-xs font-medium uppercase tracking-[0.08em] px-3 py-1.5 rounded-lg transition-colors"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="flex items-center gap-1.5 border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#6B5B55] dark:text-[#9B8B85] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] text-xs px-3 py-1.5 rounded-lg transition-colors"
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
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#F2EDE8] dark:border-[#2A1A1A]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`text-[10px] font-semibold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full flex-shrink-0 ${
                        CATEGORY_COLORS[entry.category] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {CATEGORY_LABELS[entry.category] ?? entry.category}
                    </span>
                    <p className="text-sm font-semibold text-[#1A0A0A] dark:text-[#F5F0ED] truncate">
                      {entry.title}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => startEdit(entry)}
                      className="p-1.5 rounded-lg text-[#9B8B85] hover:text-[#6B5B55] hover:bg-[#F2EDE8] dark:hover:bg-[#2A1A1A] transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteEntry(entry.id)}
                      className="p-1.5 rounded-lg text-[#9B8B85] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Card Body */}
                <div className="px-5 py-4">
                  <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] leading-relaxed whitespace-pre-wrap">
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
    </div>
  )
}
