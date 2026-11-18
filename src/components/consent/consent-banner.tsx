'use client'

import { useEffect, useState } from 'react'
import { Cookie } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { hasDecidedConsent, writeConsentPreferences, readConsentPreferences } from '@/lib/consent/preferences'

/**
 * Platform improvement programme, Phase 3 item 13. Mounted once,
 * app-wide, in the public locale root layout -- blocks nothing (the
 * page itself always renders), but src/lib/analytics/client.ts's
 * trackEvent() is a no-op until a choice is recorded here.
 *
 * Copy below is placeholder, deliberately simple, hardcoded English
 * only -- matching this codebase's existing convention of hardcoded
 * English UI chrome for recently-added components (e.g.
 * src/components/listings/filter-bar.tsx). This is NOT the final
 * legal wording: per the programme brief's own instruction, the real
 * copy needs South African legal/privacy review before launch, and
 * translating draft text into af-ZA/zu-ZA now would just need redoing
 * once that review changes the wording. Flagged explicitly in this
 * programme's final report as outstanding legal/translation work, not
 * silently left unfinished.
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false)
  const [customizing, setCustomizing] = useState(false)
  const [marketingDraft, setMarketingDraft] = useState(false)

  useEffect(() => {
    // Must run client-only (localStorage is unavailable during SSR) --
    // the same eslint-disable convention this codebase already uses
    // for a browser-only startup check (e.g. src/hooks/use-auth.ts).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(!hasDecidedConsent())
    const reopen = () => {
      const current = readConsentPreferences()
      setMarketingDraft(current?.marketing ?? false)
      setCustomizing(true)
      setVisible(true)
    }
    window.addEventListener('unity-open-cookie-preferences', reopen)
    return () => window.removeEventListener('unity-open-cookie-preferences', reopen)
  }, [])

  if (!visible) return null

  const accept = (analytics: boolean, marketing: boolean) => {
    writeConsentPreferences({ analytics, marketing })
    setVisible(false)
    setCustomizing(false)
  }

  return (
    <div
      role="dialog"
      aria-label="Cookie and privacy preferences"
      className="fixed bottom-0 inset-x-0 z-[90] p-4 sm:p-6"
    >
      <div className="max-w-2xl mx-auto bg-white rounded-2xl border border-[#F2EDE8] shadow-2xl p-5">
        <div className="flex items-start gap-3">
          <Cookie size={20} className="text-[#8B1A1A] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-[#1A0A0A] font-medium mb-1">We use cookies</p>
            <p className="text-sm text-[#6B5B55] mb-4">
              Unity uses essential cookies to run the site, and optional analytics cookies to understand how the
              marketplace is used. Analytics stays off until you say yes, and you can change your mind at any time
              from the footer link.{' '}
              <Link href="/privacy" className="text-[#8B1A1A] underline">Read our privacy policy</Link>.
            </p>

            {customizing && (
              <label className="flex items-center gap-2 mb-4 text-sm text-[#1A0A0A]">
                <input
                  type="checkbox"
                  checked={marketingDraft}
                  onChange={(e) => setMarketingDraft(e.target.checked)}
                  className="accent-[#8B1A1A]"
                />
                Marketing cookies (not currently used by Unity, reserved for future use)
              </label>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => accept(true, customizing ? marketingDraft : false)}
                className="px-4 py-2 rounded-xl bg-[#8B1A1A] text-white text-sm font-semibold hover:bg-[#6B1414] transition-colors"
              >
                Accept analytics
              </button>
              <button
                type="button"
                onClick={() => accept(false, false)}
                className="px-4 py-2 rounded-xl border border-[#F2EDE8] text-[#1A0A0A] text-sm font-medium hover:border-[#8B1A1A] transition-colors"
              >
                Essential only
              </button>
              {!customizing && (
                <button
                  type="button"
                  onClick={() => setCustomizing(true)}
                  className="text-sm text-[#6B5B55] hover:text-[#8B1A1A] underline"
                >
                  Customize
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
