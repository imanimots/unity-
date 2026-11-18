# Error Monitoring / Alerting — Integration Spec

**Nothing is installed.** A Sentry (or equivalent) SDK with no real DSN configured is inert — it would report to nowhere, which is not meaningfully different from having nothing at all, just with an extra dependency and a false sense of coverage. This document is the exact spec for whoever provisions a real account.

## 1. Recommended provider and why

**Sentry** is the specific recommendation — it's the provider this entire engagement's prior phases have consistently named as the reference choice, it has first-party Next.js support (both edge and server runtimes, matching this app's App Router architecture), and its free/low tier is proportionate to this project's current scale (no evidence anywhere in this codebase of existing traffic that would need an enterprise-tier plan). An equivalent (Datadog, Rollbar, etc.) would work too — this spec's integration steps are Sentry-specific, but the *coverage requirements* in §2 apply to any provider chosen.

## 2. What must be covered (per this phase's brief, mapped to this codebase's actual structure)

| Requirement | Where it lives in this codebase |
|---|---|
| Frontend exceptions | Every Client Component — Sentry's Next.js SDK auto-instruments this |
| Backend exceptions | Every `route.ts` under `src/app/api/` — currently each one has its own `console.error(...)` call; Sentry's SDK can capture these automatically once initialized, no per-route code change needed |
| API failures | Same as above |
| Failed scheduled jobs | The internal cron routes (`src/app/api/internal/**/route.ts`) — currently log via `console.error` on RPC failure; same auto-capture applies |
| Authentication anomalies | `requireAdmin()`/`requireAuth()` denial paths — currently silent (return `null`), by design (a denial is normal, expected traffic, not inherently an error) — **only a genuine exception inside auth code should alert, not every denied request**, or this would generate alert fatigue from routine unauthenticated traffic |
| Unexpected permission failures | Same distinction as above |
| Storage failures | `createSignedUrl`/`upload`/`.storage.from()` error branches, already present in multiple routes |
| Integration failures | Payment provider, KYC provider, Voyage AI, Upstash Redis — all already have explicit error-handling branches to hook into |
| Payment and booking errors | `OrchestrationError` branches in the checkout/booking routes — already structured, already logged |
| Significant administrative security events | The new `admin_kyc_document_access_log` and existing `admin_action_history` — these are durable records already; Sentry's role here is *real-time* notification of something urgent, not a replacement for the durable audit trail |

## 3. Exact integration steps (once a Sentry account/DSN exists)

1. `npm install @sentry/nextjs`.
2. Run Sentry's own `npx @sentry/wizard@latest -i nextjs` (or manually create `sentry.client.config.ts`/`sentry.server.config.ts`/`sentry.edge.config.ts` per Sentry's current Next.js documentation) — this generates the standard three-runtime config Next.js App Router needs.
3. Set `SENTRY_DSN` (and `NEXT_PUBLIC_SENTRY_DSN` for the client-side config) as environment variables — never hardcoded.
4. **Data filtering (non-negotiable before going live):** configure Sentry's `beforeSend` hook to strip:
   - Any `Authorization` header value from captured request context.
   - Any field matching this codebase's own existing sensitive-field names (`id_reference_number`, `account_number`, `password`, KYC document storage paths) from error context/breadcrumbs.
   - PII already excluded from this app's own analytics system (confirmed: no raw search query text, no card/bank details) should be held to the same standard here — reuse that existing discipline, don't invent a separate one.
5. Configure severity routing: payment/booking/auth-anomaly errors → high priority; routine 4xx denials → not captured as errors at all (they're expected traffic, not failures) — explicitly exclude `401`/`403`/`404` responses from error capture unless they originate from an actual unhandled exception, not a deliberate denial branch.
6. **Safe test alert:** once configured, deliberately trigger one handled exception in a non-production context (e.g., temporarily throwing from a test route) and confirm it appears in the Sentry dashboard within minutes, with no sensitive data in the captured payload. Remove the test trigger afterward.

## 4. What this spec does not include

- Actually provisioning the Sentry account (needs your decision + payment details, even for a free tier signup).
- A consolidated operational dashboard beyond what Sentry itself provides — see `docs/operations/OPERATIONAL_MONITORING_DASHBOARD_DESIGN.md` for how this fits into the broader monitoring picture once other sources (uptime, database health) are also available.
