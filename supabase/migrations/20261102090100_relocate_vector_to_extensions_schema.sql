-- E14: relocate pgvector out of the exposed public schema.
-- Existing vector columns and indexes retain their underlying type/opclass
-- OIDs. The only schema-sensitive project object is match_knowledge_base,
-- whose vector type and cosine-distance operator are explicitly qualified.
alter extension vector set schema extensions;

-- RPC function for vector similarity search
-- Called by /api/assistant/search when embeddings are available
create or replace function public.match_knowledge_base(
  query_embedding extensions.vector(1536),
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
set search_path = ''
as $$
  select
    id,
    content,
    title,
    category,
    1 - (embedding operator(extensions.<=>) query_embedding) as similarity
  from public.knowledge_base
  where embedding is not null
    and 1 - (embedding operator(extensions.<=>) query_embedding) > match_threshold
  order by embedding operator(extensions.<=>) query_embedding
  limit match_count;
$$;
