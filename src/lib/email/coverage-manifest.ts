import { EMAIL_TEMPLATES } from './templates/catalogue'
import { LOCALES, type Locale } from '@/i18n/locales'

/**
 * Deterministic, drift-proof email coverage manifest (i18n completion
 * delta, §7). Derived directly from the real EMAIL_TEMPLATES array and
 * each template's actual `localeVariants` map -- never a hand-maintained
 * parallel list that could silently fall out of sync with the catalogue.
 * Adding a new template to catalogue.ts makes it appear here automatically
 * on the next run; adding a `localeVariants` entry flips its coverage to
 * true automatically. This is what lets scripts/verify-i18n.mjs assert
 * real, specific per-template completion instead of one broad "email
 * coverage" skip.
 *
 * Recipient classification is a fixed, explicit STAFF_ONLY_TEMPLATE_IDS
 * allowlist (currently empty -- every template in the catalogue as of this
 * phase is a real customer/merchant-facing send; there is no staff-only
 * email template in this codebase today, confirmed by inspecting every
 * entry's id/event/recipient naming convention). If a genuinely
 * staff/admin-only template is added later, add its id here explicitly --
 * do NOT infer "staff-only" from a naming heuristic, since that's exactly
 * the kind of silent-guess mechanism this manifest exists to avoid.
 */
const STAFF_ONLY_TEMPLATE_IDS: ReadonlySet<string> = new Set([])

export interface TemplateCoverage {
  id: string
  event: string
  recipientClass: 'customer_merchant' | 'staff_only'
  localeComplete: Record<Locale, boolean>
  fullyComplete: boolean
}

export function getEmailCoverageManifest(): TemplateCoverage[] {
  return EMAIL_TEMPLATES.map((def) => {
    const recipientClass: TemplateCoverage['recipientClass'] = STAFF_ONLY_TEMPLATE_IDS.has(def.id)
      ? 'staff_only'
      : 'customer_merchant'

    const localeComplete = Object.fromEntries(
      LOCALES.map((locale) => [locale, locale === 'en-ZA' ? true : Boolean(def.localeVariants?.[locale])])
    ) as Record<Locale, boolean>

    return {
      id: def.id,
      event: def.event,
      recipientClass,
      localeComplete,
      fullyComplete: recipientClass === 'staff_only' || LOCALES.every((l) => localeComplete[l]),
    }
  })
}

export function summarizeEmailCoverage() {
  const manifest = getEmailCoverageManifest()
  const customerMerchant = manifest.filter((m) => m.recipientClass === 'customer_merchant')
  const staffOnly = manifest.filter((m) => m.recipientClass === 'staff_only')
  return {
    totalTemplates: manifest.length,
    customerMerchantCount: customerMerchant.length,
    staffOnlyCount: staffOnly.length,
    fullyCompleteCount: customerMerchant.filter((m) => m.fullyComplete).length,
    incompleteIds: customerMerchant.filter((m) => !m.fullyComplete).map((m) => m.id),
    perLocale: Object.fromEntries(
      LOCALES.map((locale) => [locale, customerMerchant.filter((m) => m.localeComplete[locale]).length])
    ) as Record<Locale, number>,
  }
}
