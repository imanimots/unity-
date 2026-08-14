-- Fix-forward: counter_barter_offer() never got the same "skip
-- validate_barter_offer_side() when the listing array is empty" guard
-- that propose_barter() already has (20260901000010, lines ~347-352).
-- validate_barter_offer_side() unconditionally raises 'at least one
-- listing must be offered from the % side' when passed an empty/null
-- array -- correct for the pre-Skills+Tasks world where every offer
-- side needed a listing, but wrong now that a side may be purely
-- Skill/Task-based (contributions with zero listings). Exposed live by
-- scripts/verify-skills-tasks-barter.mjs Section O (accepted-offer-only
-- milestone security via a countered/superseded offer version), which
-- could not even create a counter-offer with an empty listing side.
--
-- Signature is unchanged (same 19 params) -- plain CREATE OR REPLACE
-- is safe here, unlike the propose/counter signature widening in
-- 20260901000010 which required DROP+CREATE.
create or replace function public.counter_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_party_a_listing_ids uuid[] default '{}',
  p_party_b_listing_ids uuid[] default '{}',
  p_cash_adjustment_amount numeric default 0,
  p_cash_adjustment_payer uuid default null,
  p_delivery_method text default 'meet_in_person',
  p_delivery_notes text default null,
  p_delivery_responsibility text default null,
  p_deposit_required boolean default false,
  p_deposit_amount numeric default null,
  p_deposit_currency text default 'ZAR',
  p_deposit_payer text default null,
  p_message text default null,
  p_expiry_hours int default 72,
  p_idempotency_key text default null,
  p_party_a_contributions jsonb default null,
  p_party_b_contributions jsonb default null,
  p_deposit_terms jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_agreement record;
  v_current_offer record;
  v_new_offer_id uuid;
  v_new_version int;
  v_result jsonb;
  v_source_post public.barter_skill_task_posts;
  v_satisfies_source_kind boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;
  if p_expiry_hours is null or p_expiry_hours <= 0 then
    raise exception 'invalid expiry window';
  end if;

  v_request_hash := md5(
    coalesce(p_agreement_id::text, '') || '|' || coalesce(p_party_a_listing_ids::text, '') || '|' ||
    coalesce(p_party_b_listing_ids::text, '') || '|' || coalesce(p_party_a_contributions::text, '[]') || '|' ||
    coalesce(p_party_b_contributions::text, '[]') || '|' || coalesce(p_deposit_terms::text, '[]') || '|' ||
    coalesce(p_cash_adjustment_amount::text, '0') || '|' || coalesce(p_delivery_method, '') || '|' ||
    coalesce(p_deposit_amount::text, '') || '|' || coalesce(p_deposit_payer, '') || '|' || coalesce(p_message, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'counter_barter_offer' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id for update;

  if v_agreement.id is null or (v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id) then
    raise exception 'barter agreement not found or you are not a party to it';
  end if;
  if v_agreement.admin_hold then
    raise exception 'this barter agreement is currently suspended by an administrator';
  end if;
  if v_agreement.status not in ('proposed', 'countered') then
    raise exception 'this offer can no longer be countered';
  end if;

  -- Round 6 (F): if this agreement originated from a Looking-For
  -- source post, lock and re-check it -- a counter cannot proceed
  -- while the source is suspended (frozen) or already matched/closed.
  if v_agreement.source_skill_task_post_id is not null then
    select * into v_source_post from public.barter_skill_task_posts where id = v_agreement.source_skill_task_post_id for update;
    if v_source_post.status not in ('active', 'offers_received') then
      raise exception 'the originating request is no longer open (%), so this offer cannot be countered', v_source_post.status;
    end if;
  end if;

  select * into v_current_offer from public.barter_offers where id = v_agreement.current_offer_id;

  if v_current_offer.proposed_by = p_actor_user_id then
    raise exception 'it is not your turn to respond to this offer';
  end if;

  perform public._assert_kyc_approved(p_actor_user_id, 'self');
  perform public._assert_kyc_approved(
    case when p_actor_user_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
    'counterparty'
  );

  -- Fix (this migration): only validate a listing side when it's
  -- actually non-empty -- a side may now be purely Skill/Task-based,
  -- mirroring propose_barter()'s own guard exactly.
  if p_party_a_listing_ids is not null and array_length(p_party_a_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_a_listing_ids, v_agreement.party_a_id, 'requested');
  end if;
  if p_party_b_listing_ids is not null and array_length(p_party_b_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_b_listing_ids, v_agreement.party_b_id, 'offered');
  end if;

  if coalesce(array_length(p_party_a_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_a_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the requested side';
  end if;
  if coalesce(array_length(p_party_b_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_b_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the offered side';
  end if;

  update public.barter_offers set status = 'superseded' where id = v_current_offer.id;

  v_new_version := v_current_offer.version + 1;

  insert into public.barter_offers (
    agreement_id, version, proposed_by, status,
    cash_adjustment_amount, cash_adjustment_payer,
    delivery_method, delivery_notes, delivery_responsibility,
    deposit_required, deposit_amount, deposit_currency, deposit_payer,
    message
  ) values (
    p_agreement_id, v_new_version, p_actor_user_id, 'pending',
    coalesce(p_cash_adjustment_amount, 0), p_cash_adjustment_payer,
    p_delivery_method, p_delivery_notes, p_delivery_responsibility,
    coalesce(p_deposit_required, false), p_deposit_amount, coalesce(p_deposit_currency, 'ZAR'), p_deposit_payer,
    p_message
  )
  returning id into v_new_offer_id;

  perform public.insert_barter_offer_items(v_new_offer_id, p_party_a_listing_ids, v_agreement.party_a_id);
  perform public.insert_barter_offer_items(v_new_offer_id, p_party_b_listing_ids, v_agreement.party_b_id);

  perform public._insert_barter_skill_task_contributions(v_new_offer_id, p_party_a_contributions, v_agreement.party_a_id);
  perform public._insert_barter_skill_task_contributions(v_new_offer_id, p_party_b_contributions, v_agreement.party_b_id);

  if p_deposit_terms is not null and jsonb_array_length(p_deposit_terms) > 0 then
    if coalesce(p_deposit_required, false) or p_deposit_amount is not null then
      raise exception 'cannot combine legacy deposit fields with deposit_terms in the same offer';
    end if;
    perform public._insert_barter_deposit_terms(v_new_offer_id, p_deposit_terms, v_agreement.party_a_id, v_agreement.party_b_id);
    update public.barter_offers set deposit_required = false, deposit_amount = null, deposit_payer = null where id = v_new_offer_id;
  end if;

  if v_agreement.source_skill_task_post_id is not null then
    select exists (
      select 1 from public.barter_offer_items
      where offer_id = v_new_offer_id and offered_by <> v_source_post.owner_id and kind = v_source_post.kind
    ) into v_satisfies_source_kind;
    if not v_satisfies_source_kind then
      raise exception 'your counter-offer must include at least one % contribution to satisfy the originating request', v_source_post.kind;
    end if;
  end if;

  update public.barter_agreements set
    status = 'countered',
    current_offer_id = v_new_offer_id,
    version = v_new_version,
    expires_at = now() + make_interval(hours => p_expiry_hours)
  where id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_countered', v_agreement.status, 'countered', jsonb_build_object('offer_id', v_new_offer_id, 'version', v_new_version), p_idempotency_key
  );

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'offer_id', v_new_offer_id, 'version', v_new_version, 'status', 'countered');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'counter_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

revoke all on function public.counter_barter_offer(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
