-- Platform improvement programme, Phase 5 (database performance): the
-- audit found orders and payments both lack a dedicated index on their
-- creation-time column, unlike bookings (bookings_created_at_idx) and
-- ledger_entries (ledger_entries_created_idx) -- both tables will be
-- queried by date range as they grow (admin reporting, analytics
-- dashboards, the retention jobs added alongside this migration).
-- payments has no created_at column (20260801000002_payment_schema.sql)
-- -- its lifecycle is tracked via requested_at/authorised_at/captured_at/
-- etc., with requested_at being the row's actual creation time, so that's
-- what's indexed here instead.
-- `if not exists` + CONCURRENTLY-unsafe plain CREATE INDEX is
-- consistent with every other index in this schema (none use
-- CONCURRENTLY; this project's migrations apply via the Supabase
-- GitHub deploy integration, not a manual production console run
-- where lock duration would need separate handling).
create index if not exists orders_created_at_idx on public.orders(created_at);
create index if not exists payments_requested_at_idx on public.payments(requested_at);
