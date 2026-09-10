# KYC Upload Intent Cleanup — Operational Runbook

## Purpose

KYC document uploads use a staged flow: the app first creates an *upload
intent* row (`public.kyc_document_upload_intents`), then the browser
uploads the file to the private `kyc-documents` Storage bucket, then a
server call finalizes the intent into an immutable
`identity_verification_documents` record.

If the user abandons the flow after step 1 (or after step 2), the intent
row is left `pending` and — if step 2 happened — a private file is left
in Storage with no metadata record. Each intent has a 6-hour TTL
(`expires_at`). After that, the **B3C cleanup route** claims the expired
intent, deletes any orphaned Storage object that was never registered,
and marks the intent terminal (`cleaned`), or `preserved` if the path
turns out to belong to a genuinely registered document.

This runbook covers the **scheduler** that invokes that route
automatically (phase B3D).

## Architecture

```
GitHub Actions (hourly, minute 17 UTC)
        │  one authenticated HTTPS POST, no body
        ▼
POST /api/internal/kyc/cleanup-upload-intents      (Vercel, Unity app)
        │  service-role
        ▼
claim_expired_kyc_upload_intents(p_limit => 100)   (Postgres, SECURITY DEFINER)
        │  FOR UPDATE SKIP LOCKED, pending+past-deadline → expired
        ▼
resolveExpiredKycUploadIntent(...)  per candidate
        ├─ registered path      → intent marked `preserved`, object untouched
        ├─ object present        → object deleted, intent marked `cleaned`
        └─ object already gone    → intent marked `cleaned`
```

The scheduler is intentionally **GitHub Actions**, not Vercel Cron:
Vercel Cron is configured only through `vercel.json` (a file parked for
unrelated Reviews work) and authenticates with its own fixed
`CRON_SECRET` env var, which this route does not accept. GitHub Actions
touches no Vercel configuration and is independent of the Vercel plan.

## The route

`POST /api/internal/kyc/cleanup-upload-intents`

- `POST` only.
- Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`, compared verbatim.
- `INTERNAL_CRON_SECRET` unset in the app → `503`.
- Missing/incorrect bearer → `401`.
- Supabase env unset in the app → `503`.
- **No caller-controlled input** — no query params, no body is read. The
  batch size (100) is a server constant.
- Success → `200` with an **aggregate-counters-only** JSON body:
  `scanned`, `claimed_first_time`, `claimed_retry`, `cleaned`,
  `preserved`, `storage_errors`, `metadata_errors`, `invalid_paths`,
  `duration_ms`. No intent id, user id, storage path, document type,
  MIME, or size is ever returned or logged.

## Schedule

- **Cron:** `17 * * * *` — hourly at **minute 17 UTC**.
- **Why not minute 0:** GitHub documents the top of every hour as a
  high-load window for scheduled Actions, where runs are more likely to
  be delayed or dropped. Minute 17 is an arbitrary off-peak offset.
- **Why hourly:** matches the batch size and the low expected volume of
  abandoned KYC uploads; the route is cheap and idempotent.
- Minute 17 does **not** add 17 minutes/hours to the worst case — the
  tick is still hourly, so the maximum nominal wait from an intent
  becoming eligible to the next run stays under ~1 hour.
- **Default-branch only:** GitHub runs `schedule` triggers only from the
  workflow file as it exists on the repository's default branch. A copy
  on a feature branch does nothing until merged.

## GitHub configuration

Set once, in the repository's Actions settings (done in **B3D-2**, not
B3D-1):

| Kind | Name | Value |
|---|---|---|
| Secret | `INTERNAL_CRON_SECRET` | must equal the `INTERNAL_CRON_SECRET` configured in the deployed Unity app environment |
| Variable | `KYC_CLEANUP_ENDPOINT` | the full HTTPS endpoint, e.g. `https://<deployed-host>/api/internal/kyc/cleanup-upload-intents` |

The secret is referenced only as `${{ secrets.INTERNAL_CRON_SECRET }}`
and passed to the step as an env var; it never appears in the workflow
body or in logs. The endpoint is non-sensitive and is kept as a
*variable* (not a secret) so it shows in run logs for auditing. The
secret is never placed in the URL.

## Security posture

- **Least privilege:** `permissions: {}` — the workflow needs no
  repository token scope. It does not check out the repo.
- **No secret in logs:** curl is never run with `-v` / `--trace`;
  request headers are never printed. GitHub also auto-masks registered
  secrets.
- **Blast radius if the secret leaks:** an attacker could only trigger
  the same safe, bounded janitor more often. The route is idempotent,
  capped at 100 candidates per call, returns aggregate counters only,
  and by design **cannot** delete a registered evidence object or a
  non-expired intent's object.
- **Overlap:** safe by construction (`FOR UPDATE SKIP LOCKED` +
  durable `pending→expired`); the workflow additionally sets
  `concurrency: { group: kyc-upload-intent-cleanup,
  cancel-in-progress: false }`.
- **Endpoint validation:** the workflow refuses any
  `KYC_CLEANUP_ENDPOINT` that is not `https://`.

## One bounded invocation

Each scheduled tick issues exactly **one** POST. The route processes at
most 100 expired intents and returns. The workflow does **not** issue a
second request and does **not** implement a drain loop. If
`scanned >= 100`, it emits a `::warning::` and relies on subsequent
hourly runs to drain the remainder (~100/hour).

## Retry behaviour

At most **one** retry per invocation, ~10 seconds after the first
attempt:

