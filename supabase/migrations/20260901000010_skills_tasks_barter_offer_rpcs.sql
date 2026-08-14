-- ============================================================
-- Skills + Tasks under Barter -- offer/agreement lifecycle RPCs.
-- ============================================================
-- propose_barter()/counter_barter_offer() gain new parameters, which
-- is a genuine PostgreSQL signature change -- both are DROPped by
-- their exact live signature (confirmed immediately before this
-- migration against 20260829000001's bodies, unchanged since
-- 20260810000011) and recreated under the same name with the
-- expanded parameter list, every new parameter defaulted so every
-- existing call shape resolves identically. accept_barter_offer(),
-- confirm_barter_completion(), and activate_listing() keep their
-- exact existing signatures, so they use plain CREATE OR REPLACE.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- Helper: insert skill/task contributions for one side of an offer.
-- Handles provenance validation (R5-1/D6: an existing-post reference
-- must be an AVAILABLE, active post owned by the contributor,
-- matching kind -- a Looking-For post can never be contribution
-- provenance), the full-scope snapshot (never re-read from the post
-- afterward), per-contribution milestone weight validation, and
-- per-party contribution weight validation.
-- ────────────────────────────────────────────────────────────
create or replace function public._insert_barter_skill_task_contributions(
  p_offer_id uuid,
  p_contributions jsonb,
  p_offered_by uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_contrib jsonb;
  v_milestone jsonb;
  v_offer_item_id uuid;
  v_post public.barter_skill_task_posts;
  v_kind text;
  v_title text;
  v_description text;
  v_exclusions text;
  v_materials text;
  v_evidence text;
  v_delivery_mode text;
  v_province text;
  v_city text;
  v_availability text;
  v_start_date date;
  v_start_time time;
  v_deadline date;
  v_duration text;
  v_milestone_weight_sum numeric;
  v_contribution_count int := 0;
  v_running_weight_sum numeric := 0;
  v_milestone_texts text[];
begin
  if p_contributions is null then
    return;
  end if;

  for v_contrib in select * from jsonb_array_elements(p_contributions) loop
    v_kind := v_contrib->>'kind';
    if v_kind not in ('skill', 'task') then
      raise exception 'invalid contribution kind: %', v_kind;
    end if;

    if (v_contrib ? 'skill_task_post_id') and (v_contrib->>'skill_task_post_id') is not null then
      select * into v_post from public.barter_skill_task_posts where id = (v_contrib->>'skill_task_post_id')::uuid;
      if v_post is null then
        raise exception 'referenced Skill/Task post not found';
      end if;
      if v_post.direction <> 'available' then
        raise exception 'a Looking-For post cannot be used as contribution provenance -- only reusable Available Skill/Task supply can be offered';
      end if;
      if v_post.status <> 'active' then
        raise exception 'referenced Skill/Task supply is not currently active';
      end if;
      if v_post.owner_id <> p_offered_by then
        raise exception 'referenced Skill/Task supply does not belong to the contributing party';
      end if;
      if v_post.kind <> v_kind then
        raise exception 'referenced Skill/Task supply kind does not match the contribution kind';
      end if;

      v_title := coalesce(v_contrib->>'title', v_post.title);
      v_description := coalesce(v_contrib->>'description', v_post.description);
      v_exclusions := coalesce(v_contrib->>'exclusions', v_post.exclusions);
      v_materials := coalesce(v_contrib->>'materials_arrangement', v_post.materials_arrangement);
      v_evidence := coalesce(v_contrib->>'evidence_expectations', v_post.evidence_expectations);
      v_delivery_mode := coalesce(v_contrib->>'delivery_mode', v_post.delivery_mode);
      v_province := coalesce(v_contrib->>'province', v_post.province);
      v_city := coalesce(v_contrib->>'city', v_post.city);
      v_availability := coalesce(v_contrib->>'availability_notes', v_post.availability_notes);
      v_start_date := coalesce(nullif(v_contrib->>'preferred_start_date', '')::date, v_post.preferred_start_date);
      v_start_time := coalesce(nullif(v_contrib->>'preferred_start_time', '')::time, v_post.preferred_start_time);
      v_deadline := coalesce(nullif(v_contrib->>'deadline', '')::date, v_post.deadline);
      v_duration := coalesce(v_contrib->>'expected_duration_notes', v_post.expected_duration_notes);
    else
      if v_contrib->>'title' is null then
        raise exception 'a private/custom contribution requires a title';
      end if;
      v_title := v_contrib->>'title';
      v_description := v_contrib->>'description';
      v_exclusions := v_contrib->>'exclusions';
      v_materials := v_contrib->>'materials_arrangement';
      v_evidence := v_contrib->>'evidence_expectations';
      v_delivery_mode := v_contrib->>'delivery_mode';
      v_province := v_contrib->>'province';
      v_city := v_contrib->>'city';
      v_availability := v_contrib->>'availability_notes';
      v_start_date := nullif(v_contrib->>'preferred_start_date', '')::date;
      v_start_time := nullif(v_contrib->>'preferred_start_time', '')::time;
      v_deadline := nullif(v_contrib->>'deadline', '')::date;
      v_duration := v_contrib->>'expected_duration_notes';
    end if;

    perform public._validate_skill_task_content(array[v_title, v_description, v_exclusions, v_materials, v_evidence, v_availability]);

    if not (v_contrib ? 'contribution_weight_percent') or (v_contrib->>'contribution_weight_percent') is null then
      raise exception 'contribution_weight_percent is required for a skill/task contribution';
    end if;

    insert into public.barter_offer_items (offer_id, kind, listing_id, skill_task_post_id, contribution_weight_percent, offered_by)
    values (
      p_offer_id, v_kind, null,
      nullif(v_contrib->>'skill_task_post_id', '')::uuid,
      (v_contrib->>'contribution_weight_percent')::numeric,
      p_offered_by
    )
    returning id into v_offer_item_id;

    insert into public.barter_contribution_details (
      offer_item_id, title, description, exclusions, materials_arrangement, evidence_expectations,
      delivery_mode, province, city, availability_notes, preferred_start_date, preferred_start_time, deadline, expected_duration_notes
    ) values (
      v_offer_item_id, v_title, v_description, v_exclusions, v_materials, v_evidence,
      v_delivery_mode, v_province, v_city, v_availability, v_start_date, v_start_time, v_deadline, v_duration
    );

    if not (v_contrib ? 'milestones') or jsonb_array_length(v_contrib->'milestones') = 0 then
      raise exception 'at least one milestone is required per Skill/Task contribution';
    end if;

    select sum((m->>'weight_percent')::numeric) into v_milestone_weight_sum from jsonb_array_elements(v_contrib->'milestones') as m;
    if v_milestone_weight_sum is distinct from 100 then
      raise exception 'milestone weights for a contribution must sum to exactly 100, got %', v_milestone_weight_sum;
    end if;

    select array_agg(coalesce(m->>'title', '') || ' ' || coalesce(m->>'description', ''))
    into v_milestone_texts
    from jsonb_array_elements(v_contrib->'milestones') as m;
    perform public._validate_skill_task_content(v_milestone_texts);

    for v_milestone in select * from jsonb_array_elements(v_contrib->'milestones') loop
      insert into public.barter_contribution_milestones (
        offer_item_id, title, description, sequence, weight_percent, delivery_mode, scheduled_at, scheduled_city, scheduled_province
      ) values (
        v_offer_item_id, v_milestone->>'title', v_milestone->>'description',
        (v_milestone->>'sequence')::int, (v_milestone->>'weight_percent')::numeric,
        coalesce(v_milestone->>'delivery_mode', v_delivery_mode),
        nullif(v_milestone->>'scheduled_at', '')::timestamptz, v_milestone->>'scheduled_city', v_milestone->>'scheduled_province'
      );
    end loop;

    v_running_weight_sum := v_running_weight_sum + (v_contrib->>'contribution_weight_percent')::numeric;
    v_contribution_count := v_contribution_count + 1;
  end loop;

  if v_contribution_count > 0 and v_running_weight_sum is distinct from 100 then
    raise exception 'contribution weights for this party must sum to exactly 100 across their Skill/Task contributions, got %', v_running_weight_sum;
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Helper: insert deposit terms for an offer. Payer/amount/currency/
-- release_basis validated here; the legacy-vs-new authority
-- invariant (nulling the legacy fields) is enforced by the calling
-- RPC, since it operates on barter_offers, not this table.
-- ────────────────────────────────────────────────────────────
create or replace function public._insert_barter_deposit_terms(
  p_offer_id uuid,
  p_deposit_terms jsonb,
  p_party_a_id uuid,
  p_party_b_id uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_term jsonb;
  v_payer uuid;
  v_release_basis text;
  v_has_secured_contribution boolean;
begin
  if p_deposit_terms is null then
    return;
  end if;

  for v_term in select * from jsonb_array_elements(p_deposit_terms) loop
    v_payer := (v_term->>'payer_id')::uuid;
    v_release_basis := v_term->>'release_basis';

    if v_payer <> p_party_a_id and v_payer <> p_party_b_id then
      raise exception 'deposit payer must be a party to the agreement';
    end if;
    if v_release_basis not in ('full_on_completion', 'milestone_weighted') then
      raise exception 'invalid release_basis: %', v_release_basis;
    end if;

    if v_release_basis = 'milestone_weighted' then
      select exists (
        select 1 from public.barter_offer_items where offer_id = p_offer_id and offered_by = v_payer and kind in ('skill', 'task')
      ) into v_has_secured_contribution;
      if not v_has_secured_contribution then
        raise exception 'a milestone_weighted deposit requires a secured Skill/Task contribution from the payer';
      end if;
    end if;

    insert into public.barter_deposit_terms (offer_id, payer_id, amount, currency, release_basis)
    values (p_offer_id, v_payer, (v_term->>'amount')::numeric, coalesce(v_term->>'currency', 'ZAR'), v_release_basis);
  end loop;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- propose_barter -- DROP the exact old signature, CREATE the
-- expanded one. p_anchor_listing_id is now nullable (every existing
-- caller still passes a real value, unaffected); exactly one of
-- p_anchor_listing_id / p_anchor_skill_task_post_id must be provided.
-- An anchor Skill/Task post plays the same role for Skill/Task that
-- an anchor listing already plays for items (identifies party_a,
-- purely informational/discovery -- not automatically a
-- contribution, matching the item precedent exactly). When the
-- anchor post's direction is 'looking_for', its id is additionally
-- recorded as source_skill_task_post_id (the Looking-For linkage,
-- D7/§7) and the offer must satisfy the source's kind (O).
-- ────────────────────────────────────────────────────────────
drop function public.propose_barter(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text);

create function public.propose_barter(
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
    agreement_reference, anchor_listing_id, source_skill_task_post_id, party_a_id, party_b_id, status, expires_at
  ) values (
    v_reference, p_anchor_listing_id,
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

revoke all on function public.propose_barter(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.propose_barter(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text, uuid, jsonb, jsonb, jsonb) to service_role;

-- ────────────────────────────────────────────────────────────
-- counter_barter_offer -- same DROP+CREATE treatment, same new
-- parameters. A counter creates an entirely new offer version (the
-- existing "full replacement package" convention) -- new
-- contribution/deposit-term rows, never mutating the prior version's.
-- ────────────────────────────────────────────────────────────
drop function public.counter_barter_offer(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text);

create function public.counter_barter_offer(
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

  perform public.validate_barter_offer_side(p_party_a_listing_ids, v_agreement.party_a_id, 'requested');
  perform public.validate_barter_offer_side(p_party_b_listing_ids, v_agreement.party_b_id, 'offered');

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
grant execute on function public.counter_barter_offer(uuid, uuid, uuid[], uuid[], numeric, uuid, text, text, text, boolean, numeric, text, text, text, int, text, jsonb, jsonb, jsonb) to service_role;

-- ────────────────────────────────────────────────────────────
-- accept_barter_offer -- CREATE OR REPLACE, unchanged signature.
-- New: (1) final-acceptance revalidation of every skill_task_post_id
-- contribution (an Available supply paused/suspended/archived
-- between proposal and acceptance fails acceptance atomically
-- without deleting the historical proposal); (2) if this agreement
-- has a source_skill_task_post_id, lock that row, reject if no
-- longer active/offers_received (the one-winner race serialization
-- point), flip it to 'matched', and auto-cancel every other open
-- agreement referencing the same source post -- reusing the exact
-- pattern of the existing locked-listing auto-cancel loop below, now
-- generalized to also cover the source-post case; (3) deposit
-- creation branches on barter_deposit_terms when present, falling
-- back to the unchanged legacy single-field path otherwise.
-- ────────────────────────────────────────────────────────────
create or replace function public.accept_barter_offer(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_provider text default 'mock',
  p_idempotency_key text default null
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
  v_conflict record;
  v_result jsonb;
  v_source_post public.barter_skill_task_posts;
  v_contribution record;
  v_post public.barter_skill_task_posts;
  v_deposit_term record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_provider, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'accept_barter_offer' and idempotency_key = p_idempotency_key;
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
    raise exception 'this offer can no longer be accepted';
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

  -- Final-acceptance revalidation of every Available-supply reference.
  for v_contribution in
    select skill_task_post_id, offered_by, kind from public.barter_offer_items
    where offer_id = v_current_offer.id and skill_task_post_id is not null
  loop
    select * into v_post from public.barter_skill_task_posts where id = v_contribution.skill_task_post_id;
    if v_post is null or v_post.direction <> 'available' or v_post.status <> 'active'
       or v_post.owner_id <> v_contribution.offered_by or v_post.kind <> v_contribution.kind then
      raise exception 'a Skill/Task supply referenced by this offer is no longer available for acceptance -- it may have been paused, suspended, or archived since this offer was made';
    end if;
  end loop;

  -- One-winner race serialization for a Looking-For source post.
  if v_agreement.source_skill_task_post_id is not null then
    select * into v_source_post from public.barter_skill_task_posts where id = v_agreement.source_skill_task_post_id for update;
    if v_source_post.status not in ('active', 'offers_received') then
      raise exception 'the originating request is no longer open (%) -- another offer may already have been accepted', v_source_post.status;
    end if;
    update public.barter_skill_task_posts set status = 'matched' where id = v_agreement.source_skill_task_post_id;
    insert into public.barter_skill_task_post_history (post_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (v_agreement.source_skill_task_post_id, p_actor_user_id, 'system', 'post_matched', v_source_post.status, 'matched');
  end if;

  update public.barter_offers set status = 'accepted' where id = v_current_offer.id;

  update public.barter_agreements set
    status = 'accepted',
    accepted_offer_id = v_current_offer.id,
    accepted_at = now()
  where id = p_agreement_id;

  -- Deposits: barter_deposit_terms rows are authoritative when
  -- present; otherwise the unchanged legacy single-field path runs.
  if exists (select 1 from public.barter_deposit_terms where offer_id = v_current_offer.id) then
    for v_deposit_term in select * from public.barter_deposit_terms where offer_id = v_current_offer.id loop
      perform public.create_barter_payment_intent(
        p_agreement_id, v_deposit_term.payer_id,
        case when v_deposit_term.payer_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
        'barter_deposit', v_deposit_term.amount, v_deposit_term.currency, p_provider
      );
    end loop;
  elsif v_current_offer.deposit_required then
    if v_current_offer.deposit_payer in ('party_a', 'both') then
      perform public.create_barter_payment_intent(
        p_agreement_id, v_agreement.party_a_id, v_agreement.party_b_id,
        'barter_deposit', v_current_offer.deposit_amount, v_current_offer.deposit_currency, p_provider
      );
    end if;
    if v_current_offer.deposit_payer in ('party_b', 'both') then
      perform public.create_barter_payment_intent(
        p_agreement_id, v_agreement.party_b_id, v_agreement.party_a_id,
        'barter_deposit', v_current_offer.deposit_amount, v_current_offer.deposit_currency, p_provider
      );
    end if;
  end if;

  if v_current_offer.cash_adjustment_amount > 0 then
    perform public.create_barter_payment_intent(
      p_agreement_id,
      v_current_offer.cash_adjustment_payer,
      case when v_current_offer.cash_adjustment_payer = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end,
      'barter_cash_adjustment', v_current_offer.cash_adjustment_amount, v_current_offer.deposit_currency, p_provider
    );
  end if;

  -- Strict milestone sequencing at acceptance: for each skill/task
  -- contribution, the lowest-sequence milestone becomes active, every
  -- later one stays pending (the partial unique index guarantees at
  -- most one active per contribution at the database level).
  update public.barter_contribution_milestones m
  set status = 'active'
  from (
    select distinct on (offer_item_id) id, offer_item_id
    from public.barter_contribution_milestones
    where offer_item_id in (select id from public.barter_offer_items where offer_id = v_current_offer.id)
    order by offer_item_id, sequence asc
  ) first_milestone
  where m.id = first_milestone.id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_accepted', v_agreement.status, 'accepted', jsonb_build_object('offer_id', v_current_offer.id), p_idempotency_key
  );

  -- Auto-cancel any OTHER still-open proposal referencing a listing
  -- now locked by this acceptance.
  for v_conflict in
    select distinct ba.id
    from public.barter_agreements ba
    join public.barter_offers bo on bo.id = ba.current_offer_id
    join public.barter_offer_items boi on boi.offer_id = bo.id
    where ba.id <> p_agreement_id
      and ba.status in ('proposed', 'countered')
      and boi.listing_id in (
        select listing_id from public.barter_offer_items where offer_id = v_current_offer.id and listing_id is not null
      )
  loop
    update public.barter_agreements
    set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'A conflicting barter agreement involving one of the offered listings was accepted', cancellation_settlement = 'not_applicable'
    where id = v_conflict.id;

    insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
    values (v_conflict.id, null, 'system', 'barter_auto_cancelled_listing_locked', 'proposed', 'cancelled', jsonb_build_object('locked_by_agreement_id', p_agreement_id));
  end loop;

  -- Same auto-cancel, generalized to the Looking-For source-post case.
  if v_agreement.source_skill_task_post_id is not null then
    for v_conflict in
      select id from public.barter_agreements
      where id <> p_agreement_id
        and source_skill_task_post_id = v_agreement.source_skill_task_post_id
        and status in ('proposed', 'countered')
    loop
      update public.barter_agreements
      set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'A different offer against the same request was accepted', cancellation_settlement = 'not_applicable'
      where id = v_conflict.id;

      insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata)
      values (v_conflict.id, null, 'system', 'barter_auto_cancelled_source_matched', 'proposed', 'cancelled', jsonb_build_object('matched_agreement_id', p_agreement_id));
    end loop;
  end if;

  v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'accepted');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'accept_barter_offer', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).

-- ────────────────────────────────────────────────────────────
-- mark_barter_contribution_milestone_completed -- the responsible
-- party (offer_item.offered_by) marks their currently ACTIVE
-- milestone done. Validates the milestone belongs to the agreement's
-- accepted offer version (never a rejected/superseded/never-accepted
-- one), blocks completion of an in-person milestone until both
-- parties have confirmed its schedule, blocks while the agreement is
-- disputed/on hold, activates the next-lowest-sequence pending
-- milestone in the same transaction, and computes (never acts on)
-- deposit-release eligibility -- no escrow/payment RPC is ever
-- called from here in this phase.
-- ────────────────────────────────────────────────────────────
create or replace function public.mark_barter_contribution_milestone_completed(
  p_actor_user_id uuid,
  p_milestone_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_hash text;
  v_idem record;
  v_milestone public.barter_contribution_milestones;
  v_offer_item public.barter_offer_items;
  v_agreement record;
  v_next_milestone_id uuid;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_milestone_id::text, ''));
  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'mark_barter_contribution_milestone_completed' and idempotency_key = p_idempotency_key;
    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select * into v_milestone from public.barter_contribution_milestones where id = p_milestone_id for update;
  if v_milestone is null then
    raise exception 'milestone not found';
  end if;

  select * into v_offer_item from public.barter_offer_items where id = v_milestone.offer_item_id;
  select ba.* into v_agreement from public.barter_agreements ba where ba.id = (
    select agreement_id from public.barter_offers where id = v_offer_item.offer_id
  );

  if v_agreement.accepted_offer_id is null or v_offer_item.offer_id <> v_agreement.accepted_offer_id then
    raise exception 'this milestone does not belong to the accepted offer and cannot be acted on';
  end if;
  if v_agreement.admin_hold then
    raise exception 'this barter agreement is currently suspended by an administrator';
  end if;
  if v_agreement.status = 'disputed' then
    raise exception 'this agreement is currently disputed and cannot progress until it is resolved';
  end if;
  if v_offer_item.offered_by <> p_actor_user_id then
    raise exception 'only the responsible party may mark this milestone completed';
  end if;

  if v_milestone.status = 'completed' then
    v_result := jsonb_build_object('milestone_id', p_milestone_id, 'status', 'completed', 'idempotent_replay', true);
    if p_idempotency_key is not null then
      insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
      values (p_actor_user_id, 'mark_barter_contribution_milestone_completed', p_idempotency_key, v_request_hash, v_result);
    end if;
    return v_result;
  end if;
  if v_milestone.status <> 'active' then
    raise exception 'only the currently active milestone can be completed -- a future milestone cannot be completed out of order';
  end if;

  if v_milestone.delivery_mode = 'in_person' then
    if not (v_agreement.party_a_id = any(v_milestone.schedule_confirmed_by) and v_agreement.party_b_id = any(v_milestone.schedule_confirmed_by)) then
      raise exception 'both parties must mutually confirm the date, time, and location before this in-person milestone can be completed';
    end if;
  end if;

  update public.barter_contribution_milestones
  set status = 'completed', completed_at = now()
  where id = p_milestone_id;

  insert into public.barter_milestone_history (milestone_id, agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
  values (
    p_milestone_id, v_agreement.id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'milestone_completed', 'active', 'completed', p_idempotency_key
  );

  select id into v_next_milestone_id
  from public.barter_contribution_milestones
  where offer_item_id = v_milestone.offer_item_id and status = 'pending'
  order by sequence asc
  limit 1;

  if v_next_milestone_id is not null then
    update public.barter_contribution_milestones set status = 'active' where id = v_next_milestone_id;
    insert into public.barter_milestone_history (milestone_id, agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status)
    values (v_next_milestone_id, v_agreement.id, null, 'system', 'milestone_activated', 'pending', 'active');
  end if;

  v_result := jsonb_build_object('milestone_id', p_milestone_id, 'status', 'completed', 'next_milestone_id', v_next_milestone_id);

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'mark_barter_contribution_milestone_completed', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- In-person schedule propose/confirm. Both reject a change once the
-- milestone is completed (D3/S -- a completed milestone's contract
-- terms are frozen) and validate the milestone belongs to the
-- accepted offer version (R).
-- ────────────────────────────────────────────────────────────
create or replace function public.propose_milestone_schedule(
  p_actor_user_id uuid,
  p_milestone_id uuid,
  p_scheduled_at timestamptz,
  p_scheduled_city text,
  p_scheduled_province text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_milestone public.barter_contribution_milestones;
  v_offer_item public.barter_offer_items;
  v_agreement record;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_milestone from public.barter_contribution_milestones where id = p_milestone_id for update;
  if v_milestone is null then raise exception 'milestone not found'; end if;
  if v_milestone.status = 'completed' then
    raise exception 'this milestone is already completed -- its schedule cannot be changed';
  end if;

  select * into v_offer_item from public.barter_offer_items where id = v_milestone.offer_item_id;
  select ba.* into v_agreement from public.barter_agreements ba where ba.id = (
    select agreement_id from public.barter_offers where id = v_offer_item.offer_id
  );
  if v_agreement.accepted_offer_id is null or v_offer_item.offer_id <> v_agreement.accepted_offer_id then
    raise exception 'this milestone does not belong to the accepted offer';
  end if;
  if v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id then
    raise exception 'you are not a party to this agreement';
  end if;
  if v_agreement.status = 'disputed' then
    raise exception 'this agreement is currently disputed and cannot progress until it is resolved';
  end if;

  update public.barter_contribution_milestones
  set scheduled_at = p_scheduled_at, scheduled_city = p_scheduled_city, scheduled_province = p_scheduled_province,
      schedule_confirmed_by = array[p_actor_user_id]
  where id = p_milestone_id;

  insert into public.barter_milestone_history (milestone_id, agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_milestone_id, v_agreement.id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'schedule_proposed', v_milestone.status, v_milestone.status,
    jsonb_build_object('previous_scheduled_at', v_milestone.scheduled_at, 'new_scheduled_at', p_scheduled_at, 'city', p_scheduled_city, 'province', p_scheduled_province),
    p_idempotency_key
  );

  return jsonb_build_object('milestone_id', p_milestone_id, 'scheduled_at', p_scheduled_at, 'schedule_confirmed_by', array[p_actor_user_id]);
end;
$$;

create or replace function public.confirm_milestone_schedule(
  p_actor_user_id uuid,
  p_milestone_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_milestone public.barter_contribution_milestones;
  v_offer_item public.barter_offer_items;
  v_agreement record;
  v_confirmed uuid[];
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;

  select * into v_milestone from public.barter_contribution_milestones where id = p_milestone_id for update;
  if v_milestone is null then raise exception 'milestone not found'; end if;
  if v_milestone.status = 'completed' then
    raise exception 'this milestone is already completed -- its schedule cannot be changed';
  end if;

  select * into v_offer_item from public.barter_offer_items where id = v_milestone.offer_item_id;
  select ba.* into v_agreement from public.barter_agreements ba where ba.id = (
    select agreement_id from public.barter_offers where id = v_offer_item.offer_id
  );
  if v_agreement.accepted_offer_id is null or v_offer_item.offer_id <> v_agreement.accepted_offer_id then
    raise exception 'this milestone does not belong to the accepted offer';
  end if;
  if v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id then
    raise exception 'you are not a party to this agreement';
  end if;

  v_confirmed := v_milestone.schedule_confirmed_by;
  if not (p_actor_user_id = any(v_confirmed)) then
    v_confirmed := array_append(v_confirmed, p_actor_user_id);
    update public.barter_contribution_milestones set schedule_confirmed_by = v_confirmed where id = p_milestone_id;

    insert into public.barter_milestone_history (milestone_id, agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, idempotency_key)
    values (
      p_milestone_id, v_agreement.id, p_actor_user_id,
      case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
      'schedule_confirmed', v_milestone.status, v_milestone.status, p_idempotency_key
    );
  end if;

  return jsonb_build_object('milestone_id', p_milestone_id, 'schedule_confirmed_by', v_confirmed);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- create_barter_review -- the first real review-creation path in
-- this codebase. Reviews are OPTIONAL after overall completion --
-- never required, never blocking any other lifecycle action.
-- ────────────────────────────────────────────────────────────
create or replace function public.create_barter_review(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_rating smallint,
  p_comment text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agreement record;
  v_reviewee_id uuid;
  v_review_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not authorized'; end if;
  if p_actor_user_id is null then raise exception 'not authenticated'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'rating must be between 1 and 5'; end if;

  select * into v_agreement from public.barter_agreements where id = p_agreement_id;
  if v_agreement.id is null or (v_agreement.party_a_id <> p_actor_user_id and v_agreement.party_b_id <> p_actor_user_id) then
    raise exception 'barter agreement not found or you are not a party to it';
  end if;
  if v_agreement.status <> 'completed' then
    raise exception 'this barter agreement has not been completed yet';
  end if;

  v_reviewee_id := case when p_actor_user_id = v_agreement.party_a_id then v_agreement.party_b_id else v_agreement.party_a_id end;

  insert into public.reviews (barter_agreement_id, reviewer_id, reviewee_id, rating, comment)
  values (p_agreement_id, p_actor_user_id, v_reviewee_id, p_rating, p_comment)
  on conflict (barter_agreement_id, reviewer_id) do nothing
  returning id into v_review_id;

  if v_review_id is null then
    select id into v_review_id from public.reviews where barter_agreement_id = p_agreement_id and reviewer_id = p_actor_user_id;
  end if;

  return jsonb_build_object('review_id', v_review_id);
end;
$$;

revoke all on function public.mark_barter_contribution_milestone_completed(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.propose_milestone_schedule(uuid, uuid, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.confirm_milestone_schedule(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.create_barter_review(uuid, uuid, smallint, text, text) from public, anon, authenticated;

grant execute on function public.mark_barter_contribution_milestone_completed(uuid, uuid, text) to service_role;
grant execute on function public.propose_milestone_schedule(uuid, uuid, timestamptz, text, text, text) to service_role;
grant execute on function public.confirm_milestone_schedule(uuid, uuid, text) to service_role;
grant execute on function public.create_barter_review(uuid, uuid, smallint, text, text) to service_role;

-- ────────────────────────────────────────────────────────────
-- confirm_barter_completion -- CREATE OR REPLACE, unchanged
-- signature. Additive gate only: dual-confirmation reaching 2 is now
-- necessary but not sufficient -- every milestone belonging to the
-- accepted offer must also be 'completed'. Vacuously satisfied for a
-- pure item-only agreement (zero milestone rows), so every existing
-- item-barter regression check is unaffected. Reviews are never
-- checked here -- review submission never gates completion.
-- ────────────────────────────────────────────────────────────
create or replace function public.confirm_barter_completion(
  p_actor_user_id uuid,
  p_agreement_id uuid,
  p_confirmation_note text default null,
  p_idempotency_key text default null
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
  v_confirmation_count int;
  v_milestones_incomplete boolean;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_actor_user_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_agreement_id::text, '') || '|' || coalesce(p_confirmation_note, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_actor_user_id and operation = 'confirm_barter_completion' and idempotency_key = p_idempotency_key;

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
  if v_agreement.status = 'disputed' then
    raise exception 'this agreement is currently disputed and cannot be completed until it is resolved';
  end if;
  if v_agreement.status <> 'awaiting_confirmation' then
    raise exception 'this agreement is not yet awaiting completion confirmation';
  end if;

  insert into public.barter_confirmations (agreement_id, party_id, confirmation_note)
  values (p_agreement_id, p_actor_user_id, p_confirmation_note)
  on conflict (agreement_id, party_id) do nothing;

  select count(*) into v_confirmation_count from public.barter_confirmations where agreement_id = p_agreement_id;

  insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status, metadata, idempotency_key)
  values (
    p_agreement_id, p_actor_user_id,
    case when p_actor_user_id = v_agreement.party_a_id then 'party_a' else 'party_b' end,
    'barter_completion_confirmed', v_agreement.status, v_agreement.status,
    jsonb_build_object('confirmations_count', v_confirmation_count), p_idempotency_key
  );

  if v_confirmation_count >= 2 then
    select exists (
      select 1 from public.barter_contribution_milestones m
      join public.barter_offer_items boi on boi.id = m.offer_item_id
      where boi.offer_id = v_agreement.accepted_offer_id and m.status <> 'completed'
    ) into v_milestones_incomplete;

    if v_milestones_incomplete then
      v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_confirmation', 'confirmations_count', v_confirmation_count, 'blocked_by', 'incomplete_milestones');
    else
      update public.barter_agreements set status = 'completed', completed_at = now() where id = p_agreement_id;

      insert into public.barter_history (agreement_id, actor_user_id, actor_role, event_type, previous_status, new_status)
      values (p_agreement_id, null, 'system', 'barter_completed', 'awaiting_confirmation', 'completed');

      v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'completed', 'confirmations_count', v_confirmation_count);
    end if;
  else
    v_result := jsonb_build_object('agreement_id', p_agreement_id, 'status', 'awaiting_confirmation', 'confirmations_count', v_confirmation_count);
  end if;

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_actor_user_id, 'confirm_barter_completion', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).

-- ────────────────────────────────────────────────────────────
-- activate_listing -- CREATE OR REPLACE, unchanged signature. The
-- inline cap-count query is replaced with the shared, row-locked
-- _lock_and_count_active_supply() helper -- now genuinely combined
-- with Skill/Task Available supply, and concurrency-safe against a
-- simultaneous publish/resume/restore on the same user's Skill/Task
-- side.
-- ────────────────────────────────────────────────────────────
create or replace function public.activate_listing(
  p_listing_id uuid,
  p_admin_id uuid,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_request_hash text;
  v_idem record;
  v_listing_status listing_status;
  v_moderation_status moderation_status;
  v_merchant_id uuid;
  v_is_test boolean;
  v_plan_id text;
  v_listing_limit integer;
  v_active_count integer;
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;
  if p_admin_id is null then
    raise exception 'not authenticated';
  end if;

  v_request_hash := md5(coalesce(p_listing_id::text, ''));

  if p_idempotency_key is not null then
    select request_hash, result into v_idem
    from public.idempotency_keys
    where merchant_id = p_admin_id and operation = 'activate_listing' and idempotency_key = p_idempotency_key;

    if found then
      if v_idem.request_hash is distinct from v_request_hash then
        raise exception 'idempotency key already used with a different request';
      end if;
      return v_idem.result;
    end if;
  end if;

  select status, merchant_id, is_test into v_listing_status, v_merchant_id, v_is_test
  from public.listings where id = p_listing_id;
  if v_listing_status is null then
    raise exception 'listing not found';
  end if;
  if v_listing_status not in ('pending', 'suspended') then
    raise exception 'listing status "%" is not eligible for activation', v_listing_status;
  end if;

  select moderation_status into v_moderation_status
  from public.listing_moderation where listing_id = p_listing_id;

  if v_moderation_status is distinct from 'approved' then
    raise exception 'listing has not been approved by moderation';
  end if;

  -- Starter active-supply cap -- real listings only, never test
  -- fixtures. _lock_and_count_active_supply() takes the shared
  -- profile-row lock and returns the COMBINED listings + Available
  -- Skill/Task count, so this serializes correctly against a
  -- concurrent Skill/Task publish/resume/restore by the same user.
  if not v_is_test then
    v_plan_id := public._get_effective_merchant_plan_id(v_merchant_id);
    select active_listing_limit into v_listing_limit from public.merchant_subscription_plans where id = v_plan_id;

    if v_listing_limit is not null then
      -- The listing being activated is always currently
      -- pending/suspended (never 'active') per the guard above, so it
      -- is never itself counted by the active=true filter below --
      -- matching the original query's own (redundant) id<>p_listing_id
      -- exclusion exactly.
      v_active_count := public._lock_and_count_active_supply(v_merchant_id);

      if v_active_count >= v_listing_limit then
        raise exception 'active_listing_limit_reached: the % plan allows up to % active listings', v_plan_id, v_listing_limit;
      end if;
    end if;
  end if;

  update public.listings set status = 'active' where id = p_listing_id;

  insert into public.listing_history (listing_id, changed_by, old_values, new_values, change_reason)
  values (
    p_listing_id, p_admin_id,
    jsonb_build_object('listing_status', v_listing_status),
    jsonb_build_object('listing_status', 'active'),
    'listing_activated'
  );

  insert into public.admin_action_history (listing_id, action_type, admin_id, previous_status, new_status)
  values (p_listing_id, 'listing_activated', p_admin_id, v_listing_status::text, 'active');

  v_result := jsonb_build_object('listing_id', p_listing_id, 'status', 'active');

  if p_idempotency_key is not null then
    insert into public.idempotency_keys (merchant_id, operation, idempotency_key, request_hash, result)
    values (p_admin_id, 'activate_listing', p_idempotency_key, v_request_hash, v_result);
  end if;

  return v_result;
end;
$$;
-- create or replace preserves the existing grants (service_role only).
