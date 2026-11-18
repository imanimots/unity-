# Pillar A — Data Inventory & Analytics Event Taxonomy

All findings below are code-verified with file:line citations unless marked UNKNOWN/NOT VERIFIED. No production personal data was read; no live data was queried.

## 1. Personal data inventory

| Data category | Where stored | Fields | Lawful basis (as implemented) | Collection point | Retention/deletion |
|---|---|---|---|---|---|
| Account identity | `auth.users` (Supabase-managed) + `profiles` | email (auth.users only — `profiles` has no email column, `20260613000001_initial_schema.sql:83-93`), `full_name`, `display_name`, `phone`, `avatar_url`, `role`, `country_id` | Consent at signup (`legal_acceptances`: terms/privacy/popia checkboxes) | Registration (`src/app/[locale]/(auth)/register/page.tsx:77`) | Anonymized (not hard-deleted) via `erase_account()`, `supabase/migrations/20261022000000_account_erasure.sql:391-401` |
| Identity/KYC | `public.identity_verifications` | `legal_first_name`, `legal_surname`, `date_of_birth`, `id_reference_type` (SA ID/passport), `id_reference_number`, `nationality`, `country_of_residence`, `residential_address`, provider refs, internal `reviewer_notes`/`reason_code` (never exposed to the user — owner-safe view excludes them, `20260804000001_identity_verification_schema.sql:125-150`) | Explicit KYC consent checkbox (`kyc-flow.tsx:276`) | KYC submission flow | Scrubbed (not deleted) on erasure, `account_erasure_log` lines 403-412; no stated precise retention *period* otherwise |
| KYC document files | `kyc-documents` storage bucket (private, own bucket) | `document_type`, `storage_path` | Same KYC consent | KYC upload | Append-only; no UPDATE/DELETE policy at all — a resubmission is a new object, never an overwrite (Doc E §3) |
| Bank/payout details | `payout_destinations` + Supabase Vault | `account_last4`, `bank_code`, `universal_branch_code` plaintext; full account number stored via `vault.create_secret()`, decrypt-only via a service-role-only RPC (`20261111184936_add_payout_destination_authority.sql:459, 509-533`) | Merchant-initiated payout setup | Merchant payout settings | Not covered by `erase_account()`'s scrub list — financial records are explicitly preserved for legal/accounting reasons |
| Behavioral/analytics | `analytics_events` | `session_id` (30-min-rotating, non-permanent), `route_path`, `entity_type`/`entity_id`, `metadata` (per-event, strict-schema'd) — **no raw search-query text is ever stored by design** (`20261027145645_analytics_events_foundation.sql:4-5`) | Implicit (no consent banner currently gates this — see §3 below) | Every tracked user action | Manual-only cleanup RPC, 365-day default window, **no cron wiring found** — i.e. retention exists in code but is not automatically enforced |
| Transactional emails | `email_deliveries` | `recipient_user_id`, `recipient_email`, status, timestamps | Transactional (service emails) | Every system email | `recipient_email` is nulled on account erasure (`account_erasure.sql:414`); otherwise no pruning job found (Doc E §4) |
| Admin/mutation audit | `admin_action_history`, `identity_verification_history`, `user_account_history` | actor id, action type, previous/new status, reason, timestamp | Internal operations | Every admin mutation | Immutable, intentionally never pruned |

**Not found:** any employee/HR-specific data table (no payroll, performance review, or HR system integration found in this repo — Unity's own staff data, if any, is managed outside this codebase or not yet built).

## 2. Third-party analytics/ad platforms

**Code-verified ABSENT:** No Google Analytics 4, Google Ads, Search Console, Google Tag Manager, Meta Pixel, Conversions API, or TikTok Pixel integration exists anywhere in `src/`. Confirmed via an exhaustive case-insensitive grep for `gtag|google-analytics|googletagmanager|fbq|facebook pixel|conversions api|tiktok` across the entire source tree — the only hit was a false positive (`logTag`, a variable name, in `src/app/api/payout-destinations/route.ts`).

**What this means:**
- **No uncontrolled PII leakage risk to ad platforms** — there is nothing to "stop sending" because nothing is currently sent.
- **No marketing-attribution capability** — if/when a marketing stack is added, the consent-banner gap (§3) must be closed *before* any such integration, not after.

## 3. Consent management

- **Cookie consent banner:** Does not exist in code. `docs/ARCHITECTURE.md:153` lists it under "Security Requirements" as a requirement, but no `CookieBanner`/`CookieConsent` component exists anywhere in `src/` (confirmed via grep, zero hits).
- **What does exist:** A `legal_acceptances` table + `POST /api/legal/accept` (`src/app/api/legal/accept/route.ts:14-15`) records explicit checkbox acceptance of named policies (`terms`, `privacy`, `popia`) at registration, booking, checkout, and KYC. These rows are immutable (an UPDATE/DELETE-blocking trigger applies even to `service_role`).
- **Gap:** A legal-acceptance checkbox is not the same control as a cookie-consent banner with granular toggles for non-essential tracking — POPIA (and GDPR, for any future EU users) generally expects the latter before non-essential behavioral tracking begins. Because there are currently no third-party ad pixels, the practical exposure is lower than it would be with GA4/Meta wired in — but the first-party `analytics_events` tracking itself begins with no consent gate today.

## 4. Existing vs proposed event taxonomy

### Existing (16 events, DB-enforced allowlist + app-level canonical list + per-event Zod schema — `src/lib/analytics/events.ts:20-37`, `supabase/migrations/20261027145645_analytics_events_foundation.sql:25-42`)

| Event | Captured fields (metadata) | Notes |
|---|---|---|
| `page_view` | route_path, actor_state | |
| `signup_started` / `signup_completed` | — | |
| `search_started` / `search_results_viewed` / `search_zero_results` / `search_refined` | `has_query: boolean`, `result_count: number` — **no raw query text**, by explicit design | |
| `listing_viewed` | entity_id (listing) | |
| `listing_creation_started` / `listing_published` | entity_id | |
| `rental_checkout_started` / `booking_created` | entity_id | |
| `order_checkout_started` / `order_created` | entity_id | |
| `kyc_started` / `kyc_submitted` | — | |

### Confirmed NOT in the taxonomy (checklist from the audit brief)

| Requested event | Status | Note |
|---|---|---|
| `select_item` | Absent | No equivalent found |
| `availability_check` | Absent | No equivalent found |
| `booking_confirmed` (distinct from created) | Absent | Only `booking_created`/`order_created` exist — no separate "confirmed" step is tracked |
| `payment_success` / `payment_failure` | **Absent** | No payment-outcome event exists in the taxonomy at all |
| `handover` | Absent | |
| `overdue` | Absent | |
| `return` | Absent | |
| `refund` | Absent | |
| `dispute` | Absent | Disputes exist as a DB domain but are not instrumented as an analytics event |
| `payout` | Absent | |
| Repeat-rental / retention signal | Absent | `session_id` rotates every 30 min of inactivity, so it cannot serve as a cross-visit identity signal either |

### Proposed additions (P1 backlog, see Doc F)

| Proposed event | Fields | Privacy note |
|---|---|---|
| `payment_outcome` | `status: 'success'\|'failed'\|'declined'`, `payment_type`, entity_id | Never include card/bank details |
| `handover_confirmed` | entity_id (booking), role (renter/merchant) | |
| `return_confirmed` | entity_id | |
| `dispute_opened` / `dispute_resolved` | entity_id, `outcome` (no free-text reason) | Exclude dispute narrative text from analytics (keep in the dispute record itself, not telemetry) |
| `payout_processed` | entity_id, status | No bank details |
| `rebooking_signal` | `is_repeat_customer: boolean` (computed server-side from a durable user id, not session id) | Must be computed from `auth.uid()`-linked history, not the rotating session id |

All additions should follow the existing architecture exactly: DB CHECK-constraint allowlist + app-level const + strict Zod schema + service-role-only RPC write path — this repo's existing pattern is sound and should be extended, not replaced.

## 5. What should NOT be sent to ad platforms (forward-looking, since none are wired in yet)

If/when GA4/Meta/TikTok are added: never pass raw search query text, legal names, ID/passport numbers, residential addresses, bank details, KYC document content, or dispute narrative text as event parameters or in the Conversions API payload. The existing first-party schema already enforces "no raw query text" — that discipline should carry over verbatim to any future ad-platform integration, not be loosened for marketing convenience.

## 6. Employee/admin access controls vs POPIA proportionality

- Admin **mutations** (status changes, approvals/rejections) are logged with who/what/when (`src/lib/admin/audit-service.ts:1-89`).
- Admin **reads** of KYC documents or payout account details are **not logged at all** (confirmed absent — Doc D §5). This is the single most significant proportionality gap found: POPIA's accountability principle expects organizations to be able to show who accessed sensitive data, not only who changed it.
- The admin analytics dashboard (`src/lib/admin/analytics-service.ts`) is honestly built — it computes every figure from real queries and explicitly labels unavailable metrics (e.g. revenue) as `not_available_mock_payment_provider` rather than fabricating a number. This is a positive data-quality finding, not a gap.

## 7. Data residency

**NOT VERIFIED — would need:** Supabase Dashboard → Project Settings → General (to read the actual configured region for project ref `pwueguyrlcorurvbphej`). `docs/ARCHITECTURE.md:33` only says the region should be "considered" for Cape Town — this is planning language, not a confirmed setting, and no config file in the repo pins an actual region.
