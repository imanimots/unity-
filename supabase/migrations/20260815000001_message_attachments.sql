-- ============================================================
-- Step 11 Phase 3 -- message_attachments
-- ============================================================
-- Mirrors dispute_evidence's exact shape (table columns, bucket
-- config, path-prefix storage policies -- see
-- 20260814000005_dispute_evidence.sql), generalized to whichever of
-- messages.booking_id/order_id/barter_agreement_id is set (a message
-- attachment has no separate "type" of its own -- it belongs to the
-- transaction its parent message belongs to). No update/delete client
-- policy anywhere -- immutable, append-only, same "no overwrite"
-- requirement as dispute evidence.
--
-- Path convention: {type}/{transaction_id}/{uploader_uid}/{filename},
-- where {type} in ('booking','order','barter') -- the message itself
-- doesn't exist yet at upload time (upload happens before the message
-- row is created), so the path is scoped by the underlying transaction,
-- not by message_id. The storage RLS policies below dispatch on the
-- {type} segment rather than casting it, and always compare
-- id::text = (storage.foldername(name))[N] rather than casting the
-- path segment itself to uuid -- the same pitfall dispute_evidence's
-- storage RLS was written to avoid (a malformed/arbitrary segment cast
-- to uuid throws a hard runtime error instead of just failing the
-- policy).
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.is_message_participant(p_message_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.messages m
    left join public.bookings b on b.id = m.booking_id
    left join public.orders o on o.id = m.order_id
    left join public.barter_agreements ba on ba.id = m.barter_agreement_id
    where m.id = p_message_id
      and (
        b.renter_id = p_user_id or b.merchant_id = p_user_id
        or o.buyer_id = p_user_id or o.seller_id = p_user_id
        or ba.party_a_id = p_user_id or ba.party_b_id = p_user_id
      )
  );
$$;

create table if not exists public.message_attachments (
  id uuid primary key default uuid_generate_v4(),
  message_id uuid not null references public.messages(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  storage_path text not null,
  file_type text not null check (file_type in ('image', 'pdf', 'document')),
  created_at timestamptz not null default now(),
  constraint message_attachments_message_path_uniq unique (message_id, storage_path)
);

create index if not exists message_attachments_message_idx on public.message_attachments(message_id);

alter table public.message_attachments enable row level security;

create policy "message_attachments: parties read"
  on public.message_attachments for select
  using (public.is_message_participant(message_id, auth.uid()));

create policy "message_attachments: admin read"
  on public.message_attachments for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- rows are written only by the
-- API route via a service-role client (same as dispute_evidence).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-attachments', 'chat-attachments', false,
  10485760, -- 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

create policy "storage chat-attachments: participant read"
  on storage.objects for select
  using (
    bucket_id = 'chat-attachments'
    and (
      ((storage.foldername(name))[1] = 'booking' and exists (
        select 1 from public.bookings b
        where b.id::text = (storage.foldername(name))[2]
          and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
      ))
      or ((storage.foldername(name))[1] = 'order' and exists (
        select 1 from public.orders o
        where o.id::text = (storage.foldername(name))[2]
          and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
      ))
      or ((storage.foldername(name))[1] = 'barter' and exists (
        select 1 from public.barter_agreements ba
        where ba.id::text = (storage.foldername(name))[2]
          and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
      ))
    )
  );

create policy "storage chat-attachments: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'chat-attachments'
    and (storage.foldername(name))[3] = auth.uid()::text
    and (
      ((storage.foldername(name))[1] = 'booking' and exists (
        select 1 from public.bookings b
        where b.id::text = (storage.foldername(name))[2]
          and (b.renter_id = auth.uid() or b.merchant_id = auth.uid())
      ))
      or ((storage.foldername(name))[1] = 'order' and exists (
        select 1 from public.orders o
        where o.id::text = (storage.foldername(name))[2]
          and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
      ))
      or ((storage.foldername(name))[1] = 'barter' and exists (
        select 1 from public.barter_agreements ba
        where ba.id::text = (storage.foldername(name))[2]
          and (ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid())
      ))
    )
  );

create policy "storage chat-attachments: admin read"
  on storage.objects for select
  using (
    bucket_id = 'chat-attachments'
    and exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- No delete policy for anyone but service_role, by design (immutable).
