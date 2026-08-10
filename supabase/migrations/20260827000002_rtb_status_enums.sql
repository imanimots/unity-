-- ============================================================
-- Phase 5 -- Rent-to-Buy: status enums.
-- ============================================================
-- Fresh CREATE TYPE statements -- unlike ALTER TYPE ... ADD VALUE on an
-- existing enum, a brand-new type may be used within the same
-- migration/transaction it's created in (matches
-- 20260810000001_barter_status_enum.sql's own precedent/comment).
--
-- Three independently-tracked state dimensions (Rule E/F -- never
-- conflate agreement status, possession, and ownership):
--   rent_to_buy_agreement_status -- the overall lifecycle.
--   rent_to_buy_possession_status -- has the customer actually taken
--     hold of the item (separate from "may they", which is a payment
--     fact, not a possession fact -- mirrors booking's own
--     financially_ready vs. started distinction).
--   rent_to_buy_ownership_status -- who legally owns the item. Never
--     derived from agreement.status; only ever set by the explicit
--     ownership-transfer RPC (Rule F).
--
-- rent_to_buy_frequency: a closed, merchant-selectable set (Rule 8) --
-- not an arbitrary cron string. Only the frequencies that make
-- operational sense for a physical goods installment schedule.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'rent_to_buy_agreement_status') then
    create type rent_to_buy_agreement_status as enum (
      'pending_merchant_acceptance',
      'awaiting_first_payment',
      'active',
      'defaulted',
      'return_required',
      'completed',
      'cancelled',
      'disputed'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_possession_status') then
    create type rent_to_buy_possession_status as enum (
      'not_delivered',
      'possession_eligible',
      'customer_in_possession',
      'return_required',
      'return_in_progress',
      'returned_to_merchant',
      'recovered'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_ownership_status') then
    create type rent_to_buy_ownership_status as enum (
      'merchant_owned',
      'customer_owned'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_frequency') then
    create type rent_to_buy_frequency as enum ('weekly', 'biweekly', 'monthly');
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_installment_status') then
    create type rent_to_buy_installment_status as enum ('scheduled', 'paid', 'failed', 'waived');
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_return_case_type') then
    create type rent_to_buy_return_case_type as enum ('voluntary_return', 'recovery');
  end if;

  if not exists (select 1 from pg_type where typname = 'rent_to_buy_return_case_status') then
    create type rent_to_buy_return_case_status as enum ('requested', 'scheduled', 'returned', 'recovery_pending', 'recovered', 'cancelled');
  end if;
end $$;
