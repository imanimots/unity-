import { cookies } from 'next/headers'
import { getRequestProfile } from '@/lib/supabase/require-admin'
import { DEFAULT_COUNTRY, STORAGE_KEY, getCountry, isSupportedCountry } from '@/lib/countries'

export type EffectiveCountrySource = 'profile' | 'cookie' | 'env_default' | 'hardcoded_default'

export interface EffectiveCountry {
  countryId: string
  isoCode: string
  displayName: string
  source: EffectiveCountrySource
}

/**
 * The one server-side resolver for "what country is this request browsing
 * as" -- every server component/route that needs it calls this, none
 * reimplement the resolution order locally.
 *
 * Order: authenticated profile's country_id -> the unity_country cookie ->
 * NEXT_PUBLIC_DEFAULT_COUNTRY -> hardcoded 'ZA'. A code that's known but
 * not currently active (e.g. a "coming soon" country) is treated the same
 * as an unknown code -- rejected, falls through to the next tier.
 */
export async function resolveEffectiveCountry(): Promise<EffectiveCountry> {
  const authed = await getRequestProfile()
  if (isSupportedCountry(authed?.profile.country_id)) {
    return toEffectiveCountry(authed!.profile.country_id, 'profile')
  }

  const cookieStore = await cookies()
  const cookieValue = cookieStore.get(STORAGE_KEY)?.value
  if (isSupportedCountry(cookieValue)) {
    return toEffectiveCountry(cookieValue!, 'cookie')
  }

  const envDefault = process.env.NEXT_PUBLIC_DEFAULT_COUNTRY
  if (isSupportedCountry(envDefault)) {
    return toEffectiveCountry(envDefault!, 'env_default')
  }

  return toEffectiveCountry(DEFAULT_COUNTRY.id, 'hardcoded_default')
}

function toEffectiveCountry(id: string, source: EffectiveCountrySource): EffectiveCountry {
  const country = getCountry(id)
  return { countryId: country.id, isoCode: country.id, displayName: country.name, source }
}
