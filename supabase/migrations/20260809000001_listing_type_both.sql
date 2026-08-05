-- ============================================================
-- Extend listing_type with 'both' (Phase 2 — Buying & Selling)
-- ============================================================
-- A single physical item can be listed as rentable, sellable, or both
-- at once — one listings row, one quantity_available, so the same unit
-- can never be simultaneously committed to a rental and a sale (the
-- alternative — two separate linked listings — was considered and
-- rejected specifically because it lets exactly that happen). See
-- docs/BUYING_SELLING.md for the full design writeup.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to be committed before the
-- new value can be used in the same session — this migration only
-- changes the enum. The CHECK constraint update that uses 'both' lives
-- in the next migration.
-- Apply via: Supabase Dashboard -> SQL Editor -> Run
-- ============================================================

alter type listing_type add value if not exists 'both' after 'sale';
