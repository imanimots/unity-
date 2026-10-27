import { randomUUID } from 'crypto'
import { getAdminServiceClient } from '@/lib/admin/route-helpers'
import { validateEventMetadata } from './validation'
import type { ServerAnalyticsEventInput, AnalyticsActorState } from './types'

/**
 * Coarse, non-identifying actor classification (Section 7) -- derived
 * ONLY from a server-resolved profile (getRequestProfile()), never a
 * client-supplied role claim. `role` is the caller's actual
 * `profiles.role` value ('renter' | 'merchant' | 'both' | 'admin').
 */
export function deriveActorState(role: string | null | undefined): AnalyticsActorState {
  if (!role) return 'anonymous'
  if (role === 'admin') return 'admin'
  if (role === 'merchant' || role === 'both') return 'merchant'
  return 'authenticated'
}

/**
 * Server-side event emission for a critical event best recorded right
 * after a successful server-side action (Section 17), e.g. a booking
 * actually being created. This function can NEVER fail the caller's
 * core operation: every failure mode (misconfigured Supabase, an RPC
 * error, invalid metadata) is caught and swallowed here, never
 * rethrown. Callers should call this after their own success response
 * is already decided, never gate a 2xx response on it.
 */
export async function recordAnalyticsEvent(input: ServerAnalyticsEventInput): Promise<void> {
  try {
    const validated = validateEventMetadata(input.eventName, input.metadata ?? {})
    if (!validated.ok) return

    const admin = await getAdminServiceClient()
    if (!admin) return

    await admin.rpc('record_analytics_event', {
      p_event_id: input.eventId ?? randomUUID(),
      p_event_name: input.eventName,
      p_session_id: input.sessionId ?? null,
      p_actor_state: input.actorState ?? null,
      p_route_path: input.routePath ?? null,
      p_entity_type: input.entityType ?? null,
      p_entity_id: input.entityId ?? null,
      p_metadata: validated.data,
      p_data_classification: input.dataClassification ?? 'unknown',
    })
  } catch {
    // Analytics failure must never roll back or fail the caller's own
    // operation (booking/order/listing-publish/KYC submission, etc.).
  }
}
