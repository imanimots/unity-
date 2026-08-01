import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export interface AdminEmailDeliveryRow {
  id: string
  eventType: string
  templateId: string
  recipientEmail: string | null
  status: string
  attempts: number
  provider: string | null
  relatedEntityType: string | null
  relatedEntityId: string | null
  createdAt: string
  sentAt: string | null
  failedAt: string | null
  lastError: string | null
}

export interface AdminEmailDeliveryFilters {
  status?: string
  eventType?: string
  limit?: number
}

/**
 * Never selects template_vars (booking references, names, amounts) in
 * bulk — the brief explicitly says not to show full sensitive template
 * variables in this monitoring view. last_error is included but is
 * already restricted, at write time, to an error class NAME only (e.g.
 * "RetryableEmailError"), never a raw provider message — see
 * src/lib/email/service.ts's own comment on this.
 */
export async function listAdminEmailDeliveries(admin: SupabaseClient, filters: AdminEmailDeliveryFilters): Promise<AdminEmailDeliveryRow[]> {
  let query = admin
    .from('email_deliveries')
    .select('id, event_type, template_id, recipient_email, status, attempts, provider, related_entity_type, related_entity_id, created_at, sent_at, failed_at, last_error')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.eventType && filters.eventType !== 'all') query = query.eq('event_type', filters.eventType)

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((r) => ({
    id: r.id,
    eventType: r.event_type,
    templateId: r.template_id,
    recipientEmail: r.recipient_email,
    status: r.status,
    attempts: r.attempts,
    provider: r.provider,
    relatedEntityType: r.related_entity_type,
    relatedEntityId: r.related_entity_id,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    failedAt: r.failed_at,
    lastError: r.last_error,
  }))
}
