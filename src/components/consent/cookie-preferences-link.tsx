'use client'

/**
 * Small client trigger so the (server-component) footer can reopen
 * the always-mounted ConsentBanner without the footer itself needing
 * to become a client component or hold consent state. See
 * consent-banner.tsx's matching 'unity-open-cookie-preferences'
 * listener.
 */
export function CookiePreferencesLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('unity-open-cookie-preferences'))}
      className={className}
    >
      Cookie Preferences
    </button>
  )
}
