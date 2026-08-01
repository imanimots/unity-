# Feature & Provider Flag Matrix (Step 10)

The centralized reference for what is live, simulated, or disabled in the public-test
deployment. There is no separate runtime "feature flags" table or service — every flag here is
either an environment variable already validated by `src/lib/env/validate.ts`
(`docs/PUBLIC_TEST_RUNBOOK.md` → Environment Validation) or a UI/route-level absence that was
verified directly (no dead button, no hidden route left reachable).

| Capability | Public-test setting | Enforced by | UI behavior when disabled |
|---|---|---|---|
| Payments | `PAYMENT_PROVIDER=mock` | `src/lib/payments/registry.ts` | Checkout shows the mock-scenario selector with a visible test-mode banner; no real card entry exists anywhere in the codebase |
| Ownership verification | `OWNERSHIP_VERIFICATION_PROVIDER=manual` | `src/lib/ownership-verification/registry.ts` | Admin review queue only — a human decides, no automated verdict |
| Identity verification (KYC) | `IDENTITY_VERIFICATION_PROVIDER=manual` | `src/lib/identity-verification/registry.ts` | Same — admin review queue only |
| Transactional email | `EMAIL_PROVIDER=console` (or `resend` once real credentials exist) | `src/lib/email/registry.ts` | Console: logged, never sent externally. Resend: real send, still test-mode wording on financial emails |
| AI assistant | Enabled; falls back to a canned response without `ANTHROPIC_API_KEY` | `src/app/api/assistant/chat/route.ts` | No page depends on it being live — chat widget degrades gracefully |
| Buying & selling | **Disabled** — no UI route exists | N/A (never built) | `listing_type='sale'`/`order_status` columns exist in the schema (Step "buying/selling" groundwork) but no page, API route, or nav link reads or writes them — confirmed by a repo-wide search for any live consumer |
| Disputes execution | **Disabled** — honest empty state | `src/app/admin/disputes/page.tsx` (Step 9) | Shows "Dispute handling is not built yet," no fake counts, no action buttons |
| Real payouts | **Disabled** — no execution path | N/A | `merchant_payouts` rows are visible read-only in `/admin/financial-operations` (Step 9); nothing ever transitions a payout to `paid` |
| Real refunds | **Disabled** — no execution path | N/A | `refunds` table exists (Step 5 payment schema) for future use; no route ever creates or processes one |
| Courier / logistics (Bob Go, Pargo) | **Disabled** | N/A | Handover is manual, described as such on `/delivery-and-handover`; no API credentials configured, no route calls out to either provider |
| Peach Payments | **Never called** | `PAYMENT_PROVIDER=mock` (see `docs/PEACH_INTEGRATION.md`) | Peach env vars are accepted by config validation only (Step "discovery phase") — no live API call exists in the codebase |
| Sumsub | **Never called** | `*_VERIFICATION_PROVIDER=manual` | Same pattern — accepted as a future provider key, no implementation exists |

## How this is verified, not just declared

- `src/lib/env/validate.ts` treats `PAYMENT_PROVIDER`, `OWNERSHIP_VERIFICATION_PROVIDER`, and
  `IDENTITY_VERIFICATION_PROVIDER` as **required to equal an exact safe value** (`mock` /
  `manual` / `manual`) — not merely "present." A misconfigured deployment fails validation
  loudly (production boot throws; dev/build logs a visible FAIL line) rather than silently
  running against a provider nobody reviewed.
- Every "disabled" row above was checked by searching the deployed route tree
  (`src/app/api/**`, `src/app/(marketing)/**`, `src/app/(dashboard)/**`) for any live consumer
  of the corresponding schema — a column existing in a migration is not the same as a feature
  being reachable, and this matrix only marks something "enabled" if a real user-reachable path
  exists.
- No page in this codebase renders an action button for a disabled capability — the admin
  disputes page is the one place that previously did (Step 9 replaced it with an honest empty
  state); every other "not built" area was simply never given a UI entry point in the first
  place, so there was nothing to disable.
