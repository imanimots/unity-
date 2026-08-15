/**
 * Safe-by-default feature flag for the whole Advertising domain,
 * mirroring src/lib/escrow/config.ts's readBooleanFlag() pattern
 * exactly. While ADVERTISING_ENABLED is unset or anything other than
 * the literal string "true": no ad campaign may be created/funded/
 * activated, and get_eligible_ads() is never called from any public
 * surface (the organic search/browse result set is byte-identical to
 * before this phase). Server-only -- there is deliberately no
 * NEXT_PUBLIC_ADVERTISING_ENABLED; client code may receive a
 * server-derived availability boolean, but serving/spend authority
 * always stays server-side.
 */
function readBooleanFlag(value: string | undefined): boolean {
  return value === 'true'
}

export function isAdvertisingEnabled(): boolean {
  return readBooleanFlag(process.env.ADVERTISING_ENABLED)
}
