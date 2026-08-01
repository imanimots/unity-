-- ============================================================
-- Listing wizard fields — schema design (Phase 0, schema only)
-- ============================================================
-- Adds the columns/tables needed for the full merchant listing wizard spec
-- (rental listings only — `listing_type = 'rental'`; sale listings are out
-- of scope here, see docs/BUYING_SELLING.md). No application code — wizard
-- UI, API routes, Zod schemas, TypeScript types, or data-layer functions —
-- has been built against any of this yet. That is a later, separate pass.
-- Full field-by-field rationale, public/private designation, and validation
-- notes live in docs/LISTING_SCHEMA.md; this file is the schema itself.
-- Apply via: Supabase Dashboard → SQL Editor → Run
-- ============================================================

do $$ begin
  create type ownership_proof_type as enum (
    'receipt', 'invoice', 'warranty', 'registration',
    'affidavit', 'asset_register', 'finance_agreement', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type media_shot_type as enum (
    'primary', 'front', 'rear', 'side',
    'condition_closeup', 'damage_closeup', 'serial_mark'
  );
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────
-- LISTINGS — public, 1:1 fields only. Anything sensitive (purchase price,
-- retailer, serial number, exact handover address, category-specific
-- identifiers like VIN/IMEI) lives in listing_private_details instead —
-- every public read path in src/lib/data/listings.ts does `select('*')`,
-- so anything added here is reachable by any anon-key caller once a
-- listing is active. See docs/LISTING_SCHEMA.md for the full public/
-- private rationale.
-- ─────────────────────────────────────────
alter table public.listings
  -- Item detail (quantity_available already exists from the buying/selling
  -- migration — reused, not duplicated)
  add column if not exists brand                  text,
  add column if not exists model                   text,
  add column if not exists replacement_value        numeric(10,2),
  add column if not exists year_of_manufacture      int,
  add column if not exists colour                   text,
  add column if not exists size                     text,
  add column if not exists specifications           text,
  add column if not exists included_accessories     text,
  add column if not exists tags                     text[],
  -- Location (country_id already exists — reused)
  add column if not exists province                 text,
  add column if not exists city                     text,
  add column if not exists collection_area           text,
  -- Condition disclosure — deliberately public: the spec's point is that
  -- renters see known defects, not that they're hidden.
  add column if not exists known_defects            text,
  add column if not exists wear_description          text,
  add column if not exists functional_status         text,
  add column if not exists missing_parts             text,
  add column if not exists repair_history            text,
  add column if not exists condition_confirmed       boolean not null default false,
  -- Pricing extension (daily_rate/weekly_rate/min_rental_days already exist)
  add column if not exists weekend_rate              numeric(10,2),
  add column if not exists monthly_rate              numeric(10,2),
  add column if not exists max_rental_days           int,
  -- Availability scalars (blocked date RANGES are one-to-many — see
  -- listing_availability below)
  add column if not exists available_from            date,
  add column if not exists min_booking_notice_days   int,
  add column if not exists max_advance_booking_days  int,
  add column if not exists recurring_unavailable_weekdays int[],
  -- Handover — non-address fields only; anything address-like lives in
  -- listing_private_details.handover_instructions
  add column if not exists pickup_available          boolean not null default true,
  add column if not exists delivery_available        boolean not null default false,
  add column if not exists merchant_delivery_available boolean not null default false,
  add column if not exists courier_allowed           boolean not null default false,
  add column if not exists renter_collection_allowed boolean not null default true,
  add column if not exists preferred_handover_times  text,
  -- Ownership — low-sensitivity flags only (no PII). The legal declaration
  -- record lives in listing_declarations; ownership_declaration_accepted
  -- here is a cheap, non-authoritative summary flag for quick reads.
  add column if not exists ownership_proof_type      ownership_proof_type,
  add column if not exists ownership_declaration_accepted boolean not null default false,
  -- Affiliate extension (accepts_affiliates/affiliate_commission_rate
  -- already exist — reused, no new affiliate infrastructure)
  add column if not exists promotional_terms         text,
  add column if not exists campaign_start_date       date,
  add column if not exists campaign_end_date         date,
  -- Category-specific, NON-sensitive display attributes only (e.g. tech
  -- battery health shown for display). Never used for search/filter/sort/
  -- risk scoring today — see docs/LISTING_SCHEMA.md's promotion rule for
  -- when a key here should become a typed column instead. Sensitive
  -- category-specific identifiers (VIN, IMEI, registration number) go in
  -- listing_private_details.private_category_metadata, never here.
  add column if not exists category_metadata         jsonb;

alter table public.listings
  add constraint listings_replacement_value_chk check (replacement_value is null or replacement_value > 0),
  add constraint listings_year_of_manufacture_chk check (year_of_manufacture is null or year_of_manufacture between 1900 and 2100),
  add constraint listings_weekend_rate_chk check (weekend_rate is null or weekend_rate > 0),
  add constraint listings_monthly_rate_chk check (monthly_rate is null or monthly_rate > 0),
  add constraint listings_max_rental_days_chk check (max_rental_days is null or max_rental_days >= min_rental_days),
  add constraint listings_min_booking_notice_chk check (min_booking_notice_days is null or min_booking_notice_days >= 0),
  add constraint listings_max_advance_booking_chk check (max_advance_booking_days is null or max_advance_booking_days >= 0);

-- ─────────────────────────────────────────
-- LISTING_PRIVATE_DETAILS — 1:1, merchant + service_role read only.
-- Everything here is either PII-adjacent (purchase price, retailer),
-- fraud/theft-sensitive (serial number, category-specific identifiers
-- like VIN/IMEI), or an exact address-like field (handover instructions —
-- stays merchant-only until a real booking-confirmation flow exists to
-- reveal it to a *confirmed* renter, not the public).
-- ─────────────────────────────────────────
create table if not exists public.listing_private_details (
  listing_id              uuid primary key references public.listings(id) on delete cascade,
  purchase_date           date,
  purchase_price          numeric(10,2),
  retailer_or_seller      text,
  serial_number           text,
  handover_instructions   text,
  -- Sensitive category-specific identifiers (VIN, registration number,
  -- IMEI, device serial, ownership-document references). Never expose
  -- these via category_metadata on the public `listings` row.
  private_category_metadata jsonb,
  created_at              timestamptz not null default now()
);

alter table public.listing_private_details
  add constraint listing_private_details_purchase_price_chk check (purchase_price is null or purchase_price > 0);

alter table public.listing_private_details enable row level security;

create policy "listing_private_details: merchant read own"
  on public.listing_private_details for select
  using (
    exists (
      select 1 from public.listings
      where listings.id = listing_private_details.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_private_details: merchant insert own"
  on public.listing_private_details for insert
  with check (
    exists (
      select 1 from public.listings
      where listings.id = listing_private_details.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_private_details: merchant update own"
  on public.listing_private_details for update
  using (
    exists (
      select 1 from public.listings
      where listings.id = listing_private_details.listing_id
        and listings.merchant_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.listings
      where listings.id = listing_private_details.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

-- No public read policy at all — deliberate. service_role bypasses RLS
-- and always has access regardless of policies present.

-- ─────────────────────────────────────────
-- LISTING_AVAILABILITY — genuine one-to-many (blocked date ranges).
-- Public read: renters need this to see bookability before requesting a
-- booking. Merchant-only insert/delete — mirrors listing_media's shape.
-- ─────────────────────────────────────────
create table if not exists public.listing_availability (
  id          uuid primary key default uuid_generate_v4(),
  listing_id  uuid not null references public.listings(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  reason      text,
  created_at  timestamptz not null default now(),
  constraint listing_availability_date_range_chk check (end_date >= start_date)
);

create index if not exists listing_availability_listing_date_idx
  on public.listing_availability(listing_id, start_date, end_date);

alter table public.listing_availability enable row level security;

create policy "listing_availability: public read"
  on public.listing_availability for select using (true);

create policy "listing_availability: merchant insert"
  on public.listing_availability for insert
  with check (
    exists (
      select 1 from public.listings
      where listings.id = listing_availability.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_availability: merchant delete"
  on public.listing_availability for delete
  using (
    exists (
      select 1 from public.listings
      where listings.id = listing_availability.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────
-- LISTING_REQUIREMENTS — 1:1, public read (renters must see requirements
-- and usage/damage/cancellation terms before booking, same reasoning as
-- listing_availability being public). Consolidates renter requirements,
-- usage rules, damage/liability, cancellation, and deposit-basis into one
-- table rather than four separate ones — every field here is single-value
-- per listing, none is one-to-many, so one table keeps the 1:1 shape
-- simple without meaningfully increasing coupling.
-- ─────────────────────────────────────────
do $$ begin
  create type deposit_basis as enum ('fixed', 'percentage', 'system_calculated');
exception when duplicate_object then null; end $$;

create table if not exists public.listing_requirements (
  listing_id uuid primary key references public.listings(id) on delete cascade,

  -- Renter requirements — server-checked; a merchant can require these,
  -- but cannot self-approve a renter against them (that's enforced in
  -- application code once a real booking-eligibility check exists, not in
  -- this schema-only pass).
  verified_identity_required     boolean not null default false,
  kyc_approved_required          boolean not null default false,
  proof_of_address_required      boolean not null default false,
  min_age                        int,
  driving_licence_required       boolean not null default false,
  licence_class                  text,
  bank_statement_required        boolean not null default false,
  proof_of_employment_required   boolean not null default false,
  prior_rental_history_required  boolean not null default false,
  refundable_deposit_required    boolean not null default false,
  additional_requirements        text,

  -- Usage rules
  permitted_use                  text,
  prohibited_use                 text,
  indoor_outdoor_restriction     text,
  geographic_restriction         text,
  -- A renter's usage cap (e.g. "max 200km"), explicitly distinct from a
  -- vehicle's own current odometer reading, which belongs in
  -- listing_private_details.private_category_metadata.
  mileage_limit                  int,
  max_users                      int,
  commercial_use_allowed         boolean not null default false,
  sub_rental_allowed             boolean not null default false,
  pets_allowed                   boolean,
  smoking_allowed                boolean,
  cleaning_requirements          text,
  return_condition_requirements  text,
  consumable_return_requirements text,
  required_protective_equipment  text,
  supervision_required           boolean not null default false,
  operating_instructions         text,
  merchant_custom_rules          text,

  -- Damage / liability — no new insurance products, no arbitrary
  -- auto-deduction fields (per the spec's explicit ban).
  existing_damage_description       text,
  damage_policy_acknowledged        boolean not null default false,
  merchant_provides_insurance       boolean not null default false,
  renter_insurance_required         boolean not null default false,
  excess_amount                     numeric(10,2),
  inspection_required_before_handover boolean not null default false,
  inspection_required_on_return       boolean not null default false,
  cleaning_fee_conditions           text,
  lost_item_consequence             text,
  missing_accessory_consequence     text,

  -- Cancellation — deliberately NO refund-percentage/penalty fields. If
  -- financial cancellation rules remain unresolved, none are stored.
  merchant_cancellation_notice_hours int,
  renter_cancellation_notice_hours   int,
  auto_approval_enabled              boolean not null default false,
  cancellation_reason_required       boolean not null default false,

  -- Deposit basis. `final_deposit_amount` is system-calculated and
  -- privileged — see 20260729000006_listing_security_hardening.sql.
  deposit_basis            deposit_basis not null default 'fixed',
  requested_deposit_amount numeric(10,2),
  final_deposit_amount     numeric(10,2),

  created_at timestamptz not null default now(),

  constraint listing_requirements_custom_rules_len_chk check (merchant_custom_rules is null or char_length(merchant_custom_rules) <= 2000),
  constraint listing_requirements_min_age_chk check (min_age is null or min_age >= 0),
  constraint listing_requirements_excess_chk check (excess_amount is null or excess_amount >= 0),
  constraint listing_requirements_merchant_notice_chk check (merchant_cancellation_notice_hours is null or merchant_cancellation_notice_hours >= 0),
  constraint listing_requirements_renter_notice_chk check (renter_cancellation_notice_hours is null or renter_cancellation_notice_hours >= 0),
  constraint listing_requirements_requested_deposit_chk check (requested_deposit_amount is null or requested_deposit_amount >= 0),
  constraint listing_requirements_final_deposit_chk check (final_deposit_amount is null or final_deposit_amount >= 0)
);

alter table public.listing_requirements enable row level security;

create policy "listing_requirements: public read"
  on public.listing_requirements for select using (true);

create policy "listing_requirements: merchant insert own"
  on public.listing_requirements for insert
  with check (
    exists (
      select 1 from public.listings
      where listings.id = listing_requirements.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

create policy "listing_requirements: merchant update own"
  on public.listing_requirements for update
  using (
    exists (
      select 1 from public.listings
      where listings.id = listing_requirements.listing_id
        and listings.merchant_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.listings
      where listings.id = listing_requirements.listing_id
        and listings.merchant_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────
-- LISTING_MEDIA — tag existing rows with an optional shot type, used for
-- future completeness validation (e.g. "damage photo required if defects
-- declared") and consistent ordering. Nullable — fully backward-compatible
-- with existing/mock rows that predate this column.
-- ─────────────────────────────────────────
alter table public.listing_media
  add column if not exists shot_type media_shot_type;
