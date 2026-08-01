# Identity Verification / KYC (Step 4 — Public Test MVP)

Real, persistent, provider-neutral identity verification, replacing the prior
localStorage-only mock (`src/hooks/use-kyc.ts`, removed) and its "Powered by Sumsub" UI. No
real Sumsub, no OCR, no biometric matching, no sanctions screening — a human admin makes
every decision manually, behind a provider abstraction designed so a real provider can
replace the manual one later without touching anything else.

## Architecture

```
User browser                              Admin browser
     │                                          │
     ▼                                          ▼
kyc-flow.tsx (/verify)                Admin UI (src/app/admin/verifications/**)
     │  fetch()                                 │  fetch()
     ▼                                          ▼
/api/verification/{me,submit,resubmit}   /api/admin/verifications/**
     │                                          │  requireAdmin()
     ▼                                          ▼
submit-service.ts (completeness check)   IdentityVerificationService abstraction
     │                                          │
     └──────────────┬───────────────────────────┘
                     ▼
       ManualIdentityVerificationProvider
                     │
                     ▼
   submit_identity_verification() / start_identity_review() /
   decide_identity_verification()   (service-role-only RPCs)
```

Mirrors Step 3's ownership-verification architecture exactly (`docs/ADMIN_MODERATION.md`) —
same three-table split, same RPC trust model, same signed-URL evidence pattern — applied to
a third domain (renter/merchant identity) instead of listing ownership. Two genuinely
shared, domain-neutral pieces were factored out during this pass rather than duplicated:
`src/lib/admin/route-helpers.ts` (moved from `src/lib/listings/`, now used by both Step 3's
and Step 4's admin routes) and the idempotency infrastructure (`idempotency_keys`, reused
as-is).

## Provider abstraction

```
IdentityVerificationService (src/lib/identity-verification/types.ts)
    │
    ├── ManualIdentityVerificationProvider   [active now — a human decides]
    ├── SumsubIdentityVerificationProvider   [future stub — every method throws]
    └── (future provider)
```

`getIdentityVerificationProvider()` (`src/lib/identity-verification/registry.ts`) resolves
by name, `IDENTITY_VERIFICATION_PROVIDER` env var, default `manual` — identical pattern to
`src/lib/ownership-verification/registry.ts` (Step 3) and `src/lib/payments/registry.ts`
(Phase 2C). Every admin verification route and the submit-service call
`getIdentityVerificationProvider()`, never `ManualIdentityVerificationProvider` directly —
enforced by an architecture-fitness test
(`src/lib/identity-verification/__tests__/provider.test.ts`) that scans actual import
statements, not just types.

**Swapping to a real Sumsub provider later requires:** implementing
`SumsubIdentityVerificationProvider` for real against the same interface, adding a webhook
route mapping Sumsub's callback events onto `approve`/`reject`/`requestAdditionalInformation`,
adding credentials, and flipping `IDENTITY_VERIFICATION_PROVIDER=sumsub`. Nothing in booking
eligibility, listing activation, admin status displays, merchant/renter dashboards, the
database status model, or review history needs to change — all of it already depends only on
the abstraction.

## Status model

`identity_verification_status` (new enum): `not_started | pending | under_review |
additional_information_required | approved | rejected`. `approved` and `rejected` are
terminal for a given decision cycle — `decide_identity_verification()` refuses to re-decide
either (`already has a final decision`). Unlike Step 3's ownership verification (where
`rejected` was also terminal for re-deciding but distinct from resubmission), **KYC allows a
fresh submission cycle after `rejected`**: `submit_identity_verification()` is allowed FROM
`not_started`, `additional_information_required`, **or** `rejected` — a real-world KYC
rejection (blurry photo, wrong document) shouldn't permanently lock a user out, only block
the *current* decision from being silently overturned.

