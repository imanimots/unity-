import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/campaigns/[id]/reject -- full refund to original funding source, reason required. */
export const POST = handleSimpleAdminAction('admin_reject_ad_campaign', 'admin:advertising:campaigns:reject', true)
