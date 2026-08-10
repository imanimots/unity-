-- ============================================================
-- Phase 5 -- fix-forward correction, found via live regression testing.
-- ============================================================
-- create_marketplace_request() has its OWN hardcoded transaction_type
-- validation (`if p_transaction_type not in ('buy', 'rent', 'barter')`),
-- entirely separate from marketplace_requests_transaction_type_check
-- (already widened in 20260827000004_rtb_widening.sql). Widening the
-- table CHECK alone was not sufficient -- the RPC's own internal guard
-- rejected 'rent_to_buy' before the insert was ever attempted,
-- confirmed live: POST /api/marketplace/requests with
-- transaction_type='rent_to_buy' returned "invalid transaction type".
--
-- CREATE OR REPLACE, same exact signature (no parameter added, so no
-- DROP FUNCTION needed) -- the only change is this one line.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.create_marketplace_request(
  p_requester_id uuid,
  p_transaction_type text,
  p_title text,
  p_description text default null,
  p_category text default null,
  p_category_id uuid default null,
  p_subcategory_id uuid default null,
  p_country_id text default 'ZA',
  p_province text default null,
  p_city text default null,
  p_budget_min numeric default null,
  p_budget_max numeric default null,
  p_currency text default 'ZAR',
  p_start_date date default null,
  p_end_date date default null,
  p_quantity int default 1,
  p_condition_preferences text default null,
  p_barter_offer_description text default null,
  p_specifications jsonb default '{}'::jsonb,
  p_expires_at timestamptz default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_request_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_requester_id is null then raise exception 'not authenticated'; end if;
  if p_transaction_type not in ('buy', 'rent', 'barter', 'rent_to_buy') then raise exception 'invalid transaction type'; end if;
  if p_title is null or length(trim(p_title)) = 0 then raise exception 'a title is required'; end if;

  v_request_hash := md5(coalesce(p_title,'') || '|' || coalesce(p_transaction_type,'') || '|' || coalesce(p_description,''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem from public.idempotency_keys
    where merchant_id = p_requester_id and operation = 'create_marketplace_request' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then raise exception 'idempotency key already used with a different request'; end if;
      return v_idem.result;
    end if;
  end if;

  insert into public.marketplace_requests (
    requester_id, transaction_type, status, title, description, category, category_id, subcategory_id,
    country_id, province, city, budget_min, budget_max, currency, start_date, end_date, quantity,
    condition_preferences, barter_offer_description, specifications, expires_at
  ) values (
    p_requester_id, p_transaction_type, 'draft', p_title, p_description, p_category, p_category_id, p_subcategory_id,
    coalesce(p_country_id, 'ZA'), p_province, p_city, p_budget_min, p_budget_max, coalesce(p_currency, 'ZAR'), p_start_date, p_end_date, greatest(coalesce(p_quantity, 1), 1),
    p_condition_preferences, p_barter_offer_description, coalesce(p_specifications, '{}'::jsonb), p_expires_at
  ) returning id into v_request_id;

  perform public._marketplace_request_history(v_request_id, null, 'requester', p_requester_id, 'created', null, 'draft');

  v_result := jsonb_build_object('request_id', v_request_id, 'status', 'draft');
  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_requester_id, 'create_marketplace_request', p_idempotency_key, v_request_hash, v_result);
  end if;
  return v_result;
end;
$$;
