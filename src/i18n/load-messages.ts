import 'server-only'
import type { Locale } from './locales'

// One JSON file per domain namespace, per locale — never one giant
// messages.json (§63 of the i18n implementation prompt). Server Components
// resolve the full merged object server-side only (this module is
// `server-only`-guarded, so it can never be pulled into a client bundle);
// Client Components that need translations receive only the specific
// namespace slice they require, passed as a prop (see
// src/i18n/client-messages.ts), never this full loader.
export const MESSAGE_NAMESPACES = [
  'common',
  'navigation',
  'auth',
  'marketplace',
  'buy',
  'rent',
  'barter',
  'skills',
  'tasks',
  'lookingFor',
  'rtb',
  'advertising',
  'merchant',
  'errors',
  'emails',
  'legal',
  'personalization',
] as const

export type MessageNamespace = (typeof MESSAGE_NAMESPACES)[number]

const loaders: Record<Locale, () => Promise<Record<string, unknown>>> = {
  'en-ZA': async () => {
    const modules = await Promise.all(
      MESSAGE_NAMESPACES.map((ns) => import(`./messages/en-ZA/${ns}.json`))
    )
    return Object.fromEntries(MESSAGE_NAMESPACES.map((ns, i) => [ns, modules[i].default]))
  },
  'af-ZA': async () => {
    const modules = await Promise.all(
      MESSAGE_NAMESPACES.map((ns) => import(`./messages/af-ZA/${ns}.json`))
    )
    return Object.fromEntries(MESSAGE_NAMESPACES.map((ns, i) => [ns, modules[i].default]))
  },
  'zu-ZA': async () => {
    const modules = await Promise.all(
      MESSAGE_NAMESPACES.map((ns) => import(`./messages/zu-ZA/${ns}.json`))
    )
    return Object.fromEntries(MESSAGE_NAMESPACES.map((ns, i) => [ns, modules[i].default]))
  },
}

export async function loadMessages(locale: Locale) {
  return loaders[locale]()
}
