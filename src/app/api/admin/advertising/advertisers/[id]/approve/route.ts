import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/advertisers/[id]/approve -- external advertisers only. */
export const POST = handleSimpleAdminAction('admin_approve_ad_advertiser', 'admin:advertising:advertisers:approve', false)
