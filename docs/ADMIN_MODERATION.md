# Admin Moderation & Ownership Verification (Step 3 — Public Test MVP)

Real, persistent admin moderation and ownership verification, replacing the local-state
mock admin listing actions (`src/app/admin/listings/page.tsx` was previously seeded from
`src/lib/mock/admin-data.ts` with no backing API). No real Sumsub, no OCR, no document
recognition — a human admin makes every ownership decision manually, behind a provider
abstraction designed so that changes later without redesigning anything else.

## Architecture

```
Admin browser
     │
     ▼
Admin UI (src/app/admin/listings/**)
     │  fetch()
     ▼
Admin API routes (src/app/api/admin/listings/**)
     │  requireAdmin() — authoritative server-side check
     ▼
   ┌─────────────────────────────┬───────────────────────────────┐
   │ Ownership verification      │ Moderation / activation        │
   │ (pluggable)                 │ (not pluggable — Unity policy) │
   ▼                             ▼
OwnershipVerificationService     src/lib/listings/moderation-service.ts
     │                                 │
     ▼                                 ▼
ManualOwnershipVerificationProvider    decide_moderation() / activate_listing() /
     │                                 suspend_listing()  (service-role RPCs)
     ▼
start_ownership_review() / decide_ownership_verification()  (service-role RPCs)
```

Every mutation is a `SECURITY DEFINER` RPC, reachable only via `service_role` — the same
trust model `submit_listing_for_review()` already established in Phase 2A
(`docs/LISTING_SCHEMA.md`). No admin API route performs a raw table UPDATE for a decision;
each route's job is auth + validation + calling exactly one narrow RPC (or, for ownership
decisions, exactly one provider method).

## Provider abstraction — ownership verification only

Moderation and activation are **not** pluggable — they're Unity's own policy, not a
third-party service. Ownership verification is, because Sumsub (or another KYC/document
vendor) is a real future replacement for the manual review happening today.

```
OwnershipVerificationService (src/lib/ownership-verification/types.ts)
    │
    ├── ManualOwnershipVerificationProvider   [active now — a human decides]
    ├── SumsubOwnershipVerificationProvider   [future stub — every method throws]
    └── (future provider)
```

`getOwnershipVerificationProvider()` (`src/lib/ownership-verification/registry.ts`)
resolves by name, `OWNERSHIP_VERIFICATION_PROVIDER` env var, default `manual` — the exact
same pattern `src/lib/payments/registry.ts` already uses for payment providers (Phase 2C).
Every admin ownership route calls `getOwnershipVerificationProvider()`, never
`ManualOwnershipVerificationProvider` directly — enforced by an architecture-fitness test
(`src/lib/ownership-verification/__tests__/provider.test.ts`) that scans actual import
statements, not just types.

**Swapping in a real provider later requires:** implementing a new provider class against
the same `OwnershipVerificationProvider` interface, changing `OWNERSHIP_VERIFICATION_PROVIDER`,
and mapping the provider's own webhook/callback events onto the same
`startReview`/`approveOwnership`/`rejectOwnership`/`requestAdditionalEvidence` calls this
provider already makes. Nothing in the admin routes, `listing_ownership_verification`
schema, activation eligibility, or merchant-facing UI needs to change.

## Status models

**Ownership verification** (`ownership_verification_status` enum, new):
`not_required | pending | under_review | additional_evidence_required | verified | rejected`.
`verified`/`rejected` are terminal — `decide_ownership_verification()` refuses to
re-decide either (`already has a final decision`). No row exists in
`listing_ownership_verification` until a review starts; a missing row is treated as an
*implicit default* — `not_required` or `pending`, computed from the listing's own risk
tier (`getRiskRequirements()`), never eagerly written.

**Moderation** (`moderation_status`, from Phase 2A, unchanged):
`pending | approved | rejected | requires_review | flagged`. Kept entirely separate from
`listings.status` — see `docs/LISTING_SCHEMA.md`'s "Status vs. moderation".

**Listing status** (`listing_status`, extended this pass): `draft | pending | active |
paused | rented | suspended` (new value). `suspended` is administrative (this pass);
`paused` remains the merchant's own self-service action, unchanged.

## Activation eligibility

One function, `checkActivationEligibility()` (`src/lib/listings/activation.ts`), is the
single source of truth for "may this listing go live." It reuses
`computeListingCompleteness()` (Phase 2A) rather than duplicating any of its checks, adding
only what completeness doesn't cover: moderation approval, ownership verification against
the listing's own risk tier, and risk-tier-mandated deposit/insurance (stricter than
completeness's "deposit required only if the merchant opted in" check — a HIGH-tier
listing must have a deposit and insurance regardless of what the merchant set).

