import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 50

/**
 * Escapes a value for safe embedding inside a PostgREST `.or()`/`.in()`
 * combinator filter string (the raw string syntax `column.operator.value`
 * joined by commas, e.g. `a.eq.1,b.eq.2`, that supabase-js's `.or()` sends
 * verbatim as the `or=` query param). Wrapping the value in double quotes
 * is PostgREST's own documented escape for exactly this grammar: a comma,
 * parenthesis, period, or colon inside the quotes loses its structural
 * meaning and is treated as literal value content instead of a filter
 * separator -- so a search term like `abc,(def):ghi` can never widen the
 * filter into a second predicate or break the expression, without
 * stripping characters a legitimate search might need (case numbers use
 * hyphens, names can carry punctuation). Any literal backslash or double
 * quote in the value is itself backslash-escaped first, per the same
 * PostgREST rule, so the value can't prematurely close the quoted token.
 * Does not touch `%`/`_` -- those remain real ILIKE wildcards, matching
 * every other substring search already shipped in this codebase.
 */
export function quotePostgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface AdminSupportCaseRow {
  id: string
  caseNumber: string
  title: string
  category: string
  status: string
  priority: string
  customerId: string | null
  customerName: string | null
  merchantId: string | null
  merchantName: string | null
  linkedEntityType: string | null
  linkedEntityId: string | null
  assignedAdminId: string | null
  assignedAdminName: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminSupportCaseFilters {
  status?: string
  priority?: string
  category?: string
  assignedAdminId?: string
  /** Server-side filter -- true means "assigned_admin_id is null" rather than a literal admin id. */
  unassigned?: boolean
  search?: string
  limit?: number
  offset?: number
  /** Customer/Merchant 360 deep-link filter -- every case where this profile is the customer OR the merchant. */
  participantUserId?: string
}

export interface AdminSupportCasePage {
  cases: AdminSupportCaseRow[]
  total: number
}

/**
 * Server-side filtered + paginated list (Part 13 -- never loads the
 * whole table client-side). Name search resolves matching profile ids
 * first (same two-step pattern listAdminUsers already uses for its own
 * name search), then combines with a direct case_number/title ilike --
 * all pushed to Postgres via .or(), never filtered in memory.
 *
 * D3-F scope determination: Support Centre is an operational agent
 * work queue (assign/escalate/resolve/close/reopen/priority/notes --
 * see the dedicated action routes under src/app/api/admin/support/[id]/),
 * not a confirmed-real-customer business record list. An agent must
 * see and action every case regardless of the customer/merchant's
 * data_classification -- including a QA account's own ticket raised
 * while testing the Support flow itself. Also structurally necessary:
 * `support_cases` has no is_test column, and customer_id/merchant_id
 * are both nullable (not a universal boundary), so no reliable
 * relational test-exclusion path exists even if one were wanted.
 * Deliberately all-system -- do not add a classification filter here
 * without re-deriving this reasoning first.
 */
export async function listAdminSupportCases(admin: SupabaseClient, filters: AdminSupportCaseFilters): Promise<AdminSupportCasePage> {
  const limit = filters.limit ?? DEFAULT_LIMIT
  const offset = filters.offset ?? 0

  let query = admin
    .from('support_cases')
    .select('id, case_number, title, category, status, priority, customer_id, merchant_id, linked_entity_type, linked_entity_id, assigned_admin_id, created_at, updated_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.priority && filters.priority !== 'all') query = query.eq('priority', filters.priority)
  if (filters.category && filters.category !== 'all') query = query.eq('category', filters.category)
  if (filters.unassigned) {
    query = query.is('assigned_admin_id', null)
  } else if (filters.assignedAdminId) {
    query = query.eq('assigned_admin_id', filters.assignedAdminId)
  }
  if (filters.participantUserId) {
    query = query.or(`customer_id.eq.${filters.participantUserId},merchant_id.eq.${filters.participantUserId}`)
  }

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim()
    const quotedLike = quotePostgrestFilterValue(`%${q}%`)
    const { data: matchingProfiles } = await admin
      .from('profiles')
      .select('id')
      .or(`full_name.ilike.${quotedLike},display_name.ilike.${quotedLike}`)
    const profileIds = (matchingProfiles ?? []).map((p) => p.id as string)

    const clauses = [`case_number.ilike.${quotedLike}`, `title.ilike.${quotedLike}`]
    if (profileIds.length) {
      clauses.push(`customer_id.in.(${profileIds.join(',')})`)
      clauses.push(`merchant_id.in.(${profileIds.join(',')})`)
    }
    query = query.or(clauses.join(','))
  }

  const { data: rows, error, count } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return { cases: [], total: count ?? 0 }

  const userIds = Array.from(
    new Set([
      ...rows.filter((r) => r.customer_id).map((r) => r.customer_id as string),
      ...rows.filter((r) => r.merchant_id).map((r) => r.merchant_id as string),
      ...rows.filter((r) => r.assigned_admin_id).map((r) => r.assigned_admin_id as string),
    ])
  )
  const { data: profiles } = userIds.length
    ? await admin.from('profiles').select('id, full_name, display_name').in('id', userIds)
    : { data: [] as Array<{ id: string; full_name: string | null; display_name: string | null }> }

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))

  const cases: AdminSupportCaseRow[] = rows.map((r) => ({
    id: r.id,
    caseNumber: r.case_number,
    title: r.title,
    category: r.category,
    status: r.status,
    priority: r.priority,
    customerId: r.customer_id,
    customerName: r.customer_id ? (nameById.get(r.customer_id) ?? null) : null,
    merchantId: r.merchant_id,
    merchantName: r.merchant_id ? (nameById.get(r.merchant_id) ?? null) : null,
    linkedEntityType: r.linked_entity_type,
    linkedEntityId: r.linked_entity_id,
    assignedAdminId: r.assigned_admin_id,
    assignedAdminName: r.assigned_admin_id ? (nameById.get(r.assigned_admin_id) ?? null) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))

  return { cases, total: count ?? cases.length }
}

