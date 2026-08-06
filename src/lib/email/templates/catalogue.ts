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
  {
    id: 'dispute-opened-raiser',
    version: '1',
    event: 'dispute.opened',
    requiredVars: ['raiserName', 'title', 'transactionReference'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been opened`,
    build: (v) => ({
      preheader: 'Your dispute has been submitted',
      greeting: `Hi ${s(v, 'raiserName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" regarding ${s(v, 'transactionReference')} has been opened. An admin will review it shortly.`],
      cta: { label: 'View your dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-opened-respondent',
    version: '1',
    event: 'dispute.opened',
    requiredVars: ['respondentName', 'raiserName', 'title', 'transactionReference'],
    subject: (v) => `A dispute has been opened regarding ${s(v, 'transactionReference')}`,
    build: (v) => ({
      preheader: 'A dispute has been opened against a transaction you are party to',
      greeting: `Hi ${s(v, 'respondentName')},`,
      bodyParagraphs: [`${s(v, 'raiserName')} has opened a dispute ("${s(v, 'title')}") regarding ${s(v, 'transactionReference')}. An admin will review it shortly.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-evidence-requested',
    version: '1',
    event: 'dispute.evidence_requested',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Evidence requested for your dispute "${s(v, 'title')}"`,
    build: (v) => ({
      preheader: 'An admin has requested more evidence',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `An admin has requested more evidence for the dispute "${s(v, 'title')}".`,
        v.note ? `Note from the admin: ${s(v, 'note')}` : '',
      ].filter(Boolean),
      cta: { label: 'Upload evidence', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-evidence-received',
    version: '1',
    event: 'dispute.evidence_received',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `New evidence was added to dispute "${s(v, 'title')}"`,
    build: (v) => ({
      preheader: 'New evidence was added to your dispute',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`New evidence was added to the dispute "${s(v, 'title')}".`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-under-review',
    version: '1',
    event: 'dispute.under_review',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" is now under review`,
    build: (v) => ({
      preheader: 'An admin is now reviewing your dispute',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" is now under review by an admin.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-resolved',
    version: '1',
    event: 'dispute.resolved',
    requiredVars: ['recipientName', 'title', 'outcomeLabel'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been resolved`,
    build: (v) => ({
      preheader: 'Your dispute has been resolved',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your dispute "${s(v, 'title')}" has been resolved. Outcome: ${s(v, 'outcomeLabel')}.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-closed',
    version: '1',
    event: 'dispute.closed',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been closed`,
    build: (v) => ({
      preheader: 'Your dispute has been closed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The dispute "${s(v, 'title')}" has now been closed.`],
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  {
    id: 'dispute-cancelled',
    version: '1',
    event: 'dispute.cancelled',
    requiredVars: ['recipientName', 'title'],
    subject: (v) => `Your dispute "${s(v, 'title')}" has been cancelled`,
    build: (v) => ({
      preheader: 'Your dispute has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `The dispute "${s(v, 'title')}" has been cancelled by an admin.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      cta: { label: 'View the dispute', path: '/dashboard/disputes' },
    }),
  },
  // ---------------- BARTER (Step 11 Phase 4) ----------------
  {
    id: 'barter-accepted',
    version: '1',
    event: 'barter.accepted',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade for "${s(v, 'listingTitle')}" has been accepted`,
    build: (v) => ({
      preheader: 'Your barter trade has been accepted',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" has been accepted. If a deposit or cash adjustment is required, complete it to move the trade forward.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
  },
  {
    id: 'barter-deposit-required',
    version: '1',
    event: 'barter.deposit_required',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `A deposit is required for your trade ${s(v, 'agreementReference')}`,
    build: (v) => ({
      preheader: 'A deposit is required to move your trade forward',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A deposit is required from you before your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" can proceed.`],
      cta: { label: 'Pay your deposit', path: '/dashboard/barter' },
    }),
  },
  {
    id: 'barter-ready-to-exchange',
    version: '1',
    event: 'barter.ready_to_exchange',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} is ready to proceed`,
    build: (v) => ({
      preheader: 'All required payments are complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`All required payments for your trade ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") are complete. You can now proceed with the exchange.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
  },
  {
    id: 'barter-completion-requested',
    version: '1',
    event: 'barter.completion_requested',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Please confirm your trade ${s(v, 'agreementReference')} is complete`,
    build: (v) => ({
      preheader: 'The other party has confirmed the exchange is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The other party has confirmed the exchange for trade ${s(v, 'agreementReference')} ("${s(v, 'listingTitle')}") is complete. Please confirm on your side too to finish the trade.`],
      cta: { label: 'Confirm completion', path: '/dashboard/barter' },
    }),
  },
  {
    id: 'barter-completed',
    version: '1',
    event: 'barter.completed',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} is complete`,
    build: (v) => ({
      preheader: 'Your barter trade is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" is now complete. Any deposits have been released.`],
      cta: { label: 'View your trade', path: '/dashboard/barter' },
    }),
  },
  {
    id: 'barter-cancelled',
    version: '1',
    event: 'barter.cancelled',
    requiredVars: ['recipientName', 'agreementReference', 'listingTitle'],
    subject: (v) => `Your trade ${s(v, 'agreementReference')} has been cancelled`,
    build: (v) => ({
      preheader: 'Your barter trade has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your trade ${s(v, 'agreementReference')} for "${s(v, 'listingTitle')}" has been cancelled.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      cta: { label: 'View your trades', path: '/dashboard/barter' },
    }),
  },
  // ---------------- ORDERS (Step 11 Phase 6) ----------------
  {
    id: 'order-created-buyer',
    version: '1',
    event: 'order.created',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Your order for "${s(v, 'listingTitle')}" was placed`,
    build: (v) => ({
      preheader: 'Complete payment to secure your order',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your order for "${s(v, 'listingTitle')}" has been placed. Complete payment to secure it.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Pay now', path: '/dashboard/orders' },
    }),
  },
  {
    id: 'order-received-seller',
    version: '1',
    event: 'order.created',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `New order for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'You have a new order awaiting payment',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`A buyer has ordered "${s(v, 'listingTitle')}". We'll notify you once payment is complete.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
    }),
  },
  {
    id: 'order-payment-received-buyer',
    version: '1',
    event: 'order.payment_received',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payment is complete',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your payment for "${s(v, 'listingTitle')}" is complete. The seller will prepare your order for shipment.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/orders' },
      testModeNotice: true,
    }),
  },
  {
    id: 'order-payment-received-seller',
    version: '1',
    event: 'order.payment_received',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Payment received for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The buyer has completed payment',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The buyer's payment for "${s(v, 'listingTitle')}" is complete. Please prepare the item for shipment.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
      testModeNotice: true,
    }),
  },
  {
    id: 'order-shipped-buyer',
    version: '1',
    event: 'order.shipped',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Your order "${s(v, 'listingTitle')}" has shipped`,
    build: (v) => ({
      preheader: 'Your order is on its way',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`"${s(v, 'listingTitle')}" has been marked as shipped. Confirm delivery once you receive it.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/orders' },
    }),
  },
  {
    id: 'order-delivered-buyer',
    version: '1',
    event: 'order.delivered',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order complete: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your order is complete — delivery confirmed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your order for "${s(v, 'listingTitle')}" is complete — delivery has been confirmed. Thanks for buying on Unity!`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Leave a review', path: '/dashboard/orders' },
    }),
  },
  {
    id: 'order-delivered-seller',
    version: '1',
    event: 'order.delivered',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order complete: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'The order is complete — delivery confirmed',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`The order for "${s(v, 'listingTitle')}" is complete — the buyer confirmed delivery.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your orders', path: '/dashboard/merchant/orders' },
    }),
  },
  {
    id: 'order-cancelled-buyer',
    version: '1',
    event: 'order.cancelled',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your order has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Your order for "${s(v, 'listingTitle')}" has been cancelled.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Browse listings', path: '/listings' },
    }),
  },
  {
    id: 'order-cancelled-seller',
    version: '1',
    event: 'order.cancelled',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    subject: (v) => `Order cancelled: "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'An order has been cancelled',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `The order for "${s(v, 'listingTitle')}" has been cancelled. The stock is available again.`,
        v.cancellation_reason ? `Reason: ${s(v, 'cancellation_reason')}` : '',
      ].filter(Boolean),
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'View your listings', path: '/dashboard/merchant/listings' },
    }),
  },
  {
    id: 'order-payment-failed-buyer',
    version: '2',
    event: 'order.payment_failed',
    requiredVars: ['recipientName', 'orderReference', 'listingTitle'],
    // Deliberately not "your payment failed" -- a timeout or a
    // retryable provider error may yet resolve on its own, and this
    // template is shared across all of provider_declined/
    // terminal_provider_error/retryable_provider_error/provider_timeout
    // (see docs/ORDER_ADMINISTRATION.md). "We couldn't complete your
    // payment" is accurate for every one of those cases without implying
    // a definitive, final decline.
    subject: (v) => `We couldn't complete your payment for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: "We couldn't complete your payment",
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`We couldn't complete your payment for "${s(v, 'listingTitle')}". You can try checking out again from your orders page.`],
      summary: { title: 'Order', rows: [{ label: 'Reference', value: s(v, 'orderReference') }] },
      cta: { label: 'Retry payment', path: '/dashboard/orders' },
      testModeNotice: true,
    }),
  },
  // ---------------- AFFILIATES (Step 11 Phase 7) ----------------
  {
    id: 'affiliate-enrolled',
    version: '1',
    event: 'affiliate.enrolled',
    requiredVars: ['recipientName', 'affiliateCode'],
    subject: () => `You're now a Unity affiliate`,
    build: (v) => ({
      preheader: 'Your affiliate code is ready',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `You're now enrolled as a Unity affiliate. Your code is ${s(v, 'affiliateCode')}.`,
        `You can generate a share link for any listing that has affiliates enabled from your affiliate dashboard. Commission is only earned on listings the merchant has specifically enabled — never on barter trades.`,
      ],
      cta: { label: 'Go to your affiliate dashboard', path: '/dashboard/affiliate' },
    }),
  },
  {
    id: 'affiliate-commission-approved',
    version: '1',
    event: 'affiliate.commission_approved',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission approved for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your commission has been approved',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been approved and will be queued for payout.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }, { label: 'Amount', value: s(v, 'commissionAmount') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
  },
  {
    id: 'affiliate-commission-held',
    version: '1',
    event: 'affiliate.commission_held',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission on hold for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A commission has been placed on hold for review',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been placed on hold pending review. We'll email you once it's resolved.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
    }),
  },
  {
    id: 'affiliate-payout-queued',
    version: '1',
    event: 'affiliate.payout_queued',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Payout queued for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your payout has been queued',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been queued for payout.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
  },
  {
    id: 'affiliate-commission-paid',
    version: '1',
    event: 'affiliate.commission_paid',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `Commission paid for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Your commission has been paid',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your ${s(v, 'commissionAmount')} commission for "${s(v, 'listingTitle')}" has been paid.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
  },
  {
    id: 'affiliate-payout-failed',
    version: '1',
    event: 'affiliate.payout_failed',
    requiredVars: ['recipientName', 'listingTitle', 'commissionAmount', 'transactionReference'],
    subject: (v) => `We couldn't process your payout for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: "We couldn't process your payout",
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`We couldn't process your ${s(v, 'commissionAmount')} payout for "${s(v, 'listingTitle')}". Our team will review and retry — no action is needed from you.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
  },
  {
    id: 'affiliate-commission-voided',
    version: '1',
    event: 'affiliate.commission_voided',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'voidReason'],
    subject: (v) => `Commission voided for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'A commission has been voided',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`Your commission for "${s(v, 'listingTitle')}" has been voided. Reason: ${s(v, 'voidReason')}.`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
    }),
  },
  {
    id: 'affiliate-adjustment-created',
    version: '1',
    event: 'affiliate.adjustment_created',
    requiredVars: ['recipientName', 'listingTitle', 'transactionReference', 'adjustmentAmount'],
    subject: (v) => `An adjustment was recorded for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'An adjustment was recorded on your commission',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`An adjustment of ${s(v, 'adjustmentAmount')} was recorded against your commission for "${s(v, 'listingTitle')}".`],
      summary: { title: 'Commission', rows: [{ label: 'Reference', value: s(v, 'transactionReference') }] },
      cta: { label: 'View your commissions', path: '/dashboard/affiliate' },
      testModeNotice: true,
    }),
  },
  {
    id: 'merchant-affiliate-enabled',
    version: '1',
    event: 'merchant.affiliate_enabled',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Affiliates enabled for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Affiliate promotion is now enabled for your listing',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Affiliate promotion is now enabled for "${s(v, 'listingTitle')}". Affiliates can now generate a share link and earn commission on completed eligible sales or rental payments — never on deposits, refunds, or barter trades.`,
      ],
      cta: { label: 'Manage affiliate settings', path: '/dashboard/merchant/affiliates' },
    }),
  },
  {
    id: 'merchant-affiliate-disabled',
    version: '1',
    event: 'merchant.affiliate_disabled',
    requiredVars: ['recipientName', 'listingTitle'],
    subject: (v) => `Affiliates disabled for "${s(v, 'listingTitle')}"`,
    build: (v) => ({
      preheader: 'Affiliate promotion is now disabled for your listing',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [
        `Affiliate promotion is now disabled for "${s(v, 'listingTitle')}". No new affiliate referrals will be accepted for this listing. Commissions already earned before this change are unaffected and continue as normal.`,
      ],
      cta: { label: 'Manage affiliate settings', path: '/dashboard/merchant/affiliates' },
    }),
  },
  // ---------------- MESSAGING (Step 11 Phase 3) ----------------
  {
    id: 'new-message-received',
    version: '1',
    event: 'message.new',
    requiredVars: ['recipientName', 'senderName', 'messagePreview'],
    subject: (v) => `New message from ${s(v, 'senderName')}`,
    build: (v) => ({
      preheader: 'You have a new message on Unity',
      greeting: `Hi ${s(v, 'recipientName')},`,
      bodyParagraphs: [`${s(v, 'senderName')} sent you a message: "${s(v, 'messagePreview')}"`],
      cta: { label: 'Reply on Unity', path: '/chat' },
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