`POST /api/admin/listings/[id]/activate` runs this full check server-side before ever
calling `activate_listing()`. The RPC itself re-checks only the cheap, SQL-expressible
subset (current status ∈ `{pending, suspended}`, `moderation_status = 'approved'`) as
defense in depth — mirroring exactly why `submit_listing_for_review()` doesn't duplicate
the completeness engine in SQL either. **The browser never sets `status = 'active'`** —
`protect_listing_privileged_fields()` (extended this pass to also cover `suspended`)
silently reverts any non-service-role attempt.

Reactivating a **suspended** listing goes through the identical `activate_listing()` call
— the same full eligibility re-check, not a bare status flip. `suspend_listing()`
deliberately never touches `moderation_status`, which is what makes this recovery path
correct: the prior `approved` verdict still stands after a suspend/reactivate cycle that
didn't involve a new moderation decision.

## Request-changes and resubmission

`decide_moderation()` with `p_decision = 'rejected'` or `'requires_review'` reverts
`listings.status` to `'draft'` — "listing moves to a correct editable state." This means
resubmission needed **no new RPC at all**: the merchant's existing
`submit_listing_for_review()` flow (Phase 2A) already re-upserts `listing_moderation` back
to `'pending'` and appends fresh history on any call against a `draft` listing.
`'flagged'` is deliberately **not** reverted to draft — it's an escalation for senior
review, not a verdict the merchant can act on by editing.

**Invalidation model — smallest safe version implemented:** none of `ownership_verified`,
`serial_number`/VIN/IMEI, category, replacement value, images, or risk tier are
automatically re-checked or force-invalidated on edit this pass. A merchant edit does not
silently re-open an already-`verified` ownership decision or an already-`approved`
moderation verdict — both stay in their base tables until an admin makes a new decision
through the same RPCs. This is the smallest model that satisfies "merchant_id must never
change" (already enforced — `protect_listing_privileged_fields` blocks it) without
inventing a field-diffing invalidation engine that Phase 2A never asked for. **Known
limitation:** a merchant could, in principle, edit `replacement_value` upward or swap the
ownership-proof file after `ownership_verified` was already set `true`, without that
triggering a fresh review. Flagged explicitly below, not silently accepted as fine.

## Secure evidence access

Ownership evidence is **never** public. `ownership-proofs` remains a private Storage
bucket; `listing_media`'s public-read policy already excludes `type = 'ownership_proof'`
rows (Phase 2A). The only path to viewing a file is
`POST /api/admin/listings/[id]/evidence-url`
(`src/lib/listings/evidence-access.ts`):

1. `requireAdmin()` — authoritative server-side check, not a client claim.
2. The requested `media_id` must belong to the named `listing_id` **and** have
   `type = 'ownership_proof'` — both must match the same row, so a request can't be
   coerced into signing a URL for evidence belonging to a different listing.
3. `admin.storage.from('ownership-proofs').createSignedUrl(path, 120)` — a **120-second**
   signed URL, generated fresh per request, never cached or stored.
4. Live-verified: the URL works while valid (`200`), and fails
   (`400 InvalidJWT — "exp" claim timestamp check failed`) once expired — confirmed by
   letting a real token age past its TTL and re-fetching.

## RLS / RPC trust boundary

| Layer | Who can read/write |
|---|---|
| `listing_ownership_verification` (base table) | admin read/update only (`profiles.role = 'admin'`), no client INSERT policy |
| `listing_ownership_verification_merchant_view` | merchant reads their own listing's `status`/`merchant_feedback`/`reviewed_at` — never `reviewer_notes`, `reason_code`, or `provider_reference` |
| `admin_action_history` | admin read only, **no merchant policy at all** — the one place full internal detail (`reason_code`, `internal_note`) lives |
| `listing_history` | merchant reads their own listing's history, admin reads all — carries only status transitions + `merchant_feedback`, **never** internal notes (see "Two audit trails" below) |
| `start_ownership_review`, `decide_ownership_verification`, `decide_moderation`, `activate_listing`, `suspend_listing` | `service_role` only — verified empirically (`anon`/`authenticated` both `false`, live query against `pg_proc`/`has_function_privilege`) |
| Storage `ownership-proofs` bucket | uploading merchant (own files) + admin (Phase 2A policy), both via signed/authenticated access — never public |

## Two audit trails, deliberately separate

A real bug was found and fixed during live validation: an early version of
`decide_ownership_verification()`/`decide_moderation()` put `reason_code` and internal
notes into `listing_history`'s `new_values` jsonb — but `listing_history` already has a
merchant-read RLS policy from Phase 2A, so that would have **leaked internal admin
content to the merchant**. Fixed by introducing `admin_action_history` (new, admin-only,
immutable via the shared `prevent_row_mutation()` trigger) as the *only* place
`reason_code`/`reviewer_notes`/`internal_note` are ever persisted. `listing_history`
continues to record the same status-transition shape it always has, now provably safe
(only status values + `merchant_feedback`, which is already designed to be merchant-safe).

