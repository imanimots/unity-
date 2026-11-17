/**
 * Shared by both the assistant's /api/assistant/embed route and the admin
 * Knowledge Base CRUD routes (E48 Risk 3) -- every writer of
 * public.knowledge_base generates embeddings the same way, so a newly
 * admin-authored entry is just as searchable by the assistant as a
 * seeded one.
 *
 * Anthropic recommends Voyage AI (https://www.voyageai.com) -- set
 * VOYAGE_API_KEY. Without it, content is stored with a null embedding
 * and the table's full-text index is used as a fallback instead (see
 * match_knowledge_base's threshold/ordering and the content_fts index).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
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
