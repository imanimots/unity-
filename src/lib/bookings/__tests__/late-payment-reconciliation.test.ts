import { describe, it, expect, vi } from 'vitest'
import { checkAndRecordLateSuccessIfExpired } from '../late-payment-reconciliation'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeAdmin(bookingResult: { status: string; payment_expired_at: string | null } | null) {
  const rpc = vi.fn().mockResolvedValue({ data: { booking_id: 'x', recorded: true }, error: null })
  const maybeSingle = vi.fn().mockResolvedValue({ data: bookingResult })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { from, rpc } as unknown as SupabaseClient
}

describe('checkAndRecordLateSuccessIfExpired (category: Late Events)', () => {
  it('1. reports no late success when the booking cannot be found', async () => {
    const admin = fakeAdmin(null)
    const result = await checkAndRecordLateSuccessIfExpired(admin, 'booking-1')
    expect(result.lateSuccess).toBe(false)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('2. reports no late success when the booking is not expired', async () => {
    const admin = fakeAdmin({ status: 'accepted', payment_expired_at: null })
    const result = await checkAndRecordLateSuccessIfExpired(admin, 'booking-1')
    expect(result.lateSuccess).toBe(false)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('3. reports no late success for an "expired" booking whose expiry is the unrelated stale-request expiry (payment_expired_at is null)', async () => {
    const admin = fakeAdmin({ status: 'expired', payment_expired_at: null })
    const result = await checkAndRecordLateSuccessIfExpired(admin, 'booking-1')
    expect(result.lateSuccess).toBe(false)
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('4. reports a late success and records the reconciliation marker for a payment-expired booking', async () => {
    const admin = fakeAdmin({ status: 'expired', payment_expired_at: '2026-01-01T00:00:00Z' })
    const result = await checkAndRecordLateSuccessIfExpired(admin, 'booking-1')
    expect(result.lateSuccess).toBe(true)
    expect(admin.rpc).toHaveBeenCalledWith('record_late_payment_reconciliation', expect.objectContaining({ p_booking_id: 'booking-1' }))
  })
})
