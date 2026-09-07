-- ============================================================
-- P2 -- widen dispute-evidence storage.objects policies for RTB
-- ============================================================
-- 20260814000005_dispute_evidence.sql's two "participant" storage
-- policies (read/upload on the dispute-evidence bucket) authorize via
-- inline joins to bookings/orders/barter_agreements only. When RTB
-- disputes were added (20260827000004_rtb_widening.sql), the DATABASE
-- metadata policy ("dispute_evidence: parties read") was correctly
-- widened by widening the shared is_dispute_participant() function --
-- but these two STORAGE policies duplicate that join logic inline
-- rather than calling the shared function, so they were never updated
-- and still have no rent_to_buy_agreements branch.
--
-- Effect (confirmed live): the RTB dispute's raiser accidentally still
-- works (d.raised_by = auth.uid() is transaction-type-agnostic), but
-- the genuine RTB counterparty -- a real party via
-- rent_to_buy_agreements.merchant_id/customer_id who did not raise the
-- dispute -- is denied both upload and read of their own dispute's
-- evidence. Fails closed (no cross-tenant leak), but blocks half of
-- every RTB dispute's evidence flow.
--
-- Fix: add the exact same rent_to_buy_agreements branch already
-- proven correct in is_dispute_participant() (mirrored, not
-- reinvented) to both policies. Every existing predicate (raiser,
-- booking, order, barter) is preserved verbatim -- purely additive.
-- Path-prefix authority (dispute id / uploader uid segments), the
-- admin read policy, bucket config (private, 10MB,
-- image/jpeg|png|webp + application/pdf), the DB dispute_evidence
-- policies, the rent-to-buy-evidence bucket's own policies, and
-- is_dispute_participant() itself are all untouched by this migration.
-- ============================================================

drop policy if exists "storage dispute-evidence: participant read" on storage.objects;
create policy "storage dispute-evidence: participant read"
  on storage.objects for select
  using (
    bucket_id = 'dispute-evidence'
    and exists (
      select 1 from public.disputes d
      left join public.bookings b on b.id = d.booking_id
      left join public.orders o on o.id = d.order_id
      left join public.barter_agreements ba on ba.id = d.barter_agreement_id
      left join public.rent_to_buy_agreements rtb on rtb.id = d.rent_to_buy_agreement_id
      where d.id::text = (storage.foldername(name))[1]
        and (
          d.raised_by = auth.uid()
          or b.renter_id = auth.uid() or b.merchant_id = auth.uid()
          or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
          or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
          or rtb.merchant_id = auth.uid() or rtb.customer_id = auth.uid()
        )
    )
  );

drop policy if exists "storage dispute-evidence: participant upload" on storage.objects;
create policy "storage dispute-evidence: participant upload"
  on storage.objects for insert
  with check (
    bucket_id = 'dispute-evidence'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.disputes d
      left join public.bookings b on b.id = d.booking_id
      left join public.orders o on o.id = d.order_id
      left join public.barter_agreements ba on ba.id = d.barter_agreement_id
      left join public.rent_to_buy_agreements rtb on rtb.id = d.rent_to_buy_agreement_id
      where d.id::text = (storage.foldername(name))[1]
        and (
          d.raised_by = auth.uid()
          or b.renter_id = auth.uid() or b.merchant_id = auth.uid()
          or o.buyer_id = auth.uid() or o.seller_id = auth.uid()
          or ba.party_a_id = auth.uid() or ba.party_b_id = auth.uid()
          or rtb.merchant_id = auth.uid() or rtb.customer_id = auth.uid()
        )
    )
  );

-- "storage dispute-evidence: admin read", the dispute-evidence bucket
-- config, the dispute_evidence table's own RLS, and every
-- rent-to-buy-evidence policy are untouched -- not repeated here.
