-- ============================================================
-- Barter marketplace (Phase 4) — privileged-field protection
-- ============================================================
-- barter_agreements already has zero client write policies (see
-- 20260810000003_barter_schema.sql -- select-only for parties, every
-- mutation goes through a service-role RPC). This trigger is the same
-- belt-and-suspenders defense-in-depth already applied to `bookings`
-- (protect_booking_privileged_fields, 20260730000006_booking_security.sql)
-- in case a future migration ever mistakenly reintroduces a client
-- write policy: INSERT is hard-blocked for non-service-role callers,
-- UPDATE silently reverts every privileged column back to OLD.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

create or replace function public.protect_barter_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    if TG_OP = 'INSERT' then
      raise exception 'barter agreements must be created via the propose_barter RPC, not a direct insert';
    else
      new.agreement_reference     := old.agreement_reference;
      new.anchor_listing_id       := old.anchor_listing_id;
      new.party_a_id              := old.party_a_id;
      new.party_b_id              := old.party_b_id;
      new.status                  := old.status;
      new.current_offer_id        := old.current_offer_id;
      new.accepted_offer_id       := old.accepted_offer_id;
      new.version                 := old.version;
      new.admin_hold              := old.admin_hold;
      new.admin_hold_reason       := old.admin_hold_reason;
      new.proposed_at             := old.proposed_at;
      new.accepted_at             := old.accepted_at;
      new.rejected_at             := old.rejected_at;
      new.rejected_by             := old.rejected_by;
      new.rejection_reason        := old.rejection_reason;
      new.cancelled_at            := old.cancelled_at;
      new.cancelled_by            := old.cancelled_by;
      new.cancellation_reason     := old.cancellation_reason;
      new.cancellation_settlement := old.cancellation_settlement;
      new.expires_at              := old.expires_at;
      new.completed_at            := old.completed_at;
      new.disputed_at             := old.disputed_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_barter_privileged_fields_trg on public.barter_agreements;
create trigger protect_barter_privileged_fields_trg
  before insert or update on public.barter_agreements
  for each row execute procedure public.protect_barter_privileged_fields();
