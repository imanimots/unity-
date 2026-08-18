import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { isLocale, stripLocalePrefix, withLocalePrefix, LOCALES, DEFAULT_LOCALE } from '../locales'
import { formatMoney, formatDate } from '@/lib/i18n/format'

describe('locale config', () => {
  it('1. enabled locales are exactly en-ZA, af-ZA, zu-ZA', () => {
    expect(LOCALES).toEqual(['en-ZA', 'af-ZA', 'zu-ZA'])
  })

  it('2. default locale is en-ZA', () => {
    expect(DEFAULT_LOCALE).toBe('en-ZA')
  })

  it('3. isLocale accepts only the enabled allowlist', () => {
    expect(isLocale('en-ZA')).toBe(true)
    expect(isLocale('af-ZA')).toBe(true)
    expect(isLocale('zu-ZA')).toBe(true)
    expect(isLocale('fr-FR')).toBe(false)
    expect(isLocale('af')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale('')).toBe(false)
  })
})

describe('route prefix mapping', () => {
  it('4. en-ZA has no URL prefix', () => {
    expect(withLocalePrefix('/listings', 'en-ZA')).toBe('/listings')
    expect(withLocalePrefix('/', 'en-ZA')).toBe('/')
  })

  it('5. af-ZA uses the short /af prefix, not /af-ZA', () => {
    expect(withLocalePrefix('/listings', 'af-ZA')).toBe('/af/listings')
    expect(withLocalePrefix('/', 'af-ZA')).toBe('/af')
  })

  it('6. zu-ZA uses the short /zu prefix, not /zu-ZA', () => {
    expect(withLocalePrefix('/listings', 'zu-ZA')).toBe('/zu/listings')
  })
})

describe('locale parsing (stripLocalePrefix)', () => {
  it('7. unprefixed path resolves to the default locale', () => {
    expect(stripLocalePrefix('/listings')).toEqual({ locale: 'en-ZA', path: '/listings' })
  })

  it('8. /af prefix resolves to af-ZA and strips the prefix', () => {
    expect(stripLocalePrefix('/af/listings')).toEqual({ locale: 'af-ZA', path: '/listings' })
  })

  it('9. /zu prefix resolves to zu-ZA and strips the prefix', () => {
    expect(stripLocalePrefix('/zu/listings')).toEqual({ locale: 'zu-ZA', path: '/listings' })
  })

  it('10. bare /af (no trailing path) resolves to root', () => {
    expect(stripLocalePrefix('/af')).toEqual({ locale: 'af-ZA', path: '/' })
  })

  it('11. an unsupported prefix (e.g. /fr) is not treated as a locale prefix -- falls through to default', () => {
    expect(stripLocalePrefix('/fr/listings')).toEqual({ locale: 'en-ZA', path: '/fr/listings' })
  })

  it('12. round-trips: withLocalePrefix(stripLocalePrefix(x)) reconstructs the original path', () => {
    for (const [locale, prefix] of [['en-ZA', ''], ['af-ZA', '/af'], ['zu-ZA', '/zu']] as const) {
      const original = `${prefix}/listings?mode=barter`
      const { locale: parsedLocale, path } = stripLocalePrefix(original.split('?')[0])
      expect(parsedLocale).toBe(locale)
      expect(withLocalePrefix(path, parsedLocale)).toBe(original.split('?')[0])
    }
  })
})

describe('centralized formatters', () => {
  it('13. formatMoney keeps the ZAR "R" prefix convention across all 3 locales', () => {
    for (const locale of LOCALES) {
      expect(formatMoney(150000, 'ZAR', locale)).toMatch(/^R/)
    }
  })

  it('14. formatMoney never changes the underlying amount -- only presentation', () => {
    // 150000 cents = R1,500.00 regardless of locale digit-grouping conventions
    for (const locale of LOCALES) {
      const formatted = formatMoney(150000, 'ZAR', locale)
      const digitsOnly = formatted.replace(/[^\d]/g, '')
      expect(digitsOnly).toBe('150000')
    }
  })

  it('15. formatDate is stable and does not throw for any enabled locale', () => {
    for (const locale of LOCALES) {
      expect(() => formatDate('2026-08-17T10:00:00Z', locale)).not.toThrow()
    }
  })
})

