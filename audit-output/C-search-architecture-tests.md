# Pillar B — Search Architecture & Functional Test Matrix

## 1. Architecture (as implemented, code-verified)

```
Browser
  │
  ▼
src/app/[locale]/(marketing)/listings/page.tsx  (server component)
  │
  ├─ getListingsPage()         src/lib/data/listings.ts:172-307
  ├─ getMarketplaceRequestsPage()   src/lib/data/marketplace-requests.ts
  └─ getSkillTaskPublicPostsPage()  src/lib/data/skill-task-posts.ts
       │
       │  (no public GET /api/listings route exists — this is a
       │   server-side data-layer call, not a REST search endpoint)
       │
       ▼
  Postgres RPC (SECURITY INVOKER — real listings-table RLS applies
  even to a direct RPC caller):
    search_listings(p_query, p_mode, p_category, p_country_id,
                     p_price_min, p_price_max, p_sort,
                     p_cursor_tier, p_cursor_score, p_cursor_price,
                     p_cursor_created_at, p_cursor_id, p_limit)
    supabase/migrations/20260902000006_search_ranking_keyword_stuffing_fix.sql:121-210
       │
       ├─ Tier 3: normalized exact title match            → score 1
       ├─ Tier 2: search_vector @@ websearch_to_tsquery()  → custom
       │          coverage score (anti-keyword-stuffing,   distinct-lexeme
       │          see §3 below)                            count, not ts_rank
       └─ Tier 1: pg_trgm similarity(title, q) >= 0.3      → similarity score
       │
       ▼
  listings table: generated STORED tsvector column + GIN index
  (20260902000002_search_ranking_search_vectors.sql:28-58)
  + pg_trgm GIN index on title (initial_schema.sql:276)
       │
       ▼
  Keyset/cursor pagination (no OFFSET anywhere) —
  src/lib/search/cursor.ts: context-hash-bound cursor, 2048-char cap
       │
       ▼
  No cache layer in front of this path — every request hits Postgres
  directly (Upstash Redis in this repo is used only for rate-limiting,
  not search caching)
```

Two parallel, structurally identical RPCs exist for `marketplace_requests` (Looking For posts) and `barter_skill_task_posts` (Barter skills/tasks) — same tsvector+GIN+trigram pattern, confirmed at `20260902000002_...sql:37-58` and `20260902000003_search_ranking_trigram_fallback_indexes.sql:8-12`.

## 2. Trade-off note: Postgres full-text search vs. a dedicated search engine (e.g. Algolia)

This repo made a deliberate, documented choice to build relevance (tiered scoring, anti-keyword-stuffing, trigram typo-fallback) *inside* Postgres rather than adopting a dedicated engine. At the current evidenced scale (a developer comment notes **780 active listings** in the dev environment, `20260902000002_...sql:16-20`), this is a reasonable, low-operational-overhead choice — a dedicated engine's main advantages (sub-50ms p99 at huge scale, built-in synonym/typo UI tooling, multi-language analyzers, faceted-search dashboards) aren't yet needed. The trade-offs that **will** start to matter as the catalog grows: Postgres text search doesn't horizontally scale independently of the primary database, there is no built-in synonym dictionary (confirmed absent, see §3), and every search query competes for the same connection pool as transactional traffic. **This is a legitimate, deferred decision, not a current defect** — revisit once the 10k-listing test plan below reveals real latency numbers.

## 3. Confirmed gaps (code-verified, not inferred)

