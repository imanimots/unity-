import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdminForRoute, getAdminServiceClient, isValidUuid } from '@/lib/admin/route-helpers'
import { generateEmbedding } from '@/lib/assistant/embedding'

interface KnowledgeBaseRow {
  id: string
  title: string | null
  category: string
  content: string
  created_at: string
}

interface RouteParams {
  params: Promise<{ id: string }>
}

const updateSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  category: z.string().trim().min(1).max(64).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
})

/** PATCH /api/admin/knowledge-base/[id] -- edit survives refresh; content changes are re-embedded so search quality never silently degrades after an edit. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: 'Invalid entry id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:knowledge-base:update')
  if (!gate.ok) return gate.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', fieldErrors: parsed.error.flatten().fieldErrors }, { status: 400 })
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Knowledge base storage is not configured' }, { status: 503 })
  }

  const updates: Record<string, unknown> = {}
  if (parsed.data.title !== undefined) updates.title = parsed.data.title
  if (parsed.data.category !== undefined) updates.category = parsed.data.category
  if (parsed.data.content !== undefined) {
    updates.content = parsed.data.content
    const embedding = await generateEmbedding(parsed.data.content)
    updates.embedding = embedding ? JSON.stringify(embedding) : null
  }

  const { data, error } = await admin
    .from('knowledge_base')
    .update(updates)
    .eq('id', id)
    .select('id, title, category, content, created_at')
    .maybeSingle()

  if (error) {
    console.error('[admin.knowledge-base.update] error', { id, error })
    return NextResponse.json({ error: 'Could not update knowledge base entry' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  return NextResponse.json({ entry: data as KnowledgeBaseRow })
}

/** DELETE /api/admin/knowledge-base/[id] -- delete survives refresh. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  if (!isValidUuid(id)) {
    return NextResponse.json({ error: 'Invalid entry id' }, { status: 400 })
  }

  const gate = await requireAdminForRoute(request, 'admin:knowledge-base:delete')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Knowledge base storage is not configured' }, { status: 503 })
  }

  const { error } = await admin.from('knowledge_base').delete().eq('id', id)

  if (error) {
    console.error('[admin.knowledge-base.delete] error', { id, error })
    return NextResponse.json({ error: 'Could not delete knowledge base entry' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
