import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { SITEMAP_ENTRIES } from '../sitemap-registry'
import { HELP_TASKS } from '../task-registry'
import { LEARN_ARTICLES } from '../learn-registry'

const REPO_ROOT = join(__dirname, '../../../..')

function findPages(dir: string, base = ''): string[] {
  let out: string[] = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out = out.concat(findPages(full, rel))
    else if (entry.name === 'page.tsx') out.push(rel)
  }
  return out
}

// Real route files, stripped of their Next.js file-system scaffolding
// (group segments, page.tsx suffix) down to the URL path they actually
// serve -- used below to prove every static (non-dynamic) path quoted in
// either registry resolves to a real route, never an invented one.
function toUrlPath(pageFilePath: string): string {
  return (
    '/' +
    pageFilePath
      .replace(/(^|\/)page\.tsx$/, '')
      .split('/')
      .filter((seg) => seg && !/^\([^)]+\)$/.test(seg)) // drop (marketing)/(dashboard)/(auth) groups
      .join('/')
  ).replace(/\/$/, '') || '/'
}

const localePages = findPages(join(REPO_ROOT, 'src/app/[locale]'))
const adminPages = findPages(join(REPO_ROOT, 'src/app/admin'))
const REAL_URL_PATHS = new Set<string>([
  ...localePages.map(toUrlPath),
  ...adminPages.map((p) => '/admin' + (toUrlPath(p) === '/' ? '' : toUrlPath(p))),
  '/#how-it-works', // in-page anchor on the homepage, not a separate route
])

function strip(path: string): { base: string; isDynamic: boolean } {
  const base = path.split('?')[0]
  return { base, isDynamic: base.includes('[') }
}

// A dynamic path (e.g. /listings/[id]) can't be matched verbatim against a
// real visited URL -- instead confirm the *shape* exists as a real
// Next.js route by checking the exact bracketed path is one of the real
// page paths.
function isRealPath(base: string): boolean {
  if (REAL_URL_PATHS.has(base)) return true
  // bracketed dynamic routes are already present verbatim in REAL_URL_PATHS
  // (toUrlPath preserves [id] segments), so a direct miss means it's fake.
  return false
}

describe('help sitemap registry', () => {
  it('has at least one entry per section', () => {
    for (const section of ['public', 'user', 'merchant', 'admin'] as const) {
      expect(SITEMAP_ENTRIES.some((e) => e.section === section)).toBe(true)
    }
  })

  it('every entry path resolves to a real route on disk (no dead/invented links)', () => {
    const dead = SITEMAP_ENTRIES.filter((e) => !isRealPath(strip(e.path).base)).map((e) => ({ id: e.id, path: e.path }))
    expect(dead).toEqual([])
  })

  it('every admin entry is marked requiresAdmin, and only admin entries point at /admin/*', () => {
    const mismatched = SITEMAP_ENTRIES.filter(
      (e) => e.path.startsWith('/admin') !== e.requiresAdmin
    ).map((e) => e.id)
    expect(mismatched).toEqual([])
  })

  it('entries with a providerDependency are flagged (never silently claimed live)', () => {
    const withProvider = SITEMAP_ENTRIES.filter((e) => e.providerDependency !== null)
    expect(withProvider.every((e) => typeof e.providerDependency === 'string')).toBe(true)
  })

  it('Rent-to-Buy is documented inside Rent browsing (?mode=rent), never as a standalone browse mode', () => {
    const standaloneRtbBrowse = SITEMAP_ENTRIES.filter((e) => /mode=rent[_-]to[_-]buy|mode=rtb/.test(e.path))
    expect(standaloneRtbBrowse).toEqual([])
  })

  it('the merchant "List an Item" entry matches the real create-listing route', () => {
    const entry = SITEMAP_ENTRIES.find((e) => e.id === 'list-an-item')
    expect(entry?.path).toBe('/dashboard/merchant/listings/new')
    expect(isRealPath(entry!.path)).toBe(true)
  })
})

