import { describe, it, expect, vi } from 'vitest'
import { listAdminUsers } from '../users-service'

function chainable(result: { data?: unknown; error?: unknown }) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    or: () => obj,
    order: () => obj,
    limit: () => obj,
    in: () => obj,
    then: (resolve: (v: typeof result) => void) => resolve(result),
  }
  return obj
}

const UUID = '11111111-1111-1111-1111-111111111111'

describe('users-service: listAdminUsers search targets (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. a UUID-shaped search term does an exact id match, not a name/phone substring search', async () => {
    const eqSpy = vi.fn()
    const orSpy = vi.fn()
    const admin = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              eq: (col: string, val: string) => {
                eqSpy(col, val)
                return chainable({ data: [], error: null })
              },
              or: (clause: string) => {
                orSpy(clause)
                return chainable({ data: [], error: null })
              },
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminUsers(admin, { search: UUID })
    expect(eqSpy).toHaveBeenCalledWith('id', UUID)
    expect(orSpy).not.toHaveBeenCalled()
  })

  it('2. a non-UUID search term searches name and phone -- never email (profiles has no email column)', async () => {
    const orSpy = vi.fn()
    const admin = {
      from: () => ({
        select: () => ({
          order: () => ({
            limit: () => ({
              eq: () => chainable({ data: [], error: null }),
              or: (clause: string) => {
                orSpy(clause)
                return chainable({ data: [], error: null })
              },
            }),
          }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
    await listAdminUsers(admin, { search: '082' })
    expect(orSpy).toHaveBeenCalledTimes(1)
    const clause = orSpy.mock.calls[0][0] as string
    expect(clause).toContain('full_name.ilike')
    expect(clause).toContain('display_name.ilike')
    expect(clause).toContain('phone.ilike')
    expect(clause).not.toContain('email')
  })
})
