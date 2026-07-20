-- Add affiliate fields to profiles
alter table public.profiles
  add column if not exists is_affiliate boolean not null default false,
  add column if not exists affiliate_code text unique;

-- Index for fast affiliate code lookups (used when tracking referrals)
create index if not exists profiles_affiliate_code_idx on public.profiles (affiliate_code)
  where affiliate_code is not null;
