import type { SupabaseClient } from '@supabase/supabase-js'
import type { MerchantAiCapability } from './types'
import { getMerchantEntitlements } from '@/lib/subscriptions/entitlements'

/**
 * Plan eligibility for a given AI capability, resolved server-side from
 * the caller's OWN merchant id -- never a client-supplied plan (Section
 * 65/74). Starter: neither. Pro: listing_assistant only. Elite: both.
 * A Pro merchant manually calling the analytics-assistant route must be
 * denied here, at the entitlement boundary, not merely hidden in the UI.
 */
export async function isMerchantAiCapabilityAllowed(supabase: SupabaseClient, merchantId: string, capability: MerchantAiCapability): Promise<boolean> {
  const entitlements = await getMerchantEntitlements(supabase, merchantId)
  if (capability === 'listing_assistant') return entitlements.listingAssistantEnabled
  return entitlements.analyticsAssistantEnabled
}
