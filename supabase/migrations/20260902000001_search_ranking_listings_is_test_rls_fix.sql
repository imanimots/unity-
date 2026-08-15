-- Search Ranking prerequisite (audit finding, not itself a ranking
-- change): the public "listings: public read active" policy has never
-- enforced is_test = false at the RLS layer -- protection has only
-- ever existed at the application layer (excludeTestListings() in
-- src/lib/data/listings.ts). Any direct PostgREST caller bypassing
-- that helper can see is_test=true fixture rows for every active
-- listing. marketplace_requests already enforces this correctly at
-- the policy layer (see its own "public read (published, non-test)"
-- policy) -- this migration brings listings in line with that
-- existing, safer pattern. Owner and merchant-authenticated access is
-- unchanged; only the ANONYMOUS/OTHER-USER public-read branch gains
-- the is_test predicate.
drop policy if exists "listings: public read active" on public.listings;

create policy "listings: public read active"
  on public.listings for select
  using ((status = 'active' and is_test = false) or auth.uid() = merchant_id);
