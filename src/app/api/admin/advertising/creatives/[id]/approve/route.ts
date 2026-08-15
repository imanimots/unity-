import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/creatives/[id]/approve -- [id] is the campaign id (creative is 1:1 with its campaign). */
export const POST = handleSimpleAdminAction('admin_approve_ad_creative', 'admin:advertising:creatives:approve', false)
