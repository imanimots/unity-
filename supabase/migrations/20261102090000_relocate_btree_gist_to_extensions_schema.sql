-- E14: relocate btree_gist out of the exposed public schema.
-- The bookings_no_overlap_when_blocking exclusion constraint depends on
-- btree_gist objects by OID and is not dropped or recreated.
alter extension btree_gist set schema extensions;
