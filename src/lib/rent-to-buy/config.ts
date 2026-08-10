/**
 * Safe-by-default feature flag for the whole Rent-to-Buy domain,
 * mirroring src/lib/escrow/config.ts's readBooleanFlag() pattern
 * exactly. Checked at the route layer, once, at every entry point that
 * would create something NEW (enabling listing terms, creating a
 * request, accepting a rent_to_buy marketplace offer) -- never inside
 * the RPCs themselves. Disabling the flag never affects an existing
 * agreement: every other RTB route (payments, possession, default,
 * cure, payoff, return, recovery, admin) remains fully reachable
 * regardless of this flag's value (Rule M).
 */
function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

export function isRentToBuyEnabled(): boolean {
  return readBooleanFlag(process.env.RENT_TO_BUY_ENABLED)
}
