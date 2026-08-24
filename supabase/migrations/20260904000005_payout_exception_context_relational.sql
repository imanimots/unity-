-- Fix-forward correction to 20260904000004_payout_query_scalability.sql.
-- That migration's _merchant_payout_relevant_context(p_booking_ids uuid[])
-- fixed the PostgREST URL/header overflow (moving the id list from a GET
-- filter to an RPC JSON body), but the SET being transferred was still
-- computed in Node from an unbounded, all-time query
-- (`merchant_payouts WHERE status = 'paid'` has no time bound -- 'paid' is
-- terminal, so that set only ever grows). Moving an ever-growing id list
-- from a URL filter to a POST body delays the failure mode, it doesn't
-- remove it.
--
-- Corrected architecture: one relational, PARAMETERLESS RPC that begins
-- from merchant_payouts itself, joins to the authoritative
-- payments/disputes/profiles tables entirely server-side, and applies the
-- exception predicates in the SQL WHERE clause -- not in Node. No
-- id array of any size, still or ever, crosses the RPC boundary in
-- either direction. The returned row set is naturally bounded to
-- "payouts currently exhibiting at least one exceptional condition",
-- which does not grow with total historical payout volume the way "every
-- paid payout ever" does -- it grows only with the number of currently
-- outstanding, unresolved exceptions, which a healthy system keeps small.
--
-- Folds in merchant_payout_paid_without_reference too (a plain
-- provider_reference IS NULL check on 'paid' rows) since it was the
-- third property previously read off the same unbounded `paidPayouts`
-- fetch -- eliminating that fetch requires this predicate to move here
-- as well, or the underlying unbounded query would still exist,
-- unused for two of its three original purposes but still fetched.

drop function if exists public._merchant_payout_relevant_context(uuid[]);

create or replace function public._merchant_payout_exception_candidates()
returns table(
  payout_id uuid,
  booking_id uuid,
  merchant_id uuid,
  status text,
  updated_at timestamptz,
  provider_reference text,
  rental_payment_status text,
  has_blocking_dispute boolean,
  merchant_account_status text
)
language sql
stable
security definer
set search_path = public
as $$
  with context as (
    select
      mp.id as payout_id,
      mp.booking_id,
      mp.merchant_id,
      mp.status,
      mp.updated_at,
      mp.provider_reference,
      p.status as rental_payment_status,
      exists (
        select 1 from public.disputes d
        where d.booking_id = mp.booking_id and d.status not in ('resolved', 'closed', 'cancelled')
      ) as has_blocking_dispute,
      pr.account_status as merchant_account_status
    from public.merchant_payouts mp
    left join public.payments p on p.booking_id = mp.booking_id and p.payment_type = 'rental_charge'
    left join public.profiles pr on pr.id = mp.merchant_id
    where mp.status in ('pending', 'processing', 'paid')
  )
  select
    payout_id, booking_id, merchant_id, status::text, updated_at, provider_reference,
    rental_payment_status::text, has_blocking_dispute, merchant_account_status::text
  from context
  where
    (status in ('pending', 'processing') and (
      (rental_payment_status is not null and rental_payment_status <> 'captured')
      or has_blocking_dispute
      or merchant_account_status in ('suspended', 'restricted')
    ))
    or
    (status = 'paid' and (
      rental_payment_status in ('refunded', 'partially_refunded', 'chargeback')
      or has_blocking_dispute
      or provider_reference is null
    ));
$$;

revoke all on function public._merchant_payout_exception_candidates() from public, anon, authenticated;
grant execute on function public._merchant_payout_exception_candidates() to service_role;
