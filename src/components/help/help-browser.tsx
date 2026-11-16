'use client'

import { useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Search, Hourglass } from 'lucide-react'
import type { HelpTask, HelpRole, HelpCategory } from '@/lib/help/types'
import { CATEGORY_LABELS, ROLE_LABELS } from '@/lib/help/types'

interface HelpBrowserProps {
  tasks: HelpTask[]
}

const ROLES: HelpRole[] = ['guest', 'user', 'merchant', 'admin']
const CATEGORIES = Object.keys(CATEGORY_LABELS) as HelpCategory[]

function matchesSearch(task: HelpTask, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    task.title.toLowerCase().includes(q) ||
    task.iWantTo.toLowerCase().includes(q) ||
    task.summary.toLowerCase().includes(q) ||
    CATEGORY_LABELS[task.category].toLowerCase().includes(q) ||
    task.keywords.some((k) => k.toLowerCase().includes(q)) ||
    task.role.some((r) => ROLE_LABELS[r].toLowerCase().includes(q))
  )
}

/**
 * Client-side search/filter over a small, fully-loaded task list -- no
 * server round-trip needed (the data is static, see
 * src/lib/help/task-registry.ts), unlike the marketplace browse page's
 * server-driven filtering, which exists because listing data is real
 * and paginated. CATEGORY_LABELS/ROLE_LABELS are content taxonomy labels
 * (same precedent as CATEGORIES in src/types/index.ts) and stay
 * English-authoritative; only this component's own chrome is translated.
 */
export function HelpBrowser({ tasks }: HelpBrowserProps) {
  const t = useTranslations('help.helpCenterPage')
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<HelpRole | 'all'>('all')
  const [category, setCategory] = useState<HelpCategory | 'all'>('all')

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (role !== 'all' && !t.role.includes(role)) return false
      if (category !== 'all' && t.category !== category) return false
      return matchesSearch(t, query)
    })
  }, [tasks, query, role, category])

  return (
    <div>
      {/* Search */}
      <div className="relative max-w-xl mb-6">
        <label htmlFor={searchId} className="sr-only">{t('searchLabel')}</label>
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9B8B85] pointer-events-none" />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="w-full h-12 pl-11 pr-4 rounded-xl border border-[#E8E0D8] bg-white text-[#1A0A0A] placeholder-[#9B8B85] text-sm focus:outline-none focus:ring-2 focus:ring-[#8B1A1A]/30 focus:border-[#8B1A1A] transition-colors"
        />
      </div>

      {/* Role filter */}
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Filter by role">
        <button
          type="button"
          onClick={() => setRole('all')}
          aria-pressed={role === 'all'}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-[0.04em] transition-colors ${role === 'all' ? 'bg-[#8B1A1A] text-white' : 'bg-white border border-[#E8E0D8] text-[#6B5B55]'}`}
        >
          {t('everyone')}
        </button>
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            aria-pressed={role === r}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-[0.04em] transition-colors ${role === r ? 'bg-[#8B1A1A] text-white' : 'bg-white border border-[#E8E0D8] text-[#6B5B55]'}`}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2 mb-8" role="group" aria-label="Filter by category">
        <button
          type="button"
          onClick={() => setCategory('all')}
          aria-pressed={category === 'all'}
          className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${category === 'all' ? 'bg-[#1A0A0A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55]'}`}
        >
          {t('allCategories')}
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            aria-pressed={category === c}
            className={`px-3 py-1 rounded-full text-[11px] font-medium transition-colors ${category === c ? 'bg-[#1A0A0A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55]'}`}
          >
            {CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-4">🔍</p>
          <p className="text-[#6B5B55]">{t('noResultsTitle')} {t('noResultsHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((task) => (
            <Link
              key={task.id}
              href={`/help/${task.slug}`}
              className="block h-full rounded-2xl border border-[#F2EDE8] bg-white p-5 hover:border-[#8B1A1A]/40 transition-colors"
            >
              <p className="font-semibold text-sm text-[#1A0A0A]">{task.iWantTo}</p>
              <p className="text-xs text-[#6B5B55] mt-1.5 leading-relaxed">{task.summary}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[#9B8B85]">{CATEGORY_LABELS[task.category]}</span>
                {task.providerDependency && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                    <Hourglass size={9} /> {t('providerPendingBadge')}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
