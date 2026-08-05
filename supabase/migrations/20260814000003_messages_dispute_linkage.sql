-- ============================================================
-- Step 11 Phase 2 -- messages.dispute_id
-- ============================================================
-- A dispute-scoped message still belongs to exactly one booking/order/
-- barter agreement (the existing 3-way messages_one_transaction_chk
-- from Phase 1 is untouched) and OPTIONALLY also gets tagged
-- dispute_id when it's part of dispute-specific chat rather than
-- general transaction chat. General transaction chat doesn't exist yet
-- (Phase 3, not built) -- dispute chat is the first real use of the
-- messages table.
--
-- enforce_dispute_message_consistency() rejects a row where dispute_id
-- is set but doesn't belong to the same booking/order/barter agreement
-- as the message itself -- this cross-row consistency can't be
-- expressed as a plain CHECK constraint, hence the trigger. This is
-- the one place Phase 2 adds a genuinely new trigger rather than
-- reusing an existing one.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter table public.messages
  add column if not exists dispute_id uuid references public.disputes(id);

create index if not exists messages_dispute_idx on public.messages(dispute_id);

create or replace function public.enforce_dispute_message_consistency()
returns trigger
language plpgsql
as $$
declare
  v_dispute record;
begin
  if new.dispute_id is null then
    return new;
  end if;

  select booking_id, order_id, barter_agreement_id into v_dispute
  from public.disputes where id = new.dispute_id;

  if v_dispute is null then
    raise exception 'dispute not found';
  end if;

  if new.booking_id is not null and v_dispute.booking_id is distinct from new.booking_id then
    raise exception 'message.dispute_id does not belong to this message''s booking';
  end if;
  if new.order_id is not null and v_dispute.order_id is distinct from new.order_id then
    raise exception 'message.dispute_id does not belong to this message''s order';
  end if;
  if new.barter_agreement_id is not null and v_dispute.barter_agreement_id is distinct from new.barter_agreement_id then
    raise exception 'message.dispute_id does not belong to this message''s barter agreement';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_enforce_dispute_consistency on public.messages;
create trigger messages_enforce_dispute_consistency
  before insert or update on public.messages
  for each row execute function public.enforce_dispute_message_consistency();
