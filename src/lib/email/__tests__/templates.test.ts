import { describe, it, expect } from 'vitest'
import { EMAIL_TEMPLATES, getEmailTemplate, renderTemplate, TemplateValidationError, type TemplateVars } from '../templates/catalogue'

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
}

const FORBIDDEN_CLAIM_PATTERNS = [
  /held in escrow/i,
  /escrow.?protected/i,
  /guaranteed payment/i,
  /sumsub verified/i,
  /peach protected/i,
  /insured/i,
  /government verified/i,
]

describe('email template catalogue (category: Templates)', () => {
  it('1. every catalogue entry has a non-empty, unique id and a valid event name', () => {
    const ids = EMAIL_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of EMAIL_TEMPLATES) {
      expect(t.id.length, t.id).toBeGreaterThan(0)
      expect(t.event.length, t.id).toBeGreaterThan(0)
      expect(t.event).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('2. every template renders both an HTML and a plain-text body', () => {
    for (const t of EMAIL_TEMPLATES) {
      const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS)
      expect(rendered.html.length, t.id).toBeGreaterThan(100)
      expect(rendered.text.length, t.id).toBeGreaterThan(20)
      expect(rendered.subject.length, t.id).toBeGreaterThan(0)
    }
  })

  it('3. required variables are validated -- omitting one throws TemplateValidationError, never silently renders blank', () => {
    for (const t of EMAIL_TEMPLATES) {
      if (t.requiredVars.length === 0) continue
      const missingOne = { ...FULL_SYNTHETIC_VARS }
      delete missingOne[t.requiredVars[0]]
      expect(() => renderTemplate(t.id, missingOne), t.id).toThrow(TemplateValidationError)
    }
  })

  it('4. unknown template id throws TemplateValidationError rather than silently returning empty content', () => {
    expect(() => renderTemplate('not-a-real-template', FULL_SYNTHETIC_VARS)).toThrow(TemplateValidationError)
  })

  it('5. no forbidden claim appears in any rendered template output', () => {
    for (const t of EMAIL_TEMPLATES) {
      const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS)
      for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
        expect(rendered.html, `${t.id} matched ${pattern}`).not.toMatch(pattern)
        expect(rendered.text, `${t.id} matched ${pattern}`).not.toMatch(pattern)
      }
    }
  })

  it('6. every payment/deposit template includes the exact required test-mode notice', () => {
    const paymentTemplateIds = EMAIL_TEMPLATES.filter((t) => t.event.startsWith('payment.') || t.event.startsWith('deposit.') || t.id.includes('financially-ready') || t.id.includes('payment-required') || t.id.includes('payment-reminder')).map((t) => t.id)
    expect(paymentTemplateIds.length).toBeGreaterThan(0)
    for (const id of paymentTemplateIds) {
      const rendered = renderTemplate(id, FULL_SYNTHETIC_VARS)
      expect(rendered.text, id).toContain('Unity is currently operating in test mode. No real payment, deposit or payout was processed.')
    }
  })

  it('7. every template includes the support contact and legal (Terms/Privacy) links', () => {
    for (const t of EMAIL_TEMPLATES) {
      const rendered = renderTemplate(t.id, FULL_SYNTHETIC_VARS)
      expect(rendered.text, t.id).toContain('support@unitytest.co.za')
      expect(rendered.text, t.id).toContain('/terms')
      expect(rendered.text, t.id).toContain('/privacy')
    }
  })

  it('8. getEmailTemplate returns undefined (not a fabricated default) for an unknown id', () => {
    expect(getEmailTemplate('does-not-exist')).toBeUndefined()
  })

  it('9. every event in the catalogue is one of the normalized event names documented in docs/TRANSACTIONAL_EMAILS.md', () => {
    const knownEvents = new Set([
      'listing.submitted', 'listing.changes_requested', 'listing.ownership_approved', 'listing.ownership_rejected',
      'listing.moderation_approved', 'listing.moderation_rejected', 'listing.activated', 'listing.suspended',
      'verification.submitted', 'verification.additional_information_requested', 'verification.approved', 'verification.rejected',
      'booking.requested', 'booking.rejected', 'booking.cancelled', 'booking.expired_unanswered',
      'booking.payment_required', 'booking.payment_reminder', 'booking.payment_expired', 'booking.financially_ready',
      'booking.started', 'booking.return_initiated', 'booking.completed',
      'payment.declined', 'payment.retryable_failure', 'deposit.failed',
      'dispute.opened', 'dispute.evidence_requested', 'dispute.evidence_received', 'dispute.under_review', 'dispute.resolved', 'dispute.closed', 'dispute.cancelled',
      'message.new',
      'barter.accepted', 'barter.deposit_required', 'barter.ready_to_exchange', 'barter.completion_requested', 'barter.completed', 'barter.cancelled',
      'order.created', 'order.payment_received', 'order.shipped', 'order.delivered', 'order.cancelled', 'order.payment_failed',
    ])
    for (const t of EMAIL_TEMPLATES) {
      expect(knownEvents.has(t.event), `unexpected event "${t.event}" on template "${t.id}"`).toBe(true)
    }
  })
})
