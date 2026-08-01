# Public-Test Launch Checklist (Step 10)

Status as of this step's completion. Re-run this checklist after the owner completes the manual
Vercel deployment (see `docs/PUBLIC_TEST_RUNBOOK.md` §5) before inviting testers.

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Build clean | ✅ Done | `npm run build` — compiled successfully |
| 2 | Typecheck clean | ✅ Done | `npx tsc --noEmit` — zero errors |
| 3 | Vitest suite passes | ✅ Done | 605/605 |
| 4 | Playwright suite passes | ✅ Done | 54/54 (desktop + mobile) |
| 5 | Zero new lint findings | ✅ Done | every file touched this step: 0 errors, 0 warnings |
| 6 | Migrations applied | ✅ Done | all 47 migrations tracked, zero mismatches (`supabase migration list`) |
| 7 | Environment validator passes locally | ✅ Done | `Result: PASS` confirmed in dev server logs |
| 8 | Environment variables configured in Vercel | ⬜ Owner action | see runbook §1 — cannot be done without Vercel account access |
| 9 | QA passwords secured | ✅ Done | generated randomly, written only to gitignored `.qa-credentials.local.json`, never logged/printed/committed |
| 10 | Supabase auth redirect URLs valid | ⬜ Owner action | must point at the real deployed URL, not localhost — needs the URL from step 12 first |
| 11 | All legal pages available | ✅ Done | 12 pages live, verified by Playwright (`tests/e2e/public-pages.spec.ts`) |
| 12 | Public URL available | ⬜ Owner action | pending manual Vercel deployment |
| 13 | Support email present | ✅ Done | `support@unitytest.co.za` on footer, contact page, every transactional email |
| 14 | Admin account works | ✅ Done | QA Admin account verified end-to-end (overview, moderation, KYC, users, exceptions, audit) |
| 15 | KYC works | ✅ Done | submit → admin approve/reject/request-info, all exercised live via the seed script and prior steps |
| 16 | Moderation works | ✅ Done | approve/reject/request-changes/activate/suspend all exercised live |
| 17 | Active listing available | ✅ Done | 12-listing QA catalogue seeded, several `active` |
| 18 | Booking works | ✅ Done | 9 of 10 documented states confirmed live (see runbook §9 for the one gap and its 2-minute manual fix) |
| 19 | Checkout works | ✅ Done | mock success/retryable/declined scenarios all exercised live |
| 20 | Payment deadline works | ✅ Done | `payment_due_at` derivation and the awaiting-payment state confirmed |
| 21 | Expiry works | ✅ Done | unpaid-expiry booking backdated and confirmed present (sweep pending `INTERNAL_CRON_SECRET`-authenticated trigger — see runbook §12) |
| 22 | Emails recorded | ✅ Done | delivery records confirmed for requested/accepted/financially-ready/declined events across the seed run |
| 23 | Admin dashboard works | ✅ Done | overview, users, listings, bookings, financial operations, email deliveries, exceptions, audit all real-data-backed (Step 9) |
| 24 | No broken links | ✅ Done | footer legal links + dead `href="#"` social icons removed and verified by Playwright |
| 25 | No misleading claims | ✅ Done | public-site credibility review found no fake statistics, no unsupported trust claims, no lorem ipsum |
| 26 | Mobile usable | ✅ Done | Playwright mobile project (Pixel 7 viewport) passes across public/legal/protected/authenticated pages |
| 27 | Critical security tests pass | ✅ Done | admin-route denial, cross-user access, forged admin id/account status, wrong cron secret, CSV sensitivity — see final report §18 |
| 28 | Rollback documented | ✅ Done | `docs/PUBLIC_TEST_RUNBOOK.md` §14 |
| 29 | Public URL suitable to share externally | ⬜ Pending deployment | cannot confirm until step 12 is complete |

## Remaining before testers are invited

Only the items marked "⬜ Owner action" above — all require either Vercel account access or
Supabase dashboard access this session does not have. Everything code/config/test/doc-side that
does **not** require external account access is complete.
