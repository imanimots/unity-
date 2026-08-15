import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/advertisers/[id]/reject -- external advertisers only, reason required. */
export const POST = handleSimpleAdminAction('admin_reject_ad_advertiser', 'admin:advertising:advertisers:reject', true)
