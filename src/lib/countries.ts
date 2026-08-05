export interface Country {
  id: string
  name: string
  flag: string
  currency: string
  currencySymbol: string
  active: boolean
}

// Add new countries here — flip active: true to enable without code changes.
export const COUNTRIES: Country[] = [
  { id: 'ZA', name: 'South Africa', flag: '🇿🇦', currency: 'ZAR', currencySymbol: 'R',  active: true  },
  { id: 'NG', name: 'Nigeria',      flag: '🇳🇬', currency: 'NGN', currencySymbol: '₦',  active: false },
  { id: 'KE', name: 'Kenya',        flag: '🇰🇪', currency: 'KES', currencySymbol: 'KSh', active: false },
  { id: 'GH', name: 'Ghana',        flag: '🇬🇭', currency: 'GHS', currencySymbol: 'GH₵', active: false },
  { id: 'GB', name: 'United Kingdom', flag: '🇬🇧', currency: 'GBP', currencySymbol: '£', active: false },
]

export const DEFAULT_COUNTRY = COUNTRIES[0]

export function getCountry(id: string): Country {
  return COUNTRIES.find((c) => c.id === id) ?? DEFAULT_COUNTRY
}

/** True only for a country that's both a known code AND currently active — a "coming soon" code is known but not supported for real filtering/persistence. */
export function isSupportedCountry(id: string | null | undefined): boolean {
  if (!id) return false
  return COUNTRIES.some((c) => c.id === id && c.active)
}

export const STORAGE_KEY = 'unity_country'
