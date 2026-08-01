import { renderShell, type ShellInput } from './shared'

export type TemplateVars = Record<string, string | number>

export interface EmailTemplateDef {
  id: string
  version: string
  event: string
  requiredVars: string[]
  subject: (v: TemplateVars) => string
  build: (v: TemplateVars) => ShellInput
}

export interface RenderedTemplate {
  subject: string
  html: string
  text: string
}

const s = (v: TemplateVars, key: string): string => String(v[key] ?? '')

/**
 * The full event-to-template catalogue (Step 8). Each entry is a small
 * declarative object, not a hand-authored HTML file -- every one renders
 * through the single shared shell (src/lib/email/templates/shared.ts).
 * `id` is stable and never reused for a different meaning; bumping
 * `version` (not editing an id's wording in place) is how a template
 * changes without breaking delivery-record history that references an
 * older version. See docs/TRANSACTIONAL_EMAILS.md for the full
 * event-to-template matrix and the "why not X" notes for events that were
 * deliberately NOT given a separate template to avoid duplication
 * (e.g. booking.returned folded into booking.completed).
 */
export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // ---------------- LISTING / MERCHANT ----------------
  {
    id: 'listing-submitted-merchant',
    version: '1',
    event: 'listing.submitted',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `Your listing "${s(v, 'listingTitle')}" was submitted for review`,
    build: (v) => ({
      preheader: `We're reviewing "${s(v, 'listingTitle')}"`,
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `Your listing "${s(v, 'listingTitle')}" has been submitted for review. A Unity administrator will review it shortly.`,
        `We'll email you as soon as a decision is made.`,
      ],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-changes-requested-merchant',
    version: '1',
    event: 'listing.changes_requested',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `Changes requested on "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A Unity administrator asked for changes to your listing',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `A Unity administrator reviewed "${s(v, 'listingTitle')}" and requested changes before it can go live:`,
        s(v, 'feedback'),
        `Update your listing and resubmit it for review.`,
      ],
      cta: { label: 'Edit your listing', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-ownership-approved-merchant',
    version: '1',
    event: 'listing.ownership_approved',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `Ownership evidence approved for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your ownership evidence was approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The ownership evidence you submitted for "${s(v, 'listingTitle')}" has been reviewed and approved.`],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-ownership-rejected-merchant',
    version: '1',
    event: 'listing.ownership_rejected',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `Ownership evidence needs attention for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your ownership evidence was not approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `The ownership evidence you submitted for "${s(v, 'listingTitle')}" was not approved:`,
        s(v, 'feedback'),
      ],
      cta: { label: 'Review and resubmit', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-moderation-approved-merchant',
    version: '1',
    event: 'listing.moderation_approved',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `"${s(v, 'listingTitle')}" passed moderation`,
    build: (v) => ({
      preheader: 'Your listing passed moderation review',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [
        `"${s(v, 'listingTitle')}" has passed Unity's moderation review. It will go live once activated.`,
      ],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-moderation-rejected-merchant',
    version: '1',
    event: 'listing.moderation_rejected',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `"${s(v, 'listingTitle')}" was not approved`,
    build: (v) => ({
      preheader: 'Your listing was not approved',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" was reviewed and not approved:`, s(v, 'feedback')],
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-activated-merchant',
    version: '1',
    event: 'listing.activated',
    requiredVars: ['merchantName', 'listingTitle'],
    subject: (v) => `"${s(v, 'listingTitle')}" is now live`,
    build: (v) => ({
      preheader: 'Your listing is live on Unity',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" is now live and visible to renters on Unity.`],
      cta: { label: 'View your listing', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'listing-suspended-merchant',
    version: '1',
    event: 'listing.suspended',
    requiredVars: ['merchantName', 'listingTitle', 'feedback'],
    subject: (v) => `"${s(v, 'listingTitle')}" has been suspended`,
    build: (v) => ({
      preheader: 'Your listing has been suspended',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" has been suspended and is no longer visible to renters:`, s(v, 'feedback')],
      cta: { label: 'Contact support', path: '/contact' },
    }),
  },

  // ---------------- IDENTITY VERIFICATION ----------------
  {
    id: 'verification-submitted-user',
    version: '1',
    event: 'verification.submitted',
    requiredVars: ['userName'],
    subject: () => 'Your identity verification was submitted',
    build: (v) => ({
      preheader: 'We received your verification submission',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [
        'Your identity verification has been submitted and is being reviewed by a Unity administrator (manual test verification).',
        "We'll email you as soon as a decision is made.",
      ],
      cta: { label: 'Check your status', path: '/verify' },
    }),
  },
  {
    id: 'verification-info-requested-user',
    version: '1',
    event: 'verification.additional_information_requested',
    requiredVars: ['userName', 'feedback'],
    subject: () => 'More information needed for your verification',
    build: (v) => ({
      preheader: 'A Unity administrator needs more information from you',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [`A Unity administrator reviewed your verification and needs more information:`, s(v, 'feedback')],
      cta: { label: 'Update your submission', path: '/verify' },
    }),
  },
  {
    id: 'verification-approved-user',
    version: '1',
    event: 'verification.approved',
    requiredVars: ['userName'],
    subject: () => 'Your identity has been verified',
    build: (v) => ({
      preheader: 'Your identity verification was approved',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [
        'Your identity verification has been approved. You can now book items and list your own on Unity.',
        '"Approved" means the stated Unity review was completed based on the evidence you submitted.',
      ],
      cta: { label: 'Go to Unity', path: '/' },
    }),
  },
  {
    id: 'verification-rejected-user',
    version: '1',
    event: 'verification.rejected',
    requiredVars: ['userName', 'feedback'],
    subject: () => 'Your identity verification was not approved',
    build: (v) => ({
      preheader: 'Your identity verification was not approved',
      greeting: `Hi ${s(v, 'userName')},`,
      bodyParagraphs: [`Your identity verification was reviewed and not approved:`, s(v, 'feedback')],
      cta: { label: 'Resubmit your verification', path: '/verify' },
    }),
  },

  // ---------------- BOOKINGS ----------------
  {
    id: 'booking-requested-renter',
    version: '1',
    event: 'booking.requested',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" was sent`,
    build: (v) => ({
      preheader: 'Your booking request was sent to the merchant',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" has been sent. The merchant needs to accept it before it's confirmed.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
  },
  {
    id: 'booking-request-received-merchant',
    version: '1',
    event: 'booking.requested',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference', 'renterName'],
    subject: (v) => `New booking request for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'You have a new booking request',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`${s(v, 'renterName')} requested to book "${s(v, 'listingTitle')}". Accept or decline the request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Review request', path: '/dashboard/merchant/bookings' },
    }),
  },
  {
    id: 'booking-rejected-renter',
    version: '1',
    event: 'booking.rejected',
    requiredVars: ['renterName', 'listingTitle'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" was declined`,
    build: (v) => ({
      preheader: 'Your booking request was declined',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" was declined by the merchant.`],
      cta: { label: 'Browse other listings', path: '/listings' },
    }),
  },
  {
    id: 'booking-cancelled-renter',
    version: '1',
    event: 'booking.cancelled',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking has been cancelled',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" has been cancelled.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
  },
  {
    id: 'booking-cancelled-merchant',
    version: '1',
    event: 'booking.cancelled',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking has been cancelled',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`A booking for "${s(v, 'listingTitle')}" has been cancelled. The dates are available again.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
  },
  {
    id: 'booking-expired-unanswered-renter',
    version: '1',
    event: 'booking.expired_unanswered',
    requiredVars: ['renterName', 'listingTitle'],
    subject: (v) => `Your booking request for "${s(v, 'listingTitle')}" expired`,
    build: (v) => ({
      preheader: 'Your booking request went unanswered and has expired',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your request to book "${s(v, 'listingTitle')}" went unanswered and has expired. You're welcome to try requesting again.`],
      cta: { label: 'Browse listings', path: '/listings' },
    }),
  },
  {
    id: 'booking-payment-required-renter',
    version: '1',
    event: 'booking.payment_required',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference', 'paymentDueAt', 'totalAmount'],
    subject: (v) => `Payment required for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Complete payment to secure your booking',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" is accepted. Complete payment by the deadline below or the booking will expire.`],
      summary: {
        title: 'Payment due',
        rows: [
          { label: 'Reference', value: s(v, 'bookingReference') },
          { label: 'Total', value: s(v, 'totalAmount') },
          { label: 'Deadline', value: s(v, 'paymentDueAt') },
        ],
      },
      cta: { label: 'Complete checkout', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'booking-payment-reminder-renter',
    version: '1',
    event: 'booking.payment_reminder',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference', 'paymentDueAt'],
    subject: (v) => `Reminder: payment due soon for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment deadline is approaching',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`This is a reminder that payment for "${s(v, 'listingTitle')}" is due soon. Complete checkout before the deadline or the booking will expire.`],
      summary: {
        title: 'Payment due',
        rows: [
          { label: 'Reference', value: s(v, 'bookingReference') },
          { label: 'Deadline', value: s(v, 'paymentDueAt') },
        ],
      },
      cta: { label: 'Complete checkout', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'booking-payment-expired-renter',
    version: '1',
    event: 'booking.payment_expired',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking expired: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your booking expired because payment was not completed in time',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your booking for "${s(v, 'listingTitle')}" expired because payment was not completed before the deadline. If you still want to rent this item, please make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Browse listings', path: '/listings' },
    }),
  },
  {
    id: 'booking-payment-expired-merchant',
    version: '1',
    event: 'booking.payment_expired',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking expired unpaid: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A booking expired because the renter did not pay in time',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`A booking for "${s(v, 'listingTitle')}" expired because the renter did not complete payment in time. The dates are available again.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'booking-financially-ready-renter',
    version: '1',
    event: 'booking.financially_ready',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `You're all set for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Payment complete — your booking is ready',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Payment for "${s(v, 'listingTitle')}" is complete. Your booking is financially ready — coordinate handover with the merchant when your rental period begins.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'booking-financially-ready-merchant',
    version: '1',
    event: 'booking.financially_ready',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The renter has completed payment',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The renter's payment for "${s(v, 'listingTitle')}" is complete. Coordinate handover when the rental period begins.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'booking-started-renter',
    version: '1',
    event: 'booking.started',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Your rental has started: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental period has begun',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental of "${s(v, 'listingTitle')}" has started. Enjoy — and remember to return it in the condition you received it.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
    }),
  },
  {
    id: 'booking-started-merchant',
    version: '1',
    event: 'booking.started',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Rental started: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The rental period has begun',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The rental of "${s(v, 'listingTitle')}" has started.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
  },
  {
    id: 'booking-return-initiated-notify',
    version: '1',
    event: 'booking.return_initiated',
    requiredVars: ['recipientName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Return initiated for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A return has been initiated on your booking',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A return has been initiated for "${s(v, 'listingTitle')}". Please confirm once you've verified the item.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Confirm return', path: '/dashboard/renter/bookings' },
    }),
  },
  {
    id: 'booking-completed-renter',
    version: '1',
    event: 'booking.completed',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking completed: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental is complete — return confirmed',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental of "${s(v, 'listingTitle')}" is complete — the return has been confirmed. Thanks for renting with Unity!`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Leave a review', path: '/dashboard/renter/bookings' },
    }),
  },
  {
    id: 'booking-completed-merchant',
    version: '1',
    event: 'booking.completed',
    requiredVars: ['merchantName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Booking completed: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The rental is complete — return confirmed',
      greeting: `Hi ${s(v, 'merchantName')},`,
      bodyParagraphs: [`The rental of "${s(v, 'listingTitle')}" is complete — the return has been confirmed.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/merchant/bookings' },
    }),
  },

  // ---------------- PAYMENT / TEST MODE ----------------
  {
    id: 'payment-declined-renter',
    version: '1',
    event: 'payment.declined',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment declined for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment was declined',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your payment for "${s(v, 'listingTitle')}" was declined and cannot be retried on this booking. Please contact the merchant or make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'payment-retryable-failure-renter',
    version: '1',
    event: 'payment.retryable_failure',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Payment issue for "${s(v, 'listingTitle')}" — please retry`,
    build: (v) => ({
      preheader: 'A temporary issue stopped your payment',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`A temporary issue stopped your payment for "${s(v, 'listingTitle')}". Please try again before the payment deadline.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'Retry payment', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
  {
    id: 'deposit-failed-renter',
    version: '1',
    event: 'deposit.failed',
    requiredVars: ['renterName', 'listingTitle', 'bookingReference'],
    subject: (v) => `Deposit issue for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your rental payment succeeded but the deposit did not',
      greeting: `Hi ${s(v, 'renterName')},`,
      bodyParagraphs: [`Your rental payment for "${s(v, 'listingTitle')}" succeeded, but the deposit authorization was declined and cannot be retried on this booking. Please contact the merchant or make a new booking request.`],
      summary: { title: 'Booking', rows: [{ label: 'Reference', value: s(v, 'bookingReference') }] },
      cta: { label: 'View your bookings', path: '/dashboard/renter/bookings' },
      testModeNotice: true,
    }),
  },
]

const TEMPLATES_BY_ID = new Map(EMAIL_TEMPLATES.map((t) => [t.id, t]))

export function getEmailTemplate(templateId: string): EmailTemplateDef | undefined {
  return TEMPLATES_BY_ID.get(templateId)
}

export class TemplateValidationError extends Error {
  constructor(templateId: string, missing: string[]) {
    super(`Template "${templateId}" is missing required variables: ${missing.join(', ')}`)
    this.name = 'TemplateValidationError'
  }
}

/** The one entry point every dispatch call renders through. Validates required vars, never silently renders with a blank/undefined field. */
export function renderTemplate(templateId: string, vars: TemplateVars): RenderedTemplate {
  const def = getEmailTemplate(templateId)
  if (!def) {
    throw new TemplateValidationError(templateId, ['(unknown template id)'])
  }
  const missing = def.requiredVars.filter((key) => vars[key] === undefined || vars[key] === null || vars[key] === '')
  if (missing.length > 0) {
    throw new TemplateValidationError(templateId, missing)
  }
  const shellInput = def.build(vars)
  const { html, text } = renderShell(shellInput)
  return { subject: def.subject(vars), html, text }
}
