# E — Search Performance Report

## What was actually measured this session (real, read-only, against live data)

Ran timed `search_listings` RPC calls directly against the live database (read-only, no synthetic data written, no authorization needed beyond the already-permitted read access):

| Query | Rows returned | Latency (3 runs, ms) | Avg |
|---|---|---|---|
| Plain browse, newest | 6 | 287, 217, 222 | 242 |
| Plain browse, relevance | 6 | 215, 209, 213 | 212 |
| Keyword "camera" | 0 | 278, 230, 207 | 238 |
| Typo "camra" | 0 | 214, 204, 218 | 212 |
| Category filter | 6 | 215, 214, 215 | 215 |
| Price range | 6 | 230, 214, 258 | 234 |
| Mode=rent | 2 | 216, 210, 211 | 212 |
| Mode=buy | 4 | 210, 224, 208 | 214 |
| Combined query+category+price | 0 | 207, 211, 229 | 216 |

## The critical caveat (do not skip this when reading the table above)

**These numbers measure query latency against a table with 9,270 total rows, but only 10 of those rows are genuinely real and search-eligible** (`status='active' AND is_test=false`) — the other 9,259 are accumulated QA test fixtures from this engagement's own history. The consistent ~210-290ms latency regardless of filter complexity strongly suggests network round-trip time (this script ran from outside the Supabase region, not co-located the way a production Vercel deployment likely would be) dominates these numbers, not actual query execution cost.

**This is real evidence of current baseline latency at the current live row count. It is NOT a valid measurement of search behavior across a genuine 10,000-listing real catalog**, because the eligible set is 10, not 9,270. Presenting these numbers as "search performs well at 10k scale" would be a materially misleading overstatement — they are reported here specifically to prevent that overstatement from happening by omission.

## What remains genuinely unmeasured

A true 1k/10k/100k-real-eligible-listing test requires either:
1. Organic growth of real listings (not something this session can produce), or
2. The synthetic-data test script (`scripts/search-scale-test.mjs`, built in the prior session, still not run) — blocked on your explicit authorization to write up to 100,000 synthetic rows to the one shared Supabase project, since no isolated local/Docker environment exists here to run it safely instead (confirmed this session: no Docker, no local Postgres binary).

## Index efficiency / query plans

**NOT VERIFIED.** `EXPLAIN (ANALYZE, BUFFERS)` requires either direct SQL access (outside the standing policy's permitted read pattern — plain `.from()`/`.rpc()` calls, not arbitrary SQL) or a custom RPC exposing it (which would itself need to be deployed first). Index *existence* was confirmed via migration-file review (unchanged from the prior audit: `listings_search_vector_idx`, `listings_title_trgm_idx` both present); index *usage* at current or future scale was not measured.

## Filter correctness (verified via live, read-only RPC calls this session)

- Category filter: correctly returns only matching-category rows (6 tech-category rows for `p_category='tech'`, cross-checked against the raw table).
- Price range: correctly bounds results.
- Mode filters (rent/buy): correctly partition by `listing_type`.
- The new location/date-availability filters (added in the prior session) **could not be tested live** — the migration adding them is not yet deployed (confirmed via a live call returning "Could not find the function" for the new parameter names).

## Pagination performance

Not separately measured this session — cursor-based keyset pagination (confirmed in the prior audit's architecture review) structurally avoids the deep-offset-scan pathology regardless of row count; this is a design property, not something that needed a fresh measurement.

## Recommendation

Do not run the 1k/10k/100k synthetic test speculatively "to see." Run it only once a real decision depends on the answer (e.g., before a specific launch-scale commitment), since it carries real cost (time to clean up, temporary load on the shared project) for a question that, today, has no immediate deadline attached.
