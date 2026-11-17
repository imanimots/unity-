import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// E48 Risk 3 -- admin Knowledge Base update/delete now persist to the
// real public.knowledge_base table.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
vi.mock('@/lib/admin/route-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/route-helpers')>('@/lib/admin/route-helpers')
  return { ...actual, requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args) }
})

const generateEmbedding = vi.fn()
vi.mock('@/lib/assistant/embedding', () => ({ generateEmbedding: (...args: unknown[]) => generateEmbedding(...args) }))

interface FakeTableConfig { data: unknown; error?: unknown }

function makeFakeAdmin(tables: Record<string, FakeTableConfig> = {}) {
  const updateCalls: unknown[] = []
  const deleteCalls: string[] = []
  function makeChain(resolved: FakeTableConfig, opts: { onUpdate?: (p: unknown) => void; onDeleteEq?: (v: string) => void; isDelete?: boolean } = {}) {
    const value = { data: resolved.data ?? null, error: resolved.error ?? null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      update: (payload: unknown) => {
        opts.onUpdate?.(payload)
        return chain
      },
      delete: () => {
        chain.__isDelete = true
        return chain
      },
      eq: (_col: string, val: string) => {
        if (chain.__isDelete) opts.onDeleteEq?.(val)
        return chain
      },
      maybeSingle: () => Promise.resolve(value),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(value).then(resolve, reject),
    }
    return chain
  }
  const from = vi.fn((table: string) =>
    makeChain(tables[table] ?? { data: null, error: null }, {
      onUpdate: (p) => updateCalls.push(p),
      onDeleteEq: (v) => deleteCalls.push(v),
    })
  )
  return { from, updateCalls, deleteCalls }
}

let nextAdmin: ReturnType<typeof makeFakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { PATCH, DELETE } = await import('../route')

const ADMIN_ID = '11111111-1111-4111-a111-111111111111'
const ENTRY_ID = '22222222-2222-4222-a222-222222222222'

function patchReq(body: unknown) {
  return new NextRequest(`http://localhost/api/admin/knowledge-base/${ENTRY_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function deleteReq() {
  return new NextRequest(`http://localhost/api/admin/knowledge-base/${ENTRY_ID}`, { method: 'DELETE' })
}
const params = () => Promise.resolve({ id: ENTRY_ID })

beforeEach(() => {
  requireAdminForRoute.mockReset()
  requireAdminForRoute.mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID } })
  generateEmbedding.mockReset()
  generateEmbedding.mockResolvedValue(null)
})

describe('PATCH /api/admin/knowledge-base/[id]', () => {
  it('rejects a non-admin caller', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    nextAdmin = makeFakeAdmin()

    const res = await PATCH(patchReq({ content: 'New text' }), { params: params() })
    expect(res.status).toBe(401)
  })

  it('persists the edit -- survives being re-fetched afterward', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: { id: ENTRY_ID, title: 'Edited', category: 'faq', content: 'Edited content', created_at: '2026-02-01T00:00:00Z' } },
    })

    const res = await PATCH(patchReq({ title: 'Edited', content: 'Edited content' }), { params: params() })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry.content).toBe('Edited content')
    expect(nextAdmin.updateCalls[0]).toMatchObject({ title: 'Edited', content: 'Edited content' })
  })

  it('re-embeds when content changes', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: { id: ENTRY_ID, title: 'x', category: 'faq', content: 'changed', created_at: '2026-02-01T00:00:00Z' } },
    })
    await PATCH(patchReq({ content: 'changed' }), { params: params() })
    expect(generateEmbedding).toHaveBeenCalledWith('changed')
  })

  it('does not touch embedding when only the category changes', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: { id: ENTRY_ID, title: 'x', category: 'policy', content: 'same', created_at: '2026-02-01T00:00:00Z' } },
    })
    await PATCH(patchReq({ category: 'policy' }), { params: params() })
    expect(generateEmbedding).not.toHaveBeenCalled()
    expect(nextAdmin.updateCalls[0]).not.toHaveProperty('embedding')
  })

  it('404s when the entry does not exist', async () => {
    nextAdmin = makeFakeAdmin({ knowledge_base: { data: null } })
    const res = await PATCH(patchReq({ content: 'x' }), { params: params() })
    expect(res.status).toBe(404)
  })

  it('rejects an invalid id before querying anything', async () => {
    nextAdmin = makeFakeAdmin()
    const res = await PATCH(patchReq({ content: 'x' }), { params: Promise.resolve({ id: 'not-a-uuid' }) })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/admin/knowledge-base/[id]', () => {
  it('rejects a non-admin caller', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    nextAdmin = makeFakeAdmin()

    const res = await DELETE(deleteReq(), { params: params() })
    expect(res.status).toBe(401)
  })

  it('deletes the correct row by id', async () => {
    nextAdmin = makeFakeAdmin({ knowledge_base: { data: null, error: null } })
    const res = await DELETE(deleteReq(), { params: params() })
    expect(res.status).toBe(200)
    expect(nextAdmin.deleteCalls).toContain(ENTRY_ID)
  })
})
