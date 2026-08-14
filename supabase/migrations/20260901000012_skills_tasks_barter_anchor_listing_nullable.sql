-- ============================================================
-- Fix-forward correction, found via live smoke testing: two real
-- gaps in the source-link migration (20260901000007) and
-- propose_barter's widening (20260901000010).
--
-- 1. barter_agreements.anchor_listing_id was NEVER widened to
--    nullable -- propose_barter's new anchor_skill_task_post_id path
--    left it unset, violating the original NOT NULL constraint.
--
-- 2. There was no column recording the anchor for an AVAILABLE
--    Skill/Task post (source_skill_task_post_id is deliberately only
--    set for the LOOKING_FOR case, since it drives the
--    offers_received/matched lifecycle) -- an anchor_skill_task_post_id
--    column is added, mirroring anchor_listing_id's own "informational,
--    not necessarily in the final item set" role exactly, always
--    populated whenever the anchor is a Skill/Task post regardless of
--    direction.
--
-- propose_barter's signature is unchanged by this fix -- only its
-- body (which column it writes) -- so CREATE OR REPLACE is safe.
-- 20260901000010 itself is left untouched.
-- ============================================================

alter table public.barter_agreements
  alter column anchor_listing_id drop not null,
  add column anchor_skill_task_post_id uuid references public.barter_skill_task_posts(id);

alter table public.barter_agreements
  add constraint barter_agreements_exactly_one_anchor_chk check (
    (anchor_listing_id is not null and anchor_skill_task_post_id is null)
    or (anchor_listing_id is null and anchor_skill_task_post_id is not null)
  );

create index barter_agreements_anchor_skill_task_post_idx on public.barter_agreements(anchor_skill_task_post_id);

