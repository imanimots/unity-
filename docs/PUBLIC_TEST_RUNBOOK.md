# Unity Public-Test Runbook (Step 10)

Operational reference for running Unity as an invited-tester public-test deployment. Covers
environment, deployment, day-to-day admin operations, incident handling, and rollback. Written
for whoever operates the deployment day-to-day — not necessarily the person who built it.

## 1. Environment matrix

Validated automatically at server startup by `src/instrumentation.ts` → `src/lib/env/validate.ts`
(names only ever logged, never values). Set these in Vercel's Project → Settings →
Environment Variables, not in a committed file.

| Variable | Public test value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | your dev Supabase project URL | required |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | dev project anon key | required, safe to expose client-side |
| `SUPABASE_SERVICE_ROLE_KEY` | dev project service-role key | required, **server-only** — never add a `NEXT_PUBLIC_` prefix to this |
| `NEXT_PUBLIC_APP_URL` | the deployed Vercel URL (e.g. `https://unity-xxxx.vercel.app`) | update after first deploy, then redeploy — this value is baked into email links and legal-page absolute URLs |
| `NEXT_PUBLIC_MOCK_MODE` | `false` | must be false for real Supabase persistence |
| `PAYMENT_PROVIDER` | `mock` | real Peach integration is explicitly out of scope |
| `OWNERSHIP_VERIFICATION_PROVIDER` | `manual` | admin reviews evidence by hand |
| `IDENTITY_VERIFICATION_PROVIDER` | `manual` | admin reviews KYC by hand |
| `EMAIL_PROVIDER` | `console` (or `resend` once real credentials exist) | console = logged only, never sent |
| `NEXT_PUBLIC_PAYMENT_MODE` | `test` | gates the mock-checkout scenario selector |
| `INTERNAL_CRON_SECRET` | a long random string (`openssl rand -hex 32`) | protects the two internal cron routes below — generate a **new** one for the deployed environment, don't reuse the local dev value |
| `BOOKING_PAYMENT_DEADLINE_HOURS` | `24` (default) | optional |
| `PAYMENT_REMINDER_HOURS_BEFORE_DUE` | `6` (default) | optional |
| `ANTHROPIC_API_KEY` | optional | assistant falls back to a canned response without it |
| `RESEND_API_KEY` | only if `EMAIL_PROVIDER=resend` | never required otherwise |
| `VOYAGE_API_KEY` | optional | assistant falls back to ILIKE search without it |

**Never set**: any `PEACH_*`, `SUMSUB_*`, `PAYFAST_*` variable, or `NODE_ENV=production` production
credentials for a real payment/identity provider. The environment validator does not require
them and their presence has no effect while the providers above stay `mock`/`manual`.

See `docs/FEATURE_FLAG_MATRIX.md` for the full mapping of what each provider setting controls.

## 2. QA accounts

Created and reset by `scripts/qa-seed.mjs` (see §4). Real passwords are never in this document —
they live only in the local, gitignored `.qa-credentials.local.json` written by the seed script.

| Account | Role | KYC | Account status | Purpose |
|---|---|---|---|---|
| QA Admin | admin | approved | active | Runs every admin-side journey: moderation, KYC decisions, user restrictions, exception queue, audit log |
| Merchant A | merchant | approved | active | Owns most of the QA listing catalogue and the "healthy" booking states |
| Merchant B | merchant | approved | active | Owns the pending/changes-required/suspended listing states, second party for cross-merchant scenarios |
| Renter A | renter | approved | active | Drives every renter-side booking/checkout journey |
| Restricted user | renter | approved | **restricted** | Permanently kept restricted — proves "cannot create new booking, existing records stay visible" |
| Suspended user | merchant | approved | **suspended** | Permanently kept suspended — proves "cannot submit/activate listings, existing bookings stay auditable" |

## 3. Provider matrix

See `docs/FEATURE_FLAG_MATRIX.md` — the canonical, single source. Summary: payments, ownership
verification, and identity verification are all simulated/manual by design for this phase; email
is console-logged by default; nothing in this deployment ever moves real money or calls Peach,
Sumsub, or a courier API.

