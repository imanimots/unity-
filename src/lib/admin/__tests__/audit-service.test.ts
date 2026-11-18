import { describe, it, expect } from 'vitest'
import { listAdminAuditEntries } from '../audit-service'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Platform improvement programme, Phase 1 item 5: this is the first
 * test for listAdminAuditEntries() -- confirms the new
 * admin_kyc_document_access_log source (the one sensitive-READ log
 * the audit found with no equivalent) is correctly unified alongside
 * the three existing mutation-history sources, not silently dropped.
 */
function fakeAdmin(rows: { table: string; data: unknown[] }[]) {
  const byTable = new Map(rows.map((r) => [r.table, r.data]))
  const client = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        not: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: byTable.get(table) ?? [], error: null }),
      }
      return chain
    },
  }
  return client as unknown as SupabaseClient
}

describe('listAdminAuditEntries', () => {
  it('1. includes a kyc_document_access_log row as a kyc_document_viewed entry', async () => {
    const admin = fakeAdmin([
      { table: 'admin_action_history', data: [] },
      { table: 'identity_verification_history', data: [] },
      { table: 'user_account_history', data: [] },
      {
        table: 'admin_kyc_document_access_log',
        data: [{ id: 'log-1', user_id: 'user-1', document_id: 'doc-1', admin_id: 'admin-1', accessed_at: '2026-01-01T00:00:00.000Z' }],
      },
    ])
    const entries = await listAdminAuditEntries(admin)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: 'log-1',
      actorId: 'admin-1',
      actionType: 'kyc_document_viewed',
      entityType: 'kyc_document_access',
      entityId: 'user-1',
      result: 'document doc-1',
    })
  })

  it('2. merges all four sources and sorts by recency', async () => {
    const admin = fakeAdmin([
      { table: 'admin_action_history', data: [{ id: 'a', listing_id: 'l1', action_type: 'approved', admin_id: 'admin-1', reason_code: null, internal_note: null, previous_status: 'pending', new_status: 'active', created_at: '2026-01-01T00:00:00.000Z' }] },
      { table: 'identity_verification_history', data: [] },
      { table: 'user_account_history', data: [] },
      { table: 'admin_kyc_document_access_log', data: [{ id: 'b', user_id: 'u1', document_id: 'd1', admin_id: 'admin-1', accessed_at: '2026-01-02T00:00:00.000Z' }] },
    ])
    const entries = await listAdminAuditEntries(admin)
    expect(entries.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('3. a document-access entry never carries a safeReason (nothing to say beyond "viewed")', async () => {
    const admin = fakeAdmin([
      { table: 'admin_action_history', data: [] },
      { table: 'identity_verification_history', data: [] },
      { table: 'user_account_history', data: [] },
      { table: 'admin_kyc_document_access_log', data: [{ id: 'b', user_id: 'u1', document_id: 'd1', admin_id: 'admin-1', accessed_at: '2026-01-02T00:00:00.000Z' }] },
    ])
    const entries = await listAdminAuditEntries(admin)
    expect(entries[0].safeReason).toBeNull()
  })
})