create or replace function public.propose_barter(
  p_proposer_id uuid,
  p_anchor_listing_id uuid default null,
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
  p_anchor_skill_task_post_id uuid default null,
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
  v_anchor_owner uuid;
  v_anchor_status listing_status;
  v_anchor_post public.barter_skill_task_posts;
  v_agreement_id uuid;
  v_offer_id uuid;
  v_reference text;
  v_result jsonb;
  v_satisfies_source_kind boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_proposer_id is null then
    raise exception 'not authenticated';
  end if;
  if p_expiry_hours is null or p_expiry_hours <= 0 then
    raise exception 'invalid expiry window';
  end if;
  if (p_anchor_listing_id is not null)::int + (p_anchor_skill_task_post_id is not null)::int <> 1 then
    raise exception 'exactly one of an anchor listing or an anchor Skill/Task post must be provided';
  end if;

  v_request_hash := md5(
    coalesce(p_anchor_listing_id::text, '') || '|' || coalesce(p_anchor_skill_task_post_id::text, '') || '|' ||
    coalesce(p_party_a_listing_ids::text, '') || '|' || coalesce(p_party_b_listing_ids::text, '') || '|' ||
    coalesce(p_party_a_contributions::text, '[]') || '|' || coalesce(p_party_b_contributions::text, '[]') || '|' ||
    coalesce(p_deposit_terms::text, '[]') || '|' ||
    coalesce(p_cash_adjustment_amount::text, '0') || '|' || coalesce(p_delivery_method, '') || '|' ||
    coalesce(p_deposit_amount::text, '') || '|' || coalesce(p_deposit_payer, '') || '|' || coalesce(p_message, '')
  );

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_proposer_id and operation = 'propose_barter' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  if p_anchor_listing_id is not null then
    select merchant_id, status into v_anchor_owner, v_anchor_status from public.listings where id = p_anchor_listing_id;
    if v_anchor_owner is null then
      raise exception 'listing not found';
    end if;
    if v_anchor_status <> 'active' then
      raise exception 'this listing is not available for barter';
    end if;
  else
    select * into v_anchor_post from public.barter_skill_task_posts where id = p_anchor_skill_task_post_id for update;
    if v_anchor_post is null then
      raise exception 'post not found';
    end if;
    if v_anchor_post.direction = 'available' then
      if v_anchor_post.status <> 'active' then
        raise exception 'this Skill/Task is not currently available for barter';
      end if;
    else
      if v_anchor_post.status not in ('active', 'offers_received') then
        raise exception 'this request is no longer open for offers';
      end if;
    end if;
    v_anchor_owner := v_anchor_post.owner_id;
  end if;

  if v_anchor_owner = p_proposer_id then
    raise exception 'you cannot propose a trade against your own listing or post';
  end if;

  perform public._assert_kyc_approved(p_proposer_id, 'self');
  perform public._assert_kyc_approved(v_anchor_owner, 'counterparty');

  if p_party_a_listing_ids is not null and array_length(p_party_a_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_a_listing_ids, v_anchor_owner, 'requested');
  end if;
  if p_party_b_listing_ids is not null and array_length(p_party_b_listing_ids, 1) is not null then
    perform public.validate_barter_offer_side(p_party_b_listing_ids, p_proposer_id, 'offered');
  end if;

  if coalesce(array_length(p_party_a_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_a_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the requested side';
  end if;
  if coalesce(array_length(p_party_b_listing_ids, 1), 0) = 0 and coalesce(jsonb_array_length(p_party_b_contributions), 0) = 0 then
    raise exception 'at least one contribution must be offered from the offered side';
  end if;

  v_reference := public.generate_barter_reference();

  insert into public.barter_agreements (
    agreement_reference, anchor_listing_id, anchor_skill_task_post_id, source_skill_task_post_id,
    party_a_id, party_b_id, status, expires_at
  ) values (
    v_reference, p_anchor_listing_id, p_anchor_skill_task_post_id,
    case when v_anchor_post.direction = 'looking_for' then p_anchor_skill_task_post_id else null end,
    v_anchor_owner, p_proposer_id, 'proposed', now() + make_interval(hours => p_expiry_hours)
  )
  returning id into v_agreement_id;

  insert into public.barter_offers (
    agreement_id, version, proposed_by, status,
    cash_adjustment_amount, cash_adjustment_payer,
    delivery_method, delivery_notes, delivery_responsibility,
    deposit_required, deposit_amount, deposit_currency, deposit_payer,
    message
  ) values (
    v_agreement_id, 1, p_proposer_id, 'pending',
    coalesce(p_cash_adjustment_amount, 0), p_cash_adjustment_payer,
    p_delivery_method, p_delivery_notes, p_delivery_responsibility,
    coalesce(p_deposit_required, false), p_deposit_amount, coalesce(p_deposit_currency, 'ZAR'), p_deposit_payer,
    p_message
  )
  returning id into v_offer_id;

  update public.barter_agreements set current_offer_id = v_offer_id where id = v_agreement_id;

  perform public.insert_barter_offer_items(v_offer_id, p_party_a_listing_ids, v_anchor_owner);
  perform public.insert_barter_offer_items(v_offer_id, p_party_b_listing_ids, p_proposer_id);

  perform public._insert_barter_skill_task_contributions(v_offer_id, p_party_a_contributions, v_anchor_owner);
  perform public._insert_barter_skill_task_contributions(v_offer_id, p_party_b_contributions, p_proposer_id);

  if p_deposit_terms is not null and jsonb_array_length(p_deposit_terms) > 0 then
    if coalesce(p_deposit_required, false) or p_deposit_amount is not null then
      raise exception 'cannot combine legacy deposit fields with deposit_terms in the same offer';
    end if;
    perform public._insert_barter_deposit_terms(v_offer_id, p_deposit_terms, v_anchor_owner, p_proposer_id);
    update public.barter_offers set deposit_required = false, deposit_amount = null, deposit_payer = null where id = v_offer_id;
  end if;

  if v_anchor_post.direction = 'looking_for' then
    select exists (
      select 1 from public.barter_offer_items where offer_id = v_offer_id and offered_by = p_proposer_id and kind = v_anchor_post.kind
    ) into v_satisfies_source_kind;
    if not v_satisfies_source_kind then
      raise exception 'your offer must include at least one % contribution to satisfy this request', v_anchor_post.kind;
    end if;

    insert into public.barter_skill_task_source_snapshots (
      agreement_id, kind, title, description, exclusions, materials_arrangement, evidence_expectations,
      delivery_mode, province, city, availability_notes, preferred_start_date, preferred_start_time, deadline,
      expected_duration_notes, desired_exchange_notes
    )
    select v_agreement_id, kind, title, description, exclusions, materials_arrangement, evidence_expectations,
      delivery_mode, province, city, availability_notes, preferred_start_date, preferred_start_time, deadline,
      expected_duration_notes, desired_exchange_notes
    from public.barter_skill_task_posts where id = p_anchor_skill_task_post_id;

    if v_anchor_post.status = 'active' then
      update public.barter_skill_task_posts set status = 'offers_received' where id = p_anchor_skill_task_post_id;
      insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
      values (p_anchor_skill_task_post_id, p_proposer_id, 'system', 'post_received_first_offer', 'active', 'offers_received');
    end if;
  end if;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, new_status, metadata, idempotency_key)
  values (v_agreement_id, p_proposer_id, 'party_b', 'barter_proposed', 'proposed', jsonb_build_object('offer_id', v_offer_id), p_idempotency_key);

  v_result := jsonb_build_object(
    'agreement_id', v_agreement_id,
    'agreement_reference', v_reference,
    'offer_id', v_offer_id,
    'status', 'proposed'
  );

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_proposer_id, 'propose_barter', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).