## 4. QA seed & reset

```
QA_SEED_ENABLED=true QA_SEED_CONFIRM=UNITY_DEV_ONLY QA_SEED_PROJECT_REF=<your-dev-project-ref> \
  npm run qa:seed
```

- Refuses to run unless `NODE_ENV` isn't `production`, both confirmation variables are set
  exactly as shown, and the Supabase project ref in `NEXT_PUBLIC_SUPABASE_URL` matches
  `QA_SEED_PROJECT_REF` — a copy-paste mistake against the wrong project aborts immediately.
- Requires the app running at `NEXT_PUBLIC_APP_URL` (booking/listing/KYC lifecycle steps go
  through real HTTP routes, not direct table writes, wherever a route exists).
- Idempotent for accounts and listings — re-running never creates duplicates. Booking-state
  seeding is **not** fully idempotent (real historical `booking_history` rows are immutable by
  design and are never deleted) — re-running adds a fresh set of the 10 documented booking
  states rather than replacing the old ones. This is intentional: it never destroys audit
  history, even QA history.
- Writes credentials to `.qa-credentials.local.json` in the repo root (gitignored). Never paste
  its contents into chat, a ticket, a doc, or a log.
- Produces: 6 QA accounts, a 12-listing catalogue covering every documented risk/pricing/status
  combination, 10 booking/financial-state examples (see §9 for current known gaps), and two
  disposable console-provider email-failure fixture accounts.

To fully reset QA data: there is no destructive "wipe" script, by design (per the brief's own
"do not create destructive rollback migrations" instruction extended here to seed data too).
Re-run the seed script to add a fresh set of examples; old QA rows remain, clearly labelled
`[QA]` in `listings.title`.

## 5. Deployment (Vercel)

1. Push the current `main` branch to GitHub (`git push origin main`) — this repo is already
   connected to `https://github.com/imanimots/unity-`.
2. In the Vercel dashboard: **Add New Project** → import the `unity-` GitHub repository.
3. Framework preset: Next.js (auto-detected). Build command: `next build` (default — do not
   override). Output: default.
4. Add every variable from §1 under Project → Settings → Environment Variables, scoped to
   **Production** (or **Preview**, if deploying a preview URL for testers first — either is fine
   for this step; a temporary Vercel URL is explicitly acceptable per the brief).
5. Deploy. Note the resulting URL (e.g. `https://unity-xxxx.vercel.app`).
6. Set `NEXT_PUBLIC_APP_URL` to that exact URL in the environment variables, then **redeploy**
   (env var changes require a new deployment to take effect) — this URL is what appears in every
   transactional email link and legal-page canonical reference.
7. Confirm the deployment log shows `Result: PASS` from the environment validator (visible in
   Vercel's Runtime Logs after the first request, since `instrumentation.ts` logs on server
   start).

## 6. Supabase configuration

In the Supabase dashboard for the dev project (Authentication → URL Configuration):

- **Site URL**: set to the deployed `NEXT_PUBLIC_APP_URL`.
- **Redirect URLs**: add `<NEXT_PUBLIC_APP_URL>/**` (wildcard) so email-confirmation and
  password-reset links redirect back to the deployed app, not `localhost`.
- **Email confirmation**: leave enabled (Supabase Auth handles this natively — Unity's own
  email service, per `docs/TRANSACTIONAL_EMAILS.md`, deliberately never duplicates it).
