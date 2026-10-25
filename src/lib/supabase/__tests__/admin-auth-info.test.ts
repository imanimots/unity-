import { describe, it, expect, vi } from 'vitest'
import { getAdminAuthInfo } from '../admin-auth-info'

const USER_ID = '11111111-1111-1111-1111-111111111111'

function fakeAdminClient(getUserById: ReturnType<typeof vi.fn>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { auth: { admin: { getUserById } } } as any
}

describe('admin-auth-info: getAdminAuthInfo (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. a real auth user maps every genuinely-available SDK field, never fabricating anything', async () => {
    const getUserById = vi.fn().mockResolvedValue({
      data: {
        user: {
          id: USER_ID,
          email: 'test@example.com',
          email_confirmed_at: '2026-01-01T00:00:00Z',
          phone: '+27820000000',
          phone_confirmed_at: null,
          last_sign_in_at: '2026-02-01T00:00:00Z',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
          banned_until: null,
          recovery_sent_at: '2026-01-15T00:00:00Z',
          confirmation_sent_at: '2025-01-01T00:00:00Z',
          factors: [
            { id: 'f1', status: 'verified' },
            { id: 'f2', status: 'unverified' },
          ],
        },
      },
      error: null,
    })
    const info = await getAdminAuthInfo(fakeAdminClient(getUserById), USER_ID)
    expect(info).toEqual({
      authUserExists: true,
      email: 'test@example.com',
      emailConfirmedAt: '2026-01-01T00:00:00Z',
      phone: '+27820000000',
      phoneConfirmedAt: null,
      lastSignInAt: '2026-02-01T00:00:00Z',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      bannedUntil: null,
      mfaFactorCount: 2,
      mfaVerifiedFactorCount: 1,
      lastRecoveryEmailSentAt: '2026-01-15T00:00:00Z',
      lastConfirmationEmailSentAt: '2025-01-01T00:00:00Z',
    })
    expect(getUserById).toHaveBeenCalledWith(USER_ID)
  })

  it('2. a user with no MFA factors reports zero counts, not undefined/NaN', async () => {
    const getUserById = vi.fn().mockResolvedValue({
      data: { user: { id: USER_ID, created_at: '2025-01-01T00:00:00Z' } },
      error: null,
    })
    const info = await getAdminAuthInfo(fakeAdminClient(getUserById), USER_ID)
    expect(info?.mfaFactorCount).toBe(0)
    expect(info?.mfaVerifiedFactorCount).toBe(0)
  })

  it('3. a GoTrue error returns null rather than throwing or fabricating a user', async () => {
    const getUserById = vi.fn().mockResolvedValue({ data: { user: null }, error: { message: 'User not found' } })
    const info = await getAdminAuthInfo(fakeAdminClient(getUserById), USER_ID)
    expect(info).toBeNull()
  })

  it('4. a missing user with no error still returns null, never a half-populated object', async () => {
    const getUserById = vi.fn().mockResolvedValue({ data: { user: null }, error: null })
    const info = await getAdminAuthInfo(fakeAdminClient(getUserById), USER_ID)
    expect(info).toBeNull()
  })

  it('5. never exposes a failed-login-count or active-session-list field -- the SDK provides neither', async () => {
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { id: USER_ID, created_at: '2025-01-01T00:00:00Z' } }, error: null })
    const info = await getAdminAuthInfo(fakeAdminClient(getUserById), USER_ID)
    expect(info).not.toHaveProperty('failedLoginAttempts')
    expect(info).not.toHaveProperty('activeSessionList')
  })
})
