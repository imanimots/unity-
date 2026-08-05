import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notifyOrderParties } from '../notify'

const sendTemplate = vi.fn()
const loadOrderEmailContext = vi.fn()

vi.mock('@/lib/email', () => ({
  sendTemplate: (...args: unknown[]) => sendTemplate(...args),
  loadOrderEmailContext: (...args: unknown[]) => loadOrderEmailContext(...args),
}))

const CTX = {
  orderId: 'order-1',
  orderReference: 'OR-ABC12345',
  listingTitle: 'Vintage Camera',
  buyerId: 'buyer-1',
  buyerName: 'Buyer One',
  sellerId: 'seller-1',
  sellerName: 'Seller One',
  totalAmount: 500,
  currency: 'ZAR',
}

describe('notifyOrderParties (category: Emails)', () => {
  beforeEach(() => {
    sendTemplate.mockReset()
    loadOrderEmailContext.mockReset()
    loadOrderEmailContext.mockResolvedValue(CTX)
  })

  const admin = {} as never

  it('1. resolves a "buyer"-role recipient to the order\'s real buyer_id, never a caller-supplied id', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.created', [{ role: 'buyer', templateId: 'order-created-buyer' }])
    expect(sendTemplate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ recipientUserId: 'buyer-1', templateId: 'order-created-buyer' })
    )
  })

  it('2. resolves a "seller"-role recipient to the order\'s real seller_id', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.created', [{ role: 'seller', templateId: 'order-received-seller' }])
    expect(sendTemplate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ recipientUserId: 'seller-1', templateId: 'order-received-seller' })
    )
  })

  it('3. one eventType, two different templateIds -- event identity and template identity never collapse into one (correction 11)', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.created', [
      { role: 'buyer', templateId: 'order-created-buyer' },
      { role: 'seller', templateId: 'order-received-seller' },
    ])
    expect(sendTemplate).toHaveBeenCalledTimes(2)
    const calls = sendTemplate.mock.calls.map((c) => c[1])
    expect(calls.every((c) => c.eventType === 'order.created')).toBe(true)
    expect(new Set(calls.map((c) => c.templateId))).toEqual(new Set(['order-created-buyer', 'order-received-seller']))
  })

  it('4. occurrenceKey is deterministic per order/event/recipient -- exact route replay never double-sends', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.shipped', [{ role: 'buyer', templateId: 'order-shipped-buyer' }])
    expect(sendTemplate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ occurrenceKey: 'order-order-1-order.shipped-buyer-1' })
    )
  })

  it('5. relatedEntityType is always "order", never a caller-supplied value', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.delivered', [{ role: 'buyer', templateId: 'order-delivered-buyer' }])
    expect(sendTemplate).toHaveBeenCalledWith(admin, expect.objectContaining({ relatedEntityType: 'order', relatedEntityId: 'order-1' }))
  })

  it('6. extraVars (e.g. cancellation_reason) merge into the template vars without overwriting the resolved identity fields', async () => {
    await notifyOrderParties(admin, 'order-1', 'order.cancelled', [{ role: 'buyer', templateId: 'order-cancelled-buyer' }], {
      cancellation_reason: 'changed my mind',
    })
    expect(sendTemplate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({
        vars: expect.objectContaining({ recipientName: 'Buyer One', orderReference: 'OR-ABC12345', cancellation_reason: 'changed my mind' }),
      })
    )
  })

  it('7. silently skips dispatch when the order cannot be found (never fabricates context)', async () => {
    loadOrderEmailContext.mockResolvedValue(null)
    await notifyOrderParties(admin, 'missing-order', 'order.created', [{ role: 'buyer', templateId: 'order-created-buyer' }])
    expect(sendTemplate).not.toHaveBeenCalled()
  })
})
