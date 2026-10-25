import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdminNoteRow {
  id: string
  note: string
  adminId: string
  createdAt: string
}

/**
 * Shared read side of the generic, entity-agnostic `admin_notes` table
 * (schema already supports entity_type IN ('user','listing','booking') --
 * confirmed directly from supabase/migrations/
 * 20260808000001_account_status_and_admin_notes.sql). The write side
 * already exists and is already entity-agnostic: `addAdminNote()` in
 * src/lib/admin/users-service.ts. This file only adds the missing read
 * side for listings/bookings (users-service.ts's own detail query
 * already does this inline for 'user').
 */
export async function listAdminNotesForEntity(admin: SupabaseClient, entityType: 'listing' | 'booking', entityId: string): Promise<AdminNoteRow[]> {
  const { data, error } = await admin
    .from('admin_notes')
    .select('id, note, admin_id, created_at')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((n) => ({ id: n.id, note: n.note, adminId: n.admin_id, createdAt: n.created_at }))
}