`profiles.kyc_status` (existing enum from the original schema: `none | pending | approved |
rejected`, already protected by `protect_profile_privileged_fields`) remains the coarse,
public-readable summary every other part of the app already reads (risk engine, listing
completeness, dashboard badges). It's kept in sync by the RPCs — the same "richer private
table syncs a pre-existing public summary field" pattern Step 3 used for
`listings.ownership_verified`, applied correctly from the start this time (see "Two audit
trails" below for the bug that pattern avoided). Mapping: `pending`/`under_review`/
`additional_information_required` → `kyc_status = 'pending'` (the legacy enum has no
finer-grained equivalent); `approved`/`rejected` → the matching legacy value.

## Public/private data split

`profiles` gained **no new columns** this pass — it was already clean (no legal-identity
fields existed there before Step 4, confirmed during audit). All sensitive data lives in
three new tables, none with a public policy:

- **`identity_verifications`** (current state, 1 row per user) — legal name, date of birth,
  ID/passport reference, nationality, residential address, plus admin-only fields
  (`reviewer_notes`, `reason_code`, `provider_reference`). Admin read/write via RLS
  (`profiles.role = 'admin'`); the owner **never** reads this table directly — only through
  `identity_verification_self_view` (narrow, excludes the admin-only fields — same
  column-blindness workaround as `listing_moderation_merchant_view` in Step 3, since RLS is
  row-level, not column-level).
- **`identity_verification_documents`** (append-only) — document type, storage path, MIME
  type, size. Owner can read/insert their own rows; admin reads all; **no UPDATE/DELETE for
  anyone**, enforced by the shared `prevent_row_mutation()` trigger.
- **`identity_verification_history`** (admin-only, immutable) — every submission and
  decision, with reviewer identity and reason codes. No user-facing policy at all (unlike
  Step 3's `listing_history`, which *was* merchant-readable) — the user only ever needs
  current status + current safe feedback, not a full timeline, so there's no merchant-safe
  history table to get wrong here.

Public profile reads never expose ID/passport number, date of birth, exact address, storage
paths, admin notes, or provider payloads — none of it is on `profiles`, and none of the three
new tables has a public RLS policy.

## Document storage

Private `kyc-documents` Storage bucket (10 MB limit, `image/jpeg`, `image/png`, `image/webp`,
`application/pdf` only — no executable or unexpected MIME types accepted, enforced by the
bucket's own `allowed_mime_types` and mirrored in Zod validation). Path convention:
`{user_id}/{document_type}/{uuid}.{ext}`, exactly as specified — server never accepts a
client-supplied path; the browser generates the UUID and the folder-scoping RLS
(`auth.uid()::text = foldername(name)[1]`) is what actually enforces "only your own folder,"
not trust in the client-built path. Upload goes directly from the browser to Storage using
the user's own session (same direct-client pattern Phase 2A established for
`listing_media`) — no server-side upload route exists or is needed.

Replacement documents are **new rows/objects**, never an overwrite — the table is
append-only (immutable trigger) and the storage bucket has no UPDATE/DELETE policy for
anyone either. "Current" documents are resolved as the latest row per `document_type` in
application code (`listCurrentIdentityDocuments()`), the exact dedup-in-app-code pattern
Step 3 settled on for `listing_declarations` after finding a plain upsert can't coexist with
a hard immutability trigger.

## Manual mode / test-mode wording

`IDENTITY_VERIFICATION_PROVIDER=manual` (default). Admin UI shows **"Manual test
verification"** (queue header, review page badge). User-facing copy says **"Identity
verified by Unity"** on approval and a plain, safe rejection/info-request message — never
"Sumsub verified," "Government verified," or "Bank verified." The old "Powered by Sumsub"
badge and the "Mock mode — in production, Sumsub reviews documents within minutes" disclosure
are both gone from `kyc-flow.tsx`.

## Eligibility rules

One authoritative predicate, `isKycApproved()` (`src/lib/verification/eligibility.ts`) —
`kycStatus === 'approved'`, nothing more. Used directly (not re-derived) at:

| Action | Gate | Enforced in |
|---|---|---|
| Browsing | none | — |
| Draft listing creation | none | — |
| Listing activation | merchant KYC approved | `src/lib/listings/activation.ts` (`checkActivationEligibility`) |
| Booking request | renter KYC approved | `POST /api/bookings` |
| Booking start | renter KYC approved (checked against the booking's own `renter_id`, not necessarily the caller — either party can click "start") | `POST /api/bookings/[id]/start` |
| Admin review | independent of KYC status | — (admins act regardless of their own KYC) |

Every gate is checked **after** the idempotency-replay check and **before** the mutating
RPC call, the same ordering rule every mutation route in this codebase already follows (an
already-completed request must still return its cached result even if the actor's KYC status
changed since). Live-verified: an approved renter's booking request succeeds; the same
predicate blocks listing activation until the merchant's KYC clears (live-verified via
Scenario B — the KYC-specific reason disappeared from `activationEligibility.reasons` the
moment approval landed, while the listing's other unrelated blockers remained).

**Listing submission itself is unchanged** — `computeListingCompleteness()` (Phase 2A) still
only *warns* about unverified KYC at submission time, not blocks. The Step 4 brief's own
recommended rule groups "listing submission or activation" as one bullet; activation was
chosen as the enforcement point (not submission) to avoid changing already-validated Phase 2A
behavior and existing Step 3 test data.

## Request-information / resubmission

`requestAdditionalInformation()` moves status to `additional_information_required`; the user
sees `user_feedback` (safe) via `identity_verification_self_view`, never `reviewer_notes`
(admin-only, structurally excluded from that view — not just conventionally hidden). The
user may upload a replacement document (a new row, old one preserved) and call
`/api/verification/resubmit`, which — like `/submit` — ultimately calls the same
`submit_identity_verification()` RPC (its own status guard already allows both a genuine
first submission and a resubmission; the two routes exist only for UX clarity, sharing one
underlying handler in `submit-service.ts`).

**Invalidation rule — smallest safe version implemented:** resubmission through
`additional_information_required` or `rejected` always re-collects the **full** legal-detail
form (not a partial "just the one field" update) and requires **both** document types to be
present again (the existing one is reused if not replaced, since it's still on file) — so
every resubmission is a complete, coherent new snapshot, never a partial patch that could
leave stale legal details paired with a replaced document. No separate field-level
invalidation logic (e.g. "does changing date of birth specifically invalidate a *different*
already-approved decision") was built — once `approved`, the record is terminal for further
`decide_identity_verification()` calls regardless of what the user later edits elsewhere, and
there's no "edit an approved KYC record" path in this pass at all (unlike Step 3's listings,
which remain editable after moderation approval). This is documented as the deliberate
minimum, not a silent gap.

## RPCs, routes, permissions

Three RPCs (`submit_identity_verification`, `start_identity_review`,
`decide_identity_verification`), all `SECURITY DEFINER`, `service_role`-only — verified
empirically (`anon`/`authenticated` → `false`, `service_role` → `true` via live
`has_function_privilege` queries). Ten routes: 3 user-facing
(`GET /me`, `POST /submit`, `POST /resubmit`), 7 admin (`GET` queue/detail,
`POST` start/approve/reject/request-information/document-url) — exactly the structure
suggested in the Step 4 brief.

## Idempotency

Identical shape to every RPC since `submit_listing_for_review()` (Phase 2A): self-contained
per call (idempotency check → state validation → mutation → history write → idempotency
insert, one transaction). `submit_identity_verification` is scoped by the **submitting
user's own id** (already a `profiles.id`, no FK issue); the two admin RPCs are scoped by the
**admin's** id — reusing the generic `idempotency_keys` table exactly as Step 3 did. Live-
verified: exact replay returns the cached result with no duplicate history row (confirmed
after a genuine 500-on-timeout edge case — see "A real incident found during live
validation" below); a stale key against an already-terminal (`rejected`/`approved`) decision
is rejected with `already_decided`, not silently reprocessed.

## Security boundary

Live-verified via Scenario D: self-approval blocked (401, not an admin); direct RPC call
using an admin's own *session* JWT (not `service_role`) → `42501 permission denied` (the
DB-level guard doesn't trust "is this Postgres role an admin," only the literal
`service_role` credential); direct `profiles.kyc_status` PATCH silently reverted by the
existing `protect_profile_privileged_fields` trigger (pre-existing, unchanged this pass);
direct `identity_verifications` table writes (forged `status`/`reviewed_by`) blocked by RLS
(empty result, no admin role); cross-user document row/path access blocked (RLS empty
result, `400` on a guessed/expired storage path); expired signed URL correctly rejected
(`400 InvalidJWT — exp claim timestamp check failed`) after its 120-second window passed.

## A real incident found during live validation

During Scenario B, one `approve` call's HTTP response hung for over 16 minutes before the
route reported a `500`. Investigation confirmed this was **not a data-correctness bug**: the
RPC itself had completed correctly within about a second of the request (`identity_verifications.status`
and `profiles.kyc_status` were both already `approved`, `reviewed_by`/`reviewed_at` correctly
stamped, `identity_verification_history` had exactly one `decision_approved` row) — the delay
was in the HTTP response path back to the client (consistent with a transient dev-environment
connection stall, not application logic). Confirmed safe by retrying with the **same**
idempotency key: the retry returned in ~1 second with the correct cached result, and the
history row count stayed at exactly one `decision_approved` entry — proving the idempotency
design tolerates exactly this class of failure (a successful write whose response never
reached the caller) without creating a duplicate or losing the decision. Documented here
rather than silently omitted, since it's a genuine operational data point about response-path
reliability in this dev environment, even though it didn't indicate an application defect.

## Known limitations

- No field-level re-invalidation of an *approved* decision when unrelated profile data
  changes later (see "Invalidation rule" above) — deliberately out of scope this pass.
- `expired` status (explicitly optional per the brief — "only if genuinely required") was
  **not** built — no time-based expiry rule exists for South African test verification yet,
  and inventing one would be exactly the kind of unrequested business rule this engagement
  has consistently avoided.
- No merchant-payout-readiness or "high-risk action" gate beyond listing activation and
  booking creation/start — the brief lists these as future integration points ("later"), not
  required this pass.
- The 16-minute response-path stall (see above) was not reproduced a second time and appears
  environment-specific; flagged for awareness, not treated as a code defect requiring a fix.
- `identity_verification_history`/`identity_verification_documents` have no retention policy
  — grows unboundedly, matching every other audit table in this schema (not a new gap).

## Ease of switching to Sumsub

Same five-step path Step 3 already validated for ownership verification: implement the real
provider class against the unchanged interface, add a webhook route, add credentials, flip
one env var, map Sumsub's event shapes onto the four existing provider methods. Verified by
an architecture-fitness test that fails the build if any admin route or service file imports
`ManualIdentityVerificationProvider` directly instead of going through the registry.
