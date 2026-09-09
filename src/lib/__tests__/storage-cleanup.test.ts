import { describe, it, expect, vi } from 'vitest'
import { cleanupUnregisteredUpload } from '../storage-cleanup'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeAdmin({
  metadataCount, metadataError, removeError,
}: { metadataCount?: number; metadataError?: unknown; removeError?: unknown }) {
  const eq = vi.fn().mockResolvedValue({ count: metadataCount ?? 0, error: metadataError ?? null })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  const remove = vi.fn().mockResolvedValue({ error: removeError ?? null })
  const storageFrom = vi.fn().mockReturnValue({ remove })
  return { admin: { from, storage: { from: storageFrom } } as unknown as SupabaseClient, from, select, eq, remove, storageFrom }
}

const baseParams = {
  bucket: 'dispute-evidence',
  storagePath: 'dispute-1/uploader-1/random.jpg',
  metadataTable: 'dispute_evidence',
  metadataPathColumn: 'storage_path',
  domain: 'dispute-evidence',
}

describe('cleanupUnregisteredUpload', () => {
  it('A. removes the object when no metadata row references the path', async () => {
    const { admin, remove } = fakeAdmin({ metadataCount: 0 })
    await cleanupUnregisteredUpload({ admin, ...baseParams })
    expect(remove).toHaveBeenCalledWith([baseParams.storagePath])
  })

  it('B. never removes the object when a metadata row already references the path (registered, immutable evidence)', async () => {
    const { admin, remove } = fakeAdmin({ metadataCount: 1 })
    await cleanupUnregisteredUpload({ admin, ...baseParams })
    expect(remove).not.toHaveBeenCalled()
  })

  it('C. queries the exact metadata table/column/path supplied by the caller (never hardcoded, never a different domain)', async () => {
    const { admin, from, select, eq } = fakeAdmin({ metadataCount: 0 })
    await cleanupUnregisteredUpload({ admin, ...baseParams })
    expect(from).toHaveBeenCalledWith('dispute_evidence')
    expect(select).toHaveBeenCalledWith('*', { count: 'exact', head: true })
    expect(eq).toHaveBeenCalledWith('storage_path', baseParams.storagePath)
  })

  it('D. removes from the exact bucket supplied by the caller, never a different one', async () => {
    const { admin, storageFrom } = fakeAdmin({ metadataCount: 0 })
    await cleanupUnregisteredUpload({ admin, ...baseParams, bucket: 'barter-milestone-evidence' })
    expect(storageFrom).toHaveBeenCalledWith('barter-milestone-evidence')
  })

  it('E. fails closed (does not delete) when the metadata existence check itself errors -- cannot prove the path is unregistered', async () => {
    const { admin, remove } = fakeAdmin({ metadataError: { message: 'connection reset' } })
    await cleanupUnregisteredUpload({ admin, ...baseParams })
    expect(remove).not.toHaveBeenCalled()
  })

  it('F. never throws when Storage removal itself fails', async () => {
    const { admin } = fakeAdmin({ metadataCount: 0, removeError: { message: 'network error' } })
    await expect(cleanupUnregisteredUpload({ admin, ...baseParams })).resolves.toBeUndefined()
  })

  it('G. never throws when the metadata client itself throws synchronously/asynchronously', async () => {
    const admin = {
      from: () => { throw new Error('unexpected client failure') },
      storage: { from: vi.fn() },
    } as unknown as SupabaseClient
    await expect(cleanupUnregisteredUpload({ admin, ...baseParams })).resolves.toBeUndefined()
  })
})
