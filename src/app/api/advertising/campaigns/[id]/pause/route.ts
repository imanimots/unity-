import { handleSimpleCampaignAction } from '@/lib/advertising/simple-campaign-action'

/** POST /api/advertising/campaigns/[id]/pause */
export const POST = handleSimpleCampaignAction('pause_ad_campaign', 'advertising:campaigns:pause', false)