describe('dictionary structural integrity', () => {
  const REPO_ROOT = join(__dirname, '../../..')
  const NAMESPACES = ['common', 'navigation', 'auth', 'marketplace', 'buy', 'rent', 'barter', 'skills', 'tasks', 'lookingFor', 'rtb', 'advertising', 'merchant', 'errors', 'emails', 'legal']

  function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    let out: string[] = []
    for (const k of Object.keys(obj).sort()) {
      const path = prefix ? `${prefix}.${k}` : k
      const v = obj[k]
      if (v && typeof v === 'object' && !Array.isArray(v)) out = out.concat(collectKeys(v as Record<string, unknown>, path))
      else out.push(path)
    }
    return out
  }

  it('16. all 48 dictionary files exist (16 namespaces x 3 locales)', () => {
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        expect(existsSync(join(REPO_ROOT, 'src/i18n/messages', locale, `${ns}.json`)), `${locale}/${ns}.json`).toBe(true)
      }
    }
  })

  it('17. every locale has identical key structure to en-ZA (no missing/stale keys)', () => {
    for (const ns of NAMESPACES) {
      const en = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages/en-ZA', `${ns}.json`), 'utf-8'))
      const enKeys = collectKeys(en)
      for (const locale of LOCALES) {
        const data = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, `${ns}.json`), 'utf-8'))
        const keys = collectKeys(data)
        expect(keys, `${locale}/${ns}.json`).toEqual(enKeys)
      }
    }
  })

  it('18. interpolation tokens are preserved identically across locales (same {placeholders})', () => {
    // Matches only real ICU argument names -- an identifier immediately
    // followed by "," (a plural/select opener, e.g. "{count, plural, ...}")
    // or "}" (a simple interpolation, e.g. "{name}"). Deliberately does NOT
    // match nested plural-category text like "{ukubhukha okungu-#}" --
    // isiZulu's plural forms place the noun before the "#" count marker
    // (valid ICU; a different but equally legal category-text position
    // than English's "{# booking}"), which is not a second interpolation
    // variable and must not be flagged as one.
    function extractTokens(v: string): string[] {
      return [...v.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort()
    }
    for (const ns of NAMESPACES) {
      const en = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages/en-ZA', `${ns}.json`), 'utf-8'))
      const enKeys = collectKeys(en)
      for (const locale of LOCALES) {
        const data = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, `${ns}.json`), 'utf-8'))
        for (const key of enKeys) {
          const enVal = key.split('.').reduce((o: Record<string, unknown>, k: string) => o?.[k] as Record<string, unknown>, en)
          const otherVal = key.split('.').reduce((o: Record<string, unknown>, k: string) => o?.[k] as Record<string, unknown>, data)
          if (typeof enVal === 'string' && typeof otherVal === 'string') {
            expect(extractTokens(otherVal), `${locale}/${ns}.json:${key}`).toEqual(extractTokens(enVal))
          }
        }
      }
    }
  })
})

describe('barter terminology safety', () => {
  const REPO_ROOT = join(__dirname, '../../..')

  it('19. Skill and Task remain distinct terms in every locale', () => {
    for (const locale of LOCALES) {
      const skills = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, 'skills.json'), 'utf-8'))
      const tasks = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, 'tasks.json'), 'utf-8'))
      expect(skills.label).not.toBe(tasks.label)
    }
  })

  it('20. Available and Looking For remain distinct terms in every locale', () => {
    for (const locale of LOCALES) {
      const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, 'src/i18n/messages', locale, 'marketplace.json'), 'utf-8'))
      expect(marketplace.direction.available).not.toBe(marketplace.direction.lookingFor)
    }
  })
})
