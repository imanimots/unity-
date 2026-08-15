import { handleSimpleAdminAction } from '@/lib/advertising/simple-admin-action'

/** POST /api/admin/advertising/advertisers/[id]/suspend -- reason required, suspends every active/paused campaign too. */
export const POST = handleSimpleAdminAction('admin_suspend_ad_advertiser', 'admin:advertising:advertisers:suspend', true)