| Gap | Evidence | Impact |
|---|---|---|
| **Province/city location filter is dead code** — `ListingFilters.location` is declared (`listings.ts:16`) but never read by `getListingsPage()` (confirmed via grep, zero matches for `filters.location`) | `src/lib/data/listings.ts:16` | High — renters cannot filter by location at all today, despite the type suggesting they can |
| **No availability/date-range filter at search time** — `listing_availability` is only read in the merchant's own edit wizard, never in `search_listings` | `listings.ts:454` vs. the RPC body | High — a renter can only discover booking conflicts after clicking into a listing, not while browsing |
| No `condition` filter | Confirmed absent from `ListingFilters` and the RPC | Medium |
| No synonym dictionary | Explicitly documented as an accepted MVP limitation, `20260902000002_...sql:10-14` | Medium (e.g. "fridge" won't match "refrigerator") |
| FTS hardcoded to English | `to_tsvector('english', ...)` / `websearch_to_tsquery('english', ...)` in every tier, despite en-ZA/af-ZA/zu-ZA UI locales | Medium — isiZulu/Afrikaans listing text won't rank or match correctly |
| No total result count returned | `getListingsPage()` returns only `{ items, nextCursor }` | Low — affects UI copy ("showing X of Y"), not correctness |
| No query-suggestion on zero results | Static "no results" copy only; zero-result events ARE telemetered for demand analysis, just not surfaced to the user as suggestions | Low-Medium |

## 4. Confirmed strengths (code-verified)

- Real `tsvector`/GIN full-text search with weighted fields (title > category > description), not a naive `ILIKE`.
- A genuinely-reproduced "keyword stuffing" ranking bug was found and fixed with a documented, tested replacement scoring function — evidence of real engineering rigor, not a stub.
- Keyset/cursor pagination (not `OFFSET`) structurally avoids the classic "deep-page offset scan" performance pathology.
- RLS on `listings` correctly enforces `status='active' AND is_test=false` even for a direct RPC caller (SECURITY INVOKER + a fixed historical gap, `20260902000001_search_ranking_listings_is_test_rls_fix.sql`).
- Trigram typo-tolerance is real and threshold-tuned from live-tested pairs, not a guessed constant.

## 5. Reproducible functional test matrix (TEST PLANS — not measured results)

| # | Scenario | Method | Pass criterion | Status |
|---|---|---|---|---|
| 1 | Exact title match | Create synthetic listing "Canon EOS R5", search "Canon EOS R5" | Returned as Tier 3, score 1, first result | NOT RUN (requires a safe staging DB with synthetic data) |
| 2 | Typo tolerance | Search "Cannon EOS" against the same listing | Returned via Tier 1 trigram, similarity ≥ 0.3 | NOT RUN |
| 3 | Synonym | Search "fridge" against a listing titled "Refrigerator" | **Expected to fail today** (no synonym dictionary) | NOT RUN — expected-fail case, documents the known gap |
| 4 | Category filter | Filter by `category='electronics'` | Only electronics-category listings returned | NOT RUN |
| 5 | Price range | Filter `price_min`/`price_max` | Only in-range listings returned | NOT RUN |
| 6 | Location filter | Filter by province/city | **Expected to fail today** — filter is unwired | NOT RUN — expected-fail case, documents the known gap |
| 7 | Date-range availability | Filter by date range against a listing with an existing booking in that window | **Expected to fail today** — no availability filter exists in search | NOT RUN — expected-fail case |
| 8 | Zero-result suggestion | Search a nonsense string | Static "no results" copy renders; a `search_zero_results` event fires | NOT RUN |
| 9 | Sorting | Sort by `price_asc`/`price_desc`/`newest` | Fixed-column sort, no relevance tiering applied | NOT RUN |
| 10 | Stale/removed listing exclusion | Set a listing to `status != 'active'` or `is_test = true`, confirm it never appears | RLS + RPC filter should exclude it | NOT RUN |
| 11 | Multilingual match | Create a listing with an isiZulu title, search the same term | **Expected to fail today** — FTS config is hardcoded English | NOT RUN — expected-fail case |
| 12 | Permission boundary | Confirm an anonymous/unauthenticated client cannot retrieve a `draft` or `suspended` listing via the RPC directly | RLS should block it even bypassing the app layer | NOT RUN (safe to test with a synthetic row + anon key, no production data involved) |

**Latency (p50/p95) and 1k/10k/100k-listing capacity are explicitly TEST PLANS, not measured results** — the only real data point in the repo is a developer note observing 780 active listings in a dev environment with certain optional fields (brand/model) at 0% population (`20260902000002_...sql:16-20`). Running tests 1-12 plus a seeded-volume latency test requires a staging database; none of this was executed against production, consistent with the audit's no-load-testing constraint.

## 6. Comparison note (Takealot/Makro-style discoverability expectations, no proprietary knowledge claimed)

Public marketplaces at Takealot/Makro's scale are understood (from publicly observable behavior, not internal knowledge) to support faceted filtering by category, price, brand, location/delivery availability, and user ratings, with synonym-aware and typo-tolerant search. Unity's ranking logic (tiered exact/FTS/trigram scoring) is a reasonable foundation for that experience, but the **location and availability filters are the two gaps that most directly block matching that baseline today** — everything else (synonyms, multilingual) is a refinement on top of an already-functioning core, whereas these two are missing core filtering capability for a *rental* marketplace specifically (where "is it near me and is it free on my dates" are arguably the two most important questions a renter asks).