| Condition | Action |
|---|---|
| Transport/connection failure (DNS, refused, timeout, TLS) | retry once; fail if it recurs |
| HTTP `500` / `502` / `504` | retry once; fail if not `200` after |
| HTTP `401` | **no retry** — fail immediately (secret mismatch) |
| HTTP `503` | **no retry** — fail immediately (endpoint not configured) |
| Any other non-`200` | **no retry** — fail immediately |

No exponential backoff, no retry storm. A failed hour rolls forward
intact — expired intents stay retryable and are picked up on the next
run.

## Failure semantics

The workflow **fails the run** (red in the Actions history, plus
whatever notifications the repo has configured) on:

- any non-2xx HTTP response, a transport failure, or a job timeout;
- a `200` whose body is not valid JSON or is missing a required numeric
  field;
- `invalid_paths > 0` — a malformed stored KYC path should be
  structurally impossible; any non-zero value is a real bug signal;
- `storage_errors > 0` or `metadata_errors > 0` — the affected intent
  rows stay retryable (B3C leaves them `expired`), but the operational
  problem is made visible rather than silently tolerated.

Not failures: `preserved > 0` (a valid defensive terminal outcome) and
`claimed_retry > 0` (rows carried over from a previous run).

## Retention

- **Normal target:** an abandoned intent becomes eligible ~6 hours after
  creation (the TTL), then is picked up on the next hourly run — so an
  orphaned object normally lives **~6–7 hours** plus GitHub's usual few
  minutes of scheduling jitter.
- **Failure case:** no hard maximum. A transient Storage/metadata error
  adds ~1 hour per failed attempt. A scheduler outage, a dropped run, or
  a dormancy pause extends retention by the outage duration. This is why
  the failure signals above exist.

## GitHub schedule delivery caveats

- Scheduled workflows **may be delayed** under GitHub platform load and
  can occasionally be **dropped** entirely for a tick.
- The workflow must exist on the **default branch** for `schedule` to
  fire.
- GitHub may **automatically disable** a scheduled workflow after a
  period of repository inactivity (documented as around 60 days). If the
  schedule is disabled for inactivity, an administrator must verify and
  re-enable the workflow from the Actions tab.

## Cost

Runner-minute cost depends on repository visibility and account plan,
which are **not established in this phase**:

- **Public repository + standard GitHub-hosted runner:** currently no
  Actions runner-minute charge.
- **Private repository:** jobs consume the account's included Actions
  minutes; billable execution is **rounded up to whole minutes** per
  job. An hourly job is roughly **720 executions per 30-day month**, and
  potentially roughly that many rounded runner-minutes.
- Actual billing impact depends on repository visibility, plan, and
  other Actions usage in the account.

## Manual fallback

Use **Actions → KYC Upload Intent Cleanup → Run workflow**
(`workflow_dispatch`). It performs the exact same bounded operation as a
scheduled run, with no inputs. This is the preferred operator fallback —
it avoids handling a raw bearer token in a terminal.

An external manual POST is possible in principle (one authenticated
`POST` to the endpoint with the internal bearer secret), but is not
documented here as a copy-paste command because it would put the secret
in shell history. **No Supabase CLI is involved in any fallback.**

## Secret rotation

1. Update `INTERNAL_CRON_SECRET` in the deployed Unity app environment.
2. Wait for deployment / environment propagation.
3. Update the GitHub repository secret `INTERNAL_CRON_SECRET` to the
   same new value.
4. Validate with a `workflow_dispatch` run.
5. Confirm the next `schedule`-triggered run also succeeds.

A brief `401` during the rotation window is possible and should be
treated as a visible configuration fault, not ignored. No secret values
appear in this document or in the workflow.

## First automatic execution proof (B3D-2)

The workflow file existing is **not** operational closure. B3D-2 must
establish:

- **A.** GitHub repository secret `INTERNAL_CRON_SECRET` configured.
- **B.** GitHub repository variable `KYC_CLEANUP_ENDPOINT` configured.
- **C.** A `workflow_dispatch` run: HTTP success + valid aggregate
  response.
- **D.** One natural `schedule`-triggered run: `event == schedule`,
  HTTP success, valid aggregate response.

A manual dispatch alone does **not** prove automatic scheduling.

**Optional / recommended fixture for B3D-2:** shortly before a scheduled
tick, seed **one** disposable expired upload intent — a valid canonical
path for a real QA user id, `status = 'expired'`, `expires_at` in the
past, **no Storage object**, **no `identity_verification_documents`
row**, no sensitive bytes. The scheduled run should then report
`cleaned >= 1`, and the fixture intent should be gone afterward. Seed it
with the service-role JS client (`@supabase/supabase-js`), **never** the
Supabase CLI. Do not create this fixture in B3D-1.

## Scope limitation — legacy no-intent uploads

B3C/B3D automate cleanup **only** for intent-backed uploads. The legacy
no-intent finalization path (`finalizeViaLegacyBody`) is outside this
mechanism.

- **New intent-backed automatic retention:** can be declared closed
  after the B3D-2 proof above.
- **All KYC orphan retention:** still **not** fully closed.

Retiring the legacy path (B3B) depends first on a durable,
non-identifying legacy-usage metric (B3M). Both are later phases.

## No Supabase CLI dependency

Nothing in this scheduler — the workflow, the fallback, or the B3D-2
proof — uses the Supabase CLI. The route reaches the database through
the app's service-role client only.

## Relationship to the Reviews scheduler

The `process-deadlines` Reviews route has its own, separate scheduling
story (Vercel Cron via `vercel.json`, parked pending a Vercel plan
upgrade). It is operationally unrelated to this workflow; the two
schedules are never merged.
