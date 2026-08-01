import { describe, it, expect, beforeEach, vi } from 'vitest'
import { sendTemplate, getDeliveryStatus, retryDelivery } from '../service'
import { createFakeEmailAdmin } from './test-helpers'

const BASE_REQUEST = {
  eventType: 'booking.accepted' as const,
  templateId: 'booking-rejected-renter',
  recipientUserId: 'renter-1',
  relatedEntityType: 'booking' as const,
  relatedEntityId: 'booking-1',
  vars: { renterName: 'Sam', listingTitle: 'Camera' },
}

describe('sendTemplate (category: Dispatch)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('1. resolves the recipient email and records it on the delivery row', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const result = await sendTemplate(admin, BASE_REQUEST)
    expect(result.status).toBe('sent')
    expect(getDelivery(result.deliveryId!)?.recipient_email).toBe('sam@example.com')
  })

  it('2. missing recipient email is handled safely -- no throw, delivery recorded as failed_terminal', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: null })
    const result = await sendTemplate(admin, BASE_REQUEST)
    expect(result.status).toBe('skipped_no_recipient_email')
    expect(getDelivery(result.deliveryId!)?.status).toBe('failed_terminal')
  })

  it('3. a successful send is stored with status "sent", a provider name, and a message id', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const result = await sendTemplate(admin, BASE_REQUEST)
    const row = getDelivery(result.deliveryId!)
    expect(row?.status).toBe('sent')
    expect(row?.provider).toBe('console')
    expect(row?.provider_message_id).toBeTruthy()
    expect(row?.sent_at).toBeTruthy()
  })

  it('4. a retryable provider failure is stored as failed_retryable, not terminal', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: 'sam+fail-retryable@example.com' })
    const result = await sendTemplate(admin, BASE_REQUEST)
    expect(result.status).toBe('failed_retryable')
    expect(getDelivery(result.deliveryId!)?.status).toBe('failed_retryable')
  })

  it('5. a terminal provider failure is stored as failed_terminal', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: 'sam+fail-terminal@example.com' })
    const result = await sendTemplate(admin, BASE_REQUEST)
    expect(result.status).toBe('failed_terminal')
    expect(getDelivery(result.deliveryId!)?.status).toBe('failed_terminal')
  })

  it('6. an exact repeat dispatch (same event/entity/recipient/version/occurrence) sends once -- second call is skipped_duplicate', async () => {
    const { admin, deliveryCount } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const first = await sendTemplate(admin, BASE_REQUEST)
    const second = await sendTemplate(admin, BASE_REQUEST)
    expect(first.status).toBe('sent')
    expect(second.status).toBe('skipped_duplicate')
    expect(deliveryCount()).toBe(1)
  })

  it('7. a different occurrenceKey (e.g. a reminder) is not deduped against the original send', async () => {
    const { admin, deliveryCount } = createFakeEmailAdmin({ email: 'sam@example.com' })
    await sendTemplate(admin, BASE_REQUEST)
    await sendTemplate(admin, { ...BASE_REQUEST, occurrenceKey: 'reminder' })
    expect(deliveryCount()).toBe(2)
  })

  it('8. an unknown template id is recorded as failed_terminal, not thrown out of sendTemplate', async () => {
    const { admin, getDelivery } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const result = await sendTemplate(admin, { ...BASE_REQUEST, templateId: 'not-a-real-template' })
    expect(result.status).toBe('failed_terminal')
    expect(getDelivery(result.deliveryId!)?.last_error).toMatch(/missing required variables|Template/)
  })
})

describe('retryDelivery (category: Dispatch)', () => {
  it('9. retrying a delivery that is not failed_retryable is a safe no-op', async () => {
    const { admin } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const sent = await sendTemplate(admin, BASE_REQUEST)
    const retryResult = await retryDelivery(admin, sent.deliveryId!)
    expect(retryResult.status).toBe('skipped_duplicate')
  })

  it('10. retrying a failed_retryable delivery updates the SAME row (no duplicate record) and re-renders from stored template_vars to succeed', async () => {
    const failing = createFakeEmailAdmin({ email: 'sam+fail-retryable@example.com' })
    const first = await sendTemplate(failing.admin, BASE_REQUEST)
    expect(first.status).toBe('failed_retryable')

    // Simulate the underlying address now working by patching the stored recipient_email directly on the fake's row (as retryDelivery reads recipient_email from the row).
    const row = failing.getDelivery(first.deliveryId!)
    if (row) row.recipient_email = 'sam@example.com'

    const retryResult = await retryDelivery(failing.admin, first.deliveryId!)
    expect(retryResult.status).toBe('sent')
    expect(failing.deliveryCount()).toBe(1)
  })
})

describe('getDeliveryStatus (category: Dispatch)', () => {
  it('12. returns a safe summary without exposing last_error or template_vars', async () => {
    const { admin } = createFakeEmailAdmin({ email: 'sam@example.com' })
    const sent = await sendTemplate(admin, BASE_REQUEST)
    const status = await getDeliveryStatus(admin, sent.deliveryId!)
    expect(status).toEqual(
      expect.objectContaining({ id: sent.deliveryId, status: 'sent' })
    )
    expect(status).not.toHaveProperty('last_error')
    expect(status).not.toHaveProperty('template_vars')
  })

  it('13. returns null for an unknown delivery id rather than throwing', async () => {
    const { admin } = createFakeEmailAdmin({ email: 'sam@example.com' })
    expect(await getDeliveryStatus(admin, 'does-not-exist')).toBeNull()
  })
})
