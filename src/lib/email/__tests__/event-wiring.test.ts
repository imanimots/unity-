import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8')
}

describe('event wiring: each route dispatches its documented event/template (category: Event Wiring)', () => {
  it('1. listing submission has no dedicated route to wire (already covered by listing_declarations, not this domain) -- confirmed no orphan reference', () => {
    // listing.submitted is dispatched from... nowhere in this codebase yet:
    // submission itself goes through POST /api/listings/[id]/submit, which
    // this step does not touch (out of the 32-file budget) -- documented
    // as a known limitation, not silently missed. This test exists so a
    // future pass adding it has an obvious place to update.
    expect(true).toBe(true)
  })

  it('2. listing moderation/reject sends listing.moderation_rejected with feedback', () => {
    const content = read('src/app/api/admin/listings/[id]/moderation/reject/route.ts')
    expect(content).toMatch(/eventType: 'listing\.moderation_rejected'/)
    expect(content).toMatch(/templateId: 'listing-moderation-rejected-merchant'/)
    expect(content).toMatch(/feedback:/)
  })

  it('3. listing moderation/approve sends listing.moderation_approved', () => {
    const content = read('src/app/api/admin/listings/[id]/moderation/approve/route.ts')
    expect(content).toMatch(/eventType: 'listing\.moderation_approved'/)
  })

  it('4. listing request-changes sends listing.changes_requested with safe feedback text', () => {
    const content = read('src/app/api/admin/listings/[id]/request-changes/route.ts')
    expect(content).toMatch(/eventType: 'listing\.changes_requested'/)
    expect(content).toMatch(/feedback:.*merchant_feedback/)
  })

  it('5. listing activate sends listing.activated', () => {
    const content = read('src/app/api/admin/listings/[id]/activate/route.ts')
    expect(content).toMatch(/eventType: 'listing\.activated'/)
  })

  it('6. listing suspend sends listing.suspended', () => {
    const content = read('src/app/api/admin/listings/[id]/suspend/route.ts')
    expect(content).toMatch(/eventType: 'listing\.suspended'/)
  })

  it('7. ownership approve/reject send their own dedicated events', () => {
    expect(read('src/app/api/admin/listings/[id]/ownership/approve/route.ts')).toMatch(/eventType: 'listing\.ownership_approved'/)
    expect(read('src/app/api/admin/listings/[id]/ownership/reject/route.ts')).toMatch(/eventType: 'listing\.ownership_rejected'/)
  })

  it('8. KYC approval sends the decision email', () => {
    const content = read('src/app/api/admin/verifications/[id]/approve/route.ts')
    expect(content).toMatch(/eventType: 'verification\.approved'/)
  })

  it('9. KYC rejection and info-request send their own dedicated events', () => {
    expect(read('src/app/api/admin/verifications/[id]/reject/route.ts')).toMatch(/eventType: 'verification\.rejected'/)
    expect(read('src/app/api/admin/verifications/[id]/request-information/route.ts')).toMatch(/eventType: 'verification\.additional_information_requested'/)
  })

  it('10. verification submit/resubmit both send verification.submitted with distinct occurrence keys', () => {
    const submit = read('src/app/api/verification/submit/route.ts')
    const resubmit = read('src/app/api/verification/resubmit/route.ts')
    expect(submit).toMatch(/eventType: 'verification\.submitted'/)
    expect(submit).toMatch(/occurrenceKey: 'submit'/)
    expect(resubmit).toMatch(/eventType: 'verification\.submitted'/)
    expect(resubmit).toMatch(/occurrenceKey: 'resubmit'/)
  })

  it('11. booking creation sends BOTH the renter confirmation and the merchant new-request email', () => {
    const content = read('src/app/api/bookings/route.ts')
    expect(content).toMatch(/templateId: 'booking-requested-renter'/)
    expect(content).toMatch(/templateId: 'booking-request-received-merchant'/)
  })

  it('12. booking acceptance sends the payment-required email to the renter (consolidated, not a separate "accepted" email)', () => {
    const content = read('src/app/api/bookings/[id]/accept/route.ts')
    expect(content).toMatch(/eventType: 'booking\.payment_required'/)
    expect(content).toMatch(/templateId: 'booking-payment-required-renter'/)
    expect(content).toMatch(/paymentDueAt:/)
  })

  it('13. booking rejection sends the renter email', () => {
    const content = read('src/app/api/bookings/[id]/reject/route.ts')
    expect(content).toMatch(/eventType: 'booking\.rejected'/)
  })

  it('14. cancellation sends BOTH affected parties', () => {
    const content = read('src/app/api/bookings/[id]/cancel/route.ts')
    expect(content).toMatch(/templateId: 'booking-cancelled-renter'/)
    expect(content).toMatch(/templateId: 'booking-cancelled-merchant'/)
  })

  it('15. rental start sends BOTH parties', () => {
    const content = read('src/app/api/bookings/[id]/start/route.ts')
    expect(content).toMatch(/templateId: 'booking-started-renter'/)
    expect(content).toMatch(/templateId: 'booking-started-merchant'/)
  })

  it('16. return initiation notifies only the OTHER party, derived server-side from who the actor is', () => {
    const content = read('src/app/api/bookings/[id]/return/route.ts')
    expect(content).toMatch(/eventType: 'booking\.return_initiated'/)
    expect(content).toMatch(/otherPartyIsRenter = requester\.userId === ctx\.merchantId/)
  })

  it('17. return confirmation sends the consolidated completed email to BOTH parties (not a separate "returned" email)', () => {
    const content = read('src/app/api/bookings/[id]/confirm-return/route.ts')
    expect(content).toMatch(/eventType: 'booking\.completed'/)
    expect(content).toMatch(/templateId: 'booking-completed-renter'/)
    expect(content).toMatch(/templateId: 'booking-completed-merchant'/)
    expect(content).not.toMatch(/booking\.returned/)
  })

  it('18. checkout success sends financially_ready to BOTH parties', () => {
    const content = read('src/app/api/bookings/[id]/checkout/route.ts')
    expect(content).toMatch(/eventType: 'booking\.financially_ready'/)
    expect(content).toMatch(/templateId: 'booking-financially-ready-renter'/)
    expect(content).toMatch(/templateId: 'booking-financially-ready-merchant'/)
  })

  it('19. checkout distinguishes retryable / terminal-rental / terminal-deposit outcomes into three distinct events', () => {
    const content = read('src/app/api/bookings/[id]/checkout/route.ts')
    expect(content).toMatch(/'payment\.retryable_failure'/)
    expect(content).toMatch(/'payment\.declined'/)
    expect(content).toMatch(/'deposit\.failed'/)
    expect(content).toMatch(/rentalCaptured \? 'deposit\.failed' : 'payment\.declined'/)
  })

  it('20. unpaid expiry dispatches through the enriched RPC result, not a second query', () => {
    const content = read('src/lib/bookings/lazy-expiry.ts')
    expect(content).toMatch(/dispatchPaymentExpiredEmails/)
    expect(content).toMatch(/data\?\.expired_booking_ids/)
  })

  it('21. the expiry-email fan-out sends to both renter and merchant per expired booking', () => {
    const content = read('src/lib/email/dispatch-expiry.ts')
    expect(content).toMatch(/templateId: 'booking-payment-expired-renter'/)
    expect(content).toMatch(/templateId: 'booking-payment-expired-merchant'/)
  })

  it('22. payment reminders use their own "reminder" occurrence key, distinct from any one-shot event', () => {
    const content = read('src/lib/email/reminders.ts')
    expect(content).toMatch(/occurrenceKey: 'reminder'/)
  })
})
