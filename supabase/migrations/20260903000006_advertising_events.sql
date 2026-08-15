-- Advertising MVP -- Phase 6: impression/click event telemetry.
--
-- Not individually billable (binding) -- an impression consumes
-- campaign delivery QUOTA, a click is analytics-only. Neither table has
-- ANY client SELECT policy, not even for the owning advertiser (binding
-- §49: "no advertiser direct SELECT") -- advertisers only ever see
-- aggregate metrics through a reporting RPC (added in a later
-- migration). Writes happen only through server-authoritative RPCs
-- (service-role), never client INSERT.
--
-- Privacy-minimizing by design: `viewer_id` is nullable (populated only
-- for authenticated viewers, and only because self-click/self-impression
-- exclusion genuinely needs it -- never exposed to advertisers).
-- `reach_key` is a first-party, non-fingerprinting dedupe token (a
-- random session-scoped value for anonymous viewers, or a server-side
-- hash of the authenticated viewer id) used only to estimate distinct
-- Reach -- never raw IP, never a persistent device fingerprint. No raw
-- user-agent/IP columns exist on these tables at all.
--
-- Retention: raw rows here are subject to a 90-day retention sweep
-- (RPC added in a later migration) -- financial ledger/history tables
-- are explicitly NOT subject to this retention rule.

create table if not exists public.ad_impressions (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.ad_campaigns(id),
  placement_type ad_placement_type not null,
  viewer_id    uuid references public.profiles(id),
  reach_key    text not null,
  countable    boolean not null default true,
  exclusion_reason text check (exclusion_reason is null or exclusion_reason in ('self_view', 'qa_traffic', 'service_role')),
  served_at    timestamptz not null default now()
);

create index if not exists ad_impressions_campaign_idx on public.ad_impressions(campaign_id, served_at);
create index if not exists ad_impressions_retention_idx on public.ad_impressions(served_at);
create index if not exists ad_impressions_reach_idx on public.ad_impressions(campaign_id, reach_key);

alter table public.ad_impressions enable row level security;

create policy "ad_impressions: admin read"
  on public.ad_impressions for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));

-- Deliberately no owner/advertiser SELECT policy at all -- raw events
-- are admin/support/fraud-review only (binding §49).

create table if not exists public.ad_clicks (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references public.ad_campaigns(id),
  impression_id  uuid references public.ad_impressions(id),
  viewer_id      uuid references public.profiles(id),
  reach_key      text not null,
  is_self_click  boolean not null default false,
  countable      boolean not null default true,
  idempotency_key text,
  clicked_at     timestamptz not null default now()
);

create index if not exists ad_clicks_campaign_idx on public.ad_clicks(campaign_id, clicked_at);
create index if not exists ad_clicks_retention_idx on public.ad_clicks(clicked_at);
create unique index if not exists ad_clicks_idempotency_idx on public.ad_clicks(campaign_id, idempotency_key) where idempotency_key is not null;

alter table public.ad_clicks enable row level security;

create policy "ad_clicks: admin read"
  on public.ad_clicks for select
  using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
