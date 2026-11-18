import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdminAuditEntry {
  id: string
  actorId: string | null
  actionType: string
  entityType: 'listing' | 'identity_verification' | 'user' | 'kyc_document_access'
  entityId: string
  safeReason: string | null
  createdAt: string
  result: string
}

const DEFAULT_LIMIT = 200

/**
 * Unifies the four existing immutable admin-action/admin-access history
 * tables (admin_action_history, identity_verification_history,
 * user_account_history, admin_kyc_document_access_log) into one
 * normalized feed — deliberately does NOT merge raw ledger_entries rows
 * in here (those are financial records, not admin actions; see
 * /admin/financial-operations for those). identity_verification_history
 * is filtered to admin_id IS NOT NULL — user-initiated submit/resubmit
 * rows are not admin actions and do not belong in an admin audit log.
 * admin_kyc_document_access_log (platform improvement programme, Phase
 * 1 item 5) is a READ log, not a mutation log like the other three —
 * included here so a KYC document view is just as visible in this one
 * feed as an approve/reject action, not a separate, easy-to-miss page.
 */
export async function listAdminAuditEntries(admin: SupabaseClient, limit = DEFAULT_LIMIT): Promise<AdminAuditEntry[]> {
  const [{ data: listingActions }, { data: kycActions }, { data: userActions }, { data: kycDocumentAccess }] = await Promise.all([
    admin
      .from('admin_action_history')
      .select('id, listing_id, action_type, admin_id, reason_code, internal_note, previous_status, new_status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    admin
      .from('identity_verification_history')
      .select('id, user_id, action_type, admin_id, reason_code, internal_note, previous_status, new_status, created_at')
      .not('admin_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit),
    admin
      .from('user_account_history')
      .select('id, user_id, action_type, admin_id, internal_note, previous_status, new_status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    admin
      .from('admin_kyc_document_access_log')
      .select('id, user_id, document_id, admin_id, accessed_at')
      .order('accessed_at', { ascending: false })
      .limit(limit),
  ])

  const entries: AdminAuditEntry[] = [
    ...(listingActions ?? []).map((r) => ({
      id: r.id,
      actorId: r.admin_id,
      actionType: r.action_type,
      entityType: 'listing' as const,
      entityId: r.listing_id,
      safeReason: r.reason_code ?? r.internal_note,
      createdAt: r.created_at,
      result: `${r.previous_status ?? 'none'} → ${r.new_status}`,
    })),
    ...(kycActions ?? []).map((r) => ({
      id: r.id,
      actorId: r.admin_id,
      actionType: r.action_type,
      entityType: 'identity_verification' as const,
      entityId: r.user_id,
      safeReason: r.reason_code ?? r.internal_note,
      createdAt: r.created_at,
      result: `${r.previous_status ?? 'none'} → ${r.new_status}`,
    })),
    ...(userActions ?? []).map((r) => ({
      id: r.id,
      actorId: r.admin_id,
      actionType: r.action_type,
      entityType: 'user' as const,
      entityId: r.user_id,
      safeReason: r.internal_note,
      createdAt: r.created_at,
      result: `${r.previous_status} → ${r.new_status}`,
    })),
    ...(kycDocumentAccess ?? []).map((r) => ({
      id: r.id,
      actorId: r.admin_id,
      actionType: 'kyc_document_viewed',
      entityType: 'kyc_document_access' as const,
      entityId: r.user_id,
      safeReason: null,
      createdAt: r.accessed_at,
      result: `document ${r.document_id}`,
    })),
  ]

  return entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit)
}
