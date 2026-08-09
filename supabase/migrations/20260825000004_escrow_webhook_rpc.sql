-- ============================================================
-- Phase 3 -- Escrow architecture: webhook intake RPC.
-- Mirrors record_webhook_event() (20260801000004_payment_rpcs.sql)
-- exactly, targeting escrow_provider_events instead of
-- payment_webhook_events.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.record_escrow_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_signature_valid boolean,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_is_duplicate boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not authorized';
  end if;

  begin
    insert into public.escrow_provider_events (provider, provider_event_id, signature_valid, payload)
    values (p_provider, p_provider_event_id, p_signature_valid, p_payload)
    returning id into v_id;
  exception when unique_violation then
    v_is_duplicate := true;
    select id into v_id from public.escrow_provider_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  end;

  return jsonb_build_object('webhook_event_id', v_id, 'is_duplicate', v_is_duplicate);
end;
$$;

revoke all on function public.record_escrow_webhook_event(text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.record_escrow_webhook_event(text, text, boolean, jsonb) to service_role;
