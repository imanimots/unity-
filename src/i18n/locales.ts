// Single source of truth for enabled locales. The locale allowlist itself is
// the rollout authority — enabling a future locale is a config change here,
// never a code change elsewhere (routing.ts, request.ts, and the language
// selector all derive from this file).
export const LOCALES = ['en-ZA', 'af-ZA', 'zu-ZA'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en-ZA'

// Custom URL prefixes distinct from the BCP-47 locale identifier itself —
// the identifier (af-ZA) stays canonical for <html lang>, Intl formatting,
// and DB storage (profiles.preferred_locale / email_deliveries.resolved_locale).
// Only the URL segment is shortened. en-ZA has no entry: it is the default
// locale and stays unprefixed under localePrefix mode 'as-needed'.
export const LOCALE_PREFIXES: Partial<Record<Locale, string>> = {
  'af-ZA': '/af',
  'zu-ZA': '/zu',
}

export const LOCALE_DISPLAY_NAMES: Record<Locale, string> = {
  'en-ZA': 'English',
  'af-ZA': 'Afrikaans',
  'zu-ZA': 'isiZulu',
}

// OpenGraph uses underscore-separated locale tags, not the BCP-47 hyphen form.
export const LOCALE_OG_TAGS: Record<Locale, string> = {
  'en-ZA': 'en_ZA',
  'af-ZA': 'af_ZA',
  'zu-ZA': 'zu_ZA',
}

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value)
}

export function localePathPrefix(locale: Locale): string {
  return LOCALE_PREFIXES[locale] ?? ''
}

// Strips a known locale prefix from a raw pathname, returning the resolved
// locale and the remaining path. Falls back to the default locale when no
// prefix matches (covers both "/" and any admin/api path that never carries
// a locale prefix in the first place).
export function stripLocalePrefix(pathname: string): { locale: Locale; path: string } {
  for (const locale of LOCALES) {
    const prefix = LOCALE_PREFIXES[locale]
    if (!prefix) continue
    if (pathname === prefix) return { locale, path: '/' }
    if (pathname.startsWith(`${prefix}/`)) return { locale, path: pathname.slice(prefix.length) }
  }
  return { locale: DEFAULT_LOCALE, path: pathname }
}

export function withLocalePrefix(path: string, locale: Locale): string {
  const prefix = localePathPrefix(locale)
  if (!prefix) return path
  return path === '/' ? prefix : `${prefix}${path}`
}
