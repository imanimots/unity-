import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { generateEmbedding } from '@/lib/assistant/embedding'

interface KnowledgeBaseRow {
  id: string
  title: string | null
  category: string
  content: string
  created_at: string
}

const createSchema = z.object({
  title: z.string().trim().max(200).optional(),
  category: z.string().trim().min(1).max(64),
  content: z.string().trim().min(1).max(20_000),
})

/**
 * E48 Risk 3 -- admin Knowledge Base CRUD, backed by the real
 * public.knowledge_base table (created in 20260615000001_knowledge_base.sql
 * for the AI assistant's semantic search; previously only ever written to
 * by /api/assistant/embed's seed/single-entry insert, never read back by
 * any admin UI). The admin page previously held entries in local React
 * state only -- this is the fix: real persistence, same table, same
 * embedding pipeline, so an admin-authored entry is just as searchable
 * by the assistant as a seeded one.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:knowledge-base:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Knowledge base storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin
    .from('knowledge_base')
    .select('id, title, category, content, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[admin.knowledge-base.list] error', error)
    return NextResponse.json({ error: 'Could not load knowledge base entries' }, { status: 500 })
  }

  return NextResponse.json({ entries: (data ?? []) as KnowledgeBaseRow[] })
}

export async function POST(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:knowledge-base:create')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Knowledge base storage is not configured' }, { status: 503 })
  }

  const embedding = await generateEmbedding(parsed.data.content)

  const { data, error } = await admin
    .from('knowledge_base')
    .insert({
      title: parsed.data.title ?? null,
      category: parsed.data.category,
      content: parsed.data.content,
      embedding: embedding ? JSON.stringify(embedding) : null,
    })
    .select('id, title, category, content, created_at')
    .single()

  if (error) {
    console.error('[admin.knowledge-base.create] error', error)
    return NextResponse.json({ error: 'Could not create knowledge base entry' }, { status: 500 })
  }

  return NextResponse.json({ entry: data as KnowledgeBaseRow })
}
