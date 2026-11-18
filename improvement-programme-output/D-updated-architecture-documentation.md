# Updated Architecture Documentation

## 1. Data flow (post-programme)

```
Browser
  │
  ├─ ConsentBanner (mounted once, [locale] root layout)
  │     │
  │     └─ writes choice → localStorage (unity_consent_preferences_v1)
  │
  ├─ trackEvent() [src/lib/analytics/client.ts]
  │     │
  │     ├─ hasAnalyticsConsent()? ──NO──> silent no-op (NEW GATE)
  │     │
  │     └─ YES ──> POST /api/analytics/events ──> record_analytics_event() RPC
  │                                                   │
  │                                                   ▼
  │                                           analytics_events table
  │                                           (16 original + 6 NEW events)
  │
  └─ Transactional actions (booking checkout, start, confirm-return,
     dispute open, admin refund, admin payout mark-paid)
        │
        ├─ Authoritative RPC call (unchanged)
        │
        └─ recordAnalyticsEvent() [server-side, NEW call sites]
              │  (payment_outcome / handover_confirmed / return_confirmed /
              │   refund_issued / dispute_opened / payout_processed)
              ▼
        analytics_events table (same table, server-authoritative write path)

Admin browser
  │
  └─ POST /api/admin/verifications/[id]/document-url
        │
        ├─ getIdentityDocumentSignedUrl() [NEW: now logs]
        │     │
        │     ├─ lookup + sign (unchanged)
        │     └─ INSERT admin_kyc_document_access_log (NEW)
        │
        └─ unified into /admin/audit via listAdminAuditEntries()
              (4th source, alongside the 3 existing mutation-history tables)
```

## 2. Search architecture (post-programme)

```
Browser (FilterBar: category pills, max-price select, province select,
         city input, date-range picker [NEW])
  │
  ▼
src/app/[locale]/(marketing)/listings/page.tsx
  │  parses province/city/startDate/endDate/minPrice from URL [NEW]
  ▼
getListingsPage() [src/lib/data/listings.ts]
  │
  ▼
search_listings RPC (Postgres)
  │
  ├─ Existing: category/country/price/mode eligibility, 3-tier ranking
  │  (exact match > FTS coverage score > trigram similarity)
  │
  └─ NEW: province (ilike, whole-value) / city (ilike, partial) /
          availability (NOT EXISTS against listing_availability +
          bookings, reusing create_booking_request's own overlap check)
  │
  ▼
Keyset/cursor pagination (unchanged, cursor now also carries the new
filter params in its context hash, so a cursor from one filter state
can never be replayed against another)
```

No change to the underlying tsvector/GIN/pg_trgm indexing strategy — the audit confirmed this was already sound; this programme only closed the filter-wiring gap, not the indexing approach.

## 3. Authentication & authorization architecture

**Unchanged this programme** — `requireAdmin()`/`requireMerchant()`/`requireAuth()` (`src/lib/supabase/require-admin.ts`) remain the sole authority, still deriving role server-side from `profiles` keyed by `auth.uid()`, never from a client claim. Admin MFA enforcement was evaluated and deliberately not built this session (see Doc A) — the architecture point to design against, when it is built, is an AAL/factor check added to `requireAdmin()` itself, gated behind a feature flag during the enrollment-rollout period, not a hard cutover.

## 4. Storage architecture (updated)

```
10 buckets (unchanged inventory, see the preceding audit's Doc E for the
full list) — this programme touched access LOGGING, not bucket
structure:

kyc-documents (private)
  │
  └─ POST /api/admin/verifications/[id]/document-url
        │
        ├─ createSignedUrl() (120s TTL, unchanged)
        └─ INSERT admin_kyc_document_access_log  [NEW]
              │
              └─ read by: /admin/audit (via listAdminAuditEntries, NEW
                 4th source) AND directly by an admin with role='admin'
                 (RLS policy, same posture as admin_message_access_log)
```

## 5. Backup & recovery architecture

```
[Supabase-managed, outside this codebase's control]
  Postgres (project pwueguyrlcorurvbphej)
  Storage (10 buckets)
       │
       │  backup frequency / PITR / region: UNVERIFIED FROM CODE
       │  (see docs/operations/DISASTER_RECOVERY_RUNBOOK.md §8)
       ▼
  [This programme's contribution: PROCEDURE, not infrastructure]
  docs/operations/DISASTER_RECOVERY_RUNBOOK.md
    - 5 scenarios, each with a documented procedure
    - RTO/RPO targets marked as proposals, not measured capability
    - §8 explicitly lists the 6 facts that need live access to confirm
```

Retention jobs added this programme (`cleanup_analytics_events` scheduling + new `cleanup_email_deliveries`) are an *application-level* data-lifecycle concern, not a backup/recovery one — they bound the size of two specific log tables, unrelated to whether the underlying database itself is backed up.

## 6. Monitoring & alerting architecture

**Unchanged — still absent.** No Sentry/Datadog/PagerDuty-equivalent exists anywhere in this codebase, before or after this programme. The one monitoring-adjacent addition this programme made is the admin audit feed's new 4th source (KYC document access) — that is an *audit trail* (durable, queryable after the fact), not *alerting* (real-time notification of an anomaly). The architectural gap the preceding audit identified — no one is notified in real time when something fails — remains fully open, explicitly, pending a vendor decision this session could not make.
