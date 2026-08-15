import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/campaigns/[id]/restore -- reason required, re-validates live eligibility before resuming. */
export const POST = handleSimpleAdminAction('admin_restore_ad_campaign', 'admin:advertising:campaigns:restore', true)
