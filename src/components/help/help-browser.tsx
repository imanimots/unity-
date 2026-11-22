'use client'

import { useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import {
  Search, Hourglass, ArrowRight, Headphones,
  Home, Calendar, ShoppingBag, Package, Wallet, Repeat, HelpCircle,
  MessageCircle, AlertTriangle, Star, CreditCard, Link2, ShieldCheck, Settings,
} from 'lucide-react'
import type { HelpTask, HelpRole, HelpCategory, LearnArticle } from '@/lib/help/types'
import { CATEGORY_LABELS, CATEGORY_DESCRIPTIONS, ROLE_LABELS } from '@/lib/help/types'

interface HelpBrowserProps {
  tasks: HelpTask[]
  learnArticles: LearnArticle[]
}

/**
 * Common shape both HelpTask and LearnArticle normalize into for
 * search/filter/category-grouping purposes -- this is what lets one
 * Help Center render both content types through the same component
 * rather than two disconnected UIs (CORE CONTENT PRINCIPLE: How-To vs
 * Learn are complementary content types within one Help Center, not
 * two systems). `kind` is the only thing that changes card chrome
 * (the How-To/Learn badge) and is never used to hide one type from
 * the other's search results.
 */
interface SearchableItem {
  id: string
  slug: string
  heading: string
  summary: string
  category: HelpCategory
  role: HelpRole[]
  providerDependency: HelpTask['providerDependency']
  kind: 'how-to' | 'learn'
  searchText: string
}

function toSearchable(task: HelpTask): SearchableItem {
  return {
    id: task.id, slug: task.slug, heading: task.iWantTo, summary: task.summary,
    category: task.category, role: task.role, providerDependency: task.providerDependency,
    kind: 'how-to',
    searchText: [task.title, task.iWantTo, task.summary, CATEGORY_LABELS[task.category], ...task.keywords, ...task.role.map((r) => ROLE_LABELS[r])].join(' ').toLowerCase(),
  }
}

function learnToSearchable(article: LearnArticle): SearchableItem {
  return {
    id: article.id, slug: article.slug, heading: article.title, summary: article.summary,
    category: article.category, role: article.role, providerDependency: article.providerDependency,
    kind: 'learn',
    searchText: [article.title, article.summary, CATEGORY_LABELS[article.category], ...article.keywords, ...article.synonyms, ...article.role.map((r) => ROLE_LABELS[r])].join(' ').toLowerCase(),
  }
}

const ROLES: HelpRole[] = ['guest', 'user', 'merchant', 'admin']
const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as HelpCategory[]

const CATEGORY_ICON: Record<HelpCategory, typeof Home> = {
  'getting-started': Home,
  renting: Calendar,
  buying: ShoppingBag,
  'selling-listing': Package,
  'rent-to-buy': Wallet,
  barter: Repeat,
  'looking-for': HelpCircle,
  messages: MessageCircle,
  'problems-disputes': AlertTriangle,
  reviews: Star,
  'money-payouts': CreditCard,
  affiliate: Link2,
  'account-privacy': ShieldCheck,
  'admin-help': Settings,
  'search-discovery': Search,
  safety: ShieldCheck,
  'payments-fees': CreditCard,
}

function matchesSearch(item: SearchableItem, query: string): boolean {
  if (!query) return true
  return item.searchText.includes(query.toLowerCase())
}

function KindBadge({ kind }: { kind: 'how-to' | 'learn' }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.05em] ${
        kind === 'learn' ? 'bg-[#8B1A1A]/10 text-[#8B1A1A]' : 'bg-[#F2EDE8] text-[#6B5B55]'
      }`}
    >
      {kind === 'learn' ? 'Learn' : 'How-To'}
    </span>
  )
}

function TaskRow({ item }: { item: SearchableItem }) {
  const t = useTranslations('help.helpCenterPage')
  return (
    <Link
      href={`/help/${item.slug}`}
      className="flex items-center justify-between gap-3 py-3 px-1 -mx-1 rounded-lg hover:bg-[#FAF8F5] transition-colors group"
    >
      <span className="flex items-center gap-2 min-w-0">
        <KindBadge kind={item.kind} />
        <span className="text-sm font-medium text-[#1A0A0A] group-hover:text-[#8B1A1A] transition-colors truncate">{item.heading}</span>
      </span>
      <span className="flex items-center gap-2 shrink-0">
        {item.providerDependency && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            <Hourglass size={9} /> {t('providerPendingBadge')}
          </span>
        )}
        <ArrowRight size={13} className="text-[#C4B8B0] group-hover:text-[#8B1A1A] transition-colors" />
      </span>
    </Link>
  )
}

function TaskCard({ item }: { item: SearchableItem }) {
  const t = useTranslations('help.helpCenterPage')
  return (
    <Link
      href={`/help/${item.slug}`}
      className="block h-full rounded-2xl border border-[#F2EDE8] bg-white p-5 hover:border-[#8B1A1A]/40 transition-colors"
    >
      <div className="flex items-center gap-2 mb-1.5">
        <KindBadge kind={item.kind} />
      </div>
      <p className="font-semibold text-sm text-[#1A0A0A]">{item.heading}</p>
      <p className="text-xs text-[#6B5B55] mt-1.5 leading-relaxed">{item.summary}</p>
      <div className="flex flex-wrap items-center gap-1.5 mt-3">
        <span className="text-[10px] font-medium uppercase tracking-[0.05em] text-[#9B8B85]">{CATEGORY_LABELS[item.category]}</span>
        {item.providerDependency && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
            <Hourglass size={9} /> {t('providerPendingBadge')}
          </span>
        )}
      </div>
    </Link>
  )
}

function SupportCard() {
  const t = useTranslations('help.helpCenterPage')
  return (
    <div className="rounded-2xl border border-[#8B1A1A]/20 bg-[#8B1A1A]/[0.04] p-5">
      <Headphones size={20} className="text-[#8B1A1A] mb-3" />
      <p className="font-bold text-[#1A0A0A] text-sm mb-1.5">{t('stillNeedHelp')}</p>
      <p className="text-xs text-[#6B5B55] leading-relaxed mb-4">{t('stillNeedHelpDesc')}</p>
      <Link
        href="/contact"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#8B1A1A] text-[#8B1A1A] text-xs font-semibold hover:bg-[#8B1A1A] hover:text-white transition-colors"
      >
        {t('contactSupport')} <ArrowRight size={12} />
      </Link>
    </div>
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
 *
 * E47 Phase 2: default (unfiltered) view renders as category-grouped
 * sections with a persistent left category rail + right support card
 * (Help Centre references) -- categories with zero real tasks are
 * omitted, never shown as an empty section. The moment a search query
 * or role filter is applied, or a single category is picked, this
 * reverts to a flat results list -- the same real-functionality-first
 * pattern used for Browse's default category rows vs. flat grid.
 */
export function HelpBrowser({ tasks, learnArticles }: HelpBrowserProps) {
  const t = useTranslations('help.helpCenterPage')
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<HelpRole | 'all'>('all')
  const [category, setCategory] = useState<HelpCategory | 'all'>('all')

  const allItems = useMemo(
    () => [...tasks.map(toSearchable), ...learnArticles.map(learnToSearchable)],
    [tasks, learnArticles]
  )

  const roleFiltered = useMemo(
    () => allItems.filter((item) => (role === 'all' || item.role.includes(role)) && matchesSearch(item, query)),
    [allItems, query, role]
  )

  const categoriesWithTasks = useMemo(
    () => ALL_CATEGORIES.filter((c) => roleFiltered.some((t) => t.category === c)),
    [roleFiltered]
  )

  const isDefaultView = category === 'all'
  const filtered = isDefaultView ? roleFiltered : roleFiltered.filter((t) => t.category === category)

  return (
    <div>
      {/* Search */}
      <div className="relative max-w-xl mx-auto mb-6">
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

      {/* Category pills -- mirrors the left rail below, so the same
          selection works identically on mobile (no rail) and desktop. */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 mb-3 scrollbar-hide">
        <button
          type="button"
          onClick={() => setCategory('all')}
          aria-pressed={category === 'all'}
          className={`shrink-0 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${category === 'all' ? 'bg-[#8B1A1A] text-white' : 'bg-white border border-[#E8E0D8] text-[#6B5B55] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'}`}
        >
          {t('allCategories')}
        </button>
        {categoriesWithTasks.map((c) => {
          const Icon = CATEGORY_ICON[c]
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${category === c ? 'bg-[#8B1A1A] text-white' : 'bg-white border border-[#E8E0D8] text-[#6B5B55] hover:border-[#8B1A1A] hover:text-[#8B1A1A]'}`}
            >
              <Icon size={13} /> {CATEGORY_LABELS[c]}
            </button>
          )
        })}
      </div>

      {/* Role filter -- a real, separate dimension the reference images
          don't show (they have no notion of per-role content), kept as
          its own row rather than folded into the category rail. */}
      <div className="flex flex-wrap gap-2 mb-8" role="group" aria-label="Filter by role">
        <button
          type="button"
          onClick={() => setRole('all')}
          aria-pressed={role === 'all'}
          className={`px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.04em] transition-colors ${role === 'all' ? 'bg-[#1A0A0A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55]'}`}
        >
          {t('everyone')}
        </button>
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            aria-pressed={role === r}
            className={`px-3 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.04em] transition-colors ${role === r ? 'bg-[#1A0A0A] text-white' : 'bg-[#F2EDE8] text-[#6B5B55]'}`}
          >
            {ROLE_LABELS[r]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-4">🔍</p>
          <p className="text-[#6B5B55]">{t('noResultsTitle')} {t('noResultsHint')}</p>
        </div>
      ) : (
        <div className="lg:grid lg:grid-cols-[200px_1fr_260px] lg:gap-8 lg:items-start">
          {/* Left category rail (desktop only) */}
          <aside className="hidden lg:block sticky top-24 space-y-0.5">
            <button
              onClick={() => setCategory('all')}
              className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${category === 'all' ? 'bg-[#8B1A1A] text-white' : 'text-[#1A0A0A] hover:bg-[#FAF8F5]'}`}
            >
              {t('allCategories')}
            </button>
            {categoriesWithTasks.map((c) => {
              const Icon = CATEGORY_ICON[c]
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${category === c ? 'bg-[#8B1A1A] text-white' : 'text-[#1A0A0A] hover:bg-[#FAF8F5]'}`}
                >
                  <Icon size={15} className={category === c ? 'text-white' : 'text-[#9B8B85]'} /> {CATEGORY_LABELS[c]}
                </button>
              )
            })}
          </aside>

          {/* Center content */}
          <div className="min-w-0">
            {isDefaultView ? (
              <div className="space-y-6">
                {categoriesWithTasks.map((c) => {
                  const Icon = CATEGORY_ICON[c]
                  const categoryTasks = roleFiltered.filter((task) => task.category === c)
                  return (
                    <div key={c} className="rounded-2xl border border-[#F2EDE8] bg-white p-5">
                      <div className="flex items-start gap-3 mb-1">
                        <div className="w-10 h-10 rounded-full bg-[#8B1A1A]/10 flex items-center justify-center shrink-0">
                          <Icon size={18} className="text-[#8B1A1A]" />
                        </div>
                        <div>
                          <h2 className="font-bold text-[#1A0A0A]">{CATEGORY_LABELS[c]}</h2>
                          <p className="text-xs text-[#9B8B85]">{CATEGORY_DESCRIPTIONS[c]}</p>
                        </div>
                      </div>
                      <div className="divide-y divide-[#F2EDE8] mt-2">
                        {categoryTasks.slice(0, 5).map((item) => (
                          <TaskRow key={item.id} item={item} />
                        ))}
                      </div>
                      {categoryTasks.length > 5 && (
                        <button
                          onClick={() => setCategory(c)}
                          className="text-xs font-semibold text-[#8B1A1A] hover:underline mt-2"
                        >
                          {CATEGORY_LABELS[c]} ({categoryTasks.length}) →
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {filtered.map((item) => (
                  <TaskCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </div>

          {/* Right support card (desktop only) */}
          <div className="hidden lg:block sticky top-24">
            <SupportCard />
          </div>
        </div>
      )}

      {/* Mobile support card -- the rail/sticky column above is desktop-only. */}
      <div className="lg:hidden mt-8">
        <SupportCard />
      </div>
    </div>
  )
}
