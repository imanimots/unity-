# Operational Monitoring Dashboard — Design (not yet buildable)

**This cannot be built as a working dashboard today — there is nothing to consolidate yet.** No Sentry (or equivalent), no uptime monitor, and no database-health check exists anywhere in this codebase (confirmed by this and the preceding audit). This document designs what the dashboard should show once those sources exist, so provisioning them can target this design rather than being designed after the fact.

## What already exists and could feed this dashboard immediately, with zero new vendor dependency

| Source | Already exists | What it would contribute |
|---|---|---|
| `/admin/audit` | Yes (`src/lib/admin/audit-service.ts`) | Admin mutation/access history — already real, already queryable |
| `/admin/exceptions` | Yes (confirmed in the preceding audit) | Live-computed admin exceptions (e.g. missing Unity commissions) |
| `/admin/email-deliveries` | Yes | Failed-email visibility |
| Database row counts (this session's own read-only checks) | Partially — ad hoc, not a standing dashboard | Confirms data is flowing, catches an obviously-stuck pipeline |

A genuinely useful first version of "one operational overview" could be built **today, with no new vendor**, simply by surfacing these four existing sources on one new internal admin page — that is real, buildable, zero-cost work this session did not undertake because it wasn't named as an explicit task in the prior programme and this session's time was prioritized toward the items both briefs named directly. Flagged here as a legitimate, cheap next step, not a requirement this report is dodging.

## What requires a vendor decision first (cannot be built until then)

| Signal | Needs |
|---|---|
| Website availability (uptime) | A pinger service (even a free tier of UptimeRobot/Better Uptime, or Vercel's own built-in monitoring if the plan tier includes it — not confirmed) |
| Critical application errors | Sentry or equivalent (see `MONITORING_INTEGRATION_SPEC.md`) |
| Database health (connection pool, slow queries) | Supabase's own dashboard metrics, or a custom health-check route calling a lightweight query on a schedule |
| Failed scheduled jobs | Sentry capturing the cron routes' own error branches, or Vercel's cron-execution log (dashboard-only, not accessible this session) |
| Search failures | Sentry capturing `search_listings` RPC errors specifically |
| Storage errors | Sentry capturing `.storage.from()` error branches |
| Payment failures | Already durably logged (`payments.status`, `OrchestrationError`) — Sentry would add real-time alerting on top of what's already captured |
| Booking exceptions | Same — already logged, needs real-time alerting layered on |
| Security alerts | The new `admin_kyc_document_access_log` + existing `admin_action_history`, surfaced as an alert when an unusual pattern appears (e.g. one admin viewing an unusually high volume of KYC documents in a short window) — this specific anomaly-detection logic does not exist yet and would need to be purpose-built, not provided by a generic monitoring vendor |

## Triage categories (for the Technical Coordinator, once the dashboard exists)

The dashboard's job is to make these five categories visually distinguishable at a glance, not just list raw events:

1. **Immediate escalation** — anything touching payments, payouts, or a security alert. Should visually stand out (color, position) from everything else.
2. **External-developer-resolvable** — a typical application bug or failed job with a clear stack trace/cause.
3. **Provider outage** — Supabase/payment-provider/KYC-provider errors that correlate with the provider's own status page, not this codebase.
4. **Recurring defect needing architectural investigation** — the same error signature appearing repeatedly over days/weeks, which this session's own experience (the admin-performance N+1 investigation) shows is a real, previously-seen pattern in this project specifically.
5. **Informational, no action needed** — routine 4xx denials, expected rate-limit hits, etc. — explicitly NOT alerted on, only visible if someone goes looking.

This categorization should be the dashboard's primary organizing structure once built — not an afterthought bolted onto a plain error list.