export interface AdminSupportCaseDetail {
  case: Record<string, unknown>
  customerName: string | null
  merchantName: string | null
  assignedAdminName: string | null
  notes: Array<{ id: string; note: string; adminId: string; adminName: string | null; createdAt: string }>
  history: Array<{
    id: string
    actorAdminId: string | null
    actorAdminName: string | null
    action: string
    reason: string | null
    previousState: Record<string, unknown> | null
    newState: Record<string, unknown> | null
    createdAt: string
  }>
}

/** D3-F: deliberately all-system, same operational-work-queue rationale as listAdminSupportCases above -- an agent opening a specific case must be able to, regardless of the customer/merchant's data_classification. */
export async function getAdminSupportCaseDetail(admin: SupabaseClient, caseId: string): Promise<AdminSupportCaseDetail | null> {
  const { data: supportCase, error } = await admin.from('support_cases').select('*').eq('id', caseId).maybeSingle()
  if (error) throw error
  if (!supportCase) return null

  const [{ data: notes }, { data: history }] = await Promise.all([
    admin.from('support_case_notes').select('id, note, admin_id, created_at').eq('case_id', caseId).order('created_at', { ascending: false }),
    admin.from('support_case_history').select('id, actor_admin_id, action, reason, previous_state, new_state, created_at').eq('case_id', caseId).order('created_at', { ascending: true }),
  ])

  const userIds = Array.from(
    new Set(
      [supportCase.customer_id, supportCase.merchant_id, supportCase.assigned_admin_id]
        .filter((id): id is string => !!id)
        .concat((notes ?? []).map((n) => n.admin_id as string))
        .concat((history ?? []).filter((h) => h.actor_admin_id).map((h) => h.actor_admin_id as string))
    )
  )
  const { data: profiles } = userIds.length
    ? await admin.from('profiles').select('id, full_name, display_name').in('id', userIds)
    : { data: [] as Array<{ id: string; full_name: string | null; display_name: string | null }> }
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))

  return {
    case: supportCase,
    customerName: supportCase.customer_id ? (nameById.get(supportCase.customer_id) ?? null) : null,
    merchantName: supportCase.merchant_id ? (nameById.get(supportCase.merchant_id) ?? null) : null,
    assignedAdminName: supportCase.assigned_admin_id ? (nameById.get(supportCase.assigned_admin_id) ?? null) : null,
    notes: (notes ?? []).map((n) => ({ id: n.id, note: n.note, adminId: n.admin_id, adminName: nameById.get(n.admin_id) ?? null, createdAt: n.created_at })),
    history: (history ?? []).map((h) => ({
      id: h.id,
      actorAdminId: h.actor_admin_id,
      actorAdminName: h.actor_admin_id ? (nameById.get(h.actor_admin_id) ?? null) : null,
      action: h.action,
      reason: h.reason,
      previousState: h.previous_state,
      newState: h.new_state,
      createdAt: h.created_at,
    })),
  }
}

export interface AdminSupportCaseSummary {
  id: string
  caseNumber: string
  title: string
  status: string
  priority: string
  createdAt: string
}

/** Customer/Merchant 360's "Support" card -- open-case count + the most recent few cases for this user, in either the customer or merchant role. */
export async function getSupportCaseSummaryForUser(admin: SupabaseClient, userId: string): Promise<{ openCount: number; recent: AdminSupportCaseSummary[] }> {
  const [{ count: openCount, error: countError }, { data: recentRows, error: recentError }] = await Promise.all([
    admin
      .from('support_cases')
      .select('id', { count: 'exact', head: true })
      .or(`customer_id.eq.${userId},merchant_id.eq.${userId}`)
      .not('status', 'in', '(resolved,closed)'),
    admin
      .from('support_cases')
      .select('id, case_number, title, status, priority, created_at')
      .or(`customer_id.eq.${userId},merchant_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(5),
  ])

  if (countError) throw countError
  if (recentError) throw recentError

  return {
    openCount: openCount ?? 0,
    recent: (recentRows ?? []).map((r) => ({ id: r.id, caseNumber: r.case_number, title: r.title, status: r.status, priority: r.priority, createdAt: r.created_at })),
  }
}
