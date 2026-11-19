# C — Environment Separation Verification

## What was actually built and verified this session

`src/lib/env/environment-separation.ts` + its wiring into `next.config.ts` (commit `26c35a8`). This is **real, tested, working code**, not a plan:

1. **Pure logic, 8 unit tests, all passing**: `checkEnvironmentSeparation()` takes explicit parameters (no hidden `process.env` reads), covering every combination of production/non-production deployment against production/non-production-configured Supabase URLs.
2. **Live-verified at the actual build-tool level**, not just in a test runner: ran `next build` with `VERCEL_ENV=production` and `PRODUCTION_SUPABASE_PROJECT_REF` set to a value that deliberately didn't match the configured Supabase URL — the build **failed immediately** with the exact intended error message (`[environment-separation] Refusing to start: VERCEL_ENV=production but NEXT_PUBLIC_SUPABASE_URL does not match PRODUCTION_SUPABASE_PROJECT_REF...`). Then ran a clean `next build` immediately after, with no override env vars — succeeded normally, confirming the real (today, single-project) state is correctly treated as safe.

## What this proves

**Production and staging cannot accidentally share credentials or write to each other's databases, once the new project exists and its ref is set as `PRODUCTION_SUPABASE_PROJECT_REF`.** This is enforced at build/startup time — a misconfigured deployment doesn't silently run against the wrong database, it refuses to start at all.

## What this does not yet prove (because the second project doesn't exist)

- That the *real* new production project, once created, will actually be configured correctly in Vercel's environment-variable scoping (production vs. preview/development) — this guard catches a *mismatch*, but someone still has to set `PRODUCTION_SUPABASE_PROJECT_REF` and the per-environment Supabase URLs correctly in Vercel in the first place. The guard is a safety net, not a substitute for correct initial configuration.
- Test-payment-mode isolation specifically (the brief's "test payment modes cannot create live financial movements") — this is governed by the existing `PAYMENT_PROVIDER`/`NEXT_PUBLIC_PAYMENT_MODE` env vars and the mock-provider production-lockout pattern (`ProviderNotPermittedError`, confirmed sound in the original technical audit) — unrelated to which Supabase project is configured, and unchanged this session.
- Analytics cross-contamination between environments specifically — `analytics_events` already carries a `data_classification` field (`real`/`test`/`unknown`), but this classifies *rows within one project*, not *which project an environment writes to*. Once two projects exist, analytics separation is automatic (each project has its own `analytics_events` table) — there is no additional code needed for this specific concern once the environment-separation guard above is correctly configured.

## Developer access does not automatically grant production database access

**Unverified claim, correctly left unverified.** This depends entirely on how Supabase project membership/roles are configured for the *new* project once it exists — a dashboard/organization-permissions question this session has no access to confirm or configure.