- Confirm RLS is enabled on every table (it is, by migration — spot-check `listings`,
  `bookings`, `payments`, `email_deliveries` in the dashboard's Table Editor if in doubt).
- Confirm Storage bucket policies are active (`listing-media`, `ownership-proofs`,
  `identity-documents` — all set up in earlier migrations).
- **Migration history**: run `npx supabase migration list --linked` before any deploy — it must
  show every local migration with a matching `remote` timestamp (zero mismatches). If a gap ever
  reappears (e.g. a migration applied via a one-off `db query` rather than the standard
  migration flow), run `npx supabase migration repair --status applied --linked <version>` for
  that version — this only fixes the tracking table, it does not re-run any SQL.
- **This is a development project, not a future production project** — do not point a real
  production deployment at this same Supabase project without a deliberate, separate migration
  plan. Treat this project as permanently test-only.
- **Backup/export**: Supabase's own daily backups (dashboard → Database → Backups) are the
  backup strategy for this phase — no additional export tooling was built, since a destructive
  loss of QA data is recoverable by re-running `npm run qa:seed`.

## 7. Public URL

Fill in once deployed: `NEXT_PUBLIC_APP_URL = ____________` (see §5, step 6).

## 8. Support process

- Public contact point: `support@unitytest.co.za` (footer, contact page, and every transactional
  email's support line).
- For an invited tester reporting an issue: reproduce with the QA accounts first (§2) before
  touching their real account — this isolates "is this a real bug" from "is this account-specific
  state."

## 9. Known limitations at time of writing

- One of the ten documented booking/financial states ("completed") did not land cleanly in the
  QA seed data during this session's own testing iterations — repeated seed-script runs left
  historical `booking_history` clutter (immutable by design) on a shared listing that interfered
  with the final `confirm-return` step. All nine other states (requested, accepted-awaiting-
  payment, financially-ready, retryable-failure, terminal-decline, active, return-pending,
  cancelled, expired-unpaid-pending-sweep) are confirmed present. To get a live "completed"
  example: run the renter/merchant flow once by hand (request → accept → checkout → start →
  return → confirm-return, ~2 minutes via the QA Admin + Renter A + Merchant A accounts), or
  re-run `npm run qa:seed` against a freshly reset project.
- `PAYMENT_REMINDER_HOURS_BEFORE_DUE` and the unpaid-expiry sweep (§11) do not run on a schedule
  by themselves — nothing in this codebase configures a production cron trigger automatically
  (explicit stop condition from Step 6 forward: "do not configure production cron
  automatically"). Vercel Cron (or any external scheduler) must be configured separately,
  pointed at the two routes in §11, authenticated with `INTERNAL_CRON_SECRET`.
- No custom domain — a Vercel-issued URL is used for this phase (explicitly acceptable).
- See `docs/ADMIN_OPERATIONS.md` and `docs/TRANSACTIONAL_EMAILS.md` for each of their own
  known-limitations sections (email retry attribution, overview-count approximations, etc.) —
  not repeated here.

## 10. Daily admin checks

Using the QA Admin account (or a real admin account once one exists):

1. `/admin` overview — scan for `pending_kyc_reviews`, `pending_ownership_reviews`,
   `pending_listing_moderation` > 0.
2. `/admin/exceptions` — resolve or action anything `severity: high`.
3. `/admin/email-deliveries` — filter to `failed_retryable`, retry each; investigate any
   `failed_terminal` (these need a config/code fix, not a retry).
4. `/admin/audit` — spot-check recent admin actions look expected (no surprise restrictions/
   suspensions).

## 11. Exception-queue and failed-email process

- Exception queue (`/admin/exceptions`) is computed live from current table state — nothing to
  "process" beyond reviewing and resolving. Each row's `suggestedAction` names the exact admin
  surface to use.
- Failed emails: `failed_retryable` rows can be retried directly from `/admin/email-deliveries`.
  `failed_terminal` rows need investigation (check `EMAIL_PROVIDER` config, or if using Resend,
  check the Resend dashboard) before any retry will help.

## 12. Unpaid-expiry and reminder cron

Two internal routes, both closed by default (503) until `INTERNAL_CRON_SECRET` is set, then
require `Authorization: Bearer <INTERNAL_CRON_SECRET>`:

- `POST /api/internal/expire-unpaid-bookings` — sweeps accepted-but-unpaid bookings past their
  deadline; recommended cadence 5–15 minutes.
- `POST /api/internal/email/send-payment-reminders` — sends the one reminder email per booking
  inside the configured window; recommended cadence hourly.
- `POST /api/internal/email/retry-failed` — sweeps all `failed_retryable` email deliveries;
  recommended cadence hourly.

Configure via Vercel Cron (`vercel.json`'s `crons` array) once a schedule is decided — not
configured automatically per this step's own stop condition.

## 12a. Affiliate commission automation (Step 11 Phase 7)

Four more `INTERNAL_CRON_SECRET`-gated routes, same 503-until-configured / bearer-token pattern
as §12. None is wired to Vercel Cron yet — invoke manually (or via a shell loop) until a schedule
is decided:

```
curl -X POST https://<host>/api/internal/affiliate/review-and-approve -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/queue-payouts -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/process-payouts -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
curl -X POST https://<host>/api/internal/affiliate/reconcile-refunds -H "Authorization: Bearer $INTERNAL_CRON_SECRET"
```

Recommended order and cadence: run `review-and-approve` then `queue-payouts` then
`process-payouts` in sequence (each only acts on rows the previous step already moved),
hourly; run `reconcile-refunds` on its own, every few hours. Each processes a bounded batch and
is safely re-runnable. See `docs/AFFILIATE_SYSTEM.md` for what each transition does.

## 13. Incident handling

1. Identify scope: is it one user, one booking, or systemic? Check `/admin/exceptions` and
   `/admin/audit` first.
2. If systemic and payment-related: remember `PAYMENT_PROVIDER=mock` — no real money is ever at
   risk in this deployment, which simplifies triage considerably.
3. If a security concern: see §14 rollback — disabling the affected capability is safer than a
   rushed code fix under pressure.
4. Document the incident (what happened, what was affected, what was done) — no formal ticketing
   system is assumed; a shared doc or issue is sufficient for this phase.

## 14. Rollback and safe-disable reference

No destructive rollback migrations exist for applied schema (per this project's standing
convention — forward fixes only). To roll back or disable:

| Action | How |
|---|---|
| Roll back to the previous deployment | Vercel dashboard → Deployments → select the prior successful deployment → **Promote to Production** |
| Roll back a specific code change | `git revert <commit>` and push — never `git reset --hard` on a shared branch |
| Disable checkout entirely | Set `NEXT_PUBLIC_PAYMENT_MODE` to something other than `test` in Vercel env vars and redeploy — the mock-scenario selector and checkout UI become unavailable (`docs/MOCK_CHECKOUT.md`'s own double-gate) |
| Disable new registrations | Supabase dashboard → Authentication → Providers → toggle email sign-ups off (temporary, reversible, no code change) |
| Switch email provider to console | Set `EMAIL_PROVIDER=console` in Vercel env vars and redeploy — no other code change needed (`docs/TRANSACTIONAL_EMAILS.md`) |
| Disable the AI assistant | Remove `ANTHROPIC_API_KEY` from env vars and redeploy — the chat endpoint falls back to a canned response, never errors |
| Suspend the marketplace without losing records | Use the existing per-listing suspend action (`/admin/listings`) and per-user suspend action (`/admin/users`) at scale rather than taking the app down — every suspended record stays fully readable and auditable; nothing is deleted |
| Recreate QA seed data | `npm run qa:seed` (see §4) |
| Restore Supabase data from a backup | Supabase dashboard → Database → Backups → restore (destructive to data created after the backup point — use only if genuinely necessary, and confirm with the project owner first) |

## 15. Criteria for ending test mode

Test mode (this entire configuration — mock payments, manual verification, console/limited
email) should end only when **all** of the following are true, none of which this step
implements:

- A real payment provider (Peach) has been reviewed, approved, and integrated with production
  credentials — explicitly out of scope for this step.
- A real identity/ownership verification vendor (Sumsub or equivalent) is integrated, or the
  business has made a deliberate decision to keep manual review permanently.
- Legalese has reviewed and approved the live legal page content (see
  `docs/LEGAL_CONTENT_MAP.md` for what's currently published) — pending as of this step.
- A production Supabase project (separate from this development project) has been provisioned
  and its own migration/environment setup completed from scratch.
- A custom domain and production email-sending domain/DNS are configured.
- The launch checklist in `docs/PUBLIC_TEST_LAUNCH_CHECKLIST.md` has been re-run against the
  production configuration, not just this test deployment.
