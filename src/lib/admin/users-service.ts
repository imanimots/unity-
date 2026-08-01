import type { SupabaseClient } from '@supabase/supabase-js'

export interface AdminUserFilters {
  search?: string
  role?: string
  kycStatus?: string
  accountStatus?: string
  limit?: number
}

export interface AdminUserRow {
  id: string
  fullName: string | null
  displayName: string | null
  role: string
  kycStatus: string
  accountStatus: string
  unityScore: number
  createdAt: string
}

const DEFAULT_LIMIT = 100

/**
 * List users for the admin table. Never selects id-document fields —
 * those stay behind the dedicated identity-verification review page
 * (src/app/admin/verifications/[id]/page.tsx), which is the only place
 * sensitive document metadata is ever returned to an admin client.
 */
export async function listAdminUsers(admin: SupabaseClient, filters: AdminUserFilters): Promise<AdminUserRow[]> {
  let query = admin
    .from('profiles')
    .select('id, full_name, display_name, role, kyc_status, account_status, unity_score, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.role && filters.role !== 'all') query = query.eq('role', filters.role)
  if (filters.kycStatus && filters.kycStatus !== 'all') query = query.eq('kyc_status', filters.kycStatus)
  if (filters.accountStatus && filters.accountStatus !== 'all') query = query.eq('account_status', filters.accountStatus)
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim()
    query = query.or(`full_name.ilike.%${q}%,display_name.ilike.%${q}%`)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    displayName: row.display_name,
    role: row.role,
    kycStatus: row.kyc_status,
    accountStatus: row.account_status,
    unityScore: row.unity_score,
    createdAt: row.created_at,
  }))
}

export interface AdminUserDetail {
  profile: {
    id: string
    fullName: string | null
    displayName: string | null
    phone: string | null
    role: string
    kycStatus: string
    accountStatus: string
    statusReason: string | null
    statusChangedAt: string | null
    unityScore: number
    createdAt: string
  }
  verification: { status: string; reviewedAt: string | null } | null
  listingsCount: number
  bookingsAsRenterCount: number
  bookingsAsMerchantCount: number
  disputeCount: null // not yet available — no disputes domain exists (see docs/ADMIN_OPERATIONS.md)
  accountHistory: Array<{
    id: string
    actionType: string
    previousStatus: string
    newStatus: string
    userReason: string | null
    internalNote: string | null
    adminId: string
    createdAt: string
  }>
  notes: Array<{ id: string; note: string; adminId: string; createdAt: string }>
}

export async function getAdminUserDetail(admin: SupabaseClient, userId: string): Promise<AdminUserDetail | null> {
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, full_name, display_name, phone, role, kyc_status, account_status, status_reason, status_changed_at, unity_score, created_at')
    .eq('id', userId)
    .maybeSingle()

  if (profileError) throw profileError
  if (!profile) return null

  const [{ data: verification }, { count: listingsCount }, { count: renterCount }, { count: merchantCount }, { data: history }, { data: notes }] = await Promise.all([
    admin.from('identity_verifications').select('status, reviewed_at').eq('user_id', userId).maybeSingle(),
    admin.from('listings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId),
    admin.from('bookings').select('id', { count: 'exact', head: true }).eq('renter_id', userId),
    admin.from('bookings').select('id', { count: 'exact', head: true }).eq('merchant_id', userId),
    admin.from('user_account_history').select('id, action_type, previous_status, new_status, user_reason, internal_note, admin_id, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    admin.from('admin_notes').select('id, note, admin_id, created_at').eq('entity_type', 'user').eq('entity_id', userId).order('created_at', { ascending: false }),
  ])

  return {
    profile: {
      id: profile.id,
      fullName: profile.full_name,
      displayName: profile.display_name,
      phone: profile.phone,
      role: profile.role,
      kycStatus: profile.kyc_status,
      accountStatus: profile.account_status,
      statusReason: profile.status_reason,
      statusChangedAt: profile.status_changed_at,
      unityScore: profile.unity_score,
      createdAt: profile.created_at,
    },
    verification: verification ? { status: verification.status, reviewedAt: verification.reviewed_at } : null,
    listingsCount: listingsCount ?? 0,
    bookingsAsRenterCount: renterCount ?? 0,
    bookingsAsMerchantCount: merchantCount ?? 0,
    disputeCount: null,
    accountHistory: (history ?? []).map((h) => ({
      id: h.id,
      actionType: h.action_type,
      previousStatus: h.previous_status,
      newStatus: h.new_status,
      userReason: h.user_reason,
      internalNote: h.internal_note,
      adminId: h.admin_id,
      createdAt: h.created_at,
    })),
    notes: (notes ?? []).map((n) => ({ id: n.id, note: n.note, adminId: n.admin_id, createdAt: n.created_at })),
  }
}

export async function setUserAccountStatus(
  admin: SupabaseClient,
  userId: string,
  adminId: string,
  action: 'restricted' | 'suspended' | 'restored',
  userReason: string | null,
  internalNote: string | null,
  idempotencyKey: string | undefined
) {
  return admin.rpc('set_user_account_status', {
    p_user_id: userId,
    p_admin_id: adminId,
    p_action: action,
    p_user_reason: userReason ?? null,
    p_internal_note: internalNote ?? null,
    p_idempotency_key: idempotencyKey ?? null,
  })
}

export async function addAdminNote(
  admin: SupabaseClient,
  entityType: 'user' | 'listing' | 'booking',
  entityId: string,
  adminId: string,
  note: string,
  idempotencyKey: string | undefined
) {
  return admin.rpc('add_admin_note', {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_admin_id: adminId,
    p_note: note,
    p_idempotency_key: idempotencyKey ?? null,
  })
}
