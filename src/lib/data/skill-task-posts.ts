import type { BarterSkillTaskPublicPost, SkillTaskKind, SkillTaskDirection } from '@/types'
import { normalizeSearchQuery, decodeSearchCursor, encodeSearchCursor, computeSearchContextHash, isCursorValidForContext, resolveDefaultSort, type SearchCursor } from '@/lib/search/cursor'

export interface SkillTaskBrowseFilters {
  query?: string
  sort?: 'newest' | 'relevance'
  /** Opaque cursor from a previous SkillTaskPostsPage.nextCursor. */
  cursor?: string
  /** Defaults to 24. */
  limit?: number
}

export interface SkillTaskPostsPage {
  items: BarterSkillTaskPublicPost[]
  nextCursor: string | null
}

function skillTaskSearchContextParams(kind: SkillTaskKind, direction: SkillTaskDirection, resolvedSort: string, normalizedQuery: string | null) {
  return { kind, direction, query: normalizedQuery, sort: resolvedSort }
}

/**
 * Main Barter browse integration -- Skill+Available / Skill+Looking-For /
 * Task+Available / Task+Looking-For all read through the
 * `search_skill_task_posts` SQL RPC (Search Ranking MVP), which itself
 * queries only `barter_skill_task_public_posts` (the sole public
 * surface for this feature, per R5-2) -- never the base table. No
 * country dimension exists on this table (unlike listings), so no
 * country filter is applied here. No price/budget sort exists either
 * -- Skills/Tasks are never monetary.
 */
export async function getSkillTaskPublicPostsPage(
  kind: SkillTaskKind,
  direction: SkillTaskDirection,
  filters: SkillTaskBrowseFilters = {}
): Promise<SkillTaskPostsPage> {
  const { createClient } = await import('@/lib/supabase/server')
  const supabase = await createClient()
  if (!supabase) return { items: [], nextCursor: null }

  const normalizedQuery = normalizeSearchQuery(filters.query)
  const resolvedSort = resolveDefaultSort(filters.sort, normalizedQuery)
  const limit = filters.limit ?? 24
  const contextParams = skillTaskSearchContextParams(kind, direction, resolvedSort, normalizedQuery)
  const contextHash = computeSearchContextHash('skill_task_posts', contextParams)

  const decodedCursor = filters.cursor ? decodeSearchCursor(filters.cursor) : null
  const cursor: SearchCursor | null = decodedCursor && isCursorValidForContext(decodedCursor, 'skill_task_posts', contextParams) ? decodedCursor : null

  const { data: ranked, error: rpcError } = await supabase.rpc('search_skill_task_posts', {
    p_query: normalizedQuery,
    p_kind: kind,
    p_direction: direction,
    p_category_id: null,
    p_sort: resolvedSort,
    p_cursor_tier: cursor?.tier ?? null,
    p_cursor_score: cursor?.score ?? null,
    p_cursor_created_at: cursor?.createdAt ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit,
  })

  if (rpcError || !ranked || ranked.length === 0) return { items: [], nextCursor: null }

  type RankedRow = { id: string; match_tier: number; match_score: number; created_at: string }
  const rankedRows = ranked as RankedRow[]
  const ids = rankedRows.map((r) => r.id)

  const { data: rawData } = await supabase.from('barter_skill_task_public_posts').select('*').in('id', ids)
  const byId = new Map(((rawData ?? []) as BarterSkillTaskPublicPost[]).map((p) => [p.id, p]))
  const items = ids.map((id) => byId.get(id)).filter((p): p is BarterSkillTaskPublicPost => Boolean(p))

  const last = rankedRows[rankedRows.length - 1]
  const nextCursor =
    rankedRows.length === limit
      ? encodeSearchCursor({ tier: last.match_tier, score: last.match_score, price: null, createdAt: last.created_at, id: last.id, contextHash })
      : null

  return { items, nextCursor }
}

/** Convenience wrapper over getSkillTaskPublicPostsPage() for callers that only need the first page. */
export async function getSkillTaskPublicPosts(
  kind: SkillTaskKind,
  direction: SkillTaskDirection,
  filters: SkillTaskBrowseFilters = {}
): Promise<BarterSkillTaskPublicPost[]> {
  const page = await getSkillTaskPublicPostsPage(kind, direction, filters)
  return page.items
}
