import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/creatives/[id]/reject -- [id] is the campaign id, reason required. */
export const POST = handleSimpleAdminAction('admin_reject_ad_creative', 'admin:advertising:creatives:reject', true)
