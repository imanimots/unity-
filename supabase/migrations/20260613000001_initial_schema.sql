-- ============================================================
-- Unity Platform — Initial Schema
-- ============================================================
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ─────────────────────────────────────────
-- EXTENSIONS
-- ─────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ─────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────
do $$ begin
  create type user_role as enum ('renter', 'merchant', 'both', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type kyc_status as enum ('none', 'pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type listing_status as enum ('draft', 'pending', 'active', 'paused', 'rented');
exception when duplicate_object then null; end $$;

do $$ begin
  create type booking_status as enum ('pending', 'approved', 'active', 'returned', 'disputed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type shipping_payer as enum ('renter', 'merchant', 'split', 'negotiate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type item_condition as enum ('new', 'like_new', 'good', 'fair');
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_type as enum ('photo', 'video', 'ownership_proof');
exception when duplicate_object then null; end $$;

do $$ begin
  create type dispute_status as enum ('open', 'resolved', 'escalated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type affiliate_status as enum ('pending', 'paid', 'cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────
-- COUNTRIES
-- ─────────────────────────────────────────
create table if not exists countries (
  id              text primary key,           -- e.g. 'ZA', 'NG', 'KE'
  name            text not null,
  flag            text not null default '',
  currency        text not null,
  currency_symbol text not null,
  active          boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Seed supported countries (safe to re-run)
insert into countries (id, name, flag, currency, currency_symbol, active) values
  ('ZA', 'South Africa',   '🇿🇦', 'ZAR', 'R',    true),
  ('NG', 'Nigeria',        '🇳🇬', 'NGN', '₦',    false),
  ('KE', 'Kenya',          '🇰🇪', 'KES', 'KSh',  false),
  ('GH', 'Ghana',          '🇬🇭', 'GHS', 'GH₵',  false),
  ('GB', 'United Kingdom', '🇬🇧', 'GBP', '£',    false)
on conflict (id) do update
  set name            = excluded.name,
      flag            = excluded.flag,
      currency        = excluded.currency,
      currency_symbol = excluded.currency_symbol,
      active          = excluded.active;

-- ─────────────────────────────────────────
-- PROFILES  (extends auth.users)
-- ─────────────────────────────────────────
create table if not exists profiles (
  id           uuid primary key references auth.users on delete cascade,
  full_name    text,
  display_name text,
  phone        text,
  avatar_url   text,
  role         user_role  not null default 'renter',
  kyc_status   kyc_status not null default 'none',
  unity_score  numeric(3,2) not null default 5.00,
  country_id   text not null default 'ZA' references countries(id),
  created_at   timestamptz not null default now()
);

-- Trigger: auto-create profile row immediately after signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, display_name, role)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.raw_user_meta_data ->> 'full_name', ' ', 1)
    ),
    coalesce(
      (new.raw_user_meta_data ->> 'role')::user_role,
      'renter'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────
-- LISTINGS
-- ─────────────────────────────────────────
create table if not exists listings (
  id                        uuid primary key default uuid_generate_v4(),
  merchant_id               uuid not null references profiles(id) on delete cascade,
  country_id                text not null default 'ZA' references countries(id),
  title                     text not null,
  description               text,
  category                  text not null,
  condition                 item_condition,
  daily_rate                numeric(10,2) not null,
  weekly_rate               numeric(10,2),
  min_rental_days           int not null default 1,
  deposit_required          boolean not null default false,
  deposit_amount            numeric(10,2),
  insurance_amount          numeric(10,2),
  shipping_payer            shipping_payer not null default 'negotiate',
  min_unity_score           numeric(3,2) not null default 0,
  requires_credit_score     boolean not null default false,
  min_credit_score          int,
  accepts_affiliates        boolean not null default false,
  affiliate_commission_rate numeric(5,2) not null default 0,
  status                    listing_status not null default 'draft',
  ownership_verified        boolean not null default false,
  created_at                timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- LISTING MEDIA
-- ─────────────────────────────────────────
create table if not exists listing_media (
  id            uuid primary key default uuid_generate_v4(),
  listing_id    uuid not null references listings(id) on delete cascade,
  url           text not null,
  type          media_type not null default 'photo',
  display_order int not null default 0,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- BOOKINGS
-- ─────────────────────────────────────────
create table if not exists bookings (
  id                          uuid primary key default uuid_generate_v4(),
  listing_id                  uuid not null references listings(id),
  renter_id                   uuid not null references profiles(id),
  merchant_id                 uuid not null references profiles(id),
  start_date                  date not null,
  end_date                    date not null,
  total_days                  int not null,
  rental_fee                  numeric(10,2) not null,
  deposit_amount              numeric(10,2) not null default 0,
  shipping_fee                numeric(10,2) not null default 0,
  total_amount                numeric(10,2) not null,
  status                      booking_status not null default 'pending',
  pre_rental_media_url        text,
  post_rental_media_url       text,
  payfast_payment_id          text,
  affiliate_id                uuid references profiles(id),
  affiliate_commission_amount numeric(10,2),
  created_at                  timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- REVIEWS
-- ─────────────────────────────────────────
create table if not exists reviews (
  id          uuid primary key default uuid_generate_v4(),
  booking_id  uuid not null references bookings(id),
  reviewer_id uuid not null references profiles(id),
  reviewee_id uuid not null references profiles(id),
  rating      smallint not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (booking_id, reviewer_id)   -- one review per party per booking
);

-- Trigger: recalculate unity_score after every review insert/update
create or replace function public.update_unity_score()
returns trigger
language plpgsql
security definer
as $$
begin
  update public.profiles
  set unity_score = (
    select round(avg(rating)::numeric, 2)
    from public.reviews
    where reviewee_id = new.reviewee_id
  )
  where id = new.reviewee_id;
  return new;
end;
$$;

drop trigger if exists recalc_unity_score on reviews;
create trigger recalc_unity_score
  after insert or update on reviews
  for each row execute procedure public.update_unity_score();

-- ─────────────────────────────────────────
-- DISPUTES
-- ─────────────────────────────────────────
create table if not exists disputes (
  id               uuid primary key default uuid_generate_v4(),
  booking_id       uuid not null references bookings(id),
  raised_by        uuid not null references profiles(id),
  reason           text,
  evidence_urls    text[] not null default '{}',
  status           dispute_status not null default 'open',
  resolution_notes text,
  created_at       timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- MESSAGES
-- ─────────────────────────────────────────
create table if not exists messages (
  id            uuid primary key default uuid_generate_v4(),
  booking_id    uuid not null references bookings(id),
  sender_id     uuid not null references profiles(id),
  content       text not null,
  is_filtered   boolean not null default false,
  filter_reason text,
  created_at    timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- AFFILIATE REFERRALS
-- ─────────────────────────────────────────
create table if not exists affiliate_referrals (
  id                uuid primary key default uuid_generate_v4(),
  affiliate_id      uuid not null references profiles(id),
  referred_user_id  uuid references profiles(id),
  listing_id        uuid references listings(id),
  booking_id        uuid references bookings(id),
  commission_amount numeric(10,2),
  status            affiliate_status not null default 'pending',
  created_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────
create index if not exists listings_merchant_id_idx  on listings(merchant_id);
create index if not exists listings_status_idx       on listings(status);
create index if not exists listings_category_idx     on listings(category);
create index if not exists listings_country_idx      on listings(country_id);
create index if not exists listings_title_trgm_idx   on listings using gin (title gin_trgm_ops);
create index if not exists bookings_renter_idx       on bookings(renter_id);
create index if not exists bookings_merchant_idx     on bookings(merchant_id);
create index if not exists bookings_listing_idx      on bookings(listing_id);
create index if not exists bookings_status_idx       on bookings(status);
create index if not exists messages_booking_idx      on messages(booking_id);
create index if not exists messages_created_idx      on messages(created_at);
create index if not exists reviews_reviewee_idx      on reviews(reviewee_id);
create index if not exists listing_media_listing_idx on listing_media(listing_id, display_order);
create index if not exists disputes_booking_idx      on disputes(booking_id);
create index if not exists affiliate_ref_aff_idx     on affiliate_referrals(affiliate_id);

-- ─────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────

-- COUNTRIES — public read, no write via API
alter table countries enable row level security;

create policy "countries: public read"
  on countries for select using (true);

-- PROFILES — public read, owners update own row
alter table profiles enable row level security;

create policy "profiles: public read"
  on profiles for select using (true);

create policy "profiles: own update"
  on profiles for update using (auth.uid() = id);

-- LISTINGS — active listings are public; merchant sees all their own
alter table listings enable row level security;

create policy "listings: public read active"
  on listings for select
  using (status = 'active' or auth.uid() = merchant_id);

create policy "listings: merchant insert"
  on listings for insert
  with check (auth.uid() = merchant_id);

create policy "listings: merchant update"
  on listings for update
  using (auth.uid() = merchant_id);

create policy "listings: merchant delete"
  on listings for delete
  using (auth.uid() = merchant_id);

-- LISTING MEDIA — public read; merchant manages media for their listings
alter table listing_media enable row level security;

create policy "listing_media: public read"
  on listing_media for select using (true);

create policy "listing_media: merchant insert"
  on listing_media for insert
  with check (
    exists (
      select 1 from listings
      where listings.id = listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_media: merchant delete"
  on listing_media for delete
  using (
    exists (
      select 1 from listings
      where listings.id = listing_id
        and listings.merchant_id = auth.uid()
    )
  );

-- BOOKINGS — renter and merchant see/update their own bookings
alter table bookings enable row level security;

create policy "bookings: parties read"
  on bookings for select
  using (renter_id = auth.uid() or merchant_id = auth.uid());

create policy "bookings: renter insert"
  on bookings for insert
  with check (renter_id = auth.uid());

create policy "bookings: parties update"
  on bookings for update
  using (renter_id = auth.uid() or merchant_id = auth.uid());

-- REVIEWS — public read; reviewer inserts once per booking
alter table reviews enable row level security;

create policy "reviews: public read"
  on reviews for select using (true);

create policy "reviews: reviewer insert"
  on reviews for insert
  with check (reviewer_id = auth.uid());

-- DISPUTES — only booking parties can see/raise
alter table disputes enable row level security;

create policy "disputes: parties read"
  on disputes for select
  using (
    raised_by = auth.uid()
    or exists (
      select 1 from bookings
      where bookings.id = booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
  );

create policy "disputes: parties insert"
  on disputes for insert
  with check (
    raised_by = auth.uid()
    and exists (
      select 1 from bookings
      where bookings.id = booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
  );

-- MESSAGES — only booking parties can read/send
alter table messages enable row level security;

create policy "messages: parties read"
  on messages for select
  using (
    exists (
      select 1 from bookings
      where bookings.id = booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
  );

create policy "messages: parties send"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from bookings
      where bookings.id = booking_id
        and (bookings.renter_id = auth.uid() or bookings.merchant_id = auth.uid())
    )
  );

-- AFFILIATE REFERRALS — affiliate sees their own referrals
alter table affiliate_referrals enable row level security;

create policy "affiliate_referrals: affiliate read"
  on affiliate_referrals for select
  using (affiliate_id = auth.uid());

create policy "affiliate_referrals: affiliate insert"
  on affiliate_referrals for insert
  with check (affiliate_id = auth.uid());

-- ─────────────────────────────────────────
-- STORAGE BUCKETS
-- ─────────────────────────────────────────

-- listing-media: public (listing photos shown to everyone)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-media', 'listing-media', true,
  52428800,  -- 50 MB
  array['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/quicktime']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- avatars: public (profile photos)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true,
  5242880,   -- 5 MB
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- rental-media: private (pre/post rental photos, only booking parties)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rental-media', 'rental-media', false,
  52428800,  -- 50 MB
  array['image/jpeg','image/png','image/webp','image/heic','video/mp4','video/quicktime']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ownership-proofs: private (receipts/serials, only merchant + admins)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ownership-proofs', 'ownership-proofs', false,
  20971520,  -- 20 MB
  array['image/jpeg','image/png','image/webp','application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────
-- STORAGE RLS POLICIES
-- ─────────────────────────────────────────

-- listing-media bucket
create policy "storage listing-media: public read"
  on storage.objects for select
  using (bucket_id = 'listing-media');

create policy "storage listing-media: authenticated upload"
  on storage.objects for insert
  with check (bucket_id = 'listing-media' and auth.role() = 'authenticated');

create policy "storage listing-media: owner delete"
  on storage.objects for delete
  using (bucket_id = 'listing-media' and auth.uid()::text = (storage.foldername(name))[1]);

-- avatars bucket
create policy "storage avatars: public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "storage avatars: own upload"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "storage avatars: own delete"
  on storage.objects for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- rental-media bucket
create policy "storage rental-media: authenticated read"
  on storage.objects for select
  using (bucket_id = 'rental-media' and auth.role() = 'authenticated');

create policy "storage rental-media: authenticated upload"
  on storage.objects for insert
  with check (bucket_id = 'rental-media' and auth.role() = 'authenticated');

-- ownership-proofs bucket
create policy "storage ownership-proofs: own read"
  on storage.objects for select
  using (bucket_id = 'ownership-proofs' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "storage ownership-proofs: own upload"
  on storage.objects for insert
  with check (bucket_id = 'ownership-proofs' and auth.uid()::text = (storage.foldername(name))[1]);