describe('help task registry', () => {
  it('every relatedTaskIds entry resolves to a real task in the registry', () => {
    const ids = new Set(HELP_TASKS.map((t) => t.id))
    const dangling = HELP_TASKS.flatMap((t) =>
      t.relatedTaskIds.filter((id) => !ids.has(id)).map((id) => `${t.id} -> ${id}`)
    )
    expect(dangling).toEqual([])
  })

  it('every task id and slug is unique', () => {
    const ids = HELP_TASKS.map((t) => t.id)
    const slugs = HELP_TASKS.map((t) => t.slug)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('every non-dynamic route quoted by a task resolves to a real route on disk (no dead/invented links)', () => {
    const dead: string[] = []
    for (const task of HELP_TASKS) {
      for (const r of task.routes) {
        const { base } = strip(r.path)
        if (!isRealPath(base)) dead.push(`${task.id}: ${r.path}`)
      }
    }
    expect(dead).toEqual([])
  })

  it('tasks with status "pending-provider" always carry a providerDependency label', () => {
    // Note: 'partial' does NOT imply a providerDependency -- a task can be
    // partial for reasons unrelated to a third-party provider (e.g.
    // view-messages is partial because there's no unread/read indicator
    // yet, a known UX gap, not a provider gap).
    const unlabelled = HELP_TASKS.filter(
      (t) => t.status === 'pending-provider' && t.providerDependency === null
    ).map((t) => t.id)
    expect(unlabelled).toEqual([])
  })

  it('tasks with status "live" never carry a providerDependency (nothing live is secretly provider-gated)', () => {
    const mislabelled = HELP_TASKS.filter((t) => t.status === 'live' && t.providerDependency !== null).map((t) => t.id)
    expect(mislabelled).toEqual([])
  })

  it('every admin-only route (/admin/*) is only referenced by tasks whose role includes "admin"', () => {
    const mismatched: string[] = []
    for (const task of HELP_TASKS) {
      const touchesAdmin = task.routes.some((r) => r.path.startsWith('/admin'))
      if (touchesAdmin && !task.role.includes('admin')) mismatched.push(task.id)
    }
    expect(mismatched).toEqual([])
  })

  it('Rent-to-Buy tasks never describe a standalone RTB browse mode (it lives inside Rent browsing)', () => {
    const offenders = HELP_TASKS.filter((t) =>
      t.routes.some((r) => /mode=rent[_-]to[_-]buy|mode=rtb/.test(r.path))
    ).map((t) => t.id)
    expect(offenders).toEqual([])
  })

  it('the "list an item" task points at the real merchant create-listing route and does not invent a left-side merchant menu', () => {
    const task = HELP_TASKS.find((t) => t.id === 'list-an-item')
    expect(task).toBeDefined()
    expect(task!.routes.some((r) => r.path === '/dashboard/merchant/listings/new')).toBe(true)
    const stepsText = task!.steps.join(' ').toLowerCase()
    expect(stepsText).not.toMatch(/left-side menu|left sidebar|side navigation/)
  })

  it('every category referenced by a task is a known HelpCategory', () => {
    const unknown = HELP_TASKS.filter((t) => !KNOWN_CATEGORIES.has(t.category)).map((t) => t.id)
    expect(unknown).toEqual([])
  })

  it('every relatedLearnIds entry resolves to a real article in the Learn registry', () => {
    const learnIds = new Set(LEARN_ARTICLES.map((a) => a.id))
    const dangling = HELP_TASKS.flatMap((t) =>
      (t.relatedLearnIds ?? []).filter((id) => !learnIds.has(id)).map((id) => `${t.id} -> ${id}`)
    )
    expect(dangling).toEqual([])
  })
})

const KNOWN_CATEGORIES = new Set([
  'getting-started', 'renting', 'buying', 'selling-listing', 'rent-to-buy',
  'barter', 'looking-for', 'messages', 'problems-disputes', 'reviews',
  'money-payouts', 'affiliate', 'account-privacy', 'admin-help',
  'search-discovery', 'safety', 'payments-fees',
])

describe('help learn registry', () => {
  it('every id and slug is unique within the Learn registry', () => {
    const ids = LEARN_ARTICLES.map((a) => a.id)
    const slugs = LEARN_ARTICLES.map((a) => a.slug)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('no Learn article slug collides with a How-To task slug (they share one /help/[slug] route namespace)', () => {
    const taskSlugs = new Set(HELP_TASKS.map((t) => t.slug))
    const collisions = LEARN_ARTICLES.filter((a) => taskSlugs.has(a.slug)).map((a) => a.slug)
    expect(collisions).toEqual([])
  })

  it('every relatedTaskIds entry resolves to a real task in the registry', () => {
    const taskIds = new Set(HELP_TASKS.map((t) => t.id))
    const dangling = LEARN_ARTICLES.flatMap((a) =>
      (a.relatedTaskIds ?? []).filter((id) => !taskIds.has(id)).map((id) => `${a.id} -> ${id}`)
    )
    expect(dangling).toEqual([])
  })

  it('every relatedLearnIds entry resolves to a real article in the registry (and never points at itself)', () => {
    const learnIds = new Set(LEARN_ARTICLES.map((a) => a.id))
    const dangling: string[] = []
    for (const a of LEARN_ARTICLES) {
      for (const id of a.relatedLearnIds ?? []) {
        if (id === a.id) dangling.push(`${a.id} -> self`)
        else if (!learnIds.has(id)) dangling.push(`${a.id} -> ${id}`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('every category referenced by a Learn article is a known HelpCategory', () => {
    const unknown = LEARN_ARTICLES.filter((a) => !KNOWN_CATEGORIES.has(a.category)).map((a) => a.id)
    expect(unknown).toEqual([])
  })

  it('every Learn article has at least one section, or a definitions list (Glossary), but not neither', () => {
    const empty = LEARN_ARTICLES.filter((a) => a.sections.length === 0 && (!a.definitions || a.definitions.length === 0)).map((a) => a.id)
    expect(empty).toEqual([])
  })

  it('Rent-to-Buy is explained as part of Rent, never as a standalone fourth mode', () => {
    const rtbArticle = LEARN_ARTICLES.find((a) => a.id === 'learn-buy-rent-barter-rtb')
    expect(rtbArticle).toBeDefined()
    const text = rtbArticle!.sections.flatMap((s) => s.body).join(' ').toLowerCase()
    expect(text).toMatch(/feature of rent|part of rent|not a separate|not a fourth/)
  })

  it('no payments/logistics/KYC article names a specific provider as the live production authority', () => {
    const bannedClaims = /peach is|payfast is|tradesafe is live|bob go is live|sumsub is/i
    for (const a of LEARN_ARTICLES) {
      const text = [a.summary, ...a.sections.flatMap((s) => s.body), ...(a.quickAnswer ?? [])].join(' ')
      expect(text).not.toMatch(bannedClaims)
    }
  })
})
