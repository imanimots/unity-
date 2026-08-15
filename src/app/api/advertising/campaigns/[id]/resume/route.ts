import { handleSimpleCampaignAction } from '@/lib/advertising/simple-campaign-action'

/** POST /api/advertising/campaigns/[id]/resume */
export const POST = handleSimpleCampaignAction('resume_ad_campaign', 'advertising:campaigns:resume', false)
