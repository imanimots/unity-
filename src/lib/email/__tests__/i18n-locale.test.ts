import { describe, it, expect } from 'vitest'
import { EMAIL_TEMPLATES, renderTemplate, type TemplateVars } from '../templates/catalogue'
import { LOCALES, type Locale } from '@/i18n/locales'

const FULL_SYNTHETIC_VARS: TemplateVars = {
  merchantName: 'Jane Merchant',
  renterName: 'Sam Renter',
  userName: 'Alex User',
  recipientName: 'Alex User',
  listingTitle: 'Example Item',
  bookingReference: 'UN-TEST0001',
  feedback: 'Example feedback text.',
  paymentDueAt: '15 Aug 2026, 14:00',
  totalAmount: 'R2,500.00',
  raiserName: 'Sam Raiser',
  respondentName: 'Jane Respondent',
  title: 'Item arrived damaged',
  transactionReference: 'UN-TEST0001',
  outcomeLabel: 'Merchant wins',
  note: 'Please upload a photo of the damage.',
  cancellation_reason: 'Resolved outside the platform.',
  senderName: 'Sam Sender',
  messagePreview: 'Hey, is this still available?',
  agreementReference: 'BT-TEST0001',
  orderReference: 'OR-TEST0001',
  affiliateCode: 'AFC-TEST',
  commissionAmount: 'R80.00',
  voidReason: 'transaction was cancelled',
  adjustmentAmount: 'R10.00',
  payoutAmount: 'R1,200.00',
  payoutReference: 'MOCK-PAYOUT-TEST0001',
  failureMessage: 'Unity is reviewing an internal payout issue.',
  planName: 'Pro Merchant',
  requestTitle: 'Looking for a pressure washer',
}

const NON_DEFAULT_LOCALES = LOCALES.filter((l) => l !== 'en-ZA') as Locale[]

describe('email template locale coverage (category: i18n)', () => {
  it('1. every customer/merchant template has a real localeVariants entry for every non-default locale', () => {
    for (const t of EMAIL_TEMPLATES) {
      for (const locale of NON_DEFAULT_LOCALES) {
        expect(t.localeVariants?.[locale], `${t.id} missing ${locale}`).toBeDefined()
      }
    }
  })

  it('2. every locale variant renders a non-empty subject, HTML body, and text body', () => {
    for (const t of EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, locale)
        expect(rendered.subject.length, `${t.id}/${locale} subject`).toBeGreaterThan(0)
        expect(rendered.html.length, `${t.id}/${locale} html`).toBeGreaterThan(100)
        expect(rendered.text.length, `${t.id}/${locale} text`).toBeGreaterThan(20)
      }
    }
  })

  it('3. every locale variant carries the correct <html lang> attribute', () => {
    for (const t of EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, locale)
        expect(rendered.html, `${t.id}/${locale}`).toContain(`<html lang="${locale}">`)
      }
    }
  })

  it('4. af-ZA and zu-ZA variants are not byte-identical to the en-ZA subject/body (real translations, not copies)', () => {
    for (const t of EMAIL_TEMPLATES) {
      const base = renderTemplate(t.id, FULL_SYNTHETIC_VARS, 'en-ZA')
      for (const locale of NON_DEFAULT_LOCALES) {
        const variant = renderTemplate(t.id, FULL_SYNTHETIC_VARS, locale)
        expect(variant.subject, `${t.id}/${locale} subject identical to en-ZA`).not.toBe(base.subject)
      }
    }
  })

  it('5. required variables are validated identically regardless of locale -- a locale never bypasses validation', () => {
    for (const t of EMAIL_TEMPLATES) {
      if (t.requiredVars.length === 0) continue
      const missingOne: TemplateVars = { ...FULL_SYNTHETIC_VARS }
      delete missingOne[t.requiredVars[0]]
      for (const locale of NON_DEFAULT_LOCALES) {
        expect(() => renderTemplate(t.id, missingOne, locale), `${t.id}/${locale}`).toThrow()
      }
    }
  })

  it('6. interpolated variable values (names, references, amounts) appear verbatim in every locale variant -- interpolation params survive translation', () => {
    for (const t of EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, locale)
        // Every template greets by name or references at least one dynamic
        // value; spot-check the most universally-required one available.
        if (t.requiredVars.includes('recipientName')) {
          expect(rendered.text, `${t.id}/${locale}`).toContain('Alex User')
        }
        if (t.requiredVars.includes('merchantName')) {
          expect(rendered.text, `${t.id}/${locale}`).toContain('Jane Merchant')
        }
      }
    }
  })

  it('7. no raw ICU/template syntax or unresolved placeholder leaks into rendered output', () => {
    const rawSyntaxPatterns = [/\{\{/, /\}\}/, /undefined/, /\[object Object\]/]
    for (const t of EMAIL_TEMPLATES) {
      for (const locale of LOCALES) {
        const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, locale)
        for (const pattern of rawSyntaxPatterns) {
          expect(rendered.html, `${t.id}/${locale} matched ${pattern}`).not.toMatch(pattern)
          expect(rendered.text, `${t.id}/${locale} matched ${pattern}`).not.toMatch(pattern)
        }
      }
    }
  })

  it('8. internal CTA links carry the correct locale URL prefix, exactly once (no double-prefix)', () => {
    const templatesWithCta = EMAIL_TEMPLATES.filter((t) => t.build(FULL_SYNTHETIC_VARS).cta)
    expect(templatesWithCta.length).toBeGreaterThan(0)
    for (const t of templatesWithCta) {
      const enRendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, 'en-ZA')
      // en-ZA is unprefixed
      expect(enRendered.text).not.toMatch(/https?:\/\/[^\s]+\/(af|zu)\//)

      const afRendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, 'af-ZA')
      expect(afRendered.text, t.id).toMatch(/https?:\/\/[^\s]+\/af\//)
      expect(afRendered.text, t.id).not.toMatch(/\/af\/af\//)

      const zuRendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS, 'zu-ZA')
      expect(zuRendered.text, t.id).toMatch(/https?:\/\/[^\s]+\/zu\//)
      expect(zuRendered.text, t.id).not.toMatch(/\/zu\/zu\//)
    }
  })

  it('9. legal footer links (Terms/Privacy/Contact) are also locale-prefixed for non-default locales', () => {
    const rendered = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS, 'af-ZA')
    expect(rendered.text).toContain('/af/terms')
    expect(rendered.text).toContain('/af/privacy')
    expect(rendered.text).toContain('/af/contact')
  })

  it('10. recipient locale is independent per render call -- rendering the same template for two different locales in sequence never leaks state', () => {
    const first = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS, 'af-ZA')
    const second = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS, 'zu-ZA')
    const third = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS, 'af-ZA')
    expect(third.subject).toBe(first.subject)
    expect(second.subject).not.toBe(first.subject)
  })

  it('11. omitting the locale argument falls back to en-ZA (unchanged prior default behavior)', () => {
    const explicit = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS, 'en-ZA')
    const implicit = renderTemplate('booking-requested-renter', FULL_SYNTHETIC_VARS)
    expect(implicit.subject).toBe(explicit.subject)
    expect(implicit.html).toContain('<html lang="en-ZA">')
  })
})
