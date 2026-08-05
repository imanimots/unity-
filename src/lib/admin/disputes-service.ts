import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export interface AdminDisputeRow {
  id: string
  title: string
  status: string
  transactionType: 'booking' | 'order' | 'barter'
  transactionId: string
  transactionReference: string | null
  raisedById: string
  raisedByName: string | null
  assignedAdminId: string | null
  assignedAdminName: string | null
  outcome: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminDisputeFilters {
  status?: string
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminBookings' exact shape (operations-service.ts): one
 * base query + Promise.all of related rows + in-memory joins, no
 * separate "service class". A dispute's transaction reference is
 * resolved from whichever of booking_id/order_id/barter_agreement_id
 * is set -- the same generic pattern the dispute RPCs themselves use.
 */
export async function listAdminDisputes(admin: SupabaseClient, filters: AdminDisputeFilters): Promise<AdminDisputeRow[]> {
  let query = admin
    .from('disputes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const userIds = Array.from(
    new Set([...rows.map((r) => r.raised_by), ...rows.filter((r) => r.assigned_admin_id).map((r) => r.assigned_admin_id)])
  )
  const bookingIds = rows.filter((r) => r.booking_id).map((r) => r.booking_id)
  const orderIds = rows.filter((r) => r.order_id).map((r) => r.order_id)
  const barterIds = rows.filter((r) => r.barter_agreement_id).map((r) => r.barter_agreement_id)

  const [{ data: profiles }, { data: bookings }, { data: orders }, { data: agreements }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    bookingIds.length ? admin.from('bookings').select('id, booking_reference').in('id', bookingIds) : Promise.resolve({ data: [] }),
    orderIds.length ? admin.from('orders').select('id, order_reference').in('id', orderIds) : Promise.resolve({ data: [] }),
    barterIds.length ? admin.from('barter_agreements').select('id, agreement_reference').in('id', barterIds) : Promise.resolve({ data: [] }),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const bookingRefById = new Map((bookings ?? []).map((b) => [b.id, b.booking_reference]))
  const orderRefById = new Map((orders ?? []).map((o) => [o.id, o.order_reference]))
  const agreementRefById = new Map((agreements ?? []).map((a) => [a.id, a.agreement_reference]))

  let results: AdminDisputeRow[] = rows.map((r) => {
    const transactionType: AdminDisputeRow['transactionType'] = r.booking_id ? 'booking' : r.order_id ? 'order' : 'barter'
    const transactionId = r.booking_id ?? r.order_id ?? r.barter_agreement_id
    const transactionReference = r.booking_id
      ? (bookingRefById.get(r.booking_id) ?? null)
      : r.order_id
        ? (orderRefById.get(r.order_id) ?? null)
        : (agreementRefById.get(r.barter_agreement_id) ?? null)

    return {
      id: r.id,
      title: r.title,
      status: r.status,
      transactionType,
      transactionId,
      transactionReference,
      raisedById: r.raised_by,
      raisedByName: nameById.get(r.raised_by) ?? null,
      assignedAdminId: r.assigned_admin_id,
      assignedAdminName: r.assigned_admin_id ? (nameById.get(r.assigned_admin_id) ?? null) : null,
      outcome: r.outcome,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  })

  if (filters.search) {
    const q = filters.search.toLowerCase()
    results = results.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.raisedByName ?? '').toLowerCase().includes(q) ||
        (d.transactionReference ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminDisputeDetail {
  dispute: Record<string, unknown>
  history: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
}

export async function getAdminDisputeDetail(admin: SupabaseClient, disputeId: string): Promise<AdminDisputeDetail | null> {
  const { data: dispute } = await admin.from('disputes').select('*').eq('id', disputeId).maybeSingle()
  if (!dispute) return null

  const [{ data: history }, { data: evidence }] = await Promise.all([
    admin.from('dispute_history').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
    admin.from('dispute_evidence').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
  ])

  return { dispute, history: history ?? [], evidence: evidence ?? [] }
}
