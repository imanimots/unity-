import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

// Locale-aware wrappers around next/navigation. Using these instead of
// next/link and next/navigation directly is what keeps internal navigation
// "sticky" to the current locale (§53 of the i18n implementation prompt) —
// they automatically prepend/strip the locale prefix so call sites never
// need to manually string-concatenate a locale onto a path.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing)
