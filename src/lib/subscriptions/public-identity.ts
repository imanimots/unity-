export interface MerchantPublicIdentity {
  publicName: string
  isElite: boolean
}

/**
 * Resolves what a merchant's identity looks like on public marketplace
 * surfaces (Section 10-14), from the already-computed public_profiles
 * view columns (is_elite, public_business_name -- both derived live in
 * SQL from the merchant's currently-effective plan, see
 * supabase/migrations/20260819072454_subscription_v2_downgrade_workflow.sql).
 * Never a client-settable field, never a permanent flag that survives a
 * downgrade -- the view itself already enforces that; this is just the
 * one place every consumer picks the final display string from,
 * mirroring the existing displayNameOf() fallback exactly.
 */
export function resolveMerchantPublicIdentity(row: {
  display_name: string | null
  full_name: string | null
  is_elite?: boolean | null
  public_business_name?: string | null
}): MerchantPublicIdentity {
  const fallbackName = row.display_name ?? row.full_name ?? 'Unity Member'
  const businessName = row.public_business_name?.trim()

  return {
    publicName: businessName ? businessName : fallbackName,
    isElite: row.is_elite ?? false,
  }
}
