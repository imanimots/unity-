-- Platform improvement programme, Phase 4 (storage/backups): the audit
-- found analytics_events and email_deliveries are the two unbounded-
-- growth log tables with no retention mechanism -- unlike
-- ad_impressions/ad_clicks, which already have a working daily-
-- scheduled 90-day purge (purge_expired_ad_events(), vercel.json cron).
-- analytics_events already had cleanup_analytics_events() (just never
-- scheduled); email_deliveries had neither. This adds the matching RPC
-- for email_deliveries, same shape as cleanup_analytics_events().
--
-- 180 days, not 365 -- these are delivery-status logs (used for
-- debugging/admin visibility, src/app/admin/email-deliveries/page.tsx),
-- not a financial or legal record; no FK anywhere in this schema
-- references email_deliveries.id (confirmed via grep), so deleting old
-- rows is safe. recipient_email is already nulled on account erasure
-- (20261022000000_account_erasure.sql) independently of this.
create or replace function public.cleanup_email_deliveries(p_older_than interval default interval '180 days')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'cleanup_email_deliveries is service_role only';
  end if;

  delete from public.email_deliveries where created_at < (now() - p_older_than);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.cleanup_email_deliveries(interval) from public, anon, authenticated;
grant execute on function public.cleanup_email_deliveries(interval) to service_role;
