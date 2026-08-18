import type { Locale } from '@/i18n/locales'

/**
 * Centralized, locale-aware presentation formatters -- consolidates the 8+
 * independently duplicated `function money(...)` implementations the i18n
 * audit found (dashboard/merchant/{commissions,subscription,advertising,
 * advertising/[id],advertising/new}/page.tsx, payment-breakdown.tsx,
 * admin/ui.tsx, email/context.ts), all of which used the same
 * `currency === 'ZAR' ? 'R' : currency + ' '` string-concatenation pattern.
 *
 * Money authority remains integer cents + currency code, computed and
 * stored exactly as before -- these functions are presentation-only and
 * never participate in financial arithmetic. Localization changes
 * formatting conventions (digit grouping, decimal separator); it never
 * changes the transaction currency, which stays ZAR for this phase.
 */

const CURRENCY_SYMBOLS: Record<string, string> = { ZAR: 'R' }

export function formatMoney(cents: number, currency: string, locale: Locale): string {
  const amount = cents / 100
  const symbol = CURRENCY_SYMBOLS[currency]
  if (symbol) {
    // Intl.NumberFormat's own currency display sometimes renders "ZAR" or
    // a locale-specific symbol placement that doesn't match Unity's brand
    // convention (always a leading "R"); formatting the number only and
    // prefixing the fixed symbol keeps the existing visual convention
    // exactly while still localizing digit grouping/decimal separators.
    return `${symbol}${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)}`
  }
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
}

/**
 * Same presentation logic as formatMoney, but for the handful of call
 * sites whose data layer already returns a converted rand amount (a
 * float) rather than integer cents -- e.g. commissions/page.tsx,
 * payment-breakdown.tsx. Kept as an explicit, separate function (not an
 * overload) specifically so a call site's existing unit convention is
 * never silently reinterpreted -- picking the wrong one of these two
 * functions is a real 100x-magnitude display bug, not just a lint issue.
 */
export function formatMoneyFromRands(amount: number, currency: string, locale: Locale): string {
  return formatMoney(Math.round(amount * 100), currency, locale)
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value)
}

export function formatPercent(value: number, locale: Locale, fractionDigits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * Business-date display -- explicitly pinned to Africa/Johannesburg
 * (South-Africa-primary platform behavior), independent of UI language.
 * Language selection must never change what timestamp a date renders as;
 * only the words/digit conventions around it change.
 */
export function formatDate(date: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(date))
}

export function formatDateTime(date: string | Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Johannesburg',
  }).format(new Date(date))
}
