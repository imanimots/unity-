import { Check } from 'lucide-react'

/**
 * Unity's paid-tier merchant badge (Section 10-11): maroon circle +
 * white check, accessible name "Elite". Presentation only -- never
 * implies KYC/identity verification (that's the separate green
 * ShieldCheck "Verified" badge rendered alongside this one wherever
 * both apply). Derivation of WHETHER to render this at all happens
 * upstream, from the live public_profiles.is_elite column
 * (src/lib/subscriptions/public-identity.ts) -- this component itself
 * has no opinion on entitlement, it only renders when told to.
 */
export function EliteBadge({ label = 'Elite', size = 14 }: { label?: string; size?: number }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex items-center justify-center rounded-full bg-[#8B1A1A] shrink-0"
      style={{ width: size, height: size }}
    >
      <Check size={Math.round(size * 0.65)} strokeWidth={3} className="text-white" />
    </span>
  )
}
