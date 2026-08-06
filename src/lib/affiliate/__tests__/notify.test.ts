import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notifyAffiliateOfCommission, notifyMerchantOfAffiliateEvent } from '../notify'

const sendTemplate = vi.fn()
const loadAffiliateCommissionEmailContext = vi.fn()
const loadAffiliateListingEmailContext = vi.fn()

vi.mock('@/lib/email', () => ({
  sendTemplate: (...args: unknown[]) => sendTemplate(...args),
  loadAffiliateCommissionEmailContext: (...args: unknown[]) => loadAffiliateCommissionEmailContext(...args),
  loadAffiliateListingEmailContext: (...args: unknown[]) => loadAffiliateListingEmailContext(...args),
}))

const COMMISSION_CTX = {
  commissionId: 'commission-1',
  listingTitle: 'Vintage Camera',
  affiliateId: 'affiliate-1',
  affiliateName: 'Affiliate One',
  merchantId: 'merchant-1',
  merchantName: 'Merchant One',
  commissionAmount: 80,
  currency: 'ZAR',
  transactionReference: 'OR-ABC12345',
}

const LISTING_CTX = {
  listingId: 'listing-1',
  listingTitle: 'Vintage Camera',
  merchantId: 'merchant-1',
  merchantName: 'Merchant One',
}

const admin = {} as never

describe('notifyAffiliateOfCommission (category: Automation, Emails)', () => {
  beforeEach(() => {
    sendTemplate.mockReset()
    loadAffiliateCommissionEmailContext.mockReset()
    loadAffiliateCommissionEmailContext.mockResolvedValue(COMMISSION_CTX)
  })

  it('1. sends to the commission\'s real affiliate_id, never a caller-supplied id', async () => {
    await notifyAffiliateOfCommission(admin, 'commission-1', 'affiliate.commission_approved', 'affiliate-commission-approved')
    expect(sendTemplate).toHaveBeenCalledWith(admin, expect.objectContaining({ recipientUserId: 'affiliate-1' }))
  })

  it('2. occurrenceKey is deterministic per commission/event/affiliate -- exact replay never double-sends', async () => {
    await notifyAffiliateOfCommission(admin, 'commission-1', 'affiliate.commission_paid', 'affiliate-commission-paid')
    expect(sendTemplate).toHaveBeenCalledWith(admin, expect.objectContaining({ occurrenceKey: 'affiliate-commission-commission-1-affiliate.commission_paid-affiliate-1' }))
  })

  it('3. relatedEntityType is always affiliate_commission', async () => {
    await notifyAffiliateOfCommission(admin, 'commission-1', 'affiliate.commission_held', 'affiliate-commission-held')
    expect(sendTemplate).toHaveBeenCalledWith(admin, expect.objectContaining({ relatedEntityType: 'affiliate_commission', relatedEntityId: 'commission-1' }))
  })

  it('4. extraVars (e.g. voidReason) merge without overwriting resolved identity fields', async () => {
    await notifyAffiliateOfCommission(admin, 'commission-1', 'affiliate.commission_voided', 'affiliate-commission-voided', { voidReason: 'payment refunded' })
    expect(sendTemplate).toHaveBeenCalledWith(
      admin,
      expect.objectContaining({ vars: expect.objectContaining({ recipientName: 'Affiliate One', listingTitle: 'Vintage Camera', voidReason: 'payment refunded' }) })
    )
  })

  it('5. silently skips dispatch when the commission cannot be found', async () => {
    loadAffiliateCommissionEmailContext.mockResolvedValue(null)
    await notifyAffiliateOfCommission(admin, 'missing', 'affiliate.commission_approved', 'affiliate-commission-approved')
    expect(sendTemplate).not.toHaveBeenCalled()
  })
})

describe('notifyMerchantOfAffiliateEvent (category: Merchant Dashboard, Emails)', () => {
  beforeEach(() => {
    sendTemplate.mockReset()
    loadAffiliateListingEmailContext.mockReset()
    loadAffiliateListingEmailContext.mockResolvedValue(LISTING_CTX)
  })

  it('6. sends to the listing\'s real merchant_id', async () => {
    await notifyMerchantOfAffiliateEvent(admin, 'listing-1', 'merchant.affiliate_enabled', 'merchant-affiliate-enabled', 'occurrence-key-1')
    expect(sendTemplate).toHaveBeenCalledWith(admin, expect.objectContaining({ recipientUserId: 'merchant-1' }))
  })

  it('7. a route retry with the SAME caller-supplied occurrence key dedupes -- occurrenceKey is not self-generated per call', async () => {
    await notifyMerchantOfAffiliateEvent(admin, 'listing-1', 'merchant.affiliate_disabled', 'merchant-affiliate-disabled', 'idem-key-A')
    const firstKey = sendTemplate.mock.calls[0][1].occurrenceKey
    sendTemplate.mockReset()
    await notifyMerchantOfAffiliateEvent(admin, 'listing-1', 'merchant.affiliate_disabled', 'merchant-affiliate-disabled', 'idem-key-A')
    const secondKey = sendTemplate.mock.calls[0][1].occurrenceKey
    expect(firstKey).toBe(secondKey)
  })
})
