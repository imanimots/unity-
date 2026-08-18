import { defineRouting } from 'next-intl/routing'
import { DEFAULT_LOCALE, LOCALES, LOCALE_PREFIXES } from './locales'

// Binding routing decision (i18n Phase 2): default locale (en-ZA) stays
// unprefixed at every existing URL; non-default locales get a short prefix
// that does not match the full locale identifier (/af, /zu — not
// /af-ZA, /zu-ZA). localeDetection is disabled deliberately: no request is
// ever automatically redirected based on cookie/Accept-Language/profile
// preference, so every existing unprefixed English URL keeps resolving to
// exactly the same content with zero redirects, matching the binding
// instruction that existing English URLs must remain unchanged. Locale only
// changes via explicit user action (language selector) or an explicit
// /af or /zu URL. See docs/I18N_GLOSSARY.md and the closure report for the
// full precedence rationale.
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: {
    mode: 'as-needed',
    prefixes: LOCALE_PREFIXES,
  },
  localeDetection: false,
})
