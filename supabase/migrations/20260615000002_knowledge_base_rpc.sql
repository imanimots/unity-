-- RPC function for vector similarity search
-- Called by /api/assistant/search when embeddings are available
create or replace function match_knowledge_base(
  query_embedding vector(1536),
  match_threshold  float   default 0.7,
  match_count      int     default 3
)
returns table (
  id       uuid,
  content  text,
  title    text,
  category text,
  similarity float
)
language sql stable
as $$
  select
    id,
    content,
    title,
    category,
    1 - (embedding <=> query_embedding) as similarity
  from public.knowledge_base
  where embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
