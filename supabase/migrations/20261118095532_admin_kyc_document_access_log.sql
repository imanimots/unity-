-- Platform improvement programme, Phase 1 item 5 (sensitive data
-- access logging). Audit finding: admin_action_history/
-- identity_verification_history/user_account_history log admin
-- MUTATIONS (approve/reject/status changes) but there was no record of
-- an admin merely VIEWING a KYC document -- the one genuinely sensitive
-- "read" path this codebase has for identity documents
-- (POST /api/admin/verifications/[id]/document-url, the only way to
-- view a submitted KYC document). admin_message_access_log
-- (20260815000002_messages_admin_audit.sql) already established this
-- exact "read access log" pattern for private messages -- this is the
-- same shape applied to the other sensitive-read gap the audit found.
create table if not exists public.admin_kyc_document_access_log (
  id uuid primary key default uuid_generate_v4(),
  admin_id uuid not null references public.profiles(id),
  user_id uuid not null references public.profiles(id),
  document_id uuid not null references public.identity_verification_documents(id),
  accessed_at timestamptz not null default now()
);

create index if not exists admin_kyc_document_access_log_admin_idx on public.admin_kyc_document_access_log(admin_id, accessed_at);
create index if not exists admin_kyc_document_access_log_user_idx on public.admin_kyc_document_access_log(user_id, accessed_at);

alter table public.admin_kyc_document_access_log enable row level security;

create policy "admin_kyc_document_access_log: admin read"
  on public.admin_kyc_document_access_log for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- No client INSERT/UPDATE/DELETE policy -- same as
-- admin_message_access_log: written only by service-role, and never
-- mutated (an access log entry is a fact, not edited later).
