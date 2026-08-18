import { getRequestConfig } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { isLocale, DEFAULT_LOCALE } from './locales'
import { loadMessages } from './load-messages'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE

  if (requested && !isLocale(requested)) {
    // An unsupported locale segment reached routing (should be structurally
    // unreachable given the fixed prefix allowlist in routing.ts, but this
    // is the fail-closed backstop rather than silently rendering en-ZA
    // content under someone else's locale segment).
    notFound()
  }

  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: 'Africa/Johannesburg',
  }
})
