/**
 * Safe-by-default feature flag for the whole Personalization domain,
 * mirroring src/lib/rent-to-buy/config.ts and src/lib/escrow/config.ts's
 * readBooleanFlag() pattern exactly. Checked at the route/module layer
 * that would create or serve NEW personalized state -- never inside a
 * shared RPC. When false: no server-side behavioral event recording,
 * no anonymous-history use, no personalized modules rendered (generic
 * fallback only). This is a new user-facing discovery system and
 * launches deliberately -- never NEXT_PUBLIC_-prefixed, since client
 * code must never be the authority on whether it's enabled.
 */
function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

export function isPersonalizationEnabled(): boolean {
  return readBooleanFlag(process.env.PERSONALIZATION_ENABLED)
}
