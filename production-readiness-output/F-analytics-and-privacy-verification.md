# F — Analytics and Privacy Verification

## GA4 / Meta

**Confirmed absent, again, this session.** Re-ran the same exhaustive grep the original audit used across `src/` — zero hits. There is nothing to verify provider-side delivery for, because nothing sends data to either platform. Any future claim of "GA4/Meta tracking operational" would need actual provider-dashboard confirmation (event delivery visible in GA4's own real-time report, or Meta's Events Manager) — not possible without those accounts, and moot until the integration itself exists.

## Consent management (re-verified this session, not just carried over)

- `src/lib/analytics/client.ts`'s `trackEvent()` gate (`hasAnalyticsConsent()`) re-confirmed present and unchanged.
- Re-ran the 4 dedicated consent-gate unit tests (no decision → no-op; declined → no-op; granted → fires; stale schema version → no-op) — all pass.
- **Not re-verified in a live browser this session** (it was verified end-to-end in the prior session; this session's time went to new verification work — RLS, MFA — rather than re-confirming an already-browser-verified feature with no code change since).
- Confirmed via code review: the consent choice is read fresh on every `trackEvent()` call (not cached at module load), so a mid-session consent change takes effect immediately without needing a page refresh — though this specific behavior was not re-tested live this session.

## Distinguishing verification levels (per this phase's own requirement)

| Level | Status |
|---|---|
| Code-level | Verified — gate exists, is tested, fails closed |
| Browser-level | Verified in the prior session (end-to-end Playwright run); not re-run this session |
| Provider-level delivery | **Not applicable** — no third-party provider exists to confirm delivery to |
| Production | **Not verified** — nothing in this session confirms the consent banner or the gate behaves identically once actually deployed, as opposed to in this dev environment |

## Transaction-event verification

- The 6 new lifecycle events (`payment_outcome`, `handover_confirmed`, `return_confirmed`, `refund_issued`, `dispute_opened`, `payout_processed`) added in the prior session were re-confirmed present in the schema and taxonomy this session (typecheck/lint/test all pass, unchanged).
- **Not independently re-verified against live data this session** — none of these events have fired against the real database yet (the underlying code paths require an actual transaction to occur; this session did not create or process one, consistent with the standing no-live-financial-mutation policy).
- Deduplication: unchanged from the existing architecture — `event_id` uniqueness + `ON CONFLICT DO NOTHING` at the RPC layer, already reviewed and found sound in the original audit.

## Legal-review questions prepared for POPIA/UNity's specific data practices

1. Does a localStorage-only consent record (no server-side receipt) satisfy POPIA's accountability requirements for this specific use case (first-party behavioral analytics, no third-party sharing), or is a server-recorded receipt — similar to the existing `legal_acceptances` table — also required?
2. Is "365 days" (analytics events) and "180 days" (email delivery logs) a defensible retention period for these specific data categories, or does POPIA/this business's own policy require something different? Both numbers were chosen as reasonable engineering defaults, not as numbers legal has reviewed.
3. Given this session's finding that production and QA/test data share one database with no structural separation (Doc D), does POPIA's data-minimization principle have anything to say about retaining 9,259 test-fixture rows indefinitely alongside real user data in the same tables?
4. Does the planned malware-scanning integration (Doc: `MALWARE_SCANNING_PROVIDER_SPEC.md`) need a specific data-residency commitment from the vendor, given it would process (even briefly) the content of KYC documents and other potentially sensitive uploads?
5. Is the current `legal_acceptances` checkbox mechanism (terms/privacy/popia, unchanged from the original audit) sufficient on its own, or does the newer cookie-consent banner need to be cross-referenced with it in any way (e.g., should declining analytics consent also surface in that table)?

**No legal wording was finalized by this session** — per the brief's own instruction, these are questions prepared for counsel, not answers assumed on counsel's behalf.
