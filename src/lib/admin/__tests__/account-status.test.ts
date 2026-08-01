import { describe, it, expect } from 'vitest'
import { blocksCreation, blocksNewTransactions, blockIfCannotCreate, blockIfCannotTransact, accountStatusErrorResponse } from '../account-status'

describe('account-status: restricted behavior (category: Users)', () => {
  it('1. restricted blocks creation', () => {
    expect(blocksCreation('restricted')).toBe(true)
  })
  it('2. suspended blocks creation', () => {
    expect(blocksCreation('suspended')).toBe(true)
  })
  it('3. active does not block creation', () => {
    expect(blocksCreation('active')).toBe(false)
  })
  it('4. restricted does NOT block new transactions (existing obligations remain actionable)', () => {
    expect(blocksNewTransactions('restricted')).toBe(false)
  })
  it('5. suspended blocks new transactions', () => {
    expect(blocksNewTransactions('suspended')).toBe(true)
  })
  it('6. blockIfCannotCreate returns null for an active profile', () => {
    expect(blockIfCannotCreate({ account_status: 'active' })).toBeNull()
  })
  it('7. blockIfCannotCreate returns a 403 for a restricted profile', async () => {
    const res = blockIfCannotCreate({ account_status: 'restricted' })
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })
  it('8. blockIfCannotTransact returns null for a restricted profile (only suspended blocks transactions)', () => {
    expect(blockIfCannotTransact({ account_status: 'restricted' })).toBeNull()
  })
  it('9. blockIfCannotTransact returns a 403 for a suspended profile', () => {
    const res = blockIfCannotTransact({ account_status: 'suspended' })
    expect(res).not.toBeNull()
    expect(res?.status).toBe(403)
  })
  it('10. error response bodies never leak internal state, only a user-safe message', async () => {
    const res = accountStatusErrorResponse('suspended')
    const body = await res.json()
    expect(body.error).toMatch(/suspended/i)
    expect(body.error).not.toMatch(/profiles|sql|database/i)
  })
})
