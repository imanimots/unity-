import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/campaigns/[id]/suspend -- no refund, reversible via /restore, reason required. */
export const POST = handleSimpleAdminAction('admin_suspend_ad_campaign', 'admin:advertising:campaigns:suspend', true)