## Idempotency

Every mutation RPC is self-contained (idempotency check → state validation → mutation →
history writes → idempotency insert, one transaction), mirroring
`submit_listing_for_review()`'s exact shape rather than checking idempotency at the route
layer. Keys are scoped by `(admin_id, operation, idempotency_key)` — reusing the existing
generic `idempotency_keys` table (its `merchant_id` column holds the **admin's** id here,
the same "generic scoping key" reuse pattern established in Phase 2C for payment
idempotency). `p_listing_id` is part of every request hash, so:

- Same key + same listing + same payload → cached result returned, no duplicate history.
- Same key + different payload (or different listing) → `409 duplicate_workflow_conflict`-style
  rejection, live-verified: reusing a `start_ownership_review` key against a *different*
  listing correctly returned "already submitted with different data," not a silent replay
  or a leak of the first listing's result.
- A terminal ownership decision (`verified`/`rejected`) cannot be reopened by a fresh key
  — `decide_ownership_verification` raises `already has a final decision` regardless of
  idempotency key novelty.

## Known limitations

- **Edits after verification don't force re-review.** See "Invalidation model" above — a
  merchant can still edit sensitive fields post-verification without an automatic
  re-verify trigger. Deliberately the smallest model for this pass, not silently accepted
  as complete.
- **No senior-review workflow for `flagged`.** The status exists and is reachable (a
  future manual admin action, not built as its own route this pass — no UI button sets
  it), but nothing currently *acts* on a flagged listing beyond it not reverting to draft.
- **No merchant banking/insurance-provider integration** — `insuranceAmount` is just a
  number on `listings`, not connected to any real insurance product (unchanged from
  before this pass, unrelated to admin moderation).
- **`admin_action_history`/`listing_ownership_verification` have no automated retention
  policy** — grows unboundedly, same as every other audit table in this schema
  (`listing_history`, `listing_declarations`); not a new gap.
- **A pre-existing, unrelated bug was found and fixed as part of this pass** (see
  "Bugs found during live validation" below) because it directly blocked the
  in-scope resubmission requirement — not a new gap introduced by this pass.

## Bugs found and fixed during live validation (not hypothetical — hit live)

1. **`listings.ownership_verified` never synced.** The pre-existing public "Verified"
   badge field (read by the marketing listing page/card) was never updated by the new
   ownership RPCs — a listing could reach `ownership_verification.status = 'verified'`
   and even go `active` while its public badge still showed unverified. Fixed:
   `decide_ownership_verification()` now sets `listings.ownership_verified = true` when
   the decision is `'verified'` (`20260803000004`).
2. **Resubmission was structurally impossible.** `listing_declarations` has a real,
   pre-existing unique constraint on `(listing_id, declaration_type)` from Phase 2A
   (`20260729000008`) *and* a hard immutability trigger that rejects UPDATE/DELETE for
   every role including `service_role`. Those two constraints directly contradict each
   other for any second submission of the same listing — a merchant could never resubmit
   after changes-required, at all, regardless of this pass's own code. Fixed by dropping
   the unique constraint (schema relaxation, not data-destructive — nothing is deleted or
   rewritten) and reverting `submit_listing_for_review()` to a plain `INSERT`
   (`20260803000006`, after an intermediate upsert attempt in `20260803000005` was itself
   found to violate the immutability trigger and had to be corrected).
3. **`next.config.ts` had no Supabase Storage host in its image `remotePatterns`.** The
   merchant listings page 500'd via `next/image` for any listing with a real photo — a
   pre-existing gap, unrelated to admin moderation, but directly blocking live
   verification of the merchant-facing status UI this pass requires. Fixed with a single
   additive `remotePatterns` entry (`*.supabase.co`).

## Future Sumsub replacement plan

1. Implement `SumsubOwnershipVerificationProvider` for real against the same
   `OwnershipVerificationProvider` interface — no interface change expected; if Sumsub's
   actual API needs something the interface doesn't expose, extend the interface the same
   way Phase 2D extended `WebhookVerificationInput` for Peach (smallest justified change,
   not a redesign).
2. Add a Sumsub webhook route mapping their callback events onto
   `approveOwnership`/`rejectOwnership`/`requestAdditionalEvidence` calls against the same
   provider methods this pass already defines.
3. Flip `OWNERSHIP_VERIFICATION_PROVIDER=sumsub`.
4. `listing_moderation`, `listing_ownership_verification`, activation eligibility, and
   every merchant-facing screen require zero changes — they already only ever call the
   abstraction, never `ManualOwnershipVerificationProvider`, enforced by the
   architecture-fitness test.
