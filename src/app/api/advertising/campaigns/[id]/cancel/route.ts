import { handleSimpleCampaignAction } from '@/lib/advertising/simple-campaign-action'

/** POST /api/advertising/campaigns/[id]/cancel */
export const POST = handleSimpleCampaignAction('cancel_ad_campaign', 'advertising:campaigns:cancel', true)
