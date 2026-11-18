# Incident Response Workflow

Uses the organizational structure given for this engagement: **Technical Coordinator** (monitors and coordinates technical response), **External Developer/Technical Provider** (executes technical repairs), **Operations Manager** (coordinates business impact), **Founder** (receives material escalations, approves major strategic/financial decisions). The Founder is deliberately never assigned routine technical execution below.

## 1. Detection

Today, detection is **manual** — a user report, or someone noticing something while using the admin panel. This is a real, named gap (no automated alerting exists yet — see `MONITORING_INTEGRATION_SPEC.md`). Until that's provisioned, this workflow's first step is inherently slower than it should be; this document does not pretend otherwise.

## 2. Severity classification

Classify against the same four-tier risk model this engagement has used elsewhere:

| Severity | Examples | Who classifies |
|---|---|---|
| **Critical** | Live financial-record corruption, payout controls malfunctioning, customer data breach, site-wide outage | Technical Coordinator, immediately escalates to Founder in parallel with starting technical response |
| **High** | A core transaction flow broken (booking, checkout, dispute) for some/all users; a confirmed security vulnerability being actively exploited | Technical Coordinator |
| **Medium** | A non-critical feature broken, a performance degradation (e.g. this engagement's own admin-overview-page slowness before it was fixed), a failed scheduled job with no immediate data-loss risk | Technical Coordinator |
| **Low** | A cosmetic issue, a flaky-but-non-blocking test, an informational anomaly | Technical Coordinator, logged but not escalated |

## 3. Assigned owner

- **Critical/High:** Technical Coordinator owns coordination; External Developer owns the actual fix; Operations Manager is looped in immediately for customer-communication needs; Founder is notified, not asked to debug.
- **Medium/Low:** Technical Coordinator and External Developer handle it without escalating further up, unless investigation reveals it's actually more severe than first classified.

## 4. Technical investigation

Follow this engagement's own established, proven discipline (used repeatedly and explicitly throughout this project's history): **isolate, reproduce cleanly, and only then classify** — a single anomalous reading (a failed test, a slow page, an error report) is never treated as confirmed without a clean, isolated reproduction first. This exact discipline caught and correctly resolved multiple apparent "regressions" in this session alone that turned out to be environmental flakiness, not real defects (see `production-readiness-output/J-final-git-and-test-report.md`).

## 5. Customer impact assessment

Operations Manager determines: how many users affected, what they can/can't currently do, whether a user-facing status message is warranted (no status page currently exists in this codebase — that's a gap this workflow surfaces, not one it can close by itself).

## 6. Escalation

- Critical issues escalate to the Founder **immediately**, in parallel with (not after) starting the technical response — the workflow should never delay investigation to wait for permission to investigate.
- Founder approval is required before any **material production action** — matching this engagement's own standing risk classification (see `production-readiness-output/G-deployment-readiness-checklist.md`'s risk tiers) — e.g. a production database restore, a force-push, a security-control rollback.
- Founder is **not** the point of escalation for a Medium/Low issue, or for routine technical decisions within an incident response — that would misuse their time and create a bottleneck this structure is designed to avoid.

## 7. Recovery

External Developer executes the fix, following the same safety discipline as any other change in this codebase: never a destructive action without confirming it's necessary, never bypassing RLS/auth to move faster, never a rollback migration (this project's standing forward-fix-only convention) unless a true rollback is the only safe option.

## 8. Verification

Before declaring an incident resolved: re-run the relevant tests (unit/E2E as applicable), confirm the specific user-facing symptom is gone, and confirm via a clean, isolated check — not a single passing run under uncertain conditions — matching step 4's discipline.

## 9. Post-incident review

For Critical/High incidents: a short written record (what happened, root cause, what was changed, what would prevent recurrence) — this project's own disaster-recovery runbook and the various phase reports throughout this engagement already model exactly this kind of after-action documentation; post-incident reviews should follow the same standard of specificity (cite the actual file/line/commit that fixed it, not a vague summary).

## What this workflow cannot do until the named gaps close

- Detect an incident before a human notices (needs monitoring/alerting).
- Confirm infrastructure-level causes (needs Supabase dashboard access for anything beyond application code).
- Communicate proactively with affected users (needs a status-page mechanism, which doesn't exist).
