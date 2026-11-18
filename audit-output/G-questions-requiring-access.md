# Questions Requiring Vendor Console, Credential, or Consultant Access

Everything below was genuinely unanswerable from the repository alone. None of these were fabricated or guessed at — each is listed with the exact evidence that would resolve it.

## Supabase Dashboard

1. **What is the actual configured project region** for `pwueguyrlcorurvbphej`? (Project Settings → General) — blocks the POPIA data-residency determination (Doc F, P0-6).
2. **What is the automatic backup frequency and retention window**? (Database → Backups)
3. **Is Point-in-Time Recovery (PITR) enabled, and what is its window**? (Database → Backups, or plan-tier settings)
4. **Has a restore ever actually been tested or performed** on this project, and if so, when and how long did it take? (Likely not visible in the dashboard itself — may need to ask whoever has operated this project historically.)
5. **What is the admin-account MFA enforcement setting**, if any? (Authentication → Policies / Providers)
6. **What is the password-strength policy** configured for Supabase Auth? (Authentication → Policies)
7. **What is current storage usage and monthly cost**, broken down by bucket if possible? (Storage, or the billing/usage dashboard)
8. **What is the current Postgres row count** for the largest tables (`analytics_events`, `email_deliveries`, `bookings`, `payments`) — needed to calibrate whether the missing retention jobs (Doc F, P1-4) are already urgent or still have headroom.

## Vercel Dashboard

9. **What region(s) is the application deployed to**? (Project Settings → Functions/Regions) — relevant to both latency and data-residency questions.
10. **Is there any existing bot-protection/WAF configuration** (Vercel's own, or a separate service) in front of the application? Not visible from `vercel.json` alone.

## Payment / KYC Provider Consoles (Peach, Sumsub)

11. **Does the live payment provider integration have a documented fallback or degraded mode** if the provider is unreachable, or is checkout simply blocked? (Provider dashboard/support, plus a review of the actual production configuration — the code's error-handling path was reviewed, but the provider's own uptime/SLA commitments were not.)
12. **What is Sumsub's data-residency commitment** for the KYC documents and verification data it processes on Unity's behalf? Relevant to the same POPIA cross-border question as #1.

## Legal / Compliance Consultant

13. **Is the current `legal_acceptances` checkbox mechanism sufficient under POPIA**, or is a dedicated cookie-consent banner with granular toggles legally required even in the absence of third-party ad pixels? (Doc B §3 flags this as a documented-but-unbuilt requirement — a lawyer, not an engineer, should confirm how urgent this is.)
14. **What is an appropriate, legally-defensible retention period per data category** (KYC documents, analytics events, transactional records)? The code currently defers to "as required for legal purposes" with no concrete number.
15. **Does Unity have a documented POPIA breach-notification procedure**? None was found in `docs/` — this needs counsel's input, not a code search.
16. **Does using Supabase, Sumsub, and the payment provider (each likely hosted outside South Africa, pending #1/#12) trigger any POPIA cross-border transfer obligations**, and if so, are the appropriate contractual safeguards (e.g. processor agreements) in place? This is squarely a legal question once the technical facts (#1, #12) are known.

## Internal / Operational

17. **Who currently owns "Backup Ops"** — `docs/WAVE0_OPERATIONS.md:90` lists this role as `TBD`. Until someone owns it, items P0-1/P0-2 in the backlog have no clear driver.
18. **Has a security review or penetration test ever been performed** on this application? No evidence either way was found in the repo.
19. **What third-party vendors (Sumsub, the payment provider, Supabase, any logistics/notification providers listed in `docs/ARCHITECTURE.md` as aspirational) have signed data-processing agreements in place**, and do those agreements address the data flows described in Doc B?

None of the above should be treated as "probably fine" by default — each is a genuine unknown, and several (region, backups, MFA, breach-notification process) are consequential enough that they should be resolved before any production-launch decision, not after.
