import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/campaigns/[id]/approve -- external campaigns only; requires the creative to already be approved. */
export const POST = handleSimpleAdminAction('admin_approve_ad_campaign', 'admin:advertising:campaigns:approve', false)
