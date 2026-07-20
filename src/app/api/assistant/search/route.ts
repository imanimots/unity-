import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

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

  // Return empty in unconfigured mode — chat still works without RAG context
  if (!url || !serviceKey) {
    return NextResponse.json({ results: [] })
  }

  let body: { query?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const { query } = body
  if (!query) return NextResponse.json({ error: 'query is required' }, { status: 400 })

  const admin = createClient(url, serviceKey)

  // Try vector similarity search first
  const embedding = await generateEmbedding(query)
  if (embedding) {
    const { data, error } = await admin.rpc('match_knowledge_base', {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: 3,
    })
    if (!error && data?.length) {
      return NextResponse.json({ results: data.map((r: { content: string }) => r.content) })
    }
  }

  // Fallback: PostgreSQL full-text search
  const terms = query.split(/\s+/).filter(Boolean).join(' & ')
  const { data } = await admin
    .from('knowledge_base')
    .select('content, title')
    .textSearch('content', terms, { type: 'websearch' })
    .limit(3)

  if (data?.length) {
    return NextResponse.json({ results: data.map(r => r.content) })
  }

  // Last resort: ILIKE on any keyword
  const keyword = query.split(/\s+/).slice(0, 2).join('%')
  const { data: likeData } = await admin
    .from('knowledge_base')
    .select('content')
    .ilike('content', `%${keyword}%`)
    .limit(3)

  return NextResponse.json({ results: (likeData ?? []).map(r => r.content) })
}
