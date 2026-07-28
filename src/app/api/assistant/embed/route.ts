import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { KNOWLEDGE_BASE_ENTRIES } from '@/lib/assistant/seed-data'
import { requireAdmin } from '@/lib/supabase/require-admin'
import { checkRateLimit, getClientKey } from '@/lib/rate-limit'

const bodySchema = z.object({
  text: z.string().min(1).max(20_000).optional(),
  category: z.string().max(64).optional(),
  title: z.string().max(200).optional(),
  seed: z.boolean().optional(),
})

// Embeddings require a vector embedding model.
// Anthropic recommends Voyage AI (https://www.voyageai.com) — set VOYAGE_API_KEY.
// Without it, content is stored with a null embedding and text search is used instead.
async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: [text], model: 'voyage-3-lite' }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.data?.[0]?.embedding ?? null
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 })
  }

  const rate = checkRateLimit(`embed:${getClientKey(request)}`, 10, 60_000)
  if (!rate.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  // Writes the knowledge base that drives the AI assistant's answers —
  // admin-only, not a public endpoint.
  const adminAuth = await requireAdmin()
  if (!adminAuth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid fields', issues: parsed.error.issues }, { status: 400 })
  }
  const body = parsed.data

  const admin = createClient(url, serviceKey)

  // Seed mode: insert all knowledge base entries
  if (body.seed) {
    const results = []
    for (const entry of KNOWLEDGE_BASE_ENTRIES) {
      const embedding = await generateEmbedding(entry.content)
      const { error } = await admin.from('knowledge_base').insert({
        content: entry.content,
        title: entry.title,
        category: entry.category,
        embedding: embedding ? JSON.stringify(embedding) : null,
      })
      results.push({ title: entry.title, ok: !error, error: error?.message })
    }
    const failed = results.filter(r => !r.ok)
    return NextResponse.json({ seeded: results.length, failed: failed.length, errors: failed })
  }

  // Single entry mode
  const { text, category = 'general', title } = body
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })

  const embedding = await generateEmbedding(text)

  const { data, error } = await admin.from('knowledge_base').insert({
    content: text,
    title: title ?? null,
    category,
    embedding: embedding ? JSON.stringify(embedding) : null,
  }).select('id').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ id: data.id, embedded: !!embedding })
}
