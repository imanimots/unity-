-- Advertising MVP -- Phase 14: campaign finalization (underdelivery
-- credit) + 90-day raw-event retention purge.
--
-- Underdelivery credit formula (binding, exact):
--   delivered_value_cents = floor(funded_amount_cents * delivered_impressions / purchased_impression_quota)
--   unused_credit_cents   = funded_amount_cents - delivered_value_cents
-- Deterministic integer-cent accounting (bigint intermediate to avoid
-- 32-bit overflow on the multiplication) -- every funded cent is
-- accounted for exactly once, credited to the advertiser's
-- non-withdrawable Advertising Balance. Only applies when a campaign
-- reaches its END DATE without exhausting its quota (quota-reached
-- completion already transitions to 'completed' with zero unused value,
-- inside record_ad_impression) AND was not a voluntary post-activation
-- cancellation (which explicitly gets no underdelivery credit, per
-- cancel_ad_campaign).

create or replace function public.finalize_expired_ad_campaigns(p_actor_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign record;
  v_delivered_value_cents bigint;
  v_unused_credit_cents bigint;
  v_account public.ad_balance_accounts;
  v_new_balance integer;
  v_finalized_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  for v_campaign in
    select * from public.ad_campaigns
    where status in ('active', 'paused')
      and end_at is not null
      and end_at <= now()
    for update skip locked
  loop
    v_delivered_value_cents := (v_campaign.funded_amount_cents::bigint * v_campaign.delivered_impressions) / greatest(v_campaign.snapshot_impression_quota, 1);
    v_unused_credit_cents := v_campaign.funded_amount_cents::bigint - v_delivered_value_cents;
    -- Never credit more than the original funded amount, and never a
    -- negative amount (defensive -- the formula cannot produce either
    -- given delivered_impressions <= snapshot_impression_quota is a
    -- table CHECK constraint, but the guard costs nothing).
    v_unused_credit_cents := greatest(least(v_unused_credit_cents, v_campaign.funded_amount_cents::bigint), 0);

    if v_unused_credit_cents > 0 then
      select * into v_account from public.ad_balance_accounts where advertiser_id = v_campaign.advertiser_id for update;
      v_new_balance := v_account.balance_cents + v_unused_credit_cents::integer;
      update public.ad_balance_accounts set balance_cents = v_new_balance, updated_at = now() where id = v_account.id;
      insert into public.ad_balance_ledger (account_id, campaign_id, entry_type, amount_cents, balance_after_cents, actor_type, actor_id, reason)
      values (v_account.id, v_campaign.id, 'underdelivery_credit', v_unused_credit_cents::integer, v_new_balance, 'system', p_actor_id,
              format('campaign ended at %s with %s of %s impressions delivered', v_campaign.end_at, v_campaign.delivered_impressions, v_campaign.snapshot_impression_quota));
    end if;

    update public.ad_campaigns set status = 'completed', completion_reason = 'end_date_reached', completed_at = now(), updated_at = now()
    where id = v_campaign.id;

    insert into public.ad_campaign_history (campaign_id, actor_type, actor_id, action_type, previous_status, new_status, reason)
    values (v_campaign.id, 'system', p_actor_id, 'end_date_reached', v_campaign.status, 'completed',
            format('unused_credit_cents=%s', v_unused_credit_cents));

    v_finalized_count := v_finalized_count + 1;
  end loop;

  return jsonb_build_object('finalized_count', v_finalized_count);
end;
$$;

revoke all on function public.finalize_expired_ad_campaigns(uuid) from public, anon, authenticated;
grant execute on function public.finalize_expired_ad_campaigns(uuid) to service_role;

-- ── purge_expired_ad_events ── 90-day retention, raw telemetry only ────
-- Never touches ad_balance_ledger / ad_campaign_history / any
-- immutable financial/audit table -- retention applies exclusively to
-- ad_impressions/ad_clicks, matching the binding "90-day retention
-- applies to raw ad telemetry, not financial audit history" rule.
create or replace function public.purge_expired_ad_events()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_impressions_deleted integer;
  v_clicks_deleted integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  delete from public.ad_clicks where clicked_at < now() - interval '90 days';
  get diagnostics v_clicks_deleted = row_count;

  -- Exclude any impression still referenced by a surviving (recent)
  -- click -- a click can, rarely, happen well after its impression, and
  -- ad_clicks.impression_id has no ON DELETE CASCADE (deliberately, so
  -- a click's provenance is never silently severed by a retention sweep).
  delete from public.ad_impressions
  where served_at < now() - interval '90 days'
    and not exists (select 1 from public.ad_clicks where ad_clicks.impression_id = ad_impressions.id);
  get diagnostics v_impressions_deleted = row_count;

  return jsonb_build_object('impressions_deleted', v_impressions_deleted, 'clicks_deleted', v_clicks_deleted);
end;
$$;

revoke all on function public.purge_expired_ad_events() from public, anon, authenticated;
grant execute on function public.purge_expired_ad_events() to service_role;
