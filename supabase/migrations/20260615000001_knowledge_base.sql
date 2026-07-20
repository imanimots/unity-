-- Enable pgvector for semantic search
create extension if not exists vector;

create table if not exists public.knowledge_base (
  id         uuid        primary key default gen_random_uuid(),
  content    text        not null,
  embedding  vector(1536),
  category   text        not null default 'general',
  title      text,
  created_at timestamptz not null default now()
);

-- IVFFlat index for fast cosine similarity search
create index if not exists knowledge_base_embedding_idx
  on public.knowledge_base
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Full-text search index (fallback when no embeddings)
create index if not exists knowledge_base_content_fts
  on public.knowledge_base
  using gin (to_tsvector('english', content));

-- RLS: knowledge base is public read, service-role write
alter table public.knowledge_base enable row level security;

create policy "knowledge_base_select"
  on public.knowledge_base for select
  using (true);
