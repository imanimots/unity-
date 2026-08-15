-- Advertising MVP -- Phase 8: package catalogue admin RPCs.
--
-- No production Rand amounts are ever inserted by this migration --
-- these RPCs let an admin configure real catalogue rows later, in
-- DEVELOPMENT or production, entirely as data. Editing/deactivating a
-- package row here NEVER retroactively changes an already-funded
-- campaign's economics -- campaigns snapshot package terms at funding
-- time (see the campaign-funding RPC migration), so this table can be
-- edited freely without an auditable-history mechanism of its own
-- beyond `updated_at`/`commercial_version` (campaigns, not this table,
-- are what require immutable financial history).

create or replace function public.admin_create_ad_package(
  p_admin_id uuid,
  p_name text,
  p_inventory_class ad_inventory_class,
  p_placement_type ad_placement_type,
  p_placement_tier ad_placement_tier,
  p_position_band text,
  p_price_cents integer,
  p_impression_quota integer,
  p_currency text default 'ZAR',
  p_is_active boolean default false,
  p_is_test boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.ad_packages;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;
  if p_price_cents < 0 then
    raise exception 'price_cents must be >= 0';
  end if;
  if p_impression_quota <= 0 then
    raise exception 'impression_quota must be > 0';
  end if;
  if p_name is null or char_length(trim(p_name)) = 0 then
    raise exception 'name is required';
  end if;

  insert into public.ad_packages
    (name, inventory_class, placement_type, placement_tier, position_band, price_cents, currency, impression_quota, is_active, is_test, created_by)
  values
    (trim(p_name), p_inventory_class, p_placement_type, p_placement_tier, p_position_band, p_price_cents, p_currency, p_impression_quota, p_is_active, p_is_test, p_admin_id)
  returning * into v_package;

  return to_jsonb(v_package);
end;
$$;

revoke all on function public.admin_create_ad_package(uuid, text, ad_inventory_class, ad_placement_type, ad_placement_tier, text, integer, integer, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_create_ad_package(uuid, text, ad_inventory_class, ad_placement_type, ad_placement_tier, text, integer, integer, text, boolean, boolean) to service_role;

-- ── admin_update_ad_package ── in-place catalogue edit ───────────────
create or replace function public.admin_update_ad_package(
  p_admin_id uuid,
  p_package_id uuid,
  p_name text default null,
  p_position_band text default null,
  p_price_cents integer default null,
  p_impression_quota integer default null,
  p_is_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_package public.ad_packages;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.profiles where id = p_admin_id and role = 'admin') then
    raise exception 'not authorized';
  end if;

  select * into v_package from public.ad_packages where id = p_package_id for update;
  if not found then
    raise exception 'package not found';
  end if;
  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'price_cents must be >= 0';
  end if;
  if p_impression_quota is not null and p_impression_quota <= 0 then
    raise exception 'impression_quota must be > 0';
  end if;

  update public.ad_packages set
    name = coalesce(trim(p_name), name),
    position_band = coalesce(p_position_band, position_band),
    price_cents = coalesce(p_price_cents, price_cents),
    impression_quota = coalesce(p_impression_quota, impression_quota),
    is_active = coalesce(p_is_active, is_active),
    commercial_version = case when p_price_cents is not null or p_impression_quota is not null then commercial_version + 1 else commercial_version end,
    updated_at = now()
  where id = p_package_id
  returning * into v_package;

  return to_jsonb(v_package);
end;
$$;

revoke all on function public.admin_update_ad_package(uuid, uuid, text, text, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.admin_update_ad_package(uuid, uuid, text, text, integer, integer, boolean) to service_role;
