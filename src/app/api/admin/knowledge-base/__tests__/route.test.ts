import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// E48 Risk 3 -- admin Knowledge Base list/create now persist to the real
// public.knowledge_base table instead of local React state.
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
  const insertCalls: unknown[] = []
  function makeChain(resolved: FakeTableConfig, onInsert?: (payload: unknown) => void) {
    const value = { data: resolved.data ?? null, error: resolved.error ?? null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      insert: (payload: unknown) => {
        onInsert?.(payload)
        return chain
      },
      single: () => Promise.resolve(value),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(value).then(resolve, reject),
    }
    return chain
  }
  const from = vi.fn((table: string) => makeChain(tables[table] ?? { data: null, error: null }, (p) => insertCalls.push(p)))
  return { from, insertCalls }
}

let nextAdmin: ReturnType<typeof makeFakeAdmin>
vi.mock('@supabase/supabase-js', () => ({ createClient: () => nextAdmin }))

const { GET, POST } = await import('../route')

const ADMIN_ID = '11111111-1111-4111-a111-111111111111'
const ENTRY_ID = '22222222-2222-4222-a222-222222222222'

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/admin/knowledge-base', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  requireAdminForRoute.mockReset()
  requireAdminForRoute.mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID } })
  generateEmbedding.mockReset()
  generateEmbedding.mockResolvedValue(null)
})

describe('GET /api/admin/knowledge-base', () => {
  it('rejects a non-admin caller before ever touching the table', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'You must be signed in as an administrator' }, { status: 401 }) })
    nextAdmin = makeFakeAdmin()

    const res = await GET(new NextRequest('http://localhost/api/admin/knowledge-base'))
    expect(res.status).toBe(401)
  })

  it('returns the real persisted entries, newest first', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: [{ id: ENTRY_ID, title: 'Returns', category: 'policy', content: 'How returns work.', created_at: '2026-01-01T00:00:00Z' }] },
    })

    const res = await GET(new NextRequest('http://localhost/api/admin/knowledge-base'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].title).toBe('Returns')
  })
})

describe('POST /api/admin/knowledge-base', () => {
  it('rejects a non-admin caller', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    nextAdmin = makeFakeAdmin()

    const res = await POST(postReq({ category: 'faq', content: 'Some content' }))
    expect(res.status).toBe(401)
  })

  it('rejects an empty content field', async () => {
    nextAdmin = makeFakeAdmin()
    const res = await POST(postReq({ category: 'faq', content: '' }))
    expect(res.status).toBe(400)
  })

  it('creates a real row and generates an embedding for it', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: { id: ENTRY_ID, title: 'New FAQ', category: 'faq', content: 'Answer text', created_at: '2026-02-01T00:00:00Z' } },
    })
    generateEmbedding.mockResolvedValue([0.1, 0.2, 0.3])

    const res = await POST(postReq({ title: 'New FAQ', category: 'faq', content: 'Answer text' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.entry.id).toBe(ENTRY_ID)
    expect(generateEmbedding).toHaveBeenCalledWith('Answer text')
    expect(nextAdmin.insertCalls[0]).toMatchObject({ title: 'New FAQ', category: 'faq', content: 'Answer text' })
  })

  it('still persists the entry when no embedding model is configured (null embedding, not a failure)', async () => {
    nextAdmin = makeFakeAdmin({
      knowledge_base: { data: { id: ENTRY_ID, title: 'No embed', category: 'faq', content: 'Text', created_at: '2026-02-01T00:00:00Z' } },
    })
    generateEmbedding.mockResolvedValue(null)

    const res = await POST(postReq({ title: 'No embed', category: 'faq', content: 'Text' }))
    expect(res.status).toBe(200)
    expect(nextAdmin.insertCalls[0]).toMatchObject({ embedding: null })
  })
})
