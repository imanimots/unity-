# Remaining Blockers

Grouped by what's needed to unblock each one — nothing below was fabricated or assumed resolved.

## Requires Supabase dashboard access

- Confirm actual backup frequency, PITR enablement/window, and project region.
- Confirm whether Storage (object) data has any backup/versioning independent of the database backup.
- Confirm whether a restore has ever been performed on this project, by anyone, and if so when and how long it took.
- Enable/confirm admin-account MFA policy (prerequisite for Phase 1 item 4, not attempted this session).
- Confirm Supabase Auth's password-strength policy.

## Requires Vercel access

- Add the two new cron schedule lines to `vercel.json` (one line each for `/api/internal/analytics/purge-events` and `/api/internal/email/purge-deliveries`) — this project's own standing policy treats `vercel.json` as a parked file that must not be edited without your explicit approval, so this was deliberately left for you or whoever owns that file.
- Confirm deployment region and rollback mechanics for this specific project configuration.

## Requires Google Analytics / Meta account access

**None currently applicable** — neither is integrated into this codebase. This is not a blocker so much as a confirmed non-issue; flagged here only so it isn't mistaken for an oversight.

## Requires external service credentials

- A malware/virus-scanning vendor (Phase 1 item 6) — not selected, not provisioned, not built against.
- Sentry or an equivalent error-monitoring/alerting provider (Phase 1 item 7) — same status.

## Requires legal review

- Final copy for the cookie-consent banner (currently placeholder English, matching this codebase's existing convention for other recently-added UI chrome) — needs South African legal/privacy review before it's genuinely launch-ready copy, not just a technically-functioning gate.
- Confirmation of whether a localStorage-only consent record satisfies POPIA on its own, or whether a server-recorded consent receipt (similar to the existing `legal_acceptances` table) is also required.
- A documented POPIA breach-notification procedure — confirmed absent in the preceding audit, still absent; this programme's disaster-recovery runbook names the gap but cannot substitute for the legal process itself.
- Precise, per-category data-retention periods (the preceding audit found only "as required for legal purposes" language) — this programme added *mechanisms* (the two new retention jobs) without that mechanism's actual retention window (365 days / 180 days, both chosen as reasonable defaults, not as numbers legal has signed off on).

## Requires financial authorization

**None this session.** No payment, payout, refund, or financial-configuration change was made or proposed.

## Requires production rollout approval

- Merging `platform-improvement-programme` into `main`.
- Scheduling the two new cron jobs (see "Requires Vercel access" above).
- Any future MFA-enforcement rollout (Phase 1 item 4) — explicitly requires a supervised, staged process, not a single deploy.

## Explicitly NOT a blocker (confirmed, not assumed)

- The search filter fix, the analytics taxonomy expansion, the consent banner, the two retention jobs' code, the two new indexes, and the admin KYC access logging are all complete, tested, and have no external dependency standing between them and a merge decision — the only gate on those is your own review and approval to merge.
